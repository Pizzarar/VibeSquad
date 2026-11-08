// Q0 (inflight leak) + Q3 (quiet turns) — runner turn-slot accounting.
//   Q0: a steer delivered into a running turn must not open a second slot (the adapter emits one idle for the merged
//       turn); idle resets inflight to 0. cancel/error/exit paths must not leak a slot either.
//   Q3: a running turn with no log events for VS_RUNNER_QUIET_MS is flagged quiet and stops counting toward its family
//       cap (queue advances), but its process keeps running and its next event counts it again.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';

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

// A claude adapter over a fake child. The test drives results explicitly with child.result() (one per finished turn),
// so a steer/interrupt that queues a follow-up turn is observable (the adapter emits a second 'running' after the first result).
function fakeClaudeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.result = () => child.push({ type: 'result', subtype: 'success' });
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm' }));
    calls.push({ file, args, child, sid });
    return child;
  };
  impl.calls = calls;
  return impl;
}

// An ACP (antigravity-cli) adapter over a fake child. session/prompt requests are captured (in order) and the test
// answers them with finishPrompt(), so a steer queued behind turn 1 is observable.
function fakeAcpSpawn() {
  const prompts = []; // { id, child } for each session/prompt request, in order
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        const m = JSON.parse(l);
        if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
        else if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S' } });
        else if (m.method === 'session/prompt') prompts.push({ id: m.id, child });
      }
    });
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    impl.calls.push({ file, args, opts, child });
    return impl.last = child;
  };
  impl.calls = [];
  impl.prompts = prompts;
  impl.finishPrompt = () => { const p = prompts.shift(); p.child.push({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'end_turn' } }); };
  return impl;
}

// An adapter whose send() emits nothing: isolates what _deliver itself records (inflight/lastEvent/quiet) on a fresh turn.
function silentAdapter() {
  const started = [];
  const adapter = {
    canPark: true,
    start({ emit, onExit }) { started.push({ emit, onExit }); return { send() {}, cancel() {}, kill() {} }; },
  };
  adapter.started = started;
  return adapter;
}

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

// ---- Review-Gemini R1 findings ----

test('H: an ACP steer (a second queued prompt) keeps turn 2 counted while it runs', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } }) }, turnCaps: { antigravity: 1 }, parkGraceMs: 60_000 });
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  for (let i = 0; i < 6; i++) await tick(); // initialize + session/new settle, turn 1 prompt sent
  assert.equal(spawnImpl.prompts.length, 1, 'turn 1 prompt in flight');
  assert.equal(runner.live.get(a).inflight, 1, 'turn 1 counted while running');

  runner.send(a, 'two'); // steer queues a second prompt behind the running turn
  assert.equal(spawnImpl.prompts.length, 1, 'steer not sent yet: turn 1 still in flight');

  spawnImpl.finishPrompt(); // turn 1 ends; the adapter immediately starts turn 2
  await tick(); await tick(); await tick();
  assert.equal(spawnImpl.prompts.length, 1, 'turn 2 prompt now in flight');
  assert.equal(runner.live.get(a).inflight, 1, 'turn 2 re-took the slot (no inflight===0 gap)');

  spawnImpl.finishPrompt(); // turn 2 ends
  await tick(); await tick(); await tick();
  assert.equal(runner.live.get(a).inflight, 0, 'final idle resets inflight to 0');
  runner.shutdown();
});

test('H: an interrupt steer is not parked mid-follow-up-turn (claude adapter)', async () => {
  const spawnImpl = fakeClaudeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, turnCaps: { claude: 1 }, parkGraceMs: 0 });
  const a = mk(runner, { prompt: 'one' });
  await tick();
  assert.equal(runner.live.get(a).inflight, 1);

  runner.send(a, 'two', { activeTurnBehavior: 'interrupt' }); // cancel turn 1 + deliver turn 2
  spawnImpl.calls[0].child.result(); // turn 1 (interrupted) ends
  await tick();
  // turn 2 is now running: it must re-take the slot so it is not parked mid-turn
  assert.equal(runner.live.get(a).inflight, 1, 'turn 2 counted while running');
  assert.equal(runner.live.get(a).status, 'running');
  assert.equal(runner.live.has(a), true, 'not parked mid-turn-2 (parkGraceMs 0 would have parked an idle agent)');

  spawnImpl.calls[0].child.result(); // turn 2 ends
  await tick(30);
  assert.equal(runner.live.has(a), false, 'parked only after the final idle');
  assert.equal(runner.status(a).status, 'parked', 'no leaked slot: the agent idled cleanly');
  runner.shutdown();
});

test('L: stderr/limit/raw do not refresh lastEvent or clear quiet', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 40 });
  const a = mk(runner, { prompt: 'a' });
  runner.live.get(a).lastEvent = Date.now() - 1000;
  runner._sweepQuiet();
  assert.equal(runner.live.get(a).quiet, true, 'a flagged quiet');

  const before = runner.live.get(a).lastEvent;
  adapter.started[0].emit('stderr', { line: 'noise' });
  adapter.started[0].emit('limit', { provider: 'claude', source: 'provider' });
  adapter.started[0].emit('raw', { line: 'garbage' });
  assert.equal(runner.live.get(a).quiet, true, 'stderr/limit/raw do not clear quiet');
  assert.equal(runner.live.get(a).lastEvent, before, 'stderr/limit/raw do not refresh lastEvent');

  adapter.started[0].emit('output', { text: 'real progress' }); // a turn-progress event
  assert.equal(runner.live.get(a).quiet, false, 'output clears quiet');
  runner.shutdown();
});

test('L: a fresh turn marks itself active (lastEvent/quiet) without waiting for the adapter', () => {
  const adapter = silentAdapter(); // send() emits nothing (like ACP before its async ready.then)
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, quietMs: 40 });
  const a = mk(runner, { prompt: 'a' });
  const e = runner.live.get(a);
  assert.equal(e.inflight, 1, '_deliver took the slot on the fresh turn');
  assert.equal(e.quiet, false, '_deliver cleared quiet on the fresh turn');

  runner._sweepQuiet(); // immediately after: lastEvent is fresh, so not flagged
  assert.equal(e.quiet, false, 'fresh turn is not quiet even though the adapter emitted nothing');

  e.lastEvent = Date.now() - 1000;
  runner._sweepQuiet();
  assert.equal(e.quiet, true, 'once genuinely stale, it is flagged');
  runner.shutdown();
});
