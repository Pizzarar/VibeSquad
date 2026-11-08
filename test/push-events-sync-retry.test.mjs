import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const src = readFileSync(resolve(import.meta.dirname, "../src/notifications.tsx"), "utf8");
const start = src.indexOf("const PUSH_SYNC_DELAYS_MS");
const end = src.indexOf("const syncPushEventsImpl = createPushEventsSyncer()");
assert.ok(start >= 0 && end > start, "createPushEventsSyncer slice found in src/notifications.tsx");

const code = src
  .slice(start, end)
  .replace(/export interface PushEventsSyncerOpts \{[\s\S]*?\}\n*/, "")
  .replace("export function createPushEventsSyncer(opts?: PushEventsSyncerOpts): () => void", "function createPushEventsSyncer(opts)")
  .replace(/let lastPushEvents = "";/, "let lastPushEvents = '';")
  .replace(/let syncSeq = 0;/, "let syncSeq = 0;")
  .replace(/let retryTimer: unknown = null;/, "let retryTimer = null;")
  .replace(/\(h as any\)/, "(h)")
  .replace(/\(seq: number, pushEvents: Record<string, boolean>, key: string, retryIndex: number\)/, "(seq, pushEvents, key, retryIndex)")
  .replace(/return function sync\(\): void/, "return function sync()");

const createPushEventsSyncer = new Function(`${code}; return createPushEventsSyncer;`)();

const tick = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe("createPushEventsSyncer (push-event toggle sync retry)", () => {
  test("2xx response succeeds once, keeps cache, and does not schedule retry", async () => {
    let events = { permission: true, needsYou: true, finished: true, errored: true };
    const calls = [];
    const scheduled = [];
    const sync = createPushEventsSyncer({
      getPushEvents: () => events,
      isDisabled: () => false,
      fetchFn: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
      },
      scheduleRetry: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      cancelRetry: () => {},
    });

    sync();
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { pushEvents: events });
    assert.equal(scheduled.length, 0);

    // Calling sync() again with the same value is skipped because cache is preserved on 2xx
    sync();
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(scheduled.length, 0);
  });

  test("non-2xx response is treated as failure: clears cache, retries with bounded backoff, and gives up until next toggle", async () => {
    let events = { permission: true, needsYou: false, finished: true, errored: true };
    const calls = [];
    const scheduled = [];
    let statusToReturn = 503;

    const sync = createPushEventsSyncer({
      getPushEvents: () => events,
      isDisabled: () => false,
      delaysMs: [100, 250, 500],
      fetchFn: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: statusToReturn >= 200 && statusToReturn < 300, status: statusToReturn };
      },
      scheduleRetry: (fn, ms) => {
        const item = { fn, ms, cancelled: false };
        scheduled.push(item);
        return item;
      },
      cancelRetry: (h) => {
        if (h) h.cancelled = true;
      },
    });

    // Initial attempt fails with 503
    sync();
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 100);

    // Retry 1 fails with 503 -> schedules Retry 2 (250ms)
    scheduled[0].fn();
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].ms, 250);

    // Retry 2 fails with 500 -> schedules Retry 3 (500ms)
    statusToReturn = 500;
    scheduled[1].fn();
    await tick();
    assert.equal(calls.length, 3);
    assert.equal(scheduled.length, 3);
    assert.equal(scheduled[2].ms, 500);

    // Retry 3 fails with 500 -> bounded backoff exhausted, no more retries scheduled
    scheduled[2].fn();
    await tick();
    assert.equal(calls.length, 4);
    assert.equal(scheduled.length, 3, "stops retrying after bounded delays are exhausted");

    // Because cache was cleared on failure, a later sync() with the SAME value is not skipped
    statusToReturn = 200;
    sync();
    await tick();
    assert.equal(calls.length, 5);
    assert.equal(scheduled.length, 3);
  });

  test("retry succeeds when server recovers to 2xx mid-backoff", async () => {
    let events = { permission: false, needsYou: true };
    let attemptCount = 0;
    const scheduled = [];

    const sync = createPushEventsSyncer({
      getPushEvents: () => events,
      isDisabled: () => false,
      delaysMs: [100, 200, 400],
      fetchFn: async () => {
        attemptCount++;
        return attemptCount === 1 ? { ok: false, status: 502 } : { ok: true, status: 200 };
      },
      scheduleRetry: (fn, ms) => {
        const item = { fn, ms };
        scheduled.push(item);
        return item;
      },
      cancelRetry: () => {},
    });

    sync();
    await tick();
    assert.equal(attemptCount, 1);
    assert.equal(scheduled.length, 1);

    // First retry succeeds with 200
    scheduled[0].fn();
    await tick();
    assert.equal(attemptCount, 2);
    assert.equal(scheduled.length, 1, "no further retry after 200");

    // Cache is now set to the succeeded value, so redundant sync() is a no-op
    sync();
    await tick();
    assert.equal(attemptCount, 2);
  });

  test("newer toggle cancels pending retry and supersedes in-flight failure", async () => {
    let events = { permission: true, needsYou: false };
    const calls = [];
    const scheduled = [];
    let rejectFirst;

    const sync = createPushEventsSyncer({
      getPushEvents: () => events,
      isDisabled: () => false,
      delaysMs: [100, 200],
      fetchFn: (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.pushEvents);
        if (calls.length === 1) {
          return Promise.resolve({ ok: false, status: 503 });
        }
        if (calls.length === 2) {
          return new Promise((_, rej) => {
            rejectFirst = rej;
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      },
      scheduleRetry: (fn, ms) => {
        const item = { fn, ms, cancelled: false };
        scheduled.push(item);
        return item;
      },
      cancelRetry: (h) => {
        if (h) h.cancelled = true;
      },
    });

    // 1. First toggle fails with 503 and schedules a retry timer
    sync();
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].cancelled, false);

    // 2. Newer toggle while retry timer is pending cancels the timer and sends new value
    events = { permission: false, needsYou: true };
    sync();
    assert.equal(scheduled[0].cancelled, true, "pending retry timer was cancelled");
    await tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { permission: false, needsYou: true });

    // 3. Another toggle arrives while call #2 is still in-flight
    events = { permission: true, needsYou: true };
    sync();
    await tick();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], { permission: true, needsYou: true });

    // Stale in-flight call #2 now rejects: must not clear cache or schedule a retry
    rejectFirst(new Error("network error"));
    await tick();
    assert.equal(scheduled.length, 1, "stale failure does not schedule a retry");

    // Cache still holds call #3's value
    sync();
    await tick();
    assert.equal(calls.length, 3);
  });
});
