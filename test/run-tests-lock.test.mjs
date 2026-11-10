// The `npm test` slot (scripts/run-tests.mjs + scripts/suite-lock.mjs + runner/lock.mjs acquireStartLock): mutual
// exclusion under racing acquirers and stealers, FIFO --queue, died records for crashed holders, crashed waiters skipped,
// and a normal run leaving no lock/queue behind. Every test uses its own VIBESQUAD_TEST_LOCK_DIR, never the real slot.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callerAgentId, finishSlot, readLast, readQueue, suitePaths, tryAcquireSlot, waitForSlot } from "../scripts/suite-lock.mjs";
import { acquireStartLock, readLock } from "../runner/lock.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_LOCK = pathToFileURL(path.join(root, "scripts", "suite-lock.mjs")).href;
const DEAD_PID = 2147483646;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-suite-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("VS_AGENT_ID" in extra)) delete env.VS_AGENT_ID;
  delete env.PASEO_AGENT_ID;
  delete env.NODE_TEST_CONTEXT; // set by our own runner; a nested node --test would skip its files
  return env;
}

// A child that takes the slot (mode try | spin | queue), records enter/exit in <dir>/log, and holds it for HOLD ms
// (or until killed when HOLD=forever). A second holder inside the critical section logs OVERLAP.
const WORKER = `
import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { finishSlot, suitePaths, tryAcquireSlot, waitForSlot } from ${JSON.stringify(SUITE_LOCK)};
const { DIR, MODE, HOLD, NAME } = process.env;
const paths = suitePaths(DIR);
const log = (s) => appendFileSync(path.join(DIR, "log"), s + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let slot;
if (MODE === "queue") slot = await waitForSlot(paths, { pollMs: 20, onWait: (w) => console.log("wait " + w.position) });
else if (MODE === "spin") while (!(slot = tryAcquireSlot(paths))) await sleep(Math.random() * 5);
else if (!(slot = tryAcquireSlot(paths))) { console.log("refused"); process.exit(3); }
const occupied = path.join(DIR, "occupied");
try { closeSync(openSync(occupied, "wx")); } catch { log("OVERLAP " + NAME); }
log("enter " + NAME);
console.log("acquired " + slot.startedAt);
if (HOLD === "forever") setInterval(() => {}, 1000);
else {
  await sleep(Number(HOLD));
  rmSync(occupied, { force: true });
  log("exit " + NAME);
  finishSlot(paths, slot, { tests: 1, pass: 1, fail: 0, failingFiles: [] });
}
`;

