// Lockfiles that keep ONE runner per home. Shared by runner/server.mjs (runner.lock, held for the runner's life)
// and server/backend/runner-client.mjs (starting.lock, held only while one process spawns the runner).
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

export const STALE_START_LOCK_MS = 15000;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readLock(file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

/** O_EXCL create of `file` holding { pid, startedAt }. True if we now own it. */
export function tryCreateLock(file, pid = process.pid) {
  let fd;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ pid, startedAt: Date.now() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function releaseLock(file, pid = process.pid) {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}

/**
 * Start lock: O_EXCL file with a stale timeout (also stale when its owner pid is dead).
 * Returns true if acquired; false if another live process holds a fresh lock.
 */
export function acquireStartLock(file, { staleMs = STALE_START_LOCK_MS, alive = pidAlive } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreateLock(file)) return true;
    const info = readLock(file);
    let age;
    try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; } // vanished: retry
    if (info && alive(info.pid) && age < staleMs) return false;
    if (!info && age < 1000) return false; // created but not yet written
    rmSync(file, { force: true }); // stale: take over
  }
  return false;
}

/**
 * Runner lock: exclusive for the runner's lifetime. `isHealthy()` says whether the holder answers /health.
 * Returns { owned: true } if we hold it now, else { owned: false, holder } when a live runner owns the home.
 */
export async function acquireRunnerLock(home, { isHealthy, alive = pidAlive, bootGraceMs = STALE_START_LOCK_MS } = {}) {
  const file = path.join(home, 'runner.lock');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreateLock(file)) return { owned: true, file };
    const info = readLock(file);
    if (info && info.pid !== process.pid && alive(info.pid)) {
      const booting = Date.now() - (info.startedAt ?? 0) < bootGraceMs;
      if (booting || (await isHealthy?.())) return { owned: false, holder: info.pid };
    }
    rmSync(file, { force: true }); // dead holder or live-but-unresponsive: take over
  }
  return { owned: false, holder: readLock(file)?.pid };
}
