// Process per turn (R4): idle agents are parked right after their turn, the cap counts RUNNING TURNS per provider
// family, and over the cap a send/create is queued (FIFO, with `ahead`), never refused.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, providerFamily, turnCapsFromEnv, parkGraceFromEnv, DEFAULT_TURN_CAPS } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-perturn-')); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// Fake claude children. A turn only ends when the test calls finish(child), so "running" is observable.
function fakeSpawn() {
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
    child.finish = () => child.push({ type: 'result', subtype: 'success' });
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm' }));
    calls.push({ file, args, child, sid });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const setup = (opts = {}) => {
  const spawnImpl = fakeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, maxLive: 16, parkGraceMs: 0, turnCaps: { claude: 6 }, ...opts });
  return { runner, spawnImpl };
};
const mk = (runner, extra = {}) => runner.create({ provider: 'claude', cwd: os.tmpdir(), ...extra });
const running = (runner) => [...runner.live.values()].filter((e) => e.inflight > 0).length;
const lastStatus = (runner, id) => runner.timeline(id).filter((e) => e.type === 'status').at(-1);
const finishAll = (spawnImpl) => { for (const c of spawnImpl.calls) if (!c.child.killed) c.child.finish(); };

test('env knobs: per-family turn caps and park grace', () => {
  assert.deepEqual(turnCapsFromEnv({}), DEFAULT_TURN_CAPS);
  assert.equal(turnCapsFromEnv({ VS_RUNNER_TURN_CAP_CLAUDE: '2', VS_RUNNER_TURN_CAP_OTHER: 'x' }).claude, 2);
  assert.equal(turnCapsFromEnv({ VS_RUNNER_TURN_CAP_OTHER: 'x' }).other, DEFAULT_TURN_CAPS.other);
  assert.equal(parkGraceFromEnv({ VS_RUNNER_PARK_GRACE_MS: '0' }), 0);
  assert.equal(providerFamily('claude'), 'claude');
  assert.equal(providerFamily('agy'), 'antigravity');
  assert.equal(providerFamily('antigravity-cli'), 'antigravity');
  assert.equal(providerFamily('gemini-cli'), 'gemini');
  assert.equal(providerFamily('codex'), 'other');
});

test('40 idle agents -> 0 live processes (parked right after turn_done)', async () => {
  const { runner, spawnImpl } = setup({ maxLive: 100, turnCaps: { claude: 100 } });
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(mk(runner, { prompt: `hi ${i}` }));
  await tick();
  assert.equal(runner.live.size, 40);
  finishAll(spawnImpl);
  await tick(80);
  assert.equal(runner.live.size, 0, 'every idle agent was parked');
  assert.equal(spawnImpl.calls.filter((c) => c.child.killed).length, 40);
  assert.ok(ids.every((id) => runner.status(id).status === 'parked'));
  runner.shutdown();
});

test('8 claude sends with cap 6: 6 run, 2 queue (ahead 0 and 1), then drain FIFO', async () => {
  const { runner, spawnImpl } = setup();
  const ids = Array.from({ length: 8 }, () => mk(runner));
  await tick();
  // quiet agents have not had a turn yet, so they stay live; send to all 8
  const pos = ids.map((id) => runner.send(id, 'go'));
  assert.deepEqual(pos.slice(0, 6).map((p) => p.queued), Array(6).fill(false));
  assert.deepEqual(pos[6], { queued: true, ahead: 0 });
  assert.deepEqual(pos[7], { queued: true, ahead: 1 });
  assert.equal(running(runner), 6);
  assert.deepEqual(lastStatus(runner, ids[6]), { ...lastStatus(runner, ids[6]), status: 'queued', ahead: 0 });
  assert.equal(lastStatus(runner, ids[7]).ahead, 1);
  assert.equal(runner.status(ids[7]).status, 'queued', 'a queued agent is not reported lost');
  // one turn ends: the head of the queue starts, the other moves up to ahead 0
  spawnImpl.calls[0].child.finish();
  await tick();
  assert.equal(running(runner), 6);
  assert.equal(runner.queuePosition(ids[6]).queued, false);
  assert.deepEqual(runner.queuePosition(ids[7]), { queued: true, ahead: 0 });
  assert.equal(lastStatus(runner, ids[7]).ahead, 0);
  spawnImpl.calls[1].child.finish();
  await tick();
  assert.equal(runner.queue.length, 0);
  assert.equal(running(runner), 6);
  assert.ok(runner.timeline(ids[7]).some((e) => e.type === 'input' && e.text === 'go'));
  finishAll(spawnImpl);
  runner.shutdown();
});

