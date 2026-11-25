// RR1: the supervisor restarts a runner whose reported code hash differs from the runtime runner/ dir, once it has no
// running turns. An unknown running count is never treated as zero, and each distinct disk hash is restarted at most once.
// Pure function + injected-timer tests; nothing here touches a real runner process.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashRunnerFiles } from "../runner/server.mjs";
import { pendingIdleRestart, restartRunnerNow, restartWhenIdle, runnerBusy, superviseRunner } from "../server/runner-supervisor.mjs";

/** Runs the supervisor with a fake healthy runner; each `next()` advances one tick. `restart` only counts (never flips state). */
function harness(state, { runningCount, owner = { rc: { healthy: async () => true } } } = {}) {
  const logs = [];
  let restarts = 0;
  const pending = [];
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
  if (state.agents !== undefined) opts.agentList = async () => state.agents;
  const sup = superviseRunner(owner, opts);
  return {
    owner,
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

// idea-375: restart 01:22Z 11-20: `vs restart` saw the runner idle at 01:22:33.819 and RR1 hard-killed it at .821 (no graceful
// stop, no shutdown fold-index save). While the runner reports a vs restart drain, the restart owns the stop: RR1 defers.
test("idea-375: stale hash + idle but a vs restart drain is active: no restart (deferred, logged once); restarts once the drain ends", async () => {
  const drain = { since: 1, until: 2, reason: "vs restart pid 6284" };
  const state = { disk: "disk-hash-123", health: { hash: "old", running: 2, drain } };
  const h = harness(state);
  await h.sup.ready;
  state.health = { hash: "old", running: 0, held: 0, drain }; // the turns finish: idle, exactly when vs restart sends /shutdown
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.filter((l) => /deferred: vs restart drain active \(vs restart pid 6284\)/.test(l)).length, 1, h.logs.join("\n"));
  state.health = { hash: "old", running: 0, held: 0, drain: null }; // the drain expired (a crashed restart): RR1 resumes
  await h.next();
  assert.equal(h.restarts(), 1);
  h.sup.stop();
});

test("idea-375: the default healthInfo passes the runner's /health drain through", async () => {
  let restarts = 0;
  const pending = [];
  const owner = { rc: { healthy: async () => true, request: async () => ({ hash: "old", running: 0, held: 0, drain: { since: 1, until: 2, reason: "vs restart" } }) } };
  const sup = superviseRunner(owner, { diskHash: () => "disk", restart: async () => { restarts += 1; }, log: () => {}, setTimer: (fn) => { pending.push(fn); return { unref() {} }; }, clearTimer() {} });
  await sup.ready;
  assert.equal(restarts, 0);
  sup.stop();
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

test("restartRunnerNow is single-flight per owner: concurrent calls share one kill + one startOwned", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-restart-now-"));
  const home = path.join(dir, "runner");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242 }));
  writeFileSync(path.join(home, "token"), "t");
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: 4242 }));
  const killed = [];
  let starts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const owner = {
    rc: { home },
    startOwned: async () => { starts += 1; await gate; return true; },
  };
  try {
    const opts = { kill: (pid) => killed.push(pid), alive: () => false, waitMs: 0 };
    const p1 = restartRunnerNow(owner, opts);
    const p2 = restartRunnerNow(owner, opts);
    assert.equal(p2, p1, "second caller awaits the in-flight restart");
    release();
    assert.equal(await p1, true);
    assert.equal(await p2, true);
    assert.deepEqual(killed, [4242], "exactly one kill");
    assert.equal(starts, 1, "exactly one startOwned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// idea-786: 11-24 12:28:46Z a restart killed three running workers. Every killing restart goes through runnerBusy(): /health open
// turns + held background work + every running-ish agent on the list; unknown is busy.
test("idea-786: runnerBusy counts /health turns, held work and every running-ish listed agent; unknown is busy", () => {
  assert.equal(runnerBusy({ running: 0, held: 0, heldAgents: [] }, []).busy, false);
  assert.equal(runnerBusy({ running: 0, held: 0, heldAgents: [] }, [{ id: "a", status: "idle" }, { id: "b", status: "closed" }]).busy, false);
  assert.equal(runnerBusy({ running: 1 }, []).busy, true);
  assert.equal(runnerBusy({ running: 0, held: 1, heldAgents: ["h"] }, []).busy, true);
  for (const status of ["running", "initializing", "starting", "working", "queued", "RUNNING"]) {
    const g = runnerBusy({ running: 0, held: 0, heldAgents: [] }, [{ id: "w", status }]);
    assert.equal(g.busy, true, status);
    assert.deepEqual(g.ids, ["w"]);
  }
  assert.equal(runnerBusy({ running: 0 }, [{ id: "x", status: "running", archivedAt: "2026-11-01T00:00:00Z" }]).busy, false, "archived does not count");
  assert.equal(runnerBusy(null, []).unknown, true, "no /health body is unknown");
  assert.equal(runnerBusy({}, null).busy, true, "no count and no list is unknown -> busy");
  assert.equal(runnerBusy({}, []).busy, false, "an old build with a listed-idle roster is idle");
});

test("idea-786: RR1 stale hash + /health says 0 turns but the list has a running worker: no restart, pending names it", async () => {
  const state = { disk: "new", health: { hash: "old", running: 0, held: 0, heldAgents: [] }, agents: [{ id: "rn-980b4f09bcc1", status: "running" }] };
  const h = harness(state);
  await h.sup.ready;
  await h.next();
  assert.equal(h.restarts(), 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /restart pending: 1 running turn\(s\).*rn-980b4f09bcc1/);
  state.agents = [{ id: "rn-980b4f09bcc1", status: "idle" }];
  await h.next();
  assert.equal(h.restarts(), 1, "restarts once the worker is done");
  h.sup.stop();
});

test("idea-786: an owner restart armed while busy fires only on the first idle tick (same hash), once", async () => {
  const state = { disk: "same", health: { hash: "same", running: 1, held: 0, heldAgents: [] }, agents: [{ id: "rn-w", status: "running" }] };
  const h = harness(state);
  await h.sup.ready;
  assert.equal(restartWhenIdle(h.owner), true);
  assert.equal(restartWhenIdle(h.owner), false, "a second press while armed is a no-op");
  await h.next();
  assert.equal(h.restarts(), 0, "busy: armed, not fired");
  assert.match(h.logs.at(-1), /pending: 1 running turn\(s\).*\[owner restart armed\]/);
  state.health = { hash: "same", running: 0, held: 1, heldAgents: ["rn-w"] };
  state.agents = [{ id: "rn-w", status: "idle" }];
  await h.next();
  assert.equal(h.restarts(), 0, "held background work still blocks it");
  state.health = { hash: "same", running: 0, held: 0, heldAgents: [] };
  await h.next();
  assert.equal(h.restarts(), 1, "fires once idle");
  assert.equal(pendingIdleRestart(h.owner), null, "disarmed after firing");
  await h.next();
  assert.equal(h.restarts(), 1, "fires once");
  h.sup.stop();
});

test("idea-786: an armed owner restart waits out a vs restart drain like RR1 does", async () => {
  const state = { disk: "same", health: { hash: "same", running: 0, held: 0, heldAgents: [], drain: { kind: "restart", reason: "vs restart pid 9" } }, agents: [] };
  const h = harness(state);
  await h.sup.ready;
  restartWhenIdle(h.owner);
  await h.next();
  assert.equal(h.restarts(), 0);
  assert.ok(h.logs.some((l) => /deferred: vs restart drain active/.test(l)));
  h.sup.stop();
});

test("idea-786: a runner the supervisor (re)starts from down clears an armed owner restart", async () => {
  let healthy = false;
  const owner = { rc: { healthy: async () => healthy }, startOwned: async () => { healthy = true; return true; } };
  restartWhenIdle(owner);
  const state = { disk: "same", health: { hash: "same", running: 0, held: 0, heldAgents: [] }, agents: [] };
  const h = harness(state, { owner });
  await h.sup.ready;
  assert.equal(pendingIdleRestart(owner), null);
  await h.next();
  assert.equal(h.restarts(), 0, "no second restart of the fresh runner");
  h.sup.stop();
});
