// Agent supervisor: one child per agent, one JSONL log per agent, no pollers.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { createClaudeAdapter, CLAUDE_PERMISSION_MODES, CLAUDE_EFFORTS } from './adapters/claude.mjs';
import { createAcpAdapter, acpProviderIds, PROVIDER_ALIASES, pickModel } from './adapters/acp.mjs';
import { LogStore } from './log.mjs';
import { LimitStore, createAgyUsagePoller } from './limits.mjs';
import { createBackgroundProbe } from './background.mjs';
import path from 'node:path';

// squad/team/lane/role/ord/profile are plain meta fields, first-class on the agent record.
const META_FIELDS = ['squad', 'team', 'lane', 'role', 'ord', 'profile', 'title', 'permissionMode', 'acpMode', 'thinkingOptionId', 'featureValues', 'labels', 'model'];

// Child/provider noise that is not turn progress: it must not refresh `lastEvent` or clear `quiet` (only assistant
// output, tool activity, status and the like count as a turn still making progress).
const NON_PROGRESS_EVENTS = new Set(['stderr', 'raw', 'limit']);

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
// so every agent id/team/lane/role is overwritten from its own meta. The per-agent token (X1a) is set from the runner's
// memory only, and an inherited one (the runner was started from an agent's shell) is always dropped first: a child
// never carries another agent's token.
export function agentEnv(id, meta = {}, base = process.env, { token } = {}) {
  const env = { ...base, VS_AGENT_ID: id, PASEO_AGENT_ID: id };
  delete env.VS_AGENT_TOKEN;
  if (typeof token === 'string' && token) env.VS_AGENT_TOKEN = token;
  for (const [k, v] of [['VS_TEAM', meta.team], ['VS_LANE', meta.lane], ['VS_ROLE', meta.role], ['VS_ORD', meta.ord], ['VS_PROFILE', meta.profile]]) {
    if (v !== undefined && v !== null && v !== '') env[k] = String(v);
    else delete env[k];
  }
  return env;
}

// ---- Per-agent identity (PLAN_X1_IDENTITY X1a) ---------------------------------------------------------------------
// The runner mints one secret per agent id, once per runner process lifetime, held in memory only (never in the JSONL,
// runner.json, a prompt file or a log line: LogStore.secrets redacts it) and exported into that agent's child env as
// VS_AGENT_TOKEN. A caller is (id, token): a mismatch is refused and the claimed id is ignored. Same-user memory reads stay
// the accepted limit (SECURITY.md).

const DIGEST_PROFILE = 'Pre-check - Flash'; // server/hooks/agent-duties.ts DIGEST_PROFILE: a digest is this profile + labels.digestFor
// Spawning these needs the VS server (admin): a Buddy or a digest is never created by an agent caller.
const ADMIN_ONLY_PROFILE_RE = /^(brainstorm|pre-check)\b/i;
// Meta an agent caller may never set, on `meta.*` or `meta.labels.*` (every key server/identity.mjs, lead-handoff.mjs and
// agent-duties.ts read for privilege: role, lane, team, ord, parent, digest, orphan, retirement markers).
export const PROTECTED_META_KEYS = ['role', 'lane', 'team', 'squad', 'ord', 'profile'];
export const PROTECTED_LABEL_KEYS = ['role', 'lane', 'team', 'squad', 'ord', 'profile', 'lead', 'digestFor', 'orphan', 'topic', 'vs.parent', 'paseo.parent-agent-id', 'vs.auto-archived'];
const isHandoffKey = (k) => k.startsWith('vs.handoff') || k.startsWith('handoff-');
const isProtectedLabel = (k) => PROTECTED_LABEL_KEYS.includes(k) || isHandoffKey(k);
// Labels an agent spawn may never pass: ownership, ordinal, digest and handoff markers are stamped by the runner / the VS server.
const STRIPPED_SPAWN_LABELS = new Set(['ord', 'digestFor', 'vs.auto-archived', 'vs.parent', 'paseo.parent-agent-id', 'lead', 'orphan']);

export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Normalised identity fields of a status record / fold meta: first-class meta wins, labels fill in (runner-backend toAgent folds both).
export function identityOf(meta = {}) {
  const labels = meta?.labels ?? {};
  const pick = (k) => { const v = meta?.[k] ?? labels[k]; return v === undefined || v === null || v === '' ? null : String(v); };
  const rawRole = String(pick('role') ?? '').trim().toLowerCase();
  const role = rawRole === 'buddy' ? 'brainstorm' : rawRole;
  return { role, lane: pick('lane'), team: pick('team'), profile: pick('profile'), labels };
}

// The protected part of a meta patch (what an agent caller is refused for), or null when the patch touches none of it.
export function protectedMetaIn(patch = {}) {
  const hit = [];
  for (const k of Object.keys(patch ?? {})) if (PROTECTED_META_KEYS.includes(k) || isHandoffKey(k)) hit.push(k);
  for (const k of Object.keys(patch?.labels ?? {})) if (isProtectedLabel(k)) hit.push(`labels.${k}`);
  return hit.length ? hit : null;
}

/**
 * Whether a verified agent caller may run `action` on `target` (a status record with meta, or null). Pure: the runner
 * resolves caller and target, this is the rule table of PLAN_X1_IDENTITY "Runner scope for agent callers".
 *   input: any agent of the caller's Squad.
 *   cancel: self; own children; lane workers for a lead; any Squad agent for the Overlord; never a lead/Buddy from a worker.
 *   archive/unarchive/resume/meta: own children; lane workers for a lead; Squad workers for the Overlord. config: also self.
 */
export function agentMay(caller, action, target) {
  if (!caller || !target?.meta) return false;
  const t = identityOf(target.meta);
  const sameSquad = !!caller.team && t.team === caller.team;
  const self = target.id === caller.id;
  const child = String(t.labels['vs.parent'] ?? '') === caller.id;
  const laneWorker = sameSquad && t.role === 'worker' && !!caller.lane && t.lane === caller.lane;
  const squadWorker = sameSquad && t.role === 'worker';
  const isLead = caller.role === 'lead';
  switch (action) {
    case 'input': return sameSquad;
    case 'cancel':
      if (self || child) return true;
      if (caller.overlord && sameSquad) return true;
      if (isLead && laneWorker) return true;
      return false;
    case 'config':
      if (self) return true;
      // falls through: otherwise like archive
    case 'archive': case 'unarchive': case 'resume': case 'meta':
      if (child) return true;
      if (caller.overlord && squadWorker) return true;
      if (isLead && laneWorker) return true;
      return false;
    default: return false;
  }
}

/**
 * The meta an agent caller's spawn request actually gets. Throws a 403-tagged error when the requested role is not
 * allowed (never a silent downgrade, tools.mjs rule): `brainstorm`/Brainstorm/Pre-check profiles need the VS server;
 * `lead` only for a Buddy on its own lane or the Overlord inside its Squad, and only when that lane has no live lead.
 * Anything else becomes `worker` in the caller's lane (the Overlord may name another lane of its Squad). Team + parent are
 * always the caller's. Enforced on both meta.* and meta.labels.* (runner-backend folds them together).
 */
