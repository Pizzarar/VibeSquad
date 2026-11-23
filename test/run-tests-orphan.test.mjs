// idea-577: an orphaned `npm test` (its launching shell killed, e.g. by TaskStop) must not hold the machine-wide suite slot.
// A wrapper parent launches scripts/run-tests.mjs against a temp VIBESQUAD_TEST_LOCK_DIR, the wrapper is killed alone (the
// runner survives it, as in the incident), and the runner must release the slot / leave the queue and take its test tree down.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishSlot, readLast, suitePaths, tryAcquireSlot } from "../scripts/suite-lock.mjs";
import { readLock } from "../runner/lock.mjs";
import { isLauncher, killTree, launchChain, startOrphanGuard, treePids } from "../scripts/orphan-guard.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TESTS = path.join(root, "scripts", "run-tests.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const BOUND_MS = 60000; // load-tolerant: the guard's first process listing can take several seconds on a busy Windows box

async function until(pred, what, ms = BOUND_MS) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(100);
  }
}

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-suite-orphan-"));
  const pids = new Set();
  t.after(async () => {
    for (const pid of pids) if (alive(pid)) killTree(pid);
    for (let i = 0; i < 20; i++) { // Windows: a just-killed process can hold the log open for a moment
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  });
  return { dir, pids, paths: suitePaths(dir) };
}

// The wrapper stands in for the shell: it launches run-tests.mjs with output to a log file, records the runner's pid, and idles.
// detached: on Windows libuv puts a node parent's children in a kill-on-close job, so killing a node wrapper would take the
// runner with it; a real shell (MSYS bash, pwsh) does not, which is how the runner survived TaskStop. ppid stays the wrapper.
const WRAPPER = `
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
const { RT, LOG, PIDFILE, ARGS, CWD } = process.env;
const fd = openSync(LOG, "a");
const c = spawn(process.execPath, [RT, ...JSON.parse(ARGS)], { cwd: CWD, stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
writeFileSync(PIDFILE, String(c.pid));
setInterval(() => {}, 1000);
`;

function launch({ dir, pids }, args) {
  const env = { ...process.env, RT: RUN_TESTS, LOG: path.join(dir, "run.log"), PIDFILE: path.join(dir, "runner.pid"), ARGS: JSON.stringify(args), CWD: root,
    VIBESQUAD_TEST_LOCK_DIR: dir, VIBESQUAD_HOME: dir, VS_TEST_ORPHAN_POLL_MS: "250" };
  for (const k of ["NODE_TEST_CONTEXT", "VS_AGENT_ID", "PASEO_AGENT_ID", "VS_TEST_ORPHAN_GUARD"]) delete env[k];
  const w = spawn(process.execPath, ["--input-type=module", "-e", WRAPPER], { env, stdio: "ignore" });
  pids.add(w.pid);
  return w;
}

async function runnerPid({ dir, pids }) {
  let pid = 0;
  await until(() => (pid = Number(readJson(path.join(dir, "runner.pid")))) > 0, "the runner pid");
  pids.add(pid);
  return pid;
}

const log = (dir) => (existsSync(path.join(dir, "run.log")) ? readFileSync(path.join(dir, "run.log"), "utf8") : "");

