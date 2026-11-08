// Q0 (inflight leak) + Q3 (quiet turns) — runner turn-slot accounting.
//   Q0: a steer delivered into a running turn must not open a second slot (the adapter emits one idle for the merged
//       turn); idle resets inflight to 0. cancel/error/exit paths must not leak a slot either.
//   Q3: a running turn with no log events for VS_RUNNER_QUIET_MS is flagged quiet and stops counting toward its family
//       cap (queue advances), but its process keeps running and its next event counts it again.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-queueslots-')); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A controllable adapter: captures each started agent's emit/onExit so the test drives turn events synchronously.
// `send` emits `running` (like the real adapters) but produces no further events until the test calls emit.
function controlledAdapter() {
  const started = []; // { emit, onExit, killed } in start order
  const adapter = {
    canPark: true,
    start({ emit, onExit }) {
      const rec = { emit, onExit, killed: false };
      started.push(rec);
      return { send() { emit('status', { status: 'running' }); }, cancel() {}, kill() { rec.killed = true; } };
    },
  };
  adapter.started = started;
  return adapter;
}

const mk = (runner, extra = {}) => runner.create({ provider: 'claude', cwd: os.tmpdir(), ...extra });
const runningCount = (runner) => [...runner.live.values()].filter((e) => e.inflight > 0).length;

test('Q0: a steer into a running turn takes no extra slot; one idle frees it and the queue pumps', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true, 'b waits behind a (cap 1)');
  assert.equal(runner.live.get(a).inflight, 1, 'a holds the single slot');

  // Steer twice into a's already-running turn.
  runner.send(a, 'steer 1');
  runner.send(a, 'steer 2');
  assert.equal(runner.live.get(a).inflight, 1, 'steers merge into the open turn: still one slot, not three');
  assert.equal(runner._running('claude'), 1, 'a is the only counted running turn');

  // The merged turn ends with a single idle.
  adapter.started[0].emit('status', { status: 'idle' });
  assert.equal(runner.live.get(a).inflight, 0, 'idle reset inflight to 0 (no leaked slot)');
  assert.equal(runner.queuePosition(b).queued, false, 'the queue pumped: b started');
  assert.equal(runner.live.get(b).inflight, 1, 'b now holds the slot');
  runner.shutdown();
});

test('Q0: a process exit mid-turn frees the slot (no inflight leak)', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true);
  assert.equal(runner.live.get(a).inflight, 1);

  adapter.started[0].onExit({ code: 1 }); // the child dies mid-turn
  assert.equal(runner.live.get(a), undefined, 'exited agent removed from live');
  assert.equal(runner.queuePosition(b).queued, false, 'exit freed the slot: b started');
  assert.equal(runner.live.get(b).inflight, 1);
  runner.shutdown();
});

test('Q0: an error event is cleared by the adapter idle that follows it (no inflight leak)', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });

  adapter.started[0].emit('error', { message: 'boom' });
  assert.equal(runner.live.get(a).inflight, 1, 'error alone does not clear the slot (the adapter still owes an idle)');
  adapter.started[0].emit('status', { status: 'idle' }); // the adapters always emit idle after a turn (even a failed one)
  assert.equal(runner.live.get(a).inflight, 0, 'idle resets inflight to 0');
  runner.shutdown();
});

test('Q3: a silent turn yields its family slot and the queue advances', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 40 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true, 'b waits behind a (cap 1)');

  // a has produced no events since it started: simulate it having been silent past the quiet window, then sweep.
  runner.live.get(a).lastEvent = Date.now() - 1000;
  runner._sweepQuiet();

  assert.equal(runner.live.get(a).quiet, true, 'a flagged quiet');
  assert.ok(runner.timeline(a).some((e) => e.type === 'turn-quiet'), 'turn-quiet metric emitted');
  assert.equal(runner.queuePosition(b).queued, false, 'b started once a went quiet');
  assert.equal(runner.live.get(b).inflight, 1, 'b is running');
  assert.equal(runner._running('claude'), 1, 'quiet a does not count toward the cap');
  runner.shutdown();
});

test('Q3: a quiet turn that emits an event counts again (over the cap) and is never cancelled', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 40 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true);

  runner.live.get(a).lastEvent = Date.now() - 1000;
  runner._sweepQuiet();
  assert.equal(runner.live.get(a).quiet, true);
  assert.equal(runner.queuePosition(b).queued, false, 'b started');
  assert.equal(runner._running('claude'), 1, 'a (quiet) not counted; b counted');

  // a's next event clears the quiet flag and it counts again, even though that puts the family over the cap.
  adapter.started[0].emit('output', { text: 'still alive' });
  assert.equal(runner.live.get(a).quiet, false, 'a quiet flag cleared by its next event');
  assert.equal(runner.live.get(a).inflight, 1, 'a still running');
  assert.equal(adapter.started[0].killed, false, 'a never cancelled or killed');
  assert.equal(runningCount(runner), 2, 'both turns running');
  assert.equal(runner._running('claude'), 2, 'a counts again, over the cap (allowed)');
  runner.shutdown();
});

test('Q3: the unref sweep timer flags a silent turn and drains the queue (tests still exit)', async () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 40 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true);

  await tick(200); // the sweep interval (min(quietMs,1000)=40ms) fires on its own
  assert.equal(runner.live.get(a).quiet, true, 'a flagged quiet by the sweep timer');
  assert.equal(runner.queuePosition(b).queued, false, 'queue drained');
  assert.ok(runner.timeline(a).some((e) => e.type === 'turn-quiet'));
  runner.shutdown();
});

test('Q3: /health exposes the quiet flag', async () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const get = () => fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: 'Bearer t' } }).then((r) => r.json());

    let h = await get();
    assert.equal(h.running, 1, 'a running');
    assert.equal(h.quiet, 0, 'nothing quiet yet');

    runner.live.get(a).lastEvent = Date.now() - 70_000; // older than quietMs (60s)
    runner._sweepQuiet();
    h = await get();
    assert.equal(h.running, 1, 'a still running (a quiet turn is still a running process)');
    assert.equal(h.quiet, 1, 'quiet flag exposed in /health');
  } finally { server.close(); server.closeAllConnections?.(); runner.shutdown(); }
});
