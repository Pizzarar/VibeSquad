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
