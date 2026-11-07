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

// Overall safety ceiling on live agent processes. Process-per-turn keeps the real count near the running turns
// (idle agents are parked right after their turn), so this is only a backstop. Each claude is ~0.4 GB with its MCP sidecars.
export const DEFAULT_MAX_LIVE = 16;
export function maxLiveFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_MAX_LIVE);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_LIVE;
}

// Concurrent RUNNING TURNS per provider family. Over the cap a send/create is queued (FIFO), never refused.
export const DEFAULT_TURN_CAPS = { claude: 6, gemini: 4, antigravity: 3, other: 4 };
export function turnCapsFromEnv(env = process.env) {
  const caps = { ...DEFAULT_TURN_CAPS };
  for (const f of Object.keys(caps)) {
    const n = Number(env[`VS_RUNNER_TURN_CAP_${f.toUpperCase()}`]);
    if (Number.isInteger(n) && n >= 1) caps[f] = n;
  }
  return caps;
}
// A finished agent keeps its process this long so a quick follow-up (a lead's reply, the user's next line) skips the
// resume cost (CLI boot + MCP sidecars + session reload); past it the process is parked. 0 parks on the next tick.
export const DEFAULT_PARK_GRACE_MS = 3000;
export function parkGraceFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_GRACE_MS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PARK_GRACE_MS;
}
export function providerFamily(provider) {
  const p = PROVIDER_ALIASES[provider] ?? provider;
  if (p === 'claude') return 'claude';
  if (typeof p === 'string' && p.startsWith('gemini')) return 'gemini';
  if (p === 'antigravity-cli') return 'antigravity';
  return 'other';
}

export class Runner {
  // limitsFile: where limit-window records go (default: limits.jsonl next to the agents dir, i.e. the runner home).
  // pollAgy: after antigravity-cli turns, poll `agy -p /usage` (ACP carries no quota); only the real server turns it on.
  constructor({ dir, adapters = defaultAdapters(), maxLive = maxLiveFromEnv(), turnCaps = turnCapsFromEnv(), parkGraceMs = parkGraceFromEnv(), limitsFile = path.join(path.dirname(dir), 'limits.jsonl'), pollAgy = false, agyUsage }) {
    this.store = new LogStore(dir);
    this.folds = new Map(); // id -> log-derived status (no liveness), valid while the log file's size + mtime are unchanged
    this.limits = new LimitStore(limitsFile);
    this._pollAgy = pollAgy ? createAgyUsagePoller({ store: this.limits, ...(agyUsage ? { run: agyUsage } : {}) }) : null;
    this.adapters = adapters;
    this.maxLive = maxLive;
    this.turnCaps = { ...DEFAULT_TURN_CAPS, ...turnCaps };
    this.parkGraceMs = parkGraceMs;
    this.queue = []; // FIFO of jobs waiting for a turn slot or a live-process slot: { id, family, needsTurn, run, ahead }
    this.live = new Map(); // id -> { handle, status, ... } for agents running in THIS process only
  }

  create({ provider, model, cwd, prompt, systemPrompt, meta = {} }) {
    if (!this.adapters[provider]) throw new Error(`unknown provider "${provider}"`);
    validateCreate({ model, cwd, meta });
    const id = `rn-${randomBytes(6).toString('hex')}`; // rn- prefix: the VS router tells runner ids from Paseo uuids without a lookup
    this.store.append(id, 'created', { provider, model: model ?? null, cwd, meta: pickMeta(meta), ...(systemPrompt ? { systemPrompt } : {}) }); // kept so a lost resume restores the role prompt
    if (prompt) this.store.append(id, 'input', { text: prompt });
    // Over a cap the agent still exists (its log says queued, N ahead) and starts when its turn comes: never refused.
    this._admit({
      id, family: providerFamily(provider), needsTurn: !!prompt,
      run: () => {
        this._makeRoom(id);
        const entry = this._start(id, { provider, model, cwd, meta, systemPrompt });
        if (prompt) this._deliver(entry, prompt);
      },
    });
    return id;
  }

