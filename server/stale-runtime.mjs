import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STAMP_FILE = "build-stamp.json";
const GIT_TIMEOUT_MS = 2000;
const CACHE_MS = 60_000;

const defaultGit = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Where the server publishes its stale state so `vs` can warn without running git or an HTTP call. */
export function staleFilePath(env = process.env) {
  return join(env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "stale.json");
}

/** Build-time stamp `{commit, repo}` written by `build:desktop` into the runtime; null when absent or malformed. */
export function readBuildStamp(rootDir) {
  try {
    const s = JSON.parse(readFileSync(join(rootDir, STAMP_FILE), "utf8"));
    return s && typeof s.commit === "string" && typeof s.repo === "string" ? s : null;
  } catch {
    return null;
  }
}

/** `{built, head, behind}` when the stamped build trails the repo's master, else null. Any git/stamp failure means not stale. */
export function computeStale({ rootDir, git = defaultGit, exists = existsSync } = {}) {
  try {
    const stamp = readBuildStamp(rootDir);
    if (!stamp || !exists(stamp.repo)) return null;
    const head = git(stamp.repo, ["rev-parse", "master"]);
    if (!head || head === stamp.commit) return null;
    const behind = Number.parseInt(git(stamp.repo, ["rev-list", "--count", `${stamp.commit}..${head}`]), 10);
    if (!Number.isFinite(behind) || behind <= 0) return null;
    return { built: stamp.commit.slice(0, 7), head: head.slice(0, 7), behind };
  } catch {
    return null;
  }
}

let cached = { at: 0, value: null };

/** Cached `computeStale` (60s) that also mirrors the result to stale.json for the CLI. */
export function getStale({ rootDir, env = process.env, now = Date.now(), compute = computeStale } = {}) {
  if (now - cached.at < CACHE_MS && cached.at) return cached.value;
  const value = compute({ rootDir });
  cached = { at: now, value };
  try {
    const file = staleFilePath(env);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ stale: value }));
  } catch {}
  return value;
}

/** Last cached value only: no git, no stale.json write (the read-only /health path). */
export function peekStale() {
  return cached.value;
}

export function resetStaleCache() {
  cached = { at: 0, value: null };
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
