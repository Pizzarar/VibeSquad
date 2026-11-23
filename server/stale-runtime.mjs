import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STAMP_FILE = "build-stamp.json";
const GIT_TIMEOUT_MS = 2000;
const CACHE_MS = 60_000;

const defaultGit = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();

const defaultGitAsync = (repo, args) =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });

/** Where the server publishes its stale state so `vs` can warn without running git or an HTTP call. */
export function staleFilePath(env = process.env) {
  return join(env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "stale.json");
}

/** Stamp shipped in the installer: commit + time only, never the build machine's checkout path (`repo` is dev-sync only). */
export function packagedStamp({ commit, builtAt }) {
  return { commit, builtAt };
}

/** Build stamp `{commit, builtAt, repo?}`; `repo` exists only for dev-synced runtimes, not the packaged app. Null when absent or malformed. */
export function readBuildStamp(rootDir) {
  try {
    const s = JSON.parse(readFileSync(join(rootDir, STAMP_FILE), "utf8"));
    if (!s || typeof s.commit !== "string") return null;
    return typeof s.repo === "string" ? s : { ...s, repo: undefined };
  } catch {
    return null;
  }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Resolve `{gitDir, commonDir}` for a checkout root or a git dir, following a linked worktree's `gitdir:` file and
 * `commondir` (mirrors providers-catalog readHeadShaFs). `root` may be the checkout root (with a `.git` file/dir) or the
 * git dir itself (`stamp.repo` = `git rev-parse --git-common-dir`). Null when a `.git` file can't be parsed.
 */
function gitDirs(root) {
  let gitDir = root;
  try {
    const dotGit = join(root, ".git");
    const st = statSync(dotGit);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return null;
      gitDir = resolve(root, m[1].trim());
    } else if (st.isDirectory()) {
      gitDir = dotGit;
    }
  } catch {
    // No `.git` entry: `root` is already a git dir.
  }
  let commonDir = gitDir;
  try { commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch { /* not a linked worktree */ }
  return { gitDir, commonDir };
}

/**
 * Full sha of a named ref (e.g. `refs/heads/master`) read straight from the .git files, no spawn. Loose ref first, then
 * packed-refs, as git resolves it. Null when it can't be read (reftable, a symref chain, a missing ref): the caller never
 * guesses a sha.
 */
export function readRefSha(root, ref) {
  try {
    if (ref.split("/").some((p) => p === ".." || p === "." || p === "")) return null;
    const dirs = gitDirs(root);
    if (!dirs) return null;
    let loose = null;
    try { loose = readFileSync(join(dirs.commonDir, ref), "utf8").trim(); } catch { /* not a loose ref */ }
    if (loose !== null) return SHA_RE.test(loose) ? loose.toLowerCase() : null; // a symref or junk: let git decide
    let packed = "";
    try { packed = readFileSync(join(dirs.commonDir, "packed-refs"), "utf8"); } catch { return null; }
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && SHA_RE.test(sha)) return sha.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/** `{built, head, behind}` when the stamped build trails the repo's master, else null. Any git/stamp failure means not stale. */
export function computeStale({ rootDir, git = defaultGit, exists = existsSync } = {}) {
  try {
    const stamp = readBuildStamp(rootDir);
    if (!stamp?.repo || !exists(stamp.repo)) return null;
    const head = git(stamp.repo, ["rev-parse", "master"]);
    if (!head || head === stamp.commit) return null;
    const behind = Number.parseInt(git(stamp.repo, ["rev-list", "--count", `${stamp.commit}..${head}`]), 10);
    if (!Number.isFinite(behind) || behind <= 0) return null;
    return { built: stamp.commit.slice(0, 7), head: head.slice(0, 7), behind };
  } catch {
    return null;
  }
}

/** computeStale with an async git: the /health path must never block the loop on two git spawns (idea-225). */
export async function computeStaleAsync({ rootDir, git = defaultGitAsync, exists = existsSync } = {}) {
  try {
    const stamp = readBuildStamp(rootDir);
    if (!stamp?.repo || !exists(stamp.repo)) return null;
    const head = await git(stamp.repo, ["rev-parse", "master"]);
    if (!head || head === stamp.commit) return null;
    const behind = Number.parseInt(await git(stamp.repo, ["rev-list", "--count", `${stamp.commit}..${head}`]), 10);
    if (!Number.isFinite(behind) || behind <= 0) return null;
    return { built: stamp.commit.slice(0, 7), head: head.slice(0, 7), behind };
  } catch {
    return null;
  }
}

let inflight = null;
let generation = 0;
let cached = { at: 0, value: null, stampCommit: null };

/** Cached `computeStale` (60s) that also mirrors the result (plus the master it read) to stale.json for the CLI. */
export function getStale({ rootDir, env = process.env, now = Date.now(), compute = computeStale } = {}) {
  const stamp = rootDir ? readBuildStamp(rootDir) : null;
  const curStampCommit = stamp?.commit ?? null;
  if (now - cached.at < CACHE_MS && cached.at && curStampCommit === cached.stampCommit) return cached.value;
  const value = compute({ rootDir });
  cached = { at: now, value, stampCommit: curStampCommit };
  try {
    const file = staleFilePath(env);
    mkdirSync(join(file, ".."), { recursive: true });
    const master = stamp?.repo ? readRefSha(stamp.repo, "refs/heads/master") : null;
    writeFileSync(file, JSON.stringify({ stale: value, master, repo: stamp?.repo ?? null }));
  } catch {}
  return value;
}

/**
 * Async getStale: resolves at once with the cached value while it is under 60s old (same stamp); otherwise refreshes it
 * (single-flight, async git, async stale.json write) and resolves with the new value. Never blocks the loop on git.
 */
export function refreshStale({ rootDir, env = process.env, now = Date.now(), compute = computeStaleAsync } = {}) {
  const stamp = rootDir ? readBuildStamp(rootDir) : null;
  const curStampCommit = stamp?.commit ?? null;
  if (now - cached.at < CACHE_MS && cached.at && curStampCommit === cached.stampCommit) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  const gen = generation;
  const p = (async () => {
    try {
      const value = await compute({ rootDir });
      if (gen !== generation) return value; // resetStaleCache ran mid-flight: don't resurrect the dropped cache or file
      cached = { at: now, value, stampCommit: curStampCommit };
      try {
        const file = staleFilePath(env);
        await mkdir(join(file, ".."), { recursive: true });
        const master = stamp?.repo ? readRefSha(stamp.repo, "refs/heads/master") : null;
        await writeFile(file, JSON.stringify({ stale: value, master, repo: stamp?.repo ?? null }));
      } catch {}
      return value;
    } finally {
      if (inflight === p) inflight = null;
    }
  })();
  inflight = p;
  return p;
}

/** Last cached value only: no git, no stale.json write (the read-only /health path). */
export function peekStale(rootDir) {
  // A sync rewrote build-stamp.json since the value was cached: it describes the old build, so report nothing rather than a stale toast.
  if (rootDir && cached.at && (readBuildStamp(rootDir)?.commit ?? null) !== cached.stampCommit) return null;
  return cached.value;
}

export function resetStaleCache() {
  cached = { at: 0, value: null, stampCommit: null };
  inflight = null;
  generation += 1;
}

/**
 * One-line CLI warning from the published stale.json; null when fresh, missing, unreadable, or when refs/heads/master has
 * moved since stale.json was written (e.g. `git reset --keep HEAD~1` dropped the named head). The master re-check is a
 * spawn-free .git read, so `vs` never shells out on this path.
 */
export function staleWarning(env = process.env) {
  try {
    const s = JSON.parse(readFileSync(staleFilePath(env), "utf8"));
    const stale = s?.stale;
    if (!stale || !(stale.behind > 0)) return null;
    if (typeof s.repo === "string" && typeof s.master === "string") {
      const cur = readRefSha(s.repo, "refs/heads/master");
      if (cur && cur !== s.master) return null; // master moved since this was computed: don't name a dropped commit
    }
    return `vs: running an older build: ${stale.behind} commit${stale.behind === 1 ? "" : "s"} behind (${stale.built} vs ${stale.head}). Rebuild.`;
  } catch {
    return null;
  }
}
