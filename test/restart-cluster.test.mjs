// Restart request cluster (@bug ideas 870, 653, 673, 695).
// idea-870: the owner "Restart runner" / RR1 checked idle on the server and then hard-killed the runner; a turn that started in
// between was cut. The runner now re-checks idle and closes a restart gate in one synchronous step (POST /restart-gate), and
// the server only kills a runner whose gate closed.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';
import { RunnerHttpError } from '../server/backend/runner-client.mjs';
import { closeRestartGate, pendingIdleRestart, restartIfStillIdle, restartWhenIdle, superviseRunner } from '../server/runner-supervisor.mjs';
import { forceRestartRunner } from '../server/unstick.mjs';
import { createRestartRequestLoop, formatRequestStatus, PROGRESS_FILE, readRestartProgress, readRestartRequest } from '../server/restart-request.mjs';
import { budget } from "./helpers/load-budget.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix = 'vs-rc-') => { const d = mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + budget(ms); while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const ADMIN = 'admin-token-rc';

// Fake parkable agents (the runner-drain.test.mjs harness, trimmed).
function harness(opts = {}) {
  const sends = [];
  const kills = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, send(text) { sends.push({ id, text }); emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const runner = new Runner({ dir: path.join(tmp(), 'agents'), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe: async () => [], ...opts });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)?.('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  return { runner, sends, kills, ems, create, endTurn };
}

async function served() {
  const h = harness();
  const srv = createServer(h.runner, { token: ADMIN, hash: 'h', onShutdown() {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = async (headers, method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body: json };
  };
  const stop = async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); h.runner.shutdown(); };
  return { h, call, stop };
}
const admin = { authorization: `Bearer ${ADMIN}` };

// ---- idea-870: the runner side ----

test('idea-870: POST /restart-gate answers gated:false while a turn is open, gated:true once idle', async () => {
  const s = await served();
  try {
    const id = s.h.create();
    await until(() => s.h.sends.some((x) => x.id === id));
    const busy = await s.call(admin, 'POST', '/restart-gate', { ttlMs: 60_000 });
    assert.equal(busy.status, 200);
    assert.equal(busy.body.gated, false);
    assert.equal(busy.body.running, 1);
    assert.deepEqual(busy.body.ids, [id]);
    s.h.endTurn(id);
    await until(() => s.h.runner.status(id).status === 'parked');
    const idle = await s.call(admin, 'POST', '/restart-gate', { ttlMs: 60_000 });
    assert.equal(idle.body.gated, true);
    assert.deepEqual(idle.body.ids, []);
    assert.ok(idle.body.until > Date.now());
  } finally { await s.stop(); }
});

test('idea-870: while gated a send and a create queue (no new turn starts); DELETE /restart-gate delivers them', async () => {
  const s = await served();
  try {
    const id = s.h.create();
    await until(() => s.h.sends.some((x) => x.id === id));
    s.h.endTurn(id);
    await until(() => s.h.runner.status(id).status === 'parked');
    assert.equal((await s.call(admin, 'POST', '/restart-gate', { ttlMs: 60_000 })).body.gated, true);
    s.h.sends.length = 0;
    s.h.runner.send(id, 'again');
    const fresh = s.h.runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'new worker' });
    await tick(80);
    assert.deepEqual(s.h.sends, [], 'no turn starts behind a closed gate');
    assert.ok(s.h.runner.queue.some((j) => j.id === id), 'the send is queued');
    assert.ok(s.h.runner.queue.some((j) => j.id === fresh), 'the create is queued');
    const del = await s.call(admin, 'DELETE', '/restart-gate');
    assert.equal(del.status, 200);
    assert.equal(del.body.cleared, true);
    await until(() => s.h.sends.some((x) => x.id === id) && s.h.sends.some((x) => x.id === fresh));
    assert.equal(s.h.sends.find((x) => x.id === id).text, 'again');
    assert.equal((await s.call(admin, 'DELETE', '/restart-gate')).body.cleared, false, 'a second DELETE: nothing was closed');
  } finally { await s.stop(); }
});

