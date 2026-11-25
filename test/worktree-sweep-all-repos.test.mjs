// W1 (docs/PLAN_DISK_LIFECYCLE_1121.md; idea-464 parts 1+2, idea-424): sweep correctness and the merge auto-sweep.
// Merged = ancestor (merge-commit PRs, main-only repos) | git cherry (cherry-picks) | tree match (squash); untracked build
// output is not dirt; live-cwd guard; every sanctuary repo; branch refs are never deleted; links are never followed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  SWEEP_LOCK_FILE,
  acquireSweepLock,
  detectDefaultBranch,
  dirBytesNoFollow,
  discoverSanctuaryRepos,
  isBuildOutputEntry,
  isInside,
  liveAgentCwds,
  mergedStatus,
  normPath,
  removeSweptWorktree,
  sweepAllRepos,
  sweepMergedWorktrees,
  throttledLiveCwds,
  toLongPath,
  worktreeDirt,
} from "../server/team-worktrees.mjs";
import { createWorktreeAutoSweep, mergeSubjectBranches, runHeavyInWorker } from "../server/worktree-autosweep.mjs";

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 }).trim();

/** Build the >260-char test fixtures with the `\\?\` prefix (no MAX_PATH limit), mirroring the sweep's own long-path handling. */
const toLong = (p) => (process.platform === "win32" ? "\\\\?\\" + resolve(p) : p);

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

test("idea-978: squash merge after master moved on (tree differs) is merged by squash-patch; partly merged and dirty are kept", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const sq = addWorktree(repo, sanct, "repo", "unit-sq");
    commitFile(sq, "a.txt", "1\n");
    commitFile(sq, "a.txt", "1\n2\n");
    const part = addWorktree(repo, sanct, "repo", "unit-part");
    commitFile(part, "p1.txt", "p1\n");
    commitFile(part, "p2.txt", "p2\n");
    const dirty = addWorktree(repo, sanct, "repo", "unit-dirty");
    commitFile(dirty, "d.txt", "d\n");
    commitFile(repo, "pre.txt", "master moved before the squash\n"); // so no squash commit's tree equals a unit's tree
    // squash-merge unit-sq and only the first commit of unit-part, then move master on so no tree matches
    git(["merge", "-q", "--squash", "unit-sq"], repo);
    git(["commit", "-q", "-m", "sq squashed"], repo);
    commitFile(repo, "p1.txt", "p1\n", "part first half only");
    git(["merge", "-q", "--squash", "unit-dirty"], repo);
    git(["commit", "-q", "-m", "dirty squashed"], repo);
    commitFile(repo, "after.txt", "master moves on\n");
    writeFile(dirty, "d.txt", "uncommitted edit\n");

    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct }));
    assert.equal(res["unit-sq"].mergedBy, "squash-patch");
    assert.equal(res["unit-sq"].action, "would-remove");
    assert.equal(res["unit-part"].merged, false);
    assert.equal(res["unit-part"].reason, "unmerged");
    assert.equal(res["unit-dirty"].merged, true);
    assert.equal(res["unit-dirty"].reason, "dirty");
  }));

