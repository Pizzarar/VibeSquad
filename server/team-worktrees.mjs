// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): the opt-in "Also delete worktrees + branches" step.
// Only linked git worktrees are touched, never a main checkout. Nothing is forced: `git worktree remove`
// refuses a dirty worktree and `git branch -d` refuses an unmerged branch, and both come back as "kept"
// with git's reason so the dialog can say why.
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000, maxBuffer: 64 << 20 }).trim();
}

// idea-249 L1: git's stderr quotes host paths ('C:\\...\\wt' contains modified files) and execFileSync's message is the
// whole command line: the full text goes to the server log, the reason keeps git's first stderr line with paths masked.
const QUOTED_HOST_PATH = /'(?:[A-Za-z]:[\\/]|\/|\\\\)[^']*'/g;
const gitError = (e) => {
  const first = String(e?.stderr ?? "").trim().split(/\r?\n/)[0];
  console.warn(`[vibesquad] git failed: ${String(e?.stderr || e?.message || e).trim()}`);
  return first ? first.replace(QUOTED_HOST_PATH, "'<path>'") : `git failed${Number.isInteger(e?.status) ? ` (exit ${e.status})` : ""}; see the server log`;
};

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
    // A node_modules junction (see linkNodeModules) must be detached, never recursed into: git/rm walking it
    // would delete the main checkout's real node_modules.
    unlinkNodeModulesLink(path);
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
  let nodeModules = "none";
  try {
    nodeModules = linkNodeModules(repoRoot, dest, git);
  } catch {
    // best-effort: a worker can still npm ci
  }
  return { path: dest, branch, repoRoot: resolve(repoRoot), nodeModules };
}

/**
 * Junction the worktree's node_modules to the main checkout's (idea-79), so workers do not need npm ci.
 * Idempotent; never replaces a real node_modules. The repo .gitignore pattern `node_modules/` only matches a
 * directory, and git sees a junction as a symlink, so `/node_modules` is also added to info/exclude to keep the
 * link untracked (else it shows dirty and sweep keeps the worktree).
 * Returns "linked" | "exists" | "no-source".
 */
export function linkNodeModules(repoRoot, dest, git = defaultGit) {
  const src = resolve(repoRoot, "node_modules");
  const link = resolve(dest, "node_modules");
  if (!existsSync(src) || !statSync(src).isDirectory()) return "no-source";
  let present = false;
  try {
    lstatSync(link);
    present = true;
  } catch {}
  if (present) return "exists";
  symlinkSync(src, link, "junction");
  try {
    const common = resolve(repoRoot, git(["rev-parse", "--git-common-dir"], repoRoot));
    const exclude = resolve(common, "info", "exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split(/\r?\n/).includes("/node_modules")) {
      appendFileSync(exclude, (cur && !cur.endsWith("\n") ? "\n" : "") + "/node_modules\n");
    }
  } catch {}
  return "linked";
}

/** Remove only the link itself when <wt>/node_modules is a symlink/junction. Returns true if detached. */
export function unlinkNodeModulesLink(wtPath) {
  const link = resolve(wtPath, "node_modules");
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link); // non-recursive: fails on a real dir rather than emptying it
  }
  return true;
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
        wt = { path: line.slice("worktree ".length), head: "", branch: "", bare: false, prunable: false, locked: false };
        break;
      }
    }
    if (!wt) continue;
    for (const line of lines) {
      if (line.startsWith("HEAD ")) wt.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare") wt.bare = true;
      else if (line === "prunable" || line.startsWith("prunable ")) wt.prunable = true;
      else if (line === "locked" || line.startsWith("locked ")) wt.locked = true;
      else if (line === "detached") wt.detached = true;
    }
    out.push(wt);
  }
  return out;
}

// ── W1 (docs/PLAN_DISK_LIFECYCLE_1121.md; idea-464 parts 1+2, idea-424): sweep correctness ──────────────────────────
// Invariants (Tier A): never remove a dirty worktree, an unmerged one, or one a live agent's cwd points at; never delete a
// branch ref (the sweep's removal keeps every branch, so a wrong "merged" verdict can only cost a checkout, never a commit);
// the worktree itself goes through `git worktree remove` without --force, so git's own clean check is the last word.

