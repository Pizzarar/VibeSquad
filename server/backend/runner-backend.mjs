// RunnerBackend: the AgentBackend seam over the VS agent runner's HTTP API (docs/PLAN_OWN_DAEMON.md Block 3).
// squad/team/lane/role/ord/profile are first-class fields on the runner record; this class maps them (and the
// runner's event log) back into the agent shapes callers read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, profileMcpExtras } from "../profiles.mjs";
import { RunnerClient, RunnerHttpError, runnerHome } from "./runner-client.mjs";
import { protectedMetaIn } from "../../runner/runner.mjs";
import { isForbiddenRealHome } from "../test-guard.mjs";
import { joinTarget, joinInto, canExtendThought } from "../reply-coalesce.mjs";
import { pidAlive } from "../../runner/lock.mjs";
import { refreshWhosHere, whosHereKey } from "../whos-here.mjs";

import { createRunnerHookHost } from "./runner-hooks.mjs";
import { PROVIDER_ALIASES } from "../../runner/adapters/acp.mjs";
import { CLAUDE_PERMISSION_MODES as CLAUDE_MODE_IDS, CLAUDE_EFFORTS } from "../../runner/adapters/claude.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Log event types that change the roster row (everything else is timeline-only).
const ROSTER_EVENTS = new Set(["created", "status", "meta", "exit", "archive", "unarchive", "usage", "permission", "session"]);

const FIRST_CLASS = ["squad", "team", "lane", "role", "ord", "profile"];
const ENV_FOR = { lane: "VS_LANE", team: "VS_TEAM", role: "VS_ROLE", profile: "VS_PROFILE" };
const CLAUDE_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const STATUS = { starting: "initializing", queued: "initializing", running: "running", idle: "idle", parked: "idle", exited: "closed", lost: "closed", unknown: "idle" };

// A "turn-progress" event proves a turn ran (assistant output / tool call / status running|idle / usage / turn_done /
// permission / session / resume_fallback). Everything else is setup, lifecycle or noise: meta / stderr / raw / limit
// (the runner's NON_PROGRESS_EVENTS) plus the events the runner appends directly (created/input/status starting|queued|parked/
// parked/error/exit/archive/unarchive/cancel). `lastProgressAt`/`lastPromptAt` are derived from this split for staleness.
const NON_PROGRESS_LOG_EVENTS = new Set(["meta", "stderr", "raw", "limit", "archive", "unarchive", "cancel", "created", "input", "parked", "error", "exit", "park-held", "park-forced", "park-probe-error"]);
export function isTurnProgressEvent(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "status") return e.status === "running" || e.status === "idle";
  return !NON_PROGRESS_LOG_EVENTS.has(e.type);
}

/** Roster work on the serialized live chain waits at most this long on the runner; a timeout takes the same path as a failed fetch. */
const ROSTER_FETCH_MS = 8000;
const SEED_RETRY_BASE_MS = 1000;
const SEED_RETRY_MAX_MS = 10_000;
const bounded =(p, ms = ROSTER_FETCH_MS) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("runner request timed out")), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
};

export const isRunnerId =(id) => typeof id === "string" && id.startsWith("rn-");

/** The runner-client request option for a backend call's opts: only when the caller was given explicitly (null = admin). */
const asCaller = (opts) => (opts && "caller" in opts ? { caller: opts.caller } : {});

// Non-enumerable key on a created agent carrying per-await createAgent timing (ms, in order) so the caller's
// `spawn-timing` metric can print createAgent sub-parts (docs/PLAN_WORKAROUND_FOLLOWUPS.md F1b). Object spread drops it.
export const SPAWN_TIMING = Symbol("spawn-timing");

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * Adapter usage events -> the usage shapes callers read: lastUsage (what lead-handoff / the UI context meter use)
 * and tokenUsage (same numbers, plain). Empty until the adapter has reported one.
 */
function usageFields(u) {
  if (!u || !Number.isFinite(u.contextTokens)) return {};
  const lastUsage = {
    contextWindowUsedTokens: u.contextTokens,
    ...(Number.isFinite(u.contextMax) ? { contextWindowMaxTokens: u.contextMax } : {}),
    inputTokens: u.inputTokens ?? u.contextTokens,
    ...(Number.isFinite(u.outputTokens) ? { outputTokens: u.outputTokens } : {}),
    ...(Number.isFinite(u.costUsd) ? { costUsd: u.costUsd } : {}),
  };
  return { lastUsage, tokenUsage: { ...lastUsage, usedTokens: u.contextTokens } };
}

const MODE_LABELS = { default: "Default", plan: "Plan", acceptEdits: "Accept Edits", auto: "Auto", bypassPermissions: "Bypass Perms", dontAsk: "Don't Ask" };
/** The modes a runner agent really has: claude's permission modes, or what its ACP agent advertised (none until its first session). */
function modesFor(rec) {
  const ids = rec.provider === "claude" ? CLAUDE_MODE_IDS : (rec.offered?.modes ?? []);
  return ids.map((id) => ({ id, label: MODE_LABELS[id] ?? id }));
}

/** Runner status record -> the agent snapshot shape (PaseoAgent) the callers and UI read. */
export function toAgent(rec) {
  const meta = rec.meta ?? {};
  const labels = { ...(meta.labels ?? {}) };
  for (const k of FIRST_CLASS) if (meta[k] !== undefined && meta[k] !== null && meta[k] !== "") labels[k] = String(meta[k]);
  labels.backend = "runner";
  return {
    id: rec.id,
    provider: rec.provider,
    model: rec.model ?? null,
    cwd: rec.cwd,
    title: meta.title || rec.id,
    status: STATUS[rec.status] ?? "idle",
    // Closed-but-resumable (lost, saved session, no exit): the roster/who/send treat it as live. Exposed by the runner's
    // status record from the same predicate as the resume endpoint's 409 (Runner._resumable).
    resumable: rec.resumable === true,
    // Raw runner status 'lost' (restarted, child gone) is flattened to 'closed' above; keep the flag so vs who can
    // print "lost" instead of "closed" for a still-resumable agent.
    lost: rec.status === "lost",
    labels,
    ...(labels["vs.parent"] ? { parentAgentId: labels["vs.parent"] } : {}),
    modeId: meta.permissionMode ?? meta.acpMode ?? (rec.provider === "claude" ? "auto" : null),
    currentModeId: meta.permissionMode ?? meta.acpMode ?? (rec.provider === "claude" ? "auto" : null),
    thinkingOptionId: meta.thinkingOptionId ?? null,
    availableModes: modesFor(rec),
    // Only claude has a thinking/effort knob (--effort); ACP providers get none, so the UI offers none.
    thinkingOptions: rec.provider === "claude" ? CLAUDE_EFFORTS.map((id) => ({ id, label: id })) : [],
    ...(meta.featureValues ? { featureValues: meta.featureValues } : {}),
    ...(rec.queued ? { queued: { ahead: rec.queued.ahead } } : {}),
    requiresAttention: (rec.pendingPermissions ?? []).length > 0,
    pendingPermissions: (rec.pendingPermissions ?? []).map((p) => ({ id: p.id, toolName: p.toolName ?? null })),
    ...usageFields(rec.usage),
    createdAt: iso(rec.createdAt),
    updatedAt: iso(rec.updatedAt ?? rec.createdAt),
    lastActivityAt: iso(rec.updatedAt ?? rec.createdAt),
    ...(rec.lastPromptAt != null ? { lastPromptAt: iso(rec.lastPromptAt) } : {}),
    ...(rec.lastProgressAt != null ? { lastProgressAt: iso(rec.lastProgressAt) } : {}),
    archivedAt: iso(rec.archivedAt),
    workspaceId: null,
    backend: "runner",
  };
}

/**
 * Liveness of the runner process that owns a home: { alive, startedAt } from <home>/runner.json, or null when no
 * runner ever wrote one (then nothing can be said and the log status stands).
 */
function runnerLiveness(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "runner.json"), "utf8"));
    const alive = pidAlive(j.pid);
    return { alive, startedAt: Number.isFinite(j.startedAt) ? j.startedAt : 0 };
  } catch {
    return null;
  }
}

/**
 * Synchronous, read-only view of a runner agent straight from its JSONL log (<runner home>/agents/<id>.jsonl).
 * For callers that cannot await the HTTP API (vs log identity, vs who). Returns the toAgent() snapshot or null.
 */
export function readRunnerAgentSync(id, { env = process.env, home, liveness } = {}) {
  if (!isRunnerId(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(home ?? runnerHome(env), "agents", `${id}.jsonl`), "utf8");
  } catch {
    return null;
  }
  const f = foldRunnerLog(id);
  for (const line of text.split("\n")) f.feed(line);
  return f.finish(home ?? runnerHome(env), env, liveness);
}