test("idea-978 Tier A: a whitespace-only unmerged commit after a squash is NOT merged; squash scan is cached per ref", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    commitFile(repo, "a.py", "def f():\n    pass\n");
    const wt = addWorktree(repo, sanct, "repo", "unit-ws");
    commitFile(wt, "a.py", "def f():\n    return 1\n");
    commitFile(repo, "pre.txt", "x\n");
    git(["merge", "-q", "--squash", "unit-ws"], repo);
    git(["commit", "-q", "-m", "squashed"], repo);
    commitFile(repo, "after.txt", "y\n");
    // squashed work is merged...
    assert.equal(byBranch(sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct }))["unit-ws"].merged, true);
    // ...then an unmerged indentation-only commit lands on the branch: same whitespace-insensitive patch-id as the squash
    commitFile(wt, "a.py", "def f():\n        return 1\n", "reindent");
    const r = byBranch(sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct }))["unit-ws"];
    assert.equal(r.merged, false);
    assert.equal(r.reason, "unmerged");
    // the per-ref scan runs once for many worktrees
    const calls = [];
    const spy = (args, cwd, o) => (calls.push(args.join(" ")), execFileSync("git", args, { cwd, encoding: "utf8", input: o?.input, stdio: [o?.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim());
    const cache = new Map();
    const head = git(["rev-parse", "unit-ws"], repo);
    mergedStatus(repo, head, ["refs/heads/master"], { git: spy, treeCache: cache });
    mergedStatus(repo, head, ["refs/heads/master"], { git: spy, treeCache: cache });
    assert.equal(calls.filter((c) => c.startsWith("log -p")).length, 1);
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

test("W2 deep >260-char ignored build path (Android Gradle dirs) sweeps cleanly", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    commitFile(repo, ".gitignore", "gen/\n");
    const wt = addWorktree(repo, sanct, "repo", "unit-android-deep");
    const seg = "intermediates-".repeat(5).slice(0, 60);
    const deepRel = join("gen", "android", "app", "build", seg, seg, seg, seg, "res.txt");
    const abs = join(wt, deepRel);
    mkdirSync(toLong(dirname(abs)), { recursive: true });
    writeFileSync(toLong(abs), "deep");
    assert.ok(abs.length > 260, `fixture path is only ${abs.length} chars`);
    const r = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct }));
    assert.equal(r["unit-android-deep"].action, "removed", JSON.stringify(r["unit-android-deep"]));
    assert.equal(existsSync(wt), false);
  }));

test("W2 junction buried past 260 chars is detached, never followed; the outside target's sentinel survives", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const shared = join(root, "shared-store");
    writeFile(shared, "sentinel.txt", "precious");
    initRepo(repo);
    commitFile(repo, ".gitignore", "gen/\n");
    const wt = addWorktree(repo, sanct, "repo", "unit-deep-junction");
    const seg = "x".repeat(60);
    const deepDir = join(wt, "gen", "deep", seg, seg, seg, seg);
    mkdirSync(toLong(deepDir), { recursive: true });
    const link = join(deepDir, "target");
    symlinkSync(shared, toLong(link), "junction");
    assert.ok(link.length > 260, `junction path is only ${link.length} chars`);
    const r = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct }));
    assert.equal(r["unit-deep-junction"].action, "removed", JSON.stringify(r["unit-deep-junction"]));
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(join(shared, "sentinel.txt"), "utf8"), "precious");
  }));

test("W2 deep >260-char non-ignored build output is deleted by the sweep's own fs removal, never by following a link", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-godot-deep");
    const seg = "y".repeat(60);
    const deepRel = join(".godot", "editor", seg, seg, seg, seg);
    const deepAbs = join(wt, deepRel);
    mkdirSync(toLong(deepAbs), { recursive: true });
    writeFileSync(toLong(join(deepAbs, "shader.cache")), "cache");
    assert.ok(join(deepAbs, "shader.cache").length > 260, "build output path past MAX_PATH");
    const res = removeSweptWorktree(repo, wt, { buildOutput: [deepRel.replace(/\\/g, "/") + "/"] });
    assert.equal(res.removed, true, JSON.stringify(res));
    assert.equal(existsSync(wt), false);
  }));

// ---- W2 round 2 (Tier A review rn-3fe2bedaae5f: FAIL 2/1/2): one test per finding ----

test("H1 dirt: an untracked file past 260 chars is still dirt (git status/ls-files run with core.longpaths)", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-deep-dirt");
    const seg = "d".repeat(60);
    const deepDir = join(wt, "deep", seg, seg, seg, seg);
    mkdirSync(toLong(deepDir), { recursive: true });
    writeFileSync(toLong(join(deepDir, "notes.txt")), "keep me");
    assert.ok(join(deepDir, "notes.txt").length > 260, `fixture path is only ${join(deepDir, "notes.txt").length} chars`);
    // The deep untracked file is non-build-output dirt: a dry run must keep the worktree, not say "would-remove".
    const r = byBranch(sweepMergedWorktrees(repo, { ...OPTS, sanctuaryRoot: sanct }));
    assert.equal(r["unit-deep-dirt"].action, "kept", JSON.stringify(r["unit-deep-dirt"]));
    assert.equal(r["unit-deep-dirt"].reason, "dirty", JSON.stringify(r["unit-deep-dirt"]));
  }));

