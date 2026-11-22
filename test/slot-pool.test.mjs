// idea-267: named machine-wide slot pools (`vs slot run --pool godot -- <cmd>`, cli/slot-pool.mjs). At most N runs at once,
// FIFO waiters, dead and silent holders reclaimed, the child's exit code passed through, an interrupted waiter leaves no
// queue entry. Every test uses its own VIBESQUAD_TEST_LOCK_DIR, never the real slots.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { poolHolders, poolMax, poolPaths, releasePoolSlot, tryAcquirePoolSlot, validatePool, waitForPoolSlot } from "../cli/slot-pool.mjs";
import { readQueue } from "../cli/fifo-queue.mjs";
import { parseSlotArgs } from "../cli/vs.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VS = path.join(root, "cli", "vs.mjs");
const SLOT_POOL = pathToFileURL(path.join(root, "cli", "slot-pool.mjs")).href;
const DEAD_PID = 2147483646;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-slot-pool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "NODE_TEST_CONTEXT", "VS_SLOT_MAX_GODOT"]) delete env[k];
  return env;
}

// The wrapped command: logs "enter NAME" / "exit NAME" to <DIR>/log around a HOLD ms sleep (forever when HOLD=forever).
const CHILD = `
const { appendFileSync } = require("node:fs");
const log = (s) => appendFileSync(process.env.DIR + "/log", s + "\\n");
log("enter " + process.env.NAME + " " + process.env.VS_SLOT_INDEX);
if (process.env.HOLD === "forever") setTimeout(() => process.exit(0), 15000); // outlives a killed parent, then goes
else setTimeout(() => { log("exit " + process.env.NAME); process.exit(Number(process.env.CODE || 0)); }, Number(process.env.HOLD));
`;

// A `vs slot run` stand-in that loads only the pool module (vs.mjs loads the whole CLI: ~3s per start on Windows) and
// polls fast. GATE=<file>: print "ready" and start only once the file exists. SIGNAL_AFTER_JOIN=1 fires its own SIGINT handler once it waits (Ctrl+C; Windows can't deliver one to a child).
const RUNNER = `
import { runInSlot } from ${JSON.stringify(SLOT_POOL)};
import { existsSync } from "node:fs";
const { POOL, MAX, TIMEOUT, SIGNAL_AFTER_JOIN, GATE } = process.env;
if (GATE) { console.log("ready"); while (!existsSync(GATE)) await new Promise((r) => setTimeout(r, 10)); }
const stderr = { write: (s) => { process.stderr.write(s); if (SIGNAL_AFTER_JOIN && s.includes("waiting for")) process.emit("SIGINT"); return true; } };
const code = await runInSlot({ pool: POOL, max: Number(MAX), timeoutSec: Number(TIMEOUT || 0), cmd: process.execPath, args: ["-e", ${JSON.stringify(CHILD)}], stderr, pollMs: 20, noticeMs: 200 });
process.exit(code);
`;

