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
import { RUNNER_BOOT_MAX_MS, acquireRunnerLock, holdsLock, pidAlive } from "../runner/lock.mjs";
import { Runner } from "../runner/runner.mjs";

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
  writeFileSync(file, JSON.stringify({ pid: 4242, startedAt: Date.now() - 60_000 }));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242, startedAt: Date.now() - 50_000 }));
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

test("recoverQueued: shouldAdmit=false folds but admits nothing", () => {
  const home = mkHome();
  const dir = path.join(home, "agents");
  mkdirSync(dir, { recursive: true });
  const r = new Runner({ dir, adapters: {} });
  let asked = 0;
  try {
    assert.deepEqual(r.recoverQueued({ shouldAdmit: () => { asked += 1; return false; } }), []);
    assert.equal(asked, 1);
    assert.equal(r.queue.length, 0);
  } finally {
    r.shutdown();
  }
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