export function spawnMetaForAgent(caller, meta = {}, { laneHasLiveLead = () => false } = {}) {
  const forbid = (m) => { const e = new Error(m); e.status = 403; return e; };
  const want = identityOf(meta);
  const labels = { ...(meta.labels ?? {}) };
  for (const k of Object.keys(labels)) if (STRIPPED_SPAWN_LABELS.has(k) || isHandoffKey(k)) delete labels[k];
  const out = { ...meta, labels };
  for (const k of ['ord', 'squad']) delete out[k];
  if (want.profile && ADMIN_ONLY_PROFILE_RE.test(want.profile)) throw forbid(`an agent may not spawn profile "${want.profile}" (the VS server spawns Buddies and digests)`);
  if (want.role === 'brainstorm') throw forbid('an agent may not spawn a brainstorm (Buddy)');
  let role = 'worker';
  let lane = caller.lane ?? null;
  if (want.role === 'lead') {
    const targetLane = want.lane ?? caller.lane ?? null;
    const asBuddy = caller.role === 'brainstorm' && !!caller.lane && targetLane === caller.lane;
    const asOverlord = caller.overlord === true && !!targetLane;
    if (!asBuddy && !asOverlord) throw forbid(`${caller.id} (${caller.role || 'worker'}) may not spawn a lead${targetLane ? ` on lane "${targetLane}"` : ''}: only that lane's Buddy or the Squad's Overlord may`);
    if (laneHasLiveLead(caller.team, targetLane)) throw forbid(`lane "${targetLane}" already has a live lead`);
    role = 'lead';
    lane = targetLane;
  } else if (want.role && want.role !== 'worker') {
    throw forbid(`an agent may not spawn role "${want.role}"`);
  } else if (caller.overlord && want.lane) {
    lane = want.lane; // the Overlord may place a worker on any lane of its Squad
  }
  out.role = role;
  out.labels.role = role;
  if (lane) { out.lane = lane; out.labels.lane = lane; } else { delete out.lane; delete out.labels.lane; }
  if (caller.team) { out.team = caller.team; out.labels.team = caller.team; } else { delete out.team; delete out.labels.team; }
  out.labels['vs.parent'] = caller.id;
  return out;
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
export const DEFAULT_TURN_CAPS = { claude: 12, gemini: 4, antigravity: 3, other: 4 };
// Owner turns (a human send from the UI / `vs send`) may run over a family's cap: at most this many extra
// owner turns per family at once, so an owner message to a busy Buddy starts within seconds instead of
// waiting behind the worker backlog. The count is released as each over-cap owner turn ends.
export const OWNER_OVER_CAP = 2;
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
// The after-turn park is held while the agent has background work (a shell its CLI left running: a test suite, a build;
// see background.mjs), re-checked every poll, and forced (logged as park-forced, with what was killed) past the max hold
// so a held agent cannot keep its live slot forever. A max hold of 0 turns the hold off (park kills the tree at once).
export const DEFAULT_PARK_HOLD_MAX_MS = 60 * 60 * 1000;
export function parkHoldMaxFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_HOLD_MAX_MS);
  return env.VS_RUNNER_PARK_HOLD_MAX_MS !== undefined && env.VS_RUNNER_PARK_HOLD_MAX_MS !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_PARK_HOLD_MAX_MS;
}
export const DEFAULT_PARK_HOLD_POLL_MS = 15_000;
export function parkHoldPollFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_HOLD_POLL_MS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_PARK_HOLD_POLL_MS;
}
// An archived agent that is mid-turn gets a cancel; if it has not stopped by then it is killed (session kept).
export const DEFAULT_ARCHIVE_KILL_MS = 10_000;
export function archiveKillFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_ARCHIVE_KILL_MS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_ARCHIVE_KILL_MS;
}
// A running turn that has produced no log events for this long is flagged `quiet` and stops counting toward its family
// turn cap (its process keeps running; its next event counts it again). 0 flags immediately (dev/test only).
export const DEFAULT_QUIET_MS = 600000;
export function quietFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_QUIET_MS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_QUIET_MS;
}
// idea-126: what a turn the runner going away cut (a `vs restart` whose idle wait timed out, a crash) is resumed with, so
// the agent finishes its work instead of resuming to idle. Logged as an `input` tagged `resume: true` (not an owner line).
export const CONTINUE_PROMPT = '[VibeSquad runtime] Your previous turn was interrupted by a runtime restart before it finished. Continue where you left off: check what was already done before redoing anything.';
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
  // hubLane: (team) -> the Squad's hub lane id (its Overlord's lane). Default: the lane whose id is the team id, the
  // registry rule when no lane is flagged hub (server/lane-pure.mjs isHubLane); the real server reads teams.json.
  constructor({ dir, adapters = defaultAdapters({ promptsDir: path.join(path.dirname(dir), 'prompts') }), maxLive = maxLiveFromEnv(), turnCaps = turnCapsFromEnv(), parkGraceMs = parkGraceFromEnv(), archiveKillMs = archiveKillFromEnv(), quietMs = quietFromEnv(), limitsFile = path.join(path.dirname(dir), 'limits.jsonl'), pollAgy = false, agyUsage, queueMaxAgeMs = queueMaxAgeFromEnv(), parkHoldMaxMs = parkHoldMaxFromEnv(), parkHoldPollMs = parkHoldPollFromEnv(), bgProbe = createBackgroundProbe(), hubLane = (team) => team }) {
    this.store = new LogStore(dir);
    this.tokensById = new Map(); // id -> per-agent token, memory only (see agentEnv / verifyAgent); minted once per id per runner lifetime
    this.store.secrets = () => this.tokensById.values(); // every append (and SSE tail) is scrubbed of every live token
    this.hubLane = hubLane;
    this.folds = new Map(); // id -> log-derived status (no liveness), valid while the log file's size + mtime are unchanged
    this.limits = new LimitStore(limitsFile);
    this._pollAgy = pollAgy ? createAgyUsagePoller({ store: this.limits, ...(agyUsage ? { run: agyUsage } : {}) }) : null;
    this.adapters = adapters;
    this.maxLive = maxLive;
    this.turnCaps = { ...DEFAULT_TURN_CAPS, ...turnCaps };
    this.parkGraceMs = parkGraceMs;
    this.parkHoldMaxMs = parkHoldMaxMs;
    this.parkHoldPollMs = parkHoldPollMs;
    this.bgProbe = bgProbe; // (pid) -> Promise<[{ pid, name, cmd }]>: background shells under an agent's CLI
    this.archiveKillMs = archiveKillMs;
    this.queueMaxAgeMs = queueMaxAgeMs; // recoverQueued ignores inputs queued longer ago than this (0 = no bound)
    this.quietMs = quietMs;
    this._quietSweep = setInterval(() => this._sweepQuiet(), Math.max(25, Math.min(this.quietMs, 1000)));
    this._quietSweep.unref?.(); // never keeps the process alive (tests exit without clearing it)
    this.queue = []; // FIFO of jobs waiting for a turn slot or a live-process slot: { id, family, needsTurn, run, ahead }
    this.live = new Map(); // id -> { handle, status, ... } for agents running in THIS process only
    this.overCapOwner = new Map(); // family -> count of owner turns currently running OVER that family's turn cap (released on turn end)
  }

  create({ provider, model, cwd, prompt, systemPrompt, meta = {} }) {
    if (!this.adapters[provider]) throw new Error(`unknown provider "${provider}"`);
    validateCreate({ model, cwd, meta });
    const id = `rn-${randomBytes(6).toString('hex')}`; // rn- prefix: the VS router tells runner ids from Paseo uuids without a lookup
    this.tokenFor(id); // minted before anything is logged: the log store redacts it from this agent's first line on
    this.store.append(id, 'created', { provider, model: model ?? null, cwd, meta: pickMeta(meta), ...(systemPrompt ? { systemPrompt } : {}) }); // kept so a lost resume restores the role prompt
    if (prompt) this.store.append(id, 'input', { text: prompt });
    // Over a cap the agent still exists (its log says queued, N ahead) and starts when its turn comes: never refused.
    const job = {
      id, family: providerFamily(provider), needsTurn: !!prompt, kind: 'create', text: prompt, images: [],
      run: () => {
        this._makeRoom(id);
        const cur = this._fold(id)?.meta ?? meta; // a config change while this create sat queued must apply
        const entry = this._start(id, { provider, model: cur.model ?? model, cwd, meta: cur, systemPrompt });
        if (job.text) { this._noteOwnerOverCap(job, entry); this._deliver(entry, job.text, job.images ?? []); } // job.text: a send may have coalesced into the queued create
      },
    };
    this._admit(job);
    return id;
  }

  // The agent's token: minted on first use, then the same for the rest of this runner process (park/resume and every
  // later turn reuse it, so a running `vs` shell keeps working across turns). Never persisted.
  tokenFor(id) {
    let t = this.tokensById.get(id);
    if (!t) { t = randomBytes(32).toString('hex'); this.tokensById.set(id, t); }
    return t;
  }

  // Boot: a token for every agent that may still act (non-exited, non-archived), so agents alive across a runner restart
  // verify from the first request (their shells pick the token up on their next turn's fresh child; see the plan's migration note).
  mintBootTokens() {
    const minted = [];
    for (const id of this.store.ids()) {
      let f = null;
      try { f = this.folds.get(id) ?? this._fold(id); } catch { continue; }
      if (!f?.created || f.exit || f.archivedAt) continue;
      if (!this.tokensById.has(id)) minted.push(id);
      this.tokenFor(id);
    }
    return minted;
  }

  /**
   * The verified caller for (id, token), or null (→ 403). Constant-time token compare, then the agent's folded status
   * (never `live`: a parked agent left `live` seconds after its turn and is still that agent). Refused when the agent is
   * gone (no status, exited, archived), retired (former-* / old-lead / retired role: a former lead keeps its process for a
   * while but no longer speaks for the lane) or flagged orphan. `digest` is the shape spawnWorkerDigest writes.
   * `overlord` = a lead on its Squad's hub lane.
   */
  verifyAgent(id, token) {
    if (typeof id !== 'string' || !id) return null;
    const want = this.tokensById.get(id);
    if (!want || !secretEquals(token, want)) return null;
    let s = null;
    try { s = this.status(id); } catch { return null; }
    if (!s || s.status === 'exited' || s.exit || s.archivedAt) return null;
    const meta = s.meta ?? {};
    if (isRetiredMeta(meta)) return null;
    const { role, lane, team, profile, labels } = identityOf(meta);
    const orphan = String(labels.orphan ?? '').trim().toLowerCase();
    if (orphan === '1' || orphan === 'true') return null; // idea-134: both spellings mark an orphan
    const digestFor = labels.digestFor ? String(labels.digestFor) : null;
    const digest = profile === DIGEST_PROFILE && !!digestFor;
    const overlord = role === 'lead' && !!lane && !!team && this.hubLane(team) === lane;
    return { id, role, lane, team, profile, digest, digestFor, status: s.status, overlord };
  }

  // A lead that still counts for the lane: created, not exited, not archived, not retired, role lead, same team + lane.
  // Same liveness as verifyAgent (a lost-but-resumable lead is still the lane's lead: server/identity.mjs isLiveAgent).
  laneHasLiveLead(team, lane) {
    if (!lane) return false;
    for (const id of this.store.ids()) {
      let f = null;
      try { f = this._fold(id); } catch { continue; }
      if (!f?.created || f.exit || f.archivedAt || isRetiredMeta(f.meta)) continue;
      const t = identityOf(f.meta);
      if (t.role === 'lead' && t.lane === lane && (t.team ?? null) === (team ?? null)) return true;
    }
    return false;
  }

  // Where a request landed: { queued: false } or { queued: true, ahead } (jobs of the same family ahead of it).
  queuePosition(id) {
    const job = this.queue.find((j) => j.id === id);
    return job ? { queued: true, ahead: job.ahead } : { queued: false };
  }

  // The only place an agent process is started (create and resume-from-park).
  _start(id, { provider, model, cwd, meta, systemPrompt, resume }) {
    // inflight: OPEN TURNS, not prompts (each adapter emits one idle per finished turn); > 0 means this agent holds a
    // turn slot. A steer into a turn already running merges into it (one idle), so it must not open a second slot.
    const entry = { status: 'starting', handle: null, provider, family: providerFamily(provider), systemPrompt, sessionId: resume ?? null, parked: false, lastActive: Date.now(), lastEvent: Date.now(), quiet: false, inflight: 0, turns: resume ? 1 : 0, perms: new Set(), parkTimer: null, progress: 0, idleProgress: 0, turnGen: 0, work: null, heldSince: null };
    this.live.set(id, entry);
    const emit = (type, data) => {
      // A late event from a child that was just parked/killed (killTree is async on Windows) must not touch a dead
      // entry: a stray 'running' after 'parked' would corrupt _parkedSpec (the agent reads 'lost') or re-take inflight.
      if (entry.parked || entry.status === 'exited' || this.live.get(id) !== entry) return;
      if (!NON_PROGRESS_EVENTS.has(type)) { // only turn-progress events count: stderr/raw/limit are noise
        entry.lastEvent = Date.now();
        entry.progress++;
        if (entry.quiet) entry.quiet = false; // a real event ends a quiet turn's quiet period: it counts again
      }
      let turnEnded = false;
      if (type === 'status') {
        entry.status = data.status;
        if (data.status === 'idle' || data.status === 'running') entry.lastActive = Date.now();
        if (data.status === 'running') {
          // Mirror the adapter's real turn state: a follow-up turn (an ACP steer, a claude interrupt) re-takes the
          // slot after the previous idle cleared it. Over-cap is allowed (like OWNER_OVER_CAP / a quiet turn): the
          // agent was already admitted, so it is never re-queued or cancelled for a turn it is already running.
          if (entry.inflight === 0) entry.inflight = 1;
          this._turnStarted(entry);
        }
        if (data.status === 'idle') {
          entry.inflight = 0;
          entry.turns++;
          entry.idleProgress = entry.progress;
          turnEnded = true;
          this._releaseOverCap(entry, 1); // an owner turn that was running over the cap just ended
        }
      } else if (type === 'permission') { if (data.phase === 'request') entry.perms.add(data.id); else entry.perms.delete(data.id); }
      else if (type === 'session' && data.sessionId) entry.sessionId = data.sessionId;
      else if (type === 'limit') { try { this.limits.record({ ...data, agentId: id }); } catch { /* limits are best-effort */ } }
      else if (type === 'turn_done' && (PROVIDER_ALIASES[provider] ?? provider) === 'antigravity-cli') this._pollAgy?.(id);
      this.store.append(id, type === 'status' ? 'status' : type, data);
      if (turnEnded) { // after the idle is logged, so a queued follow-up for this same agent logs its running after it
        if (entry.archiveWhenIdle) this._stopKeepingSession(id, entry); // archived mid-turn: stop now (any prompts still queued in the child are moot)
        else this._scheduleParkAfterTurn(id, entry);
        this._pump(); // a turn slot just freed
      }
    };
    try {
      entry.handle = this.adapters[provider].start({
        id, env: agentEnv(id, meta, process.env, { token: this.tokenFor(id) }), model, cwd, meta, systemPrompt, emit, resume, history: () => this._primer(id),
        onExit: (info) => {
          if (entry.parked) return; // stopped on purpose; the log already says parked
          entry.status = 'exited';
          entry.inflight = 0;
          this._releaseOverCap(entry, entry.ownerOverCap ?? 0); // any owner over-cap turns end with the process
          clearTimeout(entry.parkTimer);
          this._clearArchive(entry);
          this.store.append(id, 'exit', info);
          if (this.live.get(id) === entry) this.live.delete(id);
          this._pump();
        },
      });
    } catch (err) {
      if (this.live.get(id) === entry) this.live.delete(id);
      if (resume) this.store.append(id, 'error', { message: err.message }); // a failed resume must not end the agent: _failJob re-parks it
      else this.store.append(id, 'exit', { code: null, error: err.message });
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

  // A turn opened: what the last probe saw (and any hold) no longer applies; the turn's own idle re-checks.
  _turnStarted(e) { e.turnGen++; e.work = null; e.heldSince = null; }

  // Background work is only possible after a turn ran in this process, and only checkable with a pid and the hold on.
  _mayHoldWork(e) { return this.parkHoldMaxMs > 0 && !!this.bgProbe && Number.isInteger(e.handle?.pid) && e.turnGen > 0; }

  // Parkable without killing background work: nothing to check, or the last probe since the turn ended saw none.
  _parkableNow(e) { return this._parkable(e) && (!this._mayHoldWork(e) || e.work?.length === 0); }

  // Probes the agent's tree once (deduped per entry), with a process snapshot started after its turn ended. Resolves to the work list, or null when a turn started meanwhile
  // (the snapshot predates it). A failing probe resolves to [] (the old park) and logs park-probe-error.
  _probeWork(id, e) {
    if (e.probing) return e.probing;
    const gen = e.turnGen;
    const settle = (work) => { e.probing = null; if (e.turnGen !== gen) return null; e.work = work; return work; };
    e.probing = Promise.resolve().then(() => this.bgProbe(e.handle.pid, e.lastActive)).then( // lastActive = the turn end: no snapshot from before it
      (work) => settle(Array.isArray(work) ? work : []),
      (err) => { try { this.store.append(id, 'park-probe-error', { message: String(err?.message ?? err) }); } catch { /* log gone */ } return settle([]); },
    );
    return e.probing;
  }

  // Room for one more live process (the safety ceiling): parks the oldest idle agent if needed. False when nothing can be parked.
  _makeRoom(except, { dryRun = false } = {}) {
    const others = [...this.live.entries()].filter(([k]) => k !== except);
    if (others.length < this.maxLive) return true;
    // Never for room: an idle agent with background work (held). One not yet probed is probed now; the result re-pumps.
    for (const [k, e] of others) if (this._parkable(e) && !this._parkableNow(e) && e.work === null) this._probeWork(k, e).then(() => this._pump());
    const idle = others.filter(([, e]) => this._parkableNow(e)).sort((a, b) => a[1].lastActive - b[1].lastActive);
    if (dryRun) return idle.length > others.length - this.maxLive; // enough parkable agents to get below the ceiling
    for (let n = others.length - this.maxLive + 1; n > 0; n--) {
      if (!idle.length) return false;
      this.park(idle.shift()[0]);
    }
    return true;
  }

  // Running turns of one provider family (agents holding a turn slot), not live processes. A quiet turn (see _sweepQuiet)
  // does not count: its process keeps running but it yields its family slot so the queue can advance.
  _running(family) {
    let n = 0;
    for (const e of this.live.values()) if (e.family === family && e.inflight > 0 && !e.quiet) n++;
    return n;
  }

  // Flags running turns that have produced no log events for quietMs as `quiet`: they stop counting toward their
  // family turn cap (see _running) so the queue can advance, but the process keeps running (never cancel/park/requeue).
  // Its next event clears the flag (see emit); it may then sit over the cap, which is allowed.
  _sweepQuiet() {
    let changed = false;
    const now = Date.now();
    for (const [id, e] of this.live.entries()) {
      if (e.inflight > 0 && !e.quiet && now - e.lastEvent >= this.quietMs) {
        e.quiet = true;
        try { this.store.append(id, 'turn-quiet', { since: e.lastEvent }); } catch { /* best effort */ }
        changed = true;
      }
    }
    if (changed) this._pump();
  }

  // Releases up to `n` of an entry's owner over-cap turns from its family's over-cap budget. Idempotent: an entry
  // with no over-cap turns (or a normal turn ending) releases nothing.
  _releaseOverCap(entry, n) {
    const have = entry?.ownerOverCap ?? 0;
    if (!entry || have <= 0 || !(n > 0)) return;
    const take = Math.min(have, n);
    entry.ownerOverCap = have - take;
    const f = entry.family;
    this.overCapOwner.set(f, Math.max(0, (this.overCapOwner.get(f) ?? 0) - take));
  }

  _fits(job) {
    const entry = this.live.get(job.id);
    if (job.needsTurn && !(entry?.inflight > 0)) {
      const cap = this.turnCaps[job.family] ?? this.turnCaps.other;
      const running = this._running(job.family);
      // Over the cap only an OWNER job may start, and only within the +OWNER_OVER_CAP over-cap budget.
      if (running >= cap && (!job.owner || (this.overCapOwner.get(job.family) ?? 0) >= OWNER_OVER_CAP)) return false;
    }
    return !!entry || this._makeRoom(job.id, { dryRun: true });
  }

  // Runs the job now when it fits and nothing of its family should run first; otherwise queues it and says so in the log.
  // An owner job jumps non-owner jobs of its family (FIFO among owner jobs), so it can start over the cap immediately.
  _admit(job) {
    // A job that would run ahead of this one in the queue: any same-family job for a non-owner, but only a same-family
    // OWNER job for an owner (owners run before workers, FIFO among themselves).
    const familyQueued = this.queue.some((j) => j.family === job.family && (!job.owner || j.owner));
    if (!familyQueued && this._fits(job)) {
      try { job.run(); } catch (err) { this._failJob(job, err); }
      return;
    }
    this._enqueue(job);
  }

  // Owner jobs sit ahead of non-owner jobs of the same family (FIFO within each group). Everything else appends FIFO.
  _enqueue(job) {
    job.ahead = -1;
    if (job.owner) {
      const idx = this.queue.findIndex((j) => j.family === job.family && !j.owner);
      if (idx === -1) this.queue.push(job);
      else this.queue.splice(idx, 0, job);
    } else {
      this.queue.push(job);
    }
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

  // A job that cannot run must leave its agent recoverable: a live agent goes back to idle, a parked/lost one is put back
  // to parked (same session, so the next send resumes it), and a create that never started gets a clear exit with the error.
  _failJob(job, err) {
    try {
      const id = job.id;
      this.store.append(id, 'error', { message: err.message });
      if (this.live.get(id)) this.store.append(id, 'status', { status: 'idle' });
      else if (job.spec?.resume) {
        this.store.append(id, 'parked', { sessionId: job.spec.resume, systemPrompt: job.spec.systemPrompt ?? null });
        this.store.append(id, 'status', { status: 'parked' });
      } else if (!this._fold(id)?.exit) this.store.append(id, 'exit', { code: null, error: err.message });
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
    this._armPark(id, entry, entry.configStale ? 0 : this.parkGraceMs); // a pending config change must not be served by the old process
  }

  _armPark(id, entry, ms) {
    clearTimeout(entry.parkTimer);
    entry.parkTimer = setTimeout(() => {
      entry.parkTimer = null;
      if (this._shutDown || this.live.get(id) !== entry || entry.perms.size > 0 || !this._parkable(entry)) return;
      this._parkWhenClear(id, entry);
    }, ms);
    entry.parkTimer.unref?.();
  }

  // park() kills the whole tree, so a background shell the CLI left running (run_in_background: a full test suite, a
  // build) would die with no exit notice to the agent. Hold the park while one lives, re-check every parkHoldPollMs, and
  // park once it is gone (after one more grace, so the CLI can report the finished task first). Past parkHoldMaxMs the
  // park is forced and logged with what it kills (park-forced), so a held agent cannot keep its live slot forever.
  // Explicit stops (archive, shutdown, kill) still kill at once.
  _parkWhenClear(id, entry) {
    if (!this._mayHoldWork(entry)) { this.park(id); this._pump(); return; }
    this._probeWork(id, entry).then((work) => {
      if (work === null || this._shutDown || this.live.get(id) !== entry || entry.perms.size > 0 || !this._parkable(entry)) return; // a turn started or the agent went: its own idle re-arms
      if (entry.progress !== entry.idleProgress) { // events since the idle with no new turn (the CLI reporting a finished task on its own)
        entry.idleProgress = entry.progress;
        entry.work = null;
        this._scheduleParkAfterTurn(id, entry);
        return;
      }
      if (!work.length) {
        if (entry.heldSince === null) { this.park(id); this._pump(); return; }
        entry.heldSince = null;
        entry.work = null;
        this._scheduleParkAfterTurn(id, entry);
        return;
      }
      const now = Date.now();
      if (entry.heldSince === null) {
        entry.heldSince = now;
        this.store.append(id, 'park-held', { work, maxHoldMs: this.parkHoldMaxMs });
      }
      const heldMs = now - entry.heldSince;
      if (heldMs >= this.parkHoldMaxMs) {
        this.store.append(id, 'park-forced', { heldMs, work });
        this.park(id);
        this._pump();
        return;
      }
      entry.work = null; // the next check takes a fresh snapshot
      this._armPark(id, entry, Math.min(this.parkHoldPollMs, this.parkHoldMaxMs - heldMs));
    }).catch((err) => { try { this.store.append(id, 'error', { message: `park: ${err.message}` }); } catch { /* log gone */ } }); // never an unhandled rejection in the runner
  }

  // Stops an idle agent's process tree but keeps its transcript; the next send() resumes it with --resume.
  park(id) {
    const entry = this.live.get(id);
    if (!entry?.handle) throw new Error(`agent ${id} is not running`);
    if (entry.status !== 'idle') throw new Error(`agent ${id} is ${entry.status}, only idle agents can be parked`);
    if (!entry.sessionId || !this.adapters[entry.provider]?.canPark) throw new Error(`agent ${id} cannot be parked`);
    entry.parked = true;
    clearTimeout(entry.parkTimer);
    this._clearArchive(entry);
    this.store.append(id, 'parked', { sessionId: entry.sessionId, systemPrompt: entry.systemPrompt ?? null });
    this.store.append(id, 'status', { status: 'parked' });
    this.live.delete(id);
    entry.handle.kill();
  }

  // Drops a pending archive-stop (flag + kill timer): unarchive, park and exit all end that window.
  _clearArchive(entry) {
    if (!entry) return;
    entry.archiveWhenIdle = false;
    clearTimeout(entry.archiveTimer);
    entry.archiveTimer = null;
  }

  // Ends an agent's process for good measure but leaves it resumable: with a session it is logged as parked (so unarchive + send
  // resumes it) even when mid-turn or still starting; without one the kill logs a plain exit. Frees its live and turn slots.
  _stopKeepingSession(id, entry) {
    clearTimeout(entry.parkTimer);
    this._clearArchive(entry);
    this._releaseOverCap(entry, entry.ownerOverCap ?? 0); // any owner over-cap turns end with the session stop
    if (!entry.handle || this.live.get(id) !== entry) return;
    if (entry.sessionId && this.adapters[entry.provider]?.canPark) {
      entry.parked = true;
      this.store.append(id, 'parked', { sessionId: entry.sessionId, systemPrompt: entry.systemPrompt ?? null });
      this.store.append(id, 'status', { status: 'parked' });
      this.live.delete(id);
      entry.handle.kill();
    } else entry.handle.kill(); // onExit logs the exit and frees the slot
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
    return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: parked.systemPrompt ?? undefined, resume: parked.sessionId };
  }

  // Whether a closed agent can come back in place (same id + session). Mirrors the resume endpoint's 409 condition
  // (_lostSpec/_parkedSpec): a saved session event, no exit, no archive, and an adapter that can resume. Exposed on the
  // status record so the server can tell "closed (resumable, live)" from "closed (retired, replace it)".
  _resumable(f) {
    if (!f || f.exit || f.archivedAt) return false;
    const sid = f.sessionId;
    if (!sid || typeof sid !== 'string' || sid.startsWith('-')) return false;
    return !!this.adapters[f.created?.provider]?.canPark;
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
    return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: c.systemPrompt ?? undefined, resume: sessionId };
  }

  // An agent whose log ends in a `queued` status never got its turn: nothing was delivered after the queued events. The runner's
  // queue is in memory, so a runner restart drops the job while the log still says queued. Returns the spec to start it (fresh
  // or, when a session was recorded, resumed) and the inputs logged since the last real status, or null if it is not that case.
  _unstartedPlan(id) {
    if (!this.store.exists(id) || this.live.has(id) || this.queue.some((j) => j.id === id)) return null; // a queued job already owns these inputs
    // Warm folds (recoverQueued's boot pass): a log whose last status is not `queued` can't be unstarted; skip the second full parse.
    // _fold is stat-validated, so a log that grew since the pass is refolded incrementally, never served stale.
    if (this._foldsWarm) { const f = this._fold(id); if (f && f.status !== 'queued') return null; }
    const events = this.store.read(id);
    const c = events[0];
    if (c?.type !== 'created' || !this.adapters[c.provider]) return null;
    let status = null;
    let statusTs = 0;
    let archived = false;
    let sessionId = null;
    let cut = -1; // index of the last non-queued status: inputs before it were delivered
    const meta = { ...(c.meta ?? {}) };
    events.forEach((e, i) => {
      if (e.type === 'exit') status = 'exited';
      else if (e.type === 'archive') archived = true;
      else if (e.type === 'unarchive') archived = false;
      else if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
      else if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
      else if (e.type === 'status') { status = e.status; statusTs = e.ts ?? 0; if (e.status !== 'queued') cut = i; }
    });
    if (status !== 'queued' || archived) return null;
    const inputs = events.filter((e, i) => e.type === 'input' && i > cut && typeof e.text === 'string');
    if (!inputs.length) return null;
    if (isRetiredMeta(meta)) return null; // retirePredecessors / confirmTakeover only relabel the role (never archive): a former-lead stays dead
    if (this.queueMaxAgeMs > 0 && Date.now() - statusTs > this.queueMaxAgeMs) return null; // stale: a days-old input must not run on a whim
    const supersededBy = this._successorOf(id, meta);
    const resumable = sessionId && !sessionId.startsWith('-') && this.adapters[c.provider]?.canPark;
    return {
      spec: { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: c.systemPrompt ?? undefined, ...(resumable ? { resume: sessionId } : {}) },
      text: inputs.map((e) => e.text).join('\n\n'),
      owner: inputs.some((e) => e.owner === true),
      ts: inputs[0].ts ?? 0,
      supersededBy,
    };
  }

  // A lead/Buddy whose replacement was spawned while it sat queued is superseded, whatever became of the replacement (it may have
  // exited, been archived or itself retired by the time of a restart). Reviving the old one would make `vs who lead` CONFLICT.
  // Superseded = any NEWER agent (created later; id breaks a tie) in the same team + lane + role family (lead/former-lead,
  // brainstorm/former-brainstorm; Buddies also the same topic). Workers and lane-less agents have no successor. Returns its id or null.
  _successorOf(id, meta) {
    const family = roleFamily(meta);
    const lane = meta?.lane;
    if ((family !== 'lead' && family !== 'brainstorm') || !lane) return null;
    const team = meta.team ?? null;
    const topic = family === 'brainstorm' ? (meta.labels?.topic ?? meta.topic ?? null) : null;
    const mine = this._fold(id)?.created?.ts ?? 0;
    for (const other of this.store.ids()) {
      if (other === id) continue;
      let f = null;
      // Warm after recoverQueued's boot pass: use the cached fold (no stat, no log read); only an agent never folded is read.
      try { f = this._foldsWarm ? (this.folds.get(other) ?? this._fold(other)) : this._fold(other); } catch { continue; }
      if (!f?.created) continue;
      const ts = f.created.ts ?? 0;
      if (ts < mine || (ts === mine && other < id)) continue;
      const m = f.meta ?? {};
      if (roleFamily(m) !== family || m.lane !== lane || (m.team ?? null) !== team) continue;
      if (family === 'brainstorm' && (m.labels?.topic ?? m.topic ?? null) !== topic) continue;
      return other;
    }
    return null;
  }

  // Runner boot: re-enqueues every agent that was queued (turn cap) when the previous runner went away, in their original
  // order (oldest unstarted input first; owner jobs still jump non-owner ones). Idempotent: the job's start logs a
  // non-queued status, which moves the log's cut past the input, so a second boot never replays it. Returns the ids re-enqueued.
  recoverQueued() {
    const plans = [];
    this._foldsWarm = false;
    for (const id of this.store.ids()) { try { this._fold(id); } catch { /* unreadable log: skipped below too */ } } // one boot pass; later successor checks read the cache
    this._foldsWarm = true;
    this.mintBootTokens(); // from the same pass: every agent that may still act verifies from the first request after a restart
    for (const id of this.store.ids()) {
      let plan = null;
      try { plan = this._unstartedPlan(id); } catch { /* unreadable log: skip */ }
      if (!plan) continue;
      if (plan.supersededBy) continue;
      plans.push({ id, plan });
    }
    // Owner inputs take the free slots first (they would have jumped the queue), then oldest first.
    plans.sort((a, b) => (b.plan.owner ? 1 : 0) - (a.plan.owner ? 1 : 0) || a.plan.ts - b.plan.ts);
    for (const { id, plan } of plans) {
      const job = { id, spec: plan.spec, family: providerFamily(plan.spec.provider), needsTurn: true, kind: 'send', owner: plan.owner, text: plan.text, images: [], run: () => this._deliverJob(job) };
      this._admit(job);
    }
    return plans.map((p) => p.id);
  }

  // Brings a parked or lost agent back in place (same id, same log), sending nothing but a cut turn's continue. False if it can't be resumed.
  // A resume needs no turn slot, only a live-process slot; it may queue like a send.
  // A queued job for it (recoverQueued's, a continue, a send) already brings it back: a second resume adds nothing.
  // A turn the previous runner cut continues (idea-126). Otherwise, for an adapter with lazyResume (claude, idea-122), there is
  // nothing to start: it is marked parked and the next send resumes the session.
  resume(id) {
    if (this.live.has(id) || this.queue.some((j) => j.id === id)) return true;
    const parked = this._parkedSpec(id);
    const spec = parked ?? this._lostSpec(id);
    if (!spec) return false;
    if (!parked && this._cutTurn(id, spec.meta)) {
      // The cut turn is closed first (tagged: never a completed turn on the server): the inputs before it were delivered, so
      // a runner restart while the continue sits queued replays only what comes after it (recoverQueued's cut).
      this.store.append(id, 'status', { status: 'lost', resume: true, reason: 'turn cut by a runner restart; continuing' });
      this.store.append(id, 'input', { text: CONTINUE_PROMPT, resume: true });
      this._admit(this._continueJob(id, spec, CONTINUE_PROMPT));
      return true;
    }
    if (this.adapters[spec.provider]?.lazyResume) {
      if (!parked) {
        this.store.append(id, 'parked', { sessionId: spec.resume, systemPrompt: spec.systemPrompt ?? null });
        this.store.append(id, 'status', { status: 'parked', resume: true });
      }
      return true;
    }
    this._admit({ id, spec, family: providerFamily(spec.provider), needsTurn: false, run: () => { const e = this._resume(id, spec, { promptless: true }); if (e) this._settleResume(id, e); } });
    return true;
  }

  // A send job carrying a cut turn's continue. Its entry keeps the job, so an unwedge retry of a continue stuck in its resume
  // handshake re-delivers the same text (a send coalesced into it included) instead of dropping it.
  _continueJob(id, spec, text, owner = false) {
    const job = {
      id, spec, family: providerFamily(spec.provider), needsTurn: true, kind: 'send', owner, text, images: [],
      run: () => { this._deliverJob(job); const e = this.live.get(id); if (e) e.continueJob = job; },
    };
    return job;
  }

  // Whether the log says a turn was open when the previous runner went away: its last status is `running`, or an untagged
  // `starting` (a send's resume had taken the turn slot). Never for an agent that may no longer act (retired, superseded) or
  // a turn older than queueMaxAgeMs (an old turn must not start again on a whim; same bound as recoverQueued).
  _cutTurn(id, meta) {
    let last = null;
    for (const e of this.store.read(id)) if (e.type === 'status') last = e;
    if (!last || !(last.status === 'running' || (last.status === 'starting' && last.resume !== true))) return false;
    if (this.queueMaxAgeMs > 0 && Date.now() - (last.ts ?? 0) > this.queueMaxAgeMs) return false;
    return !isRetiredMeta(meta) && !this._successorOf(id, meta);
  }

  // A resume sends nothing, so no adapter ever reports a turn: the agent would read `starting` forever and, never idle, would
  // never park (idea-109). Once the adapter is ready (ACP: its session handshake resolved; claude: survived its settle window)
  // it is idle, as after a turn, and the normal after-turn park takes over. Its `starting` and `idle` carry `resume: true`:
  // process lifecycle, not a turn, so the server never reads them as a completed turn (no digest, no takeover confirm).
  // A send that arrived meanwhile owns the status instead: delivered (a turn is open) or queued behind a turn cap (its
  // `queued` must stay the log's last status, or a runner restart would drop the prompt and the park would kill the agent).
  _settleResume(id, entry) {
    Promise.resolve(entry.handle?.ready).then(() => {
      if (this.live.get(id) !== entry || entry.parked || entry.status !== 'starting' || entry.inflight > 0) return; // shutdown clears live
      if (this.queue.some((j) => j.id === id)) return; // a queued send: its job delivers into this live process when it runs
      entry.status = 'idle';
      entry.lastActive = Date.now();
      this.store.append(id, 'status', { status: 'idle', resume: true });
      this._scheduleParkAfterTurn(id, entry);
      this._pump();
    }, () => {}); // a failed handshake ends the process: its onExit logs that
  }

  // A resume stuck in `starting` (its handshake never finished): stops that child. retry: resume it again at once (the log
  // is left as is). Otherwise log why plus a terminal `lost` status, so every reader (vs who, the server's roster/turn state)
  // shows it closed+lost (still resumable by a send) instead of "initializing" with a live slot. Anything not stuck (a turn
  // open, already idle, not live) is left alone, except a continue (idea-126) whose handshake hangs: its turn is open but
  // never ran, so the retry re-delivers the same job and the failure closes it like any stuck resume.
  unwedge(id, { retry = false, reason = '' } = {}) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    const e = this.live.get(id);
    const cont = e?.continueJob ?? null;
    if (!e || e.status !== 'starting' || (e.inflight > 0 && !cont)) return { action: 'not-wedged', status: this.status(id)?.status ?? null };
    e.parked = true; // onExit / late emits log nothing for this child
    clearTimeout(e.parkTimer);
    this._clearArchive(e);
    this._releaseOverCap(e, e.ownerOverCap ?? 0);
    this.live.delete(id);
    try { e.handle?.kill(); } catch { /* already gone */ }
    if (retry && cont) { this._admit(this._continueJob(id, cont.spec, cont.text, cont.owner === true)); this._pump(); return { action: 'retried' }; }
    if (retry && this.resume(id)) { this._pump(); return { action: 'retried' }; }
    const message = `resume did not finish starting${reason ? `: ${reason}` : ''}`;
    this.store.append(id, 'error', { message });
    this.store.append(id, 'status', { status: 'lost', resume: true, reason: message });
    this._pump();
    return { action: 'failed', status: this.status(id)?.status ?? null };
  }

  // Idle agents a restart would cut background work under: held parks, AND every parkable idle agent whose after-turn probe
  // has not yet come back clean. Right after a turn ends the park grace + the first probe take seconds with heldSince still
  // null, and a suite started with run_in_background is already running then. Only a probe that saw nothing clears it.
  heldIds() {
    const ids = [];
    for (const [id, e] of this.live) {
      if (e.heldSince !== null && e.heldSince !== undefined) ids.push(id);
      else if (this._parkable(e) && this._mayHoldWork(e) && e.work?.length !== 0) ids.push(id);
    }
    return ids;
  }

  // Starts the parked/lost agent's process in place. Callers have checked the room (_fits); false if there is no spec.
  // promptless: a bare resume (no send behind it), whose `starting` is tagged `resume: true` (see _settleResume).
  _resume(id, fallbackSpec = null, { promptless = false } = {}) {
    const spec = this._parkedSpec(id) ?? this._lostSpec(id) ?? this._unstartedPlan(id)?.spec ?? fallbackSpec; // fresh from the log: picks up a config change made while the job waited
    if (!spec) return null;
    if (!this._makeRoom(id)) throw new Error('no live process slot free');
    this.store.append(id, 'status', { status: 'starting', ...(promptless ? { resume: true } : {}) });
    return this._start(id, spec);
  }

  // Hands a prompt to a live agent: from now it holds a turn slot until its turn's idle.
  _deliver(entry, text, images = []) {
    if (!entry?.handle) throw new Error('agent is not running');
    clearTimeout(entry.parkTimer);
    // inflight counts OPEN TURNS (one per agent at a time), not prompts. A fresh turn takes its slot here — and marks
    // itself active — immediately, without waiting for the adapter's (possibly async, e.g. ACP ready.then) 'running'.
    const fresh = entry.inflight === 0;
    if (fresh) {
      entry.inflight = 1;
      entry.lastEvent = Date.now();
      entry.quiet = false;
      this._turnStarted(entry);
    }
    try { entry.handle.send(text, images.length ? { images } : undefined); } catch (err) { if (fresh) entry.inflight = 0; throw err; }
  }

  // opts.images: [{ data (base64), mimeType }]; opts.activeTurnBehavior: 'steer' (default, queue behind/into the turn)
  // or 'interrupt' (cancel the active turn first). opts.owner marks a human (UI / `vs send`) turn: it jumps the family
  // queue and may run over the turn cap (see _fits). opts.senderId: the verified agent that sent it (logged on the input
  // event; the HTTP layer sets it from the caller, never from the body). The log keeps the image count, never the base64 payload.
  // Returns { queued, ahead? }: over the family's turn cap the prompt is logged now and delivered FIFO when a slot frees.
  send(id, text, opts = {}) {
    const senderId = typeof opts.senderId === 'string' && opts.senderId ? { senderId: opts.senderId } : {};
    let live = this.live.get(id);
    if (live?.configStale && live.inflight === 0 && this._parkableNow(live)) { this.park(id); live = undefined; } // new model/mode/thinking: the next turn runs in a fresh process (one with background work keeps serving: never killed for a config change)
    // A lost agent (its process died in a runner restart) resumes in place on the next send, same id + session.
    // Coalesce into a job still waiting in this process's queue first (a queued create or send): one entry, one turn.
    const queued = this.queue.find((j) => j.id === id && (j.kind === 'send' || j.kind === 'create'));
    let spec = null;
    let pending = null; // inputs queued before a runner restart that this send must carry along (they never ran)
    if (!live && !queued) {
      pending = this._unstartedPlan(id); // checked even when the agent has a session: those inputs are not in the session yet
      if (pending?.supersededBy) throw new Error(`agent ${id} is superseded by ${pending.supersededBy}; send to the successor`);
      spec = this._parkedSpec(id) ?? this._lostSpec(id) ?? pending?.spec ?? null;
    }
    if (!live?.handle && !spec && !queued) throw new Error(`agent ${id} is not running`);
    const images = (Array.isArray(opts.images) ? opts.images : []).filter((i) => i && typeof i.data === 'string' && typeof i.mimeType === 'string');
    if (opts.activeTurnBehavior === 'interrupt' && live?.status === 'running') this.cancel(id);
    const owner = opts.owner === true;
    const family = live?.family ?? queued?.family ?? providerFamily(spec.provider);

    // Texts join in order with a blank line, images append, and the owner flag is the OR (an owner line makes the merged job owner).
    if (queued) {
      this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}), ...(owner ? { owner: true } : {}), ...senderId });
      queued.text = queued.text ? `${queued.text}\n\n${text}` : text;
      queued.needsTurn = true; // a create without a prompt now has one
      queued.images = [...(queued.images ?? []), ...images];
      if (owner && !queued.owner) {
        queued.owner = true;
        this._reinsertOwner(queued); // move it ahead of non-owner jobs of its family
        this._pump(); // as an owner job it may now start over the cap
      }
      return this.queuePosition(id);
    }

    this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}), ...(owner ? { owner: true } : {}), ...senderId });
    const job = {
      id, spec, family, needsTurn: true, kind: 'send', owner: owner || pending?.owner === true, text: pending ? `${pending.text}\n\n${text}` : text, images,
      run: () => this._deliverJob(job),
    };
    if (live?.inflight > 0 && !this.queue.some((j) => j.id === id)) job.run(); // steering a running turn: it already holds its slot
    else this._admit(job);
    return this.queuePosition(id);
  }

  // Starts (or resumes) the job's agent and delivers its text, marking an owner job that begins a fresh turn over the
  // family cap as an over-cap owner turn (tracked for the +OWNER_OVER_CAP budget).
  _deliverJob(job) {
    const entry = this.live.get(job.id) ?? this._resume(job.id, job.spec);
    this._noteOwnerOverCap(job, entry);
    this._deliver(entry, job.text, job.images ?? []);
  }

  // An owner job that begins a fresh turn over the family cap is tracked against the +OWNER_OVER_CAP budget until that turn ends.
  _noteOwnerOverCap(job, entry) {
    if (job.owner && entry && !(entry.inflight > 0) && this._running(job.family) >= (this.turnCaps[job.family] ?? this.turnCaps.other)) {
      entry.ownerOverCap = (entry.ownerOverCap ?? 0) + 1;
      this.overCapOwner.set(job.family, (this.overCapOwner.get(job.family) ?? 0) + 1);
    }
  }

  // Moves a queued job (that just became owner via coalesce) to the owner segment of its family's queue.
  _reinsertOwner(job) {
    const idx = this.queue.indexOf(job);
    if (idx === -1) return;
    this.queue.splice(idx, 1);
    this._enqueue(job);
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

  // Live model / mode / thinking change. The process is per turn, so this is a meta patch the next process start reads;
  // a turn that is running keeps the settings it started with. Returns { appliesFrom: 'next-turn', busy }.
  // Unsupported values for the agent's provider are rejected (never silently ignored).
  setConfig(id, { model, modeId, thinkingOptionId } = {}) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    const f = this._fold(id);
    const provider = f.created.provider;
    const patch = configPatch(PROVIDER_ALIASES[provider] ?? provider, { model, modeId, thinkingOptionId });
    // An ACP agent that has told us what it offers: anything else is refused here (HTTP 400), not skipped at the next start.
    const offered = f.offered;
    if (offered && patch.acpMode !== undefined && offered.modes.length && !offered.modes.includes(patch.acpMode)) throw new Error(`${provider}: mode "${patch.acpMode}" is not offered (one of ${offered.modes.join(', ')})`);
    if (offered && patch.model !== undefined && offered.models.length && pickModel(patch.model, offered.models.map((m) => ({ modelId: m }))) === null && (PROVIDER_ALIASES[provider] ?? provider) !== 'codex') throw new Error(`${provider}: model "${patch.model}" is not offered (one of ${offered.models.join(', ')})`);
    if (!Object.keys(patch).length) throw new Error('nothing to change');
    this.store.append(id, 'meta', { patch });
    const e = this.live.get(id);
    let busy = false;
    if (e?.handle) {
      e.configStale = true;
      busy = e.inflight > 0 || e.status === 'running';
      if (!busy && this._parkableNow(e)) { this.park(id); this._pump(); } // idle process (park grace window): drop it so the next send resumes with the new args
      else if (!busy && this._parkable(e)) this._scheduleParkAfterTurn(id, e); // may have background work: the held park runs now (configStale: no grace)
    }
    return { appliesFrom: 'next-turn', busy };
  }

  // Archive keeps the agent revivable (unarchive + send): an idle parkable agent is parked first, a running one gets a
  // cancel and parks as soon as its turn ends. kill() (which logs an exit) is only for agents that can't park.
  archive(id) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    this.queue = this.queue.filter((j) => j.id !== id); // an archived agent's waiting prompts are dropped
    this._announceQueue();
    const e = this.live.get(id);
    if (e?.handle) {
      if (e.inflight === 0) this._stopKeepingSession(id, e); // idle or starting, no turn open: nothing to wait for
      else {
        e.archiveWhenIdle = true;
        try { this.cancel(id); } catch { /* already ending */ }
        e.archiveTimer = setTimeout(() => { if (this.live.get(id) === e) this._stopKeepingSession(id, e); this._pump(); }, this.archiveKillMs); // hung or ignoring cancel
        e.archiveTimer.unref?.();
      }
    }
    this.store.append(id, 'archive', {});
    for (const a of new Set(Object.values(this.adapters))) a.cleanup?.(id); // drop per-agent prompt file; a resume rewrites it
    this._pump();
  }

  // Undoes archive (an agent archived by mistake): the log keeps the archive event, `unarchive` supersedes it. Never resumes anything.
  unarchive(id) {
    if (!this.store.exists(id)) throw new Error(`no such agent ${id}`);
    this._clearArchive(this.live.get(id));
    this.store.append(id, 'unarchive', {});
  }

  // Reads only this agent's log (lazy: no other file is touched).
  status(id) {
    const f = this._fold(id);
    if (!f) return null;
    let status = f.status;
    if (f.exit) status = 'exited';
    else if (!this.live.has(id) && status !== 'parked' && !this.queue.some((j) => j.id === id)) status = 'lost'; // log says running but no child in this process
    const { queued, ...rec } = f.rec;
    return { ...rec, ...(status === 'queued' && queued ? { queued } : {}), status, resumable: this._resumable(f), pendingPermissions: [...f.perms.values()] };
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

  // Same result as statusAll(), but yields to the event loop whenever a slice has run for sliceMs, so a cold roster
  // scan (every log folded from byte 0) never blocks POST /agents, input, SSE or health behind it. Concurrent callers
  // share one in-flight scan. Returns { ids, agents }: ids is re-read after the scan and any agent created mid-scan is
  // folded in, so the two can't diverge.
  statusAllAsync(sliceMs = 8) {
    if (this._scan) return this._scan;
    this._scan = (async () => {
      const agents = [];
      const seen = new Set();
      let t0 = Date.now();
      const visit = (id) => {
        seen.add(id);
        let s = null;
        try { s = this.status(id); } catch { /* unreadable log: left out, like a failed per-id GET */ }
        if (s) agents.push(s);
      };
      for (const id of this.store.ids()) {
        visit(id);
        if (Date.now() - t0 >= sliceMs) { await new Promise((r) => setImmediate(r)); t0 = Date.now(); }
      }
      const ids = this.store.ids();
      for (const id of ids) if (!seen.has(id)) visit(id); // created during the scan (cheap: new logs are tiny)
      return { ids, agents };
    })().finally(() => { this._scan = null; });
    return this._scan;
  }

  // Incremental: the folded state keeps the byte offset it has consumed, so a changed log only folds its new tail.
  _fold(id) {
    let stamp = null;
    let size = 0;
    try { const st = statSync(this.store.file(id)); size = st.size; stamp = `${st.size}:${st.mtimeMs}`; } catch { this.folds.delete(id); return null; }
    let st = this.folds.get(id);
    if (st?.stamp === stamp) return st;
    if (!st || size < st.offset) st = { created: null, last: null, status: 'unknown', usage: null, perms: new Map(), meta: null, archivedAt: null, exit: null, offset: 0 };
    const { events, end } = this.store.readFrom(id, st.offset);
    for (const e of events) {
      if (!st.created) { st.created = e; st.meta = { ...e.meta }; }
      st.last = e;
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
    st.offset = end;
    st.stamp = stamp;
    if (!st.created) { this.folds.delete(id); return null; }
    this.folds.set(id, st);
    st.rec = { id, provider: st.created.provider, model: st.meta.model ?? st.created.model, cwd: st.created.cwd, meta: { ...st.meta }, usage: st.usage, lastSeq: st.last.seq, createdAt: st.created.ts, updatedAt: st.last.ts, ...(st.offered ? { offered: st.offered } : {}), archivedAt: st.archivedAt, exit: st.exit, ...(st.status === 'queued' ? { queued: { ahead: st.ahead ?? 0 } } : {}) };
    return st;
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }

  list() { return this.store.ids(); } // names only; use status(id) for details

  // Marks every live agent as exited by the runner, then kills its process tree. Idempotent.
  // keepResumable (the restart script's POST /shutdown): NO exit event, so the next runner can resume every agent. An idle agent
  // with a session is parked (logged); a mid-turn/starting one is stopped with entry.parked=true and its log left as-is, so it
  // reads "lost" afterwards and POST /agents/:id/resume brings it back from its last session id.
  shutdown({ keepResumable = false } = {}) {
    if (this._shutDown) return;
    this._shutDown = true;
    this._pollAgy?.shutdown();
    clearInterval(this._quietSweep);
    const waiting = new Set(this.queue.map((j) => j.id)); // agents with a queued, unstarted input: their log must keep ending in `queued` so the next boot re-enqueues them
    this.queue.length = 0;
    for (const e of this.live.values()) { clearTimeout(e.parkTimer); this._clearArchive(e); }
    for (const id of [...this.live.keys()]) {
      if (waiting.has(id)) { const e = this.live.get(id); if (e) e.parked = true; this.kill(id); continue; } // parked flag: onExit logs nothing
      if (keepResumable) {
        const e = this.live.get(id);
        if (e) e.parked = true; // onExit/emit log nothing, even for a child still starting
        if (e?.handle) {
          if (e.status === 'idle' && e.sessionId && this.adapters[e.provider]?.canPark) {
            this.store.append(id, 'parked', { sessionId: e.sessionId, systemPrompt: e.systemPrompt ?? null });
            this.store.append(id, 'status', { status: 'parked' });
          }
          try { e.handle.kill(); } catch { /* best effort */ }
        }
        continue;
      }
      try { this.store.append(id, 'exit', { code: null, reason: 'runner-shutdown' }); } catch { /* best effort */ }
      this.kill(id);
    }
    this.live.clear();
  }
}

function queueMaxAgeFromEnv(env = process.env) {
  const raw = env.VS_RUNNER_QUEUE_MAX_AGE_MS;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : 24 * 60 * 60 * 1000;
}

// Same rule as server/identity.mjs isRetiredRole (former-*, old-lead, retired, old), applied to a log's folded meta (role + labels.role).
function roleOf(meta) { return String(meta?.role ?? meta?.labels?.role ?? '').trim().toLowerCase(); }
function roleFamily(meta) { return roleOf(meta).replace(/^former-/, ''); }
function isRetiredMeta(meta) {
  return [meta?.role, meta?.labels?.role].some((r) => { const v = String(r ?? '').trim().toLowerCase(); return v.startsWith('former-') || v === 'old-lead' || v === 'retired' || v === 'old'; });
}

const effModel = (created, meta) => meta?.model ?? created.model ?? undefined;

// Validates a live config change against what the provider's CLI can actually take at process start.
// claude: --model, --permission-mode, --effort. ACP agents (antigravity-cli, opencode, codex): session/set_model and
// session/set_mode on (re)start; ACP has no thinking/effort knob, so a thinking value is refused.
export { CLAUDE_PERMISSION_MODES, CLAUDE_EFFORTS };
export function configPatch(provider, { model, modeId, thinkingOptionId } = {}) {
  const patch = {};
  const bad = (what, v) => new Error(`${provider}: unsupported ${what} "${v}"`);
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim() || model.startsWith('-')) throw bad('model', model);
    patch.model = model.trim();
  }
  if (modeId !== undefined) {
    if (typeof modeId !== 'string' || !modeId || modeId.startsWith('-')) throw bad('mode', modeId);
    if (provider === 'claude') {
      if (!CLAUDE_PERMISSION_MODES.includes(modeId)) throw new Error(`claude: unsupported mode "${modeId}" (one of ${CLAUDE_PERMISSION_MODES.join(', ')})`);
      patch.permissionMode = modeId;
    } else patch.acpMode = modeId;
  }
  if (thinkingOptionId !== undefined) {
    if (provider === 'claude') {
      if (thinkingOptionId !== null && !CLAUDE_EFFORTS.includes(thinkingOptionId)) throw new Error(`claude: unsupported thinking "${thinkingOptionId}" (one of ${CLAUDE_EFFORTS.join(', ')})`);
      patch.thinkingOptionId = thinkingOptionId;
    } else if (thinkingOptionId === null) patch.thinkingOptionId = null;
    else throw new Error(`${provider}: thinking level is not supported by this provider`);
  }
  return patch;
}

function pickMeta(meta) {
  const out = {};
  for (const k of META_FIELDS) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}
