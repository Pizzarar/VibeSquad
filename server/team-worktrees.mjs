// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): the opt-in "Also delete worktrees + branches" step.
// Only linked git worktrees are touched, never a main checkout. Nothing is forced: `git worktree remove`
// refuses a dirty worktree and `git branch -d` refuses an unmerged branch, and both come back as "kept"
// with git's reason so the dialog can say why.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 }).trim();
}

const gitError = (e) => String(e?.stderr || e?.message || e).trim().split(/\r?\n/)[0];

/**
 * Remove each worktree and its branch. `items` are { path, branch? } from the confirm dialog.
 * Returns one result per item: { path, branch, worktree: "removed" | "kept" | "missing", branchResult, reason? }.
 */
export function removeTeamWorktrees(items, { git = defaultGit, exists = existsSync } = {}) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const path = String(raw?.path ?? "").trim();
    let branch = String(raw?.branch ?? "").trim();
    const r = { path, branch: branch || null, worktree: "kept", branchResult: "kept" };
    out.push(r);
    if (!path || !isAbsolute(path)) {
      r.reason = "not an absolute path";
      continue;
    }
    if (!exists(path)) {
      r.worktree = "missing";
      r.reason = "folder already gone";
      continue;
    }
    let gitDir, commonDir;
    try {
      gitDir = resolve(path, git(["rev-parse", "--git-dir"], path));
      commonDir = resolve(path, git(["rev-parse", "--git-common-dir"], path));
    } catch (e) {
      r.reason = `not a git worktree (${gitError(e)})`;
      continue;
    }
    if (gitDir.toLowerCase() === commonDir.toLowerCase()) {
      r.reason = "main checkout, not a worktree";
      continue;
    }
    const repoRoot = dirname(commonDir);
    if (!branch) {
      try {
        const head = git(["rev-parse", "--abbrev-ref", "HEAD"], path);
        if (head && head !== "HEAD") branch = head;
      } catch {}
      r.branch = branch || null;
    }
    try {
      git(["worktree", "remove", path], repoRoot);
      r.worktree = "removed";
    } catch (e) {
      r.reason = gitError(e);
      continue;
    }
    if (!branch) {
      r.branchResult = "none";
    } else if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
      r.branchResult = "kept";
      r.reason = `${branch} is never deleted`;
    } else {
      try {
        git(["branch", "-d", branch], repoRoot);
        r.branchResult = "deleted";
      } catch (e) {
        r.reason = gitError(e);
      }
    }
  }
  return out;
}

/**
 * A path segment safe to use as a folder name: strips trailing slashes and a trailing `.git`,
 * then keeps only `[A-Za-z0-9._-]` (runs of anything else collapse to a single `-`).
 */
function safeSlug(value) {
  let s = String(value ?? "");
  s = s.replace(/[\\/]+$/, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/[^A-Za-z0-9._-]+/g, "-");
  s = s.replace(/^-+/, "").replace(/-+$/, "");
  return s;
}

/**
 * The root folder that holds all managed git worktrees, kept out of the user's `projects` folder.
 *   - VIBESQUAD_WORKTREES_DIR (when set) wins.
 *   - On Windows with LOCALAPPDATA: `%LOCALAPPDATA%\VibeSquad\worktrees`.
 *   - Otherwise: `~/.vibesquad/worktrees`.
 */
export function resolveManagedWorktreeRoot(env = process.env) {
  if (env.VIBESQUAD_WORKTREES_DIR) {
    return resolve(env.VIBESQUAD_WORKTREES_DIR);
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return resolve(env.LOCALAPPDATA, "VibeSquad", "worktrees");
  }
  return resolve(homedir(), ".vibesquad", "worktrees");
}

/**
 * The managed sanctuary path for a repo + branch/unit, e.g.
 * `%LOCALAPPDATA%\VibeSquad\worktrees\main-project\bug-chaser-unit-1`.
 */
export function resolveManagedWorktreePath(repoRootOrName, branchOrUnit, env = process.env) {
  const repoName = safeSlug(basename(String(repoRootOrName)));
  const unitSlug = safeSlug(String(branchOrUnit));
  return resolve(resolveManagedWorktreeRoot(env), repoName, unitSlug);
}

/**
 * Create a managed worktree for `repoRoot` on `branch`, rooted under the sanctuary.
 * Returns { path, branch, repoRoot }.
 */
export function createManagedWorktree(repoRoot, branch, { baseRef = "HEAD", git = defaultGit, env = process.env } = {}) {
  const dest = resolveManagedWorktreePath(repoRoot, branch, env);
  mkdirSync(dirname(dest), { recursive: true });
  git(["worktree", "add", "-f", "-B", branch, dest, baseRef], repoRoot);
  return { path: dest, branch, repoRoot: resolve(repoRoot) };
}

/**
 * Parse `git worktree list --porcelain` into `[{ path, head, branch, bare, prunable }]`
 * where `branch` has the `refs/heads/` prefix stripped.
 */
