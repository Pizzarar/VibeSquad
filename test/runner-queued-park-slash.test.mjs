// idea-868 + idea-869 (@perfection K2a evidence, docs/lanes/perfection/K2A.md C2/C3).
//   868: the runner parks an idle agent whose next prompt waits in the family queue (to free a live slot). That park is not a
//        turn end: the server's reduceTurn must not emit turn_ended for it, the log must still say queued (status, restart).
//   869: runner.send never joins a slash command (`/compact`) to other text in a queued job, either way round. It stays a turn
//        of its own, and the messages sent after it run as their own turn once its turn ends (never steered into it).
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, isSlashText, turnGroups } from '../runner/runner.mjs';
import { reduceTurn } from '../server/backend/runner-backend.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-qpark-slash-')); dirs.push(d); return d; };

// A controllable adapter that records every text each process was handed (steers included) by agent id.
function recAdapter() {
  const started = [];
  const adapter = {
    canPark: true,
    start({ id, emit, onExit }) {
      const rec = { id, emit, onExit, texts: [], killed: false };
      started.push(rec);
      return { send(text) { rec.texts.push(text); emit('status', { status: 'running' }); }, cancel() {}, kill() { rec.killed = true; } };
    },
  };
  adapter.started = started;
  adapter.textsOf = (id) => started.filter((r) => r.id === id).flatMap((r) => r.texts);
  adapter.procOf = (id) => started.filter((r) => r.id === id && !r.killed).at(-1);
  return adapter;
}

const boot = (dir, adapter, opts = {}) => new Runner({ dir, adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, maxLive: 16, ...opts });
const mk = (runner, prompt) => runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt });
const idle = (rec) => rec.emit('status', { status: 'idle' });
const serverTurns = (runner, id) => { const t = {}; return runner.timeline(id).map((e) => reduceTurn(t, e)).filter(Boolean).map((r) => r.kind); };
const statuses = (runner, id) => runner.timeline(id).filter((e) => e.type === 'status').map((e) => e.status);

// Agent `a` has run one turn and sits idle (with a session, so it can park); `b` holds the family's single turn slot.
function setup(opts) {
  const dir = tmp();
  const adapter = recAdapter();
  const runner = boot(dir, adapter, opts);
  const a = mk(runner, 'hi');
  const ra = adapter.procOf(a);
  ra.emit('session', { sessionId: 'S-a' });
  idle(ra);
  const b = mk(runner, 'b');
  return { dir, adapter, runner, a, b, ra, rb: adapter.procOf(b) };
}

// ---- idea-868 ----

test('868 reduceTurn: a park while the prompt waits in the queue is not a turn end (tagged and untagged)', () => {
  for (const parked of [{ type: 'status', status: 'parked', queued: true }, { type: 'status', status: 'parked' }]) {
    const t = { status: 'idle', errored: false };
    const seen = [
      { type: 'input', text: '/compact' },
      { type: 'status', status: 'queued', ahead: 2 },
      { type: 'parked', sessionId: 'S' },
      { ...parked, seq: 4 },
    ].map((e) => reduceTurn(t, e)).filter(Boolean);
    assert.deepEqual(seen, [], `no lifecycle event for ${JSON.stringify(parked)}`);
    assert.deepEqual(t.queued, { ahead: 2 }, 'still queued: the prompt has not run');
    const rest = [{ type: 'status', status: 'starting' }, { type: 'status', status: 'running' }, { type: 'status', status: 'idle', seq: 7 }].map((e) => reduceTurn(t, e)).filter(Boolean);
    assert.deepEqual(rest.map((r) => r.kind), ['turn_started', 'turn_ended'], 'the queued prompt\'s own turn opens and closes once');
    assert.equal(rest[1].outcome.kind, 'completed');
  }
});

test('868 reduceTurn: a queued prompt that fails to start (_failJob: error, then parked) still closes as a failed turn', () => {
  const t = { status: 'idle', errored: false };
  const out = [
    { type: 'input', text: 'go' },
    { type: 'status', status: 'queued', ahead: 0 },
    { type: 'error', message: 'no live process slot free' },
    { type: 'parked', sessionId: 'S' },
    { type: 'status', status: 'parked', seq: 5 },
  ].map((e) => reduceTurn(t, e)).filter(Boolean);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'turn_ended');
  assert.equal(out[0].outcome.kind, 'failed');
});

