// Cross-process lock for read-modify-write of a shared JSON/text file (server + `vs` CLI + runner all write ~/.vibesquad files).
// Two front ends over one acquire step:
//  - withFileLock / updateJsonFile (async): waits with setTimeout between polls, so a contended lock never blocks the
//    event loop. Every request path in the server process uses these (idea-227, idea-114 L1).
//  - withFileLockSync / updateJsonFileSync: spins with Atomics.wait. Only for the CLI and one-shot scripts, where
//    blocking the thread is harmless, and for timeoutMs: 0 single tries (no waiting at all).
// Both take the same <target>.lock (O_EXCL create via runner/lock.mjs) holding { pid, startedAt, token }, apply the same
// stale rules, and exclude each other across processes. Old holders that write { pid, startedAt } are still understood.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive, readLock, releaseLock, tryCreateLock } from "../runner/lock.mjs";
import { writeFileAtomic } from "./brief-write.mjs";

export const FILE_LOCK_TIMEOUT_MS = 5000;
export const FILE_LOCK_STALE_MS = 30000;
/** error.code on a lock wait that timed out / a holder that lost its lock before committing (idea-235). */
export const LOCK_TIMEOUT = "ELOCKTIMEOUT";
export const LOCK_LOST = "ELOCKLOST";
/**
 * True for a failure the caller did not cause and should retry: a lock timeout or lost lock, or a Node fs/system error
 * (has .syscall). Their messages carry the lock/file path and holder pid, so request handlers answer these with a
 * generic 503 and log the detail server-side only (idea-232/idea-235).
 */
export const isFileLockError = (e) => e?.code === LOCK_TIMEOUT || e?.code === LOCK_LOST;
export const isServerSideFsError = (e) => isFileLockError(e) || (typeof e?.code === "string" && typeof e?.syscall === "string");
const POLL_MS = 10;
const UNREADABLE_GRACE_MS = 1000; // an unreadable lock younger than this is mid-write, not stale
const REAP_GUARD_STALE_MS = 2000;
const MAX_IMMEDIATE_RETRIES = 4; // after a reap / vanished lock, retry at once this many times before polling again

// Created lazily: SharedArrayBuffer is undefined in a non-crossOriginIsolated browser, and this module must never throw on import.
let sleepBuf = null;
const sleepSync = (ms) => {
  if (typeof SharedArrayBuffer === "undefined") return;
  sleepBuf ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepBuf, 0, 0, ms);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};
const isDeletePending = (e) => e?.code === "EPERM" || e?.code === "EACCES";

/** Same lock instance: pid, startedAt and token all equal (token is undefined on both for old-format locks). */
const sameLock = (a, b) => (!a || !b ? !a && !b : a.pid === b.pid && a.startedAt === b.startedAt && a.token === b.token);

/** Stale = holder pid dead, or held longer than staleMs; an unreadable lock is stale only once its mtime is old. */
function isStale(info, mtime, { staleMs, alive }) {
  if (!info) return Date.now() - mtime > UNREADABLE_GRACE_MS;
  const startedAt = Number.isFinite(info.startedAt) ? info.startedAt : mtime;
  return !alive(info.pid) || Date.now() - startedAt > staleMs;
}

/**
 * Remove `lockFile` only if it is still exactly the lock we judged stale (idea-114 L4). Under <lock>.reap, so two waiters
 * can't both pass the check and the slower one delete the faster one's fresh lock. Before the rm it re-checks the mtime
 * (rewritten or re-created since the judgement), the identity (pid + startedAt + token), and the staleness itself with a
 * fresh pid liveness check. Returns true when the lock is gone (retry the create now), false to keep waiting.
 * Exported for tests.
 */
