// R1 (docs/PLAN_DISK_LIFECYCLE_1121.md; idea-464 part 3): retention + restore for unmerged worktrees whose owner is archived
// or lost and untouched for 7 days. Dry run by default; WIP goes to refs/vs-archive/<unit> (branch never moves); restore
// round-trips the tree byte-for-byte; links are never followed; live cwd / recent touch / merged / owner live are kept.
// Temp repos only: nothing here touches the real sanctuary.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ARCHIVE_LEDGER_FILE,
  SWEEP_LOCK_FILE,
  acquireSweepLock,
  archiveWorktree,
  planWip,
  restoreArchivedWorktree,
  retentionSweep,
  scanWorktreeNoFollow,
  worktreeOwner,
  indexAgentCwds,
} from "../server/team-worktrees.mjs";

const DAY = 86_400_000;
const LATER = Date.now() + 30 * DAY; // "now" 30 days on: every tree made here is 30 days untouched
const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 }).trim();
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function writeFile(dir, rel, data) {
  const p = join(dir, rel);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, data);
}
function initRepo(dir, { autocrlf = "false" } = {}) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "master"], dir);
  git(["config", "user.email", "t@example.invalid"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "core.autocrlf", autocrlf], dir);
  writeFile(dir, "README.md", "base\n");
  writeFile(dir, "src/keep.txt", "keep\n");
  writeFile(dir, "src/gone.txt", "to be deleted\n");
  writeFile(dir, "src/staged.txt", "v1\n");
  writeFile(dir, "src-tauri/Cargo.toml", "[package]\nname = \"x\"\n");
  writeFile(dir, ".gitignore", "*.log\nsrc-tauri/target/\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
}
/** A unit worktree under <sanctuary>/<repo>/<unit> with one commit of its own (so it is unmerged). */
function addUnit(repo, sanctuary, unit) {
  const p = join(sanctuary, "repo", unit);
  mkdirSync(join(sanctuary, "repo"), { recursive: true });
  git(["worktree", "add", "-q", "-b", unit, p, "master"], repo);
  writeFile(p, `src/${unit}.txt`, `work of ${unit}\n`);
  git(["add", "."], p);
  git(["commit", "-q", "-m", `wip ${unit}`], p);
  return p;
}
function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), "vs-r1-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function setup(root, opts) {
  const repo = join(root, "repo");
  const sanctuary = join(root, "sanctuary");
  initRepo(repo, opts);
  return { repo, sanctuary };
}
const archivedAgent = (id, cwd) => ({ id, cwd, status: "closed", archivedAt: "2026-11-01T00:00:00.000Z" });
const byUnit = (res) => Object.fromEntries(res.repos.flatMap((r) => r.results).map((x) => [x.unit, x]));
const OPTS = { now: LATER, freshGraceMs: 0 };

/** Every file under `dir` (no link follow) except .git and the given top-level/nested skip prefixes: rel -> bytes. */
function snapshot(dir, skip = []) {
  const out = {};
  const walk = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (r === ".git" || skip.some((s) => r === s || r.startsWith(`${s}/`))) continue;
      const p = join(abs, d.name);
      if (d.isSymbolicLink()) out[r] = "<link>";
      else if (d.isDirectory()) walk(p, r);
      else out[r] = readFileSync(p).toString("base64");
    }
  };
  walk(dir, "");
  return out;
}

