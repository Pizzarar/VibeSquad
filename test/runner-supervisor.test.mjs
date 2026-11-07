// RR1: the supervisor restarts a runner whose reported code hash differs from the runtime runner/ dir, once it has no
// running turns. An unknown running count is never treated as zero, and each distinct disk hash is restarted at most once.
// Pure function + injected-timer tests; nothing here touches a real runner process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashRunnerFiles } from "../runner/server.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";

/** Runs the supervisor with a fake healthy runner; each `next()` advances one tick. `restart` only counts (never flips state). */
function harness(state, { runningCount } = {}) {
  const logs = [];
  let restarts = 0;
  const pending = [];
  const owner = { rc: { healthy: async () => true } };
  const opts = {
    checkMs: 5000,
    minBackoffMs: 100,
    maxBackoffMs: 400,
    healthInfo: async () => state.health,
    diskHash: () => state.disk,
    restart: async () => { restarts += 1; },
    log: (m) => logs.push(m),
    setTimer: (fn) => { pending.push(fn); return { unref() {} }; },
    clearTimer() {},
  };
  if (runningCount) opts.runningCount = runningCount;
  const sup = superviseRunner(owner, opts);
  return {
    sup,
    logs,
    restarts: () => restarts,
    next: async () => { const fn = pending.shift(); if (fn) await fn(); },
  };
}

test("hashRunnerFiles: recursive, deterministic, content-sensitive over relative *.mjs paths, ignores non-mjs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-hash-"));
  try {
    writeFileSync(path.join(dir, "b.mjs"), "two");
    writeFileSync(path.join(dir, "a.mjs"), "one");
    const h1 = hashRunnerFiles(dir);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, hashRunnerFiles(dir)); // deterministic (and cached)
    // a file in a subdir (adapters/) is included in the recursive walk
    mkdirSync(path.join(dir, "adapters"), { recursive: true });
    writeFileSync(path.join(dir, "adapters", "c.mjs"), "three");
    const h2 = hashRunnerFiles(dir);
    assert.notEqual(h1, h2);
    // a content change is detected (3 -> 7 bytes)
    writeFileSync(path.join(dir, "a.mjs"), "changed");
    const h3 = hashRunnerFiles(dir);
    assert.notEqual(h2, h3);
    // non-mjs files are ignored
    writeFileSync(path.join(dir, "note.txt"), "ignored");
    assert.equal(hashRunnerFiles(dir), h3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same hash: never restarts and logs nothing", async () => {
  const state = { disk: "disk-hash-123", health: { hash: "disk-hash-123", running: 0 } };
  const h = harness(state);
  await h.sup.ready;
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.restarts(), 0);
  assert.deepEqual(h.logs, []);
  h.sup.stop();
});

test("missing hash (old build) + zero running turns: restarts once", async () => {
  const state = { disk: "disk-hash-123", health: { running: 0 } };
  const h = harness(state);
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 1);
  h.sup.stop();
});

test("stale hash + running turns: no restart, pending logged exactly once", async () => {
  const state = { disk: "disk-hash-123", health: { hash: "old", running: 2 } };
  const h = harness(state);
  await h.sup.ready;
  for (let i = 0; i < 4; i++) await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /pending/.test(l)).length, 1);
  h.sup.stop();
});

test("stale hash + zero turns: restarts once per diskHash, then gives up (logs once)", async () => {
  const state = { disk: "disk-hash-123", health: { hash: "old", running: 0 } };
  const h = harness(state);
  await h.sup.ready;
  await h.next(); // stale + zero, disk != restartedFor -> restart (1), restartedFor = disk
  assert.equal(h.restarts(), 1);
  await h.next(); // still stale, disk == restartedFor -> give up (logged once)
  await h.next(); // still stale, give-up already logged -> nothing new
  assert.equal(h.restarts(), 1);
  assert.equal(h.logs.filter((l) => /restarting/.test(l)).length, 1); // the "restarting" metric logs once per diskHash
  assert.equal(h.logs.filter((l) => /giving up/.test(l)).length, 1);
  h.sup.stop();
});

test("restarts again when the runtime disk hash changes to a new value", async () => {
  const state = { disk: "d1", health: { hash: "old", running: 0 } };
  const h = harness(state);
  await h.sup.ready;
  await h.next(); // disk d1 -> restart (1), restartedFor = d1
  assert.equal(h.restarts(), 1);
  state.disk = "d2"; // a new build changes the runtime hash
  await h.next(); // disk d2 != restartedFor d1 -> restart (2), restartedFor = d2
  assert.equal(h.restarts(), 2);
  h.sup.stop();
});

test("old build (no hash, no running) + an agent running: no restart", async () => {
  const state = { disk: "disk-hash-123", health: {} }; // no hash, no running field
  const h = harness(state, { runningCount: async () => 1 });
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /pending/.test(l)).length, 1);
  h.sup.stop();
});

test("old build (no running) + derived zero running turns: restarts", async () => {
  const state = { disk: "disk-hash-123", health: { hash: "old" } }; // stale, no running field
  const h = harness(state, { runningCount: async () => 0 });
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 1);
  h.sup.stop();
});

test("unknown running count (derivation fails): treated as busy, no restart", async () => {
  const state = { disk: "disk-hash-123", health: { hash: "old" } }; // stale, no running field
  const h = harness(state, { runningCount: async () => null });
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /pending/.test(l)).length, 1);
  assert.match(h.logs[0], /running turns unknown/);
  h.sup.stop();
});
