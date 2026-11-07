// Agent supervisor: one child per agent, one JSONL log per agent, no pollers.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { createAcpAdapter, acpProviderIds, PROVIDER_ALIASES } from './adapters/acp.mjs';
import { LogStore } from './log.mjs';
import { LimitStore, createAgyUsagePoller } from './limits.mjs';
import path from 'node:path';

// squad/team/lane/role/ord/profile are plain meta fields, first-class on the agent record.
const META_FIELDS = ['squad', 'team', 'lane', 'role', 'ord', 'profile', 'title', 'permissionMode', 'acpMode', 'thinkingOptionId', 'featureValues', 'labels'];

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

// Concurrent live agent processes. Each claude is ~0.4 GB with its MCP sidecars (godot-ai is project-scoped now),
// so 16 fits a normal dev box with room to spare; idle ones are parked past this.
export const DEFAULT_MAX_LIVE = 16;
// How long a spawn or resume waits for a free slot when every live agent is mid-turn.
export const DEFAULT_QUEUE_MS = 10 * 60_000;
export function queueMsFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_QUEUE_MS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_QUEUE_MS;
}

export class AgentCapError extends Error {
  constructor(maxLive) {
    super(`agent cap reached (${maxLive} live) and none are idle to park; wait for one to finish, or raise VS_RUNNER_MAX_LIVE`);
    this.code = 'AGENT_CAP';
    this.status = 503; // runner HTTP API: a busy machine, not a bad request
  }
}
export function maxLiveFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_MAX_LIVE);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_LIVE;
}

export class Runner {
  // limitsFile: where limit-window records go (default: limits.jsonl next to the agents dir, i.e. the runner home).
  // pollAgy: after antigravity-cli turns, poll `agy -p /usage` (ACP carries no quota); only the real server turns it on.
  constructor({ dir, adapters = defaultAdapters(), maxLive = maxLiveFromEnv(), queueMs = queueMsFromEnv(), limitsFile = path.join(path.dirname(dir), 'limits.jsonl'), pollAgy = false, agyUsage }) {
    this.store = new LogStore(dir);
    this.limits = new LimitStore(limitsFile);
    this._pollAgy = pollAgy ? createAgyUsagePoller({ store: this.limits, ...(agyUsage ? { run: agyUsage } : {}) }) : null;
    this.adapters = adapters;
    this.maxLive = maxLive;
    this.queueMs = queueMs;
    this._slotWaiters = new Set(); // resolvers woken when an agent goes idle or exits (a slot may have opened)
    this.live = new Map(); // id -> { handle, status, ... } for agents running in THIS process only
  }

  create({ provider, model, cwd, prompt, systemPrompt, meta = {} }) {
    if (!this.adapters[provider]) throw new Error(`unknown provider "${provider}"`);
    validateCreate({ model, cwd, meta });
    this._ensureSlot(); // before anything is logged: a refused spawn leaves no agent behind
    const id = `rn-${randomBytes(6).toString('hex')}`; // rn- prefix: the VS router tells runner ids from Paseo uuids without a lookup
    this.store.append(id, 'created', { provider, model: model ?? null, cwd, meta: pickMeta(meta), ...(systemPrompt ? { systemPrompt } : {}) }); // kept so a lost resume restores the role prompt
    this._start(id, { provider, model, cwd, meta, systemPrompt });
    if (prompt) this.send(id, prompt);
    return id;
  }

  // The only place an agent process is started (create and resume-from-park).
  _start(id, { provider, model, cwd, meta, systemPrompt, resume }) {
    const entry = { status: 'starting', handle: null, provider, systemPrompt, sessionId: resume ?? null, parked: false, lastActive: Date.now() };
    this.live.set(id, entry);
    const emit = (type, data) => {
      if (type === 'status') {
        entry.status = data.status;
        if (data.status === 'idle' || data.status === 'running') entry.lastActive = Date.now();
        if (data.status === 'idle') this._wakeSlotWaiters();
      } else if (type === 'session' && data.sessionId) entry.sessionId = data.sessionId;
      else if (type === 'limit') { try { this.limits.record({ ...data, agentId: id }); } catch { /* limits are best-effort */ } }
      else if (type === 'turn_done' && (PROVIDER_ALIASES[provider] ?? provider) === 'antigravity-cli') this._pollAgy?.(id);
      this.store.append(id, type === 'status' ? 'status' : type, data);
    };
    try {
      entry.handle = this.adapters[provider].start({
        id, env: agentEnv(id, meta), model, cwd, meta, systemPrompt, emit, resume,
        onExit: (info) => {
          if (entry.parked) return; // stopped on purpose; the log already says parked
          entry.status = 'exited';
          this.store.append(id, 'exit', info);
          if (this.live.get(id) === entry) this.live.delete(id);
          this._wakeSlotWaiters();
        },
      });
    } catch (err) {
      if (this.live.get(id) === entry) this.live.delete(id);
      this.store.append(id, 'exit', { code: null, error: err.message });
      throw err;
    }
    return entry;
  }

  // Makes room for one more live process: parks the oldest idle agent, or refuses if none can be parked.
  _ensureSlot(except) {
    while ([...this.live.keys()].filter((k) => k !== except).length >= this.maxLive) {
      const idle = [...this.live.entries()]
        .filter(([k, e]) => k !== except && e.status === 'idle' && e.handle && e.sessionId && this.adapters[e.provider]?.canPark)
        .sort((a, b) => a[1].lastActive - b[1].lastActive)[0];
      if (!idle) throw new AgentCapError(this.maxLive);
      this.park(idle[0]);
    }
  }

  _wakeSlotWaiters() {
    const waiters = [...this._slotWaiters];
    this._slotWaiters.clear();
    for (const wake of waiters) wake();
  }