test("H2 normPath/isInside fail closed: an unresolvable path is not inside (so it is never deleted)", () =>
  withTmp((root) => {
    const missing = join(root, "does-not-exist");
    // realpath fails -> normPath returns null, never a lexical fallback.
    assert.equal(normPath(missing), null);
    // isInside reads an unresolvable child or parent as "not inside".
    assert.equal(isInside(join(missing, "sub"), missing), false);
    assert.equal(isInside(missing, missing), false);
  }));

test("M1 toLongPath: a \\\\.\\ device path passes through unchanged; empty input is rejected", () => {
  if (process.platform === "win32") {
    assert.equal(toLongPath("\\\\.\\C:\\foo"), "\\\\.\\C:\\foo");
    assert.equal(toLongPath("C:\\tmp\\x"), "\\\\?\\C:\\tmp\\x");
    assert.equal(toLongPath("\\\\?\\C:\\tmp\\x"), "\\\\?\\C:\\tmp\\x", "idempotent");
  }
  assert.throws(() => toLongPath(""), /empty path/);
});

test("L1 removeSweptWorktree: removed:true only when the dir is really gone; a leftover folder reports an orphan", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-leftover");
    // git drops the metadata but leaves the folder (the partial-removal failure mode idea-514 describes).
    const fakeGit = (args, cwd) => (args.includes("worktree") && args.includes("remove") ? "" : git(args, cwd));
    const res = removeSweptWorktree(repo, wt, { git: fakeGit });
    assert.equal(res.removed, false, JSON.stringify(res));
    assert.equal(res.reason, "orphan", JSON.stringify(res));
    assert.ok(existsSync(wt), "the leftover folder is left for the next sweep to report");
  }));

test("L2 dirBytesNoFollow + splitUntrackedDir use long paths: deep >260 content is sized and classified, not lost", () =>
  withTmp((root) => {
    // dirBytesNoFollow: a deep file's bytes are counted, not silently skipped (0).
    const seg = "z".repeat(60);
    const deep = join(root, "sized", seg, seg, seg, seg);
    mkdirSync(toLong(deep), { recursive: true });
    writeFileSync(toLong(join(deep, "blob.bin")), Buffer.alloc(5000, 7));
    assert.ok(join(deep, "blob.bin").length > 260);
    assert.equal(dirBytesNoFollow(deep), 5000);

    // splitUntrackedDir (via worktreeDirt): a deep >260 build-output dir still reads as clean, not dirt.
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-deep-build");
    const b = "b".repeat(60);
    const deepDist = join(wt, "gen", "deep", b, b, b, b, "dist");
    mkdirSync(toLong(deepDist), { recursive: true });
    writeFileSync(toLong(join(deepDist, "app.js")), "x");
    assert.ok(join(deepDist, "app.js").length > 260);
    const d = worktreeDirt(wt);
    assert.equal(d.clean, true, JSON.stringify(d));
    assert.ok(d.buildOutput.some((x) => x.endsWith("/dist/")), JSON.stringify(d.buildOutput));
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

// ---- Tier A review rn-3d805b325403 (PASS 0/4/2 on 23a272be): one test per Medium ----

test("M1 live-cwd: a lost agent (toAgent flattens it to status closed + lost: true) still holds its worktree", () => {
  const cwds = liveAgentCwds([
    { id: "lost", status: "closed", lost: true, resumable: false, cwd: "/home/alice/wt-lost" },
    { id: "gone", status: "closed", lost: false, resumable: false, cwd: "/home/alice/wt-gone" },
    { id: "resumable", status: "closed", resumable: true, cwd: "/home/alice/wt-resume" },
    { id: "archived", status: "closed", lost: true, archivedAt: "2026-11-01", cwd: "/home/alice/wt-arch" },
  ]);
  assert.deepEqual(cwds, ["/home/alice/wt-lost", "/home/alice/wt-resume"]);
});

test("M2 removal: a build-output link two levels down that points outside is unlinked, never followed; a link on the parent path is left alone", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const shared = join(root, "shared-store");
    writeFile(shared, "keep.txt", "precious");
    writeFile(shared, "dist/keep2.txt", "precious2");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-deep-link");
    mkdirSync(join(wt, "a", "b"), { recursive: true });
    symlinkSync(shared, join(wt, "a", "b", "dist"), "junction");
    const res = removeSweptWorktree(repo, wt, { buildOutput: ["a/b/dist"] });
    assert.equal(res.removed, true, JSON.stringify(res));
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(join(shared, "keep.txt"), "utf8"), "precious");

    // an entry reached through a link ("lnk" -> shared): its parent resolves outside, so it is not touched
    const wt2 = addWorktree(repo, sanct, "repo", "unit-parent-link");
    symlinkSync(shared, join(wt2, "lnk"), "junction");
    removeSweptWorktree(repo, wt2, { buildOutput: ["lnk/dist"] });
    assert.equal(readFileSync(join(shared, "dist", "keep2.txt"), "utf8"), "precious2");
  }));