  // Where a request landed: { queued: false } or { queued: true, ahead } (jobs of the same family ahead of it).
  queuePosition(id) {
    const job = this.queue.find((j) => j.id === id);
    return job ? { queued: true, ahead: job.ahead } : { queued: false };
  }

  // The only place an agent process is started (create and resume-from-park).
  _start(id, { provider, model, cwd, meta, systemPrompt, resume }) {
    // inflight: prompts delivered whose turn has not ended (each adapter emits one idle per finished turn); > 0 means this agent holds a turn slot.
    const entry = { status: 'starting', handle: null, provider, family: providerFamily(provider), systemPrompt, sessionId: resume ?? null, parked: false, lastActive: Date.now(), inflight: 0, turns: resume ? 1 : 0, perms: new Set(), parkTimer: null };
    this.live.set(id, entry);
    const emit = (type, data) => {
      let turnEnded = false;
      if (type === 'status') {
        entry.status = data.status;
        if (data.status === 'idle' || data.status === 'running') entry.lastActive = Date.now();
        if (data.status === 'idle') {
          entry.inflight = Math.max(0, entry.inflight - 1);
          entry.turns++;
          turnEnded = true;
        }
      } else if (type === 'permission') { if (data.phase === 'request') entry.perms.add(data.id); else entry.perms.delete(data.id); }
      else if (type === 'session' && data.sessionId) entry.sessionId = data.sessionId;
      else if (type === 'limit') { try { this.limits.record({ ...data, agentId: id }); } catch { /* limits are best-effort */ } }
      else if (type === 'turn_done' && (PROVIDER_ALIASES[provider] ?? provider) === 'antigravity-cli') this._pollAgy?.(id);
      this.store.append(id, type === 'status' ? 'status' : type, data);
      if (turnEnded) { // after the idle is logged, so a queued follow-up for this same agent logs its running after it
        this._scheduleParkAfterTurn(id, entry);
        this._pump(); // a turn slot just freed
      }
    };
    try {
      entry.handle = this.adapters[provider].start({
        id, env: agentEnv(id, meta), model, cwd, meta, systemPrompt, emit, resume, history: () => this._primer(id),
        onExit: (info) => {
          if (entry.parked) return; // stopped on purpose; the log already says parked
          entry.status = 'exited';
          entry.inflight = 0;
          clearTimeout(entry.parkTimer);
          this.store.append(id, 'exit', info);
          if (this.live.get(id) === entry) this.live.delete(id);
          this._pump();
        },
      });
    } catch (err) {
      if (this.live.get(id) === entry) this.live.delete(id);
      this.store.append(id, 'exit', { code: null, error: err.message });
      throw err;
    }
    return entry;
  }

  // Short recap of the conversation so far (from the log) to prime a fresh session when a provider cannot resume the old one.
  _primer(id, maxChars = 8000) {
    const turns = [];
    for (const e of this.store.read(id)) {
      if (e.type === 'input' && typeof e.text === 'string') turns.push({ who: 'User', text: e.text });
      else if (e.type === 'output' && typeof e.text === 'string') {
        if (turns.at(-1)?.who === 'Assistant') turns.at(-1).text += e.text; else turns.push({ who: 'Assistant', text: e.text });
      }
    }
    if (turns.at(-1)?.who === 'User') turns.pop(); // the prompt that triggered this resume: it is sent right after the primer
    const kept = [];
    let size = 0;
    for (const t of turns.reverse()) {
      const line = `${t.who}: ${t.text}`.slice(-Math.max(200, maxChars - size));
      if (size + line.length > maxChars) break;
      kept.unshift(line);
      size += line.length + 2;
    }
    return kept.length ? `[Context: your previous session could not be restored. Recent conversation so far, oldest first:]\n\n${kept.join('\n\n')}\n\n[End of earlier context. Continue from here.]` : '';
  }

  _parkable(e) { return e.status === 'idle' && e.handle && e.sessionId && e.inflight === 0 && this.adapters[e.provider]?.canPark; }

