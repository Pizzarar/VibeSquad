// `npm test` entry: only one suite may run at a time machine-wide (parallel suites each spawn runners/MCP servers and flood the box).
// Holds <tmpdir>/vibesquad-npm-test.lock for the run; a dead owner or a lock older than 2h is stale and taken over.
// Extra args are forwarded as test files (default: test/*.test.mjs).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireStartLock, releaseLock, readLock } from "../runner/lock.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockFile = path.join(os.tmpdir(), "vibesquad-npm-test.lock");
if (!acquireStartLock(lockFile, { staleMs: 2 * 60 * 60 * 1000 })) {
  const holder = readLock(lockFile);
  console.error(`npm test refused: another suite is running (pid ${holder?.pid}, lock ${lockFile}). Only one suite at a time; ask the lead for the slot.`);
  process.exit(1);
}
const files = process.argv.length > 2 ? process.argv.slice(2) : ["test/*.test.mjs"];
const child = spawn(process.execPath, ["--test", "--import", "./test/setup/hermetic.mjs", ...files], { cwd: root, stdio: "inherit" });
const done = (code) => { releaseLock(lockFile); process.exit(code); };
child.on("exit", (code, sig) => done(code ?? (sig ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { child.kill(s); });
process.on("exit", () => releaseLock(lockFile));
