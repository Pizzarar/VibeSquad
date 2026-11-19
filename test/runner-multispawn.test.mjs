// P0 runner multispawn (11-15, restart onto e2042f1): a runner whose boot outlived startOwned's 8s wait was respawned every
// ~40s, and each new runner stole runner.lock from the still-booting one (15s grace, no runner.json yet = "unhealthy"), so
// 5 runners listened at once. Invariants pinned here:
//   1. the owner never spawns while its previous runner child (or a booting lock holder) is alive;
//   2. a live holder that has not published runner.json keeps the lock while it boots (up to RUNNER_BOOT_MAX_MS);
//   3. a runner that no longer holds runner.lock admits no queued work, never publishes, and exits on its own;
//   4. a runner that exits without the lock leaves runner.json / drain.json alone (they belong to the lock holder).
// Temp homes only; every runner process started here is killed in after().
import "./helpers/clean-env.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RUNNER_BOOT_MAX_MS, acquireRunnerLock, bootingHolder, holdsLock, pidAlive, publishedBy } from "../runner/lock.mjs";
import { Runner } from "../runner/runner.mjs";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { publishIfHolding } from "../runner/server.mjs";

const SERVER = path.join(import.meta.dirname, "..", "runner", "server.mjs");
const homes = [];
const procs = [];
const mkHome = () => { const h = mkdtempSync(path.join(os.tmpdir(), "vs-multispawn-")); homes.push(h); return h; };
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

after(async () => {
  for (const p of procs) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 400));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

// A fake runner child: a live pid (this test process) that never answers /health, like a runner still folding its roster.
function slowSpawn() {
  const spawns = [];
  const spawnImpl = (...a) => { spawns.push(a); return { pid: process.pid, unref() {} }; };
  return { spawns, spawnImpl };
}

test("startOwned: a runner child still booting is waited on, never spawned again", async () => {
  const home = mkHome();
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 150 });
  await assert.rejects(rc.startOwned(), /did not start|booting/);
  await assert.rejects(rc.startOwned(), /booting/);
  await assert.rejects(rc.startOwned(), /booting/);
  assert.equal(spawns.length, 1, "one spawn while the first child is alive");
});

test("startOwned: a live runner.lock holder that has not published runner.json is booting: no spawn", async () => {
  const home = mkHome();
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 }));
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 150 });
  await assert.rejects(rc.startOwned(), /booting/);
  assert.equal(spawns.length, 0);
});

test("startOwned: a booting holder past RUNNER_BOOT_MAX_MS no longer blocks a start", async () => {
  const home = mkHome();
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() - RUNNER_BOOT_MAX_MS - 1000 }));
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 100 });
  await assert.rejects(rc.startOwned(), /did not start/);
  assert.equal(spawns.length, 1);
});

test("supervisor: a slow runner start spawns at most one runner across many ticks", async () => {
  const home = mkHome();
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 50 });
  const owner = { rc, startOwned: () => rc.startOwned().then(() => true, () => false) };
  const pending = [];
  const sup = superviseRunner(owner, {
    minBackoffMs: 1, maxBackoffMs: 1,
    setTimer: (fn) => { pending.push(fn); return { unref() {} }; },
    clearTimer() {},
    log() {},
  });
  await sup.ready;
  for (let i = 0; i < 8; i++) { const fn = pending.shift(); if (fn) await fn(); }
  sup.stop();
  assert.equal(spawns.length, 1, `spawned ${spawns.length} runners`);
});

test("acquireRunnerLock: a live, unpublished holder past the 15s grace keeps the lock (booting)", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  writeFileSync(file, JSON.stringify({ pid: 4242, startedAt: Date.now() - 60_000 }));
  const r = await acquireRunnerLock(home, { isHealthy: async () => false, alive: (p) => p === 4242 });
  assert.equal(r.owned, false);
  assert.equal(r.holder, 4242);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 4242, "the booting holder's lock is untouched");
});

test("acquireRunnerLock: an unpublished holder wedged past RUNNER_BOOT_MAX_MS is taken over", async () => {
  const home = mkHome();
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: 4242, startedAt: Date.now() - RUNNER_BOOT_MAX_MS - 1000 }));
  const r = await acquireRunnerLock(home, { isHealthy: async () => false, alive: (p) => p === 4242 });
  assert.equal(r.owned, true);
});

