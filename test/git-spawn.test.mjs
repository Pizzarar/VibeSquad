// idea-560: the off-loop git exec (server/git-spawn.mjs) runs the same `git --no-optional-locks <args>` child in a
// worker thread, so the Windows CreateProcess is off the server loop, with the identical { ok, out, code } contract the
// execFile call it replaced exposed — including the exit-code-1 "not an ancestor" case the merge-base fallback keys on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitExecOffLoop, gitSpawnStats, _resetGitSpawn } from "../server/git-spawn.mjs";

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
  assert.equal(gitSpawnStats.workerSpawns, 1, "three identical calls spawn one worker");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});
