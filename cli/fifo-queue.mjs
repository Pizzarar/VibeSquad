// The append-only FIFO waiter line shared by the `npm test` slot (scripts/suite-lock.mjs) and the named slot pools
// (cli/slot-pool.mjs, `vs slot run`). It lives under cli/ because the runtime ships cli/ but not scripts/.
// One JSON line per event: {op:"join", id, pid, agentId, [squad,] at} | {op:"beat", id, at} | {op:"done", id}.
import { appendFileSync, readFileSync } from "node:fs";
import { pidAlive } from "../runner/lock.mjs";

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