test('868 reduceTurn: an error left from a closed turn does not turn the next queued park into a failed turn end', () => {
  const t = { status: 'idle', errored: false };
  const out = [
    { type: 'input', text: 'one' },
    { type: 'status', status: 'running' },
    { type: 'error', message: 'tool blew up' },
    { type: 'status', status: 'idle', seq: 4 }, // turn 1 ends failed
    { type: 'input', text: '/compact' },
    { type: 'status', status: 'queued', ahead: 1 },
    { type: 'parked', sessionId: 'S' },
    { type: 'status', status: 'parked', seq: 8 }, // untagged (older runner): read by the queued state, not the stale error
  ].map((e) => reduceTurn(t, e)).filter(Boolean);
  assert.deepEqual(out.map((r) => [r.kind, r.outcome?.kind]), [['turn_started', undefined], ['turn_ended', 'failed']]);
});

test('868 runner: parking an agent whose /compact waits in the queue tags the park, keeps the log queued, and emits no turn end', () => {
  const { adapter, runner, a, rb } = setup();
  const sent = runner.send(a, '/compact');
  assert.equal(sent.queued, true, 'the family cap (1) is held by b');
  runner.park(a); // what _makeRoom does to free a live slot
  const tl = runner.timeline(a);
  const parkAt = tl.findIndex((e) => e.type === 'status' && e.status === 'parked');
  assert.equal(tl[parkAt].queued, true, 'the park is tagged queued');
  assert.equal(tl[parkAt + 1]?.status, 'queued', 'the log goes back to queued after the park');
  assert.equal(runner.status(a).status, 'queued', 'status() still says queued');
  assert.deepEqual(serverTurns(runner, a), ['turn_started', 'turn_ended'], 'only the first turn: the park is no turn end');

  idle(rb); // the slot frees: the queued /compact resumes a and runs as its own turn
  const ra2 = adapter.procOf(a);
  assert.deepEqual(ra2.texts, ['/compact']);
  idle(ra2);
  assert.deepEqual(serverTurns(runner, a), ['turn_started', 'turn_ended', 'turn_started', 'turn_ended']);
  runner.shutdown();
});

test('868 runner: a /compact queued when its agent was parked for room survives a runner restart', () => {
  const { dir, runner, a } = setup();
  runner.send(a, '/compact');
  runner.park(a);
  runner.shutdown();
  const adapter2 = recAdapter();
  const runner2 = boot(dir, adapter2);
  assert.deepEqual(runner2.recoverQueued(), [a], 'the queued input is re-enqueued (the log still ends in queued)');
  assert.deepEqual(adapter2.textsOf(a), ['/compact'], 'and runs alone (the slot is free after the restart)');
  runner2.shutdown();
});

// ---- idea-869 ----

test('869 helpers: slash detection and turn grouping', () => {
  for (const s of ['/compact', '/compact keep the plan', '  /clear', '/model:x y']) assert.equal(isSlashText(s), true, s);
  for (const s of ['/home/me/file.txt is broken', 'hi /compact', '', null, 'compact', '/ space']) assert.equal(isSlashText(s), false, String(s));
  assert.deepEqual(turnGroups(['a', 'b', '/compact', 'c', 'd', '/clear']), [
    { text: 'a\n\nb', slash: false }, { text: '/compact', slash: true }, { text: 'c\n\nd', slash: false }, { text: '/clear', slash: true },
  ]);
  assert.deepEqual(turnGroups(['/compact', '/compact']), [{ text: '/compact', slash: true }, { text: '/compact', slash: true }]);
});