test("R3 H1 TOCTOU: a build-output dir swapped for a junction mid-walk aborts the removal; the outside victim survives", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const victim = join(root, "victim");
    writeFile(victim, "z_sub/sentinel.txt", "precious");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-toctou");
    writeFile(wt, "dist/a_file.js", "built");
    writeFile(wt, "dist/z_sub/out.js", "built");
    const dist = join(wt, "dist");
    let swapped = false;
    // After dist is listed (a_file.js, z_sub) and before the walk descends into z_sub: dist -> junction to victim.
    const onListed = (abs) => {
      if (swapped || !/[\\/]dist$/i.test(abs)) return;
      renameSync(dist, join(wt, "dist-aside"));
      symlinkSync(victim, dist, "junction");
      swapped = true;
    };
    const res = removeSweptWorktree(repo, wt, { buildOutput: ["dist/"], onListed });
    assert.equal(swapped, true, "the swap hook ran");
    assert.notEqual(res.removed, true, JSON.stringify(res));
    assert.match(res.reason, /EESCAPE/, JSON.stringify(res));
    assert.equal(readFileSync(join(victim, "z_sub", "sentinel.txt"), "utf8"), "precious");
    assert.equal(existsSync(wt), true, "worktree left in place after the abort");

    // Same swap before the descent into a nested dir's readdir: dist/z_sub listed, then z_sub -> junction.
    const wt2 = addWorktree(repo, sanct, "repo", "unit-toctou-2");
    writeFile(wt2, "dist/z_sub/deeper/out.js", "built");
    writeFile(victim, "deeper/sentinel2.txt", "precious2");
    const sub = join(wt2, "dist", "z_sub");
    let swapped2 = false;
    const res2 = removeSweptWorktree(repo, wt2, {
      buildOutput: ["dist/"],
      onListed: (abs) => {
        if (swapped2 || !/[\\/]z_sub$/i.test(abs)) return;
        renameSync(sub, join(wt2, "z_sub-aside"));
        symlinkSync(victim, sub, "junction");
        swapped2 = true;
      },
    });
    assert.equal(swapped2, true, "the second swap hook ran");
    assert.notEqual(res2.removed, true, JSON.stringify(res2));
    assert.equal(readFileSync(join(victim, "deeper", "sentinel2.txt"), "utf8"), "precious2");
    assert.equal(readFileSync(join(victim, "z_sub", "sentinel.txt"), "utf8"), "precious");
  }));

test("M3 live-cwd refresh: the roster is re-read right before each removal; unreadable at that point keeps the worktree", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const late = addWorktree(repo, sanct, "repo", "unit-late-agent");
    const blind = addWorktree(repo, sanct, "repo", "unit-blind");
    const go = addWorktree(repo, sanct, "repo", "unit-go");
    // the snapshot taken at start has no agents in these worktrees; by removal time one has moved into unit-late-agent
    let reads = 0;
    const refresh = () => {
      reads++;
      return [late];
    };
    const r1 = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct, refreshLiveCwds: refresh, only: (w) => w.branch !== "unit-blind" }));
    assert.equal(r1["unit-late-agent"].reason, "live-cwd");
    assert.equal(r1["unit-go"].action, "removed");
    assert.ok(reads >= 2, "read before each removal");
    assert.ok(existsSync(late) && !existsSync(go));
    const r2 = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], sanctuaryRoot: sanct, refreshLiveCwds: () => null, only: (w) => w.branch === "unit-blind" }));
    assert.equal(r2["unit-blind"].reason, "live-cwd-unknown");
    assert.ok(existsSync(blind));

    // throttledLiveCwds: one roster read per interval; empty or throwing roster -> null
    let t = 0;
    let n = 0;
    const th = throttledLiveCwds(() => (n++, [{ id: "a", status: "running", cwd: "/home/alice/x" }]), { intervalMs: 1000, clock: () => t });
    assert.deepEqual(th(), ["/home/alice/x"]);
    th();
    assert.equal(n, 1);
    t = 1500;
    th();
    assert.equal(n, 2);
    assert.equal(throttledLiveCwds(() => [])(), null);
    assert.equal(
      throttledLiveCwds(() => {
        throw new Error("x");
      })(),
      null,
    );
  }));