test("an orphaned slot holder kills its test tree, writes an orphaned last record and releases the slot", { timeout: 180000 }, async (t) => {
  const ctx = setup(t);
  const { dir, paths } = ctx;
  const held = path.join(dir, "held.json");
  const file = path.join(dir, "hold.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("holds the slot", async () => {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(held)}, JSON.stringify({ runner: process.ppid, file: process.pid, grandchild: c.pid }));
  await new Promise((r) => setTimeout(r, 600000));
});
`);
  const wrapper = launch(ctx, ["--queue", file]);
  const rt = await runnerPid(ctx);
  let tree = null;
  await until(() => (tree = readJson(held)), "the test file to start");
  for (const pid of Object.values(tree)) ctx.pids.add(pid);
  assert.equal(readLock(paths.lock)?.pid, rt, "the runner holds the slot");

  wrapper.kill("SIGKILL"); // the wrapper alone: the runner and its tree survive it, as after a TaskStop
  await until(() => !existsSync(paths.lock) && !alive(rt) && !alive(tree.runner) && !alive(tree.file) && !alive(tree.grandchild),
    "slot release and the runner + test tree to exit");

  const last = readLast(paths);
  assert.equal(last.pid, rt);
  assert.equal(last.orphaned, true);
  assert.match(String(last.orphanReason), /exited/);
  assert.ok(last.fail >= 1, "an orphaned run never reads as a pass");
  assert.match(log(dir), /shell that launched this run is gone/);
});

test("an orphaned queued waiter leaves the queue and exits; the holder's lock is untouched", { timeout: 180000 }, async (t) => {
  const ctx = setup(t);
  const { dir, paths } = ctx;
  const mine = tryAcquireSlot(paths, { pid: process.pid, agentId: "holder" }); // a live foreign holder the runner must wait behind
  assert.ok(mine);
  t.after(() => { try { finishSlot(paths, mine); } catch {} }); // after hooks run in order: the temp dir may already be gone
  const file = path.join(dir, "pass.test.mjs");
  writeFileSync(file, 'import test from "node:test";\ntest("ok", () => {});\n');
  const wrapper = launch(ctx, ["--queue", file]);
  const rt = await runnerPid(ctx);
  const ops = () => (existsSync(paths.queue) ? readFileSync(paths.queue, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  await until(() => ops().some((e) => e.op === "join" && e.pid === rt) && /queued: #1/.test(log(dir)), "the runner to join the queue");
  const id = ops().find((e) => e.op === "join" && e.pid === rt).id;

  wrapper.kill("SIGKILL");
  await until(() => !alive(rt), "the orphaned waiter to exit");
  assert.ok(ops().some((e) => e.op === "done" && e.id === id), "the waiter wrote its done line");
  assert.equal(readLock(paths.lock)?.pid, process.pid, "the holder's lock is untouched");
  assert.equal(readLock(paths.lock)?.startedAt, mine.startedAt);
  assert.match(log(dir), /leaving the suite queue/);
});

test("launchChain climbs through shells and npm to the first non-launcher; a dead or reused direct parent is an orphan", () => {
  const P = (pid, ppid, start, name, cmd = name) => ({ pid, ppid, start, name, cmd });
  const procs = [
    P(10, 1, 100, "claude.exe"),
    P(20, 10, 200, "bash.exe", "bash -c \"npm test -- --queue\""),
    P(30, 20, 300, "node.exe", "\"C:\\node\\node.exe\" \"C:\\node\\node_modules\\npm\\bin\\npm-cli.js\" test -- --queue"),
    P(40, 30, 400, "cmd.exe", "cmd.exe /d /s /c node scripts/run-tests.mjs --queue"),
    P(50, 40, 500, "node.exe", "node scripts/run-tests.mjs --queue"),
  ];
  assert.deepEqual(launchChain(procs, 50).chain.map((p) => p.pid), [40, 30, 20, 10]);
  assert.equal(isLauncher(procs[0]), false);
  assert.equal(isLauncher(P(1, 0, 0, "", "/usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js test")), true);
  assert.equal(isLauncher(P(1, 0, 0, "", "-bash")), true);
  assert.equal(isLauncher(P(1, 0, 0, "node.exe", "node test/x.test.mjs")), false);
  // a plain node parent (a test, a wrapper) is the whole chain
  assert.deepEqual(launchChain([P(5, 1, 1, "node.exe", "node wrapper.mjs"), P(6, 5, 2, "node.exe")], 6).chain.map((p) => p.pid), [5]);
  // the direct parent is gone, or its pid now names a process born after us
  assert.match(launchChain(procs.filter((p) => p.pid !== 40), 50).orphan, /parent pid 40 exited/);
  assert.match(launchChain(procs.map((p) => (p.pid === 40 ? { ...p, start: 900 } : p)), 50).orphan, /pid reused/);
  // an upper ancestor reused before we started ends the chain there instead
  assert.deepEqual(launchChain(procs.map((p) => (p.pid === 20 ? { ...p, start: 900 } : p)), 50).chain.map((p) => p.pid), [40, 30]);
  // no parent to watch (init / container pid 1): no guard
  assert.equal(launchChain([P(7, 1, 1, "node")], 7).chain, null);
});

test("treePids follows children born after their parent only; startOrphanGuard fires once on a dead or reused launcher", async () => {
  const procs = [{ pid: 1, ppid: 0, start: 10 }, { pid: 2, ppid: 1, start: 20 }, { pid: 3, ppid: 2, start: 30 }, { pid: 4, ppid: 1, start: 5 }];
  assert.deepEqual(treePids(procs, 1), [1, 2, 3]);

  const chain = [{ pid: 100, ppid: 200, start: 1, name: "bash.exe" }, { pid: 200, ppid: 0, start: 0, name: "claude.exe" }, { pid: 300, ppid: 100, start: 2, name: "node.exe" }];
  let dead = new Set();
  const reasons = [];
  const g = startOrphanGuard({ onOrphan: (r) => reasons.push(r), pollMs: 1e9, list: async () => chain, alive: (pid) => !dead.has(pid), selfPid: 300, platform: "win32" });
  await g.ready;
  g.tick();
  assert.deepEqual(reasons, []);
  dead = new Set([200]);
  g.tick();
  g.tick();
  assert.deepEqual(reasons, ["claude pid 200 exited"]);

  const reused = [];
  let listing = chain;
  const g2 = startOrphanGuard({ onOrphan: (r) => reused.push(r), pollMs: 1e9, verifyMs: 0, list: async () => listing, alive: () => true, selfPid: 300, platform: "win32" });
  await g2.ready;
  listing = chain.map((p) => (p.pid === 100 ? { ...p, start: 99 } : p));
  g2.tick();
  await until(() => reused.length > 0, "the reuse verify", 5000);
  assert.deepEqual(reused, ["bash pid 100 exited (pid reused)"]);
  g2.stop();
});
