// `npm test` entry: only one suite may run at a time machine-wide (parallel suites each spawn runners/MCP servers and flood the box).
// Holds <tmpdir>/vibesquad-npm-test.lock {pid, agentId, startedAt, full, files} for the run; a dead owner or a lock older than 2h is stale
// and taken over (the dead run gets a {died:true} record). On exit it writes <tmpdir>/vibesquad-npm-test-last.json with the
// counts and failing files. Files and fields: scripts/suite-lock.mjs.
//   npm test                     refuse (exit 1) if another suite holds the slot
//   npm test -- --queue [files]  wait FIFO for the slot instead, printing the queue position
// Other args are forwarded as test files (default: test/*.test.mjs).
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finishSlot, suitePaths, tryAcquireSlot, waitForSlot } from "./suite-lock.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = suitePaths();
const args = process.argv.slice(2);
const queue = args.includes("--queue");
const files = args.filter((a) => a !== "--queue");
// Recorded in the lock and the last-run record: only a full run (no file args) can satisfy a watch set's suite item.
const run = { full: files.length === 0, files };
const who = (h) => `pid ${h?.pid}${h?.agentId ? `, agent ${h.agentId}` : ""}`;

let slot = null;
if (queue) {
  let leave = () => {};
  const quit = () => { leave(); process.exit(130); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", () => { if (!slot) leave(); });
  slot = await waitForSlot(paths, {
    ...run,
    onJoin: (t) => { leave = t.leave; },
    onWait: ({ position, waiting, holder }) =>
      console.error(`npm test queued: #${position} of ${waiting} waiting for the suite slot${holder ? ` (held by ${who(holder)})` : ""}.`),
  });
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

// Node's default reporter is spec (Node < 23: spec on a TTY, tap otherwise). Naming it keeps the output identical while the
// silent summary reporter writes the counts to a side file.
const major = Number(process.versions.node.split(".")[0]);
const reporter = major >= 23 || process.stdout.isTTY ? "spec" : "tap";
const summaryFile = path.join(paths.dir, `vibesquad-npm-test-summary-${process.pid}.json`);
const summaryReporter = pathToFileURL(path.join(root, "scripts", "test-summary-reporter.mjs")).href;
const child = spawn(
  process.execPath,
  [
    "--test",
    "--import", "./test/setup/hermetic.mjs",
    `--test-reporter=${reporter}`, "--test-reporter-destination=stdout",
    `--test-reporter=${summaryReporter}`, `--test-reporter-destination=${summaryFile}`,
    ...(files.length ? files : ["test/*.test.mjs"]),
  ],
  { cwd: root, stdio: "inherit" },
);

let finished = false;
function finish(exitCode, signal) {
  if (finished) return;
  finished = true;
  let summary = {};
  try { summary = JSON.parse(readFileSync(summaryFile, "utf8")); } catch {} // killed before the summary: counts stay null
  rmSync(summaryFile, { force: true });
  const failingFiles = (summary.failingFiles ?? []).map((f) => path.relative(root, f).split(path.sep).join("/"));
  // A non-zero exit with no counted failure (missing file, bad flag, killed mid-run) is still a FAIL: readers treat
  // fail > 0 as the failure signal, so a null or 0 here would read as a pass.
  const failedRun = exitCode !== 0 || !!signal;
  const incomplete = failedRun && !(summary.fail > 0);
  const fail = incomplete ? Math.max(Number(summary.fail) || 0, 1) : summary.fail;
  finishSlot(paths, slot, { ...summary, fail, failingFiles, exitCode: exitCode ?? null, signal: signal ?? null, ...(incomplete ? { incomplete: true } : {}) });
}
child.on("exit", (code, sig) => { finish(code, sig); process.exit(code ?? (sig ? 1 : 0)); });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { child.kill(s); });
process.on("exit", (code) => finish(code, null));