  // Retries fn() while it fails only because the cap is full, waking on every idle/exit, for up to queueMs.
  // Leads dispatching several workers at once queue behind busy agents instead of getting spawn errors.
  // opts.signal: an aborted caller (HTTP client gone) stops waiting and never gets a late spawn/delivery.
  async _whenSlot(fn, queueMs = this.queueMs, signal) {
    const deadline = Date.now() + queueMs;
    const aborted = () => Object.assign(new Error('request aborted by client'), { code: 'ABORTED' });
    for (;;) {
      if (signal?.aborted) throw aborted();
      try {
        return fn();
      } catch (err) {
        if (err?.code !== 'AGENT_CAP' || Date.now() >= deadline) throw err;
      }
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(t); this._slotWaiters.delete(wake); resolve(); };
        const t = setTimeout(wake, Math.max(0, Math.min(deadline - Date.now(), 30_000))); // periodic recheck too
        t.unref?.();
        this._slotWaiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
  }

  createQueued(spec, opts = {}) { return this._whenSlot(() => this.create(spec), opts.queueMs, opts.signal); }

  sendQueued(id, text, sendOpts = {}, opts = {}) { return this._whenSlot(() => this.send(id, text, sendOpts), opts.queueMs, opts.signal); }

  // Stops an idle agent's process tree but keeps its transcript; the next send() resumes it with --resume.
  park(id) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    if (entry.status !== 'idle') throw new Error(`agent ${id} is ${entry.status}, only idle agents can be parked`);
    if (!entry.sessionId || !this.adapters[entry.provider]?.canPark) throw new Error(`agent ${id} cannot be parked`);
    entry.parked = true;
    this.store.append(id, 'parked', { sessionId: entry.sessionId, systemPrompt: entry.systemPrompt ?? null });
    this.store.append(id, 'status', { status: 'parked' });
    this.live.delete(id);
    entry.handle.kill();
  }

  // Resume spec for a parked agent, read from its log so it survives a runner restart. Null if not parked.
  _parkedSpec(id) {
    if (!this.store.exists(id)) return null;
    const events = this.store.read(id);
    let parked = null;
    let archived = false;
    // Fold later meta patches (labels, permissionMode, ...) the same way the summary does, so a resume uses the current meta.
    const meta = { ...(events[0]?.meta ?? {}) };
    for (const e of events) {
      if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
      if (e.type === 'parked') parked = e;
      else if (e.type === 'exit') return null;
      else if (e.type === 'archive') archived = true;
      else if (e.type === 'unarchive') archived = false;
      else if (e.type === 'status' && e.status !== 'parked') parked = null;
    }
    if (archived || !parked || typeof parked.sessionId !== 'string' || !parked.sessionId || parked.sessionId.startsWith('-')) return null;
    const c = events[0];
    return { provider: c.provider, model: c.model ?? undefined, cwd: c.cwd, meta, systemPrompt: parked.systemPrompt ?? undefined, resume: parked.sessionId };
  }

  // Resume spec for a lost agent (runner restarted while it was idle/running): the log's last session id, if no exit/archive.
  _lostSpec(id) {
    if (!this.store.exists(id) || this.live.has(id)) return null;
    const events = this.store.read(id);
    let sessionId = null;
    let archived = false;
    const meta = { ...(events[0]?.meta ?? {}) };
    for (const e of events) {
      if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
      if (e.type === 'exit') return null;
      if (e.type === 'archive') archived = true;
      else if (e.type === 'unarchive') archived = false;
      if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
    }
    const c = events[0];
    if (archived || !sessionId || typeof sessionId !== 'string' || sessionId.startsWith('-') || !this.adapters[c?.provider]?.canPark) return null;
    return { provider: c.provider, model: c.model ?? undefined, cwd: c.cwd, meta, systemPrompt: c.systemPrompt ?? undefined, resume: sessionId };
  }

  // Brings a parked or lost agent back in place (same id, same log) without sending anything. False if it can't be resumed.
  resume(id) {
    if (this.live.has(id)) return true;
    return !!this._resume(id, this._lostSpec(id));
  }

  _resume(id, fallbackSpec = null) {
    const spec = this._parkedSpec(id) ?? fallbackSpec;
    if (!spec) return null;
    this._ensureSlot(id);
    this.store.append(id, 'status', { status: 'starting' });
    return this._start(id, spec);
  }

  // opts.images: [{ data (base64), mimeType }]; opts.activeTurnBehavior: 'steer' (default, queue behind/into the turn)
  // or 'interrupt' (cancel the active turn first). The log keeps the image count, never the base64 payload.
  send(id, text, opts = {}) {
    const entry = this.live.get(id) ?? this._resume(id);
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

  // Undoes archive (an agent archived by mistake): the log keeps the archive event, `unarchive` supersedes it. Never resumes anything.
  unarchive(id) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    this.store.append(id, 'unarchive', {});
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
      else if (e.type === 'unarchive') archivedAt = null;
    }
    const exit = events.find((e) => e.type === 'exit');
    if (exit) status = 'exited';
    else if (!this.live.has(id) && status !== 'parked') status = 'lost'; // log says running but no child in this process
    return {
      id, provider: created.provider, model: created.model, cwd: created.cwd, meta,
      status, usage, pendingPermissions: [...perms.values()], lastSeq: last.seq, createdAt: created.ts, updatedAt: last.ts, archivedAt, exit: exit ?? null,
    };
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }

  list() { return this.store.ids(); } // names only; use status(id) for details

  // Marks every live agent as exited by the runner, then kills its process tree.
  shutdown() {
    this._pollAgy?.shutdown();
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
