import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeRateLimit, parseAgyUsage, LimitStore, createAgyUsagePoller, runAgyUsage } from '../runner/limits.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { Runner } from '../runner/runner.mjs';
import { until } from './helpers/load-budget.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/limits/${n}`, import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-limits-'));
const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('claude rate_limit_event fixture: seven_day -> weekly, fraction -> pct, epoch s -> ISO', () => {
  const m = JSON.parse(fx('claude-rate-limit-event.jsonl'));
  assert.deepEqual(parseClaudeRateLimit(m), [{ window: 'weekly', usedPct: 16, resetsAt: '2026-11-12T07:00:00.000Z' }]);
});

test('claude: five_hour maps to 5h, unrelated windows ignored, junk yields nothing', () => {
  const m = { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1794466800 }, seven_day_opus: { utilization: 0.9, resetsAt: 1 } } } };
  assert.deepEqual(parseClaudeRateLimit(m).map((w) => [w.window, w.usedPct]), [['5h', 50]]);
  assert.deepEqual(parseClaudeRateLimit({}), []);
  assert.deepEqual(parseClaudeRateLimit({ rate_limit_info: {} }), []);
});

test('agy /usage fixture: remaining -> used, Gemini pool vs Claude/GPT pool', () => {
  const r = parseAgyUsage(fx('agy-usage.txt'));
  assert.equal(r.length, 4);
  const g5 = r.find((x) => x.provider === 'antigravity-cli' && x.window === '5h');
  assert.equal(g5.usedPct, 4);
  assert.equal(g5.resetsAt, '2026-11-07T04:42:42.000Z');
  assert.equal(r.find((x) => x.provider === 'antigravity-cli' && x.window === 'weekly').usedPct, 1);
  assert.equal(r.find((x) => x.provider === 'antigravity-cli/claude-gpt' && x.window === 'weekly').usedPct, 19);
  assert.deepEqual(parseAgyUsage('not a table\n`/usage` is the result of Git Bash'), []);
});

test('LimitStore appends the contract line and skips an identical repeat', () => {
  const f = path.join(tmp(), 'limits.jsonl');
  const s = new LimitStore(f);
  const rec = { provider: 'claude', window: 'weekly', usedPct: 16, resetsAt: '2026-11-12T07:00:00.000Z', agentId: 'rn-x' };
  assert.ok(s.record(rec, Date.parse('2026-11-06T00:00:00Z')));
  assert.equal(s.record(rec), null);
  s.record({ ...rec, usedPct: 17 });
  const got = lines(f);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { at: '2026-11-06T00:00:00.000Z', provider: 'claude', window: 'weekly', usedPct: 16, resetsAt: '2026-11-12T07:00:00.000Z', source: 'provider', agentId: 'rn-x' });
});

function fakeClaude(streamLines) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => { for (const l of streamLines) child.stdout.write(l + '\n'); });
    return child;
  };
}

test('claude adapter emits a normalized limit event from the real stream line', async () => {
  const events = [];
  createClaudeAdapter({ spawnImpl: fakeClaude([fx('claude-rate-limit-event.jsonl').trim()]), mcp: false })
    .start({ cwd: '.', emit: (t, d) => events.push([t, d]), onExit() {} });
  await until(() => events.some(([t]) => t === 'limit')); // fixed 30ms raced the setImmediate+stream under load
  assert.deepEqual(events.filter(([t]) => t === 'limit'), [['limit', { provider: 'claude', window: 'weekly', usedPct: 16, resetsAt: '2026-11-12T07:00:00.000Z', source: 'provider' }]]);
});

test('Runner persists claude limit events to limits.jsonl beside the agents dir, with agentId', async () => {
  const home = tmp();
  const adapters = { claude: createClaudeAdapter({ spawnImpl: fakeClaude([fx('claude-rate-limit-event.jsonl').trim()]), mcp: false }) };
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters });
  const id = runner.create({ provider: 'claude', cwd: home });
  await until(() => existsSync(path.join(home, 'limits.jsonl')));
  const [rec] = lines(path.join(home, 'limits.jsonl'));
  assert.equal(rec.agentId, id);
  assert.equal(rec.provider, 'claude');
  assert.equal(rec.window, 'weekly');
  assert.equal(rec.usedPct, 16);
  assert.equal(rec.source, 'provider');
  assert.ok(rec.at);
  runner.shutdown();
});