test("dry run: a stale unmerged tree with an archived owner is listed with sizes (target as build output) and nothing changes", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const wt = addUnit(repo, sanctuary, "unit-stale");
    writeFile(wt, "src/keep.txt", "keep, edited\n"); // tracked change
    writeFile(wt, "notes/todo.md", "untracked wip\n"); // untracked
    writeFile(wt, "src-tauri/target/debug/big.bin", Buffer.alloc(200_000, 1)); // ignored cargo output
    writeFile(wt, "debug.log", "ignored log\n");
    const res = retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], ...OPTS });
    assert.equal(res.apply, false);
    assert.equal(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.equal(c.action, "would-archive");
    assert.equal(c.repo, "repo");
    assert.equal(c.unit, "unit-stale");
    assert.equal(c.branch, "unit-stale");
    assert.equal(c.ownerState, "archived");
    assert.deepEqual(c.ownerAgents, ["a1"]);
    assert.ok(c.lastTouchAgeDays >= 29, `age ${c.lastTouchAgeDays}`);
    assert.equal(c.dirtyFiles, 2);
    // The first porcelain record starts with a space (" M"): a trimmed read would plan "rc/keep.txt" as a deletion.
    assert.deepEqual(
      planWip(wt).entries.map((e) => `${e.op} ${e.rel}`).sort(),
      ["file notes/todo.md", "file src/keep.txt"],
    );
    assert.ok(c.buildBytes >= 200_000 && c.bytes > c.buildBytes, `bytes ${c.bytes} build ${c.buildBytes}`);
    assert.equal(c.ignoredLost, 1); // debug.log: deleted by an apply, reported so a human sees it
    assert.equal(res.summary.candidates, 1);
    assert.equal(res.summary.bytes, c.bytes);
    // Dry run: tree, branch and refs untouched.
    assert.ok(existsSync(join(wt, "notes/todo.md")));
    assert.equal(tryGit(["rev-parse", "--verify", "--quiet", "refs/vs-archive/unit-stale"], repo), null);
    assert.ok(!existsSync(join(sanctuary, SWEEP_LOCK_FILE)));

    // A dry run must not rewrite the index: its mtime is a touch signal, so a refresh would read as "recent-touch" next run.
    const indexPath = resolve(wt, git(["rev-parse", "--git-path", "index"], wt));
    const old = new Date(Date.now() - 20 * DAY);
    utimesSync(join(wt, "README.md"), new Date(), new Date()); // stat-dirty, content-clean: plain `git status` refreshes
    utimesSync(indexPath, old, old);
    retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], ...OPTS });
    // utimes -> read back can land sub-millisecond off the written value on some filesystems (e.g. 1793729051487.999):
    // compare with a 1ms tolerance instead of exact float equality.
    const unchanged = (ms) => Math.abs(lstatSync(indexPath).mtimeMs - ms) < 1;
    assert.ok(unchanged(old.getTime()), `dry run left the index alone (mtime ${lstatSync(indexPath).mtimeMs} vs ${old.getTime()})`);
    git(["status", "--porcelain"], wt);
    assert.ok(!unchanged(old.getTime()), "setup check: a plain status does refresh the index");
  }));

test("skip rules: live cwd, owner live (resumable lost), recent touch, merged, roster unknown on apply", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const live = addUnit(repo, sanctuary, "unit-live");
    const resumable = addUnit(repo, sanctuary, "unit-resumable");
    const recent = addUnit(repo, sanctuary, "unit-recent");
    const merged = addUnit(repo, sanctuary, "unit-merged");
    const orphan = addUnit(repo, sanctuary, "unit-orphan");
    git(["merge", "-q", "--no-ff", "-m", "merge unit-merged", "unit-merged"], repo);
    writeFile(recent, "src/fresh.txt", "just now\n");
    const t = new Date(LATER - 60_000);
    utimesSync(join(recent, "src/fresh.txt"), t, t);
    const agents = [
      { id: "w-live", cwd: join(live, "src"), status: "idle" }, // a subfolder cwd still holds the tree
      { id: "w-res", cwd: resumable, status: "closed", lost: true, resumable: true },
      archivedAgent("w-old", recent),
      archivedAgent("w-merged", merged),
      { id: "w-gone", cwd: orphan, status: "closed", resumable: false }, // closed for good: owner lost
    ];
    const res = byUnit(retentionSweep({ root: sanctuary, agents, ...OPTS }));
    assert.equal(res["unit-live"].reason, "live-cwd");
    assert.equal(res["unit-live"].ownerState, "live");
    assert.equal(res["unit-resumable"].reason, "live-cwd");
    assert.equal(res["unit-resumable"].ownerState, "live");
    assert.equal(res["unit-recent"].reason, "recent-touch");
    assert.equal(res["unit-merged"].reason, "merged");
    assert.equal(res["unit-orphan"].action, "would-archive");
    assert.equal(res["unit-orphan"].ownerState, "lost");
    assert.equal(res["unit-orphan"].ownerDetail, "closed");

    // Not old enough with the real clock: every tree was just made.
    const now = byUnit(retentionSweep({ root: sanctuary, agents, freshGraceMs: 0 }));
    assert.equal(now["unit-orphan"].reason, "recent-touch");

    // No roster: dry run reports with liveCheck unknown, apply archives nothing.
    const dry = byUnit(retentionSweep({ root: sanctuary, agents: [], ...OPTS }));
    assert.equal(dry["unit-orphan"].ownerState, "unknown");
    assert.equal(dry["unit-orphan"].liveCheck, "unknown");
    const app = byUnit(retentionSweep({ root: sanctuary, agents: [], apply: true, ...OPTS }));
    assert.equal(app["unit-orphan"].reason, "roster-unknown");
    assert.ok(existsSync(orphan));
    assert.equal(tryGit(["rev-parse", "--verify", "--quiet", "refs/vs-archive/unit-orphan"], repo), null);

    // A live agent appearing between the scan and the archive (refreshAgents) keeps the tree and writes no ref.
    const raced = byUnit(
      retentionSweep({
        root: sanctuary,
        agents,
        apply: true,
        refreshAgents: () => [...agents, { id: "w-new", cwd: orphan, status: "running" }],
        ...OPTS,
      }),
    );
    assert.equal(raced["unit-orphan"].reason, "live-cwd");
    assert.ok(existsSync(orphan));
    assert.equal(tryGit(["rev-parse", "--verify", "--quiet", "refs/vs-archive/unit-orphan"], repo), null);
  }));

