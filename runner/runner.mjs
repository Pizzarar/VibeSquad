// Agent supervisor: one child per agent, one JSONL log per agent, no pollers.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { stat as fspStat } from 'node:fs/promises';
import { createClaudeAdapter, CLAUDE_PERMISSION_MODES, CLAUDE_EFFORTS } from './adapters/claude.mjs';
import { createAcpAdapter, acpProviderIds, PROVIDER_ALIASES, pickModel } from './adapters/acp.mjs';
import { LogStore } from './log.mjs';
import { LimitStore, createAgyUsagePoller } from './limits.mjs';
import { createBackgroundProbe, shellCmdTail } from './background.mjs';
import { killPidTree } from './spawn.mjs';
import { sha256 } from './reap.mjs';
import { readDetachedLedger, writeDetachedLedger } from './detached.mjs';
import { pidAlive as defaultPidAlive } from './lock.mjs';
import { oldestOpenTool } from './open-tools.mjs';
import { foldEvent, newFold, probe, probeWith, racy, RACY_MS, readFoldIndexInfo, saveFold, seedFromEntry, serializeFoldIndex, writeFoldIndex } from './fold-index.mjs';
import { COLD_FOLD_MIN, coldFoldEntries, coldFoldWorkersFromEnv } from './fold-cold.mjs';
import path from 'node:path';

// squad/team/lane/role/ord/profile are plain meta fields, first-class on the agent record.
const META_FIELDS = ['squad', 'team', 'lane', 'role', 'ord', 'profile', 'title', 'permissionMode', 'acpMode', 'thinkingOptionId', 'featureValues', 'labels', 'model'];

// Child/provider noise that is not turn progress: it must not refresh `lastEvent` or clear `quiet` (only assistant
// output, tool activity, status and the like count as a turn still making progress).
const NON_PROGRESS_EVENTS = new Set(['stderr', 'raw', 'limit', 'steer_dropped']);

// Seqs of steer-only inputs that were dropped (idea-169/214). A `steer_dropped` names its input (`input`: the input's seq);
// one logged before that field existed falls back to position: an adapter drop at turn end ('turn-ended') takes the oldest
// steer since the last real input (ACP drops its queue in order), a runner-side drop the newest (it follows its own input).
// A real input clears the pending steers: anything queued ahead of it rode along with it.
export function droppedSteerSeqs(events) {
  const dropped = new Set();
  let pending = [];
  for (const e of events) {
    if (e.type === 'input') { if (e.steerOnly) pending.push(e.seq); else pending = []; }
    else if (e.type === 'steer_dropped') {
      const seq = Number.isInteger(e.input) ? e.input : e.reason === 'turn-ended' ? pending[0] : pending.at(-1);
      if (seq === undefined) continue;
      dropped.add(seq);
      pending = pending.filter((s) => s !== seq);
    }
  }
  return dropped;
}

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
  delete env.VS_PLUGIN_LOG; // a polluted parent must not make an agent's own plugin log to stderr
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
// idea-629: `schedule` / `scheduleName` mark a schedule-spawned agent (server/schedules.mjs execute); only the VS server sets them.
export const PROTECTED_LABEL_KEYS = ['role', 'lane', 'team', 'squad', 'ord', 'profile', 'lead', 'digestFor', 'orphan', 'topic', 'vs.parent', 'paseo.parent-agent-id', 'vs.auto-archived', 'schedule', 'scheduleName'];
const isHandoffKey = (k) => k.startsWith('vs.handoff') || k.startsWith('handoff-');
const isProtectedLabel = (k) => PROTECTED_LABEL_KEYS.includes(k) || isHandoffKey(k);
// Labels an agent spawn may never pass: ownership, ordinal, digest and handoff markers are stamped by the runner / the VS server.
const STRIPPED_SPAWN_LABELS = new Set(['ord', 'digestFor', 'vs.auto-archived', 'vs.parent', 'paseo.parent-agent-id', 'lead', 'orphan', 'schedule', 'scheduleName']);

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

/**
 * idea-629: the schedule id of a schedule-spawned agent, or null. Trusted because `schedule` is a protected label: an agent
 * spawn has it stripped (STRIPPED_SPAWN_LABELS) and an agent meta patch setting it is a 403 (protectedMetaIn), so only the
 * VS server's admin spawn (server/schedules.mjs execute) or the owner can put it on a record. Never read from the env.
 */