function runner(dir, name, { pool = "godot", max = 3, hold = 300, code = 0, timeout = 0, env = {} } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", RUNNER], {
    env: cleanEnv({ DIR: dir, VIBESQUAD_TEST_LOCK_DIR: dir, POOL: pool, MAX: String(max), HOLD: String(hold), NAME: name, CODE: String(code), TIMEOUT: String(timeout), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.exited = new Promise((r) => child.on("exit", (c) => r(c)));
  return child;
}

async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const logLines = (dir) => (existsSync(path.join(dir, "log")) ? readFileSync(path.join(dir, "log"), "utf8").trim().split("\n").filter(Boolean) : []);
const entered = (dir) => logLines(dir).filter((l) => l.startsWith("enter ")).map((l) => l.split(" ")[1]);

function maxOverlap(lines) {
  let cur = 0;
  let max = 0;
  for (const l of lines) {
    if (l.startsWith("enter ")) max = Math.max(max, ++cur);
    else if (l.startsWith("exit ")) cur--;
  }
  return max;
}

const slotFiles = (dir) => readdirSync(dir).filter((f) => f.startsWith("vibesquad-slot-"));

test("pool name, max resolution and vs slot argv parsing", () => {
  assert.equal(validatePool("Godot"), "godot");
  assert.throws(() => validatePool("../x"), /bad pool name/);
  assert.equal(poolMax("godot", { env: {} }), 3);
  assert.equal(poolMax("godot", { env: { VS_SLOT_MAX_GODOT: "2" } }), 2);
  assert.equal(poolMax("godot", { flag: "5", env: { VS_SLOT_MAX_GODOT: "2" } }), 5);
  assert.equal(poolMax("unity-ci", { env: { VS_SLOT_MAX_UNITY_CI: "4" } }), 4);
  assert.equal(poolMax("other", { env: {} }), 1);
  assert.throws(() => poolMax("godot", { flag: "0" }), /--max must be/);
  assert.deepEqual(parseSlotArgs(["run", "--pool", "godot", "--max=2", "--timeout", "60", "--", "godot", "--headless", "--help"]), {
    sub: "run", pool: "godot", max: "2", timeout: "60", json: false, cmd: "godot", args: ["--headless", "--help"],
  });
  assert.equal(parseSlotArgs(["run", "--pool", "godot", "bash", "-c", "x"]).cmd, "bash", "no -- : the command starts at the first non-option");
  assert.throws(() => parseSlotArgs(["run", "--pool", "godot", "--headless"]), /unknown option "--headless"/);
  assert.throws(() => parseSlotArgs(["run", "--", "godot"]), /usage: vs slot run/);
  assert.throws(() => parseSlotArgs(["go"]), /usage: vs slot run/);
  assert.equal(parseSlotArgs(["status"]).pool, "godot");
});

test("4 runs on a 3-slot pool: never more than 3 at once, all 4 finish, slots and queue cleaned up", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const gate = path.join(dir, "go");
  const runs = ["a", "b", "c", "d"].map((n) => runner(dir, n, { hold: 1500, env: { GATE: gate } }));
  t.after(() => runs.forEach((r) => r.kill()));
  await until(() => runs.every((r) => r.out.includes("ready")), "all 4 runners started"); // so all 4 contend at once
  writeFileSync(gate, "");
  const codes = await Promise.all(runs.map((r) => r.exited));
  assert.deepEqual(codes, [0, 0, 0, 0], runs.map((r) => r.out).join("\n"));
  const lines = logLines(dir);
  assert.equal(entered(dir).length, 4, lines.join("\n"));
  assert.equal(maxOverlap(lines), 3, `3 slots, 4 runs: exactly 3 overlapped\n${lines.join("\n")}`);
  assert.ok(runs.some((r) => /waiting for godot slot \(0 ahead; 3\/3 busy/.test(r.out)), "the 4th printed its wait line");
  assert.deepEqual(slotFiles(dir), [], "no lock or queue left behind");
});

test("waiters are served FIFO", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = poolPaths("solo", dir);
  const held = tryAcquirePoolSlot(paths, { max: 1 });
  assert.ok(held);
  const waiters = [];
  t.after(() => waiters.forEach((w) => w.kill()));
  for (const name of ["w1", "w2", "w3"]) {
    const w = runner(dir, name, { pool: "solo", max: 1, hold: 100 });
    waiters.push(w);
    await until(() => readQueue(paths).live.length === waiters.length, `${name} queued`);
  }
  await until(() => waiters[2].out.includes("(2 ahead"), "w3 sees 2 ahead");
  releasePoolSlot(held);
  assert.deepEqual(await Promise.all(waiters.map((w) => w.exited)), [0, 0, 0]);
  assert.deepEqual(entered(dir), ["w1", "w2", "w3"]);
  assert.equal(maxOverlap(logLines(dir)), 1);
});

test("a dead holder's slot is reclaimed at once; a holder killed mid-run frees its slot", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = poolPaths("godot", dir);
  for (let i = 0; i < 3; i++) writeFileSync(paths.slot(i), JSON.stringify({ pid: DEAD_PID, startedAt: Date.now(), pool: "godot", index: i }));
  const r = runner(dir, "after-dead", { hold: 50 });
  t.after(() => r.kill());
  assert.equal(await r.exited, 0, r.out);
  assert.match(r.out, /reclaimed godot slot 0 from dead holder pid 2147483646/);

  // A live holder (forever child) whose own process is killed: its slot frees by pid-dead reclaim.
  rmSync(path.join(dir, "log"), { force: true });
  for (let i = 1; i < 3; i++) rmSync(paths.slot(i), { force: true });
  const fills = [1, 2].map((i) => tryAcquirePoolSlot(paths, { max: 3 }));
  assert.ok(fills.every(Boolean));
  const holder = runner(dir, "holder", { hold: "forever" });
  t.after(() => holder.kill());
  await until(() => entered(dir).includes("holder"), "holder running");
  const waiter = runner(dir, "waiter", { hold: 50 });
  t.after(() => waiter.kill());
  await until(() => waiter.out.includes("waiting for godot slot"), "waiter blocked");
  holder.kill(); // the vs process dies; its (forever) child keeps running, the slot must not
  assert.equal(await waiter.exited, 0, waiter.out);
  assert.match(waiter.out, new RegExp(`reclaimed godot slot [0-2] from dead holder pid ${holder.pid}(?!\\d)`));
  fills.forEach(releasePoolSlot);
});

