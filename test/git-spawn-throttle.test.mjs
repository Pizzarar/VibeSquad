// idea-518 part B: the server's hot git paths (spawn-time git snapshot, done-sweep unit-branch check, worktree auto-sweep
// tick) read refs from .git instead of spawning git, cache until a ref moves, and are single-flight per cwd.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitDirsFs, readHeadFs, resolveRefsFs } from "../server/git-refs-fs.mjs";
import { _resetGitHelperCaches, gitHelperStats, gitUnitBranchState, inspectGitSpawnState } from "../server/hooks/agent-duties.ts";
import { AUTOSWEEP_REPO_CACHE_TTL_MS, AUTOSWEEP_TICK_MS, createWorktreeAutoSweep } from "../server/worktree-autosweep.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-gst-"));
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

test("git-refs-fs: HEAD and refs of a repo and a linked worktree match git, loose and packed, symbolic followed", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const wtDirs = await gitDirsFs(r.wt);
  assert.ok(wtDirs && wtDirs.gitDir !== wtDirs.commonDir, "linked worktree has its own gitdir");
  assert.deepEqual(await readHeadFs(wtDirs), { branch: "unit-x" });
  assert.deepEqual(await readHeadFs(await gitDirsFs(r.repo)), { branch: "master" });
  git(r.repo, "update-ref", "refs/remotes/origin/master", "master");
  git(r.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
  const want = ["refs/heads/master", "refs/heads/unit-x", "refs/remotes/origin/HEAD", "refs/heads/nope"];
  const loose = await resolveRefsFs(wtDirs, want);
  assert.equal(loose.get("refs/heads/master"), git(r.repo, "rev-parse", "master"));
  assert.equal(loose.get("refs/heads/unit-x"), git(r.repo, "rev-parse", "unit-x"));
  assert.equal(loose.get("refs/remotes/origin/HEAD"), git(r.repo, "rev-parse", "master"));
  assert.equal(loose.has("refs/heads/nope"), false, "a missing ref is left out, like for-each-ref");
  git(r.repo, "pack-refs", "--all");
  const packed = await resolveRefsFs(await gitDirsFs(r.repo), want);
  assert.deepEqual([...packed].sort(), [...loose].sort(), "packed-refs answer the same");
  assert.equal(await gitDirsFs(path.join(r.dir, "not-a-dir")), null);
});

test("gitUnitBranchState: cached until a tip moves, single-flight, no git for the trivial answers", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitHelperCaches();
  assert.deepEqual(await gitUnitBranchState(r.repo), { unit: "", merged: false }, "on master");
  assert.equal(gitHelperStats.unitBranchGit, 0, "on master needs no git");

  const [a, b, c] = await Promise.all([gitUnitBranchState(r.wt), gitUnitBranchState(r.wt), gitUnitBranchState(r.wt)]);
  assert.deepEqual(a, { unit: "unit-x", merged: false });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(gitHelperStats.unitBranchGit, 1, "three concurrent callers share one merge-base (no main branch: master only)");
  assert.deepEqual(await gitUnitBranchState(r.wt), a);
  assert.equal(gitHelperStats.unitBranchGit, 1, "unchanged tips: answered from cache, no spawn");

  git(r.repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'unit-x'", "unit-x");
  assert.deepEqual(await gitUnitBranchState(r.wt), { unit: "unit-x", merged: true }, "master moved: cache invalidated");
  assert.equal(gitHelperStats.unitBranchGit, 2);
  assert.deepEqual(await gitUnitBranchState(r.wt), { unit: "unit-x", merged: true });
  assert.equal(gitHelperStats.unitBranchGit, 2);

  git(r.wt, "checkout", "-q", "--detach");
  assert.deepEqual(await gitUnitBranchState(r.wt), { unit: "", merged: false }, "detached HEAD: unknown, kept");
  assert.equal(gitHelperStats.unitBranchGit, 2);
  assert.deepEqual(await gitUnitBranchState(path.join(r.dir, "gone")), { unit: "", merged: false });
});