export function reapStaleLock(lockFile, seen, seenMtime, { staleMs = FILE_LOCK_STALE_MS, alive = pidAlive } = {}) {
  const reap = `${lockFile}.reap`;
  let guarded = false;
  try {
    guarded = tryCreateLock(reap, process.pid, { budgetMs: 0 });
  } catch {
    guarded = false; // delete-pending guard: someone just finished reaping, look again next poll
  }
  if (!guarded) {
    const guardMtime = mtimeOf(reap);
    if (guardMtime !== null && Date.now() - guardMtime > REAP_GUARD_STALE_MS) rmSync(reap, { force: true }); // dead reaper
    return false;
  }
  try {
    const mtime = mtimeOf(lockFile);
    if (mtime === null) return true; // released meanwhile
    if (mtime !== seenMtime) return false; // rewritten or re-created since we judged it
    const now = readLock(lockFile);
    if (!sameLock(now, seen)) return false; // a different holder, or it became readable: judge it afresh
    if (!isStale(now, mtime, { staleMs, alive })) return false; // e.g. the holder pid answers again
    rmSync(lockFile, { force: true });
    return true;
  } finally {
    releaseLock(reap);
  }
}

/**
 * One acquisition of <targetPath>.lock, shared by the sync and async front ends.
 * poll() returns "owned" | "wait" (poll again after POLL_MS) | "retry" (try again at once); it throws on timeout.
 * The timeout detects a stuck holder, not total queue time: a different holder than last poll restarts the clock.
 */