test("acquireRunnerLock: a published holder that answers /health keeps the lock; an unresponsive one is taken over", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  const held = { pid: 4242, startedAt: Date.now() - 60_000 };
  writeFileSync(file, JSON.stringify(held));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242, startedAt: Date.now() - 50_000, lockStartedAt: held.startedAt }));
  const alive = (p) => p === 4242;
  assert.equal((await acquireRunnerLock(home, { isHealthy: async () => true, alive })).owned, false);
  assert.equal((await acquireRunnerLock(home, { isHealthy: async () => false, alive })).owned, true);
});

test("holdsLock: true only for the exact holder (pid and startedAt)", () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  writeFileSync(file, JSON.stringify({ pid: 7, startedAt: 100 }));
  assert.equal(holdsLock(file, { pid: 7, startedAt: 100 }), true);
  assert.equal(holdsLock(file, { pid: 7, startedAt: 101 }), false);
  assert.equal(holdsLock(file, { pid: 8, startedAt: 100 }), false);
  rmSync(file);
  assert.equal(holdsLock(file, { pid: 7, startedAt: 100 }), false);
});

// A fake claude CLI: every spawn inits a session and then idles (holds its turn slot).
function fakeClaude() {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit("exit", 0, null); };
    setImmediate(() => child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }) + "\n"));
    return child;
  };
}
const bootRunner = (dir) => new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl: fakeClaude(), mcp: false }) }, maxLive: 16, parkGraceMs: 60_000, turnCaps: { claude: 1 } });

test("recoverQueued: shouldAdmit=false folds but admits nothing; shouldAdmit=true admits the same queued agent", async () => {
  const dir = path.join(mkHome(), "agents");
  mkdirSync(dir, { recursive: true });
  const r1 = bootRunner(dir);
  r1.create({ provider: "claude", cwd: process.cwd(), prompt: "first" }); // holds the only turn slot
  const queued = r1.create({ provider: "claude", cwd: process.cwd(), prompt: "second" }); // queued behind it
  await new Promise((r) => setTimeout(r, 40));
  r1.shutdown(); // the queue was in memory; the log still ends in `queued`

  const robbed = bootRunner(dir);
  let asked = 0;
  try {
    assert.deepEqual(robbed.recoverQueued({ shouldAdmit: () => { asked += 1; return false; } }), []);
    assert.equal(asked, 1);
    assert.equal(robbed.queue.length, 0);
    assert.equal(robbed.live.size, 0, "nothing started");
  } finally {
    robbed.shutdown();
  }
  const holder = bootRunner(dir); // control: the same log, with the lock, does admit it
  try {
    assert.deepEqual(holder.recoverQueued({ shouldAdmit: () => true }), [queued]);
  } finally {
    holder.shutdown();
  }
});

// Review H1: a runner that died hard leaves runner.json; the OS reuses its pid for a new runner that is still folding.
test("stale runner.json with a reused pid does not make a booting holder read as published", async () => {
  const home = mkHome();
  const lock = { pid: process.pid, startedAt: Date.now() - 60_000 }; // the new holder, past the 15s grace, still booting
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify(lock));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: lock.startedAt - 3_600_000, lockStartedAt: lock.startedAt - 3_600_010 }));
  assert.equal(publishedBy(home, lock), false);
  assert.equal(bootingHolder(home)?.pid, process.pid);
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 100 });
  await assert.rejects(rc.startOwned(), /booting/);
  assert.equal(spawns.length, 0, "no duplicate runner");
  // A runner.json the holder did publish (same lockStartedAt) does count.
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: Date.now(), lockStartedAt: lock.startedAt }));
  assert.equal(publishedBy(home, lock), true);
});

test("acquireRunnerLock: a stale runner.json with the holder's reused pid does not end its boot grace (review H1)", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  const lock = { pid: 4242, startedAt: Date.now() - 60_000 }; // past the 15s grace, still folding
  writeFileSync(file, JSON.stringify(lock));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242, startedAt: lock.startedAt - 3_600_000, lockStartedAt: lock.startedAt - 3_600_010 }));
  let probed = false;
  const r = await acquireRunnerLock(home, { isHealthy: async () => { probed = true; return false; }, alive: (p) => p === 4242 });
  assert.equal(r.owned, false, "the booting holder keeps its lock");
  assert.equal(probed, false, "the dead port in the stale runner.json is never probed");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), lock);
});

