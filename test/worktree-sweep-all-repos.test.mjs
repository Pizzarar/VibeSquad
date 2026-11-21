// W1 (docs/PLAN_DISK_LIFECYCLE_1121.md; idea-464 parts 1+2, idea-424): sweep correctness and the merge auto-sweep.
// Merged = ancestor (merge-commit PRs, main-only repos) | git cherry (cherry-picks) | tree match (squash); untracked build
// output is not dirt; live-cwd guard; every sanctuary repo; branch refs are never deleted; links are never followed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  detectDefaultBranch,
  discoverSanctuaryRepos,
  isBuildOutputEntry,
  liveAgentCwds,
  mergedStatus,
  sweepAllRepos,
  sweepMergedWorktrees,
  worktreeDirt,
} from "../server/team-worktrees.mjs";
import { createWorktreeAutoSweep, mergeSubjectBranches } from "../server/worktree-autosweep.mjs";

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 }).trim();

function initRepo(dir, branch = "master") {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", branch], dir);
  git(["config", "user.email", "t@example.invalid"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  writeFile(dir, "README.md", "base\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
}
function writeFile(dir, rel, text) {
  const p = join(dir, rel);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, text);
}
function commitFile(dir, rel, text, msg = `edit ${rel}`) {
  writeFile(dir, rel, text);
  git(["add", rel], dir);
  git(["commit", "-q", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}
/** A linked worktree for `branch` under `<sanctuary>/<repoName>/<branch>`, branched off `base`. */
function addWorktree(repo, sanctuary, repoName, branch, base = "HEAD") {
  const p = join(sanctuary, repoName, branch);
  mkdirSync(join(sanctuary, repoName), { recursive: true });
  git(["worktree", "add", "-q", "-b", branch, p, base], repo);
  return p;
}
const branchExists = (repo, b) => {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], repo);
    return true;
  } catch {
    return false;
  }
};
const byBranch = (res) => Object.fromEntries(res.results.map((r) => [r.branch, r]));
const OPTS = { freshGraceMs: 0 };

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), "vs-w1-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("detectDefaultBranch: main-only repo resolves main (idea-424: the old sweep tested a missing master)", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    initRepo(repo, "main");
    assert.deepEqual(detectDefaultBranch(repo), { name: "main", refs: ["refs/heads/main"] });
    const m = join(root, "m");
    initRepo(m, "master");
    assert.equal(detectDefaultBranch(m).name, "master");
    assert.equal(detectDefaultBranch(m, { preferred: "trunk" }).name, null);
  }));

test("merged: merge-commit PR on a main repo (with origin/main merged into the unit first) is an ancestor", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo, "main");
    const wt = addWorktree(repo, sanct, "repo", "unit-mc");
    commitFile(wt, "a.txt", "a\n");
    commitFile(repo, "m.txt", "main moves\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge remote-tracking branch 'origin/main' into unit-mc", "main"], wt);
    git(["merge", "-q", "--no-ff", "-m", "Merge pull request #1 from owner/unit-mc", "unit-mc"], repo);
    const res = sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct });
    assert.equal(res.defaultBranch, "main");
    const r = byBranch(res)["unit-mc"];
    assert.equal(r.merged, true);
    assert.equal(r.mergedBy, "ancestor");
    assert.equal(r.action, "would-remove");
    assert.equal(r.liveCheck, "unknown", "dry run without a roster says so");
  }));

