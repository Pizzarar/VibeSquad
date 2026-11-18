// idea-146 + idea-312: the live-process cap (maxLive) and the held-for-background park.
// 312 live (EFI 11-17, rn-887dd29362ad and 15 more): a Godot suite that ran past the 60 min max hold was force-parked at
// 60 min with nothing needing the slot, the CLI (and the work) killed silently: no wake, no notice; the lead had to tell
// the worker by hand. 146: only an agent with a live turn, or with background work actually running, may keep a live slot;
// an idle one releases it, and a held one past its yield age gives it up when the queue needs room (and hears why).
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, bgWakeText, bgForcedText, parkHoldMaxFromEnv, parkHoldYieldFromEnv, DEFAULT_PARK_HOLD_MAX_MS, DEFAULT_PARK_HOLD_YIELD_MS } from '../runner/runner.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-livecap-')); dirs.push(d); return d; };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
const SUITE = [{ pid: 9000, name: 'bash', cmd: "eval 'tools/run_godot.sh suite --timeout 7000 > /tmp/trim/suite2.out 2>&1'" }];

function harness(opts = {}) {
  const ems = new Map();
  const sends = [];
  const kills = [];
  const work = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, send(text) { sends.push({ id, text }); emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe: async (pid) => work.get(pid) ?? [], ...opts });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)?.('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  return { runner, ems, sends, kills, work, create, endTurn, pidOf };
}

test('defaults: the hard max hold outlasts a 2 h suite; a hold yields its slot to the queue after 60 min', () => {
  assert.equal(DEFAULT_PARK_HOLD_MAX_MS, 4 * 60 * 60 * 1000);
  assert.equal(parkHoldMaxFromEnv({}), DEFAULT_PARK_HOLD_MAX_MS);
  assert.equal(DEFAULT_PARK_HOLD_YIELD_MS, 60 * 60 * 1000);
  assert.equal(parkHoldYieldFromEnv({}), DEFAULT_PARK_HOLD_YIELD_MS);
  assert.equal(parkHoldYieldFromEnv({ VS_RUNNER_PARK_HOLD_YIELD_MS: '5000' }), 5000);
  assert.equal(parkHoldYieldFromEnv({ VS_RUNNER_PARK_HOLD_YIELD_MS: 'x' }), DEFAULT_PARK_HOLD_YIELD_MS);
});

test('312: a hold past its yield age with nothing queued keeps running; the work exits -> one wake', async () => {
  const h = harness({ parkHoldYieldMs: 40 });
  try {
    const id = h.create();
    h.work.set(h.pidOf(id), SUITE);
    h.endTurn(id);
    await until(() => types(h.runner, id).includes('park-held'));
    await tick(150); // well past the yield age: no queue, so nothing needs its slot
    assert.deepEqual(h.kills, [], 'a held agent with running work is never parked or killed for its age alone');
    assert.ok(!types(h.runner, id).includes('park-forced'));
    h.work.delete(h.pidOf(id)); // the suite finishes
    await until(() => h.sends.length === 2);
    assert.equal(h.sends[1].text, bgWakeText(SUITE));
    h.endTurn(id);
    await until(() => h.runner.status(id).status === 'parked');
    assert.equal(types(h.runner, id).filter((t) => t === 'bg-wake').length, 1, 'woken once');
  } finally { h.runner.shutdown(); }
});

test('146: a held agent under its yield age keeps its slot; the queued job waits, then starts once the work exits', async () => {
  const h = harness({ maxLive: 1, parkHoldYieldMs: 60_000 });
  try {
    const a = h.create();
    h.work.set(h.pidOf(a), SUITE);
    h.endTurn(a);
    await until(() => types(h.runner, a).includes('park-held'));
    const b = h.create();
    await tick(80);
    assert.equal(h.runner.status(b).status, 'queued');
    assert.deepEqual(h.kills, []);
    h.work.delete(h.pidOf(a));
    await until(() => h.sends.some((s) => s.id === a && s.text === bgWakeText(SUITE)));
    h.endTurn(a); // the woken turn reports and ends: now it is idle with no work and releases the slot
    await until(() => h.sends.some((s) => s.id === b));
    assert.equal(h.runner.status(a).status, 'parked');
  } finally { h.runner.shutdown(); }
});

