// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): the opt-in "Also delete worktrees + branches" step.
// Only linked git worktrees are touched, never a main checkout. Nothing is forced: `git worktree remove`
// refuses a dirty worktree and `git branch -d` refuses an unmerged branch, and both come back as "kept"
// with git's reason so the dialog can say why.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, linkSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Run git. Options (R1 retention): `env` extra environment (e.g. GIT_INDEX_FILE), `input` stdin, `buffer` returns the raw
 * stdout Buffer (untrimmed, for blob bytes).
 */
export function defaultGit(args, cwd, { env, input, buffer = false } = {}) {
  const out = execFileSync("git", args, {
    cwd,
    ...(buffer ? {} : { encoding: "utf8" }), // no encoding = Buffer out; "buffer" would also be used to encode a string `input` (ERR_UNKNOWN_ENCODING)
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
    ...(env ? { env: { ...process.env, ...env } } : {}),
    windowsHide: true,
    timeout: buffer || input !== undefined ? 300_000 : 30_000,
    maxBuffer: buffer ? 2 ** 31 : 64 << 20, // not `2 << 30`: that overflows int32 to a negative (ERR_OUT_OF_RANGE)
  });
  return buffer ? out : out.trim();
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
/** Like tryGit but untrimmed (buffer mode): `status --porcelain` records start with a space (" M", " D") that trim() eats. */
const tryGitRaw = (git, args, cwd, env) => {
  try {
    const out = git(args, cwd, { buffer: true, ...(env ? { env } : {}) });
    return Buffer.isBuffer(out) ? out.toString("utf8") : String(out ?? "");
  } catch {
    return null;
  }
};
export const normPath = (p) => {
  let s;
  try {
    s = realpathSync.native(resolve(String(p)));
  } catch {
    return null; // unresolvable (missing / through a dangling link): fail closed — not inside anything, so never deleted
  }
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
/** Lexical containment (no realpath): the conservative fallback for keep-guards, where a cwd that does not
 *  resolve yet (an agent's not-yet-created subfolder) must still read as inside the worktree. */
const lexKey = (p) => {
  const s = resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
const lexInside = (child, parent) => {
  const c = lexKey(child);
  const p = lexKey(parent);
  return c === p || c.startsWith(p + "/");
};
export const isInside = (child, parent) => {
  const c = normPath(child);
  const p = normPath(parent);
  if (!c || !p) return false; // an unresolvable path is not inside
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
    for (const d of readdirSync(toLongPath(resolve(wtPath, relDir)), { withFileTypes: true })) {
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
  // core.longpaths=true: a >260-char untracked file must not read as clean (idea-514); without it
  // `ls-files --others` silently omits deep paths and a dry-run sweep would say "would-remove".
  const longpaths = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
  const tracked = tryGit(git, [...longpaths, "status", "--porcelain", "--untracked-files=no"], wtPath);
  const others = tryGit(git, [...longpaths, "ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"], wtPath);
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
 * `lost` agents stay in (the process may still run): toAgent flattens the runner's `lost` to status "closed" + `lost: true`,
 * so the flag is checked as well as the raw status.
 */
export function liveAgentCwds(agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.archivedAt || a.archived) continue;
    if (a.status === "closed" && a.resumable !== true && a.lost !== true) continue;
    const cwd = String(a.cwd ?? a.config?.cwd ?? "").trim();
    if (cwd) out.push(cwd);
  }
  return out;
}

/** True when some cwd in `cwds` is `wtPath` or inside it. Conservative: a cwd that cannot be resolved yet
 *  (realpath fails) but is lexically inside still holds the tree, so a live agent's worktree is never removed. */
export const cwdHoldsWorktree = (wtPath, cwds) => (cwds ?? []).some((c) => c && (isInside(c, wtPath) || lexInside(c, wtPath)));

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

/**
 * Windows: prefix an absolute path with `\\?\` so node's fs APIs handle paths beyond MAX_PATH (~260 chars) — deep build
 * output like `src-tauri/gen/android/app/build/intermediates/...` (idea-514). The prefix also disables `..` normalization
 * (irrelevant here: every caller passes an already-resolved absolute path). A `\\.\` device path is passed through unchanged
 * (it is already absolute and long-path safe); empty input is rejected. Idempotent; a no-op on other platforms.
 */
export function toLongPath(p) {
  if (typeof p !== "string" || p.trim() === "") throw new TypeError("toLongPath: empty path");
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\.\\")) return p; // Win32 device namespace
  const abs = resolve(p);
  if (abs.startsWith("\\\\?\\")) return abs;
  if (abs.startsWith("\\\\")) return "\\\\?\\UNC\\" + abs.slice(2);
  return "\\\\?\\" + abs;
}

/** Throw (code EESCAPE) unless `p` resolves (realpath) inside the normalized worktree root `wtRoot`; unresolvable = escape. */
function assertRealInside(p, wtRoot) {
  const real = normPath(p);
  if (!wtRoot || !real || !(real === wtRoot || real.startsWith(wtRoot + "/"))) {
    throw Object.assign(new Error(`removal escaped the worktree: ${p}`), { code: "EESCAPE" });
  }
}

/**
 * Delete `abs` without ever following a symlink or junction (a link is unlinked, never recursed into). `wtRoot` is the
 * worktree root as normalized by normPath (realpath). Before acting on any entry its parent folder must resolve inside
 * `wtRoot`, and before a directory is read the directory itself must too: a folder swapped for a junction mid-walk
 * (between a readdir and the descent into a child) resolves outside, so the walk aborts (throws EESCAPE) instead of
 * following it. `onListed(abs, names)` is a test seam called right after each readdir.
 */
function removeTreeNoFollow(abs, wtRoot, onListed) {
  abs = toLongPath(abs);
  assertRealInside(dirname(abs), wtRoot);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    unlinkLinkOnly(abs);
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
  assertRealInside(abs, wtRoot); // a directory swapped for a junction since the lstat resolves outside here
  const names = readdirSync(abs);
  onListed?.(abs, names);
  // Each child re-checks its parent (`abs`) at its own entry, so `abs` swapped for a junction now aborts the walk.
  for (const name of names) removeTreeNoFollow(join(abs, name), wtRoot, onListed);
  rmdirSync(abs);
}

/** Unlink a symlink or junction itself (never its target); throws when neither works. */
function unlinkLinkOnly(p) {
  p = toLongPath(p);
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p); // a junction: non-recursive, removes only the link
  }
}

/**
 * Detach every untracked link (symlink or junction) anywhere in the worktree, e.g. a gitignored node_modules junction into
 * the main checkout, which worktreeDirt never lists: `git worktree remove` deletes ignored content and must never reach a
 * link's target. Walks without following links. A link git tracks (mode 120000) is left alone: git removes a symlink
 * without following it. Fails closed: a read error, a git error, an unlink that fails or a link still present afterwards
 * throws, so the caller removes nothing.
 */
function detachUntrackedLinks(wtPath, { git, unlinkLink = unlinkLinkOnly } = {}) {
  const links = [];
  const walk = (dir) => {
    for (const d of readdirSync(toLongPath(dir), { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (dir === wtPath && d.name === ".git") continue;
      if (d.isSymbolicLink()) links.push(p);
      else if (d.isDirectory()) walk(p);
      else if (!d.isFile() && lstatSync(toLongPath(p)).isSymbolicLink()) links.push(p);
    }
  };
  walk(wtPath);
  if (!links.length) return;
  const tracked = new Set();
  for (const e of String(git(["ls-files", "-s", "-z"], wtPath) ?? "").split("\0")) {
    const tab = e.indexOf("\t");
    if (tab > 0 && e.startsWith("120000 ")) tracked.add(e.slice(tab + 1));
  }
  for (const p of links) {
    if (tracked.has(relative(wtPath, p).replace(/\\/g, "/"))) continue;
    unlinkLink(p);
    let still = true;
    try {
      lstatSync(toLongPath(p));
    } catch (e) {
      if (e?.code === "ENOENT") still = false;
    }
    if (still) throw Object.assign(new Error(`link still attached: ${p}`), { code: "ELINK" });
  }
}

/**
 * The absolute path of build-output entry `rel` when it is safe to delete without following links: lexically under
 * `wtPath` (not the root itself), and its parent folder resolves (realpath) inside the worktree, so no link sits on the
 * way. The entry itself may be a link (removeTreeNoFollow only unlinks it). Else null (left alone).
 */
function buildOutputTarget(wtPath, rel) {
  const base = resolve(wtPath);
  const abs = resolve(base, rel);
  const lex = (p) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  if (!lex(abs).startsWith(lex(base) + "/")) return null;
  if (!isInside(dirname(abs), base)) return null;
  return abs;
}

/**
 * Remove one swept worktree and keep its branch. Untracked build output is deleted first (links unlinked, never followed),
 * then plain `git worktree remove` (no --force), which refuses anything that turned dirty since the check.
 * Returns { removed: true } or { removed: false, reason }.
 */
export function removeSweptWorktree(
  repoRoot,
  wtPath,
  { git = defaultGit, buildOutput = [], unlinkLink, force = false, onListed } = {},
) {
  try {
    const wtRoot = normPath(wtPath);
    for (const rel of buildOutput) {
      // Lexical containment, not realpath: a nested build-output link pointing outside must still be unlinked here,
      // before `git worktree remove` could walk it.
      const abs = buildOutputTarget(wtPath, rel);
      if (abs) removeTreeNoFollow(abs, wtRoot, onListed); // `onListed`: test seam only
    }
    detachUntrackedLinks(resolve(wtPath), { git, unlinkLink });
  } catch (e) {
    return { removed: false, reason: `build output not removed (${e?.code ?? "error"})` };
  }
  try {
    // `force` only for R1 retention, after its WIP is committed to refs/vs-archive/<unit> and re-verified.
    // core.longpaths=true: git deletes the whole tree (deep ignored build output included) and must not bail on
    // >260-char paths (idea-514, "Filename too long").
    git(
      [...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []), "worktree", "remove", ...(force ? ["--force"] : []), wtPath],
      repoRoot,
    );
  } catch (e) {
    return { removed: false, reason: gitError(e) };
  }
  // git may drop the worktree's metadata but leave the folder behind (a partial removal). Claim success
  // only when the directory is actually gone; otherwise report an orphan for the next sweep.
  if (existsSync(toLongPath(wtPath))) return { removed: false, reason: "orphan" };
  return { removed: true };
}

/** Bytes under `abs`, never following links (a node_modules junction counts as 0). */
export function dirBytesNoFollow(abs) {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const p = toLongPath(stack.pop());
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

export const SWEEP_LOCK_FILE = ".vs-sweep.lock";
const SWEEP_LOCK_STALE_MS = 2 * 60 * 60_000;
const SWEEP_LOCK_BEAT_MS = 60_000;
const TAKEOVER_STALE_MS = 60_000;

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
};

/**
 * The sanctuary-wide apply lock (`<root>/.vs-sweep.lock`, { pid, at, nonce }), shared by `vs worktree sweep --apply` and
 * the auto-sweep, so two removers never race on `git worktree remove`.
 * - Create is atomic with full content: a private temp file is hard-linked into place (EEXIST when held), so no reader
 *   ever sees an empty or half-written lock.
 * - The holder heartbeats (`release.beat()`, called through the sweep; it bumps the file's mtime at most once a minute).
 *   Stale = the holder's pid is gone, or no heartbeat for staleMs (a hung holder or a reused pid). An unparseable lock is
 *   stale only after staleMs without a heartbeat.
 * - Takeover of a stale lock runs under a second exclusive file (`.takeover`), re-checks staleness there, and only then
 *   unlinks, so two takers never both win. A leftover `.takeover` older than a minute is cleared (that attempt still fails).
 * Returns a release function (with `.beat()` -> false once the lock is no longer ours), or null when another live sweep
 * holds it or the lock can't be written.
 */
export function acquireSweepLock(root = resolveManagedWorktreeRoot(), { pid = process.pid, clock = Date.now, staleMs = SWEEP_LOCK_STALE_MS, alive = pidAlive } = {}) {
  const dir = resolve(root);
  const file = join(dir, SWEEP_LOCK_FILE);
  const nonce = randomUUID();
  const body = JSON.stringify({ pid, at: clock(), nonce });
  const ours = () => {
    try {
      return readFileSync(file, "utf8") === body;
    } catch {
      return false;
    }
  };
  const create = () => {
    const tmp = join(dir, `${SWEEP_LOCK_FILE}.${nonce}.tmp`);
    writeFileSync(tmp, body, { flag: "wx" });
    try {
      linkSync(tmp, file);
      return true;
    } catch (e) {
      if (e?.code === "EEXIST") return false;
      throw e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  };
  const staleness = () => {
    let st;
    try {
      st = statSync(file);
    } catch (e) {
      return e?.code === "ENOENT" ? "gone" : false;
    }
    let held = null;
    try {
      held = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    const quiet = !(clock() - st.mtimeMs < staleMs);
    return held ? !alive(held.pid) || quiet : quiet;
  };
  const takeOver = () => {
    const t = `${file}.takeover`;
    try {
      writeFileSync(t, nonce, { flag: "wx" });
    } catch (e) {
      try {
        if (e?.code === "EEXIST" && !(clock() - statSync(t).mtimeMs < TAKEOVER_STALE_MS)) unlinkSync(t);
      } catch {}
      return false;
    }
    try {
      const s = staleness();
      if (s === "gone") return true;
      if (!s) return false;
      unlinkSync(file);
      return true;
    } catch {
      return false;
    } finally {
      try {
        unlinkSync(t);
      } catch {}
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    if (!create() && !(takeOver() && create())) return null;
  } catch {
    return null;
  }
  let lastBeat = clock();
  const release = () => {
    try {
      if (ours()) unlinkSync(file);
    } catch {}
  };
  release.beat = () => {
    if (!ours()) return false;
    if (clock() - lastBeat >= SWEEP_LOCK_BEAT_MS) {
      try {
        const t = new Date(clock());
        utimesSync(file, t, t);
        lastBeat = clock();
      } catch {
        return false;
      }
    }
    return true;
  };
  return release;
}

/**
 * A `refreshLiveCwds` for sweepMergedWorktrees: reads the roster with `readAgents()` at most every `intervalMs` and returns
 * liveAgentCwds of it, or null (unknown: nothing removed) when the read throws or comes back empty.
 */
export function throttledLiveCwds(readAgents, { intervalMs = 30_000, clock = Date.now } = {}) {
  let at = -Infinity;
  let cwds = null;
  return () => {
    if (clock() - at < intervalMs) return cwds;
    at = clock();
    try {
      const agents = readAgents();
      cwds = Array.isArray(agents) && agents.length ? liveAgentCwds(agents) : null;
    } catch {
      cwds = null;
    }
    return cwds;
  };
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
 *   refreshLiveCwds  optional () => cwds | null, called right before each removal (see throttledLiveCwds); null or a
 *                  throw keeps the worktree ("live-cwd-unknown").
 *   heartbeat      optional () => bool (the sweep lock's beat): called per worktree; false before a removal keeps it
 *                  ("sweep-lock-lost").
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
    refreshLiveCwds = null,
    heartbeat = null,
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
    if (heartbeat) heartbeat(); // keep a long sweep's lock fresh (ownership is re-checked before removing)
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
    if (heartbeat && !heartbeat()) return keep("sweep-lock-lost");
    if (refreshLiveCwds) {
      // Re-read the roster right before removing: a long sweep must not act on a roster taken minutes ago.
      let fresh;
      try {
        fresh = refreshLiveCwds();
      } catch {
        fresh = null;
      }
      if (!Array.isArray(fresh)) return keep("live-cwd-unknown");
      if (cwdHoldsWorktree(wt.path, fresh)) return keep("live-cwd");
    }
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
      const key = normPath(repoRoot) ?? lexKey(repoRoot);
      if (!repos.has(key)) repos.set(key, { repoRoot, name: basename(repoRoot), sanctuaryWorktrees: 0 });
      repos.get(key).sanctuaryWorktrees++;
    }
  }
  return { root: resolve(root), repos: [...repos.values()], orphans, dangling };
}

/**
 * Sweep every repo that has worktrees in the sanctuary (idea-464 part 1), each against its own default branch. Same
 * options as sweepMergedWorktrees (sanctuaryRoot is `root`); `repoFilter(repo)` narrows the repos. `sizes` also sizes the
 * orphan folders. An apply holds the sanctuary sweep lock (acquireSweepLock); busy -> { busy: true } and nothing runs.
 * Returns { root, apply, repos: [sweep result + name], orphans, dangling, summary }.
 */
export function sweepAllRepos(opts = {}) {
  const { root = resolveManagedWorktreeRoot(), apply = false } = opts;
  if (!apply) return sweepAllReposUnlocked(opts);
  // One remover at a time across processes (the auto-sweep holds the same lock).
  const release = acquireSweepLock(root);
  if (!release) return { root: resolve(root), apply, busy: true, repos: [], orphans: [], dangling: [], summary: {} };
  try {
    return sweepAllReposUnlocked({ ...opts, heartbeat: release.beat });
  } finally {
    release();
  }
}

function sweepAllReposUnlocked({ root = resolveManagedWorktreeRoot(), apply = false, liveCwds, git = defaultGit, sizes = false, repoFilter = null, ...rest } = {}) {
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

// ── R1 (docs/PLAN_DISK_LIFECYCLE_1121.md; idea-464 part 3): retention + restore ─────────────────────────────────────────
// An UNMERGED sanctuary worktree whose owner agents are all archived or lost (none live) and whose tree has not been touched
// for RETENTION_DAYS is archived: its WIP (tracked changes + untracked files, not ignored, not build output, not links) is
// committed to refs/vs-archive/<unit> (the branch never moves), then the tree is removed. `vs worktree restore <unit>`
// recreates the worktree on the branch and writes the WIP back byte-for-byte. Invariants (Tier A):
// - Dry run by default. Apply holds W1's sanctuary sweep lock, re-reads the roster right before each archive, and needs a
//   readable roster (unknown owner = nothing archived).
// - Never remove a tree before its archive commit is written, the ref created (create-only), and the WIP re-captured to the
//   identical tree. Any git error before removal fails closed (kept); the ref is only retired by a restore that verified.
// - Blobs are hashed with --no-filters and written back raw: no eol/LFS filter can change a byte across the round trip.
// - Links (symlinks/junctions) are never followed: sizing, scanning and deleting lstat; untracked links are recorded in the
//   archive (path + target) and recreated on restore, never archived through.
// - Owner = every roster agent whose cwd is inside the tree. Any live one (liveAgentCwds' predicate, so a resumable lost
//   agent counts as live) keeps the tree.

export const RETENTION_DAYS = 7;
export const ARCHIVE_REF_PREFIX = "refs/vs-archive/";
export const RESTORED_REF_PREFIX = "refs/vs-archive-restored/";
export const ARCHIVE_LEDGER_FILE = ".vs-archive.jsonl";
/** Untracked WIP larger than this is not archived (kept, "wip-too-large"): a human decides. */
export const WIP_MAX_BYTES = 1 << 30;
const DAY_MS = 86_400_000;
const NO_INDEX_WRITE = Object.freeze({ GIT_OPTIONAL_LOCKS: "0" });
const ARCHIVE_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "VibeSquad retention",
  GIT_AUTHOR_EMAIL: "retention@vibesquad.invalid",
  GIT_COMMITTER_NAME: "VibeSquad retention",
  GIT_COMMITTER_EMAIL: "retention@vibesquad.invalid",
});
const OP_IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const lexUnder = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
const stripLongPrefix = (p) => String(p).replace(/^\\\\\?\\/, "");
const lexPath = (p) => String(p).replace(/\\/g, "/");

/** Normalized cwds of the roster, once per sweep (realpath per agent, not per agent x worktree). null = roster unknown. */
export function indexAgentCwds(agents) {
  if (!Array.isArray(agents) || !agents.length) return null;
  const out = [];
  for (const a of agents) {
    const cwd = String(a?.cwd ?? a?.config?.cwd ?? "").trim();
    if (!cwd) continue;
    out.push({ agent: a, cwd: normPath(cwd) ?? lexKey(cwd) }); // an unresolvable cwd still counts (lexically) as a holder
  }
  return out;
}

/**
 * The tree's owner state from the roster index (indexAgentCwds): "live" (some holder is live by liveAgentCwds' rule),
 * "archived" (every holder archived), "lost" (holders closed for good, or no roster agent references the tree), or
 * "unknown" (no roster). Returns { state, detail?, agents: ids }.
 */
export function worktreeOwner(wtPath, index) {
  if (!index) return { state: "unknown", agents: [] };
  const p = normPath(wtPath) ?? lexKey(wtPath);
  const holders = index.filter((x) => x.cwd && (x.cwd === p || x.cwd.startsWith(p + "/"))).map((x) => x.agent);
  const ids = holders.map((a) => a.id ?? null).filter(Boolean).slice(0, 8);
  if (!holders.length) return { state: "lost", detail: "no-record", agents: [] };
  if (holders.some((a) => liveAgentCwds([a]).length)) return { state: "live", agents: ids };
  if (holders.every((a) => a.archivedAt || a.archived)) return { state: "archived", agents: ids };
  return { state: "lost", detail: "closed", agents: ids };
}

/**
 * Walk the tree without following links: { bytes, buildBytes (inside BUILD_OUTPUT_DIRS folders, e.g. src-tauri/target),
 * buildDirs, links: [{ rel, target }], lastTouchMs, errors }. With `stopAfterMs`, returns { recent: true, lastTouchMs } as
 * soon as any entry's mtime is newer (an active tree is not walked to the end).
 */
export function scanWorktreeNoFollow(wtPath, { stopAfterMs = null } = {}) {
  const base = resolve(wtPath);
  let bytes = 0;
  let buildBytes = 0;
  let lastTouchMs = 0;
  let errors = 0;
  const links = [];
  const buildDirs = [];
  const stack = [{ abs: base, rel: "", build: false }];
  while (stack.length) {
    const { abs, rel, build } = stack.pop();
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      errors++;
      continue;
    }
    if (st.mtimeMs > lastTouchMs) lastTouchMs = st.mtimeMs;
    if (stopAfterMs != null && lastTouchMs > stopAfterMs) return { recent: true, lastTouchMs };
    if (st.isSymbolicLink()) {
      let target = null;
      try {
        target = stripLongPrefix(readlinkSync(abs));
      } catch {
        errors++;
      }
      if (rel) links.push({ rel, target });
      continue;
    }
    if (st.isDirectory()) {
      let inBuild = build;
      if (!build && rel && isBuildOutputEntry(base, `${rel}/`)) {
        inBuild = true;
        buildDirs.push(`${rel}/`);
      }
      let names;
      try {
        names = readdirSync(abs);
      } catch {
        errors++;
        continue;
      }
      for (const n of names) stack.push({ abs: join(abs, n), rel: rel ? `${rel}/${n}` : n, build: inBuild });
    } else {
      bytes += st.size;
      if (build) buildBytes += st.size;
    }
  }
  return { recent: false, bytes, buildBytes, buildDirs, links, lastTouchMs, errors };
}

/** Latest git-side touch of a worktree: its HEAD / index / HEAD reflog mtimes and HEAD's committer time. */
function gitTouchMs(wtPath, git) {
  let t = 0;
  const gd = worktreeGitDir(wtPath);
  if (gd) {
    for (const f of ["HEAD", "index", join("logs", "HEAD")]) {
      try {
        t = Math.max(t, statSync(resolve(gd, f)).mtimeMs);
      } catch {}
    }
  }
  const ct = Number(tryGit(git, ["log", "-1", "--format=%ct", "HEAD"], wtPath)?.trim());
  if (ct > 0) t = Math.max(t, ct * 1000);
  return t;
}

/** A merge / rebase / cherry-pick / revert / bisect in progress (state that lives only in the worktree's git dir). */
function gitOpInProgress(wtPath) {
  const gd = worktreeGitDir(wtPath);
  if (!gd) return true; // unreadable: fail closed
  return OP_IN_PROGRESS.some((f) => existsSync(resolve(gd, f)));
}

/**
 * What the archive would hold. Entries come from `git status` (tracked changes and untracked files, ignored excluded):
 * { rel, op: "file", mode } | { rel, op: "link", target } (a tracked symlink) | { rel, op: "del" }. Untracked build output
 * and anything at or under an untracked link (`links`, from scanWorktreeNoFollow) are left out. Fails closed (ok: false,
 * reason) on a git error, submodules, an unmerged index, a nested repo, a path through a link, or a special file.
 * Returns { ok, head, entries, dirtyFiles, untrackedBytes, untrackedLinks }.
 */
export function planWip(wtPath, { git = defaultGit, links = [] } = {}) {
  const base = resolve(wtPath);
  const fail = (reason) => ({ ok: false, reason });
  const head = tryGit(git, ["rev-parse", "--verify", "HEAD^{commit}"], base)?.trim();
  if (!head) return fail("unreadable");
  const staged = tryGit(git, ["ls-files", "-s", "-z"], base);
  if (staged === null) return fail("unreadable");
  const indexMode = new Map();
  const indexSha = new Map();
  for (const e of staged.split("\0")) {
    const tab = e.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha, stage] = e.slice(0, tab).split(" ");
    if (mode === "160000") return fail("submodules");
    if (stage !== "0") return fail("unmerged-index");
    indexMode.set(e.slice(tab + 1), mode);
    indexSha.set(e.slice(tab + 1), sha);
  }
  const untrackedLinks = links.filter((l) => indexMode.get(l.rel) !== "120000");
  // An untracked link must not stand at or over a tracked path (a tracked file or folder replaced by a link or junction):
  // the WIP cannot hold that change and a restore would collide with the recreated link. Fail closed.
  for (const rel of indexMode.keys()) if (untrackedLinks.some((l) => lexUnder(rel, l.rel))) return fail("untracked-link");
  // GIT_OPTIONAL_LOCKS=0: status must not refresh (rewrite) the index. A rewrite bumps the index mtime that gitTouchMs reads,
  // so a dry run would mark every stale tree "recent-touch" for the next `days` and a later apply would archive nothing.
  const st = tryGitRaw(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], base, NO_INDEX_WRITE);
  if (st === null) return fail("unreadable");
  const entries = new Map();
  let untrackedBytes = 0;
  for (const rec of st.split("\0")) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const raw = rec.slice(3);
    if (UNMERGED_XY.has(xy)) return fail("unmerged-index");
    if (xy === "!!") continue;
    const untracked = xy === "??";
    const rel = raw.replace(/\/+$/, "");
    if (/[\r\n]/.test(rel)) return fail("odd-path");
    if (untracked && isBuildOutputEntry(base, raw)) continue;
    if (untrackedLinks.some((l) => lexUnder(rel, l.rel))) {
      if (!untracked) return fail("untracked-link"); // a tracked change (e.g. a staged delete) shadowed by a link
      continue; // recorded as a link, never archived through
    }
    if (untracked && raw.endsWith("/")) return fail("nested-repo"); // an embedded git repo: its content is not in the WIP
    const abs = resolve(base, rel);
    if (!isInside(dirname(abs), base)) return fail("path-through-link");
    let s;
    try {
      s = lstatSync(abs);
    } catch (e) {
      if (e?.code === "ENOENT") {
        entries.set(rel, { rel, op: "del" });
        continue;
      }
      return fail("unreadable");
    }
    if (s.isSymbolicLink()) {
      if (indexMode.get(rel) !== "120000") return fail("untracked-link");
      try {
        entries.set(rel, { rel, op: "link", target: readlinkSync(abs) });
      } catch {
        return fail("unreadable");
      }
    } else if (s.isFile()) {
      const mode = process.platform === "win32" ? (indexMode.get(rel) ?? "100644") : s.mode & 0o111 ? "100755" : "100644";
      entries.set(rel, { rel, op: "file", mode });
      if (untracked) untrackedBytes += s.size;
    } else if (s.isDirectory()) {
      if (untracked) return fail("nested-repo");
      entries.set(rel, { rel, op: "del" }); // a tracked file replaced by a folder: the folder's files are listed on their own
    } else return fail("special-file");
  }
  return { ok: true, head, entries: [...entries.values()], dirtyFiles: entries.size, untrackedBytes, untrackedLinks, indexMode, indexSha };
}