test('idea-870: an agent token gets 403 on /restart-gate (admin only); no auth 401', async () => {
  const s = await served();
  try {
    const id = s.h.create();
    const agent = { 'x-vs-agent-id': id, 'x-vs-agent-token': s.h.runner.tokensById.get(id) };
    assert.ok(agent['x-vs-agent-token']);
    for (const method of ['POST', 'DELETE']) assert.equal((await s.call(agent, method, '/restart-gate', method === 'POST' ? {} : undefined)).status, 403, `agent ${method}`);
    assert.equal((await s.call({}, 'POST', '/restart-gate', {})).status, 401);
    assert.equal(s.h.runner._restartGate, null, 'an agent never closed it');
  } finally { await s.stop(); }
});

test('idea-870 (rn-01a55ab3f1bf minor): a runner with no admin token refuses /restart-gate (fails closed, as /drain)', async () => {
  const h = harness();
  const srv = createServer(h.runner, { hash: 'h', onShutdown() {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    for (const method of ['POST', 'DELETE']) {
      const r = await fetch(`http://127.0.0.1:${port}/restart-gate`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 403, method);
      assert.match((await r.json()).error, /restart gate not enabled/);
    }
    assert.equal(h.runner._restartGate, null, 'never closed');
    // closeRestartGate reads that 403 as unknown/busy, so the server never kills a runner it could not gate.
    const g = await closeRestartGate({ rc: { request: async () => { throw new RunnerHttpError(403, 'restart gate not enabled'); } } });
    assert.equal(g.gated, false);
    assert.equal(g.busy, true);
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); h.runner.shutdown(); }
});

test('idea-870: the gate lapses after its TTL and the queued turn starts', async () => {
  const h = harness();
  try {
    const id = h.create();
    await until(() => h.sends.some((x) => x.id === id));
    h.endTurn(id);
    await until(() => h.runner.status(id).status === 'parked');
    h.runner.setRestartGate(1000); // the floor
    h.sends.length = 0;
    h.runner.send(id, 'later');
    await tick(100);
    assert.deepEqual(h.sends, []);
    await until(() => h.sends.some((x) => x.id === id), 5000);
  } finally { h.runner.shutdown(); }
});

// ---- idea-870: the server side ----

const rcOwner = (answer) => {
  const calls = [];
  return { calls, owner: { rc: { request: async (method, route, body) => { calls.push({ method, route, body }); return answer(method, route); } } } };
};

test('idea-870: closeRestartGate maps answers: gated, busy, 404/down = legacy, timeout = busy unknown', async () => {
  assert.deepEqual(await closeRestartGate(rcOwner(() => ({ ok: true, gated: true })).owner), { gated: true });
  const busy = await closeRestartGate(rcOwner(() => ({ ok: true, gated: false, running: 1, held: 0, ids: ['rn-x'] })).owner);
  assert.equal(busy.busy, true);
  assert.equal(busy.running, 1);
  assert.deepEqual(busy.ids, ['rn-x']);
  const err = (status, extra = {}) => () => { throw Object.assign(new RunnerHttpError(status, `e${status}`), extra); };
  assert.deepEqual(await closeRestartGate(rcOwner(err(404)).owner), { gated: false, legacy: true }, 'an older runner without the route');
  assert.deepEqual(await closeRestartGate(rcOwner(err(504, { transport: true, timedOut: false })).owner), { gated: false, legacy: true }, 'runner down (connect refused)');
  const timeout = await closeRestartGate(rcOwner(err(504, { transport: true, timedOut: true })).owner);
  assert.equal(timeout.busy, true, 'a hung runner is never killed on a guess');
  assert.equal(timeout.unknown, true);
  const other = await closeRestartGate(rcOwner(err(500)).owner);
  assert.equal(other.busy, true);
  assert.equal(other.unknown, true);
  const { calls, owner } = rcOwner(() => ({ gated: true }));
  await closeRestartGate(owner, { ttlMs: 12_345 });
  assert.deepEqual(calls[0], { method: 'POST', route: '/restart-gate', body: { ttlMs: 12_345 } });
});

test('idea-870: restartIfStillIdle kills only a closed (or legacy) gate; busy never kills; a failed kill reopens the gate', async () => {
  let kills = 0;
  const restart = async () => { kills += 1; };
  let opened = 0;
  const open = async () => { opened += 1; return true; };
  const owner = { rc: {} };
  assert.deepEqual(await restartIfStillIdle(owner, { gate: async () => ({ gated: true }), open, restart }), { restarted: true });
  assert.equal(kills, 1);
  assert.deepEqual(await restartIfStillIdle(owner, { gate: async () => ({ gated: false, legacy: true }), open, restart }), { restarted: true });
  assert.equal(kills, 2);
  const g = { gated: false, busy: true, running: 1, held: 0, ids: ['rn-new'] };
  assert.deepEqual(await restartIfStillIdle(owner, { gate: async () => g, open, restart }), { restarted: false, gate: g });
  assert.equal(kills, 2, 'a turn that started after runnerBusy() is not killed');
  await assert.rejects(restartIfStillIdle(owner, { gate: async () => ({ gated: true }), open, restart: async () => { throw new Error('kill failed'); } }), /kill failed/);
  assert.equal(opened, 1, 'the gate is reopened so queued turns run on the runner that survived');
  await assert.rejects(restartIfStillIdle(owner, { gate: async () => ({ gated: false, legacy: true }), open, restart: async () => { throw new Error('x'); } }), /x/);
  assert.equal(opened, 1, 'a legacy (no gate) restart has nothing to reopen');
});

test('idea-870: restartIfStillIdle joins a restart already in flight without gating it', async () => {
  let gated = 0;
  let kills = 0;
  const r = await restartIfStillIdle({ rc: { restarting: Promise.resolve() } }, { gate: async () => { gated += 1; return { gated: true }; }, restart: async () => { kills += 1; } });
  assert.deepEqual(r, { restarted: true, joined: true });
  assert.equal(gated, 0, 'a gate would land on the fresh runner');
  assert.equal(kills, 1);
});

function supHarness(state, restart) {
  const logs = [];
  const pending = [];
  const owner = { rc: { healthy: async () => true } };
  const sup = superviseRunner(owner, {
    checkMs: 5000, minBackoffMs: 100, maxBackoffMs: 400,
    healthInfo: async () => state.health,
    agentList: async () => state.agents,
    diskHash: () => state.disk,
    restart,
    log: (m) => logs.push(m),
    setTimer: (fn) => { pending.push(fn); return { unref() {} }; },
    clearTimer() {},
  });
  return { owner, sup, logs, next: async () => { const fn = pending.shift(); if (fn) await fn(); } };
}

test('idea-870: supervisor, armed owner restart: a raced gate keeps it armed, logs "turned busy before the kill", retries when idle', async () => {
  const state = { disk: 'same', health: { hash: 'same', running: 0, held: 0, heldAgents: [] }, agents: [] };
  const answers = [{ restarted: false, gate: { gated: false, busy: true, running: 1, held: 0, ids: ['rn-new'] } }, { restarted: true }];
  let calls = 0;
  const h = supHarness(state, async () => { calls += 1; return answers.shift(); });
  await h.sup.ready;
  restartWhenIdle(h.owner);
  await h.next();
  assert.equal(calls, 1);
  assert.match(h.logs.at(-1), /turned busy before the kill \(1 running, 0 held: rn-new\), nothing killed.*\[owner restart armed\]/);
  assert.ok(pendingIdleRestart(h.owner), 'still armed after the race');
  await h.next();
  assert.equal(calls, 2, 'retried on the next idle tick');
  assert.equal(pendingIdleRestart(h.owner), null, 'disarmed once it fired');
  await h.next();
  assert.equal(calls, 2, 'same hash, nothing armed: no third restart');
  h.sup.stop();
});

test('idea-870: supervisor, stale hash: a raced gate does not mark the hash restarted (retried), an unanswered gate says so', async () => {
  const state = { disk: 'new', health: { hash: 'old', running: 0, held: 0, heldAgents: [] }, agents: [] };
  const answers = [{ restarted: false, gate: { gated: false, busy: true, unknown: true, error: 'runner not responding' } }, { restarted: true }];
  let calls = 0;
  const h = supHarness(state, async () => { calls += 1; return answers.shift(); });
  await h.sup.ready; // the first tick runs at start
  assert.equal(calls, 1);
  assert.match(h.logs.at(-1), /restart gate unanswered: runner not responding/);
  assert.doesNotMatch(h.logs.at(-1), /owner restart armed/);
  await h.next();
  assert.equal(calls, 2, 'the stale hash is retried, not given up on');
  await h.next();
  await h.next();
  assert.equal(calls, 2);
  assert.ok(h.logs.some((l) => /giving up/.test(l)), 'after a real restart the same hash gives up as before');
  h.sup.stop();
});

test('idea-870: forceRestartRunner idle but raced at the gate -> deferred + raced, restart-when-idle armed, nothing killed', async () => {
  let armed = 0;
  let killed = 0;
  const backend = { listAgents: async () => [{ id: 'rn-idle', status: 'idle', archivedAt: null }], rc: { request: async () => ({ ok: true, gated: false, running: 1, held: 0, ids: ['rn-new'] }) } };
  const r = await forceRestartRunner({ backend, health: async () => ({ running: 0, held: 0, heldAgents: [] }), restartRunner: async () => { killed += 1; }, whenIdle: () => { armed += 1; return true; } });
  assert.equal(killed, 0);
  assert.equal(armed, 1);
  assert.deepEqual(r, { ok: true, cancelled: [], restarted: false, deferred: true, alreadyArmed: false, raced: true, busy: ['rn-new'], running: 1, held: 0, unknown: false });
});

// ---- idea-653: a firing request says what its script is doing, and ends when the script died without a result ----
// rr-20261123160405-c410 sat in `firing` for ~10 min with nothing to show (the script was waiting for idle), abort was refused,
// and a script that crashed without a result file would have kept it firing for FIRING_TIMEOUT_MS (3 h).

const FIRED = Date.parse('2026-11-23T16:04:05.000Z');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // a real pid that has exited
function firingHome({ firedAt = FIRED, asked = {} } = {}) {
  const home = tmp('vs-rc-home-');
  const current = { id: 'rr-test-0001', tip: 'abc1234', state: 'firing', requestedBy: 'rn-ove', team: 'vibesquad', lane: 'vibesquad', needs: 'server-restart', scope: 'all', createdAt: new Date(firedAt - 60_000).toISOString(), deadline: new Date(firedAt + 1800_000).toISOString(), deadlineMin: 30, firedAt: new Date(firedAt).toISOString(), launch: { ok: true, at: new Date(firedAt + 2000).toISOString(), out: 'launched' }, asked, drained: {}, gone: {}, events: [] };
  writeFileSync(path.join(home, 'restart-request.json'), JSON.stringify({ version: 1, current, history: [] }));
  return home;
}
const writeProgressFile = (home, rec) => writeFileSync(path.join(home, PROGRESS_FILE), JSON.stringify(rec));
const writeResultFile = (home, startMs, rec) => { const at = new Date(startMs).toISOString(); writeFileSync(path.join(home, `restart-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({ startedAt: at, finishedAt: at, dryRun: false, errors: [], ...rec })); };
function requestLoop(home, { now = FIRED + 5 * 60_000 } = {}) {
  const calls = [];
  const loop = createRestartRequestLoop({ home, teams: () => [], asleepTeams: () => null, now: () => now, listAgents: async () => [], runVs: async (args) => { calls.push(args); return { ok: true }; }, fire: async () => assert.fail('never fires again') });
  return { loop, calls };
}

test('idea-653: readRestartProgress: only this fire\'s progress, with the pid checked', () => {
  const home = firingHome();
  const req = readRestartRequest(home);
  assert.equal(readRestartProgress(home, req), null, 'no file');
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED - 3600_000).toISOString(), phase: 'waiting' });
  assert.equal(readRestartProgress(home, req), null, 'an earlier run');
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting' });
  assert.equal(readRestartProgress(home, req).alive, true);
  writeProgressFile(home, { pid: deadPid(), startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting' });
  assert.equal(readRestartProgress(home, req).alive, false);
  assert.equal(readRestartProgress(home, req, { alive: () => { throw new Error('EPERM'); } }).alive, true, 'an unknown pid check is never read as dead');
  writeFileSync(path.join(home, PROGRESS_FILE), '{"pid":');
  assert.equal(readRestartProgress(home, req), null, 'corrupt');
  assert.equal(readRestartProgress(home, { ...req, firedAt: undefined }), null, 'not fired');
});

test('idea-653: a firing request whose script pid died with no result is aborted at once (not after 3 h), leads told', async () => {
  const home = firingHome({ asked: { 'rn-ui': { team: 'vibesquad', lane: 'ui', title: 'ui lead', sentAt: new Date(FIRED - 30_000).toISOString() } } });
  writeProgressFile(home, { pid: deadPid(), startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', at: new Date(FIRED + 60_000).toISOString() });
  const { loop, calls } = requestLoop(home);
  assert.equal((await loop.tick()).state, 'aborted');
  const req = readRestartRequest(home);
  assert.match(req.abortReason, /vs restart script \(pid \d+\) exited without a result \(last phase: waiting/);
  assert.ok(calls.some((c) => c[0] === 'send' && c[1] === 'rn-ui' && /was aborted/.test(c[2])), JSON.stringify(calls));
  assert.ok(calls.some((c) => c[0] === 'log' && /aborted/.test(c[2])));
});

test('idea-653: a result written before the script exited wins over the dead pid; a live script keeps the request firing', async () => {
  const home = firingHome();
  writeProgressFile(home, { pid: deadPid(), startedAt: new Date(FIRED + 3000).toISOString(), phase: 'finished', ok: true });
  writeResultFile(home, FIRED + 3000, { ok: true });
  assert.equal((await requestLoop(home).loop.tick()).state, 'done');
  const live = firingHome();
  writeProgressFile(live, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting' });
  assert.equal((await requestLoop(live).loop.tick()).state, 'firing');
  const none = firingHome();
  assert.equal((await requestLoop(none).loop.tick()).state, 'firing', 'no progress file (an older script): the 3 h timeout as before');
});

test('idea-653: vs restart status shows the firing script\'s phase, wait deadline and holders', () => {
  const home = firingHome();
  const req = readRestartRequest(home);
  const now = FIRED + 5 * 60_000;
  const p = { pid: 4242, alive: true, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', at: new Date(now - 2000).toISOString(), waitDeadline: new Date(FIRED + 3000 + 600_000).toISOString(), running: 1, held: 2, heldAgents: ['rn-a', 'rn-b'] };
  const text = formatRequestStatus(req, now, { progress: p });
  assert.match(text, /vs restart pid 4242: waiting for runner idle \(1 running, 2 held: rn-a, rn-b\), wait deadline .* \(in 5 min; then held work defers/);
  assert.match(formatRequestStatus(req, now), /vs restart progress: none yet/);
  assert.match(formatRequestStatus(req, now, { progress: { ...p, alive: false, phase: 'restarting' } }), /pid 4242 \(EXITED\): restarting/);
  assert.doesNotMatch(formatRequestStatus({ ...req, state: 'done' }, now), /progress/, 'only while firing');
});

// ---- idea-673: vs restart extend; abort reaches a waiting script; the drain hook stops lagging an abort ----
const OWNER = { hasOwnerProof: () => true, teams: [{ id: 'vibesquad', name: 'VibeSquad', hub: 'vibesquad', lanes: [{ id: 'vibesquad' }] }] };
async function vsRestart(home, args, opts = {}) {
  const { commandRestartRequest } = await import('../cli/vs.mjs');
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  try { await commandRestartRequest({ _: args, ...(opts.flags ?? {}) }, { env: { VIBESQUAD_HOME: home }, ...OWNER, now: () => FIRED + 60_000, ackMs: 0, ...opts }); return out.join(''); } finally { process.stdout.write = orig; }
}
const setState = (home, patch) => { const f = path.join(home, 'restart-request.json'); const doc = JSON.parse(readFileSync(f, 'utf8')); Object.assign(doc.current, patch); writeFileSync(f, JSON.stringify(doc)); };
const CONTROL = 'vs-restart-control.json';
const readControl = (home) => JSON.parse(readFileSync(path.join(home, CONTROL), 'utf8'));

test('idea-673: extendRestartRequest pushes a draining deadline out (capped), lengthens a queued drain, refuses ready/firing/none', async () => {
  const { extendRestartRequest, MAX_DEADLINE_MIN } = await import('../server/restart-request.mjs');
  const home = firingHome();
  setState(home, { state: 'draining' });
  const before = Date.parse(readRestartRequest(home).deadline);
  const r = extendRestartRequest(home, { by: 'rn-ove', minutes: 20, now: FIRED });
  assert.equal(Date.parse(r.deadline), before + 20 * 60_000);
  assert.match(readRestartRequest(home).events.at(-1).text, /deadline extended by rn-ove/);
  const capped = extendRestartRequest(home, { minutes: MAX_DEADLINE_MIN, now: FIRED });
  assert.equal(Date.parse(capped.deadline), FIRED - 60_000 + MAX_DEADLINE_MIN * 60_000, 'never past the cap from the drain start (createdAt)');
  assert.throws(() => extendRestartRequest(home, { minutes: 5, now: FIRED }), /already at the 240 min cap/);
  setState(home, { state: 'requested', requestedAt: new Date(FIRED - 60_000).toISOString(), deadline: new Date(FIRED - 60_000).toISOString() });
  assert.equal(Date.parse(extendRestartRequest(home, { minutes: 10, now: FIRED }).deadline), FIRED + 10 * 60_000, 'a passed deadline extends from now');
  setState(home, { state: 'queued', windowAt: new Date(FIRED + 3600_000).toISOString(), deadlineMin: 30 });
  const q = extendRestartRequest(home, { minutes: 15, now: FIRED });
  assert.equal(q.deadlineMin, 45);
  assert.equal(Date.parse(q.deadline), FIRED + 3600_000 + 45 * 60_000);
  for (const [state, code] of [['ready', 'READY'], ['firing', 'FIRING'], ['aborted', 'NONE']]) {
    setState(home, { state });
    assert.throws(() => extendRestartRequest(home, { minutes: 5, now: FIRED }), (e) => e.code === code, state);
  }
  for (const bad of [0, -1, 1.5, MAX_DEADLINE_MIN + 1, 'x']) assert.throws(() => extendRestartRequest(home, { minutes: bad }), /whole minutes/, String(bad));
});

test('idea-673 (rn-01a55ab3f1bf major): repeated extends of a draining request stop at MAX_DEADLINE_MIN after the drain start, not after now', async () => {
  const { extendRestartRequest, MAX_DEADLINE_MIN } = await import('../server/restart-request.mjs');
  const home = firingHome();
  const start = FIRED;
  setState(home, { state: 'draining', requestedAt: new Date(start).toISOString(), deadline: new Date(start + 30 * 60_000).toISOString() });
  const cap = start + MAX_DEADLINE_MIN * 60_000;
  // An extend every 25 min of the max size: under the old now-relative cap this slid forever.
  let t = start;
  let last = 0;
  for (let i = 0; i < 12; i += 1, t += 25 * 60_000) {
    try { last = Date.parse(extendRestartRequest(home, { minutes: MAX_DEADLINE_MIN, now: t }).deadline); } catch (e) { assert.match(e.message, /already at the 240 min cap \(from its drain start 2026-11-23T16:04:05.000Z\)/); }
    assert.ok(Date.parse(readRestartRequest(home).deadline) <= cap, `extend ${i} at +${(t - start) / 60_000} min stays under the cap`);
  }
  assert.equal(last, cap, 'reached exactly the anchored cap');
  // Past the cap (a stuck drain): refused rather than set to a deadline already in the past.
  setState(home, { deadline: new Date(start + 60 * 60_000).toISOString() });
  assert.throws(() => extendRestartRequest(home, { minutes: 5, now: cap + 60_000 }), /already at the 240 min cap/);
  // An older file with no requestedAt anchors to createdAt.
  setState(home, { requestedAt: undefined, deadline: new Date(FIRED).toISOString() });
  assert.equal(Date.parse(extendRestartRequest(home, { minutes: MAX_DEADLINE_MIN, now: FIRED }).deadline), FIRED - 60_000 + MAX_DEADLINE_MIN * 60_000);
});

test('idea-673 (rn-01a55ab3f1bf major): a waiting script\'s extends stop at SCRIPT_EXTEND_MAX_MS after its start, inside FIRING_TIMEOUT_MS', async () => {
  const { controlWaitingScript, SCRIPT_EXTEND_MAX_MS, FIRING_TIMEOUT_MS } = await import('../server/restart-request.mjs');
  const { EXTEND_MAX_MS } = await import('../scripts/restart-runtime.mjs');
  assert.equal(SCRIPT_EXTEND_MAX_MS, EXTEND_MAX_MS, 'server and script agree on the cap');
  assert.ok(SCRIPT_EXTEND_MAX_MS + 30 * 60_000 < FIRING_TIMEOUT_MS, 'a fully extended wait plus stop/relaunch ends well before the firing timeout');
  const home = firingHome();
  const startedAt = FIRED + 3000;
  const cap = startedAt + SCRIPT_EXTEND_MAX_MS;
  const req = readRestartRequest(home);
  // The reviewer's case: +120 at t=0 and again at t=90 min used to reach t=210 min, past the 3 h firing timeout.
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(startedAt).toISOString(), phase: 'waiting', waitDeadline: new Date(startedAt + 600_000).toISOString() });
  const a = controlWaitingScript(home, { kind: 'extend', minutes: 120, req, now: FIRED });
  assert.equal(a.extendUntil, cap, 'first +120 is cut to the cap from the start');
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(startedAt).toISOString(), phase: 'waiting', waitDeadline: new Date(a.extendUntil).toISOString() });
  assert.throws(() => controlWaitingScript(home, { kind: 'extend', minutes: 120, req, now: FIRED + 90 * 60_000 }), /already waits to .*the 120 min cap from its start/);
  assert.ok(cap - FIRED < FIRING_TIMEOUT_MS);
  // A shorter wait still extends, up to the cap.
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(startedAt).toISOString(), phase: 'waiting', waitDeadline: new Date(startedAt + 100 * 60_000).toISOString() });
  assert.equal(controlWaitingScript(home, { kind: 'extend', minutes: 60, req, now: FIRED + 90 * 60_000 }).extendUntil, cap);
});

test('idea-673: vs restart extend / abort on a firing request write the control for its waiting script; past the wait they refuse', async () => {
  const home = firingHome();
  const waitDeadline = new Date(FIRED + 600_000).toISOString();
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', waitDeadline });
  const out = await vsRestart(home, ['extend', '20']);
  const c = readControl(home);
  assert.equal(c.pid, process.pid);
  assert.equal(c.by, 'owner');
  assert.equal(c.extendUntil, FIRED + 600_000 + 20 * 60_000, 'from the script\'s own wait deadline');
  assert.match(out, /extend to .* written for vs restart pid/);
  // acknowledged: the script read it (its nonce in progress) and the CLI says the new deadline
  const acked = await vsRestart(home, ['extend', '5'], { ackMs: 2000, sleep: async () => { const n = readControl(home).nonce; writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', waitDeadline: '2026-11-23T16:40:05.000Z', control: { nonce: n } }); } });
  assert.match(acked, /now waits for runner idle until 2026-11-23T16:40:05.000Z \(rr-test-0001\)/);
  const ab = await vsRestart(home, ['abort'], { flags: { reason: 'wrong tip' } });
  assert.deepEqual(readControl(home).abort, { reason: 'wrong tip' });
  assert.match(ab, /abort written for vs restart pid/);
  assert.equal(readRestartRequest(home).state, 'firing', 'the request ends when the script\'s result lands, not before');
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'restarting' });
  await assert.rejects(vsRestart(home, ['abort']), /past its idle wait \(restarting\); a stop or relaunch is never cut halfway/);
  await assert.rejects(vsRestart(home, ['extend', '5']), /past its idle wait/);
  writeProgressFile(home, { pid: deadPid(), startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting' });
  await assert.rejects(vsRestart(home, ['abort']), /has exited/);
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED - 3600_000).toISOString(), phase: 'waiting' });
  await assert.rejects(vsRestart(home, ['abort']), /no running vs restart for rr-test-0001/, 'an earlier run\'s script is not this fire\'s');
  await assert.rejects(vsRestart(home, ['extend', 'x']), /usage: vs restart extend <min>/);
});

test('idea-673 (rn-01a55ab3f1bf minor): vs restart abort reports the abort when the script already wrote finished (nonce kept), not a false alarm', async () => {
  const home = firingHome();
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', waitDeadline: new Date(FIRED + 600_000).toISOString() });
  // The script reads the abort, throws, and its finally writes 'finished' before the CLI's first ack poll.
  const finished = (control) => async () => { const n = readControl(home).nonce; writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'finished', ok: false, ...(control ? { control: { nonce: n, kind: 'abort' } } : {}) }); };
  const out = await vsRestart(home, ['abort'], { ackMs: 2000, sleep: finished(true) });
  assert.match(out, /aborted in its idle wait: nothing was stopped; rr-test-0001 ends as aborted/);
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED + 3000).toISOString(), phase: 'waiting', waitDeadline: new Date(FIRED + 600_000).toISOString() });
  const lost = await vsRestart(home, ['abort'], { ackMs: 2000, sleep: finished(false) });
  assert.match(lost, /left its idle wait before reading the abort \(finished\)/, 'without the nonce (the pre-fix finally) it reads as missed');
});

test('idea-673: with no open request, abort/extend reach a direct vs restart still waiting; with none waiting the old error stands', async () => {
  const home = tmp('vs-rc-home-');
  await assert.rejects(vsRestart(home, ['abort']), /no open restart request/);
  writeProgressFile(home, { pid: process.pid, startedAt: new Date(FIRED).toISOString(), phase: 'waiting', waitDeadline: new Date(FIRED + 600_000).toISOString() });
  await vsRestart(home, ['abort']);
  assert.ok(readControl(home).abort);
  await vsRestart(home, ['extend', '10']);
  assert.equal(readControl(home).extendUntil, FIRED + 1200_000);
});

test('idea-673: a fired script aborted in its wait ends the request with that reason, leads told', async () => {
  const home = firingHome({ asked: { 'rn-ui': { team: 'vibesquad', lane: 'ui', title: 'ui lead', sentAt: new Date(FIRED - 30_000).toISOString() } } });
  writeResultFile(home, FIRED + 3000, { ok: false, controlAbort: { by: 'owner', reason: 'wrong tip' }, errors: ['aborted by owner while waiting for runner idle: wrong tip; nothing was stopped'] });
  const { loop, calls } = requestLoop(home);
  assert.equal((await loop.tick()).state, 'aborted');
  assert.equal(readRestartRequest(home).abortReason, 'vs restart abort by owner while the restart waited for runner idle: wrong tip; nothing was stopped');
  assert.ok(calls.some((c) => c[0] === 'send' && c[1] === 'rn-ui' && /was aborted/.test(c[2])), JSON.stringify(calls));
});

test('idea-673: the drain hook lifts a request drain at once when its request is finished or no longer current', async () => {
  const { requestDrainLifted, requestFileFor } = await import('../runner/drain-hook.mjs');
  const drain = { kind: 'request', since: Date.now(), until: Date.now() + 60_000, request: { id: 'rr-1', tip: 'abc' } };
  const doc = (cur) => ({ version: 1, current: cur, history: [] });
  assert.equal(requestDrainLifted(drain, null), false, 'no request file: keep refusing');
  assert.equal(requestDrainLifted(drain, {}), false, 'not a request doc');
  for (const st of ['requested', 'draining', 'ready']) assert.equal(requestDrainLifted(drain, doc({ id: 'rr-1', state: st })), false, st);
  assert.equal(requestDrainLifted(drain, doc({ id: 'rr-1', state: 'firing' })), false, 'fired, not launched yet');
  for (const st of ['aborted', 'done', 'queued']) assert.equal(requestDrainLifted(drain, doc({ id: 'rr-1', state: st })), true, st);
  assert.equal(requestDrainLifted(drain, doc({ id: 'rr-1', state: 'firing', launch: { ok: true } })), true, 'launched: the script drains itself');
  assert.equal(requestDrainLifted(drain, doc({ id: 'rr-2', state: 'draining' })), true, 'another request');
  assert.equal(requestDrainLifted(drain, doc(null)), true, 'no current request');
  assert.equal(requestDrainLifted({ ...drain, kind: 'restart' }, doc({ id: 'rr-1', state: 'aborted' })), false, 'vs restart\'s own drain is never lifted here');
  // end to end: the hook process, drain.json in <vs home>/runner
  const vsHome = tmp('vs-rc-hook-');
  mkdirSync(path.join(vsHome, 'runner'));
  const drainFile = path.join(vsHome, 'runner', 'drain.json');
  assert.equal(requestFileFor(drainFile), path.join(vsHome, 'restart-request.json'));
  writeFileSync(drainFile, JSON.stringify(drain));
  const hook = () => spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'runner', 'drain-hook.mjs'), drainFile], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }), encoding: 'utf8', timeout: 10_000 }).status;
  assert.equal(hook(), 2, 'no request file: refused as before');
  writeFileSync(path.join(vsHome, 'restart-request.json'), JSON.stringify(doc({ id: 'rr-1', state: 'draining' })));
  assert.equal(hook(), 2, 'request still draining');
  writeFileSync(path.join(vsHome, 'restart-request.json'), JSON.stringify(doc({ id: 'rr-1', state: 'aborted' })));
  assert.equal(hook(), 0, 'aborted: allowed before the server clears the drain');
});