/** Untracked build output: a worktree whose only untracked entries are these still counts as clean for the sweep. */
export const BUILD_OUTPUT_DIRS = Object.freeze(["node_modules", "target", ".godot", "dist", ".vite"]);
const BUILD_OUTPUT_SET = new Set(BUILD_OUTPUT_DIRS);

/** A worktree younger than this with no commit of its own is "fresh" (made for a unit that has not started): never swept. */
export const FRESH_GRACE_MS = 2 * 60 * 60_000;
/** Commits of the default branch scanned for a tree match (squash merges). */
const TREE_SCAN_MAX = 50_000;

const tryGit = (git, args, cwd) => {
  try {
    return String(git(args, cwd) ?? "");
  } catch {
    return null;
  }
};
const normPath = (p) => {
  let s = resolve(String(p));
  try {
    s = realpathSync.native(s);
  } catch {}
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
const isInside = (child, parent) => {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p + "/");
};

/**
 * Is `rel` (an untracked entry of `git ls-files --others --directory`, relative to `wtPath`) build output? One of its
 * segments must be a BUILD_OUTPUT_DIRS name, and the entry must sit at or under that segment. `target` counts only next to
 * a Cargo.toml (so a new `src/target/` source module is not mistaken for cargo output).
 */
export function isBuildOutputEntry(wtPath, rel) {
  const segs = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.includes("..")) return false;
  for (let i = 0; i < segs.length; i++) {
    if (!BUILD_OUTPUT_SET.has(segs[i])) continue;
    if (segs[i] !== "target") return true;
    if (existsSync(resolve(wtPath, ...segs.slice(0, i), "Cargo.toml"))) return true;
  }
  return false;
}

const UNTRACKED_DIR_SCAN_MAX = 5_000;

/**
 * Split a wholly untracked folder `rel` (relative to `wtPath`, trailing slash) into its build-output subfolders and any
 * other entries, walking without following links and without descending into build output. Returns null (read as dirty)
 * on a read error or past UNTRACKED_DIR_SCAN_MAX entries.
 */