test('869: a wake sent after a queued /compact is not merged into it; it runs as its own turn after the /compact turn', () => {
  const { adapter, runner, a, rb, ra } = setup();
  assert.equal(runner.send(a, '/compact').queued, true);
  assert.equal(runner.send(a, 'wake: watch complete').queued, true);
  assert.equal(runner.queue.filter((j) => j.id === a).length, 2, 'two jobs: never one merged text');
  idle(rb);
  assert.deepEqual(ra.texts, ['hi', '/compact'], 'the /compact turn gets exactly /compact (the wake is not steered into it)');
  const after = runner.timeline(a).slice(runner.timeline(a).findLastIndex((e) => e.type === 'status' && e.status === 'running'));
  assert.ok(!after.some((e) => e.type === 'status' && e.status === 'queued'), 'no queued status during the /compact turn');
  idle(ra);
  assert.deepEqual(ra.texts, ['hi', '/compact', 'wake: watch complete'], 'the wake runs as the next turn');
  idle(ra);
  assert.deepEqual(serverTurns(runner, a), ['turn_started', 'turn_ended', 'turn_started', 'turn_ended', 'turn_started', 'turn_ended']);
  runner.shutdown();
});

test('869: a /compact sent after a queued wake is not merged into it (no "<wake>\\n\\n/compact" plain text)', () => {
  const { runner, a, rb, ra } = setup();
  runner.send(a, 'wake: log event');
  runner.send(a, '/compact keep the plan');
  idle(rb);
  assert.deepEqual(ra.texts, ['hi', 'wake: log event']);
  idle(ra);
  assert.deepEqual(ra.texts, ['hi', 'wake: log event', '/compact keep the plan']);
  runner.shutdown();
});

test('869: plain sends still coalesce into one queued job (one turn)', () => {
  const { runner, a, rb, ra } = setup();
  runner.send(a, 'one');
  runner.send(a, 'two');
  assert.equal(runner.queue.filter((j) => j.id === a).length, 1);
  idle(rb);
  assert.deepEqual(ra.texts, ['hi', 'one\n\ntwo']);
  runner.shutdown();
});

test('869: a message sent while a /compact turn runs waits for that turn to end (never steered into it); a steer-only one is dropped', () => {
  const { runner, a, ra } = setup({ turnCaps: { claude: 2 } });
  assert.equal(runner.send(a, '/compact').queued, false, 'room: the /compact runs at once');
  assert.equal(runner.send(a, 'wake: done').queued, true, 'the next message waits behind the /compact turn');
  assert.deepEqual(runner.send(a, 'nudge', { steerOnly: true }), { queued: false, delivered: false, reason: 'queued' });
  assert.deepEqual(ra.texts, ['hi', '/compact']);
  idle(ra);
  assert.deepEqual(ra.texts, ['hi', '/compact', 'wake: done']);
  idle(ra);
  runner.send(a, '/compact');
  assert.deepEqual(runner.send(a, 'nudge', { steerOnly: true }), { queued: false, delivered: false, reason: 'slash-turn' });
  assert.deepEqual(ra.texts, ['hi', '/compact', 'wake: done', '/compact']);
  runner.shutdown();
});

test('869: a plain message into a running plain turn is still a steer (unchanged)', () => {
  const { runner, a, ra } = setup({ turnCaps: { claude: 2 } });
  runner.send(a, 'work');
  assert.equal(runner.send(a, 'steer').queued, false);
  assert.deepEqual(ra.texts, ['hi', 'work', 'steer']);
  runner.shutdown();
});

test('869: queued inputs with a /compact among them are re-enqueued after a runner restart as separate turns', () => {
  const { dir, runner, a } = setup();
  runner.send(a, 'wake: one');
  runner.send(a, '/compact');
  runner.send(a, 'wake: two');
  runner.shutdown();
  const adapter2 = recAdapter();
  const runner2 = boot(dir, adapter2);
  assert.deepEqual(runner2.recoverQueued(), [a]);
  const r = adapter2.procOf(a);
  assert.deepEqual(r.texts, ['wake: one']);
  idle(r);
  assert.deepEqual(r.texts, ['wake: one', '/compact']);
  idle(r);
  assert.deepEqual(r.texts, ['wake: one', '/compact', 'wake: two']);
  runner2.shutdown();
});