test("merged: squash merge matches by tree; a cherry-picked unit matches by git cherry; unmerged stays unmerged", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    // squash: two commits squashed into one on master
    const sq = addWorktree(repo, sanct, "repo", "unit-squash");
    commitFile(sq, "s1.txt", "1\n");
    commitFile(sq, "s2.txt", "2\n");
    git(["merge", "-q", "--squash", "unit-squash"], repo);
    git(["commit", "-q", "-m", "unit-squash (squashed)"], repo);
    commitFile(repo, "after.txt", "master moves on\n");
    // cherry-pick: two commits picked onto master after it moved
    const cp = addWorktree(repo, sanct, "repo", "unit-cherry", "HEAD~2");
    const c1 = commitFile(cp, "c1.txt", "c1\n");
    const c2 = commitFile(cp, "c2.txt", "c2\n");
    git(["cherry-pick", c1, c2], repo);
    // unmerged
    const um = addWorktree(repo, sanct, "repo", "unit-open");
    commitFile(um, "wip.txt", "wip\n");
    // work reverted back to the fork point: same tree as a master commit it already contains, merged nothing
    const rv = addWorktree(repo, sanct, "repo", "unit-reverted");
    commitFile(rv, "r.txt", "r\n");
    git(["revert", "--no-edit", "HEAD"], rv);

    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct }));
    assert.equal(res["unit-squash"].mergedBy, "tree");
    assert.equal(res["unit-squash"].action, "would-remove");
    assert.equal(res["unit-cherry"].mergedBy, "cherry");
    assert.equal(res["unit-cherry"].action, "would-remove");
    assert.equal(res["unit-open"].merged, false);
    assert.equal(res["unit-open"].reason, "unmerged");
    assert.equal(res["unit-reverted"].reason, "unmerged");
    // origin/<default> counts too (merged upstream, not pulled): refs list carries it
    const head = git(["rev-parse", "unit-open"], repo);
    assert.equal(mergedStatus(repo, head, ["refs/heads/master"]).merged, false);
  }));

test("dirty: untracked build output is ignored, tracked edits and other untracked files are not", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    commitFile(repo, "src-tauri/Cargo.toml", "[package]\n");
    const build = addWorktree(repo, sanct, "repo", "unit-build");
    for (const rel of ["node_modules/pkg/index.js", "dist/app.js", ".vite/deps.json", ".godot/cache.bin", "src-tauri/target/debug/x.exe", "sub/dist/b.js"]) writeFile(build, rel, "x");
    const d = worktreeDirt(build);
    assert.equal(d.clean, true, JSON.stringify(d));
    assert.ok(d.buildOutput.length >= 5);
    assert.ok(d.buildOutput.includes("sub/dist/"), JSON.stringify(d)); // a collapsed untracked folder is looked inside

    const mixed = addWorktree(repo, sanct, "repo", "unit-mixed");
    writeFile(mixed, "sub/dist/b.js", "x");
    writeFile(mixed, "sub/notes.md", "keep me");
    assert.equal(worktreeDirt(mixed).clean, false); // build output beside real work in a new folder is still dirt

    const other = addWorktree(repo, sanct, "repo", "unit-notes");
    writeFile(other, "dist/app.js", "x");
    writeFile(other, "notes.txt", "keep me");
    assert.equal(worktreeDirt(other).clean, false);

    const tracked = addWorktree(repo, sanct, "repo", "unit-tracked");
    writeFile(tracked, "README.md", "changed\n");
    assert.equal(worktreeDirt(tracked).clean, false);

    // `target` without a Cargo.toml beside it is source, not cargo output
    const src = addWorktree(repo, sanct, "repo", "unit-src-target");
    writeFile(src, "src/target/mod.rs", "fn x() {}");
    assert.equal(isBuildOutputEntry(src, "src/target/"), false);
    assert.equal(worktreeDirt(src).clean, false);
    assert.equal(isBuildOutputEntry(src, "src-tauri/target/"), true);

    // apply: only the build-output-only tree goes; every branch ref survives
    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct }));
    assert.equal(res["unit-build"].action, "removed");
    assert.equal(existsSync(build), false);
    for (const b of ["unit-notes", "unit-tracked", "unit-src-target"]) {
      assert.equal(res[b].action, "kept");
      assert.equal(res[b].reason, "dirty");
    }
    assert.equal(readFileSync(join(other, "notes.txt"), "utf8"), "keep me");
    for (const b of ["unit-build", "unit-notes", "unit-tracked", "unit-src-target"]) assert.ok(branchExists(repo, b), `${b} ref kept`);
  }));

test("removal never follows links: a junction in node_modules or nested in dist keeps its target", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const shared = join(root, "shared-store");
    writeFile(shared, "pkg/index.js", "precious");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-links");
    symlinkSync(shared, join(wt, "node_modules"), "junction");
    mkdirSync(join(wt, "dist"), { recursive: true });
    symlinkSync(shared, join(wt, "dist", "linked"), "junction");
    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct }));
    assert.equal(res["unit-links"].action, "removed");
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(join(shared, "pkg", "index.js"), "utf8"), "precious");
  }));

