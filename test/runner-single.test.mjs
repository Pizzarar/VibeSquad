// One runner per home: 8 separate processes call startOwned at once -> exactly 1 runner. Temp home only, never ~/.vibesquad.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDiscovery } from "../server/backend/runner-client.mjs";
import { acquireStartLock, acquireRunnerLock, releaseLock } from "../runner/lock.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const CHILD = path.join(import.meta.dirname, "setup", "ensure-child.mjs");
const SERVER = path.join(ROOT, "runner", "server.mjs");
const homes = [];
const mkHome = () => { const h = mkdtempSync(path.join(os.tmpdir(), "vs-single-")); homes.push(h); return h; };

const run = (file, args) => new Promise((resolve) => {
  execFile(process.execPath, [file, ...args], { timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});
const killPid = (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } };

after(async () => {
  for (const h of homes) {
    const pid = readDiscovery(h)?.pid;
    if (pid) killPid(pid);
    try { const lock = JSON.parse(readFileSync(path.join(h, "runner.lock"), "utf8")); killPid(lock.pid); } catch { /* none */ }
  }
  await new Promise((r) => setTimeout(r, 600));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

test("8 concurrent startOwned calls from separate processes end with exactly 1 runner", { timeout: 60000 }, async () => {
  const home = mkHome();
  const results = await Promise.all(Array.from({ length: 8 }, () => run(CHILD, [home])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const pids = new Set(results.map((r) => JSON.parse(r.stdout.trim().split("\n").pop()).pid));
  assert.equal(pids.size, 1, `all callers see one runner pid, got ${[...pids]}`);
  const [pid] = pids;
  assert.equal(JSON.parse(readFileSync(path.join(home, "runner.lock"), "utf8")).pid, pid);
  const before = readFileSync(path.join(home, "runner.json"), "utf8");
  assert.equal(JSON.parse(before).pid, pid);
  // Only one runner ever printed "listening"; a second ensure round must not restart it.
  const log = readFileSync(path.join(home, "runner.log"), "utf8");
  assert.equal(log.split("\n").filter((l) => l.includes('"listening"')).length, 1, log);
  await run(CHILD, [home]);
  assert.equal(readFileSync(path.join(home, "runner.json"), "utf8"), before, "runner.json unchanged");
  killPid(pid);
});

test("a second runner started on a live home exits 0 and leaves discovery untouched", { timeout: 30000 }, async () => {
  const home = mkHome();
  const first = await run(CHILD, [home]);
  const pid = JSON.parse(first.stdout.trim()).pid;
  const before = readFileSync(path.join(home, "runner.json"), "utf8");
  const second = await run(SERVER, ["--home", home]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /alreadyRunning/);
  assert.equal(readFileSync(path.join(home, "runner.json"), "utf8"), before);
  assert.equal(readDiscovery(home).pid, pid);
  killPid(pid);
});

test("stale runner.lock (dead pid) is taken over; stale starting.lock expires", async () => {
  const home = mkHome();
  writeFileSync(path.join(home, "runner.lock"), JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
  const r = await acquireRunnerLock(home, { isHealthy: async () => false });
  assert.equal(r.owned, true);
  releaseLock(r.file);
  assert.equal(existsSync(path.join(home, "runner.lock")), false);

  const start = path.join(home, "starting.lock");
  assert.equal(acquireStartLock(start), true);
  assert.equal(acquireStartLock(start), false, "fresh lock held by a live pid blocks");
  // Expire by backdating the file's mtime. (staleMs:-1 raced the fs clock: age = Date.now() - mtimeMs can be < -1 when mtime
  // is ahead of the JS clock by a tick, so the lock looked fresh and the takeover flaked under load.)
  const old = new Date(Date.now() - 60_000);
  utimesSync(start, old, old);
  assert.equal(acquireStartLock(start), true, "stale lock is taken over");
  assert.equal(acquireStartLock(start), false, "the new lock is fresh again");
});
