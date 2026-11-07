// Per-listener seed retry: a listener whose first listAgents() fails keeps retrying (backoff) until it gets roster + connected,
// and stops when the listener leaves or the stream generation changes. Mocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { realVibesquadHome } from '../server/test-guard.mjs';

const until = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stream never opens, so only seedListener runs (seedRoster is not involved).
// rc.home is <vibesquad home>/runner, so seed metrics land in <tmp>/teams/_unassigned, never the real ~/.vibesquad.
function make(failures) {
  const vs = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-seed-'));
  const rc = { vs, home: path.join(vs, 'runner'), request: async () => { throw new Error('unused'); }, stream: () => ({ close() {} }) };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  b.vs = vs;
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

test('seedRoster succeeds while a listener retry is pending: one roster + connected, no later disconnected, timer cleared', async () => {
  let fail = true;
  const vs = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-seed-'));
  const rc = { home: path.join(vs, 'runner'), request: async () => { throw new Error('unused'); }, stream: (h) => { rc.h = h; return { close() {} }; } };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  b.live.retry.base = 20;
  b.calls = 0;
  b.listAgents = async () => {
    b.calls++;
    if (fail) throw new Error('runner request timed out');
    return [{ id: 'rn-a', status: 'idle' }];
  };
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('disconnected') && b.live.seedTimers.size === 1);
  fail = false;
  rc.h.onOpen(); // stream seed lands for every listener
  await until(() => kinds.includes('connected'));
  assert.equal(b.live.seedTimers.size, 0, 'seedRoster cancels the pending per-listener retry');
  await sleep(150);
  assert.equal(kinds.filter((k) => k === 'roster').length, 1);
  assert.equal(kinds.filter((k) => k === 'connected').length, 1);
  assert.notEqual(kinds.lastIndexOf('disconnected'), kinds.length - 1);
  assert.ok(kinds.lastIndexOf('disconnected') < kinds.indexOf('connected'), 'no disconnected after connected');
  off();
});

test('retry attempts and the final success are logged once each with elapsed ms + attempt (server log + team-log metric sink)', async () => {
  const b = make(2);
  const lines = [];
  b.seedLog = (msg) => lines.push(msg);
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('connected'));
  await sleep(100);
  const retries = lines.filter((l) => /seed retry/.test(l));
  const ok = lines.filter((l) => /seed recovered/.test(l));
  assert.equal(retries.length, 2, `one line per retry attempt: ${JSON.stringify(lines)}`);
  assert.match(retries[0], /attempt=1 elapsed=\d+ms/);
  assert.match(retries[1], /attempt=2 elapsed=\d+ms/);
  assert.equal(ok.length, 1, 'one success line');
  assert.match(ok[0], /attempts=3 elapsed=\d+ms/);
  assert.equal(lines.length, 3, 'nothing else (no per-heartbeat lines)');
  off();
});

test('no log line when the first seed succeeds', async () => {
  const b = make(0);
  const lines = [];
  b.seedLog = (msg) => lines.push(msg);
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('connected'));
  assert.deepEqual(lines, []);
  off();
});

test('default sink writes the metric under the backend home, and leaves the real ~/.vibesquad log untouched', async () => {
  const realLog = path.join(realVibesquadHome(), 'teams', '_unassigned', 'log.jsonl');
  const size = () => (fs.existsSync(realLog) ? fs.statSync(realLog).size : -1);
  const before = size();
  const b = make(2);
  const kinds = [];
  const off = b.subscribeEvents((ev) => kinds.push(ev.kind));
  await until(() => kinds.includes('connected'));
  await sleep(50);
  const mine = path.join(b.vs, 'teams', '_unassigned', 'log.jsonl');
  const entries = fs.readFileSync(mine, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.every((e) => e.type === 'metric'));
  assert.equal(entries.filter((e) => /seed retry/.test(e.text)).length, 2);
  assert.equal(entries.filter((e) => /seed recovered/.test(e.text)).length, 1);
  assert.equal(size(), before, 'real log not written by a test run');
  off();
});