  // Room for one more live process (the safety ceiling): parks the oldest idle agent if needed. False when nothing can be parked.
  _makeRoom(except, { dryRun = false } = {}) {
    const others = [...this.live.entries()].filter(([k]) => k !== except);
    if (others.length < this.maxLive) return true;
    const idle = others.filter(([, e]) => this._parkable(e)).sort((a, b) => a[1].lastActive - b[1].lastActive);
    if (dryRun) return idle.length > others.length - this.maxLive; // enough parkable agents to get below the ceiling
    for (let n = others.length - this.maxLive + 1; n > 0; n--) {
      if (!idle.length) return false;
      this.park(idle.shift()[0]);
    }
    return true;
  }

  // Running turns of one provider family (agents holding a turn slot), not live processes.
  _running(family) {
    let n = 0;
    for (const e of this.live.values()) if (e.family === family && e.inflight > 0) n++;
    return n;
  }

  _fits(job) {
    const entry = this.live.get(job.id);
    if (job.needsTurn && !(entry?.inflight > 0) && this._running(job.family) >= (this.turnCaps[job.family] ?? this.turnCaps.other)) return false;
    return !!entry || this._makeRoom(job.id, { dryRun: true });
  }

  // Runs the job now when its family has no queue and it fits; otherwise queues it (FIFO) and says so in the log. Never throws a cap error.
  _admit(job) {
    if (!this.queue.some((j) => j.family === job.family) && this._fits(job)) {
      try { job.run(); } catch (err) { this._failJob(job, err); }
      return;
    }
    this.queue.push({ ...job, ahead: -1 });
    this._announceQueue();
  }

