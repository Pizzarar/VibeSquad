// Byte-offset index of folded runner-log summaries: <runner home>/roster-index.json (unit-roster-no-refold, idea-261 / idea-148).
// Every `vs who` used to fold ALL agent logs from byte 0 (444MB live, 7-11s of CPU per call); with the runner down or booting
// (when the CLI cannot ask it) a roster read now folds only the bytes appended since the last read.
//
// One entry per agent: { size, mtimeMs, statAt, offset, firstEnd, headLen, head, tail, state }. `offset` is the end of the last
// complete line folded into `state` (the fold's serialised state, ROSTER_FOLD in runner-backend.mjs); `statAt` is when
// size/mtimeMs were read. Logs are append-only, so an entry is resumed at `offset` only when (Tier A review R2, H1):
//   - the log GREW past the entry's size (an append), or kept the same size AND mtime and the entry is not racy (below). A
//     same-size log with another mtime, or a shrunk one, is folded from 0 again: a same-size rewrite reads 0 new bytes, so no
//     probe can be trusted to catch it;
//   - and `head` (sha256 of bytes 0..headLen: the whole first, `created` line and at least HEAD_MIN bytes) and `tail` (the PROBE
//     bytes just before `offset`) still match, so a rewrite of created.meta or of the last folded lines refolds.
// Racy entries (git's "racily clean" rule): an mtime within RACY_MS of the entry's statAt cannot prove the file was not rewritten
// again in the same timestamp tick (same size, same mtime), so such an entry is folded from 0 instead of trusted. That is cheap:
// the index is read only while the runner is down or booting, when logs are quiet, and an entry stops being racy once a later
// scan records it. Not detected, by design: a same-size rewrite whose mtime is then set back (utimes) outside the racy window,
// and an append that also rewrites lines strictly between the head and the tail probe; runner logs see neither.
// The file is replaced atomically (tmp + rename), so a reader never sees half of it; concurrent writers are last-writer-wins,
// each with a complete, consistent snapshot. It is one JSON value with one entry per line (a single-line index from 2ad1fbde is
// dropped and refolded once), so it is parsed and written entry by entry and the server's scan yields between entries.
// Event loop (server): the scan is a generator over small units (one stat, one log open + probes, <= YIELD_LINES lines, one index
// entry) that yields "tick" after each; whole-file I/O (index read, tmp write, rename, rm) and every sleep are yielded as effects
// that the CLI driver runs with fs.*Sync / Atomics.wait and the server driver with fs.promises / setTimeout. No unit holds the
// loop for more than a few ms (a 2000-stat loop and 64-log fold blocks did: 260-380ms, 1.1s+ under suite load).
// A large backlog (a cold index) is built by one process at a time (roster-index.lock, runner/lock.mjs primitives): the others
// wait for it and then read its result, so N concurrent `vs who` calls during a runner boot no longer fold every log N times next
// to the runner's own fold.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireStartLock, pidAlive, readLock } from "../../runner/lock.mjs";
import { isForbiddenRealHome } from "../test-guard.mjs";

export const INDEX_FILE = "roster-index.json";
export const INDEX_LOCK = "roster-index.lock";
const INDEX_VERSION = 2; // v2: statAt + hashed head through the created line + 512-byte tail (v1 entries are dropped)
const PROBE = 512; // bytes just before `offset` that pin an entry to the same file
const HEAD_MIN = 4096; // the head hash covers at least this much, or the whole first line if longer ...
const HEAD_MAX = 1 << 20; // ... but never more than 1MB per check
const RACY_MS = 3000; // an mtime this close to the stat that recorded it proves nothing (coarse FS clocks tick in 2s)
const LOCK_GRACE_MS = 1000; // an empty / torn lock younger than this is mid-write (acquireStartLock's own grace)
const CHUNK = 4 << 20;
export const BUILD_LOCK_BYTES = 8 << 20; // a backlog above this is built under the lock
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 120_000;
const YIELD_LINES = 256;
const YIELD_AGENTS = 64;

const b64 = (buf) => buf.toString("base64");

const TRANSIENT = ["EPERM", "EACCES", "EBUSY"]; // win32: the file is mid-rename by another writer