test('Runner writes no limits file when nothing reports a limit (and never polls agy by default)', () => {
  const home = tmp();
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters: {} });
  assert.equal(runner._pollAgy, null);
  assert.equal(existsSync(path.join(home, 'limits.jsonl')), false);
});

test('agy poller: parses, records, throttles, survives failure', async () => {
  const f = path.join(tmp(), 'limits.jsonl');
  const store = new LimitStore(f);
  let t = 1_000_000, calls = 0, fail = false;
  const poll = createAgyUsagePoller({ store, run: async () => { calls++; if (fail) throw new Error('boom'); return fx('agy-usage.txt'); }, minIntervalMs: 60_000, now: () => t });
  assert.equal((await poll('rn-a')).length, 4);
  assert.equal((await poll('rn-b')).length, 0); // throttled
  assert.equal(calls, 1);
  t += 61_000; fail = true;
  assert.deepEqual(await poll('rn-c'), []); // failure swallowed
  assert.equal(lines(f).length, 4);
  assert.equal(lines(f)[0].agentId, 'rn-a');
});

test('Runner polls agy after an antigravity-cli turn_done (alias included) and records Gemini windows', async () => {
  const home = tmp();
  const adapter = { start({ emit }) { setImmediate(() => emit('turn_done', {})); return { send() {}, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters: { agy: adapter }, pollAgy: true, agyUsage: async () => fx('agy-usage.txt') });
  const id = runner.create({ provider: 'agy', cwd: home });
  await new Promise((r) => setTimeout(r, 50));
  const recs = lines(path.join(home, 'limits.jsonl'));
  assert.equal(recs.filter((r) => r.provider === 'antigravity-cli').length, 2);
  assert.ok(recs.every((r) => r.agentId === id && r.source === 'provider'));
  runner.shutdown();
});

function fakeAgy({ onSpawn } = {}) {
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.killed = 0;
    child.kill = () => { child.killed++; };
    calls.push({ file, args, opts, child });
    onSpawn?.(child);
    return child;
  };
  return { spawnImpl, calls };
}

test('runAgyUsage: spawns `agy -p /usage` without a shell and resolves stdout', async () => {
  const { spawnImpl, calls } = fakeAgy({ onSpawn: (c) => setImmediate(() => { c.stdout.write(fx('agy-usage.txt')); c.emit('exit', 0); }) });
  const out = await runAgyUsage({ spawnImpl });
  assert.deepEqual(calls[0].args, ['-p', '/usage']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(parseAgyUsage(out).length, 4);
});

test('runAgyUsage: timeout kills the child tree and rejects; spawn error rejects', async () => {
  const hung = fakeAgy();
  await assert.rejects(runAgyUsage({ spawnImpl: hung.spawnImpl, timeoutMs: 20 }), /timed out/);
  assert.equal(hung.calls[0].child.killed, 1);
  const bad = fakeAgy({ onSpawn: (c) => setImmediate(() => c.emit('error', new Error('ENOENT'))) });
  await assert.rejects(runAgyUsage({ spawnImpl: bad.spawnImpl }), /ENOENT/);
});

test('runAgyUsage: refuses to spawn the real agy under a test runner without spawnImpl', async () => {
  await assert.rejects(runAgyUsage(), /refusing to spawn the real agy/);
});

test('LimitStore refuses to write inside the real ~/.vibesquad under a test runner', () => {
  const f = path.join(os.homedir(), '.vibesquad', 'runner', 'limits.jsonl');
  const before = existsSync(f) ? readFileSync(f, 'utf8') : null;
  assert.equal(new LimitStore(f).record({ provider: 'claude', window: 'weekly', usedPct: 1, resetsAt: null }), null);
  assert.equal(existsSync(f) ? readFileSync(f, 'utf8') : null, before);
});

test('poller: concurrent poll() runs agy once; shutdown() kills the in-flight child and records nothing', async () => {
  const store = new LimitStore(path.join(tmp(), 'limits.jsonl'));
  const fake = fakeAgy();
  let calls = 0;
  const poll = createAgyUsagePoller({ store, minIntervalMs: 0, run: (o) => { calls++; return runAgyUsage({ ...o, spawnImpl: fake.spawnImpl }); } });
  const [a, b, c] = [poll('rn-a'), poll('rn-b'), poll('rn-c')];
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  poll.shutdown();
  assert.equal(fake.calls[0].child.killed, 1);
  fake.calls[0].child.stdout.write(fx('agy-usage.txt')); fake.calls[0].child.emit('exit', 0);
  assert.deepEqual(await Promise.all([a, b, c]), [[], [], []]);
  assert.equal(existsSync(store.file), false);
});

test('idea-349: agy poller skips (keeps its interval) while canRun says an agy agent is busy', async () => {
  const store = new LimitStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'vs-lim-')), 'limits.jsonl'));
  let calls = 0; let busy = true; let t = 1_000_000;
  const poll = createAgyUsagePoller({ store, run: async () => { calls++; return fx('agy-usage.txt'); }, minIntervalMs: 60_000, now: () => t, canRun: () => !busy });
  assert.deepEqual(await poll('a'), []); assert.equal(calls, 0, 'no agy spawn while busy');
  busy = false; t += 1; assert.ok((await poll('a')).length > 0); assert.equal(calls, 1, 'runs once the agents are idle');
});