test("M4 sanctuary lock: one remover at a time across processes; a dead holder's lock is taken over; dry run needs no lock", () =>
  withTmp((root) => {
    const sanct = join(root, "sanct");
    mkdirSync(sanct, { recursive: true });
    const release = acquireSweepLock(sanct);
    assert.equal(typeof release, "function");
    assert.equal(acquireSweepLock(sanct), null, "held by a live pid");
    const busy = sweepAllRepos({ root: sanct, apply: true, liveCwds: [] });
    assert.equal(busy.busy, true);
    assert.deepEqual(busy.repos, []);
    assert.equal(sweepAllRepos({ root: sanct, apply: false }).busy, undefined, "dry run ignores the lock");
    release();
    assert.equal(existsSync(join(sanct, SWEEP_LOCK_FILE)), false);

    writeFile(sanct, SWEEP_LOCK_FILE, JSON.stringify({ pid: 999999, at: Date.now() }));
    const r2 = acquireSweepLock(sanct, { alive: () => false });
    assert.equal(typeof r2, "function", "dead holder's lock taken over");
    r2();
    writeFile(sanct, SWEEP_LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(join(sanct, SWEEP_LOCK_FILE), longAgo, longAgo); // live pid, no heartbeat for 3h (hung holder or reused pid)
    const r3 = acquireSweepLock(sanct);
    assert.equal(typeof r3, "function", "no heartbeat past the stale limit: taken over");
    r3();
  }));

test("M4 + L2 auto-sweep in a worker thread: off the event loop, lock-aware, one result per unit when local and origin refs both move", async () => {
  const root = mkdtempSync(join(tmpdir(), "vs-w1-worker-"));
  try {
    const sanct = join(root, "sanct");
    const repo = join(root, "repo");
    initRepo(repo);
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], repo);
    const done = addWorktree(repo, sanct, "repo", "unit-w-done");
    commitFile(done, "d.txt", "d");
    const agents = [{ id: "other", status: "running", cwd: join(root, "elsewhere") }];
    const logs = [];
    const sweep = createWorktreeAutoSweep({ root: sanct, apply: false, runHeavy: runHeavyInWorker, listAgents: async () => agents, log: (t) => logs.push(t) });
    assert.deepEqual((await sweep.tick()).results, []);
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-w-done'", "unit-w-done"], repo);
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], repo);
    const res = await sweep.tick();
    assert.equal(res.results.length, 1, JSON.stringify(res.results));
    assert.equal(res.results[0].action, "would-remove");
    assert.equal(logs.filter((t) => t.startsWith("worktree-autosweep would-remove")).length, 1, logs.join(" | "));
    assert.ok(existsSync(done));

    // apply while a manual sweep holds the lock: skipped, nothing removed
    const applier = createWorktreeAutoSweep({ root: sanct, apply: true, runHeavy: runHeavyInWorker, listAgents: async () => agents, log: () => {} });
    await applier.tick();
    commitFile(repo, "m.txt", "m");
    const held = acquireSweepLock(sanct);
    const t2 = await applier.tick();
    assert.deepEqual(t2, { skipped: "sweep-busy" });
    assert.ok(existsSync(done));
    held();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Tier A review R2 rn-a307a2468120 (PASS 0/3/2 on 440794d4): one test per Medium ----

