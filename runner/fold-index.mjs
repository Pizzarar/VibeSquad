// Runner boot fold, persisted: <runner home>/fold-index.json (unit-runner-fold-incr, idea-261). The boot pass (recoverQueued)
// used to fold EVERY agent log from byte 0 (5035 logs / ~450MB live on 11-16: 12.5s of a 12.6s boot, growing with the logs).
// The runner now saves each log's fold state with the byte offset it covers, and the next boot resumes from it: an unchanged
// log costs one stat and one JSON entry, a grown log folds only its new bytes. Same approach as server/backend/roster-index.mjs
// (9563c6e0, Tier A x3), adapted to the runner's own fold (Runner._fold) and its sync boot:
//   - an entry is { size, mtimeMs, statAt, offset, headLen, head, tail, ix, state }: `state` is the fold of bytes [0, offset)
//     (saveFold), size/mtimeMs/statAt the stat taken BEFORE that fold read the log, `ix` the LogStore line index at `offset`
//     (event count + sparse offsets, so appends and timeline reads after boot never rescan the file to count lines);
//   - trusted without opening the log only when size AND mtime are unchanged and the entry is not racy (mtime within RACY_MS of
//     statAt: a same-size rewrite in the same clock tick is invisible to a stat); resumed at `offset` only when the log grew and
//     `head` (sha256 of the first line, at least HEAD_MIN bytes) and `tail` (the PROBE bytes before `offset`) still match;
//     anything else (shrunk, same-size rewrite, racy, probes differ, unreadable entry) is folded from byte 0;
//   - the header pins FOLD_VERSION, a hash of the fold code (foldEvent / saveFold / loadFold and runner/open-tools.mjs), so any
//     change to what the fold computes drops the whole index once; so does a malformed file (any bad line: the index is a cache);
//   - written atomically (private tmp + rename, retried through win32 EPERM/EBUSY), one entry per line, by one writer at a time
//     (fold-index.lock, runner/lock.mjs start lock). A writer that finds the lock held SKIPS the save (it is only a cache): boot
//     never waits on another process's lock, and reading needs no lock (a rename replaces the whole file).
// Not detected, as in roster-index: a same-size rewrite whose mtime is set back outside the racy window, and an append that also
// rewrites bytes strictly between the head and the tail probe. Runner logs are append-only and see neither.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireStartLock, readLock } from './lock.mjs';
import { applyToolEvent } from './open-tools.mjs';

export const FOLD_INDEX_FILE = 'fold-index.json';
const INDEX_VERSION = 1;
const PROBE = 512; // bytes just before `offset` that pin an entry to the same file
const HEAD_MIN = 4096; // the head hash covers at least this much, or the whole first line if longer ...
const HEAD_MAX = 1 << 20; // ... but never more than 1MB
export const RACY_MS = 3000; // an mtime this close to the stat that recorded it proves nothing (coarse FS clocks tick in 2s)
const LOCK_STALE_MS = 60_000;
const TRANSIENT = ['EPERM', 'EACCES', 'EBUSY']; // win32: the file is mid-rename by another writer

// ---- the fold (one state per agent log; Runner._fold applies foldEvent to every event in log order) ----

/** Empty fold state. `offset` is the end of the last complete line folded. */
export function newFold() {
  return { created: null, lastSeq: undefined, lastTs: undefined, status: 'unknown', usage: null, perms: new Map(), tools: new Map(), meta: null, archivedAt: null, exit: null, offset: 0 };
}

/**
 * Applies one log event to `st`. Keeps only what the runner reads: the created event without its systemPrompt (role prompts are
 * read from the log by the resume paths, never from the fold) and the last event's seq + ts, not the last event itself.
 */
