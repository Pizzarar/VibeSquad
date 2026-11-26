// R10 fu4 (@per): the agy usage poll speeds up while a pool is hot, so the 85% agy-claude failover sees a fast climb
// (incident 11-26 00:07Z: claude-gpt 5h went 73% -> 100% inside one 30 min poll gap).
import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LimitStore, createAgyUsagePoller, agyNextPollMs, agyPollConfigFromEnv, AGY_POLL_SLOW_MS, AGY_POLL_FAST_MS, AGY_POLL_PROJECT_PCT } from '../runner/limits.mjs';
import { AGY_CLAUDE_FAILOVER_THRESHOLD } from '../server/provider-failover.mjs';

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-r10fu4-')); tmpDirs.push(d); return d; };

const MIN = 60_000;
const RESET_5H = '2026-11-26T03:52:47Z';
// One `agy -p /usage` table; pct = used %, converted to the CLI's "remaining" column.
const table = ({ claude5h = 10, claudeWeekly = 10, gem5h = 4, gemWeekly = 1, reset5h = RESET_5H } = {}) => [
  `Gemini Models\tWeekly Limit Remaining\t${100 - gemWeekly}%\t2026-11-30T23:42:42Z`,
  `Gemini Models\tFive Hour Limit Remaining\t${100 - gem5h}%\t${reset5h}`,
  `Claude and GPT models\tWeekly Limit Remaining\t${100 - claudeWeekly}%\t2026-11-30T04:36:38Z`,
  `Claude and GPT models\tFive Hour Limit Remaining\t${100 - claude5h}%\t${reset5h}`,
].join('\n');

function harness(opts = {}) {
  let t = 1_000_000_000;
  let next = table();
  let calls = 0;
  const poll = createAgyUsagePoller({ store: new LimitStore(path.join(tmp(), 'limits.jsonl')), run: async () => { calls++; return next; }, now: () => t, ...opts });
  return {
    poll,
    set: (o) => { next = table(o); },
    advance: (ms) => { t += ms; },
    calls: () => calls,
  };
}

test('fu4: projection threshold stays equal to the agy-claude failover threshold', () => {
  assert.equal(AGY_POLL_PROJECT_PCT, AGY_CLAUDE_FAILOVER_THRESHOLD);
  assert.ok(AGY_POLL_FAST_MS < AGY_POLL_SLOW_MS);
});

test('fu4: a claude-gpt 5h row at >=60% drops the floor to the fast interval (incident: 73% at the last poll)', async () => {
  const h = harness();
  h.set({ claude5h: 73 });
  await h.poll('rn-a');
  assert.equal(h.calls(), 1);
  h.advance(AGY_POLL_FAST_MS + 1000);
  h.set({ claude5h: 76 });
  await h.poll('rn-b'); // an agy turn_done 3 min later polls again, not 30 min later
  assert.equal(h.calls(), 2, 'polled again after the fast floor');
  h.advance(AGY_POLL_FAST_MS - 1000);
  await h.poll('rn-c');
  assert.equal(h.calls(), 2, 'still throttled inside the fast floor');
});

test('fu4: a Gemini (antigravity-cli) 5h row at >=60% is hot too', async () => {
  const h = harness();
  h.set({ gem5h: 65 });
  await h.poll('rn-a');
  h.advance(AGY_POLL_FAST_MS + 1000);
  await h.poll('rn-b');
  assert.equal(h.calls(), 2);
});

test('fu4: cool pools keep the 30 min floor (cheap); a weekly row over 60% alone does not poll fast', async () => {
  const h = harness();
  h.set({ claude5h: 40, claudeWeekly: 70 });
  await h.poll('rn-a');
  h.advance(AGY_POLL_FAST_MS + 1000);
  await h.poll('rn-b');
  assert.equal(h.calls(), 1, 'throttled at the slow floor');
  h.advance(AGY_POLL_SLOW_MS);
  await h.poll('rn-c');
  assert.equal(h.calls(), 2);
});