function lockAttempt(targetPath, { timeoutMs, staleMs, alive, nonBlockingCreate }) {
  const lockFile = `${targetPath}.lock`;
  mkdirSync(dirname(lockFile), { recursive: true });
  const token = randomBytes(8).toString("hex");
  let deadline = Date.now() + timeoutMs;
  let holderKey = null;
  const timedOut = (info) =>
    Object.assign(new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockFile} (held by pid ${info?.pid ?? "unknown"})`), {
      code: LOCK_TIMEOUT,
    });

  function poll() {
    try {
      // The async front end must not sit in tryCreateLock's sync delete-pending retry: budget 0, and a delete-pending
      // name is just another busy poll.
      if (tryCreateLock(lockFile, process.pid, { body: { token }, ...(nonBlockingCreate ? { budgetMs: 0 } : {}) })) return "owned";
    } catch (e) {
      if (!nonBlockingCreate || !isDeletePending(e)) throw e;
      if (Date.now() >= deadline) throw timedOut(null);
      return "wait";
    }
    const info = readLock(lockFile);
    const key = info ? `${info.pid}:${info.startedAt}:${info.token ?? ""}` : null;
    if (key && key !== holderKey) {
      holderKey = key;
      deadline = Date.now() + timeoutMs;
    }
    if (Date.now() >= deadline) throw timedOut(info);
    const mtime = mtimeOf(lockFile);
    if (mtime === null) return "retry"; // vanished between create and stat
    if (info?.pid === process.pid) return "wait"; // ours (re-entry or another task here): never steal it, just time out
    if (!isStale(info, mtime, { staleMs, alive })) return "wait";
    return reapStaleLock(lockFile, info, mtime, { staleMs, alive }) ? "retry" : "wait";
  }

  /** Ours = the lock file still names this pid and this acquisition's token. */
  const stillOwned = () => {
    const now = readLock(lockFile);
    return now?.pid === process.pid && now?.token === token;
  };
  const handle = {
    file: lockFile,
    stillOwned,
    assertOwned() {
      if (!stillOwned()) {
        throw Object.assign(new Error(`lock lost: ${lockFile} is no longer held by this process (reaped as stale?); nothing written`), {
          code: LOCK_LOST,
        });
      }
    },
  };
  /** Remove the lock only if it is still this acquisition's (a reaped holder must not delete its successor's lock). */
  const release = () => {
    if (stillOwned()) rmSync(lockFile, { force: true });
  };
  return { poll, handle, release };
}

const lockOptions = ({ timeoutMs = FILE_LOCK_TIMEOUT_MS, staleMs = FILE_LOCK_STALE_MS, alive = pidAlive } = {}) => ({ timeoutMs, staleMs, alive });

/**
 * Run fn(lock) while holding <targetPath>.lock. Waits (sync, blocking the thread) up to timeoutMs without the holder
 * changing, taking over locks whose owner pid is dead or that are older than staleMs. Always releases (only a lock this
 * acquisition owns). Returns fn()'s value. timeoutMs: 0 = one try, no waiting.
 * For the CLI and one-shot scripts; server request paths use withFileLock.
 * Not re-entrant: a nested call on the same path in one process waits out the timeout and throws.
 *
 * `lock.assertOwned()` (X1 E4a R2 L4): a holder that stalls past staleMs gets reaped and another writer takes over; when
 * the stalled one resumes it must not commit its stale view. Callers invoke it right before their rename/atomic write;
 * it re-reads the lock file and throws when it no longer holds this acquisition's { pid, token }.
 */
export function withFileLockSync(targetPath, fn, opts) {
  const o = lockOptions(opts);
  // timeoutMs: 0 is one try that never sleeps: also skip tryCreateLock's sync delete-pending retry.
  const attempt = lockAttempt(targetPath, { ...o, nonBlockingCreate: o.timeoutMs === 0 });
  for (let spins = 0; ; ) {
    const r = attempt.poll();
    if (r === "owned") break;
    if (r === "retry" && ++spins <= MAX_IMMEDIATE_RETRIES) continue;
    spins = 0;
    sleepSync(POLL_MS);
  }
  try {
    return fn(attempt.handle);
  } finally {
    attempt.release();
  }
}

/** Run fn under an owned attempt. A sync fn releases before returning; an async one when its promise settles. */
function runHeld(attempt, fn) {
  let out;
  try {
    out = fn(attempt.handle);
  } catch (e) {
    attempt.release();
    throw e;
  }
  if (out && typeof out.then === "function") return Promise.resolve(out).finally(() => attempt.release());
  attempt.release();
  return out;
}

/**
 * Async withFileLockSync: same lock file, stale rules and timeout, but waits with setTimeout so the event loop keeps
 * running. Uncontended, the whole acquire + fn + release happens synchronously within the call (so two back-to-back
 * unawaited calls never contend with each other). fn may be async (the lock is held until it settles); keep it short
 * and sync where possible. Always returns a promise: fn's value; rejects on timeout or when fn throws.
 */
export function withFileLock(targetPath, fn, opts) {
  try {
    const attempt = lockAttempt(targetPath, { ...lockOptions(opts), nonBlockingCreate: true });
    let spins = 0;
    const next = () => {
      for (;;) {
        const r = attempt.poll();
        if (r === "owned") return runHeld(attempt, fn);
        if (r === "retry" && ++spins <= MAX_IMMEDIATE_RETRIES) continue;
        spins = 0;
        return sleep(POLL_MS).then(next);
      }
    };
    return Promise.resolve(next());
  } catch (e) {
    return Promise.reject(e);
  }
}

/** The locked body of updateJsonFile(Sync): read (missing = fallback, corrupt = throw), mutate, ownership check, atomic write. */
const jsonUpdate = (targetPath, mutate, fallback) => (lock) => {
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
  lock.assertOwned(); // a reaped (stale) holder must not commit over a newer writer's file
  writeFileAtomic(targetPath, JSON.stringify(next, null, 2) + "\n");
  return next;
};

/**
 * Locked read-modify-write of a JSON file. mutate(data) may mutate in place and return undefined, or return the new
 * value. A missing file yields `fallback` (default {}); an unparseable one throws (never overwritten). Written atomically. Returns the written value.
 * Sync (blocks while waiting): CLI / one-shot callers. Server request paths use updateJsonFile.
 */
export function updateJsonFileSync(targetPath, mutate, { fallback = {}, ...lockOpts } = {}) {
  return withFileLockSync(targetPath, jsonUpdate(targetPath, mutate, fallback), lockOpts);
}

/** Async updateJsonFileSync (never blocks the event loop while waiting). `mutate` stays synchronous. */
export function updateJsonFile(targetPath, mutate, { fallback = {}, ...lockOpts } = {}) {
  return withFileLock(targetPath, jsonUpdate(targetPath, mutate, fallback), lockOpts);
}

/** `f(value)`, or `value.then(f)` when value is a promise: lets one writer body serve a sync and an async lock front end. */
export const thenMaybe = (value, f) => (value && typeof value.then === "function" ? value.then(f) : f(value));