function splitUntrackedDir(wtPath, rel) {
  const build = [];
  const other = [];
  let seen = 0;
  const walk = (relDir) => {
    for (const d of readdirSync(resolve(wtPath, relDir), { withFileTypes: true })) {
      if (++seen > UNTRACKED_DIR_SCAN_MAX) throw new Error("too many entries");
      const childRel = `${relDir}${d.name}`;
      if (d.isDirectory() && !d.isSymbolicLink() && isBuildOutputEntry(wtPath, `${childRel}/`)) build.push(`${childRel}/`);
      else if (d.isDirectory() && !d.isSymbolicLink()) walk(`${childRel}/`);
      else other.push(childRel);
    }
  };
  try {
    walk(String(rel).replace(/\\/g, "/").replace(/\/*$/, "/"));
  } catch {
    return null;
  }
  return { build, other };
}

/**
 * The worktree's dirt, split: tracked changes (always dirty), untracked build output (ignored), other untracked files
 * (dirty). `clean` is false when git can't read the tree.
 */
export function worktreeDirt(wtPath, { git = defaultGit } = {}) {
  const tracked = tryGit(git, ["status", "--porcelain", "--untracked-files=no"], wtPath);
  const others = tryGit(git, ["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"], wtPath);
  if (tracked === null || others === null) return { clean: false, error: true, tracked: 0, untracked: [], buildOutput: [] };
  const trackedCount = tracked.split(/\r?\n/).filter((l) => l.trim()).length;
  const buildOutput = [];
  const untracked = [];
  for (const p of others.split("\0").filter(Boolean)) {
    if (isBuildOutputEntry(wtPath, p)) buildOutput.push(p);
    else if (/[\\/]$/.test(p)) {
      // `--directory` collapses a wholly untracked folder (sub/ holding only sub/dist/): look inside it.
      const x = splitUntrackedDir(wtPath, p);
      if (x) buildOutput.push(...x.build);
      if (!x || x.other.length) untracked.push(p);
    } else untracked.push(p);
  }
  return { clean: trackedCount === 0 && untracked.length === 0, error: false, tracked: trackedCount, untracked, buildOutput };
}

/**
 * The repo's default branch and the refs to test against: origin/HEAD's name when set, else main, else master (or
 * `preferred` alone). `refs` holds the local branch and origin's copy, whichever exist (no fetch: a unit merged upstream but
 * not pulled is still seen through origin/<name>). idea-424: the old sweep tested a hardcoded `master`, which does not exist
 * in a main-only repo, so every merge-base call failed and read as unmerged.
 */
export function detectDefaultBranch(repoRoot, { git = defaultGit, preferred } = {}) {
  const has = (ref) => tryGit(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot) !== null;
  const names = [];
  if (preferred) names.push(String(preferred));
  else {
    const o = tryGit(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
    const n = o ? o.trim().replace(/^origin\//, "") : "";
    if (n) names.push(n);
    for (const d of ["main", "master"]) if (!names.includes(d)) names.push(d);
  }
  for (const name of names) {
    const refs = [`refs/heads/${name}`, `refs/remotes/origin/${name}`].filter(has);
    if (refs.length) return { name, refs };
  }
  return { name: null, refs: [] };
}

/**
 * Is commit `head` merged into any of `refs`? In order: ancestry (fast-forward and merge-commit PRs), a tree match (head's
 * tree equals a commit on the default branch: squash merges), then `git cherry` (every non-merge commit patch-equivalent
 * upstream: cherry-picks, rebase merges). Any git error reads as not merged (fail closed). Returns { merged, how, ref }.
 */
export function mergedStatus(repoRoot, head, refs, { git = defaultGit, treeCache = new Map() } = {}) {
  if (!head || !refs?.length) return { merged: false, how: null, ref: null };
  for (const ref of refs) {
    if (tryGit(git, ["merge-base", "--is-ancestor", head, ref], repoRoot) !== null) return { merged: true, how: "ancestor", ref };
  }
  const tree = tryGit(git, ["rev-parse", `${head}^{tree}`], repoRoot)?.trim();
  if (tree) {
    for (const ref of refs) {
      if (!treeCache.has(ref)) {
        const byTree = new Map(); // tree -> commits on ref carrying it
        const out = tryGit(git, ["log", "--format=%T %H", `--max-count=${TREE_SCAN_MAX}`, ref], repoRoot) ?? "";
        for (const line of out.split(/\r?\n/)) {
          const [t, c] = line.trim().split(" ");
          if (t && c) byTree.set(t, [...(byTree.get(t) ?? []), c]);
        }
        treeCache.set(ref, byTree);
      }
      // The matching commit must not be one head already contains: an empty commit, or work reverted back to the fork
      // point, has the base's tree but merged nothing. A merge-base error skips the commit (fail closed).
      for (const c of (treeCache.get(ref).get(tree) ?? []).slice(0, 8)) {
        const mb = tryGit(git, ["merge-base", c, head], repoRoot)?.trim();
        if (mb && mb !== c) return { merged: true, how: "tree", ref };
      }
    }
  }
  // git cherry last: it patch-ids every upstream commit since the fork point, the slow check on old branches.
  for (const ref of refs) {
    const out = tryGit(git, ["cherry", ref, head], repoRoot);
    if (out === null) continue;
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => l.startsWith("- "))) return { merged: true, how: "cherry", ref };
  }
  return { merged: false, how: null, ref: null };
}

/**
 * cwds of agents that may still be working: everything not archived, except a closed agent with no resumable session.
 * `lost` agents stay in (the process may still run).
 */
export function liveAgentCwds(agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.archivedAt || a.archived) continue;
    if (a.status === "closed" && a.resumable !== true) continue;
    const cwd = String(a.cwd ?? a.config?.cwd ?? "").trim();
    if (cwd) out.push(cwd);
  }
  return out;
}

/** True when some cwd in `cwds` is `wtPath` or inside it. */
export const cwdHoldsWorktree = (wtPath, cwds) => (cwds ?? []).some((c) => c && isInside(c, wtPath));

/**
 * `refs` minus any ref at the same commit as an earlier one (local master == origin/master: test it once). A ref that
 * does not resolve is kept, so mergedStatus still sees it (and fails closed on it).
 */
function distinctRefs(repoRoot, refs, git) {
  const seen = new Set();
  return (refs ?? []).filter((ref) => {
    const id = tryGit(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot)?.trim();
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The worktree's private git dir (from its `.git` file), or null. */
function worktreeGitDir(wtPath) {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(resolve(wtPath, ".git"), "utf8"));
    return m ? resolve(wtPath, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Fresh: created less than `graceMs` ago (its `.git` file's mtime) and HEAD never moved to another commit since then.
 * `git worktree add -b` writes two reflog lines (the creation, from the zero id, and a no-op "reset: moving to HEAD"), so
 * entries from the zero id or with old == new do not count. An unreadable age or reflog reads as fresh (kept).
 */
function isFreshWorktree(wtPath, now, graceMs) {
  if (!(graceMs > 0)) return false;
  let age;
  try {
    age = now - statSync(resolve(wtPath, ".git")).mtimeMs;
  } catch {
    return true; // unreadable: treat as fresh (kept)
  }
  if (age >= graceMs) return false;
  try {
    const lines = readFileSync(resolve(worktreeGitDir(wtPath), "logs", "HEAD"), "utf8").split(/\r?\n/).filter(Boolean);
    return !lines.some((l) => {
      const [oldId, newId] = l.split(" ");
      return !/^0+$/.test(oldId) && oldId !== newId;
    });
  } catch {
    return true;
  }
}

/** Delete `abs` without ever following a symlink or junction (a link is unlinked, never recursed into). */
function removeTreeNoFollow(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(abs);
    } catch {
      rmdirSync(abs); // a junction: non-recursive, removes only the link
    }
    return;
  }
  if (!st.isDirectory()) {
    try {
      unlinkSync(abs);
    } catch {
      chmodSync(abs, 0o666); // read-only build artifacts on Windows
      unlinkSync(abs);
    }
    return;
  }
  for (const name of readdirSync(abs)) removeTreeNoFollow(join(abs, name));
  rmdirSync(abs);
}

/** Detach build-output links at the worktree root and one level down (e.g. src-tauri/target): `git worktree remove` must not walk them. */
function detachBuildOutputLinks(wtPath) {
  unlinkNodeModulesLink(wtPath);
  const tops = [wtPath];
  try {
    for (const d of readdirSync(wtPath, { withFileTypes: true })) if (d.isDirectory() && d.name !== ".git") tops.push(join(wtPath, d.name));
  } catch {}
  for (const dir of tops) {
    for (const name of BUILD_OUTPUT_DIRS) {
      const p = join(dir, name);
      try {
        if (!lstatSync(p).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      try {
        unlinkSync(p);
      } catch {
        try {
          rmdirSync(p);
        } catch {}
      }
    }
  }
}

/**
 * Remove one swept worktree and keep its branch. Untracked build output is deleted first (links unlinked, never followed),
 * then plain `git worktree remove` (no --force), which refuses anything that turned dirty since the check.
 * Returns { removed: true } or { removed: false, reason }.
 */
export function removeSweptWorktree(repoRoot, wtPath, { git = defaultGit, buildOutput = [] } = {}) {
  try {
    detachBuildOutputLinks(wtPath);
    for (const rel of buildOutput) {
      const abs = resolve(wtPath, rel);
      if (!isInside(abs, wtPath) || normPath(abs) === normPath(wtPath)) continue;
      removeTreeNoFollow(abs);
    }
  } catch (e) {
    return { removed: false, reason: `build output not removed (${e?.code ?? "error"})` };
  }
  try {
    git(["worktree", "remove", wtPath], repoRoot);
    return { removed: true };
  } catch (e) {
    return { removed: false, reason: gitError(e) };
  }
}

/** Bytes under `abs`, never following links (a node_modules junction counts as 0). */
export function dirBytesNoFollow(abs) {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(p)) stack.push(join(p, name));
      } catch {}
    } else total += st.size;
  }
  return total;
}

/**
 * Sweep one repo's linked worktrees: remove those that are merged (ancestor / cherry / tree, see mergedStatus), clean (build
 * output aside) and not held by a live agent's cwd. The main checkout, default-branch checkouts, locked and prunable
 * worktrees are never touched. Options:
 *   targetBranch   default branch name; omitted: detectDefaultBranch (main or master). `targetRefs` overrides both.
 *   apply          false (default) reports only.
 *   liveCwds       live agents' cwds (liveAgentCwds). Required to apply: null/undefined keeps every worktree on apply.
 *   sanctuaryRoot  when set, worktrees outside it are kept ("outside-sanctuary").
 *   only           optional predicate on the listed worktree (the auto-sweep's merged-unit filter).
 *   sizes          adds `bytes` to each would-remove/removed result.
 * Returns { repoRoot, apply, defaultBranch, refs, results }. Branch refs are never deleted.
 */
export function sweepMergedWorktrees(
  repoRoot,
  {
    targetBranch,
    targetRefs,
    apply = false,
    git = defaultGit,
    liveCwds,
    sanctuaryRoot = null,
    only = null,
    sizes = false,
    freshGraceMs = FRESH_GRACE_MS,
    now = Date.now(),
  } = {},
) {
  const repoRootAbs = resolve(repoRoot);
  const def = targetRefs ? { name: targetBranch ?? null, refs: targetRefs } : detectDefaultBranch(repoRoot, { git, preferred: targetBranch });
  const testRefs = distinctRefs(repoRoot, def.refs, git);
  const wts = listRepoWorktrees(repoRoot, { git });
  const treeCache = new Map();
  const liveKnown = Array.isArray(liveCwds);
  const results = [];
  let removedAny = false;
  wts.forEach((wt, i) => {
    // Skip the main checkout: it is listed first, and its path is the repo root.
    if (i === 0 || wt.bare || normPath(wt.path) === normPath(repoRootAbs)) return;
    if (only && !only(wt)) return;
    const r = { path: wt.path, branch: wt.branch || null, head: wt.head || null };
    results.push(r);
    const keep = (reason) => Object.assign(r, { action: "kept", reason });
    if (wt.prunable) return keep("prunable");
    if (wt.locked) return keep("locked");
    if (sanctuaryRoot && !isInside(wt.path, sanctuaryRoot)) return keep("outside-sanctuary");
    if (wt.branch && (PROTECTED_BRANCHES.has(wt.branch.toLowerCase()) || wt.branch === def.name)) return keep("default-branch");
    if (!def.refs.length) return keep("no-default-branch");

    // Cheap checks first; git status (worktreeDirt) runs only on a merged candidate.
    if (isFreshWorktree(wt.path, now, freshGraceMs)) return keep("fresh");
    if (liveKnown && cwdHoldsWorktree(wt.path, liveCwds)) return keep("live-cwd");
    const m = mergedStatus(repoRoot, wt.head, testRefs, { git, treeCache });
    Object.assign(r, { merged: m.merged, mergedBy: m.how });
    if (!m.merged) return keep("unmerged");
    const dirt = worktreeDirt(wt.path, { git });
    r.clean = dirt.clean;
    if (dirt.buildOutput.length) r.buildOutput = dirt.buildOutput;
    if (!dirt.clean) return keep(dirt.error ? "unreadable" : "dirty");
    if (sizes) r.bytes = dirBytesNoFollow(wt.path);
    if (!apply) {
      r.action = "would-remove";
      if (!liveKnown) r.liveCheck = "unknown";
      return;
    }
    if (!liveKnown) return keep("live-cwd-unknown");
    const res = removeSweptWorktree(repoRoot, wt.path, { git, buildOutput: dirt.buildOutput });
    if (res.removed) {
      r.action = "removed";
      removedAny = true;
    } else keep(res.reason);
  });

  if (apply && removedAny) tryGit(git, ["worktree", "prune"], repoRoot); // best-effort
  return { repoRoot: repoRootAbs, apply, defaultBranch: def.name, refs: def.refs, results };
}

/**
 * Every repo with a linked worktree in the sanctuary (`<root>/<repo>/<unit>/.git` -> its common dir), plus the folders
 * there that are not worktrees (`orphans`: no `.git`; `dangling`: `.git` points at a git dir that is gone). The sweep only
 * reports orphans and dangling folders, it never deletes them (removal goes through `git worktree remove`).
 */
export function discoverSanctuaryRepos(root = resolveManagedWorktreeRoot()) {
  const repos = new Map();
  const orphans = [];
  const dangling = [];
  const subdirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => join(dir, d.name));
    } catch {
      return [];
    }
  };
  for (const group of subdirs(root)) {
    for (const unit of subdirs(group)) {
      let st;
      try {
        st = lstatSync(join(unit, ".git"));
      } catch {
        orphans.push({ path: unit, group: basename(group) });
        continue;
      }
      if (!st.isFile()) continue; // a full clone: not a linked worktree, left alone
      const gd = worktreeGitDir(unit);
      if (!gd || !existsSync(gd)) {
        dangling.push({ path: unit, group: basename(group) });
        continue;
      }
      let common;
      try {
        common = resolve(gd, readFileSync(join(gd, "commondir"), "utf8").trim());
      } catch {
        common = resolve(gd, "..", "..");
      }
      const repoRoot = basename(common).toLowerCase() === ".git" ? dirname(common) : common;
      const key = normPath(repoRoot);
      if (!repos.has(key)) repos.set(key, { repoRoot, name: basename(repoRoot), sanctuaryWorktrees: 0 });
      repos.get(key).sanctuaryWorktrees++;
    }
  }
  return { root: resolve(root), repos: [...repos.values()], orphans, dangling };
}