export function scheduleOf(meta = {}) {
  const v = String(meta?.labels?.schedule ?? '').trim();
  return /^sch-[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null; // server/schedules.mjs ID_RE
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
 *   input: any agent of the caller's Squad; the Overlord also reaches another Squad's live leads (crossSquadInput).
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
    case 'input': return sameSquad || crossSquadInput(caller, target);
    case 'stop-background':
      // idea-474: a lead takes over its lane's leftovers. Its retired predecessor lead (former-lead / old-lead, same Squad AND
      // same lane) still holds the background shells it started, and nobody else in the lane could stop them. The predecessor's
      // workers are lane workers, which 'cancel' below already covers. A live lead, a Buddy, another lane or Squad: as cancel.
      if (isLead && sameSquad && !!caller.lane && t.lane === caller.lane && !self && isRetiredLeadMeta(target.meta)) return true;
      // falls through: otherwise exactly the cancel scope
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
 * The one cross-Squad grant: a Squad's Overlord may send input to a live lead of another Squad (that Squad's Overlord or
 * a lane lead), so Overlords coordinate without the owner relaying. Never a worker or Buddy, never an exited, archived,
 * retired or orphan lead, and never anything but input (cancel/archive/config/meta stay same-Squad). The runner logs
 * every use in the sender's team log. Pure, like agentMay.
 */
export function crossSquadInput(caller, target) {
  if (caller?.overlord !== true || !caller.team || !target?.meta) return false;
  const t = identityOf(target.meta);
  if (!t.team || t.team === caller.team || t.role !== 'lead') return false;
  if (target.status === 'exited' || target.exit || target.archivedAt || isRetiredMeta(target.meta)) return false;
  const orphan = String(t.labels.orphan ?? '').trim().toLowerCase();
  return orphan !== '1' && orphan !== 'true';
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
// waiting behind the worker backlog. The count is released as each over-cap owner turn ends. idea-896: the same number is the
// owner allowance over maxLive (extra live processes, machine-wide; see _makeRoom).
export const OWNER_OVER_CAP = 2;
// idea-203: a worker digest (DIGEST_PROFILE + labels.digestFor, both protected meta an agent caller can't set) is a short
// read-and-log turn the lead's verdict waits on. It is admitted ahead of non-owner, non-digest jobs, and over its family's
// cap it may start within this many extra digest turns per family (a reserve separate from OWNER_OVER_CAP), so a digest
// never waits behind a long worker backlog. 0 keeps the priority ordering but no reserve. Released as each such turn ends.
export const DEFAULT_DIGEST_RESERVE = 1;
export function digestReserveFromEnv(env = process.env) {
  const raw = env.VS_RUNNER_DIGEST_RESERVE;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DIGEST_RESERVE;
}
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
// see background.mjs), re-checked every poll (unless a restart drain refuses a new hold: see Runner.setDrain), and forced (logged as park-forced, with what was killed) past the max hold
// so a held agent cannot keep its live slot forever. A max hold of 0 turns the hold off (park kills the tree at once).
// idea-312: the max hold is a hard ceiling, not the slot policy. At 60 min it force-parked EFI Godot suites (66 min, run with
// --timeout 7000) that nothing needed the slot from, silently: the CLI died with the work and nobody woke the agent. Holding
// costs nothing while the live cap has room, so the hard ceiling is 4 h (past any suite's own timeout) and the yield age below
// is what frees a slot for the queue.
export const DEFAULT_PARK_HOLD_MAX_MS = 4 * 60 * 60 * 1000;
// idea-146: a hold older than this gives its live slot up when the queue needs one (Runner._makeRoom: idle agents first, then
// the oldest such hold; park-forced reason 'room'). Younger holds, and any hold while the live cap has room, keep running.
export const DEFAULT_PARK_HOLD_YIELD_MS = 60 * 60 * 1000;
export function parkHoldYieldFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_HOLD_YIELD_MS);
  return env.VS_RUNNER_PARK_HOLD_YIELD_MS !== undefined && env.VS_RUNNER_PARK_HOLD_YIELD_MS !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_PARK_HOLD_YIELD_MS;
}
// A restart drain's TTL ceiling: `vs restart` asks for its wait timeout + stop timeout + a margin.
export const DRAIN_TTL_MAX_MS = 2 * 60 * 60 * 1000;
const REQUEST_DRAIN_ID_RE = /^rr-[\w-]{1,60}$/;
function drainTtl(ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isInteger(ttl) || ttl < 1000 || ttl > DRAIN_TTL_MAX_MS) throw Object.assign(new Error(`ttlMs must be an integer from 1000 to ${DRAIN_TTL_MAX_MS}`), { status: 400 });
  return ttl;
}
// What an agent whose new background work a drain refused reads at the start of its next input.
export function drainNoticeText(drain, work) {
  const cmds = work.map((w) => String(w.cmd ?? w.name ?? '').trim().slice(-120)).filter(Boolean).join('; ');
  if (drain?.detached) { // idea-697: it left the shell at once (nohup / & / setsid), so no hold ever saw it; refused by the drain scan
    const why = drain.kind === 'request' ? `a restart drain was open (${drain.reason || `restart request ${drain.request?.id ?? ''}`.trim()})` : `the runtime was draining for a restart (${drain.reason || 'vs restart'})`;
    return `[VibeSquad runtime] Detached background work you started (${cmds || 'a shell'}: nohup / & / setsid) was stopped: ${why}, which refuses new background work, detached or not. Run it in the foreground (no &, no nohup) only if it is short; otherwise rerun it after restart-done.`;
  }
  if (drain?.kind === 'request') { // idea-476: a restart request is (or was) open; a background rerun is refused until restart-done
    return `[VibeSquad runtime] Background work you started (${cmds || 'a shell'}) was stopped when your turn ended: a restart drain was open (${drain.reason || `restart request ${drain.request?.id ?? ''}`.trim()}), which refuses new background work. If it is still needed, run it in the foreground, or rerun it in the background after restart-done.`;
  }
  return `[VibeSquad runtime] Background work you started (${cmds || 'a shell'}) was stopped when your turn ended: the runtime was draining for a restart (${drain.reason || 'vs restart'}), which refuses new background work. Rerun it now if it is still needed.`;
}
// idea-230: what an agent reads at the start of its next input after someone stopped its background work (vs stop --background).
export function bgStopNoticeText(work) {
  const cmds = work.map((w) => String(w.cmd ?? w.name ?? '').trim().slice(-120)).filter(Boolean).join('; ');
  return `[VibeSquad runtime] Background work you started (${cmds || 'a shell'}) was stopped on purpose (vs stop --background, e.g. to free the runtime for a restart); it did not finish and has no output to read. Rerun it only if it is still needed.`;
}
// idea-112: what a held agent reads when the background work it ended its turn on has exited and nothing woke it (ACP has
// no agent-initiated turn; a Claude CLI that self-started one never reaches this). The work runs `2>&1 | tail`-style, so
// the agent is told to read its output, not to rerun it.
export function bgWakeText(work) {
  const cmds = work.map((w) => String(w.cmd ?? w.name ?? '').trim().slice(-120)).filter(Boolean).join('; ');
  return `[VibeSquad runtime] Background work you started before your turn ended (${cmds || 'a shell'}) has finished. Read its output (task output / log file; do not rerun it unless the output is gone) and continue your task. If you were waiting on it to finish your work, report your result now.`;
}
// idea-312: what a held agent reads after a forced park stopped the background work it ended its turn on ('room': the live
// cap needed its slot past the yield age; 'max': the hard max hold). The tree kill may miss detached children, so the work
// may or may not have finished: the agent checks its output before rerunning, and reruns in the foreground (a live turn is
// never parked).
export function bgForcedText(work, heldMs, reason) {
  const cmds = work.map((w) => String(w.cmd ?? w.name ?? '').trim().slice(-120)).filter(Boolean).join('; ');
  const mins = Math.max(1, Math.round((Number(heldMs) || 0) / 60_000));
  const why = reason === 'room' ? 'the runtime needed its live slot for queued agents' : "it reached the runtime's max hold";
  return `[VibeSquad runtime] Background work you started before your turn ended (${cmds || 'a shell'}) was still running after ${mins} min and was stopped (${why}). It may not have finished: check its output or log first. If it is incomplete, rerun it in the FOREGROUND with a timeout (a running turn is never stopped), then continue your task and report.`;
}
export function parkHoldMaxFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_HOLD_MAX_MS);
  return env.VS_RUNNER_PARK_HOLD_MAX_MS !== undefined && env.VS_RUNNER_PARK_HOLD_MAX_MS !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_PARK_HOLD_MAX_MS;
}
export const DEFAULT_PARK_HOLD_POLL_MS = 15_000;
export function parkHoldPollFromEnv(env = process.env) {
  const n = Number(env.VS_RUNNER_PARK_HOLD_POLL_MS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_PARK_HOLD_POLL_MS;
}
// Held-park back-off (cpu-profile-1114 fix 1): each snapshot is a whole process-table query (Windows: a powershell CIM
// spawn). A hold snapshots every parkHoldPollMs for its first parkHoldSlowAfterMs, then every parkHoldSlowPollMs (default
// 4 x poll = 60 s); the poll ticks between are a pid liveness check only (Runner._heldTickCheap).
export const DEFAULT_PARK_HOLD_SLOW_AFTER_MS = 60_000;
// An archived agent that is mid-turn gets a cancel; if it has not stopped by then it is killed (session kept).
export const DEFAULT_ARCHIVE_KILL_MS = 10_000;
// Shutdown fold-index save budget (saveFoldIndexSync): logs still unprobed after this are left out of the index.
export const SHUTDOWN_SAVE_BUDGET_MS = 3000;
const RESAVE_ROUNDS = 3;
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
// A worker digest by its (protected) meta: the same test verifyAgent uses for the digest caller shape.
export function isDigestMeta(meta) {
  const { profile, labels } = identityOf(meta ?? {});
  return profile === DIGEST_PROFILE && !!String(labels?.digestFor ?? '').trim();
}
export function providerFamily(provider) {
  const p = PROVIDER_ALIASES[provider] ?? provider;
  if (p === 'claude') return 'claude';
  if (typeof p === 'string' && p.startsWith('gemini')) return 'gemini';
  if (p === 'antigravity-cli') return 'antigravity';
  return 'other';
}

// The status record of a fold state (no liveness: status() adds that).
function foldRecord(id, st) {
  return { id, provider: st.created.provider, model: st.meta.model ?? st.created.model, cwd: st.created.cwd, meta: { ...st.meta }, usage: st.usage, lastSeq: st.lastSeq, createdAt: st.created.ts, updatedAt: st.lastTs, ...(st.offered ? { offered: st.offered } : {}), archivedAt: st.archivedAt, exit: st.exit, ...(st.status === 'queued' ? { queued: { ahead: st.ahead ?? 0 } } : {}), openTool: oldestOpenTool(st.tools) };
}

// How often the roster-watch guard stats the agents dir (idea-594). One async stat per tick, unref'd; see _ensureRosterWatchGuard.
const DEFAULT_ROSTER_WATCH_GUARD_MS = 5000;

export class Runner {
  // limitsFile: where limit-window records go (default: limits.jsonl next to the agents dir, i.e. the runner home).
  // pollAgy: after antigravity-cli turns, poll `agy -p /usage` (ACP carries no quota); only the real server turns it on.
  // hubLane: (team) -> the Squad's hub lane id (its Overlord's lane). Default: the lane whose id is the team id, the
  // registry rule when no lane is flagged hub (server/lane-pure.mjs isHubLane); the real server reads teams.json.
  // drainFile: where the restart drain is mirrored for the claude PreToolUse hook (runner/drain-hook.mjs); the real server
  // passes <runner home>/drain.json. Null (tests): the drain lives in memory only and no hook is installed.
  constructor({ dir, drainFile = null, adapters = defaultAdapters({ promptsDir: path.join(path.dirname(dir), 'prompts'), drainFile }), maxLive = maxLiveFromEnv(), turnCaps = turnCapsFromEnv(), parkGraceMs = parkGraceFromEnv(), archiveKillMs = archiveKillFromEnv(), quietMs = quietFromEnv(), limitsFile = path.join(path.dirname(dir), 'limits.jsonl'), pollAgy = false, agyUsage, queueMaxAgeMs = queueMaxAgeFromEnv(), parkHoldMaxMs = parkHoldMaxFromEnv(), parkHoldYieldMs = parkHoldYieldFromEnv(), parkHoldPollMs = parkHoldPollFromEnv(), parkHoldSlowAfterMs = DEFAULT_PARK_HOLD_SLOW_AFTER_MS, parkHoldSlowPollMs = 4 * parkHoldPollMs, bgProbe, pidAlive, killPid = killPidTree, reaper = null, reapDelayMs = 3000, onReap = null, hubLane = (team) => team, digestReserve = digestReserveFromEnv(), foldIndexFile = null, rosterWatchGuardMs = DEFAULT_ROSTER_WATCH_GUARD_MS, detachedProbe = null, detachedFile = null, detachedScanMs = 15_000, onDetached = null }) {
    this.store = new LogStore(dir);
    this._tokenAt = new Map(); // id -> when its token was minted: nothing older can carry it (the reap's lower bound)
    this.tokensById = new Map(); // id -> per-agent token, memory only (see agentEnv / verifyAgent); minted once per id per runner lifetime
    this.store.secrets = () => this.tokensById.values(); // every append (and SSE tail) is scrubbed of every live token
    this.hubLane = hubLane;
    this.folds = new Map(); // id -> log-derived status (no liveness), valid while the log file's size + mtime are unchanged
    // Roster scans (statusAll*, laneHasLiveLead) skip the per-log stat for ids in _foldClean (idea-233: ~4133 stats a pass).
    // An id is clean only while a watch on the agents dir is up and no change was seen since its fold was stat-validated;
    // every append through this store, a watch event for its file, a nameless event (overflow) or a watch error drops it.
    this.rosterWatchFactory = (dir, onChange) => fsWatch(dir, { persistent: false }, onChange);
    this.rosterWatchStat = (dir) => fspStat(dir, { bigint: true }); // overridable in tests (idea-594); bigint: 64-bit NTFS ino is exact
    this._rosterWatch = null;
    this._rosterWatchFailed = false;
    // idea-594: a cheap unref'd guard that stats the agents dir every rosterWatchGuardMs and closes the watcher when the
    // dir is deleted under it (fs.watch on a removed dir spins libuv in kernel mode on Windows and never fires 'error',
    // idea-571/590) or its identity changed, then reopens it when the dir exists again. A self-rescheduling setTimeout
    // keeps at most one tick in flight, so a stale stat can never act on a dir that was removed meanwhile.
    this._rosterWatchGuard = null; // the guard setTimeout (null when not scheduled); stopped by closeRosterWatch/shutdown
    this._rosterWatchGuardMs = rosterWatchGuardMs;
    this._rosterWatchGuardGen = 0; // bumped on every guard stop; an in-flight tick bails when it changes (H1/M1)
    this._rosterWatchIdentity = null; // `${ino}:${birthtimeNs}` (bigint; ns because ms collides on ino reuse) of the watched dir, captured when the watch opens
    this._rosterWatchReopen = false; // a reopen is pending: the guard closed the watch (missing/replaced dir) and reopens once it returns
    this._foldClean = new Set();
    this.store.onWrite = (id) => this._foldClean.delete(id); // not onAppend: that set is the SSE subscribers
    this.limits = new LimitStore(limitsFile);
    // idea-701: the default poller runs `agy -p /usage` in an isolated HOME, so it needs no busy guard; an injected run (tests) keeps the idea-349 guard.
    this._pollAgy = pollAgy ? createAgyUsagePoller({ store: this.limits, ...(agyUsage ? { run: agyUsage, canRun: () => !this._agyBusy() } : {}) }) : null;
    this.adapters = adapters;
    this.maxLive = maxLive;
    this.turnCaps = { ...DEFAULT_TURN_CAPS, ...turnCaps };
    this.parkGraceMs = parkGraceMs;
    this.parkHoldMaxMs = parkHoldMaxMs;
    this.parkHoldYieldMs = parkHoldYieldMs;
    this.parkHoldPollMs = parkHoldPollMs;
    this.parkHoldSlowAfterMs = parkHoldSlowAfterMs;
    this.parkHoldSlowPollMs = Math.max(parkHoldPollMs, parkHoldSlowPollMs);
    this.bgProbe = bgProbe === undefined ? createBackgroundProbe() : bgProbe; // (pid) -> Promise<[{ pid, name, cmd }]>: background shells under an agent's CLI; null = no hold
    // (pid) -> bool: the held reality check (heldIds). Real pids only: a test that fakes the probe's pids fakes this too, or
    // gets no check (its fake pids are not real processes).
    this.pidAlive = pidAlive !== undefined ? pidAlive : (bgProbe === undefined ? defaultPidAlive : null);
    this.killPid = killPid; // (pid) -> tree kill of one background shell (stopBackground): taskkill /pid <pid> /T /F on Windows
    this.archiveKillMs = archiveKillMs;
    // idea-515 (Z1): (job) -> Promise<{ reaped, skipped, error? }> (runner/reap.mjs createDevServerReaper); null = off (tests,
    // unsupported hosts). Run reapDelayMs after a WORKER's process ends (park, archive stop, exit) so the tree kill has landed;
    // onReap(report) gets what was reaped/skipped (runner.log line + team-log metric in runner/server.mjs).
    this.reaper = reaper;
    this.reapDelayMs = reapDelayMs;
    this.onReap = onReap;
    this.queueMaxAgeMs = queueMaxAgeMs; // recoverQueued ignores inputs queued longer ago than this (0 = no bound)
    this.quietMs = quietMs;
    this._quietSweep = setInterval(() => this._sweepQuiet(), Math.max(25, Math.min(this.quietMs, 1000)));
    this._quietSweep.unref?.(); // never keeps the process alive (tests exit without clearing it)
    this.queue = []; // FIFO of jobs waiting for a turn slot or a live-process slot: { id, family, needsTurn, run, ahead }
    this.live = new Map(); // id -> { handle, status, ... } for agents running in THIS process only
    this.overCapOwner = new Map(); // family -> count of owner turns currently running OVER that family's turn cap (released on turn end)
    this.digestReserve = digestReserve;
    this.overCapDigest = new Map(); // family -> count of digest turns currently running over that family's turn cap (idea-203)
    this.drainFile = drainFile;
    this._drain = null; // { since, until, reason } while a `vs restart` drains (see setDrain); memory only, so a runner start clears it
    this._drainTimer = null;
    this._reqDrain = null; // { id, tip, since, until, reason } while a restart request is open (see setRequestDrain); memory only too
    this._reqDrainTimer = null;
    this._restartGate = null; // idea-870: { until } while the VS server holds the restart gate (POST /restart-gate); new turns queue
    this._restartGateTimer = null;
    this._removeDrainFile(); // a drain file a crashed runner left behind
    // idea-697: detached background work (runner/detached.mjs): work an agent's tool call started that left its CLI's tree at
    // once (`nohup x &`, setsid). detachedProbe null (tests, non-Linux) = off. While a drain is open it is scanned every
    // detachedScanMs: work started after the drain began is refused (killed, the agent told), and what is left is kept in
    // detachedFile (<runner home>/detached.json), which the NEXT runner reaps after its boot grace (reapBootLedger).
    this.detachedProbe = detachedProbe;
    this.detachedFile = detachedFile;
    this.detachedScanMs = detachedScanMs;
    this.onDetached = onDetached; // (report) -> runner.log line + team-log metric (runner/server.mjs detachedReporter)
    this.detached = []; // the last scan's detached work (what the ledger holds)
    this._detachedTimer = null;
    this._detachedScan = null; // the scan in flight (scans never overlap)
    this._detachedSeen = new Set(); // roots already reported (a drain scan reports each root once)
    this._ledgerWritten = false;
    this._bootLedger = detachedProbe ? readDetachedLedger(detachedFile) : []; // the previous lifetime's ledger, read before any scan of ours rewrites it
    this._bootReapTimer = null;
    // Persisted boot fold (runner/fold-index.mjs): the real server passes <runner home>/fold-index.json; null (tests) = none.
    this.foldIndexFile = foldIndexFile;
    this._foldSeed = null; // id -> saved entry, only during recoverQueued's boot pass
    this._foldPins = new Map(); // id -> { offset, headLen, head, tail }: probes of the last loaded/saved entry, reused while the offset holds
    this.foldIndexStats = null; // the boot pass's index counts, for the {boot:...} line
    // Where the boot's fold phase (prefoldCold + recoverQueued) spent its ms (idea-337), for the {boot:...} line's bootFoldMs (and /health): prefold,
    // load (the index read; 0 when prefold handed it over), pass (folding every log: of it, stat, seed = validating a saved
    // entry, read = reading + folding log bytes), tokens (mintBootTokens), plans (the unstarted-turn scan), admit. Floats.
    this.bootFoldMs = null;
    this._prefoldMs = 0;
    this._uncreated = new Map(); // id -> stamp of a log with no created event: folded once per stamp, not on every _fold (idea-340)
    this._passMs = null; // = bootFoldMs during recoverQueued's pass only (_fold adds stat/seed/read to it)
    this._coldSeed = null; // prefoldCold's index read + worker-folded entries, taken by the next _loadFoldIndex
    this._coldAbort = null; // AbortController of an in-flight prefoldCold: shutdown() terminates its workers
    this.refoldSliceBytes = 1 << 20; // a settled racy log is refolded in slices of this size, yielding between them (_refoldSettled)
    this.resaveDelayMs = RACY_MS + 1500; // saveFoldIndex re-runs this long after a save that left racy entries (their logs may settle)
    this._resaveTimer = null;
  }

  // ---- Restart gate (idea-870) ----
  // The VS server's owner/RR1 runner restart checks idle and then hard-kills the runner; a turn starting between the two was
  // cut. runner/server.mjs POST /restart-gate checks idle and closes this gate in one synchronous step: from then on a job
  // that needs a NEW turn queues (_fits), and recoverQueued replays it on the next runner. A turn already open is never
  // touched. TTL-bound (a server that dies before its kill cannot leave the runner gated); DELETE /restart-gate reopens it.
  setRestartGate(ttlMs) {
    const ttl = Math.min(120_000, Math.max(1000, Number(ttlMs) || 30_000));
    this._restartGate = { until: Date.now() + ttl };
    clearTimeout(this._restartGateTimer);
    this._restartGateTimer = setTimeout(() => this.clearRestartGate(), ttl);
    this._restartGateTimer.unref?.();
    return this._restartGate;
  }

  clearRestartGate() {
    const was = this._restartGate !== null;
    clearTimeout(this._restartGateTimer);
    this._restartGateTimer = null;
    this._restartGate = null;
    if (was) this._pump();
    return was;
  }

  // ---- Restart drain (ideas 198 + 186) ----
  // While `vs restart` waits for running:0 + held:0 (scripts/restart-runtime.mjs sets this over the admin-only POST /drain),
  // NEW background work is refused machine-wide: claude agents' run_in_background Bash/PowerShell is blocked in-turn by the
  // drain hook (adapters/claude.mjs, drain-hook.mjs), and for every provider a park hold whose background shells were all
  // started after the drain began is refused at turn end (the agent is parked, the work stopped, and its next input says
  // why). Work that predates the drain keeps holding as before. Expires on its own after ttlMs (a crashed restart cannot
  // leave the runner draining) and never survives a runner start.
  setDrain({ ttlMs, reason = '' } = {}) {
    const ttl = drainTtl(ttlMs);
    const now = Date.now();
    const since = this._restartDrain()?.since ?? now; // a refresh extends the drain; work started since the first set is still new
    this._drain = { since, until: now + ttl, reason: String(reason ?? '').slice(0, 200) };
    clearTimeout(this._drainTimer);
    this._drainTimer = setTimeout(() => this.clearDrain(), ttl);
    this._drainTimer.unref?.();
    this._writeDrainFile();
    this._armDetachedScan();
    return this.drainState();
  }

  /** Ends a `vs restart` drain (an open restart request's drain stays). True when one was active (an expired one counts as already ended). */
  clearDrain() {
    const was = this._drain !== null && Date.now() < this._drain.until;
    clearTimeout(this._drainTimer);
    this._drainTimer = null;
    this._drain = null;
    this._writeDrainFile();
    if (!this._reqDrain) this._disarmDetachedScan();
    return was;
  }

  // idea-476 (1): an open server-side restart request (server/restart-request.mjs, idea-347) drains too, from the moment its
  // drain asks go out, not only once `vs restart` itself runs: NEW background shells are refused (claude: the drain hook
  // in-turn; every provider: _drainRefusesHold at turn end), foreground work and work already running are untouched. The
  // VS server's request loop sets it over the admin-only POST /drain/request each tick with a short TTL (a dead server
  // stops refreshing and it lapses) and ends it on DELETE when the request finishes. Kept apart from setDrain's: the
  // restart script's DELETE /drain ends its own drain only, never the request's.
  setRequestDrain({ id, tip = '', ttlMs, reason = '' } = {}) {
    const rid = String(id ?? '').trim();
    if (!REQUEST_DRAIN_ID_RE.test(rid)) throw Object.assign(new Error('id must be a restart request id (rr-...)'), { status: 400 });
    const ttl = drainTtl(ttlMs);
    const now = Date.now();
    const prev = this._requestDrainState();
    const since = prev?.id === rid ? prev.since : now; // a refresh of the same request keeps its window
    this._reqDrain = { id: rid, tip: String(tip ?? '').slice(0, 64), since, until: now + ttl, reason: String(reason ?? '').slice(0, 200) };
    clearTimeout(this._reqDrainTimer);
    this._reqDrainTimer = setTimeout(() => this.clearRequestDrain(), ttl);
    this._reqDrainTimer.unref?.();
    this._writeDrainFile();
    this._armDetachedScan();
    return this.drainState();
  }

  /** Ends the restart request's drain; with `id`, only that request's. True when one was active and ended. */
  clearRequestDrain({ id = null } = {}) {
    const cur = this._reqDrain;
    if (!cur || (id && cur.id !== String(id))) return false;
    const was = Date.now() < cur.until;
    clearTimeout(this._reqDrainTimer);
    this._reqDrainTimer = null;
    this._reqDrain = null;
    this._writeDrainFile();
    if (!this._drain) this._disarmDetachedScan();
    return was;
  }

  _restartDrain() {
    if (this._drain && Date.now() >= this._drain.until) this.clearDrain();
    return this._drain;
  }

  _requestDrainState() {
    if (this._reqDrain && Date.now() >= this._reqDrain.until) this.clearRequestDrain();
    return this._reqDrain;
  }

  /**
   * { since, until, reason, kind } while draining, else null. kind 'restart' while `vs restart` itself drains (it wins the
   * reason), 'request' while only a restart request is open (plus request: { id, tip }). Two drains: the earlier `since`
   * (work started after either began is new) and the later `until`. Expiry is checked here too, not only by the timers.
   */
  drainState() {
    const r = this._restartDrain();
    const q = this._requestDrainState();
    if (!r && !q) return null;
    const request = q ? { request: { id: q.id, tip: q.tip } } : {};
    if (r) return { since: q ? Math.min(r.since, q.since) : r.since, until: q ? Math.max(r.until, q.until) : r.until, reason: r.reason, kind: 'restart', ...request };
    return { since: q.since, until: q.until, reason: q.reason, kind: 'request', ...request };
  }

  // The hook's mirror of drainState(): rewritten on every change, removed once neither drain is active.
  _writeDrainFile() {
    if (!this.drainFile) return;
    const d = (this._drain || this._reqDrain) ? this.drainState() : null;
    if (!d) { this._removeDrainFile(); return; }
    try {
      mkdirSync(path.dirname(this.drainFile), { recursive: true });
      const tmp = `${this.drainFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(d));
      renameSync(tmp, this.drainFile); // the hook never reads a half-written file
    } catch (err) { console.error('drain file write failed', err); } // the runner-side refusal still applies
  }

  _removeDrainFile() {
    if (!this.drainFile) return;
    try { rmSync(this.drainFile, { force: true }); } catch { /* the hook checks `until` itself */ }
  }

  // A hold the drain refuses: every background shell was started after the drain began. A shell without a start time
  // (macOS ps; Linux ps carries etimes since idea-697) is treated as older work and keeps holding: the drain never stops what it cannot date.
  _drainRefusesHold(work) {
    const d = this.drainState();
    return !!d && work.length > 0 && work.every((w) => Number.isFinite(w.createdMs) && w.createdMs >= d.since);
  }

  // ---- Detached background work (idea-697, runner/detached.mjs) ----
  _armDetachedScan() {
    if (!this.detachedProbe || this._shutDown || this._detachedTimer) return;
    this._detachedTimer = setInterval(() => this._detachedTick(), this.detachedScanMs);
    this._detachedTimer.unref?.();
    this._detachedTick();
  }

  _disarmDetachedScan() {
    clearInterval(this._detachedTimer);
    this._detachedTimer = null;
  }

  _detachedTick() {
    if (!this.drainState()) { this._disarmDetachedScan(); return; }
    this.scanDetached({ why: 'drain' }).catch((err) => console.error('detached scan failed', err));
  }

  _liveCliPids() { return [...this.live.values()].map((e) => e.handle?.pid).filter((p) => Number.isInteger(p) && p > 0); }

  _teamLane(id) {
    const e = this.live.get(id);
    if (e) return { team: e.team ?? null, lane: e.lane ?? null };
    try { const m = this._fold(id)?.meta ?? {}; return { team: m.team ?? m.labels?.team ?? null, lane: m.lane ?? m.labels?.lane ?? null }; } catch { return { team: null, lane: null }; }
  }

  _reportDetached(rep) { try { this.onDetached?.(rep); } catch { /* reporting is best effort */ } }

  /**
   * One scan for detached work of this lifetime's agents (outside every live CLI tree, carrying a current token). why 'drain':
   * work started after the drain began is refused like a new hold (_drainRefusesHold): killed, logged as park-drain-refused
   * (drain.detached) and the agent told on its next input. ps dates to the second, so only work started 1 s or more after
   * the drain began is refused: what may predate the drain keeps running. Everything still running goes to the ledger.
   * Scans never overlap (a second caller shares the one in flight). Resolves { why, found, refused, skipped } or null (off).
   */
  async scanDetached({ why = 'drain' } = {}) {
    if (!this.detachedProbe) return null;
    if (this._detachedScan) return this._detachedScan;
    const run = (async () => {
      const agents = new Map();
      let since = Infinity;
      for (const [id, tok] of this.tokensById) { agents.set(sha256(tok), id); since = Math.min(since, this._tokenAt.get(id) ?? 0); }
      if (!agents.size) return { why, found: [], refused: [], skipped: [] };
      const found = await this.detachedProbe.scan({ agents, cliPids: this._liveCliPids(), protectedPids: [process.pid, process.ppid], selfPid: process.pid, since: Number.isFinite(since) ? since : 0 });
      const d = why === 'drain' && !this._shutDown ? this.drainState() : null;
      const late = d ? found.filter((w) => Number.isFinite(w.createdMs) && w.createdMs >= d.since + 1000) : [];
      let refused = [];
      let skipped = [];
      if (late.length) ({ killed: refused, skipped } = await this.detachedProbe.kill(late));
      for (const e of refused) this._noticeDetachedRefused(e, d);
      const keep = found.filter((w) => !refused.includes(w));
      this.detached = keep;
      try { await writeDetachedLedger(this.detachedFile, keep); this._ledgerWritten = true; } catch (err) { console.error('detached ledger write failed', err); }
      const fresh = keep.filter((w) => !this._detachedSeen.has(`${w.root}:${w.createdMs}`));
      for (const w of fresh) this._detachedSeen.add(`${w.root}:${w.createdMs}`);
      const tag = (w) => ({ ...w, ...this._teamLane(w.agentId) });
      if (refused.length || skipped.length || fresh.length) this._reportDetached({ why, refused: refused.map(tag), found: fresh.map(tag), skipped, ...(d ? { drain: d } : {}) });
      return { why, found: keep, refused, skipped };
    })();
    this._detachedScan = run;
    try { return await run; } finally { if (this._detachedScan === run) this._detachedScan = null; }
  }

  // A refused detached launch: the log keeps it (the parked path's notice reads park-drain-refused from the fold), and a live
  // agent carries the notice on its entry for its next input (as bgStopNotice), the same way a stopped hold is told.
  _noticeDetachedRefused(e, d) {
    const work = [{ pid: e.root, name: 'detached', cmd: e.cmd, createdMs: e.createdMs }];
    const drain = { ...d, detached: true };
    try { this.store.append(e.agentId, 'park-drain-refused', { work, drain }); } catch { /* log gone */ }
    const live = this.live.get(e.agentId);
    if (live) { const t = drainNoticeText(drain, work); live.bgStopNotice = live.bgStopNotice ? `${live.bgStopNotice}\n\n${t}` : t; }
  }

  /** Right before a /shutdown: one last scan into the ledger (no refusal), bounded by timeoutMs. Never rejects. */
  recordDetached(timeoutMs = 5000) {
    if (!this.detachedProbe || this._shutDown) return Promise.resolve(null);
    let t;
    const cap = new Promise((resolve) => { t = setTimeout(() => resolve(null), timeoutMs); t.unref?.(); });
    return Promise.race([this.scanDetached({ why: 'shutdown' }).catch(() => null), cap]).finally(() => clearTimeout(t));
  }

  /** Boot: reap the previous lifetime's ledger reapBootLedger(), graceMs from now (runner/server.mjs, after listen). */
  armBootReap(graceMs) {
    if (!this.detachedProbe || this._shutDown) return;
    clearTimeout(this._bootReapTimer);
    this._bootReapTimer = setTimeout(() => { this._bootReapTimer = null; this.reapBootLedger().catch((err) => console.error('detached boot reap failed', err)); }, graceMs);
    this._bootReapTimer.unref?.();
  }

  /**
   * The orphan rule for a restart: the previous runner's ledger entries still provably that work (same root pid, same start
   * time, env still that agent id + token sha) are tree-killed; anything else outside every live CLI tree that carries one
   * of this store's agent ids but no current token is logged as `left`, never killed. Once per boot.
   */
  async reapBootLedger() {
    const ledger = this._bootLedger ?? [];
    this._bootLedger = null;
    if (!this.detachedProbe || this._shutDown) return null;
    const currentShas = new Set([...this.tokensById.values()].map((t) => sha256(t)));
    let knownIds = null;
    try { knownIds = new Set(this.store.ids()); } catch { /* unknown: any agent id counts */ }
    const res = await this.detachedProbe.reapLedger({ ledger, cliPids: this._liveCliPids(), protectedPids: [process.pid, process.ppid], selfPid: process.pid, currentShas, knownIds });
    if (!this._ledgerWritten) { try { await writeDetachedLedger(this.detachedFile, []); } catch { /* the next boot re-verifies it */ } }
    const tag = (w) => ({ ...w, ...this._teamLane(w.agentId) });
    if (res.reaped.length || res.skipped.length || res.left.length) this._reportDetached({ why: 'boot', reaped: res.reaped.map(tag), skipped: res.skipped, left: res.left.map(tag) });
    return res;
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
      id, family: providerFamily(provider), needsTurn: !!prompt, kind: 'create', text: prompt, images: [], digest: isDigestMeta(meta),
      run: () => {
        this._makeRoom(id, { owner: job.owner === true }); // a coalesced owner send makes the queued create an owner job
        const cur = this._fold(id)?.meta ?? meta; // a config change while this create sat queued must apply
        const entry = this._start(id, { provider, model: cur.model ?? model, cwd, meta: cur, systemPrompt });
        if (job.text) { this._noteOverCap(job, entry); this._deliver(entry, job.text, job.images ?? []); } // job.text: a send may have coalesced into the queued create
      },
    };
    this._admit(job);
    return id;
  }

  // The agent's token: minted on first use, then the same for the rest of this runner process (park/resume and every
  // later turn reuse it, so a running `vs` shell keeps working across turns). Never persisted.
  tokenFor(id) {
    let t = this.tokensById.get(id);
    if (!t) { t = randomBytes(32).toString('hex'); this.tokensById.set(id, t); this._tokenAt.set(id, Date.now()); }
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
    const schedule = scheduleOf(meta); // idea-629: a schedule-spawned agent (trusted label, see scheduleOf)
    return { id, role, lane, team, profile, digest, digestFor, status: s.status, overlord, schedule };
  }

  // A lead that still counts for the lane: created, not exited, not archived, not retired, role lead, same team + lane.
  // Same liveness as verifyAgent (a lost-but-resumable lead is still the lane's lead: server/identity.mjs isLiveAgent).
  laneHasLiveLead(team, lane) {
    if (!lane) return false;
    for (const id of this.store.ids()) {
      let f = null;
      try { f = this._foldScan(id); } catch { continue; }
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
    const entry = { status: 'starting', handle: null, provider, family: providerFamily(provider), systemPrompt, sessionId: resume ?? null, parked: false, lastActive: Date.now(), lastEvent: Date.now(), quiet: false, inflight: 0, turns: resume ? 1 : 0, perms: new Set(), parkTimer: null, progress: 0, idleProgress: 0, turnGen: 0, work: null, heldSince: null, role: roleOf(meta), team: meta?.team ?? meta?.labels?.team ?? null, lane: meta?.lane ?? meta?.labels?.lane ?? null };
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
      let permResolved = false;
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
          this._releaseOverCap(entry, 1); // an owner/digest turn that was running over the cap just ended
        }
      } else if (type === 'permission') { if (data.phase === 'request') entry.perms.add(data.id); else { entry.perms.delete(data.id); permResolved = entry.perms.size === 0; } }
      else if (type === 'session' && data.sessionId) entry.sessionId = data.sessionId;
      else if (type === 'limit') { try { this.limits.record({ ...data, agentId: id }); } catch { /* limits are best-effort */ } }
      else if (type === 'turn_done' && (PROVIDER_ALIASES[provider] ?? provider) === 'antigravity-cli') this._pollAgy?.(id);
      this.store.append(id, type === 'status' ? 'status' : type, data);
      // idea-230: _armPark's timer skips an agent with a pending permission and never re-arms; a permission that resolves while
      // the agent is idle (no turn left to end and re-arm) would leave it unparked forever, so re-arm when the last one clears.
      if (permResolved && !turnEnded && entry.inflight === 0 && entry.turns >= 1 && this._parkable(entry)) this._scheduleParkAfterTurn(id, entry);
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
          this._releaseOverCap(entry, Infinity); // any owner/digest over-cap turns end with the process
          clearTimeout(entry.parkTimer);
          this._clearArchive(entry);
          this.store.append(id, 'exit', info);
          if (this.live.get(id) === entry) this.live.delete(id);
          this._reapAfterEnd(id, entry, 'exit');
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
  // A steer-only input that was dropped (a `steer_dropped` after it) never reached the agent, so it is not part of the recap.
  // Async: a full read of a big log is seconds of JSON.parse, so it is read in yielding slices (readAsync, idea-307).
  async _primer(id, maxChars = 8000) {
    const events = await this.store.readAsync(id);
    const dropped = droppedSteerSeqs(events);
    const turns = [];
    for (const e of events) {
      if (e.type === 'input' && typeof e.text === 'string') { if (!dropped.has(e.seq)) turns.push({ who: 'User', text: e.text }); }
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
  // heldWork: what the last hold held; cleared here because a turn that ran after the work started (self-woken or prompted)
  // already had the chance to read it, so no runtime wake is owed.
  _turnStarted(e) { e.turnGen++; e.work = null; e.heldSince = null; e.heldWork = null; e.heldNow = null; e.heldProbedAt = null; }

  // Background work is only possible after a turn ran in this process, and only checkable with a pid and the hold on.
  _mayHoldWork(e) { return this.parkHoldMaxMs > 0 && !!this.bgProbe && Number.isInteger(e.handle?.pid) && e.turnGen > 0; }

  // Parkable without killing background work: nothing to check, or the last probe since the turn ended saw none.
  _parkableNow(e) { return this._parkable(e) && (!this._mayHoldWork(e) || e.work?.length === 0); }

  // Probes the agent's tree once (deduped per entry), with a process snapshot started after its turn ended. Resolves to the work list, or null when a turn started meanwhile
  // (the snapshot predates it). A failing probe resolves to [] (the old park) and logs park-probe-error.
  // idea-305: the dedupe is per turn. A probe started before a turn that has since started AND ended settles to null (its
  // snapshot predates that turn), so the ended turn's own park check must get a fresh probe, not that stale promise: it
  // would read null as "a turn started, its idle re-arms" and return, while the idle that re-arms was this very check.
  // The agent then sat idle, never probed (work null), and heldIds listed it for 87 min with no shell behind it.
  _probeWork(id, e) {
    if (e.probing && e.probingGen === e.turnGen) return e.probing;
    const gen = e.turnGen;
    let p = null;
    const settle = (work) => { if (e.probing === p) e.probing = null; if (e.turnGen !== gen) return null; e.work = work; return work; };
    p = Promise.resolve().then(() => this.bgProbe(e.handle.pid, e.lastActive)).then( // lastActive = the turn end: no snapshot from before it
      (work) => settle(Array.isArray(work) ? work : []),
      (err) => { try { this.store.append(id, 'park-probe-error', { message: String(err?.message ?? err) }); } catch { /* log gone */ } return settle([]); },
    );
    e.probing = p;
    e.probingGen = gen;
    return p;
  }

  // Room for one more live process (the safety ceiling): parks the oldest idle agent if needed. False when nothing can be parked.
  // idea-146: only a live turn or running background work keeps a slot. Idle agents with no work go first (oldest first); then
  // holds past parkHoldYieldMs (oldest hold first), force-parked and told why (_forcePark). Never for room: a hold younger than
  // that, or an agent whose held work just exited and whose wake check is pending (idea-312: parking it now would drop the
  // wake; it runs a turn within one grace). yieldHolds false (a forced park's stopped-work notice, _forcePark): idle agents only,
  // never another hold, so one yield for room never cascades into the next (the notice waits for a slot like any send).
  // idea-896 owner: an owner job (job.owner) may start over maxLive by up to OWNER_OVER_CAP extra live processes, machine-wide.
  // It still parks idle agents first (down to maxLive), and yields a hold only for what the allowance does not cover. The
  // allowance in use is the live count over maxLive itself, so nothing is tagged or double-counted: it frees when an over
  // process leaves live (parked after its turn, crash, stop) and, once its turn ends or is cancelled, that idle process is the
  // first room parked for the next job. Non-owner jobs still need live below maxLive.
  _makeRoom(except, { dryRun = false, yieldHolds = true, owner = false } = {}) {
    const others = [...this.live.entries()].filter(([k]) => k !== except);
    if (others.length < this.maxLive) return true;
    // A held or unprobed idle agent is probed now (one not yet probed may have nothing); the result re-pumps. A hold this probe
    // finds empty runs its after-hold check at once (the wake), instead of at the next hold poll.
    for (const [k, e] of others) {
      if (!(this._parkable(e) && !this._parkableNow(e) && e.work === null)) continue;
      this._probeWork(k, e).then((w) => {
        if (Array.isArray(w) && !w.length && e.heldSince !== null && e.heldSince !== undefined && this.live.get(k) === e) this._armPark(k, e, 0);
        this._pump();
      });
    }
    const idle = others.filter(([, e]) => this._parkableNow(e) && !this._wakeOwed(e)).sort((a, b) => a[1].lastActive - b[1].lastActive);
    const now = Date.now();
    // A hold yields on a fresh probe that still sees its work (e.work: this round's probe above, which re-pumps), never on a
    // stale one: work that already exited is owed the finished-work wake, not the stopped-work notice.
    const yieldable = !yieldHolds ? [] : others.filter(([, e]) => this._parkable(e) && e.work?.length > 0 && e.heldSince !== null && e.heldSince !== undefined && now - e.heldSince >= this.parkHoldYieldMs)
      .sort((a, b) => a[1].heldSince - b[1].heldSince);
    const need = others.length - this.maxLive + 1;
    const mustFree = owner ? Math.max(0, others.length - (this.maxLive + OWNER_OVER_CAP) + 1) : need; // owner: below maxLive + OWNER_OVER_CAP
    if (dryRun) return idle.length + yieldable.length >= mustFree; // enough parkable agents to get below the ceiling
    let freed = 0;
    for (; freed < need && idle.length; freed++) this.park(idle.shift()[0]);
    for (; freed < mustFree; freed++) {
      if (!yieldable.length) return false;
      const [k, e] = yieldable.shift();
      this._forcePark(k, e, 'room');
    }
    // idea-975: an owner job starting over maxLive through the OWNER_OVER_CAP allowance leaves one log line (live after this start, maxLive, allowance used).
    const liveAfter = others.length - freed + 1;
    if (owner && liveAfter > this.maxLive) {
      try { this.store.append(except, 'owner-over-cap', { live: liveAfter, maxLive: this.maxLive, allowanceUsed: liveAfter - this.maxLive, allowance: OWNER_OVER_CAP }); } catch { /* log gone */ }
    }
    return true;
  }

  // A held agent (heldWork: what its hold is on) whose work a probe just saw exit, with its hold check armed or probing: the
  // agent is about to be woken (_wakeAfterBackground), so room never parks it into silence. With no check pending nothing would
  // wake it, so it is not protected (never pinned to its slot).
  _wakeOwed(e) { return !!e.heldWork && (e.parkTimer !== null || !!e.probing); }

  // Parks a held agent whose background work is still running (the hard max hold, or a yield for room) and tells it, once:
  // the wake is a normal send, admitted after the current job (setImmediate: never ahead of the job this slot was freed for).
  _forcePark(id, entry, reason) {
    const work = entry.work?.length ? entry.work : (entry.heldNow?.length ? entry.heldNow : (entry.heldWork ?? [])); // the fresh snapshot this park acts on
    const heldMs = Date.now() - (entry.heldSince ?? Date.now());
    this.store.append(id, 'park-forced', { heldMs, work, reason });
    entry.heldWork = null;
    this.park(id);
    setImmediate(() => {
      if (this._shutDown || this.live.has(id) || this.queue.some((j) => j.id === id)) return; // a send resumed it meanwhile: that turn sees its work's state itself
      this.store.append(id, 'bg-wake', { work, forced: reason });
      try { this.send(id, bgForcedText(work, heldMs, reason), { origin: 'bg-wake', yieldHolds: false }); } catch (err) {
        try { this.store.append(id, 'error', { message: `bg-wake: ${err.message}` }); } catch { /* log gone */ }
      }
    });
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

  // Releases up to `n` of an entry's over-cap turns (digest reserve first, then owner) from its family's over-cap budgets.
  // Idempotent: an entry with no over-cap turns (or a normal turn ending) releases nothing. n = Infinity releases all.
  _releaseOverCap(entry, n) {
    if (!entry || !(n > 0)) return;
    const f = entry.family;
    for (const [key, budget] of [['digestOverCap', this.overCapDigest], ['ownerOverCap', this.overCapOwner]]) {
      const have = entry[key] ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, n);
      entry[key] = have - take;
      budget.set(f, Math.max(0, (budget.get(f) ?? 0) - take));
      n -= take;
      if (n <= 0) return;
    }
  }

  _fits(job) {
    const entry = this.live.get(job.id);
    if (job.needsTurn && !(entry?.inflight > 0) && this._restartGate && Date.now() < this._restartGate.until) return false; // idea-870: gated for a restart
    if (job.needsTurn && !(entry?.inflight > 0)) {
      const cap = this.turnCaps[job.family] ?? this.turnCaps.other;
      const running = this._running(job.family);
      // Over the cap only an OWNER job (within the +OWNER_OVER_CAP budget) or a DIGEST (within the +digestReserve
      // budget) may start: the family never starts more than cap + OWNER_OVER_CAP + digestReserve turns at once.
      if (running >= cap && !this._overCapKind(job)) return false;
    }
    return !!entry || this._makeRoom(job.id, { dryRun: true, yieldHolds: job.yieldHolds !== false, owner: job.owner === true });
  }

  // idea-146: a queued job that may not yield a hold (a stopped-work notice) and waits only for that reason: with yields it
  // would fit. It does not hold up later jobs of its family that may yield (else every live slot held past its yield age plus
  // one such notice at the family head would stall that family until some hold ended on its own).
  _waitsOnYieldOnly(job) { return job.yieldHolds === false && !this._fits(job) && this._fits({ ...job, yieldHolds: true }); }

  // Which over-cap budget a job may start from when its family is at the cap: 'owner', 'digest' or null (none left / neither).
  _overCapKind(job) {
    if (job.owner && (this.overCapOwner.get(job.family) ?? 0) < OWNER_OVER_CAP) return 'owner';
    if (job.digest && (this.overCapDigest.get(job.family) ?? 0) < this.digestReserve) return 'digest';
    return null;
  }

  // Queue rank within a family: owner jobs first, then digests, then everything else (FIFO within each rank).
  _rank(job) { return job.owner ? 0 : job.digest ? 1 : 2; }

  // Runs the job now when it fits and nothing of its family should run first; otherwise queues it and says so in the log.
  // An owner job jumps non-owner jobs of its family (FIFO among owner jobs), so it can start over the cap immediately;
  // a digest likewise jumps every non-owner job of its family (idea-203).
  _admit(job) {
    // A job that would run ahead of this one in the queue: a same-family job of the same or a higher rank.
    // idea-146/312: a runtime wake into the live process that held its slot for that work (job.inPlace) needs a turn slot only;
    // FIFO behind a queued job that waits for a LIVE slot would deadlock (that job waits on this agent's slot, this turn on it).
    const familyQueued = !job.inPlace && this.queue.some((j) => j.family === job.family && this._rank(j) <= this._rank(job) && !this._waitsOnYieldOnly(j));
    if (!familyQueued && this._fits(job)) {
      try { job.run(); } catch (err) { this._failJob(job, err); }
      return;
    }
    this._enqueue(job);
    if (job.digest) this._pump(); // only queued owner jobs (budget spent) may be ahead of it: its own reserve may still fit
  }

  // Owner jobs sit ahead of non-owner jobs of the same family (FIFO within each group). A digest sits after every queued
  // owner/digest job of its family and ahead of the first plain job of ANY family, so it also wins a freed live-process
  // slot (the maxLive ceiling is shared across families). Everything else appends FIFO.
  _enqueue(job) {
    job.ahead = -1;
    let idx = -1;
    if (job.owner) {
      idx = this.queue.findIndex((j) => j.family === job.family && !j.owner);
    } else if (job.digest) {
      let floor = 0;
      this.queue.forEach((j, i) => { if (j.family === job.family && this._rank(j) <= 1) floor = i + 1; });
      idx = this.queue.findIndex((j, i) => i >= floor && this._rank(j) === 2);
    }
    if (idx === -1) this.queue.push(job);
    else this.queue.splice(idx, 0, job);
    this._announceQueue();
  }

  // Starts every queued job that now fits. A job that does not fit blocks later jobs of its family (FIFO); a missing
  // live-process slot blocks everything. Called whenever a turn ends, an agent exits or is parked.
  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      // family -> highest rank that did not fit. An owner that did not fit (its over-cap budget is spent) still lets a
      // digest try its own reserve; a digest or plain job that did not fit blocks every later non-owner job of its family.
      const blocked = new Map();
      for (let i = 0; i < this.queue.length;) {
        const job = this.queue[i];
        const b = blocked.get(job.family);
        if (b !== undefined && (b > 0 || this._rank(job) === 0)) { i++; continue; }
        if (!this._fits(job)) { if (!this._waitsOnYieldOnly(job)) blocked.set(job.family, Math.max(b ?? 0, this._rank(job))); i++; continue; }
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
    entry.parkTimer = null; // null = nothing armed (heldIds' idea-305 re-arm reads it)
    if (entry.inflight > 0 || entry.turns < 1) return;
    this._armPark(id, entry, entry.configStale ? 0 : this.parkGraceMs); // a pending config change must not be served by the old process
  }

  // idea-349: true unless every live antigravity-cli agent is provably clean: no turn running, no held work, and (where
  // background work can exist) a post-turn probe that saw none. An agent still waiting on that probe (or parked-grace with an
  // unknown work state) counts as busy: its shell may be alive and the spawned `agy -p /usage` would announce its death.
  // The caller is not exempt: park() re-polls once a process is gone, so a refused poll is retried, never lost.
  _agyBusy() {
    for (const e of this.live.values()) {
      if ((PROVIDER_ALIASES[e.provider] ?? e.provider) !== 'antigravity-cli') continue;
      if (e.inflight > 0 || (e.heldSince !== null && e.heldSince !== undefined)) return true;
      if (this._mayHoldWork(e) && e.work?.length !== 0) return true;
    }
    return false;
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
  // act once it is gone (after one more grace, so the CLI can open its own turn on the finished task first): park, or, if the
  // agent ended its turn on that work and no turn ran since, wake it (_wakeAfterBackground, idea-112). Past parkHoldMaxMs the
  // park is forced and logged with what it kills (park-forced), so a held agent cannot keep its live slot forever.
  // Explicit stops (archive, shutdown, kill) still kill at once.
  _parkWhenClear(id, entry) {
    if (!this._mayHoldWork(entry)) { this.park(id); this._pump(); return; }
    if (this._heldTickCheap(id, entry)) return;
    this._probeWork(id, entry).then((work) => {
      if (work === null || this._shutDown || this.live.get(id) !== entry || entry.perms.size > 0 || !this._parkable(entry)) return; // a turn started or the agent went: its own idle re-arms
      if (entry.progress !== entry.idleProgress) { // events since the idle with no new turn (the CLI reporting a finished task on its own)
        entry.idleProgress = entry.progress;
        entry.work = null;
        this._scheduleParkAfterTurn(id, entry);
        return;
      }
      if (!work.length) {
        if (entry.heldSince === null) {
          if (entry.heldWork) { this._wakeAfterBackground(id, entry); return; } // idea-112: it ended its turn waiting on that work
          this.park(id); this._pump(); return;
        }
        entry.heldSince = null;
        entry.heldNow = null;
        entry.work = null;
        this._scheduleParkAfterTurn(id, entry);
        return;
      }
      const now = Date.now();
      if (entry.heldSince === null && this._drainRefusesHold(work)) { // a restart is draining: no NEW hold (ideas 198 + 186)
        const drain = this.drainState();
        this.store.append(id, 'park-drain-refused', { work, drain }); // the next send reads it (_parkedSpec) and tells the agent
        this.park(id);
        this._pump();
        return;
      }
      if (entry.heldSince === null) {
        entry.heldSince = now;
        entry.heldWork = work;
        this.store.append(id, 'park-held', { work, maxHoldMs: this.parkHoldMaxMs });
      }
      entry.heldProbedAt = now; // the back-off's last snapshot (_heldTickCheap)
      entry.heldNow = work; // what holds it NOW (heldWork keeps what the hold started on, for the wake text): heldIds' reality check
      const heldMs = now - entry.heldSince;
      if (heldMs >= this.parkHoldMaxMs) {
        this._forcePark(id, entry, 'max'); // logs and reports what this FRESH snapshot sees (entry.work, just settled)
        this._pump();
        return;
      }
      entry.work = null; // the next check takes a fresh snapshot
      this._armPark(id, entry, Math.min(this.parkHoldPollMs, this.parkHoldMaxMs - heldMs));
    }).catch((err) => { try { this.store.append(id, 'error', { message: `park: ${err.message}` }); } catch { /* log gone */ } }); // never an unhandled rejection in the runner
  }

  // The held-park back-off (cpu-profile-1114 fix 1). A hold past its first parkHoldSlowAfterMs takes a fresh snapshot
  // only every parkHoldSlowPollMs; the parkHoldPollMs ticks between check the pids of the shells the last snapshot saw
  // (the same reality check heldIds runs). All dead: the hold drops at once (park-held-dead, then one grace, a fresh
  // probe and the idea-112 wake or the park), so finished work is still noticed within one fast poll. Still alive:
  // re-armed, no snapshot. Falls through to the full probe when a snapshot is due, the hold is at parkHoldMaxMs (the
  // forced park kills what a FRESH snapshot sees), or the CLI emitted events while idle. The back-off resets with the hold:
  // heldSince is per hold (cleared by a new turn, a clean probe, the reality check and stopBackground). No pid check
  // (pidAlive null) or no known pid: the hold stands until the next snapshot. True when this tick needed no snapshot.
  _heldTickCheap(id, entry) {
    if (entry.heldSince === null || entry.heldSince === undefined || !Number.isFinite(entry.heldProbedAt)) return false;
    if (entry.progress !== entry.idleProgress) return false;
    const now = Date.now();
    const heldMs = now - entry.heldSince;
    const snapAt = entry.heldProbedAt + this.parkHoldSlowPollMs;
    if (heldMs < this.parkHoldSlowAfterMs || heldMs >= this.parkHoldMaxMs || now >= snapAt) return false;
    if (this._reconcileHeldEntry(id, entry)) return true; // its shells all died: dropped, the after-hold flow is armed
    this._armPark(id, entry, Math.min(this.parkHoldPollMs, snapAt - now, this.parkHoldMaxMs - heldMs));
    return true;
  }

  // idea-112: held background work exited, one more grace passed and no turn ran since (the CLI did not start one on its
  // own: ACP agents never can, a Claude CLI normally does and its 'running' clears heldWork first). The agent ended its turn
  // waiting on that work, so it is woken with a normal input (a real turn: the server sees turn_started/turn_ended, the lead
  // is told) instead of parked into silence. Not a hold: a draining runner still refuses any NEW background work the woken
  // turn starts (drain hook in-turn, _drainRefusesHold at its end). A send that throws falls back to the old park.
  _wakeAfterBackground(id, entry) {
    const work = entry.heldWork;
    entry.heldWork = null;
    this.store.append(id, 'bg-wake', { work });
    try { this.send(id, bgWakeText(work), { origin: 'bg-wake' }); this._pump(); } catch (err) { // pump: a wake queued behind a turn cap leaves this agent idle-parkable, so a job waiting for room may now fit
      try { this.store.append(id, 'error', { message: `bg-wake: ${err.message}` }); } catch { /* log gone */ }
      if (this.live.get(id) === entry && this._parkable(entry)) { this.park(id); this._pump(); }
    }
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
    this._reapAfterEnd(id, entry, 'park');
    if ((PROVIDER_ALIASES[entry.provider] ?? entry.provider) === 'antigravity-cli') this._pollAgy?.(id); // idea-349: the retry a busy turn_done poll was refused for
  }

  // Drops a pending archive-stop (flag + kill timer): unarchive, park and exit all end that window.
  _clearArchive(entry) {
    if (!entry) return;
    entry.archiveWhenIdle = false;
    clearTimeout(entry.archiveTimer);
    entry.archiveTimer = null;
  }

  // idea-515 (Z1): a worker's process just ended (park, archive stop, exit). Listeners it leaked out of its tree (a dev server
  // started with `&` / Start-Process: the tool shell died, so the tree kill never reached it) are reaped reapDelayMs later by
  // this.reaper (runner/reap.mjs: env-token proof, never held work, never another agent's, fail closed). Protected: every live
  // agent's last-probed shells (held or not) and this entry's own last hold, the runner and its parent. Nothing is killed once
  // the agent is live again or the runner is shutting down. One reap per process (entry.reapArmed).
  _reapAfterEnd(id, entry, why) {
    if (!this.reaper || entry.reapArmed || entry.role !== 'worker' || this._shutDown) return;
    const token = this.tokensById.get(id);
    if (!token) return;
    entry.reapArmed = true;
    const endedAt = Date.now();
    const cliPid = Number.isInteger(entry.handle?.pid) ? entry.handle.pid : null;
    const shellPids = (e) => [e.heldNow, e.heldWork, e.work].flatMap((w) => (Array.isArray(w) ? w : [])).map((w) => w?.pid);
    const own = shellPids(entry);
    const stillOk = () => !this._shutDown && !this.live.has(id);
    const report = (res) => { if (res.reaped?.length || res.skipped?.length || res.error) { try { this.onReap?.({ id, why, team: entry.team, lane: entry.lane, reaped: res.reaped ?? [], skipped: res.skipped ?? [], ...(res.error ? { error: res.error } : {}) }); } catch { /* reporting is best effort */ } } };
    const t = setTimeout(() => {
      if (!stillOk()) return; // resumed (its new process owns the tree now) or shutting down: nothing to reap
      const protectedPids = [...own, ...[...this.live.values()].flatMap(shellPids), process.pid, process.ppid].filter((p) => Number.isInteger(p) && p > 0);
      Promise.resolve().then(() => this.reaper({ agentId: id, token, since: this._tokenAt.get(id) ?? 0, endedAt, protectedPids, cliPid, stillOk })).then(report, (err) => report({ error: String(err?.message ?? err) }));
    }, this.reapDelayMs);
    t.unref?.();
  }

  // Ends an agent's process for good measure but leaves it resumable: with a session it is logged as parked (so unarchive + send
  // resumes it) even when mid-turn or still starting; without one the kill logs a plain exit. Frees its live and turn slots.
  _stopKeepingSession(id, entry) {
    clearTimeout(entry.parkTimer);
    this._clearArchive(entry);
    this._releaseOverCap(entry, Infinity); // any owner/digest over-cap turns end with the session stop
    if (!entry.handle || this.live.get(id) !== entry) return;
    if (entry.sessionId && this.adapters[entry.provider]?.canPark) {
      entry.parked = true;
      this.store.append(id, 'parked', { sessionId: entry.sessionId, systemPrompt: entry.systemPrompt ?? null });
      this.store.append(id, 'status', { status: 'parked' });
      this.live.delete(id);
      entry.handle.kill();
      this._reapAfterEnd(id, entry, 'stop');
    } else entry.handle.kill(); // onExit logs the exit and frees the slot (and arms the reap)
  }

  // The current fold of a log for the resume paths (idea-307): _parkedSpec / _lostSpec / _unstartedPlan / _cutTurn used to parse
  // the whole log synchronously on every send/resume (loop-lag 302). _fold is stat-validated and incremental (only bytes appended
  // since the last fold are read; after a boot, since the fold index's offset), and its spec fields (fold-index.mjs newSpecFold)
  // fold exactly what those loops computed. Same complete lines as store.read: a partial last line is in neither.
  _specFold(id) { return this.store.exists(id) ? this._fold(id) : null; }

  // A copy of the folded meta: a spec's meta goes to callers (entries, jobs) and must never alias the cached fold.
  static _metaCopy(f) { return structuredClone(f.meta ?? {}); }

  // The created event's systemPrompt (the fold drops role prompts): the log's first event only, i.e. a full read's events[0].
  // Read in 64KB slices until that event (each slice completes at least one line, however long): store.read(id, 0, 1) would
  // read and copy a whole 1MB chunk to parse one line (4ms a call on a big log). Same event: the first complete line with seq >= 0.
  _createdPrompt(id) {
    for (let off = 0; ;) {
      const r = this.store.readFrom(id, off, 0, 1, null, 1 << 16);
      if (r.events.length) return r.events[0].systemPrompt;
      if (r.end <= off) return undefined; // end of the complete lines: no such event
      off = r.end;
    }
  }

  // The systemPrompt of the parked event the fold picked: that one line, read by seq via the store's sparse index. Trusted only
  // when every seq in the log rose strictly (f.seqMono: the event with that seq is unique) and the line read is that same event;
  // anything else (a hand-edited log: duplicate, missing or gapped seqs) falls back to the full scan the fold replaced.
  _parkedPrompt(id, f) {
    const park = f.park;
    if (f.seqMono && Number.isSafeInteger(park.seq) && park.seq >= 0) {
      const e = this.store.read(id, park.seq, 1)[0];
      if (e?.type === 'parked' && e.seq === park.seq && e.ts === park.ts && e.sessionId === park.sessionId) return e.systemPrompt;
    }
    let parked = null;
    for (const e of this.store.read(id)) {
      if (e.type === 'parked') parked = e;
      else if (e.type === 'status' && e.status !== 'parked' && e.status !== 'queued') parked = null;
    }
    return parked?.systemPrompt;
  }

  // Resume spec for a parked agent, read from its log so it survives a runner restart. Null if not parked.
  // Meta: the created meta with every later meta patch folded in (labels merged), the same way the summary does, so a resume
  // uses the current meta. A park-drain-refused / bg-stopped no (non-steer-only) input has seen yet: the next send tells the agent.
  _parkedSpec(id) {
    const f = this._specFold(id);
    if (!f || f.exit || f.archived) return null;
    const parked = f.park;
    if (!parked || typeof parked.sessionId !== 'string' || !parked.sessionId || parked.sessionId.startsWith('-')) return null;
    const c = f.created;
    const meta = Runner._metaCopy(f);
    const { refused, stopped } = f;
    return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: parked.prompt ? this._parkedPrompt(id, f) ?? undefined : undefined, resume: parked.sessionId, ...(refused ? { drainNotice: drainNoticeText(refused.drain ?? {}, Array.isArray(refused.work) ? refused.work : []) } : {}), ...(stopped?.work?.length ? { bgStopNotice: bgStopNoticeText(stopped.work) } : {}) };
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
    const f = this._fold(id);
    if (!f || f.exit) return null;
    const sessionId = f.sessionId ?? null;
    const c = f.created;
    if (f.archived || !sessionId || typeof sessionId !== 'string' || sessionId.startsWith('-') || !this.adapters[c?.provider]?.canPark) return null;
    const meta = Runner._metaCopy(f);
    return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: this._createdPrompt(id) ?? undefined, resume: sessionId };
  }

  // An agent whose log ends in a `queued` status never got its turn: nothing was delivered after the queued events. The runner's
  // queue is in memory, so a runner restart drops the job while the log still says queued. Returns the spec to start it (fresh
  // or, when a session was recorded, resumed) and the inputs logged since the last real status, or null if it is not that case.
  _unstartedPlan(id) {
    if (!this.store.exists(id) || this.live.has(id) || this.queue.some((j) => j.id === id)) return null; // a queued job already owns these inputs
    // From the fold (idea-307): lastState = the last status, or 'exited' after an exit; pending = the text inputs (not steer-only:
    // those never start a turn) after the last non-queued status (inputs before it were delivered).
    const f = this._fold(id);
    const c = f?.created;
    if (c?.type !== 'created' || !this.adapters[c.provider]) return null;
    if (f.lastState !== 'queued' || f.archived) return null;
    const inputs = f.pending;
    if (!inputs.length) return null;
    const meta = Runner._metaCopy(f);
    if (isRetiredMeta(meta)) return null; // retirePredecessors / confirmTakeover only relabel the role (never archive): a former-lead stays dead
    const statusTs = f.lastStatus?.ts ?? 0;
    if (this.queueMaxAgeMs > 0 && Date.now() - statusTs > this.queueMaxAgeMs) return null; // stale: a days-old input must not run on a whim
    const supersededBy = this._successorOf(id, meta);
    const sessionId = f.sessionId ?? null;
    const resumable = sessionId && !sessionId.startsWith('-') && this.adapters[c.provider]?.canPark;
    return {
      spec: { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: this._createdPrompt(id) ?? undefined, ...(resumable ? { resume: sessionId } : {}) },
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
  // `shouldAdmit()` is asked once, after the fold pass (the slow part of a boot): false (this runner lost runner.lock while it
  // folded, P0 11-15) admits nothing, so two runners never start the same queued turn.
  recoverQueued({ shouldAdmit } = {}) {
    const plans = [];
    this._foldsWarm = false;
    const tm = this.bootFoldMs = { prefold: this._prefoldMs, load: 0, pass: 0, stat: 0, seed: 0, read: 0, tokens: 0, plans: 0, admit: 0 };
    this._prefoldMs = 0;
    let t = performance.now();
    const lap = (k) => { const now = performance.now(); tm[k] += now - t; t = now; };
    this._loadFoldIndex(); // each log's fold resumes from the last saved one (fold-index.mjs): only bytes appended since are read
    lap('load');
    this._passMs = tm;
    try {
      for (const id of this.store.ids()) { try { this._fold(id); } catch { /* unreadable log: skipped below too */ } } // one boot pass; later successor checks read the cache
    } finally { this._foldSeed = null; this._passMs = null; } // entries of logs that are gone are dropped; no later _fold reads a seed
    lap('pass');
    this._foldsWarm = true;
    if (shouldAdmit && !shouldAdmit()) return [];
    this.mintBootTokens(); // from the same pass: every agent that may still act verifies from the first request after a restart
    lap('tokens');
    for (const id of this.store.ids()) {
      let plan = null;
      try { plan = this._unstartedPlan(id); } catch { /* unreadable log: skip */ }
      if (!plan) continue;
      if (plan.supersededBy) continue;
      plans.push({ id, plan });
    }
    lap('plans');
    // Owner inputs take the free slots first (they would have jumped the queue), then oldest first.
    // Digests next (idea-203): they keep their queue priority across a runner restart.
    const rank = (p) => (p.plan.owner ? 0 : isDigestMeta(p.plan.spec.meta) ? 1 : 2);
    plans.sort((a, b) => rank(a) - rank(b) || a.plan.ts - b.plan.ts);
    for (const { id, plan } of plans) {
      const job = { id, spec: plan.spec, family: providerFamily(plan.spec.provider), needsTurn: true, kind: 'send', owner: plan.owner, digest: isDigestMeta(plan.spec.meta), text: plan.text, images: [], run: () => this._deliverJob(job) };
      this._admit(job);
    }
    lap('admit');
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
    const last = this._fold(id)?.lastStatus ?? null; // the log's last status event (fold, idea-307)
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
    this._releaseOverCap(e, Infinity);
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
  // Ideas 228 + 229: held is checked against reality first (_reconcileHeld), so /health, the restart wait and its deferral
  // never report a hold whose shells are all dead (it would otherwise stand until the next poll, up to parkHoldPollMs).
  // idea-305: "held until its first probe" is only true while that probe is coming (a park timer armed or a probe in flight).
  // An idle agent left unprobed with neither (a lost re-arm) would be listed forever while vs stop --background finds no
  // shell, so the park check is re-armed here (logged park-rearm): listed this once, dropped within one grace + probe.
  heldIds() {
    this._reconcileHeld();
    const ids = [];
    for (const [id, e] of this.live) {
      if (e.heldSince !== null && e.heldSince !== undefined) ids.push(id);
      else if (this._parkable(e) && this._mayHoldWork(e) && e.work?.length !== 0) {
        ids.push(id);
        if (e.work == null && !e.parkTimer && !e.probing && e.perms.size === 0 && !this._shutDown) {
          try { this.store.append(id, 'park-rearm', { reason: 'held unprobed with no park check pending' }); } catch { /* log gone */ }
          this._scheduleParkAfterTurn(id, e);
        }
      }
    }
    return ids;
  }

  // What each held agent's hold is on right now: id -> [{ pid, name, cmd, createdMs? }] (the latest probe's shells that are still
  // alive; [] for an agent held only until its first probe). For /health, so a deferral can name the actual command.
  heldWork() {
    const out = {};
    for (const id of this.heldIds()) {
      const e = this.live.get(id);
      const work = Array.isArray(e?.heldNow) ? e.heldNow : [];
      out[id] = work.filter((w) => !this.pidAlive || this.pidAlive(w.pid)).map((w) => ({ pid: w.pid, name: w.name, cmd: shellCmdTail(w.cmd, 160), ...(Number.isFinite(w.createdMs) ? { createdMs: w.createdMs } : {}) })); // idea-475: createdMs dates each shell in a deferral
    }
    return out;
  }

  // The reality check: a held park whose known shells (the latest probe's) are all dead is no hold. It is dropped at once
  // (logged park-held-dead) and the after-hold flow runs as if the poll had seen it: one grace, a fresh probe, then the
  // idea-112 wake (heldWork is kept) or the park. No pid known (or no liveness check): kept, the poll stays the authority.
  _reconcileHeld() {
    if (!this.pidAlive) return;
    for (const [id, e] of this.live) this._reconcileHeldEntry(id, e);
  }

  // One entry's reality check; true when its hold was dropped.
  _reconcileHeldEntry(id, e) {
    if (!this.pidAlive || e.heldSince === null || e.heldSince === undefined) return false;
    const pids = (Array.isArray(e.heldNow) ? e.heldNow : Array.isArray(e.heldWork) ? e.heldWork : []).map((w) => w?.pid).filter((p) => Number.isInteger(p) && p > 0);
    if (!pids.length || pids.some((p) => this.pidAlive(p))) return false;
    e.heldSince = null;
    e.heldNow = null;
    e.work = []; // known clean: not "held until the first probe" either
    try { this.store.append(id, 'park-held-dead', { pids }); } catch { /* log gone */ }
    this._scheduleParkAfterTurn(id, e);
    return true;
  }

  // Stops an idle agent's background work (ideas 228 + 229): every shell a FRESH probe sees under its CLI is killed with
  // its whole tree (killPidTree: taskkill /pid <pid> /T /F), so bash -> timeout.exe -> Godot dies together instead of
  // leaving the native children orphaned. Only pids that probe saw under this agent are touched (never a remembered pid,
  // which Windows may have reused). The hold is dropped without the idea-112 wake (stopped on purpose, not finished) and
  // the agent goes through the normal after-turn park. Throws 404 (unknown), 409 (not live, mid-turn, no probe).
  async stopBackground(id, { by = null } = {}) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    const entry = this.live.get(id);
    if (!entry) throw fail(this.store.exists(id) ? 409 : 404, this.store.exists(id) ? `agent ${id} is not live (no process tree)` : 'no such agent');
    if (!entry.handle || !Number.isInteger(entry.handle.pid)) throw fail(409, `agent ${id} has no process to probe`);
    if (!this.bgProbe) throw fail(409, 'background probe is off');
    if (entry.inflight > 0 || entry.status === 'running') return this._refreshHeldMidTurn(id, entry); // idea-315
    const gen = entry.turnGen; // idea-231: a turn that starts while the probe runs owns the tree now
    const work = await this.bgProbe(entry.handle.pid, Date.now()); // a snapshot started now: nothing stale
    // A turn started (or started and ended) during the probe: the snapshot may hold that turn's own shell, and its work
    // must not be wiped. Nothing is killed; the caller retries once the agent is idle again.
    if (this.live.get(id) === entry && (entry.turnGen !== gen || entry.inflight > 0 || entry.status === 'running')) throw fail(409, `agent ${id} started a turn while its background work was probed: nothing stopped`);
    const list = Array.isArray(work) ? work : [];
    for (const w of list) { try { this.killPid(w.pid); } catch { /* gone */ } }
    if (this.live.get(id) !== entry) return { stopped: list };
    entry.heldSince = null;
    entry.heldNow = null;
    entry.heldWork = null; // no "your work finished" wake for work that was stopped
    entry.work = []; // just killed: not held (the after-turn park still probes fresh; a tree still dying re-holds, and the reality check drops it once dead)
    if (list.length) {
      try { this.store.append(id, 'bg-stopped', { work: list, ...(by ? { by } : {}) }); } catch { /* log gone */ }
      entry.bgStopNotice = bgStopNoticeText(list); // idea-230: if it stays live, its next send carries the notice (parked: folded from the log)
    }
    if (this._parkable(entry)) this._scheduleParkAfterTurn(id, entry);
    return { stopped: list };
  }

  // idea-315: `vs stop <id> --background` while the agent is running a turn. The process tree cannot tell a running foreground
  // tool shell from a background one, so this KILLS NOTHING and never touches the turn or entry.work (idea-231). It only
  // re-probes and drops a STALE held entry (heldSince set, but none of the held pids is under the CLI any more), which is
  // what a restart drain needs. Returns the shells it saw as `spared` and the resulting hold state as `held`.
  async _refreshHeldMidTurn(id, entry) {
    const gen = entry.turnGen;
    const seen = await this.bgProbe(entry.handle.pid, Date.now());
    const spared = Array.isArray(seen) ? seen : [];
    if (this.live.get(id) !== entry || entry.turnGen !== gen) return { stopped: [], spared, held: false }; // the turn moved on: it owns the entry now
    let held = entry.heldSince !== null && entry.heldSince !== undefined;
    if (held) {
      const heldPids = (Array.isArray(entry.heldNow) ? entry.heldNow : Array.isArray(entry.heldWork) ? entry.heldWork : []).map((w) => w?.pid);
      const present = new Set(spared.map((w) => w.pid));
      if (!heldPids.some((p) => present.has(p))) {
        entry.heldSince = null; entry.heldNow = null; entry.heldWork = null; entry.heldProbedAt = null;
        try { this.store.append(id, 'held-cleared', { midTurn: true, pids: heldPids }); } catch { /* log gone */ }
        held = false;
      }
    }
    return { stopped: [], spared, held };
  }

  // Starts the parked/lost agent's process in place. Callers have checked the room (_fits); false if there is no spec.
  // promptless: a bare resume (no send behind it), whose `starting` is tagged `resume: true` (see _settleResume).
  _resume(id, fallbackSpec = null, { promptless = false, yieldHolds = true, owner = false } = {}) {
    const spec = this._parkedSpec(id) ?? this._lostSpec(id) ?? this._unstartedPlan(id)?.spec ?? fallbackSpec; // fresh from the log: picks up a config change made while the job waited
    if (!spec) return null;
    if (!this._makeRoom(id, { yieldHolds, owner })) throw new Error('no live process slot free');
    this.store.append(id, 'status', { status: 'starting', ...(promptless ? { resume: true } : {}) });
    return this._start(id, spec);
  }

  // Hands a prompt to a live agent: from now it holds a turn slot until its turn's idle.
  _deliver(entry, text, images = []) {
    if (!entry?.handle) throw new Error('agent is not running');
    clearTimeout(entry.parkTimer);
    entry.parkTimer = null;
    // inflight counts OPEN TURNS (one per agent at a time), not prompts. A fresh turn takes its slot here — and marks
    // itself active — immediately, without waiting for the adapter's (possibly async, e.g. ACP ready.then) 'running'.
    const fresh = entry.inflight === 0;
    if (fresh) {
      entry.inflight = 1;
      entry.lastEvent = Date.now();
      entry.quiet = false;
      this._turnStarted(entry);
    }
    try { entry.handle.send(text, images.length ? { images } : undefined); } catch (err) {
      // The turn never opened: give back its slot and any over-cap owner/digest mark _noteOverCap took for it (marks are
      // only taken for a fresh turn, so this releases exactly that one; every deliver path comes through here).
      if (fresh) { entry.inflight = 0; this._releaseOverCap(entry, 1); }
      throw err;
    }
  }

  // opts.images: [{ data (base64), mimeType }]; opts.activeTurnBehavior: 'steer' (default, queue behind/into the turn)
  // or 'interrupt' (cancel the active turn first). opts.owner marks a human (UI / `vs send`) turn: it jumps the family
  // queue and may run over the turn cap (see _fits). opts.senderId: the verified agent that sent it (logged on the input
  // event; the HTTP layer sets it from the caller, never from the body). The log keeps the image count, never the base64 payload.
  // Returns { queued, ahead? }: over the family's turn cap the prompt is logged now and delivered FIFO when a slot frees.
  // opts.steerOnly: see _sendSteerOnly (never starts, resumes or queues a turn; returns { queued: false, delivered, reason? }).
  send(id, text, opts = {}) {
    const senderId = typeof opts.senderId === 'string' && opts.senderId ? { senderId: opts.senderId } : opts.origin === 'bg-wake' ? { origin: 'bg-wake' } : {}; // origin: a runtime wake (idea-112), never a caller's
    if (opts.steerOnly === true) return this._sendSteerOnly(id, text, opts, senderId);
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

    if (spec?.drainNotice) this.store.append(id, 'drain-notice', { text: spec.drainNotice });
    const bgStopNotice = spec?.bgStopNotice ?? live?.bgStopNotice ?? null; // idea-230: a live idle agent carries it on its entry, a parked one folds it from the log
    if (live) live.bgStopNotice = null;
    if (bgStopNotice) this.store.append(id, 'bg-stop-notice', { text: bgStopNotice });
    this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}), ...(owner ? { owner: true } : {}), ...senderId });
    const lead = [spec?.drainNotice, bgStopNotice, pending?.text].filter(Boolean); // a drain refusal notice, then inputs that never ran, then this text
    const job = {
      id, spec, family, needsTurn: true, kind: 'send', owner: owner || pending?.owner === true, digest: this._isDigest(id, spec), text: [...lead, text].join('\n\n'), images,
      run: () => this._deliverJob(job),
      ...(opts.origin === 'bg-wake' && live?.handle ? { inPlace: true } : {}), // a runtime wake into its held live process (_admit)
      ...(opts.yieldHolds === false ? { yieldHolds: false } : {}), // internal (_forcePark's notice; the HTTP layer never passes it): makes room from idle agents only
    };
    if (live?.inflight > 0 && !this.queue.some((j) => j.id === id)) job.run(); // steering a running turn: it already holds its slot
    else this._admit(job);
    return this.queuePosition(id);
  }

  // A steer-only send (idea-169: guard/nudge inputs): it joins the agent's OPEN turn or is dropped. It never starts, resumes,
  // queues or coalesces a turn, never parks for a config change and never interrupts. Dropped -> { queued: false, delivered:
  // false, reason }: 'not-running' (no live process: parked, lost, exited), 'queued' (its next turn waits in the queue),
  // 'idle' (no open turn), 'turn-ending' (the adapter has no turn left to join, e.g. after an interrupt). Joined -> { queued:
  // false, delivered: true, steer: true }. An ACP adapter cannot inject into a running prompt: the steer rides along with the
  // next real prompt if one is queued, else the adapter drops it when the turn ends (a `steer_dropped` event in the log).
  _sendSteerOnly(id, text, opts, senderId) {
    const drop = (reason) => ({ queued: false, delivered: false, reason });
    const live = this.live.get(id);
    if (!live && !this.store.exists(id)) throw new Error(`agent ${id} is not running`); // unknown id: same answer as a plain send
    if (this.queue.some((j) => j.id === id)) return drop('queued');
    if (!live?.handle) return drop('not-running');
    if (!(live.inflight > 0)) return drop('idle');
    if (typeof live.handle.steerable === 'function' && !live.handle.steerable()) return drop('turn-ending');
    const images = (Array.isArray(opts.images) ? opts.images : []).filter((i) => i && typeof i.data === 'string' && typeof i.mimeType === 'string');
    // The input's seq rides along (inputSeq) so every steer_dropped names the input it drops; the fresh-session primer skips those.
    const input = this.store.append(id, 'input', { text, ...(images.length ? { images: images.length } : {}), steerOnly: true, ...senderId }).seq;
    let joined;
    try { joined = live.handle.send(text, { ...(images.length ? { images } : {}), steerOnly: true, inputSeq: input }); } catch (err) {
      this.store.append(id, 'steer_dropped', { reason: 'send-failed', input, message: String(err?.message ?? err) });
      return drop('send-failed');
    }
    if (joined === false) { // steerable() said yes in this same tick; kept as a backstop for adapters without it
      this.store.append(id, 'steer_dropped', { reason: 'turn-ending', input });
      return drop('turn-ending');
    }
    return { queued: false, delivered: true, steer: true };
  }

  // Starts (or resumes) the job's agent and delivers its text, marking an owner job that begins a fresh turn over the
  // family cap as an over-cap owner turn (tracked for the +OWNER_OVER_CAP budget).
  _deliverJob(job) {
    const entry = this.live.get(job.id) ?? this._resume(job.id, job.spec, { yieldHolds: job.yieldHolds !== false, owner: job.owner === true });
    this._noteOverCap(job, entry);
    this._deliver(entry, job.text, job.images ?? []);
  }

  // An owner/digest job that begins a fresh turn over the family cap is tracked against its over-cap budget
  // (+OWNER_OVER_CAP / +digestReserve) until that turn ends.
  _noteOverCap(job, entry) {
    if (!entry || entry.inflight > 0 || this._running(job.family) < (this.turnCaps[job.family] ?? this.turnCaps.other)) return;
    const kind = this._overCapKind(job);
    if (!kind) return;
    const [key, budget] = kind === 'owner' ? ['ownerOverCap', this.overCapOwner] : ['digestOverCap', this.overCapDigest];
    entry[key] = (entry[key] ?? 0) + 1;
    budget.set(job.family, (budget.get(job.family) ?? 0) + 1);
  }

  // A send to a digest agent (a transient-error retry, a coalesced follow-up) keeps the digest's queue priority.
  _isDigest(id, spec) {
    if (spec?.meta) return isDigestMeta(spec.meta);
    try { return isDigestMeta(this._fold(id)?.meta); } catch { return false; }
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
  status(id, { scan = false } = {}) {
    const f = scan ? this._foldScan(id) : this._fold(id);
    if (!f) return null;
    let status = f.status;
    if (f.exit) status = 'exited';
    else if (!this.live.has(id) && status !== 'parked' && !this.queue.some((j) => j.id === id)) status = 'lost'; // log says running but no child in this process
    const { queued, ...rec } = f.rec;
    // R4-1: a tool can only be in flight in a running agent with a child; a lost/exited/parked log that ended mid-call has none.
    const openTool = status === 'running' ? rec.openTool ?? null : null;
    return { ...rec, ...(status === 'queued' && queued ? { queued } : {}), status, resumable: this._resumable(f), pendingPermissions: [...f.perms.values()], openTool, ...(status === 'idle' && this._bgHeldNow(id) ? { bgHeld: true } : {}) };
  }

  // idea-631: an idle live agent whose park the runner is holding on its own background work, OR that is still in the post-turn
  // grace + first probe (heldIds' rule, without its re-arm side effect): its turn end is not a report yet. False once the probe saw
  // no shell (it parks, leaving live) or the hold dropped (bg-stopped / held-dead clear heldSince).
  _bgHeldNow(id) {
    const e = this.live.get(id);
    if (!e || e.status !== 'idle' || e.perms.size > 0) return false; // a pending permission reads blocked (permission), not waiting-bg
    if (e.heldSince !== null && e.heldSince !== undefined) return true;
    if (this._wakeOwed(e)) return true; // the hold's shells exited (held-dead / probe saw none): the bg-wake turn is coming, not a report
    return !!(this._parkable(e) && this._mayHoldWork(e) && e.work?.length !== 0 && (e.parkTimer !== null || e.probing)); // post-turn window, only while a park check is coming
  }

  // Every agent's status in one call (roster seed): one pass over the logs, then served from the fold cache.
  statusAll() {
    const out = [];
    for (const id of this.store.ids()) {
      let s = null;
      try { s = this.status(id, { scan: true }); } catch { /* unreadable log: left out, like a failed per-id GET */ }
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
        try { s = this.status(id, { scan: true }); } catch { /* unreadable log: left out, like a failed per-id GET */ }
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

  // Roster-scan fold: the cached fold without a stat while the agents-dir watch vouches the log is unchanged, else _fold.
  _foldScan(id) {
    if (this._foldClean.has(id) && this._rosterWatch) { const f = this.folds.get(id); if (f) return f; }
    this._ensureRosterWatch();
    return this._fold(id);
  }

  // Starts the agents-dir watch once. The watch must be up BEFORE a fold is stat-validated for that fold to count as clean.
  // No watch (unsupported fs, a throwing factory) or a failed one: every scan stats, as before. A missing dir is NOT a
  // permanent failure: _ensureRosterWatch just returns and the guard retries once the dir is recreated.
  _ensureRosterWatch() {
    if (this._rosterWatch || this._rosterWatchFailed || this._shutDown) return;
    let identity = null;
    try { const st = statSync(this.store.dir, { bigint: true }); identity = `${st.ino}:${st.birthtimeNs ?? st.birthtimeMs}`; } catch { return; } // dir gone: retry later, not a failure
    let w;
    try {
      w = this.rosterWatchFactory(this.store.dir, (_event, name) => {
        const file = name == null ? '' : String(name);
        if (!file) { this._foldClean.clear(); return; } // overflow / unknown file: trust nothing
        if (file.endsWith('.jsonl')) this._foldClean.delete(file.slice(0, -6));
      });
    } catch (err) {
      // The dir vanished between the stat above and the watch open (ENOENT): a missing dir, not a permanent failure (L2).
      if (err?.code === 'ENOENT') return;
      this._rosterWatchFailed = true; this._stopRosterWatchGuard(); return;
    }
    if (!w) { this._rosterWatchFailed = true; this._stopRosterWatchGuard(); return; }
    w.on?.('error', () => { this.closeRosterWatch(); this._rosterWatchFailed = true; });
    this._rosterWatch = w;
    this._rosterWatchIdentity = identity; // captured now, not on the first guard tick (M3)
    this._rosterWatchReopen = false;
    this._ensureRosterWatchGuard();
  }

  // Closes only the fs.watch handle and forgets every clean mark. Used by the guard when it detects a missing/replaced
  // dir (it keeps polling to reopen), so it does NOT stop the guard or touch the reopen flag.
  _closeRosterWatchHandle() {
    const w = this._rosterWatch;
    this._rosterWatch = null;
    this._foldClean.clear();
    try { w?.close(); } catch { /* already closed */ }
  }

  // Stops the agents-dir watch and forgets every clean mark (the next scan stats; a later scan may watch again).
  // This is an explicit close (shutdown, a test before rmSync, or the watch's 'error' handler): it stops the guard and
  // drops the reopen flag, so the guard never reopens a watch the caller closed (M2).
  closeRosterWatch() {
    this._closeRosterWatchHandle();
    this._rosterWatchFailed = false;
    this._rosterWatchIdentity = null;
    this._rosterWatchReopen = false;
    this._stopRosterWatchGuard();
  }

  // Schedules the next guard stat. Self-rescheduling setTimeout: at most one tick is ever in flight, so a stale stat can
  // never act on a dir that was removed meanwhile (M1). Unref'd: it never keeps the process alive (tests exit without
  // clearing it), and closeRosterWatch/shutdown clear it. No sync fs on the hot scan path.
  _ensureRosterWatchGuard() {
    if (this._rosterWatchGuard || this._shutDown || this._rosterWatchFailed || !(this._rosterWatch || this._rosterWatchReopen)) return;
    const ms = Number(this._rosterWatchGuardMs);
    const interval = Number.isFinite(ms) && ms >= 25 ? ms : DEFAULT_ROSTER_WATCH_GUARD_MS;
    this._rosterWatchGuard = setTimeout(() => { this._rosterWatchGuardTick(); }, interval);
    this._rosterWatchGuard.unref?.();
  }

  // Stops the guard timer and bumps the generation: an in-flight tick that is awaiting its stat bails on the next check
  // (H1), so it can never resurrect a watch or a timer after a close/shutdown/permanent-failure.
  _stopRosterWatchGuard() {
    this._rosterWatchGuardGen++;
    if (this._rosterWatchGuard) { clearTimeout(this._rosterWatchGuard); this._rosterWatchGuard = null; }
  }

  // idea-594: the watch must never stay open on a directory that was deleted or replaced under it — fs.watch on a removed
  // dir spins libuv in kernel mode on Windows and never fires 'error' (idea-571/590). Each tick stats the agents dir once
  // (async): gone -> close and keep polling; identity (ino/birthtime) changed -> close and reopen on the new dir; gone
  // then back -> reopen. The poll bounds the spin to at most one interval, it cannot prevent a deletion that already won.
  async _rosterWatchGuardTick() {
    const gen = this._rosterWatchGuardGen;
    this._rosterWatchGuard = null; // the timer that fired is gone; the tick reschedules itself at the end
    if (this._shutDown) return;
    let st = null;
    try { st = await this.rosterWatchStat(this.store.dir); } catch { /* gone or unreadable: treat as gone */ }
    if (this._shutDown || this._rosterWatchGuardGen !== gen) return; // shutdown/close/error landed mid-stat (H1)
    const identity = st ? `${st.ino}:${st.birthtimeNs ?? st.birthtimeMs}` : null;
    if (this._rosterWatch) {
      if (!st) {
        // deleted under the watch: drop the handle and keep polling so the dir's return reopens it.
        this._closeRosterWatchHandle();
        this._rosterWatchIdentity = null;
        this._rosterWatchReopen = true;
      } else if (this._rosterWatchIdentity !== identity) {
        this._closeRosterWatchHandle(); // replaced (new ino/birthtime) under the watch: watch the new dir
        this._rosterWatchReopen = true; // keep the guard armed if the reopen races the dir away (L1)
        this._ensureRosterWatch();
      }
    } else if (this._rosterWatchReopen && st) {
      this._ensureRosterWatch(); // the dir is back: reopen on it; the reopen flag clears only on success (L1)
    }
    this._ensureRosterWatchGuard(); // reschedule only while the watch (or a pending reopen) is still live
  }

  // Incremental: the folded state keeps the byte offset it has consumed, so a changed log only folds its new tail.
  // Boot: a log not yet folded in this process starts from its saved entry (_seedFold) when that entry is valid.
  _fold(id) {
    let stamp = null;
    let size = 0;
    let stat = null;
    const tm = this._passMs; // recoverQueued's boot pass timing, else null
    const t0 = tm ? performance.now() : 0;
    const statAt = Date.now(); // before the stat: an mtime written meanwhile still counts as racy (fold-index.mjs)
    try { const st = statSync(this.store.file(id)); size = st.size; stamp = `${st.size}:${st.mtimeMs}`; stat = { size: st.size, mtimeMs: st.mtimeMs, at: statAt }; } catch { this.folds.delete(id); this._foldClean.delete(id); this._uncreated.delete(id); return null; } finally { if (tm) tm.stat += performance.now() - t0; }
    // Clean = validated by this stat while the watch is up. Synchronous from the stat to the mark: a change after the stat
    // reaches the watch callback later and unmarks it.
    const watched = !!this._rosterWatch;
    this._foldClean.delete(id);
    let st = this.folds.get(id);
    if (st?.stamp === stamp) { if (watched) this._foldClean.add(id); return st; }
    if (!st && this._uncreated.get(id) === stamp) return null; // already folded at this stamp: no created event (idea-340)
    if (!st && this._foldSeed) {
      const t1 = tm ? performance.now() : 0;
      st = this._seedFold(id, stat);
      if (tm) tm.seed += performance.now() - t1;
      if (st?.stamp === stamp) { this.folds.set(id, st); if (watched) this._foldClean.add(id); return st; }
    }
    if (!st || size < st.offset) st = newFold();
    if (this._foldSeed && this.foldIndexStats) this.foldIndexStats.bytes += Math.max(0, size - st.offset);
    // With the index on, the head/tail probes for the new offset are taken on the fd this read used (no open per log at save).
    const pinAt = this._foldIndexOn() ? (pread, end) => {
      const p = probeWith(pread, end);
      if (p) this._foldPins.set(id, { offset: end, ...p }); else this._foldPins.delete(id);
    } : null;
    const t2 = tm ? performance.now() : 0;
    const { events, end } = this.store.readFrom(id, st.offset, 0, Infinity, pinAt);
    for (const e of events) foldEvent(st, e);
    if (tm) tm.read += performance.now() - t2;
    st.offset = end;
    st.stamp = stamp;
    st.stat = stat;
    if (!st.created) { this.folds.delete(id); this._uncreated.set(id, stamp); return null; }
    this._uncreated.delete(id);
    this.folds.set(id, st);
    if (watched) this._foldClean.add(id);
    st.rec = foldRecord(id, st);
    return st;
  }

  // Loads <foldIndexFile> for the boot pass. Missing, corrupt or another fold version: an empty seed, i.e. a full fold.
  // VS_RUNNER_FOLD_INDEX=0 turns the index off (every boot folds from byte 0 and nothing is saved).
  // A prefoldCold just before (the server's boot) hands over its read of the index plus the entries its workers folded for
  // the logs the index had none for: those join the seed and are validated like any saved entry (seedFromEntry).
  _loadFoldIndex() {
    this._foldSeed = null;
    const pre = this._coldSeed;
    this._coldSeed = null;
    if (!this._foldIndexOn()) return;
    const t0 = Date.now();
    const info = pre ? pre.info : readFoldIndexInfo(this.foldIndexFile);
    const seed = info.entries;
    // saved = entries read from the file; entries = what the pass could seed from (saved + the cold workers'), so trusted +
    // resumed <= entries and trusted + resumed + full = the logs folded (idea-337: the 11-18 line read entries=5457 next to
    // trusted=5600, its 189 cold entries counted in trusted but not in entries).
    const saved = seed.size;
    if (pre) for (const [id, e] of pre.entries) if (!seed.has(id)) seed.set(id, e);
    this.foldIndexStats = { entries: seed.size, saved, trusted: 0, resumed: 0, full: 0, bytes: 0, loadMs: pre ? pre.loadMs : Date.now() - t0 };
    if (info.discardReason) { // the file gave nothing: say why, so a full fold explains itself (idea-328)
      this.foldIndexStats.discardReason = info.discardReason;
      if (info.foldWas !== undefined) Object.assign(this.foldIndexStats, { foldWas: info.foldWas, foldNow: info.foldNow });
    }
    if (pre) this.foldIndexStats.cold = { logs: pre.logs, folded: pre.entries.size, workers: pre.workers, ms: pre.ms };
    this._foldSeed = seed;
  }

  // Boot, before recoverQueued (runner/fold-cold.mjs): the logs the fold index has no entry for (all of them after a fold-code
  // change, which drops the index) are folded on worker threads, so the boot pass serves them as trusted entries instead of
  // folding each from byte 0 on the main thread. Fewer than COLD_FOLD_MIN such logs, no index, or no workers: nothing to do.
  // shutdown() during the prefold terminates its workers (and the prefold then hands nothing over).
  async prefoldCold({ workers = coldFoldWorkersFromEnv(), min = COLD_FOLD_MIN, ...opts } = {}) {
    this._coldSeed = null;
    this._prefoldMs = 0;
    if (this._shutDown || !this._foldIndexOn() || !(workers > 0)) return null;
    const t0 = Date.now();
    const p0 = performance.now();
    const info = readFoldIndexInfo(this.foldIndexFile);
    const seed = info.entries;
    const loadMs = Date.now() - t0;
    const missing = this.store.ids().filter((id) => !seed.has(id));
    let entries = new Map();
    if (missing.length >= min) {
      const ac = new AbortController();
      this._coldAbort = ac;
      try { entries = await coldFoldEntries(this.store.dir, missing, { ...opts, workers, signal: ac.signal }); } finally { if (this._coldAbort === ac) this._coldAbort = null; }
    }
    this._prefoldMs = performance.now() - p0;
    if (this._shutDown) return null;
    this._coldSeed = { info, loadMs, entries, logs: missing.length, workers: entries.size ? Math.min(workers, missing.length) : 0, ms: Date.now() - t0 };
    return { logs: missing.length, folded: entries.size, ms: this._coldSeed.ms };
  }

  _foldIndexOn() { return !!this.foldIndexFile && process.env.VS_RUNNER_FOLD_INDEX !== '0'; }

  // bootFoldMs rounded for the {boot:...} line, or null before recoverQueued. With `phaseMs` (the server's whole 'fold' phase),
  // `rest` is what the named parts leave of it (event-loop turns, GC), so the line accounts for the whole phase. stat/seed/read
  // are parts of pass, not added to it.
  bootFoldReport(phaseMs) {
    const m = this.bootFoldMs;
    if (!m) return null;
    const out = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
    if (Number.isFinite(phaseMs)) out.rest = Math.max(0, Math.round(phaseMs - (m.prefold + m.load + m.pass + m.tokens + m.plans + m.admit)));
    return out;
  }

  // The fold state saved for a log not yet folded in this process, or null (fold from byte 0). A trusted seed (log unchanged)
  // gets the current stamp, so _fold serves it as is; a resumed one has none, so _fold reads only the bytes after its offset.
  // The store's line index is seeded too, so that read (and every append after it) never recounts the lines before the offset.
  _seedFold(id, stat) {
    const e = this._foldSeed.get(id);
    this._foldSeed.delete(id);
    const r = e ? seedFromEntry(this.store.file(id), e, stat) : null;
    const s = this.foldIndexStats;
    if (!r) { if (s) s.full++; return null; }
    const st = r.state;
    this._foldPins.set(id, { offset: r.offset, headLen: e.headLen, head: e.head, tail: e.tail });
    if (r.ix && !this.store.idx.has(id)) this.store.idx.set(id, { size: r.offset, count: r.ix.count, offs: r.ix.offs.slice() });
    if (r.trusted) {
      st.stamp = `${stat.size}:${stat.mtimeMs}`;
      st.stat = stat;
      st.rec = foldRecord(id, st);
      if (s) s.trusted++;
    } else if (s) s.resumed++;
    return st;
  }

  // The index entry of a cached fold, or null (nothing worth saving: no fold, or the log is gone / shorter than the fold; or,
  // with noIo, no probe pinned yet at the fold's offset).
  _foldEntry(id, st, noIo = false) {
    if (!st?.stat || !st.created || !(st.offset > 0) || st.stat.size < st.offset) return null;
    let pin = this._foldPins.get(id);
    if (!pin || pin.offset !== st.offset) {
      if (noIo) return null;
      const p = probe(this.store.file(id), st.offset);
      if (!p) return null;
      pin = { offset: st.offset, ...p };
      this._foldPins.set(id, pin);
    }
    const ix = this.store.idx.get(id);
    return {
      size: st.stat.size, mtimeMs: st.stat.mtimeMs, statAt: st.stat.at, offset: st.offset, headLen: pin.headLen, head: pin.head, tail: pin.tail,
      ix: ix && ix.size === st.offset ? { count: ix.count, offs: ix.offs } : null,
      state: saveFold(st),
    };
  }

  // Folds a racy log again from byte 0, in refoldSliceBytes slices (yielding between them, so the loop never stalls on a big
  // log), into a private state; returns it (published to this.folds) or `st` unchanged. Sound only because:
  //   - it starts only when the log's mtime is older than RACY_MS + 1s, and takes ITS OWN stat first (pre): the new fold carries
  //     that stat, whose mtime then clears the racy test, and the read never goes past pre.size (endCap);
  //   - a restat after the read must equal pre (size AND mtime), else something wrote the log meanwhile: the result is dropped
  //     and the old (racy) fold kept; likewise if another _fold replaced or advanced the cached fold during a yield;
  //   - the line index is dropped first and rebuilt from the bytes (a racy log is the one whose cached count is least trusted).
  // Never throws: any error keeps `st`.
  *_refoldSettled(id, st) {
    try {
      const file = this.store.file(id);
      const at = Date.now();
      const pre = statSync(file);
      if (!(pre.size > 0) || at - pre.mtimeMs <= RACY_MS + 1000) return st;
      const stamp0 = st.stamp;
      this.store.idx.delete(id);
      const nf = newFold();
      let pin = null;
      const pinAt = (pread, end) => { const p = probeWith(pread, end); pin = p ? { offset: end, ...p } : null; };
      for (;;) {
        const { events, end } = this.store.readFrom(id, nf.offset, 0, Infinity, pinAt, this.refoldSliceBytes, pre.size);
        for (const e of events) foldEvent(nf, e);
        if (end <= nf.offset) break; // nothing complete left before pre.size
        nf.offset = end;
        if (end >= pre.size) break;
        yield;
      }
      const post = statSync(file);
      if (post.size !== pre.size || post.mtimeMs !== pre.mtimeMs) return st;
      if (this.folds.get(id) !== st || st.stamp !== stamp0 || !nf.created) return st;
      nf.stamp = `${pre.size}:${pre.mtimeMs}`;
      nf.stat = { size: pre.size, mtimeMs: pre.mtimeMs, at };
      nf.rec = foldRecord(id, nf);
      this.folds.set(id, nf);
      if (this._rosterWatch) this._foldClean.add(id);
      if (pin && pin.offset === nf.offset) this._foldPins.set(id, pin); else this._foldPins.delete(id);
      return nf;
    } catch { return st; }
  }

  // A save, one log per step (a generator: the async save yields between steps). A log appended to since its last fold is
  // folded first (a tail read), so the entry covers what this runner wrote. Past `deadline` (Date.now() ms) no log is read
  // any more: a fold already pinned at its offset is still saved (no I/O; one behind its log keeps its pinned offset and the
  // next boot resumes it), the rest are left out (the next boot folds them from 0). Returns { entries, skipped }.
  *_foldIndexSteps(deadline = Infinity, refold = false) {
    const entries = new Map();
    let n = 0;
    let skipped = 0;
    let racyPending = 0;
    for (const id of this.store.ids()) {
      const late = Date.now() > deadline;
      let st = this.folds.get(id);
      const ix = this.store.idx.get(id);
      const behind = !!(st && ix && ix.size !== st.offset);
      if (behind && !late) { try { st = this._fold(id); } catch { st = null; } }
      // Racy fold (its log's mtime sat within RACY_MS of the stat that recorded it: a live agent was writing as the cold boot
      // folded it): saved as is, the next boot cannot trust it and folds the log from 0 (idea-316: 126 of 5418 logs, the
      // biggest, were 8s of a warm boot). Once the log has settled, fold it again from 0 here, off the boot path, under a stat
      // older than RACY_MS: its entry is then trusted. Async saves only (the shutdown save cannot yield, and is budgeted).
      else if (refold && !late && st?.stat && racy({ mtimeMs: st.stat.mtimeMs, statAt: st.stat.at })) st = yield* this._refoldSettled(id, st);
      let e = null;
      try { e = this._foldEntry(id, st, late); } catch { e = null; }
      if (e) { entries.set(id, e); if (racy(e)) racyPending++; }
      else if (late && st) skipped++;
      if (++n % 32 === 0) yield;
    }
    for (const id of [...this._foldPins.keys()]) if (!entries.has(id)) this._foldPins.delete(id);
    return { entries, skipped, racyPending };
  }

  // Saves every cached fold to foldIndexFile, synchronously (shutdown: the runner lock, and so the next runner's start, waits
  // on it). Bounded: logs not yet probed after budgetMs are left out (a restart inside a cold boot's first async save would
  // otherwise probe every log here). Returns { entries, skipped, result, ms } or null (no index).
  saveFoldIndexSync({ budgetMs = SHUTDOWN_SAVE_BUDGET_MS } = {}) {
    if (!this._foldIndexOn()) return null;
    const t0 = Date.now();
    const g = this._foldIndexSteps(t0 + budgetMs);
    let r = g.next();
    while (!r.done) r = g.next();
    const { entries, skipped } = r.value;
    const result = writeFoldIndex(this.foldIndexFile, serializeFoldIndex(entries));
    return { entries: entries.size, ...(skipped ? { skipped } : {}), result, ms: Date.now() - t0 };
  }

  // saveFoldIndexSync for after boot: yields to the event loop whenever a slice has run for sliceMs (a cold index probes every
  // log once: thousands of opens). Concurrent callers share one save; one that ends after shutdown() writes nothing (shutdown did).
  saveFoldIndex(sliceMs = 8, round = 0) {
    if (!this._foldIndexOn()) return Promise.resolve(null);
    if (this._foldSave) return this._foldSave;
    this._foldSave = (async () => {
      const t0 = Date.now();
      const g = this._foldIndexSteps(Infinity, true);
      let t = Date.now();
      let r = g.next();
      while (!r.done) {
        if (Date.now() - t >= sliceMs) { await new Promise((res) => setImmediate(res)); t = Date.now(); }
        r = g.next();
      }
      const { entries, racyPending } = r.value;
      const result = this._shutDown ? 'shutdown' : writeFoldIndex(this.foldIndexFile, serializeFoldIndex(entries));
      // Entries saved racy whose logs have not settled yet (written within the last seconds, e.g. every agent parked by the
      // previous shutdown): nothing else would save again, so look again once the window has passed. A log still being written
      // stays racy, hence the bounded rounds.
      if (racyPending > 0 && round < RESAVE_ROUNDS && !this._shutDown) {
        clearTimeout(this._resaveTimer);
        this._resaveTimer = setTimeout(() => { this._resaveTimer = null; this.saveFoldIndex(sliceMs, round + 1).catch(() => {}); }, this.resaveDelayMs);
        this._resaveTimer.unref?.();
      }
      return { entries: entries.size, result, ms: Date.now() - t0 };
    })().finally(() => { this._foldSave = null; });
    return this._foldSave;
  }

  timeline(id, after = 0, limit = Infinity) { return this.store.read(id, after, limit); }
  timelineAsync(id, after = 0, limit = Infinity) { return this.store.readAsync(id, after, limit); } // HTTP path: yields between 1 MB slices

  list() { return this.store.ids(); } // names only; use status(id) for details

  // Marks every live agent as exited by the runner, then kills its process tree. Idempotent.
  // keepResumable (the restart script's POST /shutdown): NO exit event, so the next runner can resume every agent. An idle agent
  // with a session is parked (logged); a mid-turn/starting one is stopped with entry.parked=true and its log left as-is, so it
  // reads "lost" afterwards and POST /agents/:id/resume brings it back from its last session id.
  // keepDrainFile: this runner no longer holds runner.lock, so drain.json belongs to the holder: end only this runner's drain.
  shutdown({ keepResumable = false, keepDrainFile = false } = {}) {
    if (this._shutDown) return;
    this._shutDown = true;
    clearTimeout(this._resaveTimer);
    this._resaveTimer = null;
    this._coldAbort?.abort(); // a boot's prefold still folding: its worker threads are terminated
    this._coldAbort = null;
    this._pollAgy?.shutdown();
    this.closeRosterWatch(); // closes the handle and stops the guard timer (idea-594)
    clearInterval(this._quietSweep);
    this._disarmDetachedScan();
    clearTimeout(this._bootReapTimer);
    this._bootReapTimer = null;
    if (keepDrainFile) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
      this._drain = null;
      clearTimeout(this._reqDrainTimer);
      this._reqDrainTimer = null;
      this._reqDrain = null;
    } else { this.clearDrain(); this.clearRequestDrain(); } // the drains end with this runner (their timers and the hook's file)
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
    try { this.foldIndexSave = this.saveFoldIndexSync(); } catch { /* only a cache: the next boot folds what it lacks */ }
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
// A lead retired by a handoff (retirePredecessors / confirmTakeover relabel role to former-lead). old-lead / retired / old
// are the older spellings server/identity.mjs normalizeRoleLabel also reads as former-lead; former-brainstorm etc. are not.
function isRetiredLeadMeta(meta) {
  return [meta?.role, meta?.labels?.role].some((r) => ['former-lead', 'old-lead', 'retired', 'old'].includes(String(r ?? '').trim().toLowerCase()));
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
