// Storybook pinned-sha reader. Storybook is read-only toward the project repo: every read is `git show <sha>:<path>`,
// `git ls-tree`, `git rev-parse` or `git cat-file`, run through execFile with an args array (no shell). The working tree is
// never read, so a stale or dirty local checkout cannot leak into a report.
// The one exception to "read-only" is fetchRepo(): an optional, rate-limited `git fetch` that only moves remote-tracking refs.
// SB1 exports and tests it on a fake repo only; nothing in SB1 calls it against a real project.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;
export const FETCH_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Run git with an args array, never a shell. Resolves {ok,out,err,code}; never rejects. */
export function runGit(repo, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ ok: !err, out: String(stdout ?? ""), err: String(stderr ?? ""), code });
    });
  });
}

function safeRef(ref) {
  const r = String(ref ?? "");
  if (!r || r.startsWith("-") || /[\0\n]/.test(r)) throw new Error(`storybook git-read: bad ref ${JSON.stringify(r)}`);
  return r;
}
function safePath(p) {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (s.split("/").includes("..") || /[\0\n]/.test(s)) throw new Error(`storybook git-read: bad path ${JSON.stringify(p)}`);
  return s;
}

/** The remote default branch name (`main`), from refs/remotes/origin/HEAD; falls back to `main`. */
export async function defaultBranch(repo) {
  const r = await runGit(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const m = /^origin\/(.+)$/.exec(r.out.trim());
  if (r.ok && m && m[1] !== "HEAD") return m[1];
  return "main";
}

/**
 * Resolve a ref to a full commit sha. With no ref (or 'origin/HEAD') it means origin/<default branch>.
 * A full 40-hex sha is verified and returned as is.
 */
export async function resolveRef(repo, ref) {
  let want = ref == null || ref === "" || ref === "origin/HEAD" ? `origin/${await defaultBranch(repo)}` : safeRef(ref);
  const r = await runGit(repo, ["rev-parse", "--verify", "--quiet", `${want}^{commit}`]);
  if (!r.ok || !/^[0-9a-f]{40,64}$/.test(r.out.trim())) throw new Error(`storybook git-read: cannot resolve ${want} in ${repo}`);
  return r.out.trim();
}

/** Raw file text at sha:path, or null when the path does not exist at that sha. */
export async function readFile(repo, sha, file) {
  const r = await runGit(repo, ["show", `${safeRef(sha)}:${safePath(file)}`]);
  return r.ok ? r.out : null;
}

/** True when sha:path exists (file or directory). */
export async function exists(repo, sha, file) {
  const r = await runGit(repo, ["cat-file", "-e", `${safeRef(sha)}:${safePath(file)}`]);
  return r.ok;
}

/** Entries of a directory at sha (non-recursive unless recursive): [{path,type:'blob'|'tree',mode}]. Missing dir -> []. */
export async function listTree(repo, sha, dir = "", { recursive = false } = {}) {
  const d = safePath(dir).replace(/\/+$/, "");
  const args = ["ls-tree", "-z", ...(recursive ? ["-r"] : []), safeRef(sha), ...(d ? [`${d}/`] : [])];
  const r = await runGit(repo, args);
  if (!r.ok) return [];
  return r.out.split("\0").filter(Boolean).map((row) => {
    const m = /^(\d+) (\w+) [0-9a-f]+\t(.*)$/s.exec(row);
    return m ? { mode: m[1], type: m[2], path: m[3] } : null;
  }).filter(Boolean);
}

/** A reader bound to one repo + sha. This is the object adapters receive. */
export function makeReader(repo, sha) {
  return {
    repo, sha,
    readFile: (p) => readFile(repo, sha, p),
    exists: (p) => exists(repo, sha, p),
    listTree: (d, o) => listTree(repo, sha, d, o),
  };
}

/** Resolve + bind in one call. */
export async function openReader(repo, ref) {
  return makeReader(repo, await resolveRef(repo, ref));
}

function dataHome(env = process.env) {
  return env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");
}
/** Stamp file for a repo: <VIBESQUAD_HOME or ~/.vibesquad>/storybook/fetch-stamps/<hash of abs repo path>.json */
export function fetchStampPath(repo, { home = dataHome() } = {}) {
  const key = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
  return path.join(home, "storybook", "fetch-stamps", `${key}.json`);
}

/**
 * Optional `git fetch origin`, at most once per hour per repo (stamp file). Returns {fetched, skipped, nextAllowedAt, ok}.
 * Only attempts are stamped (a failed fetch also waits the hour, so a broken remote is not hammered).
 */
export async function fetchRepo(repo, { home, now = Date.now(), minIntervalMs = FETCH_MIN_INTERVAL_MS } = {}) {
  const stamp = fetchStampPath(repo, home ? { home } : undefined);
  let last = 0;
  try { last = Number(JSON.parse(fs.readFileSync(stamp, "utf8")).at) || 0; } catch { /* no stamp yet */ }
  if (last && now - last < minIntervalMs) return { fetched: false, skipped: "rate-limited", ok: true, nextAllowedAt: last + minIntervalMs };
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, JSON.stringify({ at: now, repo: path.resolve(repo) }));
  const r = await runGit(repo, ["fetch", "--quiet", "origin"], { timeoutMs: 120_000 });
  return { fetched: r.ok, skipped: null, ok: r.ok, err: r.ok ? "" : r.err.slice(0, 300), nextAllowedAt: now + minIntervalMs };
}