/**
 * Sweep every repo that has worktrees in the sanctuary (idea-464 part 1), each against its own default branch. Same
 * options as sweepMergedWorktrees (sanctuaryRoot is `root`); `repoFilter(repo)` narrows the repos. `sizes` also sizes the
 * orphan folders. Returns { root, apply, repos: [sweep result + name], orphans, dangling, summary }.
 */
export function sweepAllRepos({ root = resolveManagedWorktreeRoot(), apply = false, liveCwds, git = defaultGit, sizes = false, repoFilter = null, ...rest } = {}) {
  const d = discoverSanctuaryRepos(root);
  const repos = [];
  for (const repo of d.repos) {
    if (repoFilter && !repoFilter(repo)) continue;
    try {
      repos.push({ name: repo.name, ...sweepMergedWorktrees(repo.repoRoot, { apply, liveCwds, git, sanctuaryRoot: root, sizes, ...rest }) });
    } catch (e) {
      repos.push({ name: repo.name, repoRoot: repo.repoRoot, apply, error: gitError(e), results: [] });
    }
  }
  const orphans = d.orphans.map((o) => (sizes ? { ...o, bytes: dirBytesNoFollow(o.path) } : o));
  const summary = {};
  for (const r of repos) {
    const s = (summary[r.name] = { defaultBranch: r.defaultBranch ?? null, worktrees: r.results.length, remove: 0, bytes: 0, kept: {} });
    for (const x of r.results) {
      if (x.action === "would-remove" || x.action === "removed") {
        s.remove++;
        s.bytes += x.bytes ?? 0;
      } else s.kept[x.reason] = (s.kept[x.reason] ?? 0) + 1;
    }
  }
  for (const o of orphans) {
    const s = (summary[`orphans:${o.group}`] ??= { orphanFolders: 0, bytes: 0 });
    s.orphanFolders++;
    s.bytes += o.bytes ?? 0;
  }
  return { root: d.root, apply, repos, orphans, dangling: d.dangling, summary };
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
