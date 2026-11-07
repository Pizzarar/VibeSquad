// GET /__vibesquad/git/watch?cwd=&since= : long-poll that answers when the repo at `cwd` changes (a working-tree edit, a new
// untracked file, git add, commit, branch switch), so the Changes panel re-fetches instead of polling the diff.
//
// One shared entry per cwd: a recursive fs.watch on the cwd (node_modules and .git skipped), plus the git dir's `index` / `HEAD`
// and the common dir's `refs/` (the git dir is not under cwd in a linked worktree). Events are debounced into one bump of a
// counter. The cursor is `epoch:n`; a cursor from another epoch (watcher closed and recreated, server restarted) answers
// "changed" at once, which only costs the client one extra re-fetch. The last waiter leaving starts a short linger before the
// watchers close, so the gap between two back-to-back polls never loses a change.
// Fallback when recursive watching is unavailable (older Linux Node): the entry polls `git status` + `git diff --numstat`
// every FALLBACK_POLL_MS and bumps on a different signature (an in-place edit that keeps a file's line counts is missed there).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { join, resolve } from "node:path";

export const GIT_WATCH_HOLD_MS = 25_000; // client re-polls at once; keeps each request under proxy idle limits
export const GIT_WATCH_DEBOUNCE_MS = 150;
export const GIT_WATCH_LINGER_MS = 10_000;
const FALLBACK_POLL_MS = 1500;

const entries = new Map(); // normalized cwd -> entry
export const _gitWatcherCount = () => entries.size;
const norm = (p) => resolve(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
const segs = (f) => String(f).split(/[\\/]/).filter(Boolean);

/** True when a change under the cwd tree should wake waiters: anything outside node_modules and .git. */
export const worktreeEventRelevant = (f) => !f || !segs(f).some((s) => s === "node_modules" || s.toLowerCase() === ".git");
/** Git-dir events that matter: the index (staging, commit) and HEAD (branch switch); `index.lock` and objects/ are noise. */
export const gitDirEventRelevant = (f) => !f || ["index", "HEAD"].includes(String(f));

function git(args, cwd) {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => done(err ? null : String(stdout)));
  });
}

async function gitDirs(cwd) {
  const out = await git(["rev-parse", "--absolute-git-dir", "--git-common-dir"], cwd);
  if (!out) return null;
  const [dir, common] = out.split(/\r?\n/);
  if (!dir) return null;
  return { dir, common: common ? resolve(cwd, common) : dir };
}

async function fallbackSignature(cwd) {
  const [status, numstat, head] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd),
    git(["diff", "HEAD", "--numstat"], cwd),
    git(["rev-parse", "HEAD"], cwd),
  ]);
  return createHash("sha1").update(`${status}\0${numstat}\0${head}`).digest("hex");
}

let epochCounter = 0;

function createEntry(cwd, recursive) {
  const e = { n: 0, epoch: `${Date.now().toString(36)}${++epochCounter}`, waiters: new Set(), watchers: [], timer: null, linger: null, poll: null, ready: null, closed: false };
  const bump = () => {
    if (e.closed) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { e.n++; for (const fn of [...e.waiters]) fn(); }, e.debounceMs);
    e.timer.unref?.();
  };
  e.debounceMs = GIT_WATCH_DEBOUNCE_MS;
  const add = (path, opts, filter) => {
    try {
      const w = watch(path, { persistent: false, ...opts }, (_ev, f) => { if (filter(f)) bump(); });
      w.on("error", bump);
      e.watchers.push(w);
      return true;
    } catch { return false; }
  };
  e.ready = (async () => {
    const dirs = await gitDirs(cwd);
    let ok = recursive && add(cwd, { recursive: true }, worktreeEventRelevant);
    if (ok && dirs) {
      add(dirs.dir, {}, gitDirEventRelevant);
      add(join(dirs.common, "refs"), { recursive: true }, () => true);
    }
    if (!ok) {
      // Fallback: signature poll (also covers a non-recursive platform).
      let last = await fallbackSignature(cwd);
      e.poll = setInterval(async () => { const s = await fallbackSignature(cwd); if (s !== last) { last = s; bump(); } }, FALLBACK_POLL_MS);
      e.poll.unref?.();
    }
  })();
  return e;
}

function closeEntry(key, e) {
  e.closed = true;
  clearTimeout(e.timer);
  clearTimeout(e.linger);
  clearInterval(e.poll);
  for (const w of e.watchers) { try { w.close(); } catch { /* already closed */ } }
  if (entries.get(key) === e) entries.delete(key);
}

/**
 * Resolves { seq, changed }. `since` undefined = baseline (answers at once). A cursor that already differs answers at once
 * (changed true); otherwise waits for a change or `holdMs` (changed false). Aborting `signal` (client gone) leaves the entry,
 * which closes after `lingerMs` with no waiters.
 */
export async function gitWatch(cwd, since, { holdMs = GIT_WATCH_HOLD_MS, lingerMs = GIT_WATCH_LINGER_MS, debounceMs = GIT_WATCH_DEBOUNCE_MS, recursive = true, signal } = {}) {
  const key = norm(cwd);
  let e = entries.get(key);
  if (!e || e.closed) { e = createEntry(cwd, recursive); entries.set(key, e); }
  e.debounceMs = debounceMs;
  clearTimeout(e.linger);
  await e.ready;
  const cursor = () => `${e.epoch}:${e.n}`;
  if (typeof since !== "string" || !since) { scheduleLinger(key, e, lingerMs); return { seq: cursor(), changed: false }; }
  if (since !== cursor()) { scheduleLinger(key, e, lingerMs); return { seq: cursor(), changed: true }; }
  return new Promise((done) => {
    const finish = (changed) => {
      clearTimeout(hold);
      signal?.removeEventListener("abort", onAbort);
      e.waiters.delete(wake);
      scheduleLinger(key, e, lingerMs);
      done({ seq: cursor(), changed });
    };
    const wake = () => finish(true);
    const onAbort = () => finish(false);
    const hold = setTimeout(() => finish(false), holdMs);
    e.waiters.add(wake);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function scheduleLinger(key, e, lingerMs) {
  if (e.waiters.size || e.closed) return;
  clearTimeout(e.linger);
  e.linger = setTimeout(() => { if (!e.waiters.size) closeEntry(key, e); }, lingerMs);
  e.linger.unref?.();
}

/** Route glue: GET ?cwd=&since= with `cwd` already resolved by the caller. */
export function handleGitWatch(req, res, cwd, since, sendJson, opts = {}) {
  const ac = new AbortController();
  res.on("close", () => !res.writableFinished && ac.abort());
  return gitWatch(cwd, since || undefined, { ...opts, signal: ac.signal }).then((r) => {
    if (ac.signal.aborted) return;
    return sendJson(res, 200, { seq: r.seq, changed: r.changed });
  });
}