test('146: an idle agent with no background work releases its slot to a queued job at once', async () => {
  const h = harness({ maxLive: 1, parkGraceMs: 60_000 }); // a long grace: only the room-park can free it
  try {
    const a = h.create();
    h.endTurn(a);
    const b = h.create();
    await until(() => h.sends.some((s) => s.id === b));
    assert.equal(h.runner.status(a).status, 'parked');
  } finally { h.runner.shutdown(); }
});

test('146: a hold past its yield age gives its slot to a queued job (oldest hold first) and the agent is told, once', async () => {
  const h = harness({ maxLive: 2, parkHoldYieldMs: 40 });
  try {
    const a = h.create();
    h.work.set(h.pidOf(a), SUITE);
    h.endTurn(a);
    await until(() => types(h.runner, a).includes('park-held'));
    await tick(20);
    const b = h.create();
    h.work.set(h.pidOf(b), [{ ...SUITE[0], pid: 9001 }]);
    h.endTurn(b);
    await until(() => types(h.runner, b).includes('park-held'));
    await tick(60); // both past the yield age; a is the older hold
    const c = h.create();
    await until(() => h.sends.some((s) => s.id === c));
    const forced = h.runner.timeline(a).filter((e) => e.type === 'park-forced');
    assert.equal(forced.length, 1);
    assert.equal(forced[0].reason, 'room');
    assert.equal(forced[0].work[0].pid, 9000);
    assert.ok(!types(h.runner, b).includes('park-forced'), 'one slot needed: one hold yields');
    assert.equal(h.runner.status(b).status, 'idle');
    // a hears why (queued behind c: it waits for a slot like any send)
    h.endTurn(c);
    await until(() => h.sends.some((s) => s.id === a && s.text === bgForcedText(SUITE, forced[0].heldMs, 'room')));
    assert.equal(types(h.runner, a).filter((t) => t === 'bg-wake').length, 1);
  } finally { h.runner.shutdown(); }
});

test('146: a hold under its yield age is never taken for room, whatever the queue', async () => {
  const h = harness({ maxLive: 1, parkHoldYieldMs: 60_000 });
  try {
    const a = h.create();
    h.work.set(h.pidOf(a), SUITE);
    h.endTurn(a);
    await until(() => types(h.runner, a).includes('park-held'));
    h.create();
    h.create();
    await tick(100);
    assert.deepEqual(h.kills, []);
    assert.ok(!types(h.runner, a).includes('park-forced'));
  } finally { h.runner.shutdown(); }
});

test('312: work exits while the queue needs room -> the held agent is woken, not room-parked into silence', async () => {
  const h = harness({ maxLive: 1, parkGraceMs: 200, parkHoldYieldMs: 60_000 });
  try {
    const a = h.create();
    h.work.set(h.pidOf(a), SUITE);
    h.endTurn(a);
    await until(() => types(h.runner, a).includes('park-held'), 3000);
    h.work.delete(h.pidOf(a)); // the suite ends; the hold's next poll clears it and arms the one-grace wake check
    await until(() => h.runner.live.get(a)?.heldSince === null);
    h.create(); // a queued job arrives inside that grace: it must not room-park a before its wake
    await until(() => h.sends.some((s) => s.id === a && s.text === bgWakeText(SUITE)));
    assert.ok(!types(h.runner, a).includes('parked'), 'woken in place, never parked first');
  } finally { h.runner.shutdown(); }
});

test('312: the hard max hold still forces the park, and the agent is told its work was stopped (not left silent)', async () => {
  const h = harness({ parkHoldMaxMs: 60, parkHoldYieldMs: 30 });
  try {
    const id = h.create();
    h.work.set(h.pidOf(id), SUITE);
    h.endTurn(id);
    await until(() => types(h.runner, id).includes('park-forced'));
    const forced = h.runner.timeline(id).find((e) => e.type === 'park-forced');
    assert.equal(forced.reason, 'max');
    await until(() => h.sends.length === 2);
    assert.equal(h.sends[1].text, bgForcedText(SUITE, forced.heldMs, 'max'));
    assert.match(h.sends[1].text, /may not have finished/);
    assert.equal(types(h.runner, id).filter((t) => t === 'bg-wake').length, 1);
  } finally { h.runner.shutdown(); }
});