/** One whole-file I/O effect: the sync driver runs fs[`${op}Sync`](...args), the async one fs.promises[op](...args). */
function* io(op, ...args) {
  return yield { io: op, args };
}

/** The index entries, or an empty map. A transient win32 read error is retried, not taken as "no index" (review R2, M1). */
function* readIndex(file, version) {
  let text;
  for (let i = 0; ; i++) {
    try { text = yield* io("readFile", file, "utf8"); break; } catch (e) {
      if (i >= 5 || !TRANSIENT.includes(e?.code)) return new Map(); // missing, or still locked: start over
      yield { sleep: 10 * (i + 1) };
    }
  }
  return yield* parseIndex(text, version);
}

/** Layout: a header line `{"v":2,"fold":"…","entries":{`, one `"id":{…},` line per entry, then `}}`. Still one JSON value. */
function* serializeIndex(version, entries) {
  const ids = Object.keys(entries);
  const out = [`${JSON.stringify({ v: INDEX_VERSION, fold: version }).slice(0, -1)},"entries":{`];
  for (let i = 0; i < ids.length; i++) {
    out.push(`${JSON.stringify(ids[i])}:${JSON.stringify(entries[ids[i]])}${i < ids.length - 1 ? "," : ""}`);
    yield "tick";
  }
  out.push("}}");
  return out.join("\n");
}

/** Entry by entry (a tick after each); any malformed line (torn by an older writer, another version) drops the whole index. */
function* parseIndex(text, version) {
  const none = new Map();
  const lines = text.split("\n");
  let head;
  try { head = JSON.parse(`${lines[0]}}}`); } catch { return none; }
  if (head?.v !== INDEX_VERSION || head.fold !== version || !head.entries || lines.length < 2 || lines[lines.length - 1] !== "}}") return none;
  const map = new Map();
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const last = i === lines.length - 2;
    if (line.endsWith(",") === last) return none; // every entry but the last ends with a comma
    let kv;
    try { kv = Object.entries(JSON.parse(`{${last ? line : line.slice(0, -1)}}`)); } catch { return none; }
    if (kv.length !== 1 || !kv[0][1] || typeof kv[0][1] !== "object") return none;
    map.set(kv[0][0], kv[0][1]);
    yield "tick";
  }
  return map;
}

/** Atomic replace: write a private tmp file, then rename it over the index (retried: win32 refuses while a reader has it open). */
function* writeIndex(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    yield* io("writeFile", tmp, data);
    for (let i = 0; ; i++) {
      try { yield* io("rename", tmp, file); return true; } catch (e) {
        if (i >= 5 || !TRANSIENT.includes(e?.code)) throw e;
        yield { sleep: 10 * (i + 1) };
      }
    }
  } catch {
    try { yield* io("rm", tmp, { force: true }); } catch { /* ignore */ }
    return false; // the index is only a cache: the answer stands without it
  }
}

