// Parallel cold fold (unit-cold-fold-reg). A boot whose fold index has no entry for a log (first boot, a FOLD_VERSION bump that
// dropped the whole index, a lost index file) folds that log from byte 0 in Runner.recoverQueued's single-threaded pass: ~13s
// for 5457 logs / 487MB offline, but 157.5s live on 11-18 (and 120.7s on 11-16, before any fold-code change): the cold pass is
// two opens, two full reads and a stat or three per log, and every one of those syscalls is what a busy box makes slow.
// Here the logs with no entry are folded by worker threads instead, each one exactly as Runner._fold folds a log from 0
// (LogStore.readFrom with the probes taken on its fd, foldEvent, saveFold), into the fold-index entry Runner._foldEntry would
// save for it. The boot pass then takes those entries like a saved index: seedFromEntry trusts one only while the log's size
// AND mtime still equal the stat the worker took BEFORE its read and that stat is not racy; a grown log resumes at the
// entry's offset behind the head/tail probes; anything else is folded from 0 by the boot pass, as before. So the fold state a
// boot ends with is the one a full fold computes (the warm-boot guarantee), whichever worker folded it, or none did.
import { availableParallelism } from 'node:os';
import { statSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { LogStore } from './log.mjs';
import { foldEvent, newFold, probeWith, saveFold } from './fold-index.mjs';

// Below this many logs without an entry, the boot pass folds them itself (a worker costs ~30-50ms to start).
export const COLD_FOLD_MIN = 64;
const MAX_WORKERS = 8;
const BATCH = 128; // entries per message back
const TIMEOUT_MS = 300_000; // a safety net only: workers still running are terminated, their logs folded by the boot pass

/** Worker count: VS_RUNNER_COLD_FOLD_WORKERS (0 = off), else cores - 1 (max 8), none on a box with fewer than 3 cores. */
export function coldFoldWorkersFromEnv(env = process.env) {
  const v = env.VS_RUNNER_COLD_FOLD_WORKERS;
  if (v !== undefined && v !== '') { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, 32) : 0; }
  const cores = availableParallelism();
  return cores >= 3 ? Math.min(MAX_WORKERS, cores - 1) : 0;
}

/**
 * The fold-index entry of `id`'s log folded from byte 0 now, or null (no created event, unreadable, nothing complete, or the
 * log grew past the stat during the read). Mirrors Runner._fold's from-0 path and Runner._foldEntry step for step: the stat
 * (statAt taken before it) precedes the read, the probes come from the read's own fd at the end it reached.
 */
export function coldEntry(store, id) {
  const statAt = Date.now();
  let s;
  try { s = statSync(store.file(id)); } catch { return null; }
  const st = newFold();
  let pin = null;
  const { events, end } = store.readFrom(id, 0, 0, Infinity, (pread, at) => { const p = probeWith(pread, at); pin = p ? { offset: at, ...p } : null; });
  for (const e of events) foldEvent(st, e);
  st.offset = end;
  if (!st.created || !(end > 0) || s.size < end || !pin || pin.offset !== end) return null;
  const ix = store.idx.get(id);
  return {
    size: s.size, mtimeMs: s.mtimeMs, statAt, offset: end, headLen: pin.headLen, head: pin.head, tail: pin.tail,
    ix: ix && ix.size === end ? { count: ix.count, offs: ix.offs } : null,
    state: saveFold(st),
  };
}

/**
 * Folds `ids` (logs in `dir`) on `workers` threads; resolves to a Map id -> entry for the ones folded (never rejects: a worker
 * that fails or times out just leaves its remaining logs out). Workers take the next id from a shared counter, so one big log
 * never holds up a fixed share.
 */
export function coldFoldEntries(dir, ids, { workers = coldFoldWorkersFromEnv(), timeoutMs = TIMEOUT_MS } = {}) {
  const out = new Map();
  const n = Math.min(workers, ids.length);
  if (!(n > 0)) return Promise.resolve(out);
  return new Promise((resolve) => {
    const next = new Int32Array(new SharedArrayBuffer(4));
    const ws = [];
    let left = n;
    const finish = () => { if (--left === 0) { clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => { for (const w of ws) w.terminate().catch(() => {}); }, timeoutMs);
    for (let k = 0; k < n; k++) {
      let done = false;
      const end = () => { if (!done) { done = true; finish(); } };
      let w;
      try { w = new Worker(new URL(import.meta.url), { workerData: { coldFold: true, dir, ids, next } }); } catch { end(); continue; }
      w.on('message', (m) => { if (Array.isArray(m)) for (const [id, e] of m) out.set(id, e); else if (m === 'done') end(); });
      w.on('error', () => {}); // 'exit' follows
      w.on('exit', end);
      ws.push(w);
    }
  });
}

if (!isMainThread && workerData?.coldFold) {
  const { dir, ids, next } = workerData;
  const store = new LogStore(dir);
  let batch = [];
  for (let i; (i = Atomics.add(next, 0, 1)) < ids.length;) {
    const id = ids[i];
    let e = null;
    try { e = coldEntry(store, id); } catch { e = null; }
    store.idx.delete(id); // the entry carries its line index; this thread keeps nothing per log
    if (e) batch.push([id, e]);
    if (batch.length >= BATCH) { parentPort.postMessage(batch); batch = []; }
  }
  if (batch.length) parentPort.postMessage(batch);
  parentPort.postMessage('done');
}