test("owner state: no roster agent references the tree reads as lost (no-record); empty roster is unknown", () =>
  withTmp((root) => {
    const wt = join(root, "wt");
    mkdirSync(wt);
    assert.deepEqual(worktreeOwner(wt, indexAgentCwds([{ id: "x", cwd: root + "-other", status: "idle" }])), { state: "lost", detail: "no-record", agents: [] });
    assert.equal(worktreeOwner(wt, indexAgentCwds([])).state, "unknown");
    assert.equal(worktreeOwner(wt, indexAgentCwds([archivedAgent("a", wt), { id: "b", cwd: wt, status: "idle" }])).state, "live");
  }));

test("WIP round trip: archive keeps the branch, removes the tree; restore brings back tracked + untracked + index byte-for-byte", () =>
  withTmp((root) => {
    // autocrlf=true: a filtered add/checkout would turn LF into CRLF; the archive must not.
    const { repo, sanctuary } = setup(root, { autocrlf: "true" });
    const wt = addUnit(repo, sanctuary, "unit-wip");
    writeFile(wt, "src/keep.txt", "keep\nedited with LF only\n"); // unstaged tracked change
    writeFile(wt, "src/staged.txt", "v2 staged\n");
    git(["add", "src/staged.txt"], wt);
    writeFile(wt, "src/staged.txt", "v3 unstaged on top\r\nmixed\n"); // partially staged
    rmSync(join(wt, "src/gone.txt")); // tracked deletion
    writeFile(wt, "notes/deep/plan.md", "untracked\nLF\n");
    writeFile(wt, "notes/blob.bin", Buffer.from([0, 1, 2, 13, 10, 255, 254, 0]));
    writeFile(wt, "dist/bundle.js", "untracked build output, not archived\n");
    writeFile(wt, "src-tauri/target/debug/x.bin", Buffer.alloc(50_000, 7));
    writeFile(wt, "debug.log", "ignored\n");
    const branchTip = git(["rev-parse", "refs/heads/unit-wip"], repo);
    const before = snapshot(wt, ["dist", "src-tauri/target", "debug.log"]);
    // Untracked build output (dist/) is sized, not archived: it is the one status line restore does not bring back.
    const statusBefore = git(["status", "--porcelain", "--untracked-files=all"], wt)
      .split("\n")
      .filter((l) => l !== "?? dist/bundle.js")
      .join("\n");
    assert.ok(statusBefore.startsWith("D src/gone.txt\n M src/keep.txt\nMM src/staged.txt"), statusBefore); // dirty tracked are in it
    const indexBefore = git(["write-tree"], wt);

    const res = retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], apply: true, refreshAgents: () => [archivedAgent("a1", wt)], ...OPTS });
    const r = byUnit(res)["unit-wip"];
    assert.equal(r.action, "archived", JSON.stringify(r));
    assert.equal(r.removed, true);
    assert.ok(!existsSync(wt), "tree removed");
    assert.equal(git(["rev-parse", "refs/heads/unit-wip"], repo), branchTip, "branch never moves");
    const ref = git(["rev-parse", "refs/vs-archive/unit-wip"], repo);
    assert.equal(ref, r.commit);
    assert.equal(git(["rev-parse", `${ref}^1`], repo), branchTip);
    assert.ok(readFileSync(join(sanctuary, ARCHIVE_LEDGER_FILE), "utf8").includes('"op":"archive"'));
    assert.ok(!existsSync(join(sanctuary, SWEEP_LOCK_FILE)), "lock released");
    // Build output and ignored files are not in the archive.
    const files = git(["ls-tree", "-r", "--name-only", ref], repo).split("\n");
    assert.ok(files.includes("notes/deep/plan.md") && files.includes("notes/blob.bin"));
    assert.ok(!files.includes("src/gone.txt"));
    assert.ok(!files.some((f) => f.startsWith("dist/") || f.startsWith("src-tauri/target") || f === "debug.log"));
    // A second pass sees nothing (the tree is gone) and does not touch the ref.
    assert.equal(retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], apply: true, ...OPTS }).candidates.length, 0);

    const back = restoreArchivedWorktree("unit-wip", { root: sanctuary });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(back.verified, true);
    assert.deepEqual(snapshot(wt, ["dist", "src-tauri/target", "debug.log"]), before);
    assert.equal(git(["status", "--porcelain", "--untracked-files=all"], wt), statusBefore);
    assert.equal(git(["write-tree"], wt), indexBefore, "index (staged half) restored");
    assert.equal(git(["rev-parse", "HEAD"], wt), branchTip);
    assert.equal(tryGit(["rev-parse", "--verify", "--quiet", "refs/vs-archive/unit-wip"], repo), null, "archive ref retired");
    assert.equal(git(["rev-parse", back.retiredRef], repo), ref, "kept under refs/vs-archive-restored/");
    // Restoring twice: nothing left to restore.
    assert.equal(restoreArchivedWorktree("unit-wip", { root: sanctuary }).reason, "no-archive");
  }));

