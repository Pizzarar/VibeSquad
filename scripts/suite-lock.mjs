// The machine-wide `npm test` slot (scripts/run-tests.mjs): one lock, an opt-in FIFO queue and a last-run record.
// The watcher (server/watch-sets.mjs) reads these file names and fields, so keep them stable.
//   <dir>/vibesquad-npm-test.lock       {pid, agentId, startedAt, full, files}  O_EXCL, held for the run (runner/lock.mjs)
//   <dir>/vibesquad-npm-test-last.json  {agentId, pid, startedAt, finishedAt, full, files, tests, pass, fail, failingFiles} on exit,
//                                       or {agentId, pid, startedAt, full, files, died:true} written by whoever steals a dead holder's lock
// full: true only for a whole-suite run (no file args); files: the file args. A watch set's suite item accepts only full runs.
//   <dir>/vibesquad-npm-test.queue      append-only JSON lines: join / beat / done, see readQueue
// <dir> is os.tmpdir(), or VIBESQUAD_TEST_LOCK_DIR (tests point it at a temp dir so they never touch the real slot).
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireStartLock, pidAlive, readLock } from "../runner/lock.mjs";

export const SUITE_STALE_MS = 2 * 60 * 60 * 1000; // a live holder older than this is stuck and gets taken over
export const QUEUE_POLL_MS = 500;
export const QUEUE_BEAT_MS = 30_000;
// A waiter that has not beaten for this long is gone even if its pid is alive again (Windows reuses pids quickly).
export const QUEUE_BEAT_STALE_MS = 120_000;

export function suitePaths(dir = process.env.VIBESQUAD_TEST_LOCK_DIR || os.tmpdir()) {
  return {
    dir,
    lock: path.join(dir, "vibesquad-npm-test.lock"),
    last: path.join(dir, "vibesquad-npm-test-last.json"),
    queue: path.join(dir, "vibesquad-npm-test.queue"),
  };
}

/** The agent running this suite: the runner exports VS_AGENT_ID (and PASEO_AGENT_ID) to every agent. null for a human. */
export function callerAgentId(env = process.env) {
  const id = String(env.VS_AGENT_ID || env.PASEO_AGENT_ID || "").trim();
  return id || null;
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];

/** Write-then-rename so a reader never sees half a file. Windows refuses the rename while a reader has the target open; retry briefly. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 20 || !RETRY_CODES.includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(sleepBuf, 0, 0, 10 + attempt * 5);
    }
  }
}

export function readLast(paths) {
  return readLock(paths.last);
}

const sameRun = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

/** The old holder's lock is being stolen: record that its run died, unless it already wrote its own result. */
export function recordDied(paths, old, reason = "dead") {
  if (!Number.isInteger(old?.pid)) return;
  if (sameRun(readLast(paths), old)) return;
  const rec = { agentId: old.agentId ?? null, pid: old.pid, startedAt: old.startedAt ?? null, full: old.full === true, files: Array.isArray(old.files) ? old.files : [], died: true };
  if (reason !== "dead") rec.reason = reason; // "stale": alive but past SUITE_STALE_MS
  writeJsonAtomic(paths.last, rec);
}

/** One try for the slot. Returns the slot {pid, agentId, startedAt, full, files} or null while another live run holds it. */
export function tryAcquireSlot(paths, { pid = process.pid, agentId = callerAgentId(), alive = pidAlive, staleMs = SUITE_STALE_MS, full = false, files = [] } = {}) {
  const startedAt = Date.now();
  const run = { full: full === true, files: [...files] };
  const ok = acquireStartLock(paths.lock, {
    staleMs,
    alive,
    pid,
    body: { agentId, startedAt, ...run },
    onSteal: (old, reason) => recordDied(paths, old, reason),
  });
  return ok ? { pid, agentId, startedAt, ...run } : null;
}

/**
 * End of the run: write the result record (before the release, so a stealer that finds the lock still there sees the
 * result and writes no died record), then drop the lock. Skips the record if another run has already taken the lock over.
 */
