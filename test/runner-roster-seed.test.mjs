// Roster seed after a runner restart: one cheap summary call (GET /agents?full=1), and a failed/slow seed on an open stream
// is retried until it lands instead of leaving the "Runner disconnected" pill up for good. Temp homes / mocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-rs-'));
const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const rec = (id) => ({ id, provider: 'claude', model: 'm', cwd: '/x', meta: {}, status: 'idle', usage: null, pendingPermissions: [], lastSeq: 1, createdAt: 1, updatedAt: 2, archivedAt: null, exit: null });

// A fake runner client: request() fails `failures` times, then serves the full roster; stream() hands back onOpen.
function fakeClient({ failures, legacy = false }) {
  const calls = [];
  const c = {
    home: tmp(),
    calls,
    opens: 0,
    closed: false,
    async request(method, route) {
      calls.push(route);
      if (failures > 0) { failures--; throw new Error('runner request timed out'); }
      if (route.startsWith('/agents?')) return legacy ? { ids: ['rn-a'] } : { ids: ['rn-a'], agents: [rec('rn-a')] };
      if (route === '/agents/rn-a') return rec('rn-a');
      throw new Error(`unexpected ${route}`);
    },
    stream(h) {
      c.opens++;
      c.handlers = h;
      queueMicrotask(() => h.onOpen?.());
      return { close() { c.closed = true; } };
    },
  };
  return c;
}

test('seed fails on an open stream: it retries with backoff and then emits roster + connected', async () => {
  const rc = fakeClient({ failures: 2 });
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  b.live.retry.base = 10;
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('connected'));
  assert.ok(kinds.filter((k) => k === 'disconnected').length >= 2, 'each failed seed reports disconnected');
  assert.ok(kinds.includes('roster'));
  assert.equal(rc.opens, 1, 'retries re-seed on the same open stream, they do not reopen it');
  const n = rc.calls.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rc.calls.length, n, 'no retries once seeded');
  off();
});

test('closing the stream cancels the pending seed retry', async () => {
  const rc = fakeClient({ failures: 1000 });
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  b.live.retry.base = 20;
  const off = b.subscribeEvents(() => {});
  await until(() => rc.calls.length >= 2);
  off();
  await new Promise((r) => setTimeout(r, 30)); // let an in-flight attempt finish
  const n = rc.calls.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rc.calls.length, n, 'no hot loop after the stream is gone');
});

test('an old runner (no ?full=1 support) falls back to one GET per id', async () => {
  const rc = fakeClient({ failures: 0, legacy: true });
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  const agents = await b.listAgents();
  assert.deepEqual(agents.map((a) => a.id), ['rn-a']);
  assert.ok(rc.calls.includes('/agents/rn-a'));
});

test('runner GET /agents?full=1 returns every agent status in one request, with no per-id calls', async () => {
  const dir = path.join(tmp(), 'agents');
  mkdirSync(dir, { recursive: true });
  const N = 450;
  for (let i = 0; i < N; i++) {
    const lines = [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: '/x', meta: { lane: `l${i % 5}`, title: `a${i}` } }];
    for (let s = 1; s <= 200; s++) lines.push({ seq: s, ts: 1 + s, type: s % 2 ? 'output' : 'status', text: 'x'.repeat(80), status: 'idle' });
    writeFileSync(path.join(dir, `rn-${i}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const runner = new Runner({ dir, adapters: {} });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const rc = new RunnerClient({ home });
  try {
    const t0 = performance.now();
    const res = await rc.request('GET', '/agents?full=1');
    const cold = performance.now() - t0;
    assert.equal(res.agents.length, N);
    assert.equal(res.ids.length, N);
    const a = res.agents.find((x) => x.id === 'rn-7');
    assert.equal(a.status, 'lost'); // idle in the log, no child in this process
    assert.equal(a.meta.title, 'a7');
    assert.equal(a.lastSeq, 200);
    const t1 = performance.now();
    await rc.request('GET', '/agents?full=1');
    const warm = performance.now() - t1;
    console.log(`full roster, ${N} agents / 200 events each: cold ${cold.toFixed(0)}ms, cached ${warm.toFixed(0)}ms`);
    // a new event invalidates only that agent's cached status
    runner.updateMeta('rn-7', { title: 'renamed' });
    const again = (await rc.request('GET', '/agents?full=1')).agents.find((x) => x.id === 'rn-7');
    assert.equal(again.meta.title, 'renamed');
    assert.equal((await rc.request('GET', '/agents')).agents, undefined, 'plain GET /agents stays names-only');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
