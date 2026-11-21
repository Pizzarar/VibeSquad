import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capProviderOnUpstreamExit, UPSTREAM_CAP_TTL_MS, toTimeline } from '../server/backend/runner-backend.mjs';
import { lastAssistantText } from '../server/mcp/tools.mjs';
import { UPSTREAM_FAILURE_RE } from '../runner/adapters/acp.mjs';
import { readCappedProviders, setProviderCapped, isProviderOverQuota } from '../server/provider-failover.mjs';

test('upstream exit caps the provider briefly (idea-442)', () => {
  const calls = []; const logs = [];
  const r = capProviderOnUpstreamExit('opencode', { type: 'exit', code: 1, error: 'opencode exited (code 1) after: Internal error: Internal service failure', upstream: true }, { cap: (...a) => calls.push(a), log: (m) => logs.push(m) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'opencode');
  assert.equal(calls[0][2].ttlMs, UPSTREAM_CAP_TTL_MS);
  assert.match(logs[0], /opencode capped for 10 min: upstream failure/);
  assert.equal(r.provider, 'opencode');
});

test('non-upstream exits and other events cap nothing', () => {
  const cap = () => assert.fail('must not cap');
  assert.equal(capProviderOnUpstreamExit('opencode', { type: 'exit', code: 1, upstream: false }, { cap }), null);
  assert.equal(capProviderOnUpstreamExit('opencode', { type: 'error', upstream: true }, { cap }), null);
  assert.equal(capProviderOnUpstreamExit('', { type: 'exit', upstream: true }, { cap }), null);
});

test('setProviderCapped ttlMs writes resetsAt so the cap expires on its own', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'vs-cap-')), 'capped.json');
  const now = Date.now();
  setProviderCapped('opencode', true, { cappedProvidersPath: file, reason: 'x', ttlMs: 600000, now });
  assert.equal(readCappedProviders({ cappedProvidersPath: file, useDiskCaps: true, now }).opencode?.resetsAt, now + 600000);
  assert.equal(isProviderOverQuota('opencode', [], 95, { cappedProvidersPath: file, useDiskCaps: true }).overQuota, true);
  setProviderCapped('claude', true, { cappedProvidersPath: file, now: now + 700000 }); // prunes the expired opencode cap
  assert.equal(readCappedProviders({ cappedProvidersPath: file, useDiskCaps: true, now: now + 700000 }).opencode, undefined);
});

test('a replayed (catch-up) exit older than the TTL caps nothing; a recent one gets only the remaining TTL', () => {
  const now = Date.now(); const calls = [];
  const cap = (...a) => calls.push(a);
  const old = { type: 'exit', upstream: true, error: 'x', ts: now - UPSTREAM_CAP_TTL_MS - 1 };
  assert.equal(capProviderOnUpstreamExit('opencode', old, { cap, log() {}, now }), null);
  capProviderOnUpstreamExit('opencode', { ...old, ts: now - 4 * 60000 }, { cap, log() {}, now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].ttlMs, UPSTREAM_CAP_TTL_MS - 4 * 60000);
});

test('status regex: HTTP codes next to punctuation match, other numbers do not', () => {
  for (const m of ['HTTP 503', 'status: 502', '(429)', 'Internal error: Internal service failure']) assert.match(m, UPSTREAM_FAILURE_RE, m);
  for (const m of ['bad tool schema', 'line 15003 of file', 'code 5000']) assert.doesNotMatch(m, UPSTREAM_FAILURE_RE, m);
});

test('exit.error reaches lastMessage (vs status / digest) instead of an empty string', () => {
  const ev = [
    { seq: 1, ts: 1, type: 'input', text: 'go' },
    { seq: 2, ts: 2, type: 'error', message: 'Internal error: Internal service failure' },
    { seq: 3, ts: 3, type: 'exit', code: 1, error: 'opencode exited (code 1) after: Internal error: Internal service failure', upstream: true },
  ];
  const tl = toTimeline(ev);
  assert.match(lastAssistantText(tl), /^\[agent error\] opencode exited \(code 1\)/);
  assert.equal(lastAssistantText(toTimeline([{ seq: 1, ts: 1, type: 'exit', code: 0 }])), '');
  // a real reply always wins over an error, and a newer turn hides an older turn's error
  assert.equal(lastAssistantText(toTimeline([...ev, { seq: 4, ts: 4, type: 'input', text: 'again' }, { seq: 5, ts: 5, type: 'output', text: 'done' }])), 'done');
  assert.equal(lastAssistantText(toTimeline([...ev.slice(0, 3), { seq: 4, ts: 4, type: 'input', text: 'again' }])), '');
});