test("startOwned: a stale runner.json naming the spawned child's reused pid does not end its boot", async () => {
  const home = mkHome();
  const { spawns, spawnImpl } = slowSpawn(); // the child gets this process's pid
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: Date.now() - 3_600_000 }));
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 80 });
  await assert.rejects(rc.startOwned(), /did not start|booting/);
  await assert.rejects(rc.startOwned(), /booting/);
  assert.equal(spawns.length, 1);
});

test("startOwned: once a runner answers, the owned child no longer blocks a later start (review M1a)", async () => {
  const home = mkHome();
  const { spawns, spawnImpl } = slowSpawn();
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 80 });
  let up = false;
  rc.healthy = async () => up;
  await assert.rejects(rc.startOwned(), /did not start/);
  assert.ok(rc.ownedChild, "child tracked while it boots");
  up = true;
  await rc.startOwned();
  assert.equal(rc.ownedChild, null, "cleared once a runner answers");
  up = false; // runner.json deleted / runner gone while the old child pid is still alive (here: this process)
  await assert.rejects(rc.startOwned(), /did not start/);
  assert.equal(spawns.length, 2, "a fresh start is not blocked by the old child");
});

// Review H2: a lock created (O_EXCL) but not yet written must never be removed.
test("acquireRunnerLock: an empty, just-created lock is left alone", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  writeFileSync(file, "");
  let probed = false;
  const r = await acquireRunnerLock(home, { isHealthy: async () => { probed = true; return false; } });
  assert.equal(r.owned, false);
  assert.equal(probed, false);
  assert.ok(existsSync(file), "the creator's lock survives");
  assert.equal(readFileSync(file, "utf8"), "");
});

test("acquireRunnerLock: a stealer that lost the race to a faster stealer leaves the winner's lock alone", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  const stale = { pid: 4242, startedAt: Date.now() - 60_000 };
  writeFileSync(file, JSON.stringify(stale));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242, startedAt: Date.now() - 50_000, lockStartedAt: stale.startedAt }));
  const winner = { pid: 5151, startedAt: Date.now() };
  // While we await the stale holder's /health, another runner judges it the same way, removes it and takes the lock.
  const isHealthy = async () => { rmSync(file); writeFileSync(file, JSON.stringify(winner)); return false; };
  const r = await acquireRunnerLock(home, { isHealthy, alive: (p) => p === 4242 || p === 5151 });
  assert.equal(r.owned, false);
  assert.equal(r.holder, 5151);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), winner, "winner's lock untouched");
});

test("acquireRunnerLock: a dead holder's lock is taken over", async () => {
  const home = mkHome();
  const file = path.join(home, "runner.lock");
  writeFileSync(file, JSON.stringify({ pid: 4242, startedAt: Date.now() - 1000 }));
  const r = await acquireRunnerLock(home, { isHealthy: async () => true, alive: () => false });
  assert.equal(r.owned, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
  rmSync(file);
});

test("publishIfHolding: a runner robbed during boot calls lockLost('boot') and publishes nothing", () => {
  const home = mkHome();
  const me = { pid: process.pid, startedAt: Date.now() - 5000 };
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() })); // a newer holder's lock
  const lost = [];
  assert.equal(publishIfHolding(home, { port: 1, token: "t", me, onLost: (w) => lost.push(w) }), false);
  assert.deepEqual(lost, ["boot"]);
  assert.equal(existsSync(path.join(home, "runner.json")), false);
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify(me)); // holding: publishes, tied to the lock
  assert.equal(publishIfHolding(home, { port: 1, token: "t", me, onLost: (w) => lost.push(w) }), true);
  assert.deepEqual(lost, ["boot"]);
  const pub = JSON.parse(readFileSync(path.join(home, "runner.json"), "utf8"));
  assert.equal(pub.pid, process.pid);
  assert.equal(pub.lockStartedAt, me.startedAt);
});

function startRunner(home, env = {}) {
  const child = spawn(process.execPath, [SERVER, "--home", home], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env }, windowsHide: true });
  procs.push(child.pid);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  return { child, out: () => out, exited };
}

