// cpu-profile-1114 fix 1: a held park re-checks its background work with a whole process-table snapshot (Windows: a
// powershell CIM query). A hold polls at parkHoldPollMs for its first minute, then takes a snapshot only every
// parkHoldSlowPollMs; the ticks between are a cheap pid liveness check of the shells the last snapshot saw, so a finished
// suite still drops the hold (and wakes the agent, idea-112) within one fast poll. Fake clock (node:test mock timers).
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-parkbackoff-')); dirs.push(d); return d; };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const POLL = 15_000;
const SUITE = { pid: 27324, name: 'bash', cmd: 'npm test -- --queue' };

function harness(t, opts = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => mock.timers.reset());
  const work = new Map();
  const alive = new Set();
  const probes = []; // fake-clock time of every snapshot
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, sends: [], send(x) { this.sends.push(x); emit('status', { status: 'running' }); }, cancel() {}, kill() {} };
    },
  };
  const bgProbe = async (pid) => { probes.push(Date.now()); return work.get(pid) ?? []; };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: POLL, parkHoldMaxMs: 3_600_000, bgProbe, pidAlive: (pid) => alive.has(pid), ...opts });
  t.after(() => { for (const e of runner.live.values()) clearTimeout(e.parkTimer); });
  const create = () => {
    const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' });
    ems.get(id)('session', { sessionId: `s-${id}` });
    return id;
  };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  const shells = (id, list) => { work.set(pidOf(id), list); for (const s of list) alive.add(s.pid); };
  // Advance the fake clock to `to` one second at a time, letting each fired timer's probe settle.
  const advanceTo = async (to) => { await flush(); while (Date.now() < to) { mock.timers.tick(1000); await flush(); } };
  return { runner, work, alive, probes, create, endTurn, pidOf, shells, advanceTo };
}

// Snapshot times relative to the hold's first one (the grace timer fires on the first fake tick).
const rel = (list, from = 0) => list.slice(from).map((x) => x - list[from]);

test('held park: snapshots every parkHoldPollMs for the first minute, then every 60s (4 x poll)', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(300_000);
  assert.ok(types(h.runner, id).includes('park-held'));
  assert.deepEqual(rel(h.probes), [0, 15_000, 30_000, 45_000, 105_000, 165_000, 225_000, 285_000]);
  assert.deepEqual(h.runner.heldIds(), [id], 'still held: the cheap ticks keep the hold while its shell lives');
});

test('slow phase: the shell exits -> the pid check drops the hold within one fast poll and the idea-112 wake runs', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(121_000); // slow phase; the tick at ~121s was a cheap one (last snapshot ~106s, next ~166s)
  const before = h.probes.length;
  h.alive.delete(SUITE.pid); // the suite finishes
  h.work.set(h.pidOf(id), []);
  await h.advanceTo(140_000);
  assert.ok(types(h.runner, id).includes('park-held-dead'), 'dropped by the pid check, not the next snapshot');
  assert.ok(types(h.runner, id).includes('bg-wake'), 'the agent is woken about its finished work');
  assert.equal(h.probes.length, before + 1, 'one fresh snapshot (after the grace) confirms nothing is left');
  assert.ok(h.probes.at(-1) <= 137_000, `woken within one fast poll (probe at ${h.probes.at(-1)})`);
  assert.deepEqual(h.runner.heldIds(), []);
});

test('back-off resets when a new turn starts: the next hold polls fast again for its first minute', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(200_000); // slow phase
  h.runner.send(id, 'next task');
  await h.advanceTo(201_000);
  assert.equal(h.runner.live.get(id).heldSince, null, 'the turn cleared the hold');
  const from = h.probes.length;
  h.endTurn(id); // the suite is still running: a new hold
  await h.advanceTo(340_000);
  assert.deepEqual(rel(h.probes, from), [0, 15_000, 30_000, 45_000, 105_000]);
});

test('back-off resets when a hold clears without a turn: the re-taken hold starts its first minute again', async (t) => {
  const h = harness(t);
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(121_000);
  const from = h.probes.length;
  const NEXT = { ...SUITE, pid: 30001, cmd: 'npm run build' };
  h.alive.delete(SUITE.pid); // the suite ends, but another shell is already running under the CLI
  h.shells(id, [NEXT]);
  await h.advanceTo(140_000);
  assert.ok(types(h.runner, id).includes('park-held-dead'));
  assert.ok(!types(h.runner, id).includes('bg-wake'), 'still held on the new shell');
  assert.deepEqual(h.runner.heldIds(), [id]);
  await h.advanceTo(260_000);
  assert.deepEqual(rel(h.probes, from), [0, 15_000, 30_000, 45_000, 105_000]);
});

test('no liveness check (pidAlive null): the hold stands on the 60s snapshots alone and still ends', async (t) => {
  const h = harness(t, { pidAlive: null });
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(121_000);
  h.work.set(h.pidOf(id), []);
  await h.advanceTo(160_000);
  assert.ok(!types(h.runner, id).includes('bg-wake'), 'no pid check: nothing notices before the next snapshot');
  await h.advanceTo(175_000); // the ~166s snapshot sees nothing
  assert.ok(types(h.runner, id).includes('bg-wake'));
});

test('parkHoldMaxMs is unchanged by the back-off: the park is forced on time', async (t) => {
  const h = harness(t, { parkHoldMaxMs: 200_000 });
  const id = h.create();
  h.shells(id, [SUITE]);
  h.endTurn(id);
  await h.advanceTo(200_000);
  assert.ok(!types(h.runner, id).includes('park-forced'));
  await h.advanceTo(203_000);
  assert.ok(types(h.runner, id).includes('park-forced'));
  assert.equal(h.probes.at(-1) - h.probes[0], 200_000, 'forced exactly at max, on a fresh snapshot of what it kills');
});

test('parkHoldSlowAfterMs / parkHoldSlowPollMs: defaults 60s and 4 x poll; slow poll never below the fast poll', () => {
  const r = new Runner({ dir: tmp(), adapters: {}, parkHoldPollMs: 5_000, bgProbe: null });
  assert.equal(r.parkHoldSlowAfterMs, 60_000);
  assert.equal(r.parkHoldSlowPollMs, 20_000);
  const r2 = new Runner({ dir: tmp(), adapters: {}, parkHoldPollMs: 5_000, parkHoldSlowPollMs: 1_000, bgProbe: null });
  assert.equal(r2.parkHoldSlowPollMs, 5_000);
});
