// Ideas 228 + 229 (live 11-14: an URGENT restart deferred 3x on rn-83342416653e). The runner's `held` must be the truth a
// restart drains on: (1) stopping a held agent's background work kills each shell's whole tree (taskkill /T /F), not only
// the direct child; (2) before held is reported or used it is checked against reality (a held entry whose shells are all
// dead is dropped at once, not after the next poll); (3) the restart drain guard cross-checks a lead's 'drained restart'
// self-report against the runner's held list instead of taking it as truth.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { killPidTree } from '../runner/spawn.mjs';
import { createServer as createRunnerServer } from '../runner/server.mjs';
import { drainGuard, drainGuardMessage } from '../server/restart-coord.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-heldtruth-')); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);

// Fake agents with fake pids. `work` (cli pid -> shells) is what the probe sees; `alive` is the set of pids the
// liveness check reports; killPid records tree kills.
function harness(opts = {}) {
  const work = new Map();
  const alive = new Set();
  const kills = [];
  const treeKills = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, sends: [], send(t) { this.sends.push(t); emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const bgProbe = async (pid) => work.get(pid) ?? [];
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 60_000, parkHoldMaxMs: 3_600_000, bgProbe, pidAlive: (pid) => alive.has(pid), killPid: (pid) => { treeKills.push(pid); alive.delete(pid); }, ...opts });
  const create = () => {
    const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' });
    ems.get(id)('session', { sessionId: `s-${id}` });
    return id;
  };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  const shells = (id, list) => { work.set(pidOf(id), list); for (const s of list) alive.add(s.pid); };
  return { runner, work, alive, kills, treeKills, ems, create, endTurn, pidOf, shells };
}
const GODOT = { pid: 27324, name: 'bash', cmd: "bash tools/run_godot.sh suite --timeout 7000 > /tmp/so_suite.out 2>&1; echo exit=$? >> /tmp/so_suite.out" };
const WAITER = { pid: 24420, name: 'bash', cmd: "until grep -q '^exit=' /tmp/so_suite.out; do sleep 30; done" };

// ---- (1) tree kill -------------------------------------------------------------------------------------------------

