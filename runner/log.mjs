// Append-only JSONL log per agent. One file per agent; nothing scans all files at startup.
// Each agent gets an in-memory index (bytes covered, event count, sparse ordinal->byte offset) so appends
// never re-read the file and `read(after)` seeks to the right offset instead of reading from byte 0.
import * as nodeFs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STEP = 64; // sparse index granularity: one offset per STEP events
const CHUNK = 1 << 20;

export const REDACTED = '[redacted]';

// Replaces every occurrence of each secret inside the strings of `value` (recursively: arrays, plain objects), leaving
// everything else as is. Secrets are per-agent tokens (runner/runner.mjs tokensById): a child's stderr, an unparseable
// stdout line, an error message or an echo in a reply must never land in the JSONL log or on the SSE tail.
export function redactSecrets(value, secrets, mask = REDACTED) {
  if (!secrets?.length) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(mask);
    return out;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => { const r = redactSecrets(v, secrets, mask); if (r !== v) changed = true; return r; });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let out = null;
    for (const [k, v] of Object.entries(value)) {
      const r = redactSecrets(v, secrets, mask);
      if (r !== v) { out ??= { ...value }; out[k] = r; }
    }
    return out ?? value;
  }
  return value;
}

export class LogStore {
  constructor(dir, fsImpl = nodeFs) {
    this.fs = fsImpl;
    this.dir = dir;
    this.idx = new Map(); // id -> { size, count, offs: [byte offset of event 0, STEP, 2*STEP...] }
    this.listeners = new Set(); // fn(id, ev) per append; see onAppend
    this.secrets = null; // () -> iterable of strings never to be written (see redactSecrets); set by the Runner
    this.fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!ID_RE.test(id)) throw new Error('bad agent id');
    return path.join(this.dir, `${id}.jsonl`);
  }

  exists(id) { return ID_RE.test(id) && this.fs.existsSync(this.file(id)); }

  // Directory listing only (names, no file reads).
  ids() {
    return this.fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
  }

  // Brings the index in line with the file: new bytes are scanned from the known offset; a file that shrank (or is unknown) is scanned once from 0.
  _index(id) {
    let size;
    try { size = this.fs.statSync(this.file(id)).size; } catch { this.idx.delete(id); return null; }
    let ix = this.idx.get(id);
    if (ix && size < ix.size) ix = null;
    if (!ix) { ix = { size: 0, count: 0, offs: [] }; this.idx.set(id, ix); }
    if (size > ix.size) this._scan(id, ix, size);
    return ix;
  }

  // Counts complete lines in [ix.size, end) without parsing them.
  _scan(id, ix, end) {
    const fd = this.fs.openSync(this.file(id), 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - ix.size));
      let pos = ix.size;
      let lineStart = pos;
      let lineLen = 0; // non-newline bytes seen on the current line
      while (pos < end) {
        const n = this.fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) {
          if (buf[i] === 10) {
            if (lineLen > 0) { if (ix.count % STEP === 0) ix.offs.push(lineStart); ix.count++; }
            lineStart = pos + i + 1;
            lineLen = 0;
            ix.size = lineStart;
          } else if (buf[i] !== 13) lineLen++; // a bare CR LF line is blank, like readFrom treats it
        }
        pos += n;
      }
    } finally { this.fs.closeSync(fd); }
  }

  // Number of events (the next seq).
  count(id) { return this._index(id)?.count ?? 0; }

  append(id, type, data = {}) {
    const ix = this.exists(id) ? this._index(id) : null;
    const seq = ix ? ix.count : 0;
    const secrets = this.secrets ? [...this.secrets()] : null; // before the line is built: file and listeners both see the clean event
    const ev = { seq, ts: Date.now(), type, ...(secrets?.length ? redactSecrets(data, secrets) : data) };
    const line = JSON.stringify(ev) + '\n';
    const before = ix ? ix.size : 0;
    this.fs.appendFileSync(this.file(id), line);
    const cur = ix ?? { size: 0, count: 0, offs: [] };
    if (cur.count % STEP === 0) cur.offs.push(before);
    cur.count++;
    cur.size = before + Buffer.byteLength(line);
    this.idx.set(id, cur);
    for (const fn of [...this.listeners]) { try { fn(id, ev); } catch { /* a bad listener must not break logging */ } }
    return ev;
  }

  // Live tail of every append (the SSE stream). Returns the unsubscribe.
  onAppend(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Events with seq >= after (callers tail by passing last seq + 1). Seeks via the index; never reads the whole file for a tail.
  read(id, after = 0, limit = Infinity) {
    const ix = this._index(id);
    if (!ix || after >= ix.count) return []; // seq <= event ordinal, so nothing at or past count can match
    const start = after > 0 ? ix.offs[Math.min(Math.floor(after / STEP), ix.offs.length - 1)] : 0;
    return this.readFrom(id, start, after, limit).events;
  }

  // Parses complete lines from byte `offset`; returns the events (seq >= after) and `end`, the byte offset after the last complete line read.
  readFrom(id, offset = 0, after = 0, limit = Infinity) {
    const out = [];
    const ix = this._index(id);
    if (!ix) return { events: out, end: offset };
    if (offset > ix.size) offset = 0;
    const end = ix.size;
    if (offset >= end) return { events: out, end: offset };
    const fd = this.fs.openSync(this.file(id), 'r');
    let pos = offset;
    let carry = Buffer.alloc(0);
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - offset));
      while (pos < end && out.length < limit) {
        const n = this.fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
        if (n <= 0) break;
        pos += n;
        let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let nl;
        let from = 0;
        while ((nl = data.indexOf(10, from)) !== -1 && out.length < limit) {
          const line = data.toString('utf8', from, nl);
          offset += nl - from + 1;
          from = nl + 1;
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.seq >= after) out.push(ev);
        }
        carry = Buffer.from(data.subarray(from));
      }
    } finally { this.fs.closeSync(fd); }
    return { events: out, end: offset };
  }
}