test('a family cap does not block another family', async () => {
  const spawnImpl = fakeSpawn();
  const claudeAdapter = createClaudeAdapter({ spawnImpl, mcp: false });
  const sent = [];
  const other = { canPark: true, start({ emit }) { emit('status', { status: 'idle' }); return { send(t) { sent.push(t); emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: claudeAdapter, codex: other }, turnCaps: { claude: 1, other: 1 }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  const c = runner.create({ provider: 'codex', cwd: os.tmpdir(), prompt: 'c' });
  assert.equal(runner.queuePosition(b).queued, true);
  assert.equal(runner.queuePosition(c).queued, false, 'codex runs while claude is capped');
  assert.deepEqual(sent, ['c']);
  assert.ok(a);
  runner.shutdown();
});

test('no AGENT_CAP: send/create over every limit queue instead of throwing, even past the live ceiling', async () => {
  const { runner, spawnImpl } = setup({ maxLive: 2, turnCaps: { claude: 2 } });
  const a = mk(runner, { prompt: 'x' });
  const b = mk(runner, { prompt: 'x' });
  let c;
  assert.doesNotThrow(() => { c = mk(runner, { prompt: 'x' }); });
  assert.doesNotThrow(() => runner.send(a, 'more')); // steers the running turn: no slot needed
  assert.equal(runner.queuePosition(c).queued, true);
  assert.equal(runner.live.size, 2);
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner', 'runner.mjs'), 'utf8');
  assert.ok(!/AGENT_CAP|AgentCapError/.test(src), 'the cap error is gone from the runner');
  finishAll(spawnImpl); await tick();
  assert.equal(runner.queue.length, 0);
  assert.ok(b);
  runner.shutdown();
});

test('a queued send to a parked agent resumes it (--resume) when its slot frees', async () => {
  const { runner, spawnImpl } = setup({ turnCaps: { claude: 1 } });
  const a = mk(runner, { prompt: 'one' });
  await tick();
  spawnImpl.calls[0].child.finish();
  await tick(60);
  assert.equal(runner.status(a).status, 'parked');
  const b = mk(runner, { prompt: 'busy' }); // takes the only claude turn slot
  await tick();
  assert.deepEqual(runner.send(a, 'again'), { queued: true, ahead: 0 });
  assert.equal(runner.status(a).status, 'queued');
  assert.equal(spawnImpl.calls.length, 2, 'nothing resumed while queued');
  spawnImpl.calls[1].child.finish();
  await tick(60);
  const resumed = spawnImpl.calls.at(-1);
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], 'sess-1');
  assert.equal(runner.queuePosition(a).queued, false);
  assert.equal(runner.live.has(a), true);
  assert.ok(b);
  finishAll(spawnImpl);
  runner.shutdown();
});

test('an agent with a pending permission is not parked; a quick follow-up inside the grace keeps its process', async () => {
  const events = [];
  let em;
  const adapter = { canPark: true, start({ emit }) { em = emit; return { send() { emit('status', { status: 'running' }); }, cancel() {}, kill() { events.push('kill'); } }; } };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 40 });
  const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'x' });
  em('session', { sessionId: 's' });
  em('permission', { phase: 'request', id: 'p1', toolName: 'Bash' });
  em('turn_done', {}); em('status', { status: 'idle' });
  await tick(100);
  assert.deepEqual(events, [], 'pending permission blocks the park');
  em('permission', { phase: 'resolved', id: 'p1' });
  em('turn_done', {}); em('status', { status: 'idle' });
  await tick(15);
  runner.send(id, 'quick follow-up'); // inside the grace: process kept
  await tick(80);
  assert.deepEqual(events, [], 'follow-up cancelled the park timer');
  em('turn_done', {}); em('status', { status: 'idle' });
  await tick(100);
  assert.deepEqual(events, ['kill'], 'parked once idle past the grace');
  runner.shutdown();
});

test('runner HTTP: create/input answer at once with queued + ahead', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner', 'server.mjs'), 'utf8');
  assert.match(src, /queuePosition\(nid\)/);
  assert.match(src, /\.\.\.pos/);
  assert.ok(!/sendQueued|createQueued/.test(src));
});