test("restore fails closed: branch moved, path exists; the archive ref is kept", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const wt = addUnit(repo, sanctuary, "unit-moved");
    writeFile(wt, "notes/a.md", "a\n");
    const r = byUnit(retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], apply: true, ...OPTS }))["unit-moved"];
    assert.equal(r.action, "archived", JSON.stringify(r));
    mkdirSync(wt, { recursive: true });
    assert.equal(restoreArchivedWorktree("unit-moved", { root: sanctuary }).reason, "path-exists");
    rmSync(wt, { recursive: true });
    git(["branch", "-f", "unit-moved", "master"], repo);
    assert.equal(restoreArchivedWorktree("unit-moved", { root: sanctuary }).reason, "branch-moved");
    assert.ok(tryGit(["rev-parse", "--verify", "--quiet", "refs/vs-archive/unit-moved"], repo));
    assert.equal(restoreArchivedWorktree("../x", { root: sanctuary }).reason, "bad-unit-name");
  }));

test("links are never followed: not sized, not archived through, target survives removal, link recreated on restore", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const outside = join(root, "outside");
    writeFile(outside, "precious.bin", Buffer.alloc(1_000_000, 9));
    const wt = addUnit(repo, sanctuary, "unit-link");
    symlinkSync(outside, join(wt, "shared"), LINK_TYPE); // untracked link to a folder outside the tree
    mkdirSync(join(wt, "src-tauri/target"), { recursive: true });
    symlinkSync(outside, join(wt, "src-tauri/target/cache"), LINK_TYPE); // a link inside build output
    writeFile(wt, "notes/n.md", "n\n");

    const sc = scanWorktreeNoFollow(wt);
    assert.ok(sc.bytes < 1_000_000, `sized through a link: ${sc.bytes}`);
    assert.deepEqual(sc.links.map((l) => l.rel).sort(), ["shared", "src-tauri/target/cache"]);
    const plan = planWip(wt, { links: sc.links });
    assert.equal(plan.ok, true, plan.reason);
    assert.ok(!plan.entries.some((e) => e.rel.startsWith("shared")), "nothing archived through the link");

    const dry = byUnit(retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], ...OPTS }))["unit-link"];
    assert.equal(dry.action, "would-archive");
    assert.ok(dry.bytes < 1_000_000);
    assert.equal(dry.links, 1); // the build-output link is not recorded

    const r = byUnit(retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], apply: true, ...OPTS }))["unit-link"];
    assert.equal(r.action, "archived", JSON.stringify(r));
    assert.ok(!existsSync(wt));
    assert.equal(readFileSync(join(outside, "precious.bin")).length, 1_000_000, "link target untouched");

    const back = restoreArchivedWorktree("unit-link", { root: sanctuary });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.deepEqual(back.links.restored, ["shared"]);
    assert.ok(lstatSync(join(wt, "shared")).isSymbolicLink());
    assert.ok(existsSync(join(wt, "shared/precious.bin")));
    assert.equal(readFileSync(join(wt, "notes/n.md"), "utf8"), "n\n");
  }));