test("R2 M-a heartbeat: a beating live holder keeps the lock past 2h; without beats it is taken over and the old holder's beat reports the loss", () =>
  withTmp((root) => {
    const sanct = join(root, "sanct");
    mkdirSync(sanct, { recursive: true });
    const lock = join(sanct, SWEEP_LOCK_FILE);
    let t = Date.now();
    const rel = acquireSweepLock(sanct, { clock: () => t });
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(lock, longAgo, longAgo); // a 3h sweep: the creation time is long past
    t += 61_000;
    assert.equal(rel.beat(), true);
    assert.equal(acquireSweepLock(sanct), null, "live pid + recent heartbeat: never stolen, however old the lock");
    utimesSync(lock, longAgo, longAgo); // now no beat for 3h
    const thief = acquireSweepLock(sanct);
    assert.equal(typeof thief, "function");
    assert.equal(rel.beat(), false, "the old holder learns it lost the lock");
    rel(); // its release must not delete the new holder's lock (nonce differs)
    assert.ok(existsSync(lock));
    thief();

    // the sweep stops removing once its lock is lost
    const repo = join(root, "repo");
    initRepo(repo);
    const wt = addWorktree(repo, join(root, "sanct2"), "repo", "unit-lock-lost");
    let beats = 0;
    const res = byBranch(sweepMergedWorktrees(repo, { ...OPTS, apply: true, liveCwds: [], heartbeat: () => (beats++, false) }));
    assert.equal(res["unit-lock-lost"].reason, "sweep-lock-lost");
    assert.ok(beats >= 1 && existsSync(wt));
  }));

test("R2 M-b links: a gitignored junction deep in the tree is detached before git worktree remove; a link that will not detach fails closed", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const shared = join(root, "main-node-modules");
    writeFile(shared, "pkg/index.js", "precious");
    initRepo(repo);
    commitFile(repo, ".gitignore", "node_modules");
    const wt = addWorktree(repo, sanct, "repo", "unit-ignored-link");
    mkdirSync(join(wt, "packages", "x"), { recursive: true });
    symlinkSync(shared, join(wt, "packages", "x", "node_modules"), "junction");
    assert.equal(worktreeDirt(wt).clean, true, "ignored: not dirt, not in buildOutput");
    const ok = removeSweptWorktree(repo, wt);
    assert.equal(ok.removed, true, JSON.stringify(ok));
    assert.equal(readFileSync(join(shared, "pkg", "index.js"), "utf8"), "precious");

    const wt2 = addWorktree(repo, sanct, "repo", "unit-stuck-link");
    symlinkSync(shared, join(wt2, "node_modules"), "junction");
    const stuck = removeSweptWorktree(repo, wt2, { unlinkLink: () => {} }); // the unlink silently does nothing
    assert.equal(stuck.removed, false);
    assert.match(stuck.reason, /ELINK/);
    assert.ok(existsSync(wt2));
    assert.equal(readFileSync(join(shared, "pkg", "index.js"), "utf8"), "precious");
    const thrown = removeSweptWorktree(repo, wt2, {
      unlinkLink: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    assert.equal(thrown.removed, false);
    assert.match(thrown.reason, /EBUSY/);
    assert.ok(existsSync(wt2));
  }));

