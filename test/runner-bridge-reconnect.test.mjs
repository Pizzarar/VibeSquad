import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// S1 (docs/PLAN_STREAM_RECONNECT.md): the browser EventSource goes CLOSED after a non-200 reconnect reply and never
// recovers by itself. runnerBridge must recreate it (backoff), on a silent stream (watchdog), and on visible/online.
// src/runnerBridge.ts is plain TS: node strips the types. EventSource, document, window and timers are faked.

const WATCHDOG_MS = 40000;
let n = 0;

async function setup() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const instances = [];
  class FakeES {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; instances.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    failClosed() { this.readyState = 2; this.onerror?.(); } // e.g. the reconnect got a 503: native EventSource gives up
    msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
  }
  const docL = {};
  const winL = {};
  globalThis.document = { hidden: false, addEventListener: (k, f) => (docL[k] = f) };
  globalThis.window = { addEventListener: (k, f) => (winL[k] = f) };
  globalThis.EventSource = FakeES;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: true, lanes: [] }) });
  const mod = await import(`../src/runnerBridge.ts?s1-${++n}`);
  const conn = [];
  const seen = [];
  mod.runnerHandle('rn-a').timeline.subscribe((ev) => seen.push(ev.event.type));
  mod.startRunnerBridge(() => {}, (c) => conn.push(c));
  await new Promise((r) => setImmediate(r));
  return { instances, docL, winL, conn, seen, mod };
}
const live = (inst) => inst.filter((e) => !e.closed);

test('a CLOSED stream (503 on reconnect) is recreated with backoff and recovers with a catch-up, no reload', async (t) => {
  t.after(() => mock.timers.reset());
  const { instances, conn, seen } = await setup();
  assert.equal(instances.length, 1);
  instances[0].open();
  conn.length = 0; seen.length = 0;
  instances[0].failClosed();
  assert.deepEqual(conn, [false]);
  assert.equal(instances.length, 1, 'waits for the backoff');
  mock.timers.tick(1000);
  assert.equal(instances.length, 2);
  assert.ok(instances[0].closed, 'old instance closed before replacing');
  instances[1].failClosed(); // second attempt also fails -> longer backoff
  mock.timers.tick(1000);
  assert.equal(instances.length, 2, 'backoff grew past 1s');
  mock.timers.tick(1000);
  assert.equal(instances.length, 3);
  conn.length = 0; seen.length = 0;
  instances[2].open();
  assert.deepEqual(conn, [true]);
  assert.deepEqual(seen, ['runner-catchup']);
  assert.equal(live(instances).length, 1, 'no duplicate instances');
  // backoff reset on open: next failure retries after 1s again
  instances[2].failClosed();
  mock.timers.tick(1000);
  assert.equal(instances.length, 4);
});

test('a native auto-reconnecting (CONNECTING) error does not spawn a second instance', async (t) => {
  t.after(() => mock.timers.reset());
  const { instances } = await setup();
  instances[0].open();
  instances[0].readyState = 0;
  instances[0].onerror();
  mock.timers.tick(20000);
  assert.equal(instances.length, 1);
});

test('a silent stream past the watchdog is closed and recreated; heartbeats keep it alive', async (t) => {
  t.after(() => mock.timers.reset());
  const { instances, conn } = await setup();
  instances[0].open();
  mock.timers.tick(WATCHDOG_MS - 5000);
  instances[0].msg({ kind: 'hb' }); // activity resets the watchdog
  mock.timers.tick(WATCHDOG_MS - 5000);
  assert.equal(instances.length, 1, 'hb kept it alive');
  conn.length = 0;
  mock.timers.tick(10000);
  assert.ok(instances[0].closed, 'silent stream closed');
  assert.deepEqual(conn, [false]);
  mock.timers.tick(1000);
  assert.equal(instances.length, 2, 'recreated');
  assert.equal(live(instances).length, 1);
  instances[1].open();
  mock.timers.tick(WATCHDOG_MS + 1);
  mock.timers.tick(1000);
  assert.equal(instances.length, 3, 'exactly one recreate per silent period (no leaked timers)');
  assert.equal(live(instances).length, 1);
});

test('visibilitychange->visible and online recreate a CLOSED stream immediately; an open one is left alone', async (t) => {
  t.after(() => mock.timers.reset());
  const { instances, docL, winL, seen } = await setup();
  instances[0].open();
  seen.length = 0;
  docL.visibilitychange();
  assert.equal(instances.length, 1, 'open stream untouched');
  assert.deepEqual(seen, ['runner-catchup'], 'visible still catches up');
  instances[0].failClosed();
  docL.visibilitychange();
  assert.equal(instances.length, 2, 'visible recreates a CLOSED stream');
  assert.ok(instances[0].closed);
  instances[1].failClosed();
  winL.online();
  assert.equal(instances.length, 3, 'online recreates a CLOSED stream');
  mock.timers.tick(20000);
  assert.equal(instances.length, 3, 'the pending backoff timer was cancelled, no duplicate');
  assert.equal(live(instances).length, 1);
});
