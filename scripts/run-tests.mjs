// `npm test` entry: only one suite may run at a time machine-wide (parallel suites each spawn runners/MCP servers and flood the box).
// Holds <tmpdir>/vibesquad-npm-test.lock {pid, agentId, startedAt, full, files} for the run; a dead owner or a lock older than 2h is stale
// and taken over (the dead run gets a {died:true} record). On exit it writes <tmpdir>/vibesquad-npm-test-last.json with the
// counts and failing files. Files and fields: scripts/suite-lock.mjs.
//   npm test                     refuse (exit 1) if another suite holds the slot
//   npm test -- --queue [files]  wait FIFO for the slot instead, printing the queue position
// While a `vs restart` waits on a coordinated drain (idea-197, the D2 window in server/restart-coord.mjs) a full run is
// refused, and a queued full run leaves the queue; targeted runs (file args) still go. Owner override, logged:
//   npm test -- --ignore-drain   (or VIBESQUAD_IGNORE_DRAIN=1), the owner's shell only
// Other args are forwarded as test files (default: test/*.test.mjs).
// idea-577: if the shell that launched this run dies (TaskStop kills the shell only), the run is orphaned but its pid stays live,
// so nothing would ever take the slot over. scripts/orphan-guard.mjs notices; a queued run leaves the queue, a holder kills its
// test process tree and writes a last record with orphaned:true, then exits 1. Off with VS_TEST_ORPHAN_GUARD=0.
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDrainGuard, DRAIN_OVERRIDE_FLAG, drainOverrideRequested } from "../server/restart-coord.mjs";
import { childEnv } from "./test-child-env.mjs";
import { startWatchdog, DEFAULT_FILE_IDLE_MS } from "./test-watchdog.mjs";
import { finishSlot, suitePaths, tryAcquireSlot, waitForSlot } from "./suite-lock.mjs";
import { killTree, startOrphanGuard } from "./orphan-guard.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = suitePaths();
const args = process.argv.slice(2);
const queue = args.includes("--queue");
const ignoreDrain = drainOverrideRequested(args);
const files = args.filter((a) => a !== "--queue" && a !== DRAIN_OVERRIDE_FLAG);
// Recorded in the lock and the last-run record: only a full run (no file args) can satisfy a watch set's suite item.
const run = { full: files.length === 0, files };
const who = (h) => `pid ${h?.pid}${h?.agentId ? `, agent ${h.agentId}` : ""}`;

// idea-197: a full suite started while a restart waits on a coordinated drain is the background work the asked leads were
// told to hold. Refuse it rather than wait: a queued waiter is itself held work the restart would wait on.
// The owner's --ignore-drain / VIBESQUAD_IGNORE_DRAIN=1 goes ahead and logs one restart-feedback line (checkDrainGuard).
const DRAIN_POLL_MS = 2000;
const vsHome = process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");
let drainOverridden = false;
function drainRefusal(action) {
  if (!run.full || drainOverridden) return null;
  const g = checkDrainGuard(action, { vsHome, override: ignoreDrain, hint: "Targeted runs (npm test -- <files>) still go." });
  if (!g.ok) return g.message;
  if (g.overridden) { drainOverridden = true; console.error(g.note); } // logged once per run
  return null;
}
const refusal = drainRefusal(queue ? "npm test -- --queue" : "npm test");
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

