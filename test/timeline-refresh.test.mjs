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

test('an inactive timeline never fetches on events, and refetches immediately when activated', () => {
  const clock = fakeClock();
  let loads = 0;
  let active = false;
  const s = createRefreshScheduler({ load: () => loads++, isActive: () => active, clock });
  s.request(); s.request();
  clock.advance(10_000);
  assert.equal(loads, 0);
  assert.equal(s.isStale(), true);
  active = true;
  s.activate();
  assert.equal(loads, 1);
  s.activate();
  assert.equal(loads, 1, 'not stale any more');
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