  // Starts every queued job that now fits. A job that does not fit blocks later jobs of its family (FIFO); a missing
  // live-process slot blocks everything. Called whenever a turn ends, an agent exits or is parked.
  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      const blocked = new Set();
      for (let i = 0; i < this.queue.length;) {
        const job = this.queue[i];
        if (blocked.has(job.family)) { i++; continue; }
        if (!this._fits(job)) { blocked.add(job.family); i++; continue; }
        this.queue.splice(i, 1);
        try { job.run(); } catch (err) { this._failJob(job, err); }
        i = 0; // running it may have changed what fits (a park, a new turn): rescan from the head
      }
    } finally { this._pumping = false; }
    this._announceQueue();
  }

  _failJob(job, err) {
    try {
      this.store.append(job.id, 'error', { message: err.message });
      this.store.append(job.id, 'status', { status: 'idle' });
    } catch { /* log gone */ }
  }

  // Tells each queued agent where it stands: a `queued` status event with `ahead` (same-family jobs in front), only when it changed.
  _announceQueue() {
    const seen = {};
    for (const job of this.queue) {
      const ahead = seen[job.family] ?? 0;
      seen[job.family] = ahead + 1;
      if (job.ahead === ahead) continue;
      job.ahead = ahead;
      try { this.store.append(job.id, 'status', { status: 'queued', ahead, family: job.family }); } catch { /* log gone */ }
    }
  }

  // After a turn ends, park the agent once it has stayed idle for the grace period (process per turn).
  _scheduleParkAfterTurn(id, entry) {
    clearTimeout(entry.parkTimer);
    if (entry.inflight > 0 || entry.turns < 1) return;
    entry.parkTimer = setTimeout(() => {
      entry.parkTimer = null;
      if (this.live.get(id) !== entry || entry.perms.size > 0 || !this._parkable(entry)) return;
      this.park(id);
      this._pump();
    }, this.parkGraceMs);
    entry.parkTimer.unref?.();
  }

  // Stops an idle agent's process tree but keeps its transcript; the next send() resumes it with --resume.
  park(id) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    if (entry.status !== 'idle') throw new Error(`agent ${id} is ${entry.status}, only idle agents can be parked`);
    if (!entry.sessionId || !this.adapters[entry.provider]?.canPark) throw new Error(`agent ${id} cannot be parked`);
    entry.parked = true;
    clearTimeout(entry.parkTimer);
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
      else if (e.type === 'status' && e.status !== 'parked' && e.status !== 'queued') parked = null;
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
  // A resume needs no turn slot, only a live-process slot; it may queue like a send.
  resume(id) {
    if (this.live.has(id)) return true;
    const spec = this._parkedSpec(id) ?? this._lostSpec(id);
    if (!spec) return false;
    this._admit({ id, family: providerFamily(spec.provider), needsTurn: false, run: () => { this._resume(id, spec); } });
    return true;
  }

  // Starts the parked/lost agent's process in place. Callers have checked the room (_fits); false if there is no spec.
  _resume(id, fallbackSpec = null) {
    const spec = this._parkedSpec(id) ?? fallbackSpec;
    if (!spec) return null;
    if (!this._makeRoom(id)) throw new Error('no live process slot free');
    this.store.append(id, 'status', { status: 'starting' });
    return this._start(id, spec);
  }

  // Hands a prompt to a live agent: from now it holds a turn slot until its turn's idle.
  _deliver(entry, text, images = []) {
    if (!entry?.handle) throw new Error('agent is not running');
    clearTimeout(entry.parkTimer);
    entry.inflight++;
    try { entry.handle.send(text, images.length ? { images } : undefined); } catch (err) { entry.inflight--; throw err; }
  }

  // opts.images: [{ data (base64), mimeType }]; opts.activeTurnBehavior: 'steer' (default, queue behind/into the turn)
  // or 'interrupt' (cancel the active turn first). The log keeps the image count, never the base64 payload.
  // Returns { queued, ahead? }: over the family's turn cap the prompt is logged now and delivered FIFO when a slot frees.
  send(id, text, opts = {}) {
    const live = this.live.get(id);
    const spec = live ? null : this._parkedSpec(id);
    if (!live?.handle && !spec) throw new Error(`agent ${id} is not running`);
    const images = (Array.isArray(opts.images) ? opts.images : []).filter((i) => i && typeof i.data === 'string' && typeof i.mimeType === 'string');
    if (opts.activeTurnBehavior === 'interrupt' && live?.status === 'running') this.cancel(id);
    this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}) });
    const job = {
      id, family: live?.family ?? providerFamily(spec.provider), needsTurn: true,
      run: () => this._deliver(this.live.get(id) ?? this._resume(id), text, images),
    };
    if (live?.inflight > 0 && !this.queue.some((j) => j.id === id)) job.run(); // steering a running turn: it already holds its slot
    else this._admit(job);
    return this.queuePosition(id);
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
    this.queue = this.queue.filter((j) => j.id !== id); // an archived agent's waiting prompts are dropped
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
    const f = this._fold(id);
    if (!f) return null;
    let status = f.status;
    if (f.exit) status = 'exited';
    else if (!this.live.has(id) && status !== 'parked' && !this.queue.some((j) => j.id === id)) status = 'lost'; // log says running but no child in this process
    return { ...f.rec, status, pendingPermissions: [...f.perms] };
  }

  // Every agent's status in one call (roster seed): one pass over the logs, then served from the fold cache.
  statusAll() {
    const out = [];
    for (const id of this.store.ids()) {
      let s = null;
      try { s = this.status(id); } catch { /* unreadable log: left out, like a failed per-id GET */ }
      if (s) out.push(s);
    }
    return out;
  }

  _fold(id) {
    let stamp = null;
    try { const st = statSync(this.store.file(id)); stamp = `${st.size}:${st.mtimeMs}`; } catch { this.folds.delete(id); return null; }
    const hit = this.folds.get(id);
    if (hit?.stamp === stamp) return hit;
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
    const fold = {
      stamp, status, exit: exit ?? null, perms: [...perms.values()],
      rec: { id, provider: created.provider, model: created.model, cwd: created.cwd, meta, usage, lastSeq: last.seq, createdAt: created.ts, updatedAt: last.ts, archivedAt, exit: exit ?? null },
    };
    this.folds.set(id, fold);
    return fold;
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }

  list() { return this.store.ids(); } // names only; use status(id) for details

  // Marks every live agent as exited by the runner, then kills its process tree.
  shutdown() {
    this._pollAgy?.shutdown();
    this.queue.length = 0;
    for (const e of this.live.values()) clearTimeout(e.parkTimer);
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