/**
 * Clean tracked files whose working bytes are the raw blob (`hash-object --no-filters` == index sha). A fresh checkout runs
 * the repo's filters (core.autocrlf, eol / ident attributes) and could write them differently (an agent's LF file under
 * autocrlf=true comes back CRLF), so restore rewrites these raw. Clean files that differ from their blob are already the
 * filtered checkout form and come back the same way. Returns [{ rel, sha }].
 */
function rawIdenticalClean(base, plan, git) {
  const dirty = new Set(plan.entries.map((e) => e.rel));
  const clean = [...plan.indexMode]
    .filter(([rel, mode]) => (mode === "100644" || mode === "100755") && !dirty.has(rel) && !/[\r\n]/.test(rel))
    .map(([rel]) => rel);
  if (!clean.length) return [];
  const raw = String(git(["hash-object", "--no-filters", "--stdin-paths"], base, { input: clean.join("\n") + "\n" }))
    .split(/\r?\n/)
    .filter(Boolean);
  if (raw.length !== clean.length) throw new Error("hash-object count mismatch");
  return clean.flatMap((rel, i) => (raw[i] === plan.indexSha.get(rel) ? [{ rel, sha: raw[i] }] : []));
}
const RAW_MANIFEST = "clean-raw.txt";

/** Build the WIP tree for `plan` in a throwaway index (the worktree's own index is never touched); writes blobs raw. */
function captureWipTree(wtPath, plan, git) {
  const base = resolve(wtPath);
  const idx = join(tmpdir(), `vs-archive-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(["read-tree", plan.head], base, { env });
    const files = plan.entries.filter((e) => e.op === "file");
    const shas = files.length
      ? String(git(["hash-object", "-w", "--no-filters", "--stdin-paths"], base, { input: files.map((e) => e.rel).join("\n") + "\n" }))
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
    if (shas.length !== files.length) throw new Error("hash-object count mismatch");
    const zero = "0".repeat(plan.head.length);
    const lines = plan.entries.filter((e) => e.op === "del").map((e) => `0 ${zero}\t${e.rel}`);
    files.forEach((e, i) => lines.push(`${e.mode} ${shas[i]}\t${e.rel}`));
    for (const e of plan.entries.filter((x) => x.op === "link")) {
      lines.push(`120000 ${String(git(["hash-object", "-w", "--stdin"], base, { input: e.target })).trim()}\t${e.rel}`);
    }
    if (lines.length) git(["update-index", "--add", "--replace", "-z", "--index-info"], base, { env, input: lines.join("\0") + "\0" });
    return String(git(["write-tree"], base, { env })).trim();
  } finally {
    for (const f of [idx, `${idx}.lock`]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

/** Ignored, non-build-output entries: `git worktree remove --force` deletes them and the archive does not hold them. */
function ignoredNonBuild(wtPath, git) {
  const out = tryGit(git, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], wtPath);
  if (out === null) return null;
  return out.split("\0").filter((p) => p && !isBuildOutputEntry(wtPath, p));
}

/**
 * The untracked links an archive records for restore: not inside build output and not gitignored (ignored content is not
 * archived either; the node_modules junction is recreated by linkNodeModules). null on a git error.
 */
function linksToRecord(wtPath, links, buildDirs, git) {
  const cands = links.filter((l) => l.target && !isBuildOutputEntry(wtPath, l.rel) && !(buildDirs ?? []).some((b) => lexUnder(l.rel, b.replace(/\/+$/, ""))));
  if (!cands.length) return [];
  let out;
  try {
    out = String(git(["check-ignore", "-z", "--stdin"], wtPath, { input: cands.map((l) => l.rel).join("\0") + "\0" }));
  } catch (e) {
    if (e?.status !== 1) return null; // 1 = none ignored; anything else is an error
    out = "";
  }
  const ignored = new Set(out.split("\0").filter(Boolean));
  return cands.filter((l) => !ignored.has(l.rel)).map((l) => ({ rel: l.rel, target: l.target }));
}

/** Order-free identity of a link list (path + target), so a retargeted or swapped link reads as a change. */
const linkKey = (links) => JSON.stringify(links.map((l) => [l.rel, l.target ?? null]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
const archiveRef = (unit) => `${ARCHIVE_REF_PREFIX}${unit}`;
const refExists = (git, repo, ref) => tryGit(git, ["rev-parse", "--verify", "--quiet", ref], repo) !== null;

function appendLedger(root, entry) {
  if (!root) return;
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, ARCHIVE_LEDGER_FILE), JSON.stringify(entry) + "\n");
  } catch (e) {
    console.warn(`[vibesquad] archive ledger not written: ${e?.message ?? e}`);
  }
}

/**
 * Archive one worktree (the retention sweep has already decided it is a candidate): commit its index tree and its WIP tree
 * (parents: HEAD, index commit) to refs/vs-archive/<unit> (create-only), re-capture the WIP and compare, then remove the
 * tree (build output and untracked links first, never followed; then `git worktree remove --force`). The branch ref never
 * moves and is never deleted. `beforeRef()` (live re-check, lock heartbeat) returns a keep reason or null.
 * Returns { archived, reason?, ref, commit, removed, removeReason? }.
 */
export function archiveWorktree(
  repoRoot,
  wtPath,
  { git = defaultGit, branch, unit = basename(resolve(wtPath)), scan, owner = null, ledgerRoot = null, beforeRef = null, now = Date.now() } = {},
) {
  const base = resolve(wtPath);
  const ref = archiveRef(unit);
  const keep = (reason) => ({ archived: false, reason, ref });
  if (!branch) return keep("no-branch");
  if (tryGit(git, ["check-ref-format", ref], repoRoot) === null) return keep("bad-unit-name");
  if (refExists(git, repoRoot, ref)) return keep("archive-ref-exists");
  if (gitOpInProgress(base)) return keep("git-op-in-progress");
  const sc = scan ?? scanWorktreeNoFollow(base);
  if (sc.errors) return keep("scan-error");
  const links = sc.links;
  const plan = planWip(base, { git, links });
  if (!plan.ok) return keep(plan.reason);
  if (plan.untrackedBytes > WIP_MAX_BYTES) return keep("wip-too-large");
  const recordLinks = linksToRecord(base, plan.untrackedLinks, sc.buildDirs, git);
  if (!recordLinks) return keep("unreadable");
  let commit, wipTree, indexTree;
  try {
    indexTree = String(git(["write-tree"], base)).trim();
    wipTree = captureWipTree(base, plan, git);
    const indexCommit = String(git(["commit-tree", indexTree, "-p", plan.head, "-F", "-"], base, { env: ARCHIVE_ENV, input: `vs-archive index ${unit}\n` })).trim();
    // Optional third parent: the raw-identical clean file list (rawIdenticalClean), in a commit so gc keeps it.
    const same = rawIdenticalClean(base, plan, git);
    let rawCommit = null;
    if (same.length) {
      const list = same.map((x) => `${x.sha} ${x.rel}`).join("\n") + "\n";
      const blob = String(git(["hash-object", "-w", "--no-filters", "--stdin"], base, { input: list })).trim();
      const tree = String(git(["mktree"], base, { input: `100644 blob ${blob}\t${RAW_MANIFEST}\n` })).trim();
      rawCommit = String(git(["commit-tree", tree, "-F", "-"], base, { env: ARCHIVE_ENV, input: `vs-archive raw ${unit}\n` })).trim();
    }
    const meta = {
      v: 1,
      unit,
      repo: resolve(repoRoot),
      path: base,
      branch,
      head: plan.head,
      index: indexCommit,
      raw: rawCommit,
      links: recordLinks,
      dirtyFiles: plan.dirtyFiles,
      owner,
      at: new Date(now).toISOString(),
    };
    commit = String(
      git(["commit-tree", wipTree, "-p", plan.head, "-p", indexCommit, ...(rawCommit ? ["-p", rawCommit] : []), "-F", "-"], base, {
        env: ARCHIVE_ENV,
        input: `vs-archive ${unit}\n\n${JSON.stringify(meta)}\n`,
      }),
    ).trim();
  } catch (e) {
    return keep(`archive-failed: ${gitError(e)}`);
  }
  const why = beforeRef ? beforeRef() : null;
  if (why) return keep(why);
  try {
    git(["update-ref", "-m", `vs-archive ${unit}`, ref, commit, ""], repoRoot); // "" = must not exist yet
  } catch (e) {
    return keep(`archive-ref-failed: ${gitError(e)}`);
  }
  // Re-capture: anything written since the first capture (or an index / HEAD change) means the archive is stale.
  let same = false;
  try {
    const sc2 = scanWorktreeNoFollow(base);
    const plan2 = planWip(base, { git, links: sc2.links });
    same =
      !sc2.errors &&
      linkKey(sc2.links) === linkKey(links) &&
      plan2.ok &&
      plan2.head === plan.head &&
      captureWipTree(base, plan2, git) === wipTree &&
      String(git(["write-tree"], base)).trim() === indexTree;
  } catch {}
  if (!same) {
    tryGit(git, ["update-ref", "-d", ref, commit], repoRoot);
    return keep("changed-during-archive");
  }
  // The re-capture walks the whole tree again (seconds on a big target/): re-check live cwd + lock right before removal.
  const why2 = beforeRef ? beforeRef() : null;
  if (why2) {
    tryGit(git, ["update-ref", "-d", ref, commit], repoRoot);
    return keep(why2);
  }
  appendLedger(ledgerRoot, { op: "archive", unit, repo: resolve(repoRoot), path: base, branch, head: plan.head, ref, commit, at: new Date(now).toISOString() });
  const res = removeSweptWorktree(repoRoot, base, { git, buildOutput: sc.buildDirs ?? [], force: true });
  if (res.removed) tryGit(git, ["worktree", "prune"], repoRoot);
  return { archived: true, ref, commit, removed: res.removed, ...(res.removed ? {} : { removeReason: res.reason }) };
}

/**
 * Retention over every sanctuary repo (or `repoFilter`'s): unmerged, owner archived/lost, untouched for `days`. Dry run by
 * default: each candidate is reported as "would-archive" with { repo, unit, branch, ownerState, lastTouchAgeDays, bytes,
 * buildBytes, dirtyFiles, untrackedBytes, links, ignoredLost }. `agents` is the full roster (archived included);
 * `refreshAgents()` re-reads it right before each archive. Apply holds the sweep lock (busy -> { busy: true }).
 */
export function retentionSweep(opts = {}) {
  const { root = resolveManagedWorktreeRoot(), apply = false } = opts;
  if (!apply) return retentionSweepUnlocked(opts);
  const release = acquireSweepLock(root);
  if (!release) return { root: resolve(root), apply, busy: true, repos: [], candidates: [], summary: {} };
  try {
    return retentionSweepUnlocked({ ...opts, heartbeat: release.beat });
  } finally {
    release();
  }
}

function retentionSweepUnlocked({
  root = resolveManagedWorktreeRoot(),
  apply = false,
  agents,
  refreshAgents = null,
  git = defaultGit,
  days = RETENTION_DAYS,
  now = Date.now(),
  repoFilter = null,
  heartbeat = null,
  freshGraceMs = FRESH_GRACE_MS,
} = {}) {
  const cutoff = now - days * DAY_MS;
  const index = indexAgentCwds(agents);
  const d = discoverSanctuaryRepos(root);
  const repos = [];
  for (const repo of d.repos) {
    if (repoFilter && !repoFilter(repo)) continue;
    const results = [];
    const entry = { name: repo.name, repoRoot: repo.repoRoot, results };
    repos.push(entry);
    try {
      const def = detectDefaultBranch(repo.repoRoot, { git });
      entry.defaultBranch = def.name;
      const testRefs = distinctRefs(repo.repoRoot, def.refs, git);
      const treeCache = new Map();
      const wts = listRepoWorktrees(repo.repoRoot, { git });
      wts.forEach((wt, i) => {
        if (i === 0 || wt.bare || normPath(wt.path) === normPath(repo.repoRoot)) return;
        if (heartbeat) heartbeat();
        const r = { repo: repo.name, unit: basename(wt.path), path: wt.path, branch: wt.branch || null };
        results.push(r);
        const keep = (reason) => Object.assign(r, { action: "kept", reason });
        if (wt.prunable) return keep("prunable");
        if (wt.locked) return keep("locked");
        if (!isInside(wt.path, root)) return keep("outside-sanctuary");
        if (!wt.branch) return keep("no-branch");
        if (PROTECTED_BRANCHES.has(wt.branch.toLowerCase()) || wt.branch === def.name) return keep("default-branch");
        if (!def.refs.length) return keep("no-default-branch");
        if (isFreshWorktree(wt.path, now, freshGraceMs)) return keep("fresh");
        const owner = worktreeOwner(wt.path, index);
        r.ownerState = owner.state;
        if (owner.detail) r.ownerDetail = owner.detail;
        if (owner.agents.length) r.ownerAgents = owner.agents;
        if (owner.state === "live") return keep("live-cwd");
        if (owner.state === "unknown" && apply) return keep("roster-unknown");
        const m = mergedStatus(repo.repoRoot, wt.head, testRefs, { git, treeCache });
        if (m.merged) return keep("merged"); // W1's sweep removes it
        if (gitOpInProgress(wt.path)) return keep("git-op-in-progress");
        const unit = r.unit;
        if (refExists(git, repo.repoRoot, archiveRef(unit))) return keep("archive-ref-exists");
        const gt = gitTouchMs(wt.path, git);
        const sc = gt > cutoff ? { recent: true, lastTouchMs: gt } : scanWorktreeNoFollow(wt.path, { stopAfterMs: cutoff });
        const touch = Math.max(gt, sc.lastTouchMs ?? 0);
        r.lastTouchAt = new Date(touch).toISOString();
        r.lastTouchAgeDays = Math.round(((now - touch) / DAY_MS) * 10) / 10;
        if (sc.recent) return keep("recent-touch");
        if (sc.errors) return keep("scan-error");
        const plan = planWip(wt.path, { git, links: sc.links });
        if (!plan.ok) return keep(plan.reason);
        Object.assign(r, { bytes: sc.bytes, buildBytes: sc.buildBytes, dirtyFiles: plan.dirtyFiles, untrackedBytes: plan.untrackedBytes });
        const rec = linksToRecord(wt.path, plan.untrackedLinks, sc.buildDirs, git);
        const ign = ignoredNonBuild(wt.path, git);
        if (ign === null || rec === null) return keep("unreadable");
        r.links = rec.length;
        r.ignoredLost = ign.length;
        if (ign.length) r.ignoredSample = ign.slice(0, 5);
        if (plan.untrackedBytes > WIP_MAX_BYTES) return keep("wip-too-large");
        if (!apply) {
          r.action = "would-archive";
          if (owner.state === "unknown") r.liveCheck = "unknown";
          return;
        }
        const res = archiveWorktree(repo.repoRoot, wt.path, {
          git,
          branch: wt.branch,
          unit,
          scan: sc,
          owner: { state: owner.state, agents: owner.agents },
          ledgerRoot: root,
          now,
          beforeRef: () => {
            if (heartbeat && !heartbeat()) return "sweep-lock-lost";
            if (!refreshAgents) return null;
            let fresh;
            try {
              fresh = indexAgentCwds(refreshAgents());
            } catch {
              fresh = null;
            }
            const o = worktreeOwner(wt.path, fresh);
            if (o.state === "unknown") return "roster-unknown";
            return o.state === "live" ? "live-cwd" : null;
          },
        });
        if (!res.archived) return keep(res.reason);
        Object.assign(r, { action: "archived", ref: res.ref, commit: res.commit, removed: res.removed });
        if (!res.removed) r.removeReason = res.removeReason;
      });
    } catch (e) {
      entry.error = gitError(e);
    }
  }
  const candidates = [];
  const summary = { candidates: 0, bytes: 0, buildBytes: 0, dirtyFiles: 0, repos: {} };
  for (const r of repos) {
    const s = (summary.repos[r.name] = { worktrees: r.results.length, candidates: 0, bytes: 0, buildBytes: 0, kept: {} });
    for (const x of r.results) {
      if (x.action === "would-archive" || x.action === "archived") {
        candidates.push(x);
        s.candidates++;
        s.bytes += x.bytes ?? 0;
        s.buildBytes += x.buildBytes ?? 0;
        summary.candidates++;
        summary.bytes += x.bytes ?? 0;
        summary.buildBytes += x.buildBytes ?? 0;
        summary.dirtyFiles += x.dirtyFiles ?? 0;
      } else s.kept[x.reason] = (s.kept[x.reason] ?? 0) + 1;
    }
  }
  return { root: d.root, apply, days, rosterKnown: Boolean(index), repos, candidates, summary };
}

function readLedger(root) {
  try {
    return readFileSync(join(root, ARCHIVE_LEDGER_FILE), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Raw bytes of each blob (one `git cat-file --batch`). */
function readBlobs(repo, shas, git) {
  const map = new Map();
  if (!shas.length) return map;
  const out = git(["cat-file", "--batch"], repo, { input: shas.join("\n") + "\n", buffer: true });
  let pos = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, pos);
    const [id, type, size] = out.subarray(pos, nl).toString("utf8").split(" ");
    if (id !== sha || type !== "blob") throw new Error(`blob ${sha} unreadable`);
    const n = Number(size);
    map.set(sha, out.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return map;
}

/**
 * `vs worktree restore <unit>`: find refs/vs-archive/<unit> (the ledger's repos, every sanctuary repo, or `repoRoot`),
 * recreate the worktree at its old path on its branch (the branch must still point at the archived HEAD; a deleted branch is
 * recreated there), write the WIP back raw (deletions, files, modes, tracked links), restore the index, recreate untracked
 * links whose target exists, then re-capture and compare with the archive. Only a verified restore retires the ref (moved to
 * refs/vs-archive-restored/<unit>/<ms>, never deleted outright). Holds the sweep lock. Returns { ok, reason?, ... }.
 */
export function restoreArchivedWorktree(unit, { root = resolveManagedWorktreeRoot(), repoRoot = null, git = defaultGit, now = Date.now(), lock = true } = {}) {
  const name = String(unit ?? "").trim();
  const ref = archiveRef(name);
  const fail = (reason, extra = {}) => ({ ok: false, unit: name, reason, ...extra });
  if (!name || /[\\/]/.test(name) || tryGit(git, ["check-ref-format", ref], repoRoot ?? root) === null) return fail("bad-unit-name");
  const seen = new Map();
  const consider = (p) => {
    const k = normPath(p) ?? lexKey(p);
    if (!seen.has(k)) seen.set(k, p);
  };
  if (repoRoot) consider(resolve(repoRoot));
  else {
    for (const e of readLedger(root)) if (e.op === "archive" && e.unit === name) consider(e.repo);
    for (const r of discoverSanctuaryRepos(root).repos) consider(r.repoRoot);
  }
  const hits = [...seen.values()].filter((r) => existsSync(r) && refExists(git, r, ref));
  if (!hits.length) return fail("no-archive");
  if (hits.length > 1) return fail("ambiguous", { repos: hits });
  const repo = hits[0];
  const release = lock ? acquireSweepLock(root) : () => {};
  if (!release) return fail("sweep-lock-busy");
  try {
    return restoreUnlocked(name, ref, repo, { root, git, now, fail });
  } finally {
    release();
  }
}

function restoreUnlocked(unit, ref, repo, { root, git, now, fail }) {
  let commit, meta, parents;
  try {
    commit = String(git(["rev-parse", "--verify", `${ref}^{commit}`], repo)).trim();
    const body = String(git(["cat-file", "commit", commit], repo));
    const sep = body.indexOf("\n\n");
    parents = body
      .slice(0, sep)
      .split("\n")
      .filter((l) => l.startsWith("parent "))
      .map((l) => l.slice(7).trim());
    const line = body
      .slice(sep + 2)
      .split("\n")
      .find((l) => l.startsWith("{"));
    meta = JSON.parse(line);
  } catch (e) {
    return fail(`archive-unreadable: ${e?.message ?? e}`);
  }
  if (meta?.v !== 1 || meta.unit !== unit || !meta.branch || !isAbsolute(String(meta.path)) || parents[0] !== meta.head || parents[1] !== meta.index || (parents[2] ?? null) !== (meta.raw ?? null) || parents.length > 3) {
    return fail("archive-metadata-mismatch");
  }
  const dest = resolve(meta.path);
  const out = { unit, repoRoot: repo, path: dest, branch: meta.branch, commit };
  try {
    lstatSync(dest);
    return fail("path-exists", out);
  } catch (e) {
    if (e?.code !== "ENOENT") return fail("path-unreadable", out);
  }
  const tip = tryGit(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${meta.branch}^{commit}`], repo)?.trim();
  if (!tip) {
    if (tryGit(git, ["branch", meta.branch, meta.head], repo) === null) return fail("branch-recreate-failed", out);
    out.branchRecreated = true;
  } else if (tip !== meta.head) return fail("branch-moved", { ...out, tip, archivedHead: meta.head });
  try {
    mkdirSync(dirname(dest), { recursive: true });
    git(["worktree", "add", dest, meta.branch], repo);
  } catch (e) {
    return fail(`worktree-add-failed: ${gitError(e)}`, out);
  }
  try {
    applyWip(dest, meta.head, commit, git);
    if (meta.raw) applyRawClean(dest, meta.raw, git);
    git(["read-tree", `${meta.index}^{tree}`], dest);
    tryGit(git, ["update-index", "-q", "--refresh"], dest);
  } catch (e) {
    return fail(`apply-failed: ${e?.code ?? gitError(e)}`, out); // the tree stays for inspection; the ref stays
  }
  const links = { restored: [], skipped: [] };
  for (const l of Array.isArray(meta.links) ? meta.links : []) {
    const abs = resolve(dest, l.rel);
    if (!lexPath(abs).startsWith(lexPath(dest) + "/")) {
      links.skipped.push({ rel: l.rel, why: "outside-tree" });
      continue;
    }
    const tgt = isAbsolute(l.target) ? l.target : resolve(dirname(abs), l.target);
    if (!existsSync(tgt)) {
      links.skipped.push({ rel: l.rel, why: "target-missing", target: l.target });
      continue;
    }
    try {
      lstatSync(abs);
      links.skipped.push({ rel: l.rel, why: "exists" });
      continue;
    } catch {}
    try {
      mkdirSync(dirname(abs), { recursive: true });
      if (!isInside(dirname(abs), dest)) throw Object.assign(new Error("path through link"), { code: "ELINK" });
      symlinkSync(l.target, abs, process.platform === "win32" ? (statSync(tgt).isDirectory() ? "junction" : "file") : undefined);
      links.restored.push(l.rel);
    } catch (e) {
      links.skipped.push({ rel: l.rel, why: `link-failed (${e?.code ?? "error"})` });
    }
  }
  try {
    linkNodeModules(repo, dest, git);
  } catch {}
  out.links = links;
  // Verify: the restored tree re-captures to the archived WIP tree, and the index to the archived index tree.
  let verified = false;
  try {
    const wipTree = String(git(["rev-parse", `${commit}^{tree}`], repo)).trim();
    const indexTree = String(git(["rev-parse", `${meta.index}^{tree}`], repo)).trim();
    const sc = scanWorktreeNoFollow(dest);
    const plan = planWip(dest, { git, links: sc.links });
    verified = plan.ok && plan.head === meta.head && captureWipTree(dest, plan, git) === wipTree && String(git(["write-tree"], dest)).trim() === indexTree;
  } catch {}
  out.verified = verified;
  if (!verified) return fail("verify-mismatch", out); // ref kept: the archive still holds the WIP
  const retired = `${RESTORED_REF_PREFIX}${unit}/${now}`;
  if (tryGit(git, ["update-ref", "-m", `vs-archive restored ${unit}`, retired, commit, ""], repo) !== null) {
    tryGit(git, ["update-ref", "-d", ref, commit], repo);
    out.retiredRef = retired;
  }
  appendLedger(root, { op: "restore", unit, repo, path: dest, branch: meta.branch, commit, at: new Date(now).toISOString() });
  return { ok: true, ...out };
}