test("idea-544 TOCTOU: a dir swapped for a junction during the untracked-link walk aborts; links outside the worktree stay attached", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const shared = join(root, "main-node-modules");
    writeFile(shared, "pkg/index.js", "precious");
    // Outside the worktree: a folder holding its own untracked link (what the swapped junction would lead the walk to).
    const victim = join(root, "victim");
    mkdirSync(join(victim, "sub"), { recursive: true });
    symlinkSync(shared, join(victim, "nm"), "junction");
    symlinkSync(shared, join(victim, "sub", "nm"), "junction");
    const victimLinked = () => existsSync(join(victim, "nm", "pkg", "index.js")) && existsSync(join(victim, "sub", "nm", "pkg", "index.js"));
    initRepo(repo);
    commitFile(repo, ".gitignore", "node_modules\nnm");

    // (1) deps is listed (sub), then deps/sub -> junction to victim before the walk reads it.
    const wt = addWorktree(repo, sanct, "repo", "unit-walk-swap");
    mkdirSync(join(wt, "deps", "sub"), { recursive: true });
    symlinkSync(shared, join(wt, "deps", "sub", "node_modules"), "junction");
    const sub = join(wt, "deps", "sub");
    let swapped = false;
    const res = removeSweptWorktree(repo, wt, {
      onLinkWalkListed: (dir) => {
        if (swapped || !/[\\/]deps$/i.test(dir)) return;
        renameSync(sub, join(wt, "sub-aside"));
        symlinkSync(victim, sub, "junction");
        swapped = true;
      },
    });
    assert.equal(swapped, true, "the swap hook ran");
    assert.notEqual(res.removed, true, JSON.stringify(res));
    assert.match(res.reason, /EESCAPE/, JSON.stringify(res));
    assert.ok(victimLinked(), "the outside links were never unlinked");
    assert.ok(existsSync(wt), "worktree left in place after the abort");

    // (2) the walk finished inside (deps/sub/nm collected), then deps -> junction to victim before the unlink.
    const wt2 = addWorktree(repo, sanct, "repo", "unit-unlink-swap");
    mkdirSync(join(wt2, "deps", "sub"), { recursive: true });
    symlinkSync(shared, join(wt2, "deps", "sub", "nm"), "junction");
    const deps = join(wt2, "deps");
    let swapped2 = false;
    const res2 = removeSweptWorktree(repo, wt2, {
      onLinkWalkListed: (dir) => {
        if (swapped2 || !/[\\/]deps[\\/]sub$/i.test(dir)) return; // the last folder the walk reads
        renameSync(deps, join(wt2, "deps-aside"));
        symlinkSync(victim, deps, "junction");
        swapped2 = true;
      },
    });
    assert.equal(swapped2, true, "the second swap hook ran");
    assert.notEqual(res2.removed, true, JSON.stringify(res2));
    assert.match(res2.reason, /EESCAPE/, JSON.stringify(res2));
    assert.ok(victimLinked(), "the outside link under the swapped ancestor was never unlinked");
    assert.equal(readFileSync(join(shared, "pkg", "index.js"), "utf8"), "precious");
  }));

test("R2 M-c lock races: an empty or half-written lock is not stale; a concurrent takeover blocks a second taker; create leaves no temp files", () =>
  withTmp((root) => {
    const sanct = join(root, "sanct");
    mkdirSync(sanct, { recursive: true });
    const lock = join(sanct, SWEEP_LOCK_FILE);
    writeFileSync(lock, ""); // what a non-atomic create looks like mid-write
    assert.equal(acquireSweepLock(sanct), null);
    assert.equal(readFileSync(lock, "utf8"), "", "untouched");
    rmSync(lock);

    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0, nonce: "dead" }));
    writeFileSync(lock + ".takeover", "someone"); // another taker is mid-takeover
    assert.equal(acquireSweepLock(sanct, { alive: () => false }), null);
    assert.match(readFileSync(lock, "utf8"), /dead/, "the other taker's decision stands");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock + ".takeover", old, old); // that taker crashed
    assert.equal(acquireSweepLock(sanct, { alive: () => false }), null, "leftover cleared, this attempt still yields");
    const rel = acquireSweepLock(sanct, { alive: () => false });
    assert.equal(typeof rel, "function");
    assert.deepEqual(readdirSync(sanct).sort(), [SWEEP_LOCK_FILE]);
    const body = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(body.pid, process.pid);
    assert.match(body.nonce, /^[0-9a-f-]{36}$/);
    rel();
    assert.deepEqual(readdirSync(sanct), []);
  }));

test("R2 L tips: a skipped tick does not advance tips, so the merge is swept on the next tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "vs-w1-tips-"));
  try {
    const sanct = join(root, "sanct");
    const repo = join(root, "repo");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "repo", "unit-retry");
    commitFile(wt, "r.txt", "r");
    let agents = null;
    const sweep = createWorktreeAutoSweep({ root: sanct, listAgents: async () => agents, log: () => {} });
    await sweep.tick();
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-retry'", "unit-retry"], repo);
    assert.deepEqual(await sweep.tick(), { skipped: "agents-unreadable" });
    agents = [{ id: "other", status: "running", cwd: join(root, "elsewhere") }];
    const res = await sweep.tick();
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].action, "would-remove");
    assert.deepEqual((await sweep.tick()).results, [], "committed after the successful sweep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