function worker(dir, mode, { hold = 30, name = mode, env = {} } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER], {
    env: cleanEnv({ DIR: dir, MODE: mode, HOLD: String(hold), NAME: name, ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return child;
}

async function until(pred, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const logLines = (dir) => (existsSync(path.join(dir, "log")) ? readFileSync(path.join(dir, "log"), "utf8").trim().split("\n") : []);

test("callerAgentId reads VS_AGENT_ID, then PASEO_AGENT_ID, else null", () => {
  assert.equal(callerAgentId({ VS_AGENT_ID: "a1", PASEO_AGENT_ID: "p1" }), "a1");
  assert.equal(callerAgentId({ PASEO_AGENT_ID: "p1" }), "p1");
  assert.equal(callerAgentId({}), null);
  assert.equal(callerAgentId({ VS_AGENT_ID: "  " }), null);
});

test("lock body is {pid, agentId, startedAt, full, files}; a live holder refuses a second acquirer; finish records and releases", (t) => {
  const paths = suitePaths(tmp(t));
  const slot = tryAcquireSlot(paths, { agentId: "agent-a", full: true, files: [] });
  assert.ok(slot);
  const body = readLock(paths.lock);
  assert.equal(body.pid, process.pid);
  assert.equal(body.agentId, "agent-a");
  assert.equal(body.startedAt, slot.startedAt);
  assert.equal(body.full, true);
  assert.deepEqual(body.files, []);
  assert.equal(tryAcquireSlot(paths, { agentId: "agent-b" }), null, "fresh live lock blocks");
  finishSlot(paths, slot, { tests: 4, pass: 3, fail: 1, failingFiles: ["test/x.test.mjs"] });
  assert.equal(existsSync(paths.lock), false);
  const last = readLast(paths);
  assert.deepEqual(
    { ...last, finishedAt: typeof last.finishedAt },
    { agentId: "agent-a", pid: process.pid, startedAt: slot.startedAt, finishedAt: "number", full: true, files: [], tests: 4, pass: 3, fail: 1, failingFiles: ["test/x.test.mjs"] },
  );
  assert.deepEqual(readdirSync(paths.dir).sort(), ["vibesquad-npm-test-last.json"], "no tmp or guard files left behind");
});

test("racing stealers of a dead holder never both hold the lock (steal guard)", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  writeFileSync(paths.lock, JSON.stringify({ pid: DEAD_PID, agentId: "ghost", startedAt: 1 }));
  const kids = Array.from({ length: 8 }, (_, i) => worker(dir, "spin", { name: `s${i}`, hold: 25 }));
  const codes = await Promise.all(kids.map((k) => k.exited));
  assert.deepEqual(codes, kids.map(() => 0), kids.map((k) => k.out).join("\n"));
  const lines = logLines(dir);
  assert.deepEqual(lines.filter((l) => l.startsWith("OVERLAP")), []);
  assert.equal(lines.filter((l) => l.startsWith("enter")).length, 8);
  // enter/exit strictly alternate: nobody entered while another was inside
  lines.forEach((l, i) => assert.equal(l.split(" ")[0], i % 2 ? "exit" : "enter", lines.join("\n")));
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(`${paths.lock}.steal`), false);
});

test("steal guard: a stealer that judged the dead holder before another stealer won does not delete the winner's lock", (t) => {
  // Deterministic interleaving of the race above: B reads the dead holder, then (inside B's liveness check) A steals it and
  // creates its own lock. An unguarded check-then-rm would now delete A's live lock and let B in too.
  const file = path.join(tmp(t), "x.lock");
  writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
  const A = 111, B = 222;
  let raced = false;
  const alive = (pid) => {
    if (pid === DEAD_PID && !raced) {
      raced = true;
      assert.equal(acquireStartLock(file, { pid: A, alive: (p) => p === A }), true, "A steals first");
    }
    return pid === A;
  };
  assert.equal(acquireStartLock(file, { pid: B, alive }), false, "B must not also hold the lock");
  assert.equal(readLock(file).pid, A);
  assert.equal(existsSync(`${file}.steal`), false);
});

test("steal guard: a fresh guard blocks the steal; an orphaned one is cleared", (t) => {
  const file = path.join(tmp(t), "x.lock");
  writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
  writeFileSync(`${file}.steal`, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
  assert.equal(acquireStartLock(file), false, "another stealer is mid-steal");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.steal`, old, old);
  assert.equal(acquireStartLock(file), true, "orphaned guard cleared, dead holder stolen");
  assert.equal(readLock(file).pid, process.pid);
  assert.equal(existsSync(`${file}.steal`), false);
});

test("steal guard: clearing an orphaned guard and stealing happen in one attempt, even when attempts are tight", (t) => {
  // Before: the orphan removal returned early and used up an attempt, so orphan + any transient miss exhausted all 3.
  const file = path.join(tmp(t), "x.lock");
  writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
  writeFileSync(`${file}.steal`, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.steal`, old, old);
  let judged = 0;
  assert.equal(acquireStartLock(file, { alive: (p) => (judged++, p === process.pid) }), true);
  assert.equal(readLock(file).pid, process.pid);
  assert.equal(existsSync(`${file}.steal`), false);
  // One liveness judgment of the holder (no onSteal, so no reason check). The early-return version needed a second round.
  assert.equal(judged, 1, `orphan cleared and holder stolen in the first attempt (judged=${judged})`);
});

test("concurrent --queue waiters are served one at a time and leave no lock or queue file", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  const kids = Array.from({ length: 6 }, (_, i) => worker(dir, "queue", { name: `q${i}`, hold: 25 }));
  const codes = await Promise.all(kids.map((k) => k.exited));
  assert.deepEqual(codes, kids.map(() => 0), kids.map((k) => k.out).join("\n"));
  const lines = logLines(dir);
  assert.deepEqual(lines.filter((l) => l.startsWith("OVERLAP")), []);
  assert.equal(lines.filter((l) => l.startsWith("enter")).length, 6);
  lines.forEach((l, i) => assert.equal(l.split(" ")[0], i % 2 ? "exit" : "enter", lines.join("\n")));
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.queue), false, "the last claimer compacts the queue");
});