let slot = null;
let child = null;
let watchdog = null;
// idea-577: started before the queue wait so an orphaned waiter leaves the line too. Cheap: one listing at start, kill(0) on a
// few pids every few seconds, a filtered listing every 30s.
const orphanGuard = process.env.VS_TEST_ORPHAN_GUARD === "0" ? null : startOrphanGuard({ onOrphan: orphaned });
function orphaned(reason) {
  // The launcher's pipes may be gone with it: a write error must not throw before the slot is released.
  for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
  const say = (m) => { try { console.error(m); } catch {} };
  if (child && watchdog) {
    say(`npm test: the shell that launched this run is gone (${reason}); killing the test process tree and releasing the suite slot.`);
    const pids = killTree(child.pid, { rootStart: childSpawnedAt });
    say(`npm test: killed ${pids.length} process(es); exiting 1.`);
    finish(null, null, { orphaned: true, orphanReason: reason });
  } else {
    say(`npm test: the shell that launched this run is gone (${reason}); leaving the suite queue and exiting 1.`);
  }
  process.exit(1); // a queued waiter leaves the queue in its exit handler (slot is still null)
}
if (queue) {
  let leave = () => {};
  const quit = () => { leave(); process.exit(130); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", () => { if (!slot) leave(); });
  // A drain that starts while we wait: leave the queue (the exit handler above) instead of taking the slot after it.
  const drainTimer = setInterval(() => {
    const r = drainRefusal("npm test -- --queue (left the queue)");
    if (r) { console.error(r); process.exit(1); }
  }, DRAIN_POLL_MS);
  slot = await waitForSlot(paths, {
    ...run,
    onJoin: (t) => { leave = t.leave; },
    onWait: ({ position, waiting, holder }) =>
      console.error(`npm test queued: #${position} of ${waiting} waiting for the suite slot${holder ? ` (held by ${who(holder)})` : ""}.`),
  });
  clearInterval(drainTimer);
  process.off("SIGINT", quit);
  process.off("SIGTERM", quit);
} else {
  slot = tryAcquireSlot(paths, run);
  if (!slot) {
    let holder = null;
    try { holder = JSON.parse(readFileSync(paths.lock, "utf8")); } catch {}
    console.error(`npm test refused: another suite is running (${who(holder)}, lock ${paths.lock}). Only one suite at a time; ask the lead for the slot, or wait for it with npm test -- --queue.`);
    process.exit(1);
  }
}

// Pin the human reporter to spec: Node's default is spec on a TTY (and on every stream from Node 23) but tap on a non-TTY
// under Node 22, which made the output (and tests matching `ℹ pass N`) differ by Node version. The silent summary reporter
// writes the counts to a side file.
const reporter = "spec";
const summaryFile = path.join(paths.dir, `vibesquad-npm-test-summary-${process.pid}.json`);
const summaryReporter = pathToFileURL(path.join(root, "scripts", "test-summary-reporter.mjs")).href;
const progressFile = path.join(paths.dir, `vibesquad-npm-test-progress-${process.pid}.jsonl`);
const progressReporter = pathToFileURL(path.join(root, "scripts", "test-progress-reporter.mjs")).href;
const fileIdleMs = Number(process.env.VS_TEST_FILE_TIMEOUT_MS) || DEFAULT_FILE_IDLE_MS;
// idea-412: node --test defaults to availableParallelism()-1 files at once (19 on a 20-CPU box). Each file spawns servers, CLIs and
// browsers, so the full suite ran load-only timeouts (sec-s4 S4-5, identity-v2 #3, file-lock-async, verdict-gate) that pass solo.
// Measured on 150 files + those 4: concurrency 19 = identity-v2 #3 27.5s, file-lock M1 15.4s, total 113s; concurrency 8 = 12.4s, 7.8s, 97s.
// Cap at 8 (VS_TEST_CONCURRENCY overrides).
function testConcurrency(env = process.env, cpus = os.availableParallelism?.() ?? os.cpus().length) {
  const n = Math.floor(Number(env.VS_TEST_CONCURRENCY));
  return n >= 1 ? n : Math.max(1, Math.min(8, cpus - 1));
}
const childSpawnedAt = Date.now(); // lower bound for the child's start time (orphan killTree fallback)
child = spawn(
  process.execPath,
  [
    "--test",
    `--test-concurrency=${testConcurrency()}`,
    "--import", "./test/setup/hermetic.mjs",
    `--test-reporter=${reporter}`, "--test-reporter-destination=stdout",
    `--test-reporter=${summaryReporter}`, `--test-reporter-destination=${summaryFile}`,
    `--test-reporter=${progressReporter}`, `--test-reporter-destination=${progressFile}`,
    ...(files.length ? files : ["test/*.test.mjs"]),
  ],
  // The live runtime (VIBESQUAD_RUNTIME_DIR in agent shells) must never reach test children; hermetic.mjs then sets a temp one.
  { cwd: root, stdio: "inherit", env: childEnv(process.env) },
);

// idea-309: one wedged file must not hold the slot forever. A file with a test running and no test event for
// VS_TEST_FILE_TIMEOUT_MS (default 15 min) is named on stderr, its process tree (incl. a headless browser) is killed, and node --test fails it.
watchdog = startWatchdog({ progressFile, rootPid: child.pid, idleMs: fileIdleMs, pollMs: Math.min(5000, Math.max(250, fileIdleMs / 4)), root });

let finished = false;
function finish(exitCode, signal, extra = {}) {
  if (finished) return;
  finished = true;
  orphanGuard?.stop();
  let summary = {};
  try { summary = JSON.parse(readFileSync(summaryFile, "utf8")); } catch {} // killed before the summary: counts stay null
  watchdog.stop();
  rmSync(summaryFile, { force: true });
  rmSync(progressFile, { force: true });
  const failingFiles = [...new Set([...(summary.failingFiles ?? []), ...watchdog.killed])].map((f) => path.relative(root, f).split(path.sep).join("/"));
  // A non-zero exit with no counted failure (missing file, bad flag, killed mid-run) is still a FAIL: readers treat
  // fail > 0 as the failure signal, so a null or 0 here would read as a pass.
  const failedRun = exitCode !== 0 || !!signal;
  const incomplete = failedRun && !(summary.fail > 0);
  const fail = incomplete ? Math.max(Number(summary.fail) || 0, 1) : summary.fail;
  finishSlot(paths, slot, { ...summary, fail, failingFiles, exitCode: exitCode ?? null, signal: signal ?? null, ...(incomplete ? { incomplete: true } : {}), ...extra });
}
child.on("exit", (code, sig) => { finish(code, sig); process.exit(code ?? (sig ? 1 : 0)); });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { child.kill(s); });
process.on("exit", (code) => finish(code, null));
