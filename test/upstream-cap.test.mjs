import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capProviderOnUpstreamExit, UPSTREAM_CAP_TTL_MS } from '../server/backend/runner-backend.mjs';
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