test("a live-pid holder that stopped beating (pid reused) is reclaimed only after the waiter was awake holdStaleMs", { timeout: 30000 }, async (t) => {
  const dir = tmp(t);
  const paths = poolPaths("solo", dir);
  // A lock naming a live pid (ours) whose beat is 10 minutes old: the pid was reused by an unrelated process.
  writeFileSync(paths.slot(0), JSON.stringify({ pid: process.pid, startedAt: 1, pool: "solo", index: 0 }));
  const old = new Date(Date.now() - 600_000);
  utimesSync(paths.slot(0), old, old);
  assert.equal(poolHolders(paths, { judgeBeat: true })[0].fresh, false);
  assert.equal(poolHolders(paths, { judgeBeat: false })[0].fresh, true);
  const t0 = Date.now();
  const stolen = [];
  const slot = await waitForPoolSlot(paths, { max: 1, pollMs: 20, holdStaleMs: 400, onSteal: (o) => stolen.push(o) });
  const waited = Date.now() - t0;
  assert.ok(waited >= 380, `stole after ${waited}ms, before the waiter had been awake holdStaleMs`);
  assert.equal(stolen[0]?.reason, "stale");
  assert.equal(slot.index, 0);
  releasePoolSlot(slot);

  // A holder that keeps beating is never taken, however long it runs.
  const live = tryAcquirePoolSlot(paths, { max: 1 });
  const beat = setInterval(() => utimesSync(live.file, new Date(), new Date()), 50);
  t.after(() => clearInterval(beat));
  const none = await waitForPoolSlot(paths, { max: 1, pollMs: 20, holdStaleMs: 200, timeoutMs: 800 });
  assert.equal(none, null, "timed out instead of stealing a beating holder");
  assert.equal(readQueue(paths).known.size, 0, "the timed-out waiter left the line");
  releasePoolSlot(live);
});

test("exit code passthrough, timeout 124 and an interrupted waiter leaving no queue entry", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = poolPaths("solo", dir);
  const seven = runner(dir, "seven", { pool: "solo", max: 1, hold: 10, code: 7 });
  assert.equal(await seven.exited, 7, seven.out);

  const held = tryAcquirePoolSlot(paths, { max: 1 });
  const late = runner(dir, "late", { pool: "solo", max: 1, timeout: 1 });
  assert.equal(await late.exited, 124, late.out);
  assert.match(late.out, /no solo slot within 1s/);
  assert.equal(readQueue(paths).known.size, 0, "the timed-out waiter wrote its done line");

  const intr = runner(dir, "intr", { pool: "solo", max: 1, env: { SIGNAL_AFTER_JOIN: "1" } });
  assert.equal(await intr.exited, 130, intr.out);
  assert.equal(readQueue(paths).known.size, 0, "the interrupted waiter wrote its done line");
  assert.ok(!entered(dir).includes("intr") && !entered(dir).includes("late"));
  releasePoolSlot(held);
});

test("vs slot run (the real CLI) passes the exit code and the wrapped command's own flags through", { timeout: 60000 }, (t) => {
  const dir = tmp(t);
  const env = cleanEnv({ VIBESQUAD_TEST_LOCK_DIR: dir });
  const r = spawnSync(process.execPath, [VS, "slot", "run", "--pool", "godot", "--", process.execPath, "-e", "console.log(process.argv.slice(1).join(','), process.env.VS_SLOT_POOL); process.exit(5)", "--", "--help", "x"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /--help,x godot/);
  const missing = spawnSync(process.execPath, [VS, "slot", "run", "--pool", "godot", "--", "vs-no-such-cmd-267"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(missing.status, 127, missing.stdout + missing.stderr);
  const help = spawnSync(process.execPath, [VS, "--help"], { env, encoding: "utf8", timeout: 30000 });
  assert.match(help.stdout, /vs slot run --pool <name>/);
  assert.deepEqual(slotFiles(dir), []);
});
