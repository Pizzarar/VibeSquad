// Append-only JSONL log per agent. One file per agent; nothing scans all files at startup.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class LogStore {
  constructor(dir) {
    this.dir = dir;
    this.seqs = new Map(); // id -> next seq; filled lazily, per agent
    mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!ID_RE.test(id)) throw new Error('bad agent id');
    return path.join(this.dir, `${id}.jsonl`);
  }

  exists(id) { return ID_RE.test(id) && existsSync(this.file(id)); }

  // Directory listing only (names, no file reads).
  ids() {
    return readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
  }

  append(id, type, data = {}) {
    let seq = this.seqs.get(id);
    if (seq === undefined) seq = this.exists(id) ? this.read(id).length : 0; // lazy index for this agent only
    const ev = { seq, ts: Date.now(), type, ...data };
    appendFileSync(this.file(id), JSON.stringify(ev) + '\n');
    this.seqs.set(id, seq + 1);
    return ev;
  }

  // Events with seq >= after (callers tail by passing last seq + 1).
  read(id, after = 0, limit = Infinity) {
    if (!this.exists(id)) return [];
    const out = [];
    for (const line of readFileSync(this.file(id), 'utf8').split('\n')) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.seq >= after) {
        out.push(ev);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
