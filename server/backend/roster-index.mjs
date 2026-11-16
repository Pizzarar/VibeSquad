// Byte-offset index of folded runner-log summaries: <runner home>/roster-index.json (unit-roster-no-refold, idea-261 / idea-148).
// Every `vs who` used to fold ALL agent logs from byte 0 (444MB live, 7-11s of CPU per call); with the runner down or booting
// (when the CLI cannot ask it) a roster read now folds only the bytes appended since the last read.
//
// One entry per agent: { size, mtimeMs, offset, head, tail, state }. `offset` is the end of the last complete line folded into
// `state` (the fold's serialised state, ROSTER_FOLD in runner-backend.mjs). Logs are append-only; an entry is trusted only while
// the file's first bytes (`head`) and the bytes just before `offset` (`tail`) are unchanged and it has not shrunk, else that log
// is folded from 0 again. An unchanged size + mtime skips the file entirely. The file is replaced atomically (tmp + rename), so
// a reader never sees half of it; concurrent writers are last-writer-wins, each with a complete, consistent snapshot.
// A large backlog (a cold index) is built by one process at a time (roster-index.lock): the others wait for it and then read
// its result, so N concurrent `vs who` calls during a runner boot no longer fold every log N times next to the runner's own fold.
import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "../../runner/lock.mjs";
import { isForbiddenRealHome } from "../test-guard.mjs";

export const INDEX_FILE = "roster-index.json";
export const INDEX_LOCK = "roster-index.lock";
const INDEX_VERSION = 1;
const PROBE = 64; // head / pre-offset bytes that pin an entry to the same file
const CHUNK = 4 << 20;
export const BUILD_LOCK_BYTES = 8 << 20; // a backlog above this is built under the lock
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 120_000;
const YIELD_LINES = 2000;
const YIELD_AGENTS = 64;

const b64 = (buf) => buf.toString("base64");

function readIndex(file, version) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j?.v === INDEX_VERSION && j.fold === version && j.entries && typeof j.entries === "object") return new Map(Object.entries(j.entries));
  } catch { /* missing, torn by an older writer, or another version: start over */ }
  return new Map();
}

/** Atomic replace: write a private tmp file, then rename it over the index (retried: win32 refuses while a reader has it open). */
export function writeIndexAtomic(file, data, { sleep = sleepSync } = {}) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return true; } catch (e) {
        if (i >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
        sleep(10 * (i + 1));
      }
    }
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return false; // the index is only a cache: the answer stands without it
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/** A live, fresh holder owns the lock (a dead pid or an old lock is stale: the next builder takes it over). */
function lockBusy(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return pidAlive(j.pid) && Date.now() - (j.at ?? 0) < LOCK_STALE_MS;
  } catch (e) {
    return e?.code !== "ENOENT"; // torn mid-write by its holder: busy; gone: free
  }
}
function tryLock(file) {
  const take = () => { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" }); return true; };
  try { return take(); } catch (e) {
    if (e?.code !== "EEXIST") return true; // cannot lock at all (read-only dir): build without it
  }
  if (lockBusy(file)) return false;
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  try { return take(); } catch { return false; }
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
function* foldOne(file, st, entry, fold) {
  const size = st.size;
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let state = null;
    let offset = 0;
    if (entry && size >= entry.offset && entry.size !== undefined) {
      const head = preadExact(fd, 0, Math.min(PROBE, entry.offset));
      const tailLen = Math.min(PROBE, entry.offset);
      const tail = preadExact(fd, entry.offset - tailLen, tailLen);
      if (head && tail && b64(head) === entry.head && b64(tail) === entry.tail) {
        try { state = fold.load(entry.state); offset = entry.offset; } catch { state = null; }
      }
    }
    if (!state) { state = fold.init(); offset = 0; }
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
    const head = offset ? preadExact(fd, 0, Math.min(PROBE, offset)) : Buffer.alloc(0);
    const tail = offset ? preadExact(fd, offset - tailLen, tailLen) : Buffer.alloc(0);
    return { entry: { size, mtimeMs: st.mtimeMs, offset, head: b64(head ?? Buffer.alloc(0)), tail: b64(tail ?? Buffer.alloc(0)), state: saved }, result };
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
  let index;
  let stats;
  let locked = false;
  // A test that forgot its temp home never writes the index (or its lock) into the real ~/.vibesquad/runner: it folds in memory.
  const persist = !isForbiddenRealHome(home);
  for (;;) {
    index = readIndex(file, version);
    stats = new Map();
    let pending = 0;
    for (const id of ids) {
      let st;
      try { st = fs.statSync(path.join(dir, `${id}.jsonl`)); } catch { continue; }
      stats.set(id, st);
      const e = index.get(id);
      if (!(e && e.size === st.size && e.mtimeMs === st.mtimeMs)) pending += Math.max(0, st.size - (e && st.size >= e.offset ? e.offset : 0));
    }
    if (!persist || pending <= BUILD_LOCK_BYTES || Date.now() >= deadline) break;
    if (tryLock(lockFile)) { locked = true; break; }
    // Another process is building: wait for it to finish, then re-read its index (most of the backlog is gone).
    while (lockBusy(lockFile) && Date.now() < deadline) yield { sleep: 100 };
  }
  try {
    const out = [];
    const next = {};
    let changed = index.size !== stats.size;
    let n = 0;
    for (const id of ids) {
      const st = stats.get(id);
      if (!st) continue;
      const e = index.get(id);
      let entry = e;
      let state;
      if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && e.offset === st.size) {
        try { state = fold.load(e.state); } catch { state = null; }
      }
      if (!state) {
        const r = yield* foldOne(path.join(dir, `${id}.jsonl`), st, e, fold);
        if (!r) { changed = true; continue; }
        ({ entry, result: state } = r);
        changed = true;
      }
      next[id] = entry;
      out.push({ id, state });
      if (++n % YIELD_AGENTS === 0) yield "agents";
    }
    if (changed && persist) writeIndexAtomic(file, JSON.stringify({ v: INDEX_VERSION, fold: version, entries: next }));
    return out;
  } finally {
    if (locked) try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  }
}

/** Fold states of `ids` (sync): only bytes appended since the index was written are parsed. */
export function indexedFoldSync(home, ids, fold) {
  const g = scan(home, ids, fold);
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value;
    if (r.value?.sleep) sleepSync(r.value.sleep);
  }
}

/** Same as indexedFoldSync, but yields to the event loop (every sliceMs of work, and while it waits on another builder). */
export async function indexedFold(home, ids, fold, { sliceMs = 8 } = {}) {
  const g = scan(home, ids, fold);
  let t0 = performance.now();
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value;
    if (r.value?.sleep) { await new Promise((res) => setTimeout(res, r.value.sleep)); t0 = performance.now(); }
    else if (r.value === "agents" || performance.now() - t0 >= sliceMs) { await new Promise((res) => setImmediate(res)); t0 = performance.now(); }
  }
}