test('spawn failover reads caps through dropExpiredCaps (expired entries gone, fresh and flag-style kept)', async () => {
  const { dropExpiredCaps } = await import('../server/provider-failover.mjs');
  const { readFileSync } = await import('node:fs');
  const now = Date.now();
  const kept = dropExpiredCaps({ opencode: { reason: 'x', resetsAt: now - 1000 }, codex: { reason: 'y', resetsAt: now + 1000 }, claude: { capped: true } }, now);
  assert.deepEqual(Object.keys(kept).sort(), ['claude', 'codex']);
  // agent-duties' readCappedProviderMap (spawn failover) must use it for both its sources
  const src = readFileSync(new URL('../server/hooks/agent-duties.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("dropExpiredCaps(m)"));
  assert.ok(src.includes("live(normalizeCappedProviders(JSON.parse"));
  assert.ok(src.includes("live(normalizeCappedProviders(deps.cappedProviders))"));
});

test('lastAssistantText: a verdict followed by a later user_message is still the last message (R2 High)', () => {
  const tl = toTimeline([
    { seq: 1, ts: 1, type: 'input', text: 'review' },
    { seq: 2, ts: 2, type: 'output', text: 'PASS 0/0/0 abc1234' },
    { seq: 3, ts: 3, type: 'turn_done' },
    { seq: 4, ts: 4, type: 'input', text: 'follow-up question' },
  ]);
  assert.equal(lastAssistantText(tl), 'PASS 0/0/0 abc1234');
});

test('lastAssistantText: error fallback stops at the turn boundary, is clipped by cap, and a newer turn failure is returned', () => {
  const old = [
    { seq: 1, ts: 1, type: 'input', text: 'a' }, { seq: 2, ts: 2, type: 'error', message: 'old failure' },
    { seq: 3, ts: 3, type: 'input', text: 'b' }, { seq: 4, ts: 4, type: 'output', text: 'fine' }, { seq: 5, ts: 5, type: 'turn_done' },
    { seq: 6, ts: 6, type: 'input', text: 'c' },
  ];
  assert.equal(lastAssistantText(toTimeline(old)), 'fine'); // the old error is not this turn's
  assert.equal(lastAssistantText(toTimeline(old.slice(0, 2).concat({ seq: 3, ts: 3, type: 'input', text: 'b' }))), ''); // no reply, older error hidden
  const long = toTimeline([{ seq: 1, ts: 1, type: 'input', text: 'a' }, { seq: 2, ts: 2, type: 'error', message: 'x'.repeat(5000) }]);
  assert.ok(lastAssistantText(long, 600).length <= 600);
  // failed newer turn after an older reply: the failure, not the stale reply
  const newer = toTimeline([...old.slice(2, 5), { seq: 6, ts: 6, type: 'input', text: 'c' }, { seq: 7, ts: 7, type: 'exit', code: 1, error: 'boom' }]);
  assert.equal(lastAssistantText(newer), '[agent error] boom');
});

test('read-only expiry: an expired cap is gone on read, no second write; other providers stay uncapped', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'vs-cap-ro-')), 'capped.json');
  const now = Date.now();
  setProviderCapped('opencode', true, { cappedProvidersPath: file, reason: 'x', ttlMs: 600000, now });
  const fresh = readCappedProviders({ cappedProvidersPath: file, useDiskCaps: true, now: now + 1000 });
  assert.ok(fresh.opencode);
  assert.equal(fresh.codex, undefined);
  const { dropExpiredCaps } = await import('../server/provider-failover.mjs');
  assert.equal(dropExpiredCaps(fresh, now + 700000).opencode, undefined);
});

test('failover: a capped opencode routes Work Order - DSP to Implement - Sonnet; a quota entry for the same family cannot shadow the cap when capped entries come first', async () => {
  const { resolveProfileWithFailover } = await import('../server/provider-failover.mjs');
  const profiles = [
    { name: 'Work Order - DSP', role: 'worker', provider: 'opencode', model: 'deepseek/deepseek-v4-pro' },
    { name: 'Implement - Sonnet', role: 'worker', provider: 'claude', model: 'claude-sonnet-5-5' },
    { name: 'Lead - Gemini', role: 'lead', provider: 'antigravity-cli', model: 'gemini-x' },
  ];
  const capped = { id: 'opencode', status: 'exhausted', usedPct: 100 };
  const quotaOk = { id: 'opencode', status: 'ok', usedPct: 3 };
  const r = resolveProfileWithFailover('Work Order - DSP', profiles, [capped, quotaOk]); // currentUsageList order: caps first
  assert.equal(r.failedOver, true);
  assert.equal(r.profile.name, 'Implement - Sonnet');
  assert.equal(resolveProfileWithFailover('Work Order - DSP', profiles, [quotaOk]).failedOver, false); // uncapped: stays
  assert.equal(resolveProfileWithFailover('Implement - Sonnet', profiles, [capped]).failedOver, false); // other providers unaffected
});