test("live-cwd guard: an agent cwd inside the worktree keeps it; apply with no roster removes nothing", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const held = addWorktree(repo, sanct, "repo", "unit-held");
    const free = addWorktree(repo, sanct, "repo", "unit-free");
    const agents = [
      { id: "a1", cwd: join(held, "server"), status: "running" },
      { id: "a2", cwd: free, status: "closed", resumable: false }, // closed for good: does not hold
      { id: "a3", cwd: free, archivedAt: "2026-01-01T00:00:00Z" }, // archived: does not hold
    ];
    const live = liveAgentCwds(agents);
    assert.deepEqual(live, [join(held, "server")]);

    const noRoster = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, sanctuaryRoot: sanct }));
    assert.equal(noRoster["unit-held"].reason, "live-cwd-unknown");
    assert.equal(noRoster["unit-free"].reason, "live-cwd-unknown");
    assert.ok(existsSync(held) && existsSync(free));

    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: live, sanctuaryRoot: sanct }));
    assert.equal(res["unit-held"].action, "kept");
    assert.equal(res["unit-held"].reason, "live-cwd");
    assert.ok(existsSync(held));
    assert.equal(res["unit-free"].action, "removed");
  }));

test("fresh guard: a just-created worktree with no commit of its own is kept", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    addWorktree(repo, sanct, "repo", "unit-new");
    const r = byBranch(sweepMergedWorktrees(repo, { apply: true, liveCwds: [], sanctuaryRoot: sanct }))["unit-new"];
    assert.equal(r.reason, "fresh");
  }));

test("sweepAllRepos covers every sanctuary repo with its own default branch, reports orphans and outside worktrees, deletes no branch", () =>
  withTmp((root) => {
    const sanct = join(root, "sanct");
    const a = join(root, "alpha");
    const b = join(root, "beta");
    initRepo(a, "master");
    initRepo(b, "main");
    const wa = addWorktree(a, sanct, "alpha", "unit-a");
    commitFile(wa, "a.txt", "a\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-a'", "unit-a"], a);
    const wb = addWorktree(b, sanct, "beta", "unit-b");
    commitFile(wb, "b.txt", "b\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge pull request #2 from owner/unit-b", "unit-b"], b);
    const wbOpen = addWorktree(b, sanct, "beta", "unit-b-open");
    commitFile(wbOpen, "o.txt", "o\n");
    // a worktree outside the sanctuary is never swept; a folder with no .git is only reported
    const outside = join(root, "elsewhere", "unit-out");
    git(["worktree", "add", "-q", "-b", "unit-out", outside], a);
    writeFile(join(sanct, "alpha", "leftover"), "node_modules/x.js", "x");

    const disc = discoverSanctuaryRepos(sanct);
    assert.deepEqual(disc.repos.map((r) => r.name).sort(), ["alpha", "beta"]);
    assert.equal(disc.orphans.length, 1);

    const dry = sweepAllRepos({ root: sanct, sizes: true, ...OPTS });
    assert.equal(dry.summary.alpha.defaultBranch, "master");
    assert.equal(dry.summary.beta.defaultBranch, "main");
    assert.equal(dry.summary.alpha.remove, 1);
    assert.equal(dry.summary.alpha.kept["outside-sanctuary"], 1);
    assert.equal(dry.summary.beta.remove, 1);
    assert.equal(dry.summary.beta.kept.unmerged, 1);
    assert.ok(dry.summary.alpha.bytes > 0);
    assert.equal(dry.summary["orphans:alpha"].orphanFolders, 1);

    const res = sweepAllRepos({ root: sanct, apply: true, liveCwds: [], ...OPTS });
    assert.equal(existsSync(wa), false);
    assert.equal(existsSync(wb), false);
    assert.ok(existsSync(wbOpen) && existsSync(outside));
    assert.ok(existsSync(join(sanct, "alpha", "leftover", "node_modules", "x.js")), "orphan folders are never deleted");
    assert.equal(res.summary.alpha.remove + res.summary.beta.remove, 2);
    for (const [repo, br] of [[a, "unit-a"], [b, "unit-b"], [b, "unit-b-open"], [a, "unit-out"]]) assert.ok(branchExists(repo, br), `${br} kept`);
  }));