/** Rewrite raw the clean files the archive saw byte-equal to their blob, where the filtered checkout wrote them otherwise. */
function applyRawClean(dest, rawCommit, git) {
  const base = resolve(dest);
  const out = git(["cat-file", "blob", `${rawCommit}:${RAW_MANIFEST}`], base, { buffer: true });
  const list = (Buffer.isBuffer(out) ? out.toString("utf8") : String(out))
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, l.indexOf(" ")), rel: l.slice(l.indexOf(" ") + 1) }));
  if (!list.length) return;
  const now = String(git(["hash-object", "--no-filters", "--stdin-paths"], base, { input: list.map((x) => x.rel).join("\n") + "\n" }))
    .split(/\r?\n/)
    .filter(Boolean);
  if (now.length !== list.length) throw Object.assign(new Error("hash-object count mismatch"), { code: "EHASH" });
  const fix = list.filter((x, i) => now[i] !== x.sha);
  if (!fix.length) return;
  const blobs = readBlobs(base, [...new Set(fix.map((x) => x.sha))], git);
  for (const x of fix) {
    const abs = resolve(base, x.rel);
    if (!lexPath(abs).startsWith(lexPath(base) + "/")) throw Object.assign(new Error("outside tree"), { code: "EOUTSIDE" });
    if (!isInside(dirname(abs), base)) throw Object.assign(new Error("path through link"), { code: "ELINK" });
    if (!lstatSync(abs).isFile()) throw Object.assign(new Error("not a plain file"), { code: "ENOTFILE" });
    writeFileSync(abs, blobs.get(x.sha)); // an overwrite keeps the checkout's mode bits
  }
}