export function foldEvent(st, e) {
  if (!st.created) {
    if (e.systemPrompt !== undefined) { const { systemPrompt, ...c } = e; st.created = c; } else st.created = e;
    st.meta = { ...e.meta };
  }
  st.lastSeq = e.seq;
  st.lastTs = e.ts;
  applyToolEvent(st.tools, e); // R4-1: oldest open tool call (byte-offset fold: each event is applied exactly once)
  if (e.type === 'status') { st.status = e.status; st.ahead = e.status === 'queued' && Number.isInteger(e.ahead) ? e.ahead : undefined; }
  else if (e.type === 'usage') st.usage = { contextTokens: e.contextTokens, contextMax: e.contextMax, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
  else if (e.type === 'permission') { if (e.phase === 'request') st.perms.set(e.id, { id: e.id, toolName: e.toolName }); else st.perms.delete(e.id); }
  else if (e.type === 'meta') Object.assign(st.meta, e.patch, e.patch?.labels ? { labels: { ...st.meta.labels, ...e.patch.labels } } : {});
  else if (e.type === 'session') {
    if (e.sessionId) st.sessionId = e.sessionId;
    if (Array.isArray(e.modes)) st.offered = { modes: e.modes, models: Array.isArray(e.models) ? e.models : [] };
  }
  else if (e.type === 'archive') st.archivedAt = e.ts;
  else if (e.type === 'unarchive') st.archivedAt = null;
  else if (e.type === 'exit' && !st.exit) st.exit = e;
}

/** The fold state as plain JSON (Maps as [key, value] entries, in insertion order). Bookkeeping (stamp, stat, rec) is not state. */
export function saveFold(st) {
  return {
    created: st.created, lastSeq: st.lastSeq, lastTs: st.lastTs, status: st.status, ahead: st.ahead, usage: st.usage,
    perms: [...st.perms], tools: [...st.tools], meta: st.meta, sessionId: st.sessionId, offered: st.offered,
    archivedAt: st.archivedAt, exit: st.exit, offset: st.offset,
  };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pairs = (v) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isObj(p[1]));

/** saveFold's inverse. Throws on anything saveFold cannot have written (the entry is then folded from 0). */
export function loadFold(o) {
  if (!isObj(o) || !isObj(o.created) || !isObj(o.meta) || typeof o.status !== 'string' || !Number.isSafeInteger(o.offset) || o.offset <= 0) throw new Error('bad fold state');
  if (!pairs(o.perms) || !pairs(o.tools)) throw new Error('bad fold maps');
  const st = newFold();
  st.created = o.created;
  st.lastSeq = o.lastSeq;
  st.lastTs = o.lastTs;
  st.status = o.status;
  if (o.ahead !== undefined) st.ahead = o.ahead;
  st.usage = o.usage ?? null;
  st.perms = new Map(o.perms);
  st.tools = new Map(o.tools);
  st.meta = o.meta;
  if (o.sessionId !== undefined) st.sessionId = o.sessionId;
  if (o.offered !== undefined) st.offered = o.offered;
  st.archivedAt = o.archivedAt ?? null;
  st.exit = o.exit ?? null;
  st.offset = o.offset;
  return st;
}

/** Hash of everything that decides what a fold computes: a change to any of it drops every saved state once. */
export const FOLD_VERSION = (() => {
  const h = createHash('sha256').update(`v${INDEX_VERSION}\n${newFold}\n${foldEvent}\n${saveFold}\n${loadFold}\n`);
  try { h.update(fs.readFileSync(fileURLToPath(new URL('./open-tools.mjs', import.meta.url)))); } catch { h.update(String(Math.random())); } // unreadable: never trust an old index
  return h.digest('base64').slice(0, 24);
})();

// ---- entries ----

const sha = (buf) => createHash('sha256').update(buf).digest('base64');
const b64 = (buf) => buf.toString('base64');
/** An entry whose mtime was within RACY_MS of the stat that recorded it. */
const racy = (e) => !(typeof e.statAt === 'number' && e.mtimeMs < e.statAt - RACY_MS);

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
 * Where the fold of `file` (stat `st`) may start from entry `e`: { state, offset, ix, trusted } or null (fold from 0).
 * trusted: the log is unchanged since the entry's fold (nothing to read, not even the probes).
 */
export function seedFromEntry(file, e, st) {
  if (!isObj(e) || !Number.isSafeInteger(e.offset) || e.offset <= 0 || typeof e.size !== 'number' || e.size < e.offset || typeof e.mtimeMs !== 'number') return null;
  let trusted = false;
  if (st.size === e.size && st.mtimeMs === e.mtimeMs && !racy(e)) trusted = true;
  else if (!(st.size > e.size)) return null; // shrunk, same-size rewrite, or racy: from 0
  if (!trusted) {
    if (!(e.headLen > 0) || e.headLen > e.offset || typeof e.head !== 'string' || typeof e.tail !== 'string') return null;
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try {
      const head = preadExact(fd, 0, e.headLen);
      const tailLen = Math.min(PROBE, e.offset);
      const tail = preadExact(fd, e.offset - tailLen, tailLen);
      if (!head || !tail || sha(head) !== e.head || b64(tail) !== e.tail) return null;
    } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  let state;
  try { state = loadFold(e.state); } catch { return null; }
  if (state.offset !== e.offset) return null;
  const ix = isObj(e.ix) && Number.isSafeInteger(e.ix.count) && Array.isArray(e.ix.offs) && e.ix.offs.every(Number.isSafeInteger) && e.ix.offs.length === Math.ceil(e.ix.count / 64) ? e.ix : null;
  return { state, offset: e.offset, ix, trusted };
}

/** Head/tail probes of `file` for a fold ending at `offset`, or null (unreadable, or shorter than the fold: never resumed). */
export function probe(file, offset) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const first = preadExact(fd, 0, Math.min(offset, 64 * 1024));
    if (!first) return null;
    let firstEnd = first.indexOf(10) + 1;
    let head = first;
    if (!firstEnd && offset > first.length) { // a first line over 64KB (a long system prompt)
      head = preadExact(fd, 0, Math.min(offset, HEAD_MAX));
      if (!head) return null;
      firstEnd = head.indexOf(10) + 1 || head.length;
    }
    const headLen = Math.min(offset, HEAD_MAX, Math.max(firstEnd, HEAD_MIN));
    const h = headLen <= head.length ? head.subarray(0, headLen) : preadExact(fd, 0, headLen);
    const tailLen = Math.min(PROBE, offset);
    const tail = preadExact(fd, offset - tailLen, tailLen);
    if (!h || !tail) return null;
    return { headLen, head: sha(h), tail: b64(tail) };
  } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// ---- the file ----

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/** Entries by id, or an empty map (missing, unreadable, another version, any malformed byte). Transient win32 errors retried, bounded. */
export function readFoldIndex(file, { sleep = sleepSync } = {}) {
  let text;
  for (let i = 0; ; i++) {
    try { text = fs.readFileSync(file, 'utf8'); break; } catch (e) {
      if (i >= 4 || !TRANSIENT.includes(e?.code)) return new Map();
      sleep(10 * (i + 1));
    }
  }
  let o;
  try { o = JSON.parse(text); } catch { return new Map(); }
  if (!isObj(o) || o.v !== INDEX_VERSION || o.fold !== FOLD_VERSION || !isObj(o.entries)) return new Map();
  return new Map(Object.entries(o.entries));
}

/** Layout: a header line `{"v":1,"fold":"…","entries":{`, one `"id":{…},` line per entry, then `}}`. Still one JSON value. */
export function serializeFoldIndex(entries) {
  const out = [`${JSON.stringify({ v: INDEX_VERSION, fold: FOLD_VERSION }).slice(0, -1)},"entries":{`];
  const ids = [...entries.keys()];
  for (let i = 0; i < ids.length; i++) out.push(`${JSON.stringify(ids[i])}:${JSON.stringify(entries.get(ids[i]))}${i < ids.length - 1 ? ',' : ''}`);
  out.push('}}');
  return out.join('\n');
}

/**
 * Atomic replace under <file>.lock. Never waits for the lock: held by a live writer (or not creatable) means "skipped" (the
 * index is only a cache; that writer's snapshot is as valid as ours). Returns 'written' | 'busy' | 'failed'.
 */
export function writeFoldIndex(file, data, { sleep = sleepSync } = {}) {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  let got;
  try { got = acquireStartLock(lockFile, { staleMs: LOCK_STALE_MS, body: { token } }); } catch { got = false; }
  if (!got) return 'busy';
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return 'written'; } catch (e) {
        if (i >= 5 || !TRANSIENT.includes(e?.code)) throw e;
        sleep(10 * (i + 1));
      }
    }
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return 'failed';
  } finally {
    try { if (readLock(lockFile)?.token === token) fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  }
}