/** Remove a link (junction on Windows, symlink elsewhere) without touching its target. */
function unlinkLink(p) {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}
const archiveRefOf = (repo, unit) => tryGit(["rev-parse", "--verify", "--quiet", `refs/vs-archive/${unit}`], repo);

test("fail closed: an untracked link over a tracked path (replaced folder, staged delete under a link) keeps the tree", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const outside = join(root, "outside");
    writeFile(outside, "other.txt", "outside\n");
    // A tracked folder replaced by a junction/symlink: its tracked files must not be silently dropped from the WIP.
    const a = addUnit(repo, sanctuary, "unit-shadow");
    writeFile(a, "vendored/lib.txt", "tracked lib\n");
    git(["add", "."], a);
    git(["commit", "-q", "-m", "vendored"], a);
    rmSync(join(a, "vendored"), { recursive: true, force: true });
    symlinkSync(outside, join(a, "vendored"), LINK_TYPE);
    // A staged delete (gone from the index, still in HEAD) sitting under an untracked link.
    const b = addUnit(repo, sanctuary, "unit-staged-del");
    writeFile(b, "vendor2/a.txt", "tracked a\n");
    git(["add", "."], b);
    git(["commit", "-q", "-m", "vendor2"], b);
    git(["rm", "-q", "-r", "--cached", "vendor2"], b);
    rmSync(join(b, "vendor2"), { recursive: true, force: true });
    symlinkSync(outside, join(b, "vendor2"), LINK_TYPE);

    for (const wt of [a, b]) {
      const plan = planWip(wt, { links: scanWorktreeNoFollow(wt).links });
      assert.equal(plan.ok, false, `${wt}: ${JSON.stringify(plan.entries)}`);
      assert.equal(plan.reason, "untracked-link");
    }
    const agents = [archivedAgent("a", a), archivedAgent("b", b)];
    const dry = byUnit(retentionSweep({ root: sanctuary, agents, ...OPTS }));
    const res = byUnit(retentionSweep({ root: sanctuary, agents, apply: true, ...OPTS }));
    for (const u of ["unit-shadow", "unit-staged-del"]) {
      assert.equal(dry[u].reason, "untracked-link", JSON.stringify(dry[u]));
      assert.equal(res[u].reason, "untracked-link", JSON.stringify(res[u]));
      assert.equal(archiveRefOf(repo, u), null);
    }
    for (const p of [a, b]) assert.ok(existsSync(p));
    assert.equal(readFileSync(join(outside, "other.txt"), "utf8"), "outside\n");
  }));

test("archive re-checks live cwd / lock after the re-capture, right before removal; the ref is rolled back", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const wt = addUnit(repo, sanctuary, "unit-late-live");
    writeFile(wt, "notes/wip.md", "wip\n");
    let calls = 0;
    const res = archiveWorktree(repo, wt, { branch: "unit-late-live", beforeRef: () => (++calls === 1 ? null : "live-cwd") });
    assert.equal(res.archived, false, JSON.stringify(res));
    assert.equal(res.reason, "live-cwd");
    assert.equal(calls, 2);
    assert.ok(existsSync(join(wt, "notes/wip.md")));
    assert.equal(archiveRefOf(repo, "unit-late-live"), null, "archive ref rolled back");
  }));