/** Write the archived WIP (diff HEAD -> WIP commit) into a fresh checkout of HEAD: deletions first, then raw blobs. */
function applyWip(dest, head, commit, git) {
  const raw = String(git(["diff-tree", "-r", "-z", "--no-renames", head, commit], dest));
  const parts = raw.split("\0");
  const dels = [];
  const writes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(parts[i]);
    if (!m) throw Object.assign(new Error("unparsed diff-tree record"), { code: "EDIFF" });
    const rel = parts[i + 1];
    if (m[5] === "D") dels.push(rel);
    else writes.push({ rel, mode: m[2], sha: m[4] });
  }
  const base = resolve(dest);
  const target = (rel) => {
    const abs = resolve(base, rel);
    if (!lexPath(abs).startsWith(lexPath(base) + "/")) throw Object.assign(new Error("outside tree"), { code: "EOUTSIDE" });
    return abs;
  };
  for (const rel of dels) {
    const abs = target(rel);
    if (!isInside(dirname(abs), base)) throw Object.assign(new Error("path through link"), { code: "ELINK" });
    try {
      unlinkSync(abs);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    // Drop folders the deletions emptied (git tracks no empty folders; the archived tree had none there).
    for (let dir = dirname(abs); dir !== base && isInside(dir, base); dir = dirname(dir)) {
      try {
        if (readdirSync(dir).length) break;
        rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
  const blobs = readBlobs(base, [...new Set(writes.map((w) => w.sha))], git);
  const symlinks = tryGit(git, ["config", "--bool", "core.symlinks"], base)?.trim() !== "false";
  for (const w of writes) {
    if (w.mode === "160000") throw Object.assign(new Error("submodule in archive"), { code: "ESUBMODULE" });
    const abs = target(w.rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (!isInside(dirname(abs), base)) throw Object.assign(new Error("path through link"), { code: "ELINK" });
    try {
      const st = lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) throw Object.assign(new Error("folder in the way"), { code: "EISDIR" });
      unlinkLinkOnly(abs);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const bytes = blobs.get(w.sha);
    if (w.mode === "120000" && symlinks) symlinkSync(bytes.toString("utf8"), abs);
    else {
      writeFileSync(abs, bytes);
      if (w.mode === "100755" && process.platform !== "win32") chmodSync(abs, 0o755);
    }
  }
}