test('review: a failed queued create leaves an exited agent with the error; a failed resume re-parks so the next send works', async () => {
  const spawnImpl = fakeSpawn();
  let failNext = false;
  const inner = createClaudeAdapter({ spawnImpl, mcp: false });
  const adapter = { canPark: true, start: (o) => { if (failNext) { failNext = false; throw new Error('spawn boom'); } return inner.start(o); } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 0 });
  const a = mk(runner, { prompt: 'one' });
  await tick();
  const b = mk(runner, { prompt: 'queued create' });
  assert.equal(runner.queuePosition(b).queued, true);
  failNext = true;
  spawnImpl.calls[0].child.finish();
  await tick(60);
  assert.equal(runner.status(b).status, 'exited', 'not lost: a clear exited state');
  assert.ok(runner.timeline(b).some((e) => e.type === 'error' && /spawn boom/.test(e.message)));
  assert.equal(runner.queue.length, 0);
  // a parked agent whose resume fails stays resumable
  assert.equal(runner.status(a).status, 'parked');
  failNext = true;
  runner.send(a, 'again');
  assert.equal(runner.status(a).status, 'parked', 'failed resume re-parked it');
  runner.send(a, 'retry'); await tick();
  assert.ok(spawnImpl.calls.at(-1).args.includes('--resume'));
  finishAll(spawnImpl);
  runner.shutdown();
});

test('review: archiving a queued agent re-announces the ones behind it', async () => {
  const { runner, spawnImpl } = setup({ turnCaps: { claude: 1 } });
  mk(runner, { prompt: 'run' });
  const q1 = mk(runner, { prompt: 'q1' });
  const q2 = mk(runner, { prompt: 'q2' });
  assert.equal(runner.queuePosition(q2).ahead, 1);
  runner.archive(q1);
  assert.equal(runner.queuePosition(q2).ahead, 0);
  assert.equal(lastStatus(runner, q2).ahead, 0);
  finishAll(spawnImpl);
  runner.shutdown();
});

test('review: queued ahead is in the status record (roster seed) and survives toAgent', async () => {
  const { toAgent } = await import('../server/backend/runner-backend.mjs');
  const { runner, spawnImpl } = setup({ turnCaps: { claude: 1 } });
  mk(runner, { prompt: 'run' });
  const q = mk(runner, { prompt: 'q' });
  const rec = runner.statusAll().find((s) => s.id === q);
  assert.deepEqual(rec.queued, { ahead: 0 });
  assert.deepEqual(toAgent(rec).queued, { ahead: 0 });
  assert.equal(toAgent(rec).status, 'initializing');
  finishAll(spawnImpl); await tick();
  assert.equal(runner.status(q).queued, undefined);
  runner.shutdown();
});

test('review: a crash mid-turn and a start failure both free the turn slot', async () => {
  const spawnImpl = fakeSpawn();
  let failNext = false;
  const inner = createClaudeAdapter({ spawnImpl, mcp: false });
  const adapter = { canPark: true, start: (o) => { if (failNext) { failNext = false; throw new Error('boom'); } return inner.start(o); } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 0 });
  const a = mk(runner, { prompt: 'x' });
  await tick();
  assert.equal(running(runner), 1);
  spawnImpl.calls[0].child.kill(); // crash mid-turn
  await tick();
  assert.equal(running(runner), 0, 'crash freed the slot');
  failNext = true;
  mk(runner, { prompt: 'fails to start' });
  assert.equal(running(runner), 0, 'start failure holds no slot');
  const c = mk(runner, { prompt: 'fine' });
  assert.equal(runner.queuePosition(c).queued, false, 'slot is free for the next one');
  assert.ok(a);
  finishAll(spawnImpl);
  runner.shutdown();
});

test('review: archive parks an idle agent (session kept); unarchive + send resumes the same session', async () => {
  const { runner, spawnImpl } = setup({ parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'hi' });
  await tick();
  spawnImpl.calls[0].child.finish();
  await tick();
  assert.equal(runner.live.has(a), true);
  runner.archive(a);
  assert.equal(runner.live.has(a), false, 'no live process');
  assert.ok(!runner.timeline(a).some((e) => e.type === 'exit'), 'archive is not an exit');
  assert.ok(runner.timeline(a).some((e) => e.type === 'parked' && e.sessionId === 'sess-1'));
  runner.unarchive(a);
  runner.send(a, 'back'); await tick();
  const r = spawnImpl.calls.at(-1);
  assert.equal(r.args[r.args.indexOf('--resume') + 1], 'sess-1');
  finishAll(spawnImpl);
  runner.shutdown();
});

test('review: archiving a running agent cancels it and parks it when the turn ends, keeping the session', async () => {
  const { runner, spawnImpl } = setup({ parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'long' });
  await tick();
  runner.archive(a);
  assert.equal(runner.live.has(a), true, 'still finishing its turn');
  spawnImpl.calls[0].child.finish();
  await tick();
  assert.equal(runner.live.has(a), false);
  assert.ok(runner.timeline(a).some((e) => e.type === 'parked' && e.sessionId === 'sess-1'));
  assert.ok(!runner.timeline(a).some((e) => e.type === 'exit'));
  runner.unarchive(a);
  assert.ok(runner._parkedSpec(a), 'revivable');
  runner.shutdown();
});
