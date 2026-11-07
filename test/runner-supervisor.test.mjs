// RR1: the supervisor restarts a runner whose reported code hash differs from the runtime runner/ dir, once it has no
// running turns. Pure function + injected-timer tests; nothing here touches a real runner process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashRunnerFiles } from "../runner/server.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";

const DISK = "disk-hash-123";

/** Runs the supervisor with a fake healthy runner, capturing ticks so each `next()` advances one tick. */
function harness(state) {
  const logs = [];
  let restarts = 0;
  const pending = [];
  const owner = { rc: { healthy: async () => true } };
  const sup = superviseRunner(owner, {
    checkMs: 5000,
    minBackoffMs: 100,
    maxBackoffMs: 400,
    healthInfo: async () => state.health,
    diskHash: () => DISK,
    restart: async () => {
      restarts += 1;
      state.health = { hash: DISK, running: 0 }; // the new runner reports the matching hash
    },
    log: (m) => logs.push(m),
    setTimer: (fn) => { pending.push(fn); return { unref() {} }; },
    clearTimer() {},
  });
  return {
    sup,
    logs,
    restarts: () => restarts,
    next: async () => { const fn = pending.shift(); if (fn) await fn(); },
  };
}

test("hashRunnerFiles: deterministic, content-sensitive sha256 over *.mjs names+contents, ignores non-mjs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-hash-"));
  try {
    writeFileSync(path.join(dir, "b.mjs"), "two");
    writeFileSync(path.join(dir, "a.mjs"), "one");
    const h1 = hashRunnerFiles(dir);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, hashRunnerFiles(dir));
    writeFileSync(path.join(dir, "a.mjs"), "changed");
    const h3 = hashRunnerFiles(dir);
    assert.notEqual(h1, h3);
    writeFileSync(path.join(dir, "c.txt"), "ignored");
    assert.equal(hashRunnerFiles(dir), h3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same hash: never restarts and logs nothing", async () => {
  const h = harness({ health: { hash: DISK, running: 0 } });
  await h.sup.ready;
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.restarts(), 0);
  assert.deepEqual(h.logs, []);
  h.sup.stop();
});

test("missing hash (old build): stale, restarts once zero turns", async () => {
  const h = harness({ health: { running: 0 } });
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 1);
  assert.ok(h.logs.some((l) => /runner restart:/.test(l)), `got: ${h.logs.join(" | ")}`);
  h.sup.stop();
});

test("stale hash + running turns: no restart, pending logged exactly once", async () => {
  const h = harness({ health: { hash: "old-hash", running: 2 } });
  await h.sup.ready;
  for (let i = 0; i < 4; i++) await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /pending/.test(l)).length, 1);
  h.sup.stop();
});

test("stale hash + zero running turns: exactly one restart", async () => {
  const h = harness({ health: { hash: "old-hash", running: 0 } });
  await h.sup.ready;
  await h.next(); // stale + zero -> restart, health flips to matching
  assert.equal(h.restarts(), 1);
  await h.next();
  await h.next();
  assert.equal(h.restarts(), 1);
  assert.ok(h.logs.some((l) => /runner restart:/.test(l)));
  h.sup.stop();
});

test("restart becomes pending then happens across ticks: pending logged once, restart logged once", async () => {
  const state = { health: { hash: "old-hash", running: 1 } };
  const h = harness(state);
  await h.sup.ready;
  await h.next(); // running -> pending (logged)
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /pending/.test(l)).length, 1);
  state.health = { hash: "old-hash", running: 0 }; // turns finished, still stale
  await h.next(); // stale + zero -> restart
  assert.equal(h.restarts(), 1);
  assert.equal(h.logs.filter((l) => /runner restart:/.test(l)).length, 1);
  h.sup.stop();
});
