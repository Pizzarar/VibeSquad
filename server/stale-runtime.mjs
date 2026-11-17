import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
let cached = { at: 0, value: null, stampCommit: null };

/** Cached `computeStale` (60s) that also mirrors the result to stale.json for the CLI. */
export function getStale({ rootDir, env = process.env, now = Date.now(), compute = computeStale } = {}) {
  const curStampCommit = rootDir ? (readBuildStamp(rootDir)?.commit ?? null) : null;
  if (now - cached.at < CACHE_MS && cached.at && curStampCommit === cached.stampCommit) return cached.value;
  const value = compute({ rootDir });
  cached = { at: now, value, stampCommit: curStampCommit };
  try {
    const file = staleFilePath(env);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ stale: value }));
  } catch {}
  return value;
}

/**
 * Non-blocking getStale: returns the cached value now and, when it is older than 60s (or the stamp changed), refreshes it in the
 * background (single-flight, async git, async stale.json write). Resolves with the refreshed value; callers need not await it.
 */
export function refreshStale({ rootDir, env = process.env, now = Date.now(), compute = computeStaleAsync } = {}) {
  const curStampCommit = rootDir ? (readBuildStamp(rootDir)?.commit ?? null) : null;
  if (now - cached.at < CACHE_MS && cached.at && curStampCommit === cached.stampCommit) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await compute({ rootDir });
      cached = { at: now, value, stampCommit: curStampCommit };
      try {
        const file = staleFilePath(env);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, JSON.stringify({ stale: value }));
      } catch {}
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Last cached value only: no git, no stale.json write (the read-only /health path). */
export function peekStale() {
  return cached.value;
}

export function resetStaleCache() {
  cached = { at: 0, value: null, stampCommit: null };
  inflight = null;
}

/** One-line CLI warning from the published stale.json; null when fresh, missing, or unreadable. */
export function staleWarning(env = process.env) {
  try {
    const s = JSON.parse(readFileSync(staleFilePath(env), "utf8"))?.stale;
    if (!s || !(s.behind > 0)) return null;
    return `vs: running an older build: ${s.behind} commit${s.behind === 1 ? "" : "s"} behind (${s.built} vs ${s.head}). Rebuild.`;
  } catch {
    return null;
  }
}