const yieldLoop = () => new Promise((r) => setImmediate(r));
const FOLD_YIELD_LINES = 2000; // a multi-MB log must not hold the loop for its whole parse

/** Same snapshot as readRunnerAgentSync, but file read is async and the parse yields to the event loop. */
export async function readRunnerAgent(id, { env = process.env, home, liveness } = {}) {
  if (!isRunnerId(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const h = home ?? runnerHome(env);
  let text;
  try {
    text = await fs.promises.readFile(path.join(h, "agents", `${id}.jsonl`), "utf8");
  } catch {
    return null;
  }
  const f = foldRunnerLog(id);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    f.feed(lines[i]);
    if (i % FOLD_YIELD_LINES === FOLD_YIELD_LINES - 1) await yieldLoop();
  }
  return f.finish(h, env, liveness);
}

/** Incremental fold of one agent log: feed() each line, then finish() for the toAgent() snapshot (null without a created event). */
function foldRunnerLog(id) {
  let created = null;
  let status = "unknown";
  let exited = false;
  let archivedAt = null;
  let last = null;
  let lastLive = null; // last event that proves a child ran: meta/archive appends happen on lost agents too
  let lastPrompt = null; // last input/created event (the "most recent prompt/created" clock for staleness)
  let lastProgress = null; // last turn-progress event (output/tool/status running|idle/usage/…)
  let usage = null;
  let queued = null; // last `queued` status event's ahead count (waiting for a turn slot), like the async status record
  const perms = new Map();
  const meta = {};
  let offered = null;
  let sessionId = null;
  const feed = (line) => {
    if (!line) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    last = e;
    if (e.type !== "meta" && e.type !== "archive") lastLive = e;
    if (e.type === "input" || e.type === "created") lastPrompt = e;
    if (isTurnProgressEvent(e)) lastProgress = e;
    if (e.type === "created") { created = e; Object.assign(meta, e.meta); }
    else if (e.type === "meta") Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
    else if (e.type === "session") {
      if (e.sessionId) sessionId = e.sessionId;
      if (Array.isArray(e.modes)) offered = { modes: e.modes, models: e.models ?? [] };
    }
    else if (e.type === "status") { status = e.status; queued = e.status === "queued" && Number.isInteger(e.ahead) ? { ahead: e.ahead } : null; }
    else if (e.type === "exit") exited = true;
    else if (e.type === "archive") archivedAt = e.ts;
    else if (e.type === "unarchive") archivedAt = null;
    else if (e.type === "usage") usage = e;
    else if (e.type === "permission") { if (e.phase === "request") perms.set(e.id, { id: e.id, toolName: e.toolName }); else perms.delete(e.id); }
  };
  const finish = (home, env, liveness) => {
    if (!created) return null;
    // The log's last status is not liveness (runner/runner.mjs summary: "log says running but no child in this process").
    // A non-parked agent whose last event predates the running runner's start, or whose runner is dead, has no child: lost.
    if (!exited && status !== "parked") {
      const rl = liveness === undefined ? runnerLiveness(home ?? runnerHome(env)) : liveness;
      if (rl && (!rl.alive || (lastLive?.ts ?? 0) < rl.startedAt)) status = "lost";
    }
    // A lost (restarted) agent is resumable in place only when it has a saved session and never exited/archived:
    // the same predicate the runner's resume endpoint (409) applies (_lostSpec/_parkedSpec). Every adapter canPark today.
    const resumable =
      status === "lost" &&
      !archivedAt &&
      typeof sessionId === "string" &&
      sessionId !== "" &&
      !sessionId.startsWith("-");
    return toAgent({
      id, provider: created.provider, model: meta.model ?? created.model, cwd: created.cwd, meta, ...(offered ? { offered } : {}),
      status: exited ? "exited" : status, createdAt: created.ts, updatedAt: last?.ts, archivedAt,
      lastPromptAt: lastPrompt?.ts ?? null, lastProgressAt: lastProgress?.ts ?? null,
      usage, pendingPermissions: [...perms.values()], resumable,
      ...(status === "queued" && !exited && queued ? { queued } : {}),
    });
  };
  return { feed, finish };
}

/** The created event is the log's first line: read just that (never the whole log) for a cheap id -> cwd. */
function parseCreatedCwd(head) {
  const nl = head.indexOf("\n");
  if (nl < 0) return undefined; // longer than the window (or still being written): caller falls back
  try { const e = JSON.parse(head.slice(0, nl)); return e?.type === "created" ? (typeof e.cwd === "string" ? e.cwd : null) : undefined; } catch { return undefined; }
}
const HEAD_BYTES = 16 * 1024;
export function readRunnerCwdSync(id, { env = process.env, home } = {}) {
  if (!isRunnerId(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const file = path.join(home ?? runnerHome(env), "agents", `${id}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const cwd = parseCreatedCwd(buf.toString("utf8", 0, n));
    if (cwd !== undefined) return cwd;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return readRunnerAgentSync(id, { env, home })?.cwd ?? null; // unusual first line: the full fold
}
export async function readRunnerCwd(id, { env = process.env, home } = {}) {
  if (!isRunnerId(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const file = path.join(home ?? runnerHome(env), "agents", `${id}.jsonl`);
  let fh;
  try {
    fh = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const cwd = parseCreatedCwd(buf.toString("utf8", 0, bytesRead));
    if (cwd !== undefined) return cwd;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
  return (await readRunnerAgent(id, { env, home }))?.cwd ?? null;
}

/** Every runner agent on this machine (sync, log-derived). Empty when no runner dir exists. */
export function listRunnerAgentsSync({ env = process.env } = {}) {
  const home = runnerHome(env);
  let names;
  try {
    names = fs.readdirSync(path.join(home, "agents"));
  } catch {
    return [];
  }
  const liveness = runnerLiveness(home); // once for the whole list, not per agent
  return names.filter((f) => f.endsWith(".jsonl")).map((f) => readRunnerAgentSync(f.slice(0, -6), { env, home, liveness })).filter(Boolean);
}

/** listRunnerAgentsSync without blocking the event loop: async reads, small batches, a yield between them. */
export async function listRunnerAgents({ env = process.env, batch = 8 } = {}) {
  const home = runnerHome(env);
  let names;
  try {
    names = await fs.promises.readdir(path.join(home, "agents"));
  } catch {
    return [];
  }
  const liveness = runnerLiveness(home);
  const ids = names.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    const got = await Promise.all(ids.slice(i, i + batch).map((id) => readRunnerAgent(id, { env, home, liveness })));
    for (const a of got) if (a) out.push(a);
    await yieldLoop();
  }
  return out;
}

/** Runner JSONL events -> timeline entries ({ item, timestamp, seqStart, seqEnd }) as the timeline UI expects. */
export function toTimeline(events) {
  const entries = [];
  const toolIdx = new Map();
  for (const e of events) {
    const base = { timestamp: iso(e.ts), seqStart: e.seq, seqEnd: e.seq };
    const last = entries[entries.length - 1];
    switch (e.type) {
      case "input":
        entries.push({ ...base, item: { type: "user_message", text: e.text, ...(e.images ? { images: e.images } : {}) } });
        break;
      case "output": {
        // The log is walked in order and input / tool / error / turn_done are the separators, so no seq arithmetic:
        // stderr / raw / meta lines mid-reply must not split it. Text after a thought rejoins the message before it.
        const next = { ...base, item: { type: "assistant_message", text: e.text } };
        const i = joinTarget(entries, next);
        if (i >= 0) entries[i] = joinInto(entries[i], next, { trailing: entries.slice(i + 1) });
        else entries.push(next);
        break;
      }
      case "thought":
        if (canExtendThought(entries)) {
          last.item.text += e.text;
          last.seqEnd = e.seq;
        } else entries.push({ ...base, item: { type: "reasoning", text: e.text } });
        break;
      case "tool":
        if (e.phase === "call") {
          toolIdx.set(e.id, entries.length);
          entries.push({ ...base, item: { type: "tool_call", callId: e.id, name: e.name ?? "tool", status: "running", detail: { input: e.input, kind: e.kind } } });
        } else {
          const t = entries[toolIdx.get(e.id)];
          if (t) {
            const failed = e.isError || e.status === "failed";
            t.item.status = failed ? "failed" : e.status === "completed" || e.phase === "result" ? "completed" : t.item.status;
            if (failed) t.item.error = "tool failed";
            t.seqEnd = e.seq;
          }
        }
        break;
      case "turn_done":
        if (last) last.turnEnd = true; // a real turn boundary: the next turn's text never rejoins this reply
        break;
      case "error":
        entries.push({ ...base, item: { type: "error", message: e.message } });
        break;
      default:
        break;
    }
  }
  return entries;
}

let promptModule;
/** The Paseo plugin's own pure prompt builder (EVERYONE_LAYER + role pack), so both backends layer identically. */
async function injectedPrefix(role, cwd) {
  if (!["lead", "brainstorm", "worker"].includes(role)) return "";
  try {
    promptModule ??= await import("../hooks/agent-duties.ts");
    return promptModule.injectedPrefix(role, cwd) || "";
  } catch {
    return ""; // prompt layering is best effort: an agent without it is still usable
  }
}

/**
 * Advance one agent's turn state by one runner log event (pure, no I/O); returns the lifecycle event it caused, if any.
 * A prompt (`input`) marks a turn live even before the adapter's first `running` (an ACP adapter failing in initialize /
 * session-new errors in that window while its log status is still unknown), and an error/exit there is a failed turn.
 */
export function reduceTurn(t, e) {
  const inTurn = t.status === "running" || t.status === "initializing" || !!t.awaiting;
  if (e.type === "input") { t.awaiting = true; return null; }
  if (e.type === "error") { if (inTurn) { t.errored = true; t.error = e.message; } return null; }
  if (e.type === "cancel") { if (inTurn) t.cancelled = true; return null; }
  if (e.type === "status" && e.status && e.resume === true) {
    // A prompt-less resume (Runner._settleResume / unwedge): the process came back (or gave up), no turn ran. Never a
    // turn_started/turn_ended. A turn the restart cut is abandoned here, not reported completed (no digest, no takeover).
    t.status = STATUS[e.status] ?? e.status;
    t.queued = undefined;
    if (e.status !== "starting") { t.awaiting = false; t.errored = false; t.error = undefined; t.cancelled = false; }
    return null;
  }
  if (e.type === "status" && e.status) {
    const wasRunning = t.status === "running";
    t.status = STATUS[e.status] ?? e.status;
    t.queued = e.status === "queued" ? { ahead: Number.isInteger(e.ahead) ? e.ahead : 0 } : undefined; // waiting for a turn slot
    if (t.status === "running") {
      t.errored = false; // next turn began
      t.error = undefined;
      t.cancelled = false;
      return wasRunning ? null : { kind: "turn_started" };
    }
    if (inTurn && t.status === "idle") {
      t.awaiting = false;
      const outcome = t.errored ? { kind: "failed", error: { message: String(t.error ?? "turn failed") } } : t.cancelled ? { kind: "cancelled" } : { kind: "completed" };
      return { kind: "turn_ended", turnId: String(e.seq), outcome };
    }
    return null;
  }
  if (e.type === "exit") {
    t.status = "closed";
    t.awaiting = false;
    if (inTurn && (e.error || (e.code ?? 0) !== 0)) t.errored = true; // died mid-turn
    return inTurn ? { kind: "turn_ended", turnId: String(e.seq), outcome: { kind: "failed", error: { message: String(e.error ?? `agent exited (code ${e.code ?? "?"})`) } } } : null;
  }
  return null;
}

/** One stderr line plus a `metric` entry in the team log (same path the runner hook failure uses); never throws. */
export function logRunnerMetric(msg, vsHome = process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad")) {
  console.error(`[vibesquad] ${msg}`);
  try {
    const base = path.resolve(vsHome, "teams", "_unassigned");
    if (isForbiddenRealHome(base)) return; // a test that forgot a temp home must not write the real team log
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(path.join(base, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), agent: "runner", lane: "unassigned", type: "metric", text: msg.slice(0, 240), refs: [] }) + "\n");
  } catch {
    /* the stderr line above is the fallback */
  }
}

/** Never silent: hooks that cannot load mean unlayered runner spawns / dead lifecycle. Say so on stderr and in the team log. */
export function logHooksUnavailable(err) {
  logRunnerMetric(`runner hooks unavailable (${process.version}): ${err?.message ?? err}`);
}

/**
 * Baseline for one agent log without parsing the whole file: read from the tail until a turn boundary (created / status idle / exit),
 * then fold the events after it. Returns { seq, t, archived }.
 */
// Boot catch-up cutoff (enableCatchUp), in the runner home: { ts: the newest runner event this server handled, aliveAt: when
// this server last wrote it (refreshed every SEEN_ALIVE_MS, so an idle server still dates its own end) }.
const SEEN_FILE = "server-seen.json";
const SEEN_FLUSH_MS = 1000; // a hard kill loses at most this much: those events replay once more at the next boot
const SEEN_ALIVE_MS = 60 * 1000;
const TURN_EDGE_EVENTS = new Set(["status", "exit", "archive"]); // persisted synchronously (noteSeen)
export const CATCHUP_MAX_GAP_MS = 30 * 60 * 1000; // a longer outage is not a restart gap: its events stay history
function readSeen(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, SEEN_FILE), "utf8"));
    return Number.isFinite(j?.ts) && Number.isFinite(j?.aliveAt) ? { ts: j.ts, aliveAt: j.aliveAt } : null;
  } catch { return null; }
}

async function scanTail(file, limit = Infinity, cutoffTs = null) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = Math.min((await fh.stat()).size, limit); // `limit`: the size when the baseline began, so later appends stay live events
    for (let want = 64 * 1024; ; want *= 4) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      let lines = buf.toString("utf8").split("\n");
      if (len < size) lines = lines.slice(1); // first line is cut
      let evs = [];
      for (const line of lines) {
        if (!line) continue;
        try { evs.push(JSON.parse(line)); } catch { /* partial last line */ }
      }
      // `cutoffTs`: the last event the previous server handled. Anything appended after it (while no server ran) is not
      // history: the baseline stops before it, so catch-up replays it once (a worker's turn_ended in a restart gap).
      if (cutoffTs !== null) {
        const k = evs.findIndex((e) => Number.isFinite(e.ts) && e.ts > cutoffTs);
        if (k >= 0) evs = evs.slice(0, k);
        if (!evs.length && len < size) continue; // the whole window is newer: read further back
      }
      let b = -1;
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i];
        if (e.type === "created" || e.type === "exit" || (e.type === "status" && e.status === "idle")) { b = i; break; }
      }
      if ((b < 0 || b < 8) && len < size) continue; // boundary (and the few events before it, where an archive may sit) not in this window: read more
      const last = evs[evs.length - 1];
      const seq = last?.seq ?? -1;
      // Runner.archive appends `archive` and then the killed child's exit / error / idle, so it is rarely the last event.
      const archived = evs.reduce((a, e) => (e.type === "archive" ? true : e.type === "unarchive" ? false : a), false);
      const ts = Number.isFinite(last?.ts) ? last.ts : null;
      if (b < 0) return { seq, ts, t: null, archived };
      const e0 = evs[b];
      const t = { status: e0.type === "created" ? "initializing" : e0.type === "exit" ? "closed" : "idle", errored: false };
      for (let i = b + 1; i < evs.length; i++) reduceTurn(t, evs[i]);
      return { seq, ts, t, archived };
    }
  } finally {
    await fh.close();
  }
}

/**
 * The last prompt/created event (`input`/`created`) and the last turn-progress event from a log. Reads a tail window
 * and scans backwards, stopping at the first prompt/created event (anything earlier is an earlier turn). Grows the
 * window (×4) up to the full file so a huge prompt line or a large run of raw/stderr/meta noise does not hide the
 * prompt; the caller only runs this for starting/queued agents, so the cost stays small in practice. Returns
 * { lastPromptAt, lastProgressAt } (either may be null when absent).
 */
export function scanLogProgress(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let lastPrompt = null;
    let lastProgress = null;
    for (let want = 64 * 1024; ; want *= 4) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let lines = buf.toString("utf8").split("\n");
      if (len < size) lines = lines.slice(1); // first line is cut
      let foundPrompt = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "input" || e.type === "created") {
          // The most recent prompt/created event: a progress event seen before it (later in the log) is "since the
          // prompt"; anything earlier belongs to an earlier turn, so stop here.
          lastPrompt = e.ts;
          foundPrompt = true;
          break;
        }
        if (!lastProgress && isTurnProgressEvent(e)) lastProgress = e.ts;
      }
      if (foundPrompt || len >= size) break;
    }
    return { lastPromptAt: lastPrompt, lastProgressAt: lastProgress };
  } finally {
    fs.closeSync(fd);
  }
}

/** Shown status of a tracked agent: "error" while an errored turn has not been followed by a new one. */
const viewStatus = (t) => (t.errored && t.status !== "running" ? "error" : t.status);

const ENSURE_COOLDOWN_MS = 30_000;

export class RunnerBackend {
  /**
   * `hooks`: the lifecycle hook host (server/backend/runner-hooks.mjs). Default: built lazily on the first createAgent (no
   * watcher), unless the caller injected its own `buildPrefix` (tests) or passed `hooks: false`. startRunnerLifecycle() attaches
   * the server's watcher-enabled host with attachHooks().
   */
  constructor({ client = new RunnerClient(), buildPrefix = injectedPrefix, whosHere = refreshWhosHere, rootDir = REPO_ROOT, hooks } = {}) {
    const hooksOff = hooks === false || (hooks === undefined && buildPrefix !== injectedPrefix);
    Object.defineProperty(this, "hooksState", { value: { host: hooks && hooks !== true ? hooks : null, pending: null, off: hooksOff } });
    Object.defineProperty(this, "rc", { value: client });
    Object.defineProperty(this, "buildPrefix", { value: buildPrefix });
    Object.defineProperty(this, "whosHere", { value: whosHere });
    Object.defineProperty(this, "rootDir", { value: rootDir });
    Object.defineProperty(this, "listeners", { value: new Set() });
    Object.defineProperty(this, "progressCache", { value: new Map() }); // rec.id -> { lastSeq, lastPromptAt, lastProgressAt }
    Object.defineProperty(this, "whosFlights", { value: new Map() }); // lane -> { running, queued }: refreshLaneWhosHere coalescing
    Object.defineProperty(this, "rosterFlights", { value: new Map() }); // route -> { seq, p }: the roster read in flight (rosterGet)
    Object.defineProperty(this, "live", { value: { stream: null, chain: Promise.resolve(), turn: new Map(), gen: 0, retry: { timer: null, n: 0 }, seedTimers: new Map(), seeded: new Set(), hwm: null, known: new Map(), archived: new Set(), emitted: new WeakSet() } });
  }

  async connect() {
    await this.rc.requireRunning();
  }

  async close() {}

  /**
   * X1a: a verified agent caller ({ id, token }) is forwarded to the runner, which applies the agent scope rules (team +
   * parent stamped, role checked, protected meta refused). Pass nothing (or caller: null) for the server's own admin call.
   */
  verifyAgent(caller) {
    return this.rc.verifyAgent(caller);
  }

  async createAgent({ config = {}, initialPrompt, prompt, labels = {}, env = {}, caller } = {}) {
    const as = caller !== undefined ? { caller } : {};
    // Per-await spawn timing (docs/PLAN_WORKAROUND_FOLLOWUPS.md F1b): ms since the previous await, so a slow step
    // shows up in the caller's `spawn-timing` metric as createAgent sub-parts. Each mark runs in a finally so a
    // throw mid-spawn keeps the partial timing; it is attached to the returned agent under SPAWN_TIMING (non-
    // enumerable, so the later {...created} merge drops it) and to a thrown error as err[SPAWN_TIMING].
    const timing = { last: Date.now(), parts: {} };
    const mark = (name) => {
      const now = Date.now();
      timing.parts[name] = now - timing.last;
      timing.last = now;
    };
    try {
      try { await this.rc.requireRunning(); } finally { mark("req"); }
      // before("agent.create"): the plugin's prompt layering + spawn guard, in-process so every spawn path (UI, MCP, vs CLI) gets it.
      config = { ...config };
      if (PROVIDER_ALIASES[config.provider]) config.provider = PROVIDER_ALIASES[config.provider]; // the plugin's antigravity-cli guard keys on the canonical id
      let host;
      try { host = await this.hookHost(); } finally { mark("hh"); }
      if (host) {
        const request = {
          config: { ...config },
          env: { ...env },
          prompt: initialPrompt || prompt || undefined,
          ...(Object.keys(labels).length ? { labels: { ...labels } } : {}),
        };
        let hookFailed = false;
        let out;
        try {
          out = await host.before("agent.create", { request }).catch((err) => {
            hookFailed = true;
            console.warn(`[vibesquad] runner spawn hook failed: ${err}`);
            return undefined;
          });
        } finally { mark("hk"); }
        const next = out ?? request;
        config = next.config ?? config;
        env = next.env ?? env;
        labels = next.labels ?? labels;
        // Tell agent.created (another process: the VS server) that this spawn already had its profile enforced here.
        if (!hookFailed) labels = { ...labels, "vs.spawn-configured": "1" };
      }
      const meta = { title: config.title, labels: {} };
      if (config.thinkingOptionId) meta.thinkingOptionId = String(config.thinkingOptionId);
      if (config.featureValues && typeof config.featureValues === "object") meta.featureValues = config.featureValues;
      for (const k of FIRST_CLASS) {
        const v = labels[k] ?? (ENV_FOR[k] ? env[ENV_FOR[k]] : undefined);
        if (v !== undefined && v !== "") meta[k] = v;
      }
      for (const [k, v] of Object.entries(labels)) if (!FIRST_CLASS.includes(k) && v !== undefined) meta.labels[k] = String(v);
      // Opt-in MCP extras (e.g. playwright for UI live checks) come from the profile; an explicit vs.mcp label wins.
      if (meta.profile && meta.labels["vs.mcp"] === undefined) {
        let stored; try { stored = loadProfiles(undefined, { autoSeed: false }).profiles; } catch { /* defaults only */ }
        const extras = profileMcpExtras(meta.profile, stored);
        if (extras.length) meta.labels["vs.mcp"] = extras.join(",");
      }
      // Claude permission modes only mean something to claude; for ACP providers modeId is the agent's own ACP mode.
      if (config.modeId) {
        if (config.provider === "claude") { if (CLAUDE_PERMISSION_MODES.has(config.modeId)) meta.permissionMode = config.modeId; }
        else meta.acpMode = config.modeId;
      }
      let prefix;
      try { prefix = host ? "" : await this.buildPrefix(meta.role || "", config.cwd); } finally { mark("pfx"); }
      const systemPrompt = [prefix, config.systemPrompt].filter(Boolean).join("\n\n") || undefined;
      let id;
      try {
        id = (await this.rc.request("POST", "/agents", {
          provider: config.provider,
          model: config.model,
          cwd: config.cwd,
          prompt: initialPrompt || prompt || undefined,
          systemPrompt,
          meta,
        }, as)).id;
      } finally { mark("post"); }
      let agent;
      try { agent = (await this.fetchAgent(id)).agent; } finally { mark("get"); }
      try { await this.refreshLaneWhosHere(agent.labels?.lane); } finally { mark("whos"); }
      Object.defineProperty(agent, SPAWN_TIMING, { value: timing.parts, enumerable: false, configurable: true });
      return agent;
    } catch (err) {
      try {
        if (err && (typeof err === "object" || typeof err === "function")) {
          Object.defineProperty(err, SPAWN_TIMING, { value: timing.parts, enumerable: false, configurable: true });
        }
      } catch { /* a frozen/non-extensible error: keep the original throw intact */ }
      throw err;
    }
  }

  /** The lifecycle host for this backend, or null when hooks are off. Built once, lazily (no wakeup watcher). */
  hookHost() {
    const st = this.hooksState;
    if (st.host || st.off) return Promise.resolve(st.host);
    st.pending ??= createRunnerHookHost(this).then(
      (host) => (st.host = host),
      (err) => {
        logHooksUnavailable(err);
        st.off = true;
        return null;
      },
    );
    return st.pending;
  }

  /** Install the (watcher-enabled) host the VS server runs; replaces a lazily built one. Returns it. */
  async attachHooks({ startWatcher = true, deps } = {}) {
    const st = this.hooksState;
    const old = st.host ?? (await st.pending?.catch(() => null));
    old?.dispose?.();
    st.off = false;
    st.pending = null;
    st.host = await createRunnerHookHost(this, { startWatcher, deps });
    return st.host;
  }

  detachHooks() {
    const st = this.hooksState;
    st.host?.dispose?.();
    st.host = null;
    st.pending = null;
  }

  /**
   * Keep the lane brief's "Who's here" current (spawn, archive, role/lane move, exit). Best effort.
   * Coalesced per lane (unit-loop-stall): one refresh runs at a time. A caller arriving meanwhile joins it when no write
   * through this client has settled since it started (rc.writeSeq, as rosterGet); otherwise all such callers share ONE
   * rerun that starts after it. A burst of spawns/archives in a lane costs at most two full-roster reads, not one each,
   * and every caller still gets a refresh that read the roster after its own write. No writeSeq: always the rerun.
   */
  refreshLaneWhosHere(lane) {
    if (!lane) return Promise.resolve();
    const flights = this.whosFlights;
    let f = flights.get(lane);
    if (!f) flights.set(lane, (f = { running: null, queued: null, seq: undefined }));
    const seq = this.rc.writeSeq;
    if (f.running && !f.queued && seq !== undefined && f.seq === seq) return f.running;
    if (f.queued) return f.queued;
    const start = () => {
      f.queued = null;
      f.seq = this.rc.writeSeq;
      const p = this.whosHereNow(lane).finally(() => {
        if (f.running === p) f.running = null;
        if (!f.running && !f.queued && flights.get(lane) === f) flights.delete(lane);
      });
      f.running = p;
      return p;
    };
    if (f.running) return (f.queued = f.running.then(start, start));
    return start();
  }

  async whosHereNow(lane) {
    try {
      const agents = await this.listAgents();
      this.whosHere({ laneId: lane, agents, rootDir: this.rootDir });
    } catch {
      /* the brief is cosmetic: never fail a spawn over it */
    }
  }

  /** Best-effort: enrich a runner rec with lastPromptAt/lastProgressAt from its log tail (absent on an unreadable log). */
  progressFor(rec) {
    if (!rec || !rec.id) return rec;
    // isStalePredecessor is the only consumer and returns false for every status but starting/queued; skip the log
    // scan for everything else so a running/idle turn never re-reads its log on every tick.
    if (rec.status !== "starting" && rec.status !== "queued") return rec;
    const cached = this.progressCache.get(rec.id);
    if (cached && cached.lastSeq === rec.lastSeq) {
      // The log has not advanced since the last scan (same lastSeq): reuse it, so repeated ticks don't re-read.
      if (cached.lastPromptAt != null) rec.lastPromptAt = cached.lastPromptAt;
      if (cached.lastProgressAt != null) rec.lastProgressAt = cached.lastProgressAt;
      return rec;
    }
    try {
      const p = scanLogProgress(path.join(this.rc.home, "agents", `${rec.id}.jsonl`));
      this.progressCache.set(rec.id, { lastSeq: rec.lastSeq, ...p });
      if (p.lastPromptAt != null) rec.lastPromptAt = p.lastPromptAt;
      if (p.lastProgressAt != null) rec.lastProgressAt = p.lastProgressAt;
    } catch { /* leave fields absent */ }
    return rec;
  }

  async fetchAgent(id) {
    const rec = await this.rc.request("GET", `/agents/${encodeURIComponent(id)}`);
    return { agent: toAgent(this.progressFor(rec)), project: null };
  }

  async getAgent(id) {
    return (await this.fetchAgent(id)).agent;
  }

  /** Connect-only gate for MCP/CLI/API callers: throws RUNNER_DOWN when the runner is not up, never starts it. */
  requireRunning() {
    return this.rc.requireRunning();
  }

  /**
   * OWNER ONLY (the VS server's runner supervisor): start the runner if it is down. Single-flight, and not again for a while
   * after a failed start. Resolves true when a runner is up afterwards.
   */
  startOwned({ force = false } = {}) {
    // force (explicit owner-confirmed restart): drop the failure cooldown and any in-flight start, which may be waiting on a runner we just killed.
    if (force) {
      this.ensureFailedAt = 0;
      this.ensuring = null;
      this.rc.starting = null;
    }
    if (this.ensuring) return this.ensuring;
    if (Date.now() - (this.ensureFailedAt ?? 0) < ENSURE_COOLDOWN_MS) return Promise.resolve(false);
    const p = Promise.resolve()
      .then(() => this.rc.startOwned())
      .then(
        () => true,
        () => {
          this.ensureFailedAt = Date.now();
          return false;
        },
      )
      .finally(() => {
        if (this.ensuring === p) this.ensuring = null;
      });
    this.ensuring = p;
    return p;
  }

  async fetchAgents(opts = {}) {
    const includeArchived = opts?.filter?.includeArchived;
    const recs = await this.fetchAllRecs(undefined, { archived: !!includeArchived });
    // Archived records are dropped before toAgent (most of a long-lived roster is archived; converting them all on every
    // read was a hot spot on the server loop). Same result: toAgent's archivedAt is set exactly when rec.archivedAt is a number.
    const entries = recs
      .filter((r) => r && (includeArchived || !Number.isFinite(r.archivedAt)))
      .map((r) => ({ agent: toAgent(r), project: null }));
    return { entries };
  }

  async listAgents(opts) {
    return (await this.fetchAgents(opts)).entries.map((e) => e.agent);
  }

  /**
   * opts: { senderId (calling agent, for the retired-lead redirect), images: [{ data (base64), mimeType }], activeTurnBehavior:
   * 'steer' (default) | 'interrupt', owner (a human UI/`vs send` turn that jumps the queue), caller ({ id, token }: forwarded to
   * the runner, which then sets owner/senderId from the verified caller and scopes the send; see X1a), steerOnly (idea-169: join
   * the agent's open turn or drop it; never starts, resumes or revives a turn) }.
   * Returns the runner's answer for a steerOnly send ({ delivered, reason? }), so the caller learns whether it was dropped.
   */
  async sendAgentPrompt(id, text, opts = {}) {
    const as = "caller" in opts ? { caller: opts.caller } : {};
    // An agent (opts.senderId) writing to a retired Lead/Buddy is redirected to the live one (plugin handleSendAgentPrompt).
    if (opts.senderId) {
      const host = await this.hookHost();
      const res = host
        ? await host.before("send_agent_prompt", { agentId: id, senderAgentId: opts.senderId, prompt: text }).catch((err) => {
            if (/is retired and no live/.test(String(err?.message ?? err))) throw err; // the sender must see "no live lead", not a delivery to the retired one
          })
        : undefined;
      if (res?.redirected) return { redirectedTo: res.targetAgentId ?? res.agentId }; // the sender must learn the message went to the successor
    }
    const body = { text };
    if (opts.images?.length) body.images = opts.images;
    if (opts.activeTurnBehavior) body.activeTurnBehavior = opts.activeTurnBehavior;
    if (opts.owner) body.owner = true;
    if (opts.steerOnly) {
      body.steerOnly = true;
      // No revive (an archived worker is not in a turn) and no retry: a steer-only input never brings an agent back.
      return await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/input`, body, as);
    }
    const post = () => this.rc.request("POST", `/agents/${encodeURIComponent(id)}/input`, body, as);
    // A worker closed by the done-report path (role=worker + vs.auto-archived) is archived but resumable: a follow-up brings it back
    // first, because the runner refuses to resume an archived agent. Retired leads / Buddies and manually archived agents are never revived.
    // The unarchive is the gated step (an agent caller needs unarchive rights on the worker: its lead, its parent, the Overlord);
    // clearing the auto-archived marker afterwards is this backend's own bookkeeping (vs.auto-archived is admin-only meta).
    const revive = async () => {
      const a = (await this.fetchAgent(id)).agent;
      if (!a.archivedAt || a.labels?.role !== "worker" || a.labels?.["vs.auto-archived"] !== "1") return false;
      await this.unarchiveAgent(id, as);
      await this.updateAgent(id, { labels: { "vs.auto-archived": "" } }, { caller: null }).catch(() => {});
      return true;
    };
    if (this.live.archived.has(id)) await revive().catch(() => false);
    try {
      await post();
    } catch (err) {
      if (!/not running/.test(String(err?.message ?? err)) || !(await revive().catch(() => false))) throw err;
      await post();
    }
  }

  async fetchAgentTimeline(id, opts = {}) {
    const { events } = await this.rc.request("GET", `/agents/${encodeURIComponent(id)}/timeline`);
    let entries = toTimeline(events);
    if (opts.direction === "before" && opts.cursor) entries = entries.filter((e) => e.seqStart < opts.cursor.seq);
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : entries.length;
    // The newest row can be a thought while the reply it belongs to grew in an earlier row, so change-detection
    // (runnerBridge poll) reads the highest seq across all rows, not the last row's.
    const lastSeq = entries.reduce((m, e) => Math.max(m, e.seqEnd ?? -1), -1);
    const hasOlder = entries.length > limit;
    entries = entries.slice(-limit);
    const first = entries[0];
    return { entries, hasOlder, lastSeq, startCursor: first ? { epoch: "runner", seq: first.seqStart } : null };
  }

  async getAgentTimeline(id) {
    return (await this.fetchAgentTimeline(id)).entries;
  }

  async cancelAgent(id, opts = {}) {
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/cancel`, {}, asCaller(opts));
  }

  async archiveAgent(id, opts = {}) {
    const lane = (await this.fetchAgent(id).catch(() => null))?.agent.labels?.lane;
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/archive`, {}, asCaller(opts));
    await this.deleteHeartbeat(id).catch(() => {}); // an archived agent's self-heartbeats would otherwise fire at it forever
    await this.refreshLaneWhosHere(lane);
    return { archivedAt: new Date().toISOString() };
  }

  /** Brings an archived agent back to the roster as it was (closed/idle history, no resume). */
  async unarchiveAgent(id, opts = {}) {
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/unarchive`, {}, asCaller(opts));
    await this.refreshLaneWhosHere((await this.fetchAgent(id).catch(() => null))?.agent.labels?.lane);
    return { archivedAt: null };
  }

  /** opts.caller: an agent caller may not set protected keys (role/lane/team/ord/profile, digestFor, vs.parent, ...): 403 before any request. */
  async updateAgent(id, { name, labels } = {}, opts = {}) {
    const patch = {};
    if (name) patch.title = name;
    if (labels) {
      patch.labels = {};
      for (const [k, v] of Object.entries(labels)) {
        if (FIRST_CLASS.includes(k)) patch[k] = v;
        else patch.labels[k] = String(v);
      }
    }
    if (opts.caller?.id) {
      const hit = protectedMetaIn(patch);
      if (hit) throw new RunnerHttpError(403, `an agent may not set ${hit.join(", ")} (admin only)`);
    }
    // role / lane changes (a Lead or Buddy retiring to former-*) change who is listed
    const mayMove = patch.role !== undefined || patch.lane !== undefined || patch.labels?.role !== undefined;
    // Callers often re-send the full label set with role/lane unchanged (a lead handoff re-points every open worker this
    // way): only a write that changes what Who's here reads pays for the full-roster re-read (unit-loop-stall: repoint 41s).
    const before = mayMove ? whosHereKey((await this.fetchAgent(id).catch(() => null))?.agent) : null;
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/meta`, patch, asCaller(opts));
    if (mayMove) {
      const after = (await this.fetchAgent(id).catch(() => null))?.agent;
      if (before === null || before !== whosHereKey(after)) await this.refreshLaneWhosHere(after?.labels?.lane);
    }
  }

  /**
   * Live model / mode / thinking change: a meta patch the runner folds into the NEXT turn's process args (process per turn).
   * Resolves { appliesFrom: "next-turn", busy } (busy = a turn is running now and keeps its old settings); the runner
   * rejects values the provider cannot take (400 -> thrown here with its message).
   */
  async setAgentConfig(id, { model, modeId, thinkingOptionId } = {}, opts = {}) {
    const body = {};
    if (model !== undefined) body.model = model;
    if (modeId !== undefined) body.modeId = modeId;
    if (thinkingOptionId !== undefined) body.thinkingOptionId = thinkingOptionId;
    const r = await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/config`, body, asCaller(opts));
    return { appliesFrom: r?.appliesFrom ?? "next-turn", busy: !!r?.busy };
  }

  /** Reopens a closed agent in place when the runner can resume it (lost or parked with a saved session): same id, same history. */
  async refreshAgent(id, opts = {}) {
    const agent = (await this.fetchAgent(id)).agent;
    if (agent.status !== "closed" || agent.archivedAt) return agent;
    try {
      await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/resume`, {}, asCaller(opts));
    } catch (err) {
      if (err?.status === 409) return agent; // not resumable (exited, no session): the caller replaces it
      throw err; // runner down / agent cap / IPC failure: surface it, don't replace a resumable Buddy
    }
    return (await this.fetchAgent(id)).agent;
  }

  async detachAgent() {}
  /** Heartbeats are VS schedules with a self target; the runner has no daemon-side store, so drop them from schedules.json. */
  async deleteHeartbeat(agentId) {
    const { sharedSchedules } = await import("../schedules.mjs");
    (await sharedSchedules()).deleteHeartbeat(agentId);
  }

  /**
   * Live runner events (one shared SSE stream, opened on the first listener and closed with the last):
   *   { kind: 'connected' | 'disconnected' }
   *   { kind: 'roster', agents }                      full roster, on every (re)connect
   *   { kind: 'agent', agent }                        roster upsert
   *   { kind: 'remove', agentId }                     archived
   *   { kind: 'status', agentId, from, to, agent }    e.g. running -> idle | error
   *   { kind: 'permission', agentId, request }
   *   { kind: 'timeline', agentId, seq, type }        a timeline entry was appended
   *   { kind: 'created' | 'turn_started', agentId, agent }
   *   { kind: 'turn_ended', agentId, agent, turnId, outcome }   outcome: { kind: 'completed' | 'cancelled' } | { kind: 'failed', error: { message } }
   * Returns the unsubscribe.
   */
  subscribeEvents(listener) {
    this.listeners.add(listener);
    if (!this.live.stream) {
      this.live.stream = this.rc.stream({
        onOpen: () => {
          clearTimeout(this.live.retry.timer); // a fresh open seeds at once and restarts the backoff
          this.live.retry.n = 0;
          this.enqueue((gen) => this.seedRoster(gen));
        },
        onClose: () => this.emitEvent({ kind: "disconnected" }),
        // The timeline emit never waits behind roster fetches on the chain: the browser refetches on it, so it goes out at once.
        onMessage: (m) => {
          this.emitTimeline(m);
          this.enqueue((gen) => this.handleLogEvent(m, gen));
        },
      });
    }
    // The first roster a listener sees comes through the same chain as live events, so a slow listAgents() can never
    // land after a newer agent event. Runner unreachable = "disconnected", never an empty roster (clients keep their agents).
    this.enqueue((gen) => this.seedListener(listener, gen));
    return () => {
      this.listeners.delete(listener);
      clearTimeout(this.live.seedTimers.get(listener));
      this.live.seedTimers.delete(listener);
      this.live.seeded.delete(listener);
      if (!this.listeners.size && this.live.stream) {
        this.live.stream.close();
        this.live.stream = null;
        clearTimeout(this.live.retry.timer);
        this.live.retry.n = 0;
        for (const t of this.live.seedTimers.values()) clearTimeout(t);
        this.live.seedTimers.clear();
        this.live.seeded.clear();
        this.live.gen++; // work already queued on the chain belongs to the closed stream: drop its results
        this.live.turn.clear();
      }
    };
  }

  enqueue(fn) {
    const gen = this.live.gen;
    this.live.chain = this.live.chain.then(() => (gen === this.live.gen ? fn(gen) : undefined)).catch(() => {});
  }

  /** Emits the { kind: 'timeline' } event for a log message once (live path emits it ahead of the chain; handleLogEvent then skips it). */
  emitTimeline({ id, event: e }) {
    if (!id || !e || this.live.emitted.has(e)) return;
    this.live.emitted.add(e);
    this.emitEvent({ kind: "timeline", agentId: id, seq: e.seq, type: e.type });
  }

  emitEvent(ev) {
    for (const fn of [...this.listeners]) {
      try { fn(ev); } catch { /* a bad listener must not stop the others */ }
    }
  }

  /** Sink for per-listener seed retry lines (server log + team-log metric under the backend home); tests may replace it. */
  seedLog(msg) { logRunnerMetric(msg, path.dirname(this.rc.home)); } // rc.home is <vibesquad home>/runner

  /** A listed agent with the in-memory "error" overlay (the runner log itself only knows running/idle). */
  overlay(agent) {
    return this.live.turn.get(agent.id)?.errored && agent.status !== "running" ? { ...agent, status: "error" } : agent;
  }

  /** Initial roster for one new listener (the stream's shared status map is seeded by seedRoster on open).
   *  A failed first fetch is retried for this listener alone (1s..10s backoff) until it gets roster + connected; leaving or a gen change cancels it. */
  async seedListener(listener, gen, attempt = 0, started = Date.now()) {
    let agents;
    try { agents = await bounded(this.listAgents()); } catch { agents = null; }
    if (gen !== this.live.gen || !this.listeners.has(listener) || this.live.seeded.has(listener)) return; // seedRoster may have seeded it meanwhile
    if (agents) this.live.seeded.add(listener);
    try {
      if (agents) {
        listener({ kind: "roster", agents: agents.map((a) => this.overlay(a)) });
        listener({ kind: "connected" });
      } else listener({ kind: "disconnected" });
    } catch { /* a bad listener must not stop the chain */ }
    if (agents) {
      if (attempt > 0) this.seedLog(`seed recovered: attempts=${attempt + 1} elapsed=${Date.now() - started}ms`);
      return;
    }
    const base = this.live.retry.base ?? SEED_RETRY_BASE_MS; // tests shrink it
    const delay = Math.min(this.live.retry.base ? base * 8 : SEED_RETRY_MAX_MS, base * 2 ** attempt);
    clearTimeout(this.live.seedTimers.get(listener));
    const t = setTimeout(() => {
      this.live.seedTimers.delete(listener);
      if (gen === this.live.gen && this.listeners.has(listener) && !this.live.seeded.has(listener)) {
        this.seedLog(`seed retry: attempt=${attempt + 1} elapsed=${Date.now() - started}ms`);
        this.enqueue((g) => this.seedListener(listener, g, attempt + 1, started));
      }
    }, delay);
    t.unref?.();
    this.live.seedTimers.set(listener, t);
  }

  /** On (re)connect: remember every agent's status (so the first transition after it is detected) and publish the full roster. */
  async seedRoster(gen) {
    let agents;
    let recs = null;
    try {
      if (this.live.hwm) {
        recs = await bounded(this.fetchRecs());
        agents = recs.filter((r) => !r.archivedAt).map((r) => toAgent(r));
      } else agents = await bounded(this.listAgents());
    } catch { agents = null; }
    if (gen !== this.live.gen) return;
    if (!agents) {
      this.emitEvent({ kind: "disconnected" });
      return this.scheduleSeedRetry(gen);
    }
    this.live.retry.n = 0;
    // Lifecycle mode keeps turn state purely from the events it has consumed (baseline scan + replay): never re-seeded from tail-of-log status.
    if (!this.live.hwm) {
      const next = new Map();
      for (const a of agents) {
        const prev = this.live.turn.get(a.id);
        next.set(a.id, { status: a.status, errored: !!prev?.errored && a.status !== "running", queued: a.queued });
      }
      this.live.turn = next;
    } else for (const a of agents) this.live.known.set(a.id, a);
    for (const t of this.live.seedTimers.values()) clearTimeout(t); // every listener gets this roster: their own retries are moot
    this.live.seedTimers.clear();
    for (const l of this.listeners) this.live.seeded.add(l);
    this.emitEvent({ kind: "roster", agents: agents.map((a) => this.overlay(a)) });
    this.emitEvent({ kind: "connected" });
    if (recs) await this.catchUp(gen, recs);
  }

  /** A failed seed on an open stream is retried (1s, 2s, 4s ... capped at 10s) until it lands; closing the stream cancels it. */
  scheduleSeedRetry(gen) {
    const r = this.live.retry;
    clearTimeout(r.timer);
    const base = r.base ?? SEED_RETRY_BASE_MS; // tests shrink it
    const delay = Math.min(r.base ? base * 8 : SEED_RETRY_MAX_MS, base * 2 ** r.n);
    r.n++;
    r.timer = setTimeout(() => {
      r.timer = null;
      if (gen === this.live.gen && this.live.stream) this.enqueue((g) => this.seedRoster(g));
    }, delay);
    r.timer.unref?.();
  }

  /** Raw runner records, skipping agents the baseline saw archived (their logs are never read again). */
  async fetchRecs() {
    return this.fetchAllRecs(this.live.archived);
  }

  /**
   * Every runner record in one call (GET /agents?full=1); a runner without it only answers { ids }, so fall back to one GET per id.
   * archived: false asks the runner to leave archived records out (archived=0; an older runner ignores it and callers filter anyway).
   * Records are shared by concurrent callers (see rosterGet): treat them as read-only.
   */
  async fetchAllRecs(skip = new Set(), { archived = true } = {}) {
    const recs = await this.rosterGet(archived ? "/agents?full=1" : "/agents?full=1&archived=0");
    return skip.size ? recs.filter((r) => !skip.has(r.id)) : recs;
  }

  /**
   * One roster read in flight per route: callers that arrive while it runs share its parsed answer instead of each paying the
   * runner's serialise + this loop's JSON.parse of the whole roster (a spawn reads it 4-6 times; many at once stalled the server
   * loop for seconds, unit-loop-stall). A caller only joins a read that started after the last write through this client
   * settled (rc.writeSeq), so a caller always sees its own create/archive/meta change. No caching once the read has answered.
   */
  rosterGet(route) {
    const flights = this.rosterFlights;
    const seq = this.rc.writeSeq;
    const cur = flights.get(route);
    if (cur && seq !== undefined && cur.seq === seq) return cur.p;
    const p = (async () => {
      const res = await this.rc.request("GET", route);
      if (Array.isArray(res.agents)) return res.agents.filter(Boolean).map((r) => this.progressFor(r));
      const recs = await Promise.all((res.ids ?? []).map((id) => this.rc.request("GET", `/agents/${encodeURIComponent(id)}`).catch(() => null)));
      return recs.filter(Boolean).map((r) => this.progressFor(r));
    })();
    const flight = { seq, p };
    flights.set(route, flight);
    const done = () => { if (flights.get(route) === flight) flights.delete(route); };
    p.then(done, done);
    return p;
  }

  /**
   * Lifecycle catch-up (server process only). A tail scan of every agent's log gives its turn state and high-water mark (history is
   * never replayed, so a server restart does not re-fire digests, handoffs or wakeups); from then on each event is handled once
   * (live or replayed) and every (re)connect of the event stream replays what was appended while it was not connected (the
   * cold-start race: the runner boots and the first agent's created / input / status events land before /events connects).
   * Turn state survives reconnects: it only ever advances by consuming events.
   * History ends where the previous server stopped handling events (<runner home>/server-seen.json, written as events are
   * handled), not at boot: events from the restart gap replay once (idea-88: a worker that finished while the server was down
   * got no digest and its lead no wake). A gap over CATCHUP_MAX_GAP_MS, or no file, falls back to "everything is history".
   */
  enableCatchUp({ now = Date.now(), maxGapMs = CATCHUP_MAX_GAP_MS } = {}) {
    const hwm = new Map();
    const turn = new Map();
    const archived = new Set();
    this.live.hwm = hwm;
    this.live.turn = turn;
    this.live.archived = archived;
    this.live.known = new Map();
    const seen = typeof this.rc?.home === "string" ? readSeen(this.rc.home) : null;
    const cutoff = seen && seen.aliveAt <= now && now - seen.aliveAt <= maxGapMs ? seen.ts : null;
    this.live.seenTs = cutoff ?? 0;
    // A re-init on the same instance (stopRunnerLifecycle + startRunnerLifecycle) starts from this baseline only: a throttled
    // write of the previous run must not land later, and noteSeen must not compare with the previous run's last write.
    clearTimeout(this.live.seenTimer);
    this.live.seenTimer = null;
    this.live.seenFlushed = 0;
    if (!this.live.seenAlive) {
      this.live.seenAlive = setInterval(() => this.flushSeen(), SEEN_ALIVE_MS);
      this.live.seenAlive.unref?.();
    }
    // The tail scan is async and batched (it ran sync over every log at boot and stalled the loop); `ready` settles when the
    // baseline is complete. Callers that need it (startRunnerLifecycle) await it before opening the event stream.
    const dir = path.join(this.rc.home, "agents");
    // Sizes are taken in quick batches of concurrent stats at the very start (tens of ms in total, yielding between batches): the batched scan below reads each log
    // only up to that size, so an event appended during the ~second-long scan stays a live/replayed event instead of becoming history.
    // A log created after its stat has no hwm entry and replays from seq 0.
    this.live.baseline = (async () => {
      const sizes = new Map();
      try {
        const names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        for (let i = 0; i < names.length; i += 128) {
          await Promise.all(names.slice(i, i + 128).map((f) => fs.promises.stat(path.join(dir, f)).then((st) => sizes.set(f, st.size), () => {})));
          await new Promise((r) => setImmediate(r));
        }
      } catch { /* no runner dir yet: every agent is new */ }
      const files = [...sizes.keys()];
      for (let i = 0; i < files.length; i += 16) {
        await Promise.all(files.slice(i, i + 16).map(async (f) => {
          const id = f.slice(0, -6);
          let r;
          try { r = await scanTail(path.join(dir, f), sizes.get(f), cutoff); } catch { return; }
          hwm.set(id, r.seq);
          if (r.ts !== null && r.ts > this.live.seenTs) this.live.seenTs = r.ts; // the newest history event: what this server starts from
          if (r.archived) archived.add(id);
          else if (r.t) turn.set(id, r.t);
        }));
        await new Promise((r) => setImmediate(r));
      }
      this.flushSeen();
    })();
    // Everything that reads hwm/turn/archived (seed, replay, live events) runs on the chain: hold it until the baseline is complete.
    this.live.chain = this.live.chain.then(() => this.live.baseline).catch(() => {});
    return this.live.baseline;
  }

  /**
   * Records the newest handled event's ts for the next boot's baseline (enableCatchUp); written at most every SEEN_FLUSH_MS.
   * sync: a turn-edge event (status / exit / archive: the only ones that open or close a turn) is written at once, BEFORE
   * its lifecycle events reach the hooks, so a hard kill right after a digest/wake was dispatched can never replay that
   * turn_ended into a second digest. The cost is at-most-once: a kill between this write and the dispatch drops it.
   */
  noteSeen(ts, { sync = false } = {}) {
    if (Number.isFinite(ts) && ts > (this.live.seenTs ?? 0)) this.live.seenTs = ts;
    // Compare with what is ON DISK, not with seenTs: a throttled event in the same ms (turn_done right before its idle)
    // already raised seenTs, and returning on ts <= seenTs then skipped the idle's sync write (the cold-start replay).
    if ((this.live.seenTs ?? 0) <= (this.live.seenFlushed ?? 0)) return;
    if (sync) {
      clearTimeout(this.live.seenTimer);
      this.live.seenTimer = null;
      this.flushSeen();
      return;
    }
    if (this.live.seenTimer) return;
    this.live.seenTimer = setTimeout(() => { this.live.seenTimer = null; this.flushSeen(); }, SEEN_FLUSH_MS);
    this.live.seenTimer.unref?.();
  }

  flushSeen() {
    const home = this.rc?.home;
    if (!this.live.seenTs || typeof home !== "string" || !home) return; // an injected client without a home has nowhere to keep it
    if (isForbiddenRealHome(home)) return; // a test that forgot a temp home must not move the live server's cutoff
    const file = path.join(home, SEEN_FILE);
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ts: this.live.seenTs, aliveAt: Date.now(), pid: process.pid }));
      fs.renameSync(`${file}.tmp`, file);
      this.live.seenFlushed = this.live.seenTs;
    } catch { /* best effort: a missing file only means the next boot treats the gap as history (the old behaviour) */ }
  }

  /** Replay events newer than the high-water mark, agents in creation order (new agents replay from seq 0). */
  async catchUp(gen, recs) {
    const hwm = this.live.hwm;
    if (!hwm) return;
    const todo = recs.filter((r) => r.lastSeq > (hwm.get(r.id) ?? -1)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : 1));
    for (const rec of todo) {
      if (gen !== this.live.gen) return;
      const id = rec.id;
      let events;
      try { ({ events } = await bounded(this.rc.request("GET", `/agents/${encodeURIComponent(id)}/timeline?after=${(hwm.get(id) ?? -1) + 1}`))); } catch { continue; }
      for (const event of events) await this.handleLogEvent({ id, event }, gen);
    }
  }

  /**
   * The shown status comes from the log events themselves, applied in log order on the serialized chain, never from
   * fetchAgent's tail-of-log status (which may already include events still queued behind this one).
   */
  async handleLogEvent({ id, event: e }, gen = this.live.gen) {
    if (!id || !e) return;
    const hwm = this.live.hwm;
    if (hwm) {
      if (e.seq <= (hwm.get(id) ?? -1)) return; // already handled (replayed at connect, or history before startup)
      hwm.set(id, e.seq);
      this.noteSeen(e.ts, { sync: TURN_EDGE_EVENTS.has(e.type) });
    }
    this.emitTimeline({ id, event: e });
    if (e.type === "compacted") logRunnerMetric(`compacted agent=${id} before=${e.before ?? "?"} after=${e.after ?? "?"}${e.trigger ? ` trigger=${e.trigger}` : ""}`); // once per event: the hwm gate above drops replays
    const t0 = this.live.turn.get(id);
    const from = t0 && viewStatus(t0);
    // Archive is terminal. The killed child's exit / error / idle land AFTER the archive event: they must not resurrect the roster
    // row, but they may still close a turn that was open when the agent was archived (once).
    if (this.live.archived.has(id) && e.type !== "archive") {
      const closing = t0 ? reduceTurn(t0, e) : null;
      if (closing) {
        this.live.turn.delete(id);
        this.emitEvent({ ...closing, agentId: id, agent: await this.snapshotFor(id, e) });
      }
      return;
    }
    if (!ROSTER_EVENTS.has(e.type)) {
      if (t0) reduceTurn(t0, e); // input / error / cancel only move turn state
      return;
    }
    if (e.type === "unarchive") {
      this.live.archived.delete(id);
      const agent = (await bounded(this.fetchAgent(id)).catch(() => null))?.agent;
      if (agent) {
        this.live.known.set(id, agent);
        this.emitEvent({ kind: "agent", agent: this.overlay(agent) });
      }
      return;
    }
    if (e.type === "archive") {
      this.live.archived.add(id);
      if (t0 && !(t0.status === "running" || t0.status === "initializing" || t0.awaiting)) this.live.turn.delete(id); // an open turn is kept until its exit closes it
      this.emitEvent({ kind: "remove", agentId: id });
      return;
    }
    // A new agent is seeded from its own "created" event, never from a fetch (which already shows later log state), so its
    // first status event is seen as the transition it is. Turn state advances before the fetch so a failed fetch loses nothing.
    let t = e.type === "created" ? { status: "initializing", errored: false } : t0;
    let lifecycle = null;
    if (t) {
      lifecycle = reduceTurn(t, e);
      this.live.turn.set(id, t);
    }
    let agent;
    try {
      agent = (await bounded(this.fetchAgent(id))).agent;
      if (hwm) this.live.known.set(id, agent);
    } catch {
      // Runner hiccup. In lifecycle mode this event's seq is already consumed, so the transition must still be emitted: with the
      // best snapshot we have (never a label-less one if any source knows the labels). Elsewhere the next event resyncs.
      if (!hwm) return;
      agent = await this.snapshotFor(id, e);
    }
    if (gen !== this.live.gen) return;
    if (!t) {
      // A non-status event (meta/usage/session/permission) with no prior turn state: seed the turn from the fetch,
      // but keep the fetch's `queued` so a queued agent read here is not stripped below (the log's own status events
      // set t.queued; a meta/usage event before any status would otherwise wipe it).
      t = { status: agent.status, errored: false, ...(agent.queued ? { queued: agent.queued } : {}) };
      lifecycle = reduceTurn(t, e);
      this.live.turn.set(id, t);
    }
    const to = viewStatus(t);
    const { queued: _fetchedQueue, ...agentNoQueue } = agent; // the event stream, not the (possibly newer) fetch, decides the queued label
    const shown = { ...agentNoQueue, status: to, ...(t.queued ? { queued: t.queued } : {}) };
    this.emitEvent({ kind: "agent", agent: shown });
    if (e.type === "created") this.emitEvent({ kind: "created", agentId: id, agent: shown });
    if (lifecycle) this.emitEvent({ ...lifecycle, agentId: id, agent: shown });
    if (from !== undefined && from !== to) this.emitEvent({ kind: "status", agentId: id, from, to, agent: shown });
    if (e.type === "permission" && e.phase === "request") this.emitEvent({ kind: "permission", agentId: id, agent: shown, request: { id: e.id, toolName: e.toolName } }); // snapshot lets watch-sets see an already auto-resolved request (ACP) is not pending
    if (e.type === "exit") await this.refreshLaneWhosHere(agent.labels?.lane);
  }

  /** Best available snapshot when the roster fetch failed: last known, else the log itself, else one built from the created event (cached). */
  async snapshotFor(id, e) {
    const known = this.live.known.get(id);
    if (known) return known;
    try {
      const fresh = (await bounded(this.fetchAgent(id))).agent;
      this.live.known.set(id, fresh);
      return fresh;
    } catch { /* fall through */ }
    let agent = await readRunnerAgent(id, { home: this.rc.home });
    if (!agent && e?.type === "created") agent = toAgent({ id, provider: e.provider, model: e.model, cwd: e.cwd, meta: e.meta, status: "starting", createdAt: e.ts, updatedAt: e.ts });
    if (agent) this.live.known.set(id, agent);
    return agent ?? { id, title: id, labels: { backend: "runner" }, status: "idle", backend: "runner" };
  }

  /** AgentBackend.subscribe shape (what server/push.mjs reads): agent_update / agent_permission_request / agent_deleted. */
  subscribe(cb) {
    return this.subscribeEvents((ev) => {
      if (ev.kind === "agent") cb({ type: "agent_update", agentId: ev.agent.id, payload: { agent: ev.agent } });
      else if (ev.kind === "permission") cb({ type: "agent_permission_request", agentId: ev.agentId, request: ev.request });
      else if (ev.kind === "remove") cb({ type: "agent_deleted", agentId: ev.agentId });
    });
  }

  subscribeConnectionStatus(cb) {
    return this.subscribeEvents((ev) => {
      if (ev.kind === "connected") cb({ status: "connected" });
      else if (ev.kind === "disconnected") cb({ status: "disconnected" });
    });
  }

  /** Polls the log-derived status; resolves like DaemonClient.waitForFinish (status idle | timeout | error). */
  async waitForFinish(id, timeoutMs = 0) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const { agent } = await this.fetchAgent(id);
      if (agent.status === "idle") return { status: "idle", agent };
      if (agent.status === "closed") return { status: "error", error: "agent exited", agent };
      if (Date.now() >= deadline) return { status: "timeout", agent };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