test("inspectGitSpawnState: single-flight per cwd, cached while HEAD/index/origin are unchanged, refreshed when they move", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  _resetGitHelperCaches();
  const [s1, s2] = await Promise.all([inspectGitSpawnState(r.wt, { timeoutMs: 30_000 }), inspectGitSpawnState(r.wt, { timeoutMs: 30_000 })]);
  assert.equal(s1, s2);
  assert.match(s1, /branch=unit-x, origin=0 behind \/ 0 ahead, dirty=0 files\.$/);
  assert.equal(gitHelperStats.spawnStateGit, 1, "one status; no origin refs, so no rev-list spawned");

  assert.equal(await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 }), s1);
  assert.equal(gitHelperStats.spawnStateGit, 1, "cache hit");

  fs.writeFileSync(path.join(r.wt, "a.txt"), "changed\n");
  git(r.wt, "add", "a.txt"); // index moves
  assert.match(await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 }), /dirty=1 files\.$/);
  assert.equal(gitHelperStats.spawnStateGit, 2);

  git(r.repo, "update-ref", "refs/remotes/origin/unit-x", git(r.repo, "rev-parse", "unit-x~1"));
  assert.match(await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 }), /origin=0 behind \/ 1 ahead/, "origin ref appeared: refreshed");
  assert.equal(gitHelperStats.spawnStateGit, 4, "status + one rev-list (only the origin ref that exists)");

  assert.ok(await inspectGitSpawnState(r.wt, { timeoutMs: 30_000, cacheMs: 0 }));
  assert.equal(gitHelperStats.spawnStateGit, 6, "cacheMs 0 always re-runs git");
});

test("worktree auto-sweep: slow cadence, quiet tick spawns no git, yields between repos, for-each-ref only as fallback", async (t) => {
  assert.ok(AUTOSWEEP_TICK_MS >= 10 * 60_000, `tick every ${AUTOSWEEP_TICK_MS} ms`);
  assert.ok(AUTOSWEEP_REPO_CACHE_TTL_MS >= 60 * 60_000);

  const r = makeRepo();
  t.after(r.cleanup);
  const tip = git(r.repo, "rev-parse", "master");
  const repos = [0, 1, 2].map((i) => ({ repo: { name: `r${i}`, repoRoot: r.repo }, def: { name: "master", refs: ["refs/heads/master"] } }));
  let gitAsyncCalls = 0;
  let yields = 0;
  const order = [];
  const sweep = createWorktreeAutoSweep({
    root: r.dir,
    listAgents: async () => [],
    log: () => {},
    runHeavy: async (name) => (name === "repos" ? repos : { results: [] }),
    gitAsync: async () => (gitAsyncCalls++, null),
    yieldLoop: async () => {
      yields++;
      order.push("yield");
    },
    readRefs: async (refs, root) => {
      order.push("read");
      return resolveRefsFs(await gitDirsFs(root), refs);
    },
  });
  assert.deepEqual(await sweep.tick(), { apply: false, removed: 0, wouldRemove: 0, kept: 0, results: [] });
  assert.equal(gitAsyncCalls, 0, "refs read from .git, no git child");
  assert.equal(yields, 2, "yield between each of the 3 repos");
  assert.deepEqual(order, ["read", "yield", "read", "yield", "read"]);

  // Fallback: unreadable .git -> for-each-ref, and its output still baselines/moves tips.
  const outs = [`refs/heads/master\t${tip}\n`, `refs/heads/master\t${"f".repeat(40)}\n`];
  const seen = [];
  const fb = createWorktreeAutoSweep({
    root: r.dir,
    listAgents: async () => [],
    log: () => {},
    runHeavy: async (name) => (name === "repos" ? repos.slice(0, 1) : { results: [] }),
    readRefs: async () => null,
    yieldLoop: async () => {},
    gitAsync: async (args) => (seen.push(args[0]), outs.shift() ?? null),
  });
  await fb.tick(); // baseline
  assert.deepEqual(await fb.tick(), { skipped: "agents-unreadable" }, "moved tip seen through the fallback (empty roster then fails closed)");
  assert.deepEqual(seen, ["for-each-ref", "for-each-ref"]);
});
