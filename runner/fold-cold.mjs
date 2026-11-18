// Parallel cold fold (unit-cold-fold-reg). A boot whose fold index has no entry for a log (first boot, a FOLD_VERSION bump that
// dropped the whole index, a lost index file) folds that log from byte 0 in Runner.recoverQueued's single-threaded pass: ~13s
// for 5457 logs / 487MB offline, but 157.5s live on 11-18 (and 120.7s on 11-16, before any fold-code change): the cold pass is
// two opens, two full reads and a stat or three per log, and every one of those syscalls is what a busy box makes slow.
// Here the logs with no entry are folded by worker threads instead, each one exactly as Runner._fold folds a log from 0
// (LogStore.readFrom with the probes taken on its fd, foldEvent, saveFold), into the fold-index entry Runner._foldEntry would
// save for it, under Runner._refoldSettled's byte pinning (coldEntry: a racy log gets no entry; the read is capped at the
// stat's size and dropped unless a restat equals that stat). The boot pass then takes those entries like a saved index:
// seedFromEntry trusts one only while the log's size AND mtime still equal the stat the worker took BEFORE its read; a grown
// log resumes at the entry's offset behind the head/tail probes; anything else is folded from 0 by the boot pass, as before.
// So the fold state a boot ends with is the one a full fold computes (the warm-boot guarantee), whichever worker folded it,
// or none did.
import { availableParallelism } from 'node:os';
import { statSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { LogStore } from './log.mjs';
import { foldEvent, newFold, probeWith, racy, saveFold } from './fold-index.mjs';

// Below this many logs without an entry, the boot pass folds them itself (a worker costs ~30-50ms to start).
export const COLD_FOLD_MIN = 64;
const MAX_WORKERS = 8;
const BATCH = 128; // entries per message back
const SLICE_BYTES = 1 << 20; // a log is read and folded in slices of this size (Runner.refoldSliceBytes): bounded memory per worker
const TIMEOUT_MS = 300_000; // a safety net only: workers still running are terminated, their logs folded by the boot pass
let liveWorkers = 0; // cold-fold threads not yet exited (tests: none outlives the promise)
export const coldFoldLiveWorkers = () => liveWorkers;

/** Worker count: VS_RUNNER_COLD_FOLD_WORKERS (0 = off), else cores - 1 (max 8), none on a box with fewer than 3 cores. */
export function coldFoldWorkersFromEnv(env = process.env) {
  const v = env.VS_RUNNER_COLD_FOLD_WORKERS;
  if (v !== undefined && v !== '') { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, 32) : 0; }
  const cores = availableParallelism();
  return cores >= 3 ? Math.min(MAX_WORKERS, cores - 1) : 0;
}

/**
 * The fold-index entry of `id`'s log folded from byte 0 now, or null: the boot pass then folds the log itself. Same byte
 * pinning as Runner._refoldSettled (idea-316), since the main thread adopts the entry later and only through its stat:
 *   - the stat (statAt taken before it) comes first, and a log whose mtime is within RACY_MS of it is not folded at all (a
 *     racy entry could carry bytes rewritten in the stat's own mtime tick, and seedFromEntry resumes a grown entry without
 *     the racy test): null;
 *   - the read never goes past that stat's size (endCap), in sliceBytes slices folded one by one (never a whole log's events
 *     in memory), the line index rebuilt from the bytes;
 *   - a restat after the read must equal the first (size AND mtime), else the log was written meanwhile: null.
 * So an entry pins exactly the bytes its stat names, and seedFromEntry's size/mtime/probe checks decide the rest as for any
 * saved entry. Never throws.
 */
export function coldEntry(store, id, sliceBytes = SLICE_BYTES) {
  try {
    const file = store.file(id);
    const statAt = Date.now();
    const pre = statSync(file);
    if (!(pre.size > 0) || racy({ mtimeMs: pre.mtimeMs, statAt })) return null;
    store.idx.delete(id);
    const st = newFold();
    let pin = null;
    const pinAt = (pread, at) => { const p = probeWith(pread, at); pin = p ? { offset: at, ...p } : null; };
    for (;;) {
      const { events, end } = store.readFrom(id, st.offset, 0, Infinity, pinAt, sliceBytes, pre.size);
      for (const e of events) foldEvent(st, e);
      if (end <= st.offset) break; // nothing complete left before pre.size
      st.offset = end;
      if (end >= pre.size) break;
    }
    const post = statSync(file);
    if (post.size !== pre.size || post.mtimeMs !== pre.mtimeMs) return null;
    const end = st.offset;
    if (!st.created || !(end > 0) || !pin || pin.offset !== end) return null;
    const ix = store.idx.get(id);
    return {
      size: pre.size, mtimeMs: pre.mtimeMs, statAt, offset: end, headLen: pin.headLen, head: pin.head, tail: pin.tail,
      ix: ix && ix.size === end ? { count: ix.count, offs: ix.offs } : null,
      state: saveFold(st),
    };
  } catch { return null; }
}

/**
 * Folds `ids` (logs in `dir`) on `workers` threads; resolves to a Map id -> entry for the ones folded (never rejects: a worker
 * that fails or times out just leaves its remaining logs out). Workers take the next id from a shared counter, so one big log
 * never holds up a fixed share. Every worker is terminated before the promise resolves: on 'done', on the timeout, and on
 * `signal` (Runner.shutdown during a boot's prefold), which resolves with what arrived so far.
 */
export function coldFoldEntries(dir, ids, { workers = coldFoldWorkersFromEnv(), timeoutMs = TIMEOUT_MS, signal = null, batch = BATCH, sliceBytes = SLICE_BYTES } = {}) {
  const out = new Map();
  const n = Math.min(workers, ids.length);
  if (!(n > 0) || signal?.aborted) return Promise.resolve(out);
  return new Promise((resolve) => {
    const next = new Int32Array(new SharedArrayBuffer(4));
    const ws = new Set();
    let settled = false;
    const killAll = () => { for (const w of ws) w.terminate().catch(() => {}); };
    const finish = () => {
      if (settled || ws.size) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(out);
    };
    const onAbort = () => { killAll(); };
    const timer = setTimeout(killAll, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    for (let k = 0; k < n; k++) {
      let w;
      try { w = new Worker(new URL(import.meta.url), { workerData: { coldFold: true, dir, ids, next, batch, sliceBytes } }); } catch { continue; }
      ws.add(w);
      liveWorkers++;
      w.on('message', (m) => {
        if (Array.isArray(m)) { for (const [id, e] of m) out.set(id, e); } else if (m === 'done') w.terminate().catch(() => {}); // the thread is gone before we resolve
      });
      w.on('error', () => {}); // 'exit' follows
      w.on('exit', () => { ws.delete(w); liveWorkers--; finish(); });
    }
    finish(); // no worker could start
  });
}

if (!isMainThread && workerData?.coldFold) {
  const { dir, ids, next, batch: max, sliceBytes } = workerData;
  const store = new LogStore(dir);
  let batch = [];
  for (let i; (i = Atomics.add(next, 0, 1)) < ids.length;) {
    const id = ids[i];
    let e = null;
    try { e = coldEntry(store, id, sliceBytes); } catch { e = null; }
    store.idx.delete(id); // the entry carries its line index; this thread keeps nothing per log
    if (e) batch.push([id, e]);
    if (batch.length >= max) { parentPort.postMessage(batch); batch = []; }
  }
  if (batch.length) parentPort.postMessage(batch);
  parentPort.postMessage('done');
}