export function listRepoWorktrees(repoRoot, { git = defaultGit } = {}) {
  const raw = String(git(["worktree", "list", "--porcelain"], repoRoot) ?? "");
  const out = [];
  for (const block of raw.split(/\n[ \t]*\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    let wt;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wt = { path: line.slice("worktree ".length), head: "", branch: "", bare: false, prunable: false };
        break;
      }
    }
    if (!wt) continue;
    for (const line of lines) {
      if (line.startsWith("HEAD ")) wt.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare") wt.bare = true;
      else if (line === "prunable") wt.prunable = true;
    }
    out.push(wt);
  }
  return out;
}

/**
 * Remove linked worktrees whose branch is fully merged into `targetBranch` and whose working tree is
 * clean. The main checkout is never touched. Dry-run (`apply: false`) reports what would happen.
 * Returns { repoRoot, apply, results }.
 */
export function sweepMergedWorktrees(
  repoRoot,
  { targetBranch = "master", apply = false, git = defaultGit, exists = existsSync } = {},
) {
  const repoRootAbs = resolve(repoRoot);
  const wts = listRepoWorktrees(repoRoot, { git });
  const results = [];
  wts.forEach((wt, i) => {
    // Skip the main checkout: it is listed first, and its path is the repo root.
    if (i === 0 || resolve(wt.path) === repoRootAbs) return;

    let merged = false;
    if (wt.branch && !PROTECTED_BRANCHES.has(wt.branch.toLowerCase())) {
      try {
        git(["merge-base", "--is-ancestor", wt.branch, targetBranch], repoRoot);
        merged = true;
      } catch {
        merged = false;
      }
    }

    let clean = false;
    try {
      clean = String(git(["status", "--porcelain"], wt.path) ?? "").trim() === "";
    } catch {
      clean = false;
    }

    const r = { path: wt.path, branch: wt.branch || null, merged, clean };
    if (merged && clean) {
      if (apply) {
        removeTeamWorktrees([{ path: wt.path, branch: wt.branch }], { git, exists });
        r.action = "removed";
      } else {
        r.action = "would-remove";
      }
    } else {
      r.action = "kept";
      r.reason = clean ? "unmerged" : "dirty";
    }
    results.push(r);
  });

  if (apply) {
    try {
      git(["worktree", "prune"], repoRoot);
    } catch {
      // prune is best-effort
    }
  }
  return { repoRoot: repoRootAbs, apply, results };
}

/**
 * Audit the immediate subdirectories of `projectsDir` and clean up linked git worktrees that were
 * accidentally created directly inside `projects/`. Real top-level product checkouts (`.git` is a
 * directory) are never touched. Merged clean linked worktrees are removed; unmerged clean linked
 * worktrees are moved into the managed sanctuary; dirty linked worktrees are reported and left alone.
 * Returns { projectsDir, apply, items }.
 */
export function cleanupProjectsFolder(
  projectsDir,
  { apply = false, git = defaultGit, exists = existsSync, env = process.env } = {},
) {
  const projectsDirAbs = resolve(projectsDir);
  const items = [];
  let entries;
  try {
    entries = readdirSync(projectsDirAbs, { withFileTypes: true });
  } catch {
    return { projectsDir: projectsDirAbs, apply, items };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = resolve(projectsDirAbs, entry.name);
    const dotGit = resolve(dirPath, ".git");

    let st;
    try {
      st = statSync(dotGit);
    } catch {
      items.push({ path: dirPath, kind: "other", action: "kept" });
      continue;
    }

    if (st.isDirectory()) {
      items.push({ path: dirPath, kind: "product", action: "kept" });
      continue;
    }
    if (!st.isFile()) {
      items.push({ path: dirPath, kind: "other", action: "kept" });
      continue;
    }

    // A `.git` file -> linked git worktree cluttering `projects/`.
    let commonDir, repoRoot, branch = "";
    try {
      commonDir = resolve(dirPath, git(["rev-parse", "--git-common-dir"], dirPath));
      repoRoot = dirname(commonDir);
      branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"], dirPath) ?? "").trim();
    } catch {
      items.push({ path: dirPath, kind: "worktree", action: "kept", reason: "not-a-worktree" });
      continue;
    }

    let clean = false;
    try {
      clean = String(git(["status", "--porcelain"], dirPath) ?? "").trim() === "";
    } catch {
      clean = false;
    }

    let merged = false;
    if (branch && branch !== "HEAD") {
      for (const tb of ["master", "main"]) {
        try {
          git(["merge-base", "--is-ancestor", branch, tb], repoRoot);
          merged = true;
          break;
        } catch {
          // not an ancestor of this target; try the other
        }
      }
    }

    const base = { path: dirPath, kind: "worktree", branch: branch || null, clean, merged };
    if (clean && merged) {
      if (apply) {
        removeTeamWorktrees([{ path: dirPath, branch }], { git, exists });
        items.push({ ...base, action: "removed-merged" });
      } else {
        items.push({ ...base, action: "would-remove-merged" });
      }
    } else {
      const targetPath = resolveManagedWorktreePath(repoRoot, basename(dirPath), env);
      if (apply && clean) {
        mkdirSync(dirname(targetPath), { recursive: true });
        git(["worktree", "move", dirPath, targetPath], repoRoot);
        items.push({ ...base, action: "moved-to-sanctuary", targetPath });
      } else {
        items.push({ ...base, action: apply ? "kept-dirty" : "would-move-to-sanctuary", targetPath });
      }
    }
  }
  return { projectsDir: projectsDirAbs, apply, items };
}