export function finishSlot(paths, slot, { tests = null, pass = null, fail = null, failingFiles = [], ...extra } = {}) {
  const cur = readLock(paths.lock);
  const ours = sameRun(cur, slot);
  if (ours || !cur) {
    writeJsonAtomic(paths.last, {
      agentId: slot.agentId ?? null,
      pid: slot.pid,
      startedAt: slot.startedAt,
      finishedAt: Date.now(),
      full: slot.full === true,
      files: Array.isArray(slot.files) ? slot.files : [],
      tests,
      pass,
      fail,
      failingFiles,
      ...extra,
    });
  }
  if (ours) rmSync(paths.lock, { force: true });
}

function appendQueue(paths, rec) {
  // One short O_APPEND write: atomic against other appenders. EPERM is Windows delete-pending (a claimer just compacted
  // the file while we opened it); it clears within milliseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      appendFileSync(paths.queue, JSON.stringify(rec) + "\n");
      return;
    } catch (e) {
      if (attempt >= 20 || !RETRY_CODES.includes(e.code)) throw e;
      Atomics.wait(sleepBuf, 0, 0, 10);
    }
  }
}

/**
 * Fold the queue file. Lines: {op:"join", id, pid, agentId, at} | {op:"beat", id, at} | {op:"done", id}.
 * `known` holds every id still joined (not done). `live` is the FIFO line of waiters whose pid is alive and whose last
 * beat is fresh; dead or silent waiters are skipped so they never block the ones behind them.
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
    if (rec.op === "join" && !joined.has(rec.id)) joined.set(rec.id, { id: rec.id, pid: rec.pid, agentId: rec.agentId ?? null, at: rec.at, beat: rec.at });
    else if (rec.op === "beat" && joined.has(rec.id)) joined.get(rec.id).beat = rec.at;
    else if (rec.op === "done") joined.delete(rec.id);
  }
  const live = [...joined.values()].filter((e) => alive(e.pid) && now - (Number(e.beat) || 0) < beatStaleMs);
  return { known: new Set(joined.keys()), live };
}

/**
 * Wait FIFO for the slot (`npm test -- --queue`). Joins the queue, and only the head of the live line tries the lock,
 * so arrivals are served in order. The lock alone keeps two runs apart; the queue only decides who tries next.
 * `onWait({position, waiting, holder})` fires when the position or holder changes. `onJoin({id, leave})` hands a signal
 * handler the way out of the line before the slot is won. Resolves with the slot.
 */
export async function waitForSlot(
  paths,
  {
    pid = process.pid,
    agentId = callerAgentId(),
    alive = pidAlive,
    staleMs = SUITE_STALE_MS,
    pollMs = QUEUE_POLL_MS,
    beatMs = QUEUE_BEAT_MS,
    beatStaleMs = QUEUE_BEAT_STALE_MS,
    full = false,
    files = [],
    onWait,
    onJoin,
  } = {},
) {
  const id = `${pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const join = () => appendQueue(paths, { op: "join", id, pid, agentId, at: Date.now() });
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    try {
      appendQueue(paths, { op: "done", id });
    } catch {}
  };
  join();
  onJoin?.({ id, leave });
  let lastBeat = Date.now();
  const beat = () => {
    appendQueue(paths, { op: "beat", id, at: Date.now() });
    lastBeat = Date.now();
  };
  let shown = "";
  try {
    for (;;) {
      const { known, live } = readQueue(paths, { alive, beatStaleMs });
      const idx = live.findIndex((e) => e.id === id);
      if (!known.has(id)) {
        join(); // our line was compacted away (a claimer emptied the file just as we joined): join again at the tail
        lastBeat = Date.now();
      } else if (idx < 0) {
        beat(); // we went silent past beatStaleMs (a suspended machine) and were skipped: a fresh beat restores our place
      }
      if (idx < 0) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (idx === 0) {
        const slot = tryAcquireSlot(paths, { pid, agentId, alive, staleMs, full, files });
        if (slot) {
          leave();
          if (live.length === 1) rmSync(paths.queue, { force: true }); // nobody behind us: compact (a racing joiner re-joins)
          return slot;
        }
      }
      const holder = readLock(paths.lock);
      const key = `${idx + 1}|${holder?.pid}|${holder?.startedAt}`;
      if (key !== shown) {
        shown = key;
        onWait?.({ position: idx + 1, waiting: live.length, holder });
      }
      if (Date.now() - lastBeat >= beatMs) beat();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch (e) {
    leave();
    throw e;
  }
}