test("--queue is FIFO: waiters get the slot in arrival order", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  assert.ok(held);
  const kids = [];
  for (const [i, name] of ["first", "second", "third"].entries()) {
    const k = worker(dir, "queue", { name, hold: 20 });
    kids.push(k);
    await until(() => k.out.includes(`wait ${i + 1}`), `${name} at #${i + 1}`);
  }
  finishSlot(paths, held);
  await Promise.all(kids.map((k) => k.exited));
  assert.deepEqual(logLines(dir).filter((l) => l.startsWith("enter")), ["enter first", "enter second", "enter third"]);
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.queue), false);
});

test("a crashed holder is stolen and gets a died record", { timeout: 30000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  const k = worker(dir, "try", { hold: "forever", env: { VS_AGENT_ID: "agent-crash" } });
  await until(() => k.out.includes("acquired"), "holder acquired");
  const startedAt = Number(/acquired (\d+)/.exec(k.out)[1]);
  assert.equal(tryAcquireSlot(paths), null, "live holder blocks");
  k.kill("SIGKILL");
  await k.exited;
  const slot = tryAcquireSlot(paths, { agentId: "agent-next" });
  assert.ok(slot, "dead holder's lock taken over");
  assert.deepEqual(readLast(paths), { agentId: "agent-crash", pid: k.pid, startedAt, full: false, files: [], died: true });
  assert.equal(readLock(paths.lock).agentId, "agent-next");
  finishSlot(paths, slot, { tests: 1, pass: 1, fail: 0 });
  assert.equal(readLast(paths).agentId, "agent-next");
  assert.equal(readLast(paths).died, undefined);
});

test("a holder that wrote its own result before dying gets no died record", (t) => {
  const paths = suitePaths(tmp(t));
  const result = { agentId: "agent-x", pid: DEAD_PID, startedAt: 5, finishedAt: 9, tests: 3, pass: 3, fail: 0, failingFiles: [] };
  writeFileSync(paths.lock, JSON.stringify({ pid: DEAD_PID, agentId: "agent-x", startedAt: 5 }));
  writeFileSync(paths.last, JSON.stringify(result));
  const slot = tryAcquireSlot(paths);
  assert.ok(slot);
  assert.deepEqual(readLast(paths), result);
  finishSlot(paths, slot);
});

test("a live holder past the 2h stale age is taken over with a died record (reason stale)", (t) => {
  const paths = suitePaths(tmp(t));
  writeFileSync(paths.lock, JSON.stringify({ pid: DEAD_PID, agentId: "agent-stuck", startedAt: 7, full: true, files: [] }));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(paths.lock, old, old);
  const slot = tryAcquireSlot(paths, { alive: () => true });
  assert.ok(slot);
  assert.deepEqual(readLast(paths), { agentId: "agent-stuck", pid: DEAD_PID, startedAt: 7, full: true, files: [], died: true, reason: "stale" }, "a died full run stays marked full");
  finishSlot(paths, slot);
});

test("a crashed queued waiter does not block the waiters behind it", { timeout: 30000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  const a = worker(dir, "queue", { name: "a" });
  await until(() => a.out.includes("wait 1"), "a at #1");
  const b = worker(dir, "queue", { name: "b" });
  await until(() => b.out.includes("wait 2"), "b at #2");
  a.kill("SIGKILL");
  await a.exited;
  await until(() => b.out.includes("wait 1"), "b moves up to #1 past the dead waiter");
  finishSlot(paths, held);
  assert.equal(await b.exited, 0, b.out);
  assert.deepEqual(logLines(dir).filter((l) => l.startsWith("enter")), ["enter b"]);
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.queue), false);
});

test("readQueue folds join/beat/done and skips dead pids and silent waiters", (t) => {
  const paths = suitePaths(tmp(t));
  const now = 1_000_000;
  const lines = [
    { op: "join", id: "dead", pid: DEAD_PID, at: now },
    { op: "join", id: "silent", pid: process.pid, at: now - 200_000 },
    { op: "join", id: "beaten", pid: process.pid, at: now - 200_000 },
    { op: "beat", id: "beaten", at: now - 1000 },
    { op: "join", id: "gone", pid: process.pid, at: now },
    { op: "done", id: "gone" },
    { op: "join", id: "fresh", pid: process.pid, agentId: "ag", at: now },
  ];
  writeFileSync(paths.queue, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
  const q = readQueue(paths, { now, beatStaleMs: 120_000 });
  assert.deepEqual(q.live.map((e) => e.id), ["beaten", "fresh"]);
  assert.deepEqual([...q.known].sort(), ["beaten", "dead", "fresh", "silent"]);
});

test("a waiter whose queue line was compacted away re-joins and still gets the slot", { timeout: 30000 }, async (t) => {
  const paths = suitePaths(tmp(t));
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  let waits = 0;
  const waiting = waitForSlot(paths, { agentId: "w", pollMs: 20, onWait: () => waits++ });
  await until(() => waits > 0, "waiter queued");
  rmSync(paths.queue, { force: true });
  await until(() => readQueue(paths).live.length === 1, "waiter re-joined");
  finishSlot(paths, held);
  const slot = await waiting;
  assert.equal(readLock(paths.lock).agentId, "w");
  finishSlot(paths, slot);
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.queue), false);
});