test("a robbed runner exits on its own and leaves the new holder's runner.json and drain.json alone", { timeout: 30000 }, async () => {
  const home = mkHome();
  const a = startRunner(home, { VS_RUNNER_LOCK_CHECK_MS: "100" });
  await until(() => a.out().includes('"listening"'));
  // A newer runner takes the home: it owns runner.lock and has published its runner.json; a restart drain is in force.
  const thief = { pid: process.pid, startedAt: Date.now() };
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify(thief));
  const json = JSON.stringify({ port: 1, pid: process.pid, startedAt: Date.now() });
  writeFileSync(path.join(home, "runner.json"), json);
  const drain = JSON.stringify({ since: Date.now(), until: Date.now() + 600_000, reason: "test" });
  writeFileSync(path.join(home, "drain.json"), drain);
  const code = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r("still running"), 10000))]);
  assert.notEqual(code, "still running", "the robbed runner exited");
  assert.match(a.out(), /lockLost/);
  assert.equal(readFileSync(path.join(home, "runner.json"), "utf8"), json, "runner.json still names the holder");
  assert.equal(readFileSync(path.join(home, "drain.json"), "utf8"), drain, "drain.json kept");
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "runner.lock"), "utf8")), thief, "lock untouched");
});

test("a robbed runner never deletes runner.json, even its own, once it no longer holds the lock (review M1b)", { timeout: 30000 }, async () => {
  const home = mkHome();
  const a = startRunner(home, { VS_RUNNER_LOCK_CHECK_MS: "100" });
  await until(() => a.out().includes('"listening"'));
  const own = readFileSync(path.join(home, "runner.json"), "utf8");
  // The thief has the lock but has not published yet: its writeDiscovery may land at any moment, so the robbed runner keeps out.
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const code = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r("still running"), 10000))]);
  assert.notEqual(code, "still running");
  assert.match(a.out(), /lockLost/);
  assert.equal(readFileSync(path.join(home, "runner.json"), "utf8"), own);
});

test("a runner that exits holding the lock removes its own runner.json and lock, and logs boot timing", { timeout: 30000 }, async () => {
  const home = mkHome();
  const a = startRunner(home);
  await until(() => a.out().includes('"listening"'));
  const pub = JSON.parse(readFileSync(path.join(home, "runner.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(home, "runner.lock"), "utf8"));
  assert.equal(pub.lockStartedAt, lock.startedAt, "runner.json is tied to the lock it holds");
  assert.match(a.out(), /"boot":\{"lock":\d+,"sweepOrphans":\d+,"init":\d+,"fold":\d+,"listen":\d+,"total":\d+\}/);
  // idea-328/337: the line says where the fold phase went and why a fold index was not used
  const bootLine = JSON.parse(a.out().split("\n").find((l) => l.startsWith('{"boot":')));
  const fm = bootLine.bootFoldMs;
  assert.ok(fm && ["prefold", "load", "pass", "stat", "seed", "read", "tokens", "plans", "admit", "rest"].every((k) => Number.isInteger(fm[k])), JSON.stringify(fm));
  assert.ok(Math.abs(fm.prefold + fm.load + fm.pass + fm.tokens + fm.plans + fm.admit + fm.rest - bootLine.boot.fold) <= 6, "bootFoldMs adds up to the fold phase");
  assert.equal(bootLine.foldIndex.discardReason, "missing", "a fresh home has no index yet");
  // POST /shutdown runs stop() on every platform (a win32 SIGTERM is a hard kill that skips the handlers).
  const token = readFileSync(path.join(home, "token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${pub.port}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.ok(res.ok, `shutdown ${res.status}`);
  await a.exited;
  assert.match(a.out(), /\{"foldIndexSave":\{[^\n]*"at":"shutdown"\}\}/, "the shutdown save is logged once");
  assert.equal(a.out().match(/"at":"shutdown"/g).length, 1);
  assert.equal(existsSync(path.join(home, "runner.json")), false);
  assert.equal(existsSync(path.join(home, "runner.lock")), false);
});

test("a second runner on a home whose holder is alive but still booting exits 0 without publishing", { timeout: 30000 }, async () => {
  const home = mkHome();
  // The holder (this live test process) took the lock 60s ago and has not published runner.json yet.
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 }));
  const b = startRunner(home);
  const code = await b.exited;
  assert.equal(code, 0);
  assert.match(b.out(), /alreadyRunning/);
  assert.equal(existsSync(path.join(home, "runner.json")), false, "no discovery published");
  assert.equal(JSON.parse(readFileSync(path.join(home, "runner.lock"), "utf8")).pid, process.pid);
  assert.ok(pidAlive(process.pid));
});