/** writeIndex, sync (CLI, tests). */
export function writeIndexAtomic(file, data, { sleep = sleepSync } = {}) {
  return runSync(writeIndex(file, data), { sleep });
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/**
 * The build lock is runner/lock.mjs's start lock: O_EXCL create retried through Windows delete-pending EPERM/EACCES (an existing
 * lock is never taken for "cannot lock"), a stale holder removed only under the .steal guard and only if it still is the holder
 * judged stale. Busy = a live holder younger than LOCK_STALE_MS, or an empty / torn lock younger than LOCK_GRACE_MS (its holder
 * is between create and write). A dead pid, an old lock, or an empty / corrupt one past the grace is stale: the next builder
 * takes it over (review R2, H2).
 */
function lockBusy(file) {
  let age;
  try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { return false; } // gone (or going: delete-pending)
  const info = readLock(file);
  if (!info) return age < LOCK_GRACE_MS;
  return pidAlive(info.pid) && age < LOCK_STALE_MS;
}
/** "owned" (we created it, tagged `token`), "busy" (another builder holds it) or "none" (cannot lock at all: build without it). */
function tryLock(file, token) {
  try { return acquireStartLock(file, { staleMs: LOCK_STALE_MS, body: { token } }) ? "owned" : "busy"; } catch {
    return "none"; // read-only dir, or a create that kept failing: never touch a lock we did not create
  }
}
/** Remove the lock only while it is still the one we created (a builder judged stale may have lost it to a stealer). */
function unlock(file, token) {
  try { if (readLock(file)?.token === token) fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

const sha = (buf) => createHash("sha256").update(buf).digest("base64");
/** An entry whose mtime was within RACY_MS of the stat that recorded it (see the header). */
const racy = (e) => !(typeof e.statAt === "number" && e.mtimeMs < e.statAt - RACY_MS);
/** Where a fold of (entry, stat) may resume if its probes match: e.offset, or 0 for a full fold (see the header). */
function resumeAt(e, st) {
  if (!e || !(e.offset > 0) || typeof e.size !== "number" || e.size < e.offset) return 0;
  if (st.size > e.size) return e.offset;
  if (st.size === e.size && st.mtimeMs === e.mtimeMs && !racy(e)) return e.offset;
  return 0;
}

function preadExact(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let n = 0;
  while (n < len) {
    const r = fs.readSync(fd, buf, n, len - n, pos + n);
    if (r <= 0) break;
    n += r;
  }
  return n === len ? buf : null;
}

/**
 * The fold of one log from (entry, stat): yields "tick" every YIELD_LINES lines. Returns { entry, result } where result is the
 * state to finish (it includes a trailing line without its newline, as a full read of the file would) and entry the new index entry.
 */
function* foldOne(file, st, statAt, entry, fold) {
  const size = st.size;
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let state = null;
    let offset = 0;
    let firstEnd = 0; // end of the first complete line (the created event): the head hash covers it
    const resume = resumeAt(entry, st);
    if (resume > 0 && entry.headLen > 0 && entry.headLen <= resume) {
      const head = preadExact(fd, 0, entry.headLen);
      const tailLen = Math.min(PROBE, resume);
      const tail = preadExact(fd, resume - tailLen, tailLen);
      if (head && tail && sha(head) === entry.head && b64(tail) === entry.tail) {
        try { state = fold.load(entry.state); offset = resume; firstEnd = entry.firstEnd; } catch { state = null; }
      }
    }
    if (!state) { state = fold.init(); offset = 0; firstEnd = 0; }
    yield "tick"; // open + head/tail probes
    let pos = offset;
    let carry = null;
    let lines = 0;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size - offset)));
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      let nl;
      while ((nl = data.indexOf(10, from)) !== -1) {
        fold.feed(state, data.toString("utf8", from, nl));
        offset += nl - from + 1;
        if (!firstEnd) firstEnd = offset;
        from = nl + 1;
        if (++lines % YIELD_LINES === 0) yield "tick";
      }
      carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
    }
    // A last line without its newline (mid-append, or a log not written by the runner): folded into the answer like a full read
    // does, but not into the saved state, which resumes at the end of the last complete line.
    let result = state;
    const saved = fold.save(state);
    if (carry?.length) { result = fold.load(structuredClone(saved)); fold.feed(result, carry.toString("utf8")); }
    const tailLen = Math.min(PROBE, offset);
    const headLen = Math.min(offset, HEAD_MAX, Math.max(firstEnd, HEAD_MIN));
    const head = headLen ? preadExact(fd, 0, headLen) : null;
    const tail = tailLen ? preadExact(fd, offset - tailLen, tailLen) : null;
    const pinned = !!(head && tail); // no probes (offset 0, or shrunk under us): headLen 0, never resumed
    return {
      entry: { size, mtimeMs: st.mtimeMs, statAt, offset, firstEnd, headLen: pinned ? headLen : 0, head: pinned ? sha(head) : "", tail: pinned ? b64(tail) : "", state: saved },
      result,
    };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Generator core shared by the sync (CLI) and async (server) drivers. Yields "tick" (every YIELD_LINES lines: the async driver
 * yields to the loop if its slice is used up), "agents" (every YIELD_AGENTS agents: it always yields, so even a warm scan of a
 * big roster interleaves with other loop work) or { sleep: ms } (waiting on another builder's lock). Returns [{ id, state }] in `ids` order, logs without a readable file left out.
 */
function* scan(home, ids, fold) {
  const file = path.join(home, INDEX_FILE);
  const lockFile = path.join(home, INDEX_LOCK);
  const version = fold.version;
  const dir = path.join(home, "agents");
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID(); // names our lock: unlock() never removes one we did not create
  let index;
  let stats;
  let locked = false;
  // A test that forgot its temp home never writes the index (or its lock) into the real ~/.vibesquad/runner: it folds in memory.
  const persist = !isForbiddenRealHome(home);
  for (;;) {
    index = yield* readIndex(file, version);
    stats = new Map();
    let pending = 0;
    for (const id of ids) {
      let st;
      const at = Date.now(); // taken before the stat, so an mtime written meanwhile still counts as racy
      try { st = fs.statSync(path.join(dir, `${id}.jsonl`)); } catch { continue; }
      stats.set(id, { st, at });
      pending += Math.max(0, st.size - resumeAt(index.get(id), st));
      yield "tick";
    }
    if (!persist || pending <= BUILD_LOCK_BYTES || Date.now() >= deadline) break;
    const got = tryLock(lockFile, token);
    if (got === "none") break;
    if (got === "owned") { locked = true; break; }
    // Another process is building: wait for it to finish, then re-read its index (most of the backlog is gone). Pause at least
    // once even if the lock already reads free: a steal can lose to another stealer, and this must not spin.
    do yield { sleep: 100 }; while (lockBusy(lockFile) && Date.now() < deadline);
  }
  try {
    const out = [];
    const next = {};
    let changed = index.size !== stats.size;
    let n = 0;
    for (const id of ids) {
      const s = stats.get(id);
      if (!s) continue;
      const { st, at } = s;
      const e = index.get(id);
      let entry = e;
      let state;
      // Unchanged and fully folded (resumeAt rules out a racy entry): nothing to read.
      if (e && e.offset === st.size && resumeAt(e, st) === st.size) {
        try { state = fold.load(e.state); } catch { state = null; }
      }
      if (!state) {
        const r = yield* foldOne(path.join(dir, `${id}.jsonl`), st, at, e, fold);
        if (!r) { changed = true; continue; }
        ({ entry, result: state } = r);
        changed = true;
      }
      next[id] = entry;
      out.push({ id, state });
      if (++n % YIELD_AGENTS === 0) yield "agents";
      else yield "tick";
    }
    if (changed && persist) yield* writeIndex(file, yield* serializeIndex(version, next));
    return out;
  } finally {
    if (locked) unlock(lockFile, token);
  }
}

/** Runs a scan generator to completion with sync I/O and sleeps (the CLI: nothing else shares its loop). */
function runSync(g, { sleep = sleepSync } = {}) {
  for (let r = g.next(); ; ) {
    if (r.done) return r.value;
    const v = r.value;
    if (v?.io) {
      let out;
      try { out = fs[`${v.io}Sync`](...v.args); } catch (e) { r = g.throw(e); continue; }
      r = g.next(out);
      continue;
    }
    if (v?.sleep) sleep(v.sleep);
    r = g.next();
  }
}

/** Fold states of `ids` (sync): only bytes appended since the index was written are parsed. */
export function indexedFoldSync(home, ids, fold) {
  return runSync(scan(home, ids, fold));
}

/**
 * Same as indexedFoldSync, but never holds the event loop: index I/O through fs.promises, sleeps through timers, and a yield to
 * the loop whenever sliceMs of work has run (and always every YIELD_AGENTS agents).
 */
export async function indexedFold(home, ids, fold, { sliceMs = 8 } = {}) {
  const g = scan(home, ids, fold);
  let t0 = performance.now();
  for (let r = g.next(); ; ) {
    if (r.done) return r.value;
    const v = r.value;
    if (v?.io) {
      let out;
      try { out = await fs.promises[v.io](...v.args); } catch (e) { t0 = performance.now(); r = g.throw(e); continue; }
      t0 = performance.now();
      r = g.next(out);
      continue;
    }
    if (v?.sleep) { await new Promise((res) => setTimeout(res, v.sleep)); t0 = performance.now(); }
    else if (v === "agents" || performance.now() - t0 >= sliceMs) { await new Promise((res) => setImmediate(res)); t0 = performance.now(); }
    r = g.next();
  }
}
