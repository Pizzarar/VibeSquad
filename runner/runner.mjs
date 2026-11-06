// Agent supervisor: one child per agent, one JSONL log per agent, no pollers.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { createAcpAdapter, acpProviderIds, PROVIDER_ALIASES } from './adapters/acp.mjs';
import { LogStore } from './log.mjs';

// squad/team/lane/role/ord/profile are plain meta fields, first-class on the agent record.
const META_FIELDS = ['squad', 'team', 'lane', 'role', 'ord', 'profile', 'title', 'permissionMode', 'acpMode', 'labels'];

// Values that reach a CLI as an argument must never look like a flag.
export function validateCreate({ model, cwd, meta = {} }) {
  for (const [name, v] of [['model', model], ['permissionMode', meta.permissionMode]]) {
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.startsWith('-'))) throw new Error(`invalid ${name}`);
  }
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is required');
  let st;
  try { st = statSync(cwd); } catch { throw new Error(`cwd does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
}

// Env a child gets: the runner's own env is stale for identity (it carries whichever lead started the runner),
// so every agent id/team/lane/role is overwritten from its own meta.
export function agentEnv(id, meta = {}, base = process.env) {
  const env = { ...base, VS_AGENT_ID: id, PASEO_AGENT_ID: id };
  for (const [k, v] of [['VS_TEAM', meta.team], ['VS_LANE', meta.lane], ['VS_ROLE', meta.role], ['VS_ORD', meta.ord], ['VS_PROFILE', meta.profile]]) {
    if (v !== undefined && v !== null && v !== '') env[k] = String(v);
    else delete env[k];
  }
  return env;
}

export function defaultAdapters(opts = {}) {
  const adapters = { claude: createClaudeAdapter(opts) };
  for (const provider of acpProviderIds()) adapters[provider] = createAcpAdapter({ ...opts, provider });
  for (const [alias, target] of Object.entries(PROVIDER_ALIASES)) adapters[alias] = adapters[target];
  return adapters;
}

export class Runner {
  constructor({ dir, adapters = defaultAdapters() }) {
    this.store = new LogStore(dir);
    this.adapters = adapters;
    this.live = new Map(); // id -> { handle, status } for agents running in THIS process only
  }

  create({ provider, model, cwd, prompt, systemPrompt, meta = {} }) {
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`unknown provider "${provider}"`);
    validateCreate({ model, cwd, meta });
    const id = `rn-${randomBytes(6).toString('hex')}`; // rn- prefix: the VS router tells runner ids from Paseo uuids without a lookup
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
        id, env: agentEnv(id, meta), model, cwd, meta, systemPrompt, emit,
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

  // opts.images: [{ data (base64), mimeType }]; opts.activeTurnBehavior: 'steer' (default, queue behind/into the turn)
  // or 'interrupt' (cancel the active turn first). The log keeps the image count, never the base64 payload.
  send(id, text, opts = {}) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    const images = (Array.isArray(opts.images) ? opts.images : []).filter((i) => i && typeof i.data === 'string' && typeof i.mimeType === 'string');
    if (opts.activeTurnBehavior === 'interrupt' && entry.status === 'running') this.cancel(id);
    this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}) });
    entry.handle.send(text, images.length ? { images } : undefined);
  }

  // Live tail of every log append: fn(id, event). Returns the unsubscribe.
  subscribe(fn) { return this.store.onAppend(fn); }

  cancel(id) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    this.store.append(id, 'cancel', {});
    entry.handle.cancel();
  }

  kill(id) { this.live.get(id)?.handle?.kill(); }

  // Meta changes (rename, labels) are events too, so the log stays the single source of truth.
  updateMeta(id, patch = {}) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    this.store.append(id, 'meta', { patch: pickMeta(patch) });
  }

  archive(id) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    this.kill(id);
    this.store.append(id, 'archive', {});
  }

  // Reads only this agent's log (lazy: no other file is touched).
  status(id) {
    const events = this.store.read(id);
    if (!events.length) return null;
    const created = events[0];
    const last = events[events.length - 1];
    let status = 'unknown';
    let usage = null;
    const perms = new Map();
    for (const e of events) {
      if (e.type === 'status') status = e.status;
      else if (e.type === 'usage') usage = { contextTokens: e.contextTokens, contextMax: e.contextMax, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
      else if (e.type === 'permission') { if (e.phase === 'request') perms.set(e.id, { id: e.id, toolName: e.toolName }); else perms.delete(e.id); }
    }
    const meta = { ...created.meta };
    let archivedAt = null;
    for (const e of events) {
      if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
      else if (e.type === 'archive') archivedAt = e.ts;
    }
    const exit = events.find((e) => e.type === 'exit');
    if (exit) status = 'exited';
    else if (!this.live.has(id)) status = 'lost'; // log says running but no child in this process
    return {
      id, provider: created.provider, model: created.model, cwd: created.cwd, meta,
      status, usage, pendingPermissions: [...perms.values()], lastSeq: last.seq, createdAt: created.ts, updatedAt: last.ts, archivedAt, exit: exit ?? null,
    };
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }

  list() { return this.store.ids(); } // names only; use status(id) for details

  // Marks every live agent as exited by the runner, then kills its process tree.
  shutdown() {
    for (const id of [...this.live.keys()]) {
      try { this.store.append(id, 'exit', { code: null, reason: 'runner-shutdown' }); } catch { /* best effort */ }
      this.kill(id);
    }
    this.live.clear();
  }
}

function pickMeta(meta) {
  const out = {};
  for (const k of META_FIELDS) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}
