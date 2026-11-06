// Agent supervisor: one child per agent, one JSONL log per agent, no pollers.
import { randomBytes } from 'node:crypto';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { createAcpAdapter } from './adapters/acp.mjs';
import { LogStore } from './log.mjs';

// squad/team/lane/role/ord/profile are plain meta fields, first-class on the agent record.
const META_FIELDS = ['squad', 'team', 'lane', 'role', 'ord', 'profile'];

export function defaultAdapters(opts = {}) {
  return { claude: createClaudeAdapter(opts), opencode: createAcpAdapter(opts) };
}

export class Runner {
  constructor({ dir, adapters = defaultAdapters() }) {
    this.store = new LogStore(dir);
    this.adapters = adapters;
    this.live = new Map(); // id -> { handle, status } for agents running in THIS process only
  }

  create({ provider, model, cwd, prompt, meta = {} }) {
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`unknown provider "${provider}"`);
    const id = randomBytes(6).toString('hex');
    const record = { provider, model: model ?? null, cwd, meta: pickMeta(meta) };
    this.store.append(id, 'created', record);
    const entry = { status: 'starting', handle: null };
    this.live.set(id, entry);
    const emit = (type, data) => {
      if (type === 'status') entry.status = data.status;
      this.store.append(id, type === 'status' ? 'status' : type, data);
    };
    try {
      entry.handle = adapter.start({
        model, cwd, meta, emit,
        onExit: (info) => {
          entry.status = 'exited';
          this.store.append(id, 'exit', info);
          this.live.delete(id);
        },
      });
    } catch (err) {
      this.live.delete(id);
      this.store.append(id, 'exit', { code: null, error: err.message });
      throw err;
    }
    if (prompt) this.send(id, prompt);
    return id;
  }

  send(id, text) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    this.store.append(id, 'input', { text });
    entry.handle.send(text);
  }

  cancel(id) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    this.store.append(id, 'cancel', {});
    entry.handle.cancel();
  }

  kill(id) { this.live.get(id)?.handle?.kill(); }

  // Reads only this agent's log (lazy: no other file is touched).
  status(id) {
    const events = this.store.read(id);
    if (!events.length) return null;
    const created = events[0];
    const last = events[events.length - 1];
    let status = 'unknown';
    for (const e of events) if (e.type === 'status') status = e.status;
    const exit = events.find((e) => e.type === 'exit');
    if (exit) status = 'exited';
    else if (!this.live.has(id)) status = 'lost'; // log says running but no child in this process
    return {
      id, provider: created.provider, model: created.model, cwd: created.cwd, meta: created.meta,
      status, lastSeq: last.seq, createdAt: created.ts, exit: exit ?? null,
    };
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }

  list() { return this.store.ids(); } // names only; use status(id) for details

  shutdown() { for (const id of [...this.live.keys()]) this.kill(id); }
}

function pickMeta(meta) {
  const out = {};
  for (const k of META_FIELDS) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}
