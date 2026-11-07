// Per-listener seed retry: a listener whose first listAgents() fails keeps retrying (backoff) until it gets roster + connected,
// and stops when the listener leaves or the stream generation changes. Mocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';

const until = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stream never opens, so only seedListener runs (seedRoster is not involved).
function make(failures) {
  const rc = { home: '/tmp/x', request: async () => { throw new Error('unused'); }, stream: () => ({ close() {} }) };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  b.live.retry.base = 10;
  b.calls = 0;
  b.listAgents = async () => {
    b.calls++;
    if (failures > 0) { failures--; throw new Error('runner request timed out'); }
    return [{ id: 'rn-a', status: 'idle' }];
  };
  return b;
}

test('first listAgents fails: that listener later gets roster + connected', async () => {
  const b = make(2);
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('connected'));
  assert.deepEqual(kinds.slice(-2), ['roster', 'connected']);
  assert.ok(kinds.includes('disconnected'));
  const n = b.calls;
  await sleep(100);
  assert.equal(b.calls, n, 'no more retries once seeded');
  off();
});

test('retry stops when the listener unsubscribes', async () => {
  const b = make(1000);
  const evs = [];
  const other = b.subscribeEvents(() => {});
  const off = b.subscribeEvents((ev) => evs.push(ev.kind));
  await until(() => b.calls >= 3);
  off();
  await sleep(30);
  const seen = evs.length;
  await sleep(150);
  assert.equal(evs.length, seen, 'the left listener gets no more events');
  other();
  await sleep(30);
  const m = b.calls;
  await sleep(150);
  assert.equal(b.calls, m, 'no timers left after the last listener leaves');
});

test('retry stops when the backend gen changes', async () => {
  const b = make(1000);
  const evs = [];
  const off = b.subscribeEvents((ev) => evs.push(ev.kind));
  await until(() => b.calls >= 2);
  b.live.gen++;
  await sleep(30);
  const n = b.calls;
  const seen = evs.length;
  await sleep(150);
  assert.equal(b.calls, n);
  assert.equal(evs.length, seen);
  off();
});
