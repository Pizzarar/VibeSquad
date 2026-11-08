// Cross-process lock for read-modify-write of a shared JSON/text file (server + `vs` CLI both write ~/.vibesquad files).
// Synchronous on purpose: the callers are sync. Reuses runner/lock.mjs (O_EXCL create + pid liveness) and brief-write's
// writeFileAtomic. Locks live at <target>.lock and hold { pid, startedAt }.
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive, readLock, releaseLock, tryCreateLock } from "../runner/lock.mjs";
import { writeFileAtomic } from "./brief-write.mjs";

export const FILE_LOCK_TIMEOUT_MS = 5000;
export const FILE_LOCK_STALE_MS = 30000;
const POLL_MS = 10;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/**
 * Remove the lock only if it is still the one we judged stale. Serialised through <lock>.reap so two waiters
 * can't both pass the check and the slower one delete the faster one's fresh lock.
 */
function reapStale(lockFile, seen) {
  const reap = `${lockFile}.reap`;
  if (!tryCreateLock(reap)) {
    try { if (Date.now() - statSync(reap).mtimeMs > 2000) rmSync(reap, { force: true }); } catch {} // dead reaper
    return;
  }
  try {
    const now = readLock(lockFile);
    if (now && now.pid === seen?.pid && now.startedAt === seen?.startedAt) rmSync(lockFile, { force: true });
    else if (!now && !seen) rmSync(lockFile, { force: true }); // unreadable and old: only mtime said stale
  } finally {
    releaseLock(reap);
  }
}

/**
 * Run fn() while holding <targetPath>.lock. Waits (sync) up to timeoutMs, taking over locks whose owner pid is dead
 * or that are older than staleMs. Always releases (only a lock this process owns). Returns fn()'s value.
 * Not re-entrant: a nested call on the same path in one process waits out the timeout and throws.
 */
export function withFileLockSync(targetPath, fn, { timeoutMs = FILE_LOCK_TIMEOUT_MS, staleMs = FILE_LOCK_STALE_MS, alive = pidAlive } = {}) {
  const lockFile = `${targetPath}.lock`;
  mkdirSync(dirname(lockFile), { recursive: true });
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
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockFile} (held by pid ${info?.pid ?? "unknown"})`);
    }
    if (info?.pid === process.pid) { // our own lock (re-entry): never steal it, just time out
      sleepSync(POLL_MS);
      continue;
    }
    const heldFor = Date.now() - (Number.isFinite(info?.startedAt) ? info.startedAt : Date.now() - age);
    const stale = info ? !alive(info.pid) || heldFor > staleMs : age > 1000; // unreadable = mid-write unless old
    if (stale) reapStale(lockFile, info);
    else sleepSync(POLL_MS);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Locked read-modify-write of a JSON file. mutate(data) may mutate in place and return undefined, or return the new
 * value. A missing file yields `fallback` (default {}); an unparseable one throws (never overwritten). Written atomically. Returns the written value.
 */
export function updateJsonFileSync(targetPath, mutate, { fallback = {}, ...lockOpts } = {}) {
  return withFileLockSync(
    targetPath,
    () => {
      let raw = null;
      try {
        raw = readFileSync(targetPath, "utf8");
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
      // fallback only for a missing file; a corrupt one throws so we never wipe real data
      const data = raw === null ? structuredClone(fallback) : JSON.parse(raw.replace(/^﻿/, ""));
      const out = mutate(data);
      const next = out === undefined ? data : out;
      writeFileAtomic(targetPath, JSON.stringify(next, null, 2) + "\n");
      return next;
    },
    lockOpts,
  );
}