test('fu4: burn projection: 30% -> 58% in 30 min projects >=85% by the next slow poll, so poll fast', async () => {
  const h = harness();
  h.set({ claude5h: 30 });
  await h.poll('rn-a');
  h.advance(AGY_POLL_SLOW_MS);
  h.set({ claude5h: 58 });
  await h.poll('rn-b');
  assert.equal(h.calls(), 2);
  assert.equal(h.poll.floorMs(), AGY_POLL_FAST_MS);
  h.advance(AGY_POLL_FAST_MS + 1000);
  await h.poll('rn-c');
  assert.equal(h.calls(), 3);
});

test('fu4: projection ignores a window rollover (new resetsAt) and a slow climb', () => {
  const at = 10 * AGY_POLL_SLOW_MS;
  const prev = new Map([['antigravity-cli/claude-gpt|5h', { usedPct: 10, resetsAt: '2026-11-25T22:00:00Z', at: at - AGY_POLL_SLOW_MS }]]);
  const row = (usedPct, resetsAt = RESET_5H) => [{ provider: 'antigravity-cli/claude-gpt', window: '5h', usedPct, resetsAt }];
  assert.equal(agyNextPollMs(row(50), prev, { at }), AGY_POLL_SLOW_MS, 'rollover: no slope across windows');
  prev.get('antigravity-cli/claude-gpt|5h').resetsAt = RESET_5H;
  assert.equal(agyNextPollMs(row(30), prev, { at }), AGY_POLL_SLOW_MS, '10 -> 30 projects 50');
  assert.equal(agyNextPollMs(row(50), prev, { at }), AGY_POLL_FAST_MS, '10 -> 50 projects 90');
});

test('fu4: hot -> cool (window reset) goes back to the slow floor', async () => {
  const h = harness();
  h.set({ claude5h: 90 });
  await h.poll('rn-a');
  assert.equal(h.poll.floorMs(), AGY_POLL_FAST_MS);
  h.advance(AGY_POLL_FAST_MS + 1000);
  h.set({ claude5h: 0, reset5h: '2026-11-26T08:52:47Z' });
  await h.poll('rn-b');
  assert.equal(h.poll.floorMs(), AGY_POLL_SLOW_MS);
});

test('fu4: env overrides the floors and level; bad values are ignored', () => {
  assert.deepEqual(agyPollConfigFromEnv({ VS_AGY_POLL_SLOW_MS: '600000', VS_AGY_POLL_FAST_MS: '120000', VS_AGY_POLL_FAST_AT_PCT: '50' }), { minIntervalMs: 600_000, fastIntervalMs: 120_000, fastAtPct: 50 });
  assert.deepEqual(agyPollConfigFromEnv({ VS_AGY_POLL_SLOW_MS: '-1', VS_AGY_POLL_FAST_MS: 'x', VS_AGY_POLL_FAST_AT_PCT: '150' }), {});
  assert.deepEqual(agyPollConfigFromEnv({}), {});
});

test('fu4 r1 L1: a whitespace-only env value is ignored, not read as 0', () => {
  assert.deepEqual(agyPollConfigFromEnv({ VS_AGY_POLL_SLOW_MS: ' ', VS_AGY_POLL_FAST_MS: '\t', VS_AGY_POLL_FAST_AT_PCT: '  ' }), {});
  assert.deepEqual(agyPollConfigFromEnv({ VS_AGY_POLL_FAST_MS: ' 120000 ' }), { fastIntervalMs: 120_000 });
});

test('fu4 r1 L2: empty or unparseable /usage output keeps a hot fast floor', async () => {
  let t = 1_000_000_000, calls = 0, next = table({ claude5h: 80 });
  const poll = createAgyUsagePoller({ store: new LimitStore(path.join(tmp(), 'limits.jsonl')), run: async () => { calls++; return next; }, now: () => t });
  await poll('rn-a');
  assert.equal(poll.floorMs(), AGY_POLL_FAST_MS);
  for (const out of ['', 'agy: signed out\n']) {
    t += AGY_POLL_FAST_MS + 1000; next = out;
    assert.deepEqual(await poll('rn-b'), []);
    assert.equal(poll.floorMs(), AGY_POLL_FAST_MS, `kept fast after ${JSON.stringify(out)}`);
  }
  assert.equal(calls, 3);
});
