import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshScheduler } from '../src/timelineRefresh.ts';
import { reduceTurn, toAgent } from '../server/backend/runner-backend.mjs';

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => timers.delete(h),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

test('first runner event fetches immediately (leading edge)', () => {
  const clock = fakeClock();
  let loads = 0;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => true, clock });
  s.request();
  assert.equal(loads, 1);
});

test('a steady event stream is throttled, not starved: fetches keep landing while events never pause', () => {
  const clock = fakeClock();
  const loadsAt = [];
  const s = createRefreshScheduler({ load: () => loadsAt.push(clock.now()), isActive: () => true, gapMs: 800, clock });
  for (let t = 0; t <= 6000; t += 100) { clock.advance(t === 0 ? 0 : 100); s.request(); }
  assert.ok(loadsAt.length >= 6, `expected steady fetches, got ${loadsAt.join(',')}`);
  assert.equal(loadsAt[0], 0);
  for (let i = 1; i < loadsAt.length; i++) {
    assert.ok(loadsAt[i] - loadsAt[i - 1] >= 800, 'never faster than the gap');
    assert.ok(loadsAt[i] - loadsAt[i - 1] <= 2500, 'trailing fetch lands within 2.5s');
  }
});

test('events inside the gap collapse into one trailing fetch that is not pushed back', () => {
  const clock = fakeClock();
  let loads = 0;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => true, gapMs: 800, clock });
  s.request(); // leading
  clock.advance(100); s.request();
  clock.advance(100); s.request();
  clock.advance(100); s.request();
  assert.equal(loads, 1);
  clock.advance(500); // 800ms after the leading fetch
  assert.equal(loads, 2);
  clock.advance(5000);
  assert.equal(loads, 2, 'no extra fetch without new events');
});

test('a hidden (mounted, inactive) timeline still refetches live, at the slower gap, and activation catches up', () => {
  const clock = fakeClock();
  let loads = 0;
  let active = false;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => active, gapMs: 800, hiddenGapMs: 3000, clock });
  s.request(); // leading edge: hidden tab fetches at once
  assert.equal(loads, 1);
  clock.advance(100); s.request();
  clock.advance(1000); s.request();
  assert.equal(loads, 1, 'hidden gap is slower than the active one');
  assert.equal(s.isStale(), true);
  clock.advance(2000);
  assert.equal(loads, 2, 'trailing hidden fetch lands inside 3s');
  assert.equal(s.isStale(), false);
  s.request(); // owed again
  active = true;
  s.activate();
  assert.equal(loads, 3);
  s.activate();
  assert.equal(loads, 3, 'not stale any more');
});

test('catchUp (SSE reconnect / window visible) refetches once and not while a fetch is already due', () => {
  const clock = fakeClock();
  let loads = 0;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => false, clock });
  s.catchUp();
  assert.equal(loads, 1);
  s.request(); s.request(); // trailing due
  s.catchUp();
  assert.equal(loads, 1);
  clock.advance(3000);
  assert.equal(loads, 2);
});

test('dispose cancels a pending trailing fetch', () => {
  const clock = fakeClock();
  let loads = 0;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => true, clock });
  s.request(); s.request();
  s.dispose();
  clock.advance(5000);
  assert.equal(loads, 1);
});

test('parked maps to idle in the snapshot and the live turn reducer alike', () => {
  const snap = toAgent({ id: 'rn-1', provider: 'claude', cwd: '/x', status: 'parked', meta: {}, createdAt: 1 });
  const live = { status: 'idle', errored: false };
  reduceTurn(live, { type: 'status', status: 'parked', seq: 5 });
  assert.equal(snap.status, 'idle');
  assert.equal(live.status, snap.status);
  // a parked agent being woken starts a turn cleanly: parked -> starting -> running
  reduceTurn(live, { type: 'input', seq: 6 });
  reduceTurn(live, { type: 'status', status: 'starting', seq: 7 });
  assert.deepEqual(reduceTurn(live, { type: 'status', status: 'running', seq: 8 }), { kind: 'turn_started' });
});

test('runner bridge: SSE open/reconnect/"connected" and a shown window send a catch-up to every mounted timeline; a timeline event is a plain change', async () => {
  const listeners = {};
  globalThis.document = { hidden: false, addEventListener: (n, f) => (listeners[n] = f) };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: true, lanes: [] }) });
  let es;
  globalThis.EventSource = class { constructor() { es = this; } };
  const { startRunnerBridge, runnerHandle } = await import('../src/runnerBridge.ts');
  const seen = [];
  runnerHandle('rn-a').timeline.subscribe((ev) => seen.push(`a:${ev.event.type}`));
  runnerHandle('rn-b').timeline.subscribe((ev) => seen.push(`b:${ev.event.type}`));
  startRunnerBridge(() => {});
  await new Promise((r) => setTimeout(r, 20));
  es.onopen();
  assert.deepEqual(seen, ['a:runner-catchup', 'b:runner-catchup'], 'reconnect');
  seen.length = 0;
  es.onmessage({ data: JSON.stringify({ kind: 'timeline', agentId: 'rn-a', seq: 3, type: 'x' }) });
  assert.deepEqual(seen, ['a:runner-changed']);
  seen.length = 0;
  es.onmessage({ data: JSON.stringify({ kind: 'connected' }) });
  assert.equal(seen.length, 2, 'connected after a runner outage');
  seen.length = 0;
  listeners.visibilitychange();
  assert.equal(seen.length, 2, 'window shown again');
  seen.length = 0;
  globalThis.document.hidden = true;
  listeners.visibilitychange();
  assert.equal(seen.length, 0);
});

test('catchUp bursts (open + connected + roster) coalesce into one fetch; a later reconnect fetches again', () => {
  const clock = fakeClock();
  let loads = 0;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => true, clock });
  s.catchUp(); s.catchUp(); s.catchUp();
  assert.equal(loads, 1);
  clock.advance(1500);
  s.catchUp();
  assert.equal(loads, 2);
});
