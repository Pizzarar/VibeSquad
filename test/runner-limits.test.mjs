import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeRateLimit, parseAgyUsage, LimitStore, createAgyUsagePoller } from '../runner/limits.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { Runner } from '../runner/runner.mjs';

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
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(events.filter(([t]) => t === 'limit'), [['limit', { provider: 'claude', window: 'weekly', usedPct: 16, resetsAt: '2026-11-12T07:00:00.000Z', source: 'provider' }]]);
});

test('Runner persists claude limit events to limits.jsonl beside the agents dir, with agentId', async () => {
  const home = tmp();
  const adapters = { claude: createClaudeAdapter({ spawnImpl: fakeClaude([fx('claude-rate-limit-event.jsonl').trim()]), mcp: false }) };
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters });
  const id = runner.create({ provider: 'claude', cwd: home });
  await new Promise((r) => setTimeout(r, 30));
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
