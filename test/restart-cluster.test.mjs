// Restart request cluster (@bug ideas 870, 653, 673, 695).
// idea-870: the owner "Restart runner" / RR1 checked idle on the server and then hard-killed the runner; a turn that started in
// between was cut. The runner now re-checks idle and closes a restart gate in one synchronous step (POST /restart-gate), and
// the server only kills a runner whose gate closed.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';
import { RunnerHttpError } from '../server/backend/runner-client.mjs';
import { closeRestartGate, pendingIdleRestart, restartIfStillIdle, restartWhenIdle, superviseRunner } from '../server/runner-supervisor.mjs';
import { forceRestartRunner } from '../server/unstick.mjs';
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