function suiteFiles(dir) {
  const pass = path.join(dir, "pass.test.mjs");
  const fail = path.join(dir, "fail.test.mjs");
  writeFileSync(pass, 'import test from "node:test";\ntest("ok case", () => {});\n');
  writeFileSync(fail, 'import test from "node:test";\ntest("bad case", () => { throw new Error("boom"); });\n');
  return { pass, fail };
}

const RUN_TESTS = path.join(root, "scripts", "run-tests.mjs");

test("run-tests.mjs: a normal run keeps the spec output, writes the last record, and leaves no lock", { timeout: 60000 }, (t) => {
  const dir = tmp(t);
  const { pass, fail } = suiteFiles(dir);
  const r = spawnSync(process.execPath, [RUN_TESTS, pass, fail], { cwd: root, env: cleanEnv({ VIBESQUAD_TEST_LOCK_DIR: dir, VS_AGENT_ID: "agent-e2e" }), encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✔ ok case/);
  assert.match(r.stdout, /✖ bad case/);
  assert.match(r.stdout, /ℹ tests 2/);
  assert.doesNotMatch(r.stdout, /failingFiles/, "the summary reporter prints nothing");
  const last = JSON.parse(readFileSync(path.join(dir, "vibesquad-npm-test-last.json"), "utf8"));
  assert.equal(last.agentId, "agent-e2e");
  assert.equal(last.pid, r.pid);
  assert.ok(last.startedAt <= last.finishedAt);
  assert.deepEqual([last.tests, last.pass, last.fail], [2, 1, 1]);
  assert.deepEqual(last.failingFiles, [path.relative(root, fail).split(path.sep).join("/")]);
  assert.equal(last.full, false, "file args = a partial run");
  assert.deepEqual(last.files, [pass, fail]);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("vibesquad-")), ["vibesquad-npm-test-last.json"], "no lock, queue or summary left");
});

test("run-tests.mjs: a non-zero exit with no counted failure records fail >= 1, never a silent pass", { timeout: 60000 }, (t) => {
  const dir = tmp(t);
  const missing = path.join(dir, "missing.test.mjs");
  const r = spawnSync(process.execPath, [RUN_TESTS, missing], { cwd: root, env: cleanEnv({ VIBESQUAD_TEST_LOCK_DIR: dir }), encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const last = JSON.parse(readFileSync(path.join(dir, "vibesquad-npm-test-last.json"), "utf8"));
  assert.ok(last.fail >= 1, JSON.stringify(last));
  assert.equal(last.exitCode, 1);
  assert.equal(last.incomplete, true);
  assert.equal(existsSync(path.join(dir, "vibesquad-npm-test.lock")), false);
});

test("run-tests.mjs: without --queue a held slot still exits 1; with --queue it waits and then runs", { timeout: 60000 }, async (t) => {
  const dir = tmp(t);
  const paths = suitePaths(dir);
  const { pass } = suiteFiles(dir);
  const env = cleanEnv({ VIBESQUAD_TEST_LOCK_DIR: dir });
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  const refused = spawnSync(process.execPath, [RUN_TESTS, pass], { cwd: root, env, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /npm test refused: another suite is running \(pid \d+, agent holder/);
  assert.equal(readLock(paths.lock).agentId, "holder");

  const q = spawn(process.execPath, [RUN_TESTS, "--queue", pass], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  q.stdout.on("data", (d) => (out += d));
  q.stderr.on("data", (d) => (out += d));
  const code = new Promise((r) => q.on("exit", r));
  await until(() => out.includes("npm test queued: #1 of 1"), "queued position printed");
  finishSlot(paths, held);
  assert.equal(await code, 0, out);
  assert.match(out, /ℹ pass 1/);
  const last = readLast(paths);
  assert.deepEqual([last.agentId, last.tests, last.pass, last.fail, last.failingFiles, last.full, last.files], [null, 1, 1, 0, [], false, [pass]], "--queue is not a file arg");
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.queue), false);
});