test('idea-349: real turn_done -> idle -> park lifecycle with pollAgy:true polls only once no agy agent may hold work', async () => {
  const home = tmp();
  const emitters = {};
  const dirs = { A: path.join(home, 'A'), B: path.join(home, 'B') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  let work = [{ pid: 1 }];
  const adapter = { canPark: true, start({ emit, cwd }) { const h = { pid: 4242, send() {}, cancel() {}, kill() {} }; emitters[path.basename(cwd)] = emit; return h; } };
  let spawns = 0;
  const runner = new Runner({
    dir: path.join(home, 'agents'), adapters: { 'antigravity-cli': adapter }, pollAgy: true, agyUsage: async () => { spawns++; return fx('agy-usage.txt'); },
    bgProbe: async () => work, pidAlive: () => work.length > 0, parkGraceMs: 60_000, parkHoldPollMs: 60_000, parkHoldMaxMs: 60_000,
  });
  const A = runner.create({ provider: 'antigravity-cli', cwd: dirs.A, prompt: 'go' });
  const B = runner.create({ provider: 'antigravity-cli', cwd: dirs.B, prompt: 'go' });
  await new Promise((r) => setTimeout(r, 20));
  for (const c of ['A', 'B']) { emitters[c]('session', { sessionId: 's' + c }); emitters[c]('status', { status: 'running' }); }
  emitters.A('status', { status: 'idle' }); emitters.A('turn_done', {}); // A ends its turn with a live bg shell: probe not back / sees work
  emitters.B('status', { status: 'idle' }); emitters.B('turn_done', {}); // B ends moments later
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spawns, 0, 'no agy -p /usage while A (and B) may still hold background work');
  assert.ok(runner.live.has(A), 'A is still live (held)');
  runner.park(A); await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawns, 0, 'A parked but B may still hold work: the retry is refused too');
  runner.park(B); await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawns, 1, 'once nothing agy is live, the park retry polls exactly once');
  runner.shutdown();
});

test('idea-349: Runner._agyBusy: unknown post-turn work, held work and running turns are busy; clean/claude are not', () => {
  const r = new Runner({ dir: mkdtempSync(path.join(os.tmpdir(), 'vs-run-')), bgProbe: async () => [], parkHoldMaxMs: 1000 });
  const agy = (o) => ({ provider: 'agy', inflight: 0, heldSince: null, turnGen: 1, handle: { pid: 1 }, work: [], ...o });
  r.live.set('c', { provider: 'claude', inflight: 1, heldSince: null });
  assert.equal(r._agyBusy(), false);
  r.live.set('a', agy({ work: null })); assert.equal(r._agyBusy(), true, 'probe not back yet');
  r.live.set('a', agy({ heldSince: 5 })); assert.equal(r._agyBusy(), true);
  r.live.set('a', agy({ inflight: 1 })); assert.equal(r._agyBusy(), true);
  r.live.set('a', agy({})); assert.equal(r._agyBusy(), false, 'probed clean');
});
