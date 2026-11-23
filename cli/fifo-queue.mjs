// The append-only FIFO waiter line shared by the `npm test` slot (scripts/suite-lock.mjs) and the named slot pools
// (cli/slot-pool.mjs, `vs slot run`). It lives under cli/ because the runtime ships cli/ but not scripts/.
// One JSON line per event: {op:"join", id, pid, agentId, [squad,] at} | {op:"beat", id, at} | {op:"done", id}.
import { appendFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pidAlive } from "../runner/lock.mjs";

const myUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/**
 * The one machine-wide directory (per OS user) for the `npm test` slot (lock, queue, last-run record) and the `vs slot` pools.
 * It is NOT os.tmpdir(): TMPDIR differs by caller (runner shells, the forge systemd unit's ~/.cache/vibesquad-tmp, a plain shell's
 * /tmp), and a per-TMPDIR lock let two "exclusive" suites run at once and hid the last-run record from the server's watcher
 * (forge 11-23). POSIX: /tmp/vibesquad-test-lock-<uid> (per user, like Windows; checked by checkTestLockDir).
 * Windows: %LOCALAPPDATA%\vibesquad-test-lock. VIBESQUAD_TEST_LOCK_DIR overrides (tests point it at a temp dir so they never
 * touch the real slot).
 */
export function testLockDir(env = process.env, { platform = process.platform, home = os.homedir(), uid = myUid() } = {}) {
  const override = String(env.VIBESQUAD_TEST_LOCK_DIR ?? "").trim();
  if (override) return override;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "vibesquad-test-lock");
  return `/tmp/vibesquad-test-lock-${uid ?? "nouid"}`;
}

/**
 * Why `dir` must not hold the slot, or null when it is safe. Fails closed (lstat, never following a link) on: missing, a symlink,
 * not a directory, and on POSIX a different owner or any group/other permission bit. In a shared /tmp, another user could
 * otherwise pre-create the dir (or a link) and unlink our locks or forge the last-run record the watcher reads.
 */
export function checkTestLockDir(dir, { platform = process.platform, uid = myUid(), lstat = lstatSync } = {}) {
  let st;
  try {
    st = lstat(dir);
  } catch (e) {
    return `cannot stat (${e.code || e.message})`;
  }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isDirectory()) return "is not a directory";
  if (platform !== "win32") {
    if (uid !== null && st.uid !== uid) return `owned by uid ${st.uid}, not ${uid}`;
    if ((st.mode & 0o077) !== 0) return `mode ${(st.mode & 0o777).toString(8)} is open to group/other (want 700)`;
  }
  return null;
}

/** Creates `dir` (0700) if missing, then checkTestLockDir; throws code EVSLOCKDIR instead of using an unsafe dir. Returns `dir`. */
export function ensureTestLockDir(dir, opts = {}) {
  mkdirSync(path.dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 }); // not recursive: an existing dir/link/file is EEXIST and goes through the check below
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const why = checkTestLockDir(dir, opts);
  if (why) {
    const err = new Error(`refusing the test lock dir ${dir}: it ${why}. Remove it (or set VIBESQUAD_TEST_LOCK_DIR to a private dir) and retry.`);
    err.code = "EVSLOCKDIR";
    throw err;
  }
  return dir;
}

export const QUEUE_POLL_MS = 500;
export const QUEUE_BEAT_MS = 30_000;
// A waiter that has not beaten for this long is gone even if its pid is alive again (Windows reuses pids quickly).
export const QUEUE_BEAT_STALE_MS = 120_000;
export const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/** Append one record to `paths.queue`. */
export function appendQueue(paths, rec) {
  // One short O_APPEND write: atomic against other appenders. EPERM is Windows delete-pending (a claimer just compacted
  // the file while we opened it); it clears within milliseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      appendFileSync(paths.queue, JSON.stringify(rec) + "\n");
      return;
    } catch (e) {
      if (attempt >= 20 || !RETRY_CODES.includes(e.code)) throw e;
      sleepSync(10);
    }
  }
}

/**
 * Fold the queue file. `known` holds every id still joined (not done). `live` is the FIFO line of waiters whose pid is
 * alive and whose last beat is fresh; dead or silent waiters are skipped so they never block the ones behind them.
 */
export function readQueue(paths, { alive = pidAlive, now = Date.now(), beatStaleMs = QUEUE_BEAT_STALE_MS } = {}) {
  let text = "";
  try {
    text = readFileSync(paths.queue, "utf8");
  } catch {}
  const joined = new Map();
  for (const line of text.split("\n")) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // blank or torn line
    }
    if (!rec || typeof rec.id !== "string") continue;
    // squad: written only by a slot pool with reservations (idea-578); the npm-test slot's entries never carry it.
    if (rec.op === "join" && !joined.has(rec.id)) joined.set(rec.id, { id: rec.id, pid: rec.pid, agentId: rec.agentId ?? null, ...(rec.squad ? { squad: rec.squad } : {}), at: rec.at, beat: rec.at });
    else if (rec.op === "beat" && joined.has(rec.id)) joined.get(rec.id).beat = rec.at;
    else if (rec.op === "done") joined.delete(rec.id);
  }
  const live = [...joined.values()].filter((e) => alive(e.pid) && now - (Number(e.beat) || 0) < beatStaleMs);
  return { known: new Set(joined.keys()), live };
}
