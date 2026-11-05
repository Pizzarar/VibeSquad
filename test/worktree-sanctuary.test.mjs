// Managed worktree sanctuary: keep git worktrees out of the user's `projects` folder.
// Covers resolveManagedWorktreeRoot/Path, createManagedWorktree, sweepMergedWorktrees,
// cleanupProjectsFolder (server/team-worktrees.mjs), and the managed-path fallback in
// server/identity.mjs (extractManagedWorktreeRepoName + matchPathInRegistry).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import {
  cleanupProjectsFolder,
  createManagedWorktree,
  listRepoWorktrees,
  resolveManagedWorktreePath,
  resolveManagedWorktreeRoot,
  sweepMergedWorktrees,
} from "../server/team-worktrees.mjs";
import { extractManagedWorktreeRepoName, matchPathInRegistry } from "../server/identity.mjs";

const runGit = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 30_000,
  }).trim();

function initRepo(dir, { branch = "master" } = {}) {
  execFileSync("git", ["init", "-q", "-b", branch, dir], { windowsHide: true });
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], dir);
}

// ── 1. Path resolution ─────────────────────────────────────────────────────────

test("resolveManagedWorktreeRoot honors VIBESQUAD_WORKTREES_DIR, LOCALAPPDATA, and the ~/.vibesquad fallback", () => {
  assert.equal(
    resolveManagedWorktreeRoot({ VIBESQUAD_WORKTREES_DIR: "/custom/worktrees" }),
    resolve("/custom/worktrees"),
  );
  assert.equal(
    resolveManagedWorktreeRoot({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
    resolve("C:\\Users\\me\\AppData\\Local", "VibeSquad", "worktrees"),
  );
  assert.equal(resolveManagedWorktreeRoot({}), resolve(homedir(), ".vibesquad", "worktrees"));
});

test("resolveManagedWorktreePath slugs the repo name and branch/unit", () => {
  const env = { VIBESQUAD_WORKTREES_DIR: "/wt" };
  assert.equal(
    resolveManagedWorktreePath("C:\\repos\\main-project.git", "bug-chaser/unit-1", env),
    resolve("/wt", "main-project", "bug-chaser-unit-1"),
  );
  assert.equal(
    resolveManagedWorktreePath("main-project", "unit-1", env),
    resolve("/wt", "main-project", "unit-1"),
  );
  assert.equal(
    resolveManagedWorktreePath("main-project", "branch with spaces//", env),
    resolve("/wt", "main-project", "branch-with-spaces"),
  );
});

// ── 2. createManagedWorktree + sweepMergedWorktrees ────────────────────────────

test("createManagedWorktree + sweepMergedWorktrees removes merged clean worktrees and keeps dirty/unmerged ones", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-sanctuary-"));
  const wtDir = resolve(root, "sanctuary");
  const env = { VIBESQUAD_WORKTREES_DIR: wtDir };
  try {
    const repo = join(root, "repo");
    initRepo(repo);

    const merged = createManagedWorktree(repo, "unit-merged", { env });
    assert.equal(merged.branch, "unit-merged");
    assert.equal(merged.path, resolve(wtDir, "repo", "unit-merged"));
    assert.ok(existsSync(merged.path));

    const dirty = createManagedWorktree(repo, "unit-dirty", { env });
    writeFileSync(join(dirty.path, "x.txt"), "x");

    const unmerged = createManagedWorktree(repo, "unit-unmerged", { env });
    runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "wip"], unmerged.path);

    const listed = listRepoWorktrees(repo);
    assert.ok(listed.length >= 4, "main + three linked worktrees");
    assert.equal(resolve(listed[0].path), resolve(repo), "main checkout is listed first");

    // Dry run: nothing is removed.
    const dry = sweepMergedWorktrees(repo, { targetBranch: "master", apply: false });
    const dryByBranch = Object.fromEntries(dry.results.map((r) => [r.branch, r]));
    assert.equal(dryByBranch["unit-merged"].action, "would-remove");
    assert.equal(dryByBranch["unit-dirty"].action, "kept");
    assert.equal(dryByBranch["unit-dirty"].reason, "dirty");
    assert.equal(dryByBranch["unit-unmerged"].action, "kept");
    assert.equal(dryByBranch["unit-unmerged"].reason, "unmerged");
    assert.ok(existsSync(merged.path), "dry run must not remove");

    // Apply: only the merged clean worktree goes away.
    const res = sweepMergedWorktrees(repo, { targetBranch: "master", apply: true });
    const byBranch = Object.fromEntries(res.results.map((r) => [r.branch, r]));
    assert.equal(byBranch["unit-merged"].action, "removed");
    assert.equal(byBranch["unit-dirty"].action, "kept");
    assert.equal(byBranch["unit-unmerged"].action, "kept");
    assert.ok(!existsSync(merged.path), "merged worktree removed from disk");
    assert.ok(existsSync(dirty.path));
    assert.ok(existsSync(unmerged.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. cleanupProjectsFolder ───────────────────────────────────────────────────

test("cleanupProjectsFolder never touches products, removes merged spam, and moves unmerged spam to the sanctuary", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-projects-"));
  const sanctuary = join(root, "sanctuary");
  const env = { VIBESQUAD_WORKTREES_DIR: sanctuary };
  try {
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });

    // A real top-level product.
    const product = join(projects, "MyProduct");
    initRepo(product);

    // The hub repo the spam worktrees link from (also a product sitting in projects/).
    const hub = join(projects, "HubRepo");
    initRepo(hub);

    // Merged linked worktree clutter.
    const mergedSpam = join(projects, "HubRepo-unit-merged");
    runGit(["worktree", "add", "-q", "-b", "unit-merged", mergedSpam], hub);

    // Unmerged linked worktree clutter (extra commit not in master).
    const unmergedSpam = join(projects, "HubRepo-unit-unmerged");
    runGit(["worktree", "add", "-q", "-b", "unit-unmerged", unmergedSpam], hub);
    runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "wip"], unmergedSpam);

    // Dry run.
    const dry = cleanupProjectsFolder(projects, { apply: false, env });
    const dryByName = Object.fromEntries(dry.items.map((i) => [basename(i.path), i]));
    assert.equal(dryByName["MyProduct"].kind, "product");
    assert.equal(dryByName["MyProduct"].action, "kept");
    assert.equal(dryByName["HubRepo"].kind, "product");
    assert.equal(dryByName["HubRepo"].action, "kept");
    assert.equal(dryByName["HubRepo-unit-merged"].action, "would-remove-merged");
    assert.equal(dryByName["HubRepo-unit-unmerged"].action, "would-move-to-sanctuary");
    assert.equal(
      dryByName["HubRepo-unit-unmerged"].targetPath,
      resolveManagedWorktreePath(hub, "HubRepo-unit-unmerged", env),
    );
    assert.ok(existsSync(mergedSpam), "dry run leaves merged spam in place");
    assert.ok(existsSync(unmergedSpam), "dry run leaves unmerged spam in place");

    // Apply.
    const applied = cleanupProjectsFolder(projects, { apply: true, env });
    const byName = Object.fromEntries(applied.items.map((i) => [basename(i.path), i]));
    assert.equal(byName["MyProduct"].action, "kept");
    assert.equal(byName["HubRepo"].action, "kept");
    assert.equal(byName["HubRepo-unit-merged"].action, "removed-merged");
    assert.equal(byName["HubRepo-unit-unmerged"].action, "moved-to-sanctuary");
    assert.ok(!existsSync(mergedSpam), "merged spam removed from projects/");
    assert.ok(!existsSync(unmergedSpam), "unmerged spam moved out of projects/");
    assert.ok(existsSync(byName["HubRepo-unit-unmerged"].targetPath), "unmerged spam now in the sanctuary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupProjectsFolder leaves a dirty linked worktree in projects/", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-projects-dirty-"));
  const env = { VIBESQUAD_WORKTREES_DIR: join(root, "sanctuary") };
  try {
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });
    const hub = join(projects, "HubRepo");
    initRepo(hub);

    const dirtySpam = join(projects, "HubRepo-unit-dirty");
    runGit(["worktree", "add", "-q", "-b", "unit-dirty", dirtySpam], hub);
    writeFileSync(join(dirtySpam, "x.txt"), "x");

    const dry = cleanupProjectsFolder(projects, { apply: false, env });
    assert.equal(Object.fromEntries(dry.items.map((i) => [basename(i.path), i]))["HubRepo-unit-dirty"].action, "would-move-to-sanctuary");

    const applied = cleanupProjectsFolder(projects, { apply: true, env });
    const item = Object.fromEntries(applied.items.map((i) => [basename(i.path), i]))["HubRepo-unit-dirty"];
    assert.equal(item.action, "kept-dirty");
    assert.ok(existsSync(dirtySpam), "dirty worktree is not moved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. identity: managed sanctuary path → team ─────────────────────────────────

test("extractManagedWorktreeRepoName pulls the repo name out of a sanctuary path, else null", () => {
  assert.equal(
    extractManagedWorktreeRepoName("C:\\Users\\me\\AppData\\Local\\VibeSquad\\worktrees\\main-project\\unit-1"),
    "main-project",
  );
  assert.equal(
    extractManagedWorktreeRepoName("/home/me/.vibesquad/worktrees/main-project/unit-1"),
    "main-project",
  );
  assert.equal(extractManagedWorktreeRepoName("C:\\projects\\VibeSquad\\src"), null);
  assert.equal(extractManagedWorktreeRepoName(""), null);
  assert.equal(extractManagedWorktreeRepoName(null), null);
});

test("matchPathInRegistry resolves a managed sanctuary path to its team", () => {
  const teams = [
    { id: "efi", name: "Main Game", paths: ["main-project"], lanes: [{ id: "main-game", name: "Main Game" }] },
    { id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "vibesquad", name: "VibeSquad" }] },
  ];
  // The `.git` file does not exist on disk (a plain string path), so resolveWorktreeRootPath is null.
  const m = matchPathInRegistry("C:\\Users\\me\\AppData\\Local\\VibeSquad\\worktrees\\main-project\\unit-1", teams);
  assert.ok(m, "expected a match for the sanctuary path");
  assert.equal(m.team.id, "efi");
  assert.equal(m.lane.id, "main-game");
});