test("archive re-capture compares link paths and targets, not just the count", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const outA = join(root, "outA");
    const outB = join(root, "outB");
    writeFile(outA, "a.txt", "a\n");
    writeFile(outB, "b.txt", "b\n");
    const wt = addUnit(repo, sanctuary, "unit-retarget");
    symlinkSync(outA, join(wt, "shared"), LINK_TYPE);
    let calls = 0;
    const res = archiveWorktree(repo, wt, {
      branch: "unit-retarget",
      beforeRef: () => {
        if (++calls === 1) {
          unlinkLink(join(wt, "shared")); // same count, new target: between the first capture and the re-capture
          symlinkSync(outB, join(wt, "shared"), LINK_TYPE);
        }
        return null;
      },
    });
    assert.equal(res.archived, false, JSON.stringify(res));
    assert.equal(res.reason, "changed-during-archive");
    assert.ok(existsSync(wt));
    assert.ok(existsSync(join(wt, "shared/b.txt")));
    assert.ok(existsSync(join(outA, "a.txt")) && existsSync(join(outB, "b.txt")), "link targets untouched");
    assert.equal(archiveRefOf(repo, "unit-retarget"), null);
  }));

test("apply holds the sweep lock: busy -> nothing archived", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const wt = addUnit(repo, sanctuary, "unit-busy");
    const release = acquireSweepLock(sanctuary);
    try {
      const res = retentionSweep({ root: sanctuary, agents: [archivedAgent("a1", wt)], apply: true, ...OPTS });
      assert.equal(res.busy, true);
      assert.ok(existsSync(wt));
      assert.equal(restoreArchivedWorktree("unit-busy", { root: sanctuary }).reason, "no-archive");
    } finally {
      release();
    }
  }));

test("fail closed: an existing archive ref, a nested repo, and an in-progress merge keep the tree", () =>
  withTmp((root) => {
    const { repo, sanctuary } = setup(root);
    const a = addUnit(repo, sanctuary, "unit-refexists");
    git(["update-ref", "refs/vs-archive/unit-refexists", "master"], repo);
    const b = addUnit(repo, sanctuary, "unit-nested");
    initRepo(join(b, "vendor/clone"));
    const c = addUnit(repo, sanctuary, "unit-merging");
    writeFileSync(join(git(["rev-parse", "--absolute-git-dir"], c), "MERGE_HEAD"), git(["rev-parse", "master"], repo) + "\n");
    const agents = [archivedAgent("a", a), archivedAgent("b", b), archivedAgent("c", c)];
    const res = byUnit(retentionSweep({ root: sanctuary, agents, apply: true, ...OPTS }));
    assert.equal(res["unit-refexists"].reason, "archive-ref-exists");
    assert.equal(res["unit-nested"].reason, "nested-repo");
    assert.equal(res["unit-merging"].reason, "git-op-in-progress");
    for (const p of [a, b, c]) assert.ok(existsSync(p));
  }));

test("CLI: retention/restore flags parse; --summary report ranks top candidates by size with build share", async () => {
  const { parseArgs, retentionReport } = await import("../cli/vs.mjs");
  const f = parseArgs(["worktree", "retention", "--days", "14", "--summary", "--limit", "3"]);
  assert.deepEqual([f._[1], f.days, f.summary, f.limit, Boolean(f.apply)], ["retention", "14", true, "3", false]);
  assert.equal(parseArgs(["worktree", "restore", "unit-x", "--repo", "C:/r"]).repo, "C:/r");
  const cand = (unit, bytes, buildBytes) => ({ repo: "r", unit, ownerState: "archived", lastTouchAgeDays: 9, bytes, buildBytes, dirtyFiles: 1, ignoredLost: 0, action: "would-archive" });
  const rep = retentionReport({ root: "/s", apply: false, days: 7, rosterKnown: true, summary: { candidates: 3 }, candidates: [cand("a", 10, 5), cand("b", 300, 270), cand("c", 0, 0)] }, 2);
  assert.deepEqual(rep.top.map((x) => [x.unit, x.bytes, x.buildShare]), [["b", 300, 0.9], ["a", 10, 0.5]]);
  assert.equal(rep.busy, false);
});
