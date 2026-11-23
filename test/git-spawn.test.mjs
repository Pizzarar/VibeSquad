// idea-560: the off-loop git exec (server/git-spawn.mjs) runs the same `git --no-optional-locks <args>` child in a
// worker thread, so the Windows CreateProcess is off the server loop, with the identical { ok, out, code } contract the
// execFile call it replaced exposed — including the exit-code-1 "not an ancestor" case the merge-base fallback keys on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { execOffLoop, gitExecOffLoop, gitSpawnStats, _resetGitSpawn } from "../server/git-spawn.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-gso-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  const wt = path.join(dir, "wt");
  git(repo, "worktree", "add", "-q", "-b", "unit-x", wt);
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  git(wt, "add", "b.txt");
  git(wt, "commit", "-q", "-m", "unit work");
  return { dir, repo, wt, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("gitExecOffLoop returns the same stdout and exit codes plain git gives", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitSpawn();

  // stdout is raw (untrimmed): rev-parse HEAD ends in a newline, exit 0.
  const rev = await gitExecOffLoop(r.repo, ["rev-parse", "HEAD"], 30_000);
  assert.deepEqual(rev, { ok: true, out: `${git(r.repo, "rev-parse", "HEAD")}\n`, code: 0 });

  // unit-x is ahead of master (not merged): its tip is NOT an ancestor of master -> exit 1 (empty stdout).
  const unitTip = git(r.repo, "rev-parse", "unit-x");
  const unmerged = await gitExecOffLoop(r.wt, ["merge-base", "--is-ancestor", unitTip, "master"], 30_000);
  assert.deepEqual(unmerged, { ok: false, out: "", code: 1 }, "non-ancestor exits 1: the merge-base fallback's cacheable signal");

  // master IS an ancestor of unit-x -> exit 0.
  const merged = await gitExecOffLoop(r.wt, ["merge-base", "--is-ancestor", "master", unitTip], 30_000);
  assert.deepEqual(merged, { ok: true, out: "", code: 0 });
});

test("gitExecOffLoop: missing cwd fails closed (ok:false, code null) and never rejects", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitSpawn();
  const missing = await gitExecOffLoop(path.join(r.dir, "gone"), ["rev-parse", "HEAD"], 30_000);
  assert.deepEqual(missing, { ok: false, out: "", code: null });
});

test("gitExecOffLoop is single-flight per repo+args: concurrent identical calls share one worker", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitSpawn();
  const [a, b, c] = await Promise.all([
    gitExecOffLoop(r.repo, ["rev-parse", "HEAD"], 30_000),
    gitExecOffLoop(r.repo, ["rev-parse", "HEAD"], 30_000),
    gitExecOffLoop(r.repo, ["rev-parse", "HEAD"], 30_000),
  ]);
  assert.equal(gitSpawnStats.dispatches, 1, "three identical calls dispatch one git child (deduped, not just one persistent worker)");
  assert.equal(gitSpawnStats.workerSpawns, 1, "three identical calls spawn one worker");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("idea-572: execOffLoop runs any child in the worker: stdout, stderr, exit code, explicit env, never rejects", async () => {
  _resetGitSpawn();
  const script = "process.stdout.write('out:' + (process.env.VS572 ?? 'none')); process.stderr.write('err'); process.exit(Number(process.argv[1] ?? 0))";
  const ok = await execOffLoop(process.execPath, ["-e", script, "0"], { env: { ...process.env, VS572: "yes" }, timeoutMs: 30_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.out, "out:yes");
  assert.equal(ok.err, "err");
  assert.equal(ok.code, 0);
  const bad = await execOffLoop(process.execPath, ["-e", script, "3"], { timeoutMs: 30_000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.equal(bad.out, "out:none", "no env passed: the worker's own env");
  const missing = await execOffLoop(path.join(os.tmpdir(), "vs-572-no-such-binary.exe"), [], { timeoutMs: 30_000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, null);
  assert.equal(gitSpawnStats.workerSpawns, 1, "one persistent worker for all three");
  assert.equal(gitSpawnStats.dispatches, 3, "no dedupe for generic children");
});

test("idea-572: gitExecOffLoop maxBuffer lifts the 1 MiB stdout cap (big git log reads)", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitSpawn();
  fs.writeFileSync(path.join(r.repo, "big.txt"), "x".repeat(1_300_000) + "\n");
  git(r.repo, "add", "big.txt");
  git(r.repo, "commit", "-q", "-m", "big");
  const capped = await gitExecOffLoop(r.repo, ["show", "HEAD:big.txt"], 30_000);
  assert.equal(capped.ok, false, "default cap: over 1 MiB fails closed");
  const big = await gitExecOffLoop(r.repo, ["show", "HEAD:big.txt"], 30_000, { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(big.ok, true);
  assert.equal(big.out.length, 1_300_001);
});

test("idea-576: long-budget calls run on their own worker, so a short call's worker is separate (a short guard terminate can't fail them)", async () => {
  _resetGitSpawn();
  const slow = execOffLoop(process.execPath, ["-e", "setTimeout(() => process.stdout.write('long'), 300)"], { timeoutMs: 60_000 });
  const quick = await execOffLoop(process.execPath, ["-e", "process.stdout.write('short')"], { timeoutMs: 5_000 });
  assert.equal(quick.out, "short");
  assert.equal(gitSpawnStats.workerSpawns, 2, "one short worker + one long worker");
  const r = await slow;
  assert.equal(r.ok, true);
  assert.equal(r.out, "long");
  _resetGitSpawn();
});
