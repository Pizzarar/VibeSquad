// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): the opt-in "Also delete worktrees + branches" step.
// Only linked git worktrees are touched, never a main checkout. Nothing is forced: `git worktree remove`
// refuses a dirty worktree and `git branch -d` refuses an unmerged branch, and both come back as "kept"
// with git's reason so the dialog can say why.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

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
