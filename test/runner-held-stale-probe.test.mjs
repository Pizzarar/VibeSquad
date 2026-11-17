// idea-305: `vs restart` deferred on rn-e74150250df3 (an idle worker) as "held", while `vs stop --background` found no shell
// (stoppedBackground: []). Its log: a CLI self-started turn ran 19:01:06-19:01:12Z right after a park check had started a
// process snapshot; the turn's idle armed the 3s grace, whose park check reused that still-running snapshot. The snapshot
// predated the turn, so it settled to null ("a turn started, its idle re-arms") and the check returned. Nothing re-armed:
// the agent sat idle and unprobed (work null) and heldIds listed it until the stop's own probe cleared it 87 min later.
// Fixed: the probe dedupe is per turn (Runner._probeWork), and heldIds re-arms an unprobed hold with no check pending.
import "./helpers/clean-env.mjs";
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-stalehold-')); dirs.push(d); return d; };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const GRACE = 3000;

function harness(t) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => mock.timers.reset());
  const probes = []; // each snapshot: { resolve } (settled by the test, so one can still be running when a turn opens)
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) { ems.set(id, emit); return { pid: nextPid++, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; },
  };
  const bgProbe = () => new Promise((resolve) => probes.push({ resolve }));
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: GRACE, parkHoldPollMs: 15_000, parkHoldMaxMs: 3_600_000, bgProbe, pidAlive: () => false, killPid: () => {} });
  t.after(() => { for (const e of runner.live.values()) clearTimeout(e.parkTimer); });
  const create = () => {
    const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' });
    ems.get(id)('session', { sessionId: `s-${id}` });
    return id;
  };
  const em = (id, ...a) => ems.get(id)(...a);
  const endTurn = (id) => { em(id, 'turn_done', {}); em(id, 'status', { status: 'idle' }); };
  const tick = async (ms) => { mock.timers.tick(ms); await flush(); };
  return { runner, probes, create, em, endTurn, tick };
}

test('idea-305: a turn that opens and ends while a park probe runs gets its own fresh probe, not the stale one', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.endTurn(id);
  await h.tick(GRACE); // the grace fires: the park check starts snapshot #1
  assert.equal(h.probes.length, 1);

  // The CLI opens a turn on its own (a task notification) and ends it while snapshot #1 is still running.
  h.em(id, 'status', { status: 'running' });
  h.endTurn(id);
  await h.tick(GRACE); // that idle's grace fires: its park check must not reuse snapshot #1 (it predates the turn)
  assert.equal(h.probes.length, 2, 'a fresh snapshot for the ended turn');

  h.probes[0].resolve([]); // the stale snapshot lands: settles to null, its check returns
  await h.tick(0);
  assert.deepEqual(h.runner.heldIds(), [id], 'still unprobed until snapshot #2 lands');
  h.probes[1].resolve([]);
  await h.tick(0);
  assert.ok(types(h.runner, id).includes('parked'), 'parked once the fresh snapshot saw no shell');
  assert.deepEqual(h.runner.heldIds(), []);
  assert.ok(!types(h.runner, id).includes('park-rearm'), 'no watchdog needed on this path');
});

test('idea-305: heldIds re-arms an unprobed hold with no park check pending, so held and vs stop --background agree', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.endTurn(id);
  await h.tick(GRACE);
  h.probes[0].resolve([]);
  await h.tick(0);
  assert.ok(types(h.runner, id).includes('parked'));

  // Same lost re-arm, forced directly on a live idle agent: unprobed, no timer, no probe in flight.
  const id2 = h.create();
  h.endTurn(id2);
  const e = h.runner.live.get(id2);
  clearTimeout(e.parkTimer);
  e.parkTimer = null;
  assert.equal(e.work, null);
  assert.deepEqual(h.runner.heldIds(), [id2], 'listed while its first probe is due');
  assert.ok(types(h.runner, id2).includes('park-rearm'));
  assert.deepEqual(h.runner.heldIds(), [id2], 'the second read does not re-arm again');
  assert.equal(types(h.runner, id2).filter((x) => x === 'park-rearm').length, 1);
  await h.tick(GRACE);
  assert.equal(h.probes.length, 2, 'the re-armed check probes');
  h.probes[1].resolve([]);
  await h.tick(0);
  assert.ok(types(h.runner, id2).includes('parked'));
  assert.deepEqual(h.runner.heldIds(), []);
});