test('killPidTree: Windows kills the whole tree with taskkill /pid <pid> /T /F (no shell); POSIX signals the pid', () => {
  const calls = [];
  const spawnImpl = (file, args, o) => { calls.push({ file, args, o }); return { on() {}, unref() {} }; };
  assert.equal(killPidTree(4242, { platform: 'win32', spawnImpl }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4242', '/T', '/F'], 'tree (/T) + force (/F), not only the direct child');
  assert.equal(calls[0].o.shell, false);
  const sigs = [];
  assert.equal(killPidTree(4243, { platform: 'linux', killImpl: (pid, sig) => sigs.push([pid, sig]) }), true);
  assert.deepEqual(sigs[0], [-4243, 'SIGKILL'], 'POSIX: the process group first');
  assert.equal(killPidTree(0, { platform: 'win32', spawnImpl }), false, 'no pid: nothing to kill');
  assert.equal(killPidTree(-5, { platform: 'win32', spawnImpl }), false);
  assert.equal(calls.length, 1);
});

test('stopBackground: kills each held shell tree from a fresh probe, logs bg-stopped, drops the hold, no bg-wake, then parks', async () => {
  const h = harness();
  const id = h.create();
  h.shells(id, [GODOT, WAITER]);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  assert.deepEqual(h.runner.heldIds(), [id]);
  h.work.set(h.pidOf(id), [GODOT, WAITER]);
  const r = await h.runner.stopBackground(id);
  assert.deepEqual(r.stopped.map((w) => w.pid), [27324, 24420]);
  assert.deepEqual(h.treeKills, [27324, 24420], 'every shell is tree-killed (killPidTree: taskkill /T /F)');
  const ev = h.runner.timeline(id).find((e) => e.type === 'bg-stopped');
  assert.deepEqual(ev.work.map((w) => w.pid), [27324, 24420]);
  assert.deepEqual(h.runner.heldIds(), [], 'not held any more');
  h.work.delete(h.pidOf(id)); // the trees are gone
  await until(() => h.kills.length === 1);
  assert.equal(h.runner.status(id).status, 'parked');
  assert.ok(!types(h.runner, id).includes('bg-wake'), 'stopped on purpose: no "your work finished" wake');
  h.runner.shutdown();
});

test('stopBackground: refuses a running turn, an unknown agent; nothing to stop is a clean no-op', async () => {
  const h = harness();
  const id = h.create(); // mid-turn
  await assert.rejects(h.runner.stopBackground(id), (e) => e.status === 409 && /running/.test(e.message));
  await assert.rejects(h.runner.stopBackground('rn-nope'), (e) => e.status === 404);
  h.endTurn(id);
  await until(() => h.kills.length === 1); // no work: parked
  await assert.rejects(h.runner.stopBackground(id), (e) => e.status === 409, 'parked: no live tree');
  const h2 = harness();
  const id2 = h2.create();
  h2.shells(id2, [GODOT]);
  h2.endTurn(id2);
  await until(() => types(h2.runner, id2).includes('park-held'));
  h2.work.delete(h2.pidOf(id2)); // gone by the time the stop probes
  assert.deepEqual((await h2.runner.stopBackground(id2)).stopped, []);
  assert.deepEqual(h2.treeKills, [], 'only pids the fresh probe saw under the agent are ever killed');
  h.runner.shutdown(); h2.runner.shutdown();
});

test('stopBackground (idea-231): a turn that starts while the probe runs -> nothing is killed, the new turn\'s work is not wiped', async () => {
  const h = harness();
  const id = h.create();
  h.shells(id, [GODOT]);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  const NEW_SHELL = { pid: 31337, name: 'bash', cmd: 'npm test' }; // the new turn's own shell, seen by the stop's probe
  let release;
  const gate = new Promise((r) => { release = r; });
  let probing = false;
  h.runner.bgProbe = async () => { probing = true; await gate; return [GODOT, NEW_SHELL]; };
  const stop = h.runner.stopBackground(id);
  await until(() => probing);
  h.runner.send(id, 'next task'); // a new turn starts mid-probe
  const entry = h.runner.live.get(id);
  entry.work = [NEW_SHELL]; // what the new turn holds
  release();
  await assert.rejects(stop, (e) => e.status === 409 && /started a turn/.test(e.message));
  assert.deepEqual(h.treeKills, [], 'no shell in the snapshot is killed: it may be the new turn\'s');
  assert.deepEqual(entry.work, [NEW_SHELL], 'the new turn\'s work is not wiped');
  assert.ok(!types(h.runner, id).includes('bg-stopped'));
  assert.equal(h.runner.status(id).status, 'running');
  h.runner.shutdown();
});

// ---- (2) held checks reality ---------------------------------------------------------------------------------------

test('a held entry whose shells are all dead is dropped when held is read (no waiting for the next poll), then the idea-112 wake runs', async () => {
  const h = harness(); // poll 60 s: without the reality check the stale hold would stand a full minute
  const id = h.create();
  h.shells(id, [GODOT]);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  assert.deepEqual(h.runner.heldIds(), [id], 'pid alive: held');
  h.alive.delete(GODOT.pid); // the tree died (killed by a lead, or it finished)
  h.work.delete(h.pidOf(id));
  assert.deepEqual(h.runner.heldIds(), [], 'dead pid: dropped at once');
  const dead = h.runner.timeline(id).find((e) => e.type === 'park-held-dead');
  assert.deepEqual(dead.pids, [GODOT.pid]);
  await until(() => types(h.runner, id).includes('bg-wake')); // idea-112 kept: the agent still reads its finished work
  await until(() => h.runner.status(id).status === 'running');
  h.runner.shutdown();
});

test('held follows the LATEST probe: one shell died, another is still alive -> still held; no pid known -> kept (fail safe)', async () => {
  const h = harness({ parkHoldPollMs: 20 });
  const id = h.create();
  h.shells(id, [GODOT, WAITER]);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  h.alive.delete(GODOT.pid);
  h.work.set(h.pidOf(id), [WAITER]); // the 11-14 shape: Godot gone, the until-loop waiter still alive
  await tick(80); // a poll or two
  assert.deepEqual(h.runner.heldIds(), [id], 'the waiter is real background work');
  h.alive.delete(WAITER.pid); // dead but the poll has not seen it yet
  assert.deepEqual(h.runner.heldIds(), [], 'all known shells dead');
  h.runner.shutdown();
  const r = new Runner({ dir: tmp(), adapters: {}, bgProbe: null, pidAlive: () => false });
  r.live.set('rn-held', { inflight: 0, quiet: false, heldSince: Date.now() }); // no pids recorded
  assert.deepEqual(r.heldIds(), ['rn-held']);
  r.live.delete('rn-held');
  r.shutdown();
});

test('/health reports held agents with their live shells (heldWork) after the reality check; POST stop-background is scoped', async () => {
  const h = harness();
  const id = h.create();
  h.shells(id, [WAITER]);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  const srv = createRunnerServer(h.runner, { token: 't0k', hash: 'h' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (method, route) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: 'Bearer t0k' } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    let hb = (await call('GET', '/health')).body;
    assert.deepEqual([hb.held, hb.heldAgents], [1, [id]]);
    assert.deepEqual(hb.heldWork[id].map((w) => w.pid), [WAITER.pid]);
    assert.match(hb.heldWork[id][0].cmd, /until grep/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/agents/${id}/stop-background`, { method: 'POST' })).status, 401);
    assert.equal((await call('POST', '/agents/rn-nope/stop-background')).status, 404);
    const r = await call('POST', `/agents/${id}/stop-background`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.stopped.map((w) => w.pid), [WAITER.pid]);
    assert.deepEqual(h.treeKills, [WAITER.pid]);
    h.work.delete(h.pidOf(id));
    hb = (await call('GET', '/health')).body;
    assert.deepEqual([hb.held, hb.heldAgents, hb.heldWork], [0, [], {}]);
  } finally { await new Promise((r) => srv.close(r)); h.runner.shutdown(); }
});

// ---- (3) drained is cross-checked against the runner's held list ---------------------------------------------------

function deferredHome() {
  const home = tmp();
  const now = Date.parse('2026-11-14T05:25:00.000Z');
  const iso = (min) => new Date(now - min * 60000).toISOString();
  const L = (leadId, lane, held) => ({ team: 'efi', lane, leadId, leadTitle: null, heldAgents: held, ask: 'x' });
  writeFileSync(path.join(home, `restart-${iso(11).replace(/[:.]/g, '-')}.json`), JSON.stringify({ startedAt: iso(11), finishedAt: iso(2), dryRun: false, ok: false, errors: [],
    deferred: { held: 2, heldAgents: ['rn-83342416653e', 'rn-b'], running: 0, leads: [L('rn-cdc0bf03dfbf', 'ui-shell-hideout', ['rn-83342416653e']), L('rn-lead-ui', 'ui', ['rn-b'])], unresolved: [] } }));
  const drain = (agent, min) => { mkdirSync(path.join(home, 'teams', 'efi'), { recursive: true }); writeFileSync(path.join(home, 'teams', 'efi', 'log.jsonl'), JSON.stringify({ ts: iso(min), agent, lane: 'x', type: 'metric', text: 'restart-feedback: drained restart', refs: [] }) + '\n', { flag: 'a' }); };
  return { home, now, drain };
}

test("drain guard: a lead's 'drained restart' is not accepted while the runner still holds its agents; it names what still holds", () => {
  const { home, now, drain } = deferredHome();
  drain('rn-cdc0bf03dfbf', 1);
  drain('rn-lead-ui', 1);
  const held = { ids: ['rn-83342416653e'], work: { 'rn-83342416653e': [WAITER] } };
  const g = drainGuard(home, { now, held });
  assert.deepEqual(g.pending.map((l) => l.leadId), ['rn-cdc0bf03dfbf'], 'drained but still held: pending');
  assert.deepEqual(g.pending[0].stillHeld, ['rn-83342416653e']);
  assert.equal(g.pending[0].drainedButHeld, true);
  const msg = drainGuardMessage(g, now);
  assert.match(msg, /rn-cdc0bf03dfbf/);
  assert.match(msg, /logged 'drained restart' but the runner still holds rn-83342416653e/);
  assert.match(msg, /pid 24420: until grep/, 'names the live shell so the lead can act on it');
  assert.match(msg, /stop-background/);
  assert.ok(!/rn-lead-ui/.test(msg), 'drained and not held: accepted');
  // a thunk works too, and held lists as a plain id array
  assert.deepEqual(drainGuard(home, { now, held: () => ['rn-83342416653e'] }).pending.map((l) => l.leadId), ['rn-cdc0bf03dfbf']);
});

test('drain guard: a named lead whose agents the runner no longer holds is accepted without a drained log; unknown held keeps the old self-report rule', () => {
  const { home, now } = deferredHome();
  const g = drainGuard(home, { now, held: [] });
  assert.deepEqual(g.pending, [], 'runner holds nothing: nothing to drain');
  assert.deepEqual(g.cleared.map((l) => l.leadId), ['rn-cdc0bf03dfbf', 'rn-lead-ui']);
  assert.deepEqual(drainGuard(home, { now, held: ['rn-b'] }).pending.map((l) => l.leadId), ['rn-lead-ui'], 'only the lead whose agent still holds');
  for (const held of [undefined, null, () => null, () => { throw new Error('runner down'); }]) {
    assert.deepEqual(drainGuard(home, { now, held }).pending.map((l) => l.leadId), ['rn-cdc0bf03dfbf', 'rn-lead-ui'], 'fail closed: self-report rule');
  }
});

test('vs restart passes the runner held list to the drain guard', async () => {
  const { commandRestart } = await import('../cli/vs.mjs');
  const { home, now, drain } = deferredHome();
  drain('rn-cdc0bf03dfbf', 1);
  drain('rn-lead-ui', 1);
  const teams = [{ id: 'vibesquad', name: 'VibeSquad', hub: 'vibesquad', lanes: [{ id: 'vibesquad' }] }];
  const run = (heldList) => commandRestart({}, { spawnFn: () => 7, env: { VIBESQUAD_HOME: home }, teams, hasOwnerProof: () => true, now: () => now, heldList });
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await assert.rejects(run(async () => ({ ids: ['rn-83342416653e'], work: {} })), /still holds rn-83342416653e/);
    assert.equal(await run(async () => ({ ids: [], work: {} })), 0, 'nothing held: proceeds');
    assert.equal(await run(async () => null), 0, 'runner unreachable: the old self-report rule (both drained)');
  } finally { process.stdout.write = orig; }
});
