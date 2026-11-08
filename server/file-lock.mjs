// Cross-process lock for read-modify-write of a shared JSON/text file (server + `vs` CLI both write ~/.vibesquad files).
// Synchronous on purpose: the callers are sync. Reuses runner/lock.mjs (O_EXCL create + pid liveness) and brief-write's
// writeFileAtomic. Locks live at <target>.lock and hold { pid, startedAt }.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { pidAlive, readLock, releaseLock, tryCreateLock } from "../runner/lock.mjs";
import { writeFileAtomic } from "./brief-write.mjs";

export const FILE_LOCK_TIMEOUT_MS = 5000;
export const FILE_LOCK_STALE_MS = 30000;
const POLL_MS = 10;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/** Remove the lock only if it is still the one we judged stale (narrows the take-over race). */
function removeIfSame(lockFile, seen) {
  const now = readLock(lockFile);
  if ((now?.pid ?? null) === (seen?.pid ?? null) && (now?.startedAt ?? null) === (seen?.startedAt ?? null)) {
    rmSync(lockFile, { force: true });
  }
}

/**
 * Run fn() while holding <targetPath>.lock. Waits (sync) up to timeoutMs, taking over locks whose owner pid is dead
 * or that are older than staleMs. Always releases (only a lock this process owns). Returns fn()'s value.
 * Not re-entrant: a nested call on the same path in one process waits out the timeout and throws.
 */
export function withFileLockSync(targetPath, fn, { timeoutMs = FILE_LOCK_TIMEOUT_MS, staleMs = FILE_LOCK_STALE_MS, alive = pidAlive } = {}) {
  const lockFile = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreateLock(lockFile)) break;
    const info = readLock(lockFile);
    let age = null;
    try {
      age = Date.now() - statSync(lockFile).mtimeMs;
    } catch {
      continue; // vanished between create and stat: retry at once
    }
    const stale = info ? !alive(info.pid) || age > staleMs : age > 1000; // unreadable = mid-write unless old
    if (stale) {
      removeIfSame(lockFile, info);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockFile} (held by pid ${info?.pid ?? "unknown"})`);
    }
    sleepSync(POLL_MS);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Locked read-modify-write of a JSON file. mutate(data) may mutate in place and return undefined, or return the new
 * value. A missing/unparseable file yields `fallback` (default {}). Written atomically. Returns the written value.
 */
export function updateJsonFileSync(targetPath, mutate, { fallback = {}, ...lockOpts } = {}) {
  return withFileLockSync(
    targetPath,
    () => {
      let data;
      try {
        data = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, "utf8")) : structuredClone(fallback);
      } catch {
        data = structuredClone(fallback);
      }
      const out = mutate(data);
      const next = out === undefined ? data : out;
      writeFileAtomic(targetPath, JSON.stringify(next, null, 2) + "\n");
      return next;
    },
    lockOpts,
  );
}