test("mergeSubjectBranches parses local merges, remote-tracking merges and PR merges", () => {
  assert.deepEqual(mergeSubjectBranches("Merge branch 'unit-x': fix"), ["unit-x"]);
  assert.deepEqual(mergeSubjectBranches("Merge branch 'unit-x' into master"), ["unit-x"]);
  assert.deepEqual(mergeSubjectBranches("Merge remote-tracking branch 'origin/unit-y'"), ["unit-y"]);
  assert.deepEqual(mergeSubjectBranches("Merge pull request #12 from owner/unit-z"), ["unit-z"]);
  assert.deepEqual(mergeSubjectBranches("feat: not a merge"), []);
});

test("auto-sweep: dry run by default; with apply a lead's merge removes that unit's clean merged worktree only; live cwd, dirty and unmerged stay; roster unreadable skips", async () => {
  const root = mkdtempSync(join(tmpdir(), "vs-w1-auto-"));
  try {
    const sanct = join(root, "sanct");
    const repo = join(root, "repo");
    initRepo(repo);
    const done = addWorktree(repo, sanct, "repo", "unit-done");
    commitFile(done, "d.txt", "d\n");
    writeFile(done, "dist/out.js", "build");
    const held = addWorktree(repo, sanct, "repo", "unit-held");
    commitFile(held, "h.txt", "h\n");
    const dirty = addWorktree(repo, sanct, "repo", "unit-dirty");
    commitFile(dirty, "x.txt", "x\n");
    const other = addWorktree(repo, sanct, "repo", "unit-other");
    commitFile(other, "o.txt", "o\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-other'", "unit-other"], repo); // merged before the baseline

    const logs = [];
    let agents = [{ id: "w1", cwd: held, status: "idle" }];
    const sweep = createWorktreeAutoSweep({ root: sanct, apply: true, listAgents: async () => agents, log: (t) => logs.push(t) });
    const dryLogs = [];
    const dry = createWorktreeAutoSweep({ root: sanct, listAgents: async () => agents, log: (t) => dryLogs.push(t) });
    assert.deepEqual((await sweep.tick()).results, [], "first tick records tips only");
    assert.deepEqual((await dry.tick()).results, []);

    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-done'", "unit-done"], repo);
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-held'", "unit-held"], repo);
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-dirty'", "unit-dirty"], repo);
    writeFile(dirty, "README.md", "edited after merge\n");
    const dres = await dry.tick();
    assert.equal(dres.apply, false);
    assert.equal(dres.removed, 0);
    assert.equal(Object.fromEntries(dres.results.map((r) => [r.branch, r]))["unit-done"].action, "would-remove");
    assert.ok(existsSync(done), "the default (dry run) removes nothing");
    assert.ok(dryLogs.some((t) => /^worktree-autosweep would-remove repo=repo unit=unit-done /.test(t)), dryLogs.join("\n"));
    const res = await sweep.tick();
    const by = Object.fromEntries(res.results.map((r) => [r.branch, r]));
    assert.equal(by["unit-done"].action, "removed");
    assert.equal(existsSync(done), false);
    assert.equal(by["unit-held"].reason, "live-cwd");
    assert.equal(by["unit-dirty"].reason, "dirty");
    assert.equal(by["unit-other"], undefined, "merges before the baseline are left to the manual sweep");
    assert.ok(existsSync(held) && existsSync(dirty) && existsSync(other));
    for (const b of ["unit-done", "unit-held", "unit-dirty", "unit-other"]) assert.ok(branchExists(repo, b));
    assert.ok(logs.some((t) => /^worktree-autosweep removed repo=repo unit=unit-done merge=\w{8} .*branch-kept$/.test(t)), logs.join("\n"));
    assert.ok(logs.some((t) => /kept repo=repo unit=unit-held .*reason=live-cwd/.test(t)));

    // roster unreadable: nothing removed even though a merge landed
    agents = null;
    commitFile(held, "h2.txt", "h2\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-held'", "unit-held"], repo);
    assert.deepEqual(await sweep.tick(), { skipped: "agents-unreadable" });
    assert.ok(existsSync(held));
    // an empty roster is how the fold reports unreadable runner logs: also skipped
    agents = [];
    commitFile(held, "h3.txt", "h3\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-held'", "unit-held"], repo);
    assert.deepEqual(await sweep.tick(), { skipped: "agents-unreadable" });
    assert.ok(existsSync(held));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
