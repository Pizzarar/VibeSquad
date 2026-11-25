// idea-347: server-side restart coordination. The Overlord used to hold the drain-ask -> wait-for-drained -> fire-restart
// timer in its own turn; a dead session missed the window (11-18 03:30Z, 18:42Z). `vs restart request <tip>` now records a
// durable request in <VIBESQUAD_HOME>/restart-request.json and this module's server loop drives it:
//
//   requested --(live leads listed, drain asks sent)--> draining
//   draining  --(every asked lead drained or gone, runner holds none of their work)--> ready
//   draining  --(deadline passed: laggards logged)--> ready
//   ready     --(firedAt persisted BEFORE the launch: one fire per request, also across a server restart)--> firing
//   firing    --(restart-<ts>.json ok)--> done (restart-done logged + sent) | (refused / deferred / failed / no result)--> aborted
//
// A drain is a team-log `vs log restart-feedback 'drained restart <tip>'` (a bare 'drained restart' logged after the request
// counts too; another tip does not). The fire runs the existing `vs restart` path as the owner's shell (the same path and
// identity scripts/restart-runtime.mjs uses for its done broadcast); this module never restarts anything itself.
// idea-369: each ask and `vs restart status` carry the runner's held background work (/health heldAgents + heldWork) per lead.
// idea-398: a request with `--needs build` (the Live-Needs token) runs the source repo's sync-runtime (it rebuilds a stale
// dist, then copies the runtime) right before the `vs restart` launch, once the leads have drained. A sync that does not
// happen is never silent: the request logs `sync-skipped reason=...` (restart-feedback) and fires on the runtime as last synced.
// idea-402: auto-drain. A lead whose lane the runner holds no background work for (restart-coord laneHolders: the very check
// that gates a lead's own 'drained restart' log) is recorded as drained by the loop (asked[id].auto, source auto) and gets no
// prompt; re-checked every tick, so a prompted lead whose work finishes is drained without a turn. Leads never prompted
// (asked[id].quiet) get no aborted / restart-done send either: the team log line and vs restart status carry it. Fail safe:
// no fresh held list or agent list -> no auto-drain, the lead is asked as before.
// idea-674 (restart windows): a NON-urgent request is recorded `queued` for the next fixed UTC window (DEFAULT_WINDOWS_UTC,
// VS_RESTART_WINDOWS) and asks nobody, holds no runner drain and has no running deadline until then:
//
//   queued    --(another non-urgent request: tip/needs/scope folded in, tips[] kept)--> queued
//   queued    --(now >= windowAt: deadline = now + deadlineMin)--> requested (then the drain above, same tick)
//   queued    --(--urgent request: folded in, deadline = now + deadlineMin)--> requested
//   queued    --(vs restart abort)--> aborted (no lead was ever asked: no lead message)
//
// `--urgent [--reason]` keeps the immediate `requested` path. Any request while one is requested..firing is refused as before.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { pidAlive } from "../runner/lock.mjs";
import { runtimeDir as runtimeDirOf } from "./runtime-dir.mjs";
import { writeFileAtomic } from "./brief-write.mjs";
import { execOffLoop } from "./git-spawn.mjs";
import { linesFromEndSync } from "./log-tail.mjs";
import { DONE_TEXT, DRAINED_TEXT, DRAIN_LOG_SLACK_MS, doneText, heldCmdRedacted, heldShells, holderLeads, laneHolders } from "./restart-coord.mjs";
import { redactHostPathTokens } from "./redact-host-paths.mjs";
import { asleepTeamIds, isLiveAgent, loadTeamsRegistry, readTeamsConfig, resolveAgentIdentity, resolveLeadWinner, whoCandidate } from "./identity.mjs";
import { toAgent } from "./backend/runner-backend.mjs";

export const REQUEST_FILE = "restart-request.json";
export const STATES = Object.freeze(["queued", "requested", "draining", "ready", "firing", "done", "aborted"]);
export const TERMINAL = new Set(["done", "aborted"]);
export const DEFAULT_DEADLINE_MIN = 30;
export const MAX_DEADLINE_MIN = 240;
export const TICK_MS = 15_000;
/**
 * idea-476 (1): while a request is open the loop holds the runner's request drain (runner POST /drain/request), so NEW
 * background shells are refused from the drain ask on, not only once vs restart runs. Refreshed every tick with this TTL:
 * a server that dies stops refreshing and the drain lapses within it, never blocking background work for the whole deadline.
 */
export const REQUEST_DRAIN_TTL_MS = 5 * 60_000;

/** idea-674: the fixed daily UTC restart windows a non-urgent request waits for (override: VS_RESTART_WINDOWS="HH:MM,HH:MM"). */
export const DEFAULT_WINDOWS_UTC = Object.freeze(["13:00", "21:00"]);
const WINDOW_RE = /^(\d{1,2}):(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Comma-separated `HH:MM` UTC times -> sorted, de-duplicated ["HH:MM", ...], or null when empty or any entry is not a valid
 * time (the caller then falls back to DEFAULT_WINDOWS_UTC: a typo never disables or scrambles the windows).
 */
export function parseRestartWindows(raw) {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!parts.length || parts.length > 24) return null;
  const out = new Set();
  for (const p of parts) {
    const m = WINDOW_RE.exec(p);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    out.add(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  return [...out].sort();
}

/** The windows in force: VS_RESTART_WINDOWS when it parses, else DEFAULT_WINDOWS_UTC. */
export function restartWindows(env = process.env) {
  return parseRestartWindows(env?.VS_RESTART_WINDOWS) ?? [...DEFAULT_WINDOWS_UTC];
}

/** The next window strictly after `now` (ms since epoch, UTC). An invalid `windows` list falls back to DEFAULT_WINDOWS_UTC. */
export function nextRestartWindow(now = Date.now(), windows = DEFAULT_WINDOWS_UTC) {
  const list = parseRestartWindows(windows) ?? [...DEFAULT_WINDOWS_UTC];
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (const off of [0, 1]) {
    for (const w of list) {
      const [h, m] = w.split(":").map(Number);
      const t = day + off * DAY_MS + h * 3600_000 + m * 60_000;
      if (t > now) return t;
    }
  }
  /* c8 ignore next */ throw new Error("nextRestartWindow: no window"); // unreachable: tomorrow's first window is > now
}

/** Live-Needs token lists merged, de-duplicated (first spelling kept); `a` returned unchanged when `b` adds nothing. */
export function mergeNeeds(a, b) {
  const toks = (x) => String(x ?? "").split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const have = toks(a);
  const seen = new Set(have.map((t) => t.toLowerCase()));
  const add = toks(b).filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  return add.length ? [...have, ...add].join(",") : String(a ?? "");
}
/** A fired request whose vs restart launch was never recorded (a server crash between firedAt and the launch) holds the drain this long at most. */
export const FIRING_DRAIN_MAX_MS = 15 * 60_000;

/**
 * idea-476 (1): whether the runner's request drain should be held for `req` now. Queued (idea-674): no. Open (requested, draining, ready): yes.
 * Firing: only until the vs restart launch is recorded (vs restart then holds its own drain, POST /drain, from its first
 * seconds), and never past FIRING_DRAIN_MAX_MS after the fire, so a fire that never launched cannot hold background work
 * for FIRING_TIMEOUT_MS. Done, aborted, no request: no.
 */
export function requestHoldsDrain(req, now = Date.now()) {
  if (!req || TERMINAL.has(req.state)) return false;
  if (req.state === "queued") return false; // idea-674: nothing is held (no drain, no asks) before the window opens
  if (req.state !== "firing") return true;
  if (req.launch) return false;
  const fired = Date.parse(req.firedAt ?? "");
  return Number.isFinite(fired) && now - fired < FIRING_DRAIN_MAX_MS;
}
/** A fired request with no restart-<ts>.json after this long is aborted (restart-runtime's own drain wait tops out at 2h). */
export const FIRING_TIMEOUT_MS = 3 * 3600_000;
/** A restart result counts for a request when it started no earlier than this before the fire (clock skew between processes). */
const RESULT_SLACK_MS = 60_000;
const EVENTS_MAX = 40;
const HISTORY_MAX = 10;
export const TIP_RE = /^[A-Za-z0-9][\w./-]{0,63}$/;
const DRAINED_RE = /^restart-feedback:\s*drained restart\b\s*([^\s,;'"]*)/i;

const vsHomeOf = (home) => path.resolve(home || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
export const requestPath = (home) => path.join(vsHomeOf(home), REQUEST_FILE);
const iso = (ms) => new Date(ms).toISOString();
const clean = (t, cap = 80) => String(t ?? "").replace(/[^\w .,:;=/@%+~#()[\]{}<>|&*?!$-]+/g, " ").replace(/\s+/g, " ").trim().slice(-cap);
/** clean() keeping the HEAD (a message whose important part comes first), cut with '...'. */
const cleanHead = (t, cap) => fitLog(clean(t, Infinity), cap);
/** clean() keeping the TAIL with a cut-into first word dropped (no half word or path fragment at the head). */
const cleanTail = (t, cap) => { const c = clean(t, Infinity); return c.length > cap ? c.slice(-cap).replace(/^\S*\s*/, "") : c; };
/** Cap for an abort reason: whole in vs restart status and the leads' send; the log line is cut again by fitLog. */
const ABORT_REASON_MAX = 900;

/**
 * idea-475: why a fired restart deferred. 11-21: the abort reason kept the deferral message's last 300 chars, which dropped
 * every lead and holder and cut the agent id mid-way ("deferred on background work: 95d4c3966a --background ..."), so four
 * restarts read as blocked by unowned shells. The record's `blocking` lines (owner first, then pid, age, command) lead now.
 */
export function deferredAbortReason(r) {
  const d = r?.deferred;
  const lines = Array.isArray(d?.blocking) && d.blocking.length ? d.blocking
    : (d?.heldAgents ?? []).map((id) => {
      const lead = (d.leads ?? []).find((l) => (l.heldAgents ?? []).includes(id));
      const un = (d.unresolved ?? []).find((u) => u.agentId === id);
      return `${id}${lead ? ` (${lead.team}/${lead.lane}, lead ${lead.leadId}${lead.leadTitle ? ` ${lead.leadTitle}` : ""})` : un ? ` NO OWNER (${un.reason})` : ""}`;
    });
  const head = lines.length ? `blocking: ${lines.join(" | ")}` : (r?.errors?.[0] ?? "no error recorded");
  return cleanHead(redactHostPathTokens(`the restart deferred on background work: ${head}`), ABORT_REASON_MAX); // R2: abort reasons go to the team log and leads' sends
}

// ---- the file -------------------------------------------------------------------------------------------------------

function readDoc(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { version: 1, current: null, history: [] };
    throw e;
  }
  const doc = JSON.parse(raw.replace(/^﻿/, ""));
  if (!doc || typeof doc !== "object") throw new Error(`${file}: not a restart request file`);
  return { version: 1, current: doc.current ?? null, history: Array.isArray(doc.history) ? doc.history : [] };
}

const mutation = (file, fn) => (lock) => {
  const doc = readDoc(file);
  const before = JSON.stringify(doc);
  const out = fn(doc);
  if (JSON.stringify(doc) !== before) {
    lock?.assertOwned?.();
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
  }
  return out;
};
function mutateSync(home, fn) {
  const file = requestPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, mutation(file, fn));
}
function mutateAsync(home, fn) {
  const file = requestPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, mutation(file, fn));
}

/** The current (open or last finished) request, or null. */
export function readRestartRequest(home) {
  return readDoc(requestPath(home)).current;
}

/**
 * Record a request (the CLI's `vs restart request`; the caller gate is the CLI's). `requestedBy` is the Overlord's agent id
 * or "owner"; team/lane are where restart-feedback lines are logged.
 * idea-674: non-urgent (the default) -> `queued` for nextRestartWindow(now, windows); a second non-urgent request while one
 * is queued is folded into it (never refused). `urgent` -> `requested` at once (today's path), promoting an open queued
 * request with the new tip folded in. While a request is requested/draining/ready/firing any new one is refused, as before.
 */
export function createRestartRequest(home, { tip, requestedBy, team = "", lane = "", needs = "", deadlineMin = DEFAULT_DEADLINE_MIN, scope = "all", urgent = false, reason = "", windows = restartWindows(), now = Date.now() } = {}) {
  if (scope !== "all" && scope !== "team") throw new Error("vs restart request: scope must be all or team");
  const t = String(tip ?? "").trim();
  if (!TIP_RE.test(t)) throw new Error(`vs restart request: <tip> must be a commit or branch name (letters, digits, . _ / -), got ${JSON.stringify(String(tip ?? ""))}`);
  const min = Number(deadlineMin);
  if (!Number.isInteger(min) || min < 1 || min > MAX_DEADLINE_MIN) throw new Error(`vs restart request: --deadline must be whole minutes, 1-${MAX_DEADLINE_MIN}`);
  const need = String(needs ?? "").trim();
  if (need && !/^[\w,.\s-]{1,120}$/.test(need)) throw new Error("vs restart request: --needs takes Live-Needs tokens (e.g. server-restart,runner-restart)");
  const why = clean(reason, 200);
  if (why && !urgent) throw new Error("vs restart request: --reason is only for --urgent (a non-urgent request waits for the next restart window)");
  const by = String(requestedBy || "owner");
  return mutateSync(home, (doc) => {
    const cur = doc.current;
    const at = iso(now);
    if (cur && cur.state === "queued") {
      // idea-674: fold into the open queued request (tip = latest, tips[] kept, needs merged, scope only widens).
      foldInto(cur, { tip: t, by, team: String(team ?? ""), needs: need, scope, at });
      if (urgent) {
        cur.state = "requested";
        cur.urgent = true;
        cur.urgentReason = why;
        cur.promotedAt = at;
        cur.requestedAt = at;
        cur.deadlineMin = min;
        cur.deadline = iso(now + min * 60_000);
        event(cur, at, `URGENT by ${by}${why ? ` (${why})` : ""}: promoted from queued (window ${cur.windowAt}), draining now (deadline ${min} min)`);
      } else {
        cur.deadlineMin = Math.max(Number(cur.deadlineMin) || DEFAULT_DEADLINE_MIN, min);
        cur.deadline = iso(Date.parse(cur.windowAt) + cur.deadlineMin * 60_000);
      }
      return cur;
    }
    if (cur && !TERMINAL.has(cur.state)) throw new Error(`vs restart request: ${cur.id} (tip ${cur.tip}) is still ${cur.state}; see vs restart status, or vs restart abort first.`);
    if (cur) doc.history = [cur, ...doc.history].slice(0, HISTORY_MAX);
    const base = {
      id: `rr-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`,
      tip: t,
      tips: [t],
      requestedBy: by,
      team: String(team ?? ""),
      lane: String(lane ?? ""),
      needs: need,
      // idea-371 L1: the runtime restart is machine-wide, so every Squad's leads are asked by default ("all"); "team" asks only the requester's Squad.
      scope,
      createdAt: at,
      deadlineMin: min,
    };
    if (urgent) {
      doc.current = {
        ...base,
        urgent: true,
        urgentReason: why,
        requestedAt: at,
        deadline: iso(now + min * 60_000),
        state: "requested",
        asked: {}, drained: {}, gone: {}, held: null,
        events: [{ at, text: `URGENT request by ${by}${why ? ` (${why})` : ""} (deadline ${min} min)` }],
      };
    } else {
      const win = nextRestartWindow(now, windows);
      doc.current = {
        ...base,
        urgent: false,
        windowAt: iso(win),
        // Projected only: the real deadline is set when the window opens (now + deadlineMin), so leads get the full drain.
        deadline: iso(win + min * 60_000),
        state: "queued",
        asked: {}, drained: {}, gone: {}, held: null,
        events: [{ at, text: `queued by ${by} for the restart window ${iso(win)} (drain deadline ${min} min after it)` }],
      };
    }
    return doc.current;
  });
}

/** idea-674: fold a request into the open queued `cur` (mutated). */
function foldInto(cur, { tip, by, team, needs, scope, at }) {
  const before = cur.tip;
  cur.tips = Array.isArray(cur.tips) && cur.tips.length ? cur.tips : [cur.tip];
  if (!cur.tips.includes(tip)) cur.tips.push(tip);
  cur.tip = tip;
  const merged = mergeNeeds(cur.needs, needs);
  const widen = cur.scope === "team" && (scope === "all" || (team && team !== cur.team));
  if (widen) cur.scope = "all";
  event(cur, at, `tip ${tip} folded in by ${by}${tip === before ? " (same tip)" : ` (was ${before})`}${merged !== cur.needs ? `, needs now ${merged}` : ""}${widen ? ", scope widened to all Squads" : ""}`);
  cur.needs = merged;
}

/** `vs restart abort`: an open request that has not fired yet ends as aborted; the server loop tells the asked leads. */
export function abortRestartRequest(home, { by = "owner", reason = "", now = Date.now() } = {}) {
  return mutateSync(home, (doc) => {
    const cur = doc.current;
    if (!cur || TERMINAL.has(cur.state)) throw new Error("vs restart abort: no open restart request.");
    if (cur.state === "firing") throw new Error(`vs restart abort: ${cur.id} already fired vs restart at ${cur.firedAt}; it cannot be called back.`);
    abort(cur, iso(now), `aborted by ${by}${reason ? `: ${clean(reason, 200)}` : ""}`);
    return cur;
  });
}

// ---- inputs ---------------------------------------------------------------------------------------------------------

/**
 * Every live lead, one per lane the `vs who lead` way (whoCandidate + resolveLeadWinner; a CONFLICT lane lists each
 * contender). Accepts the runner's raw /agents records or toAgent() rows. [{ leadId, team, lane, title }].
 */
export function liveLeads(agents, teams = loadTeamsRegistry()) {
  const list = (Array.isArray(agents) ? agents : []).map((a) => (a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a));
  const byLane = new Map();
  for (const a of list) {
    if (!a || !isLiveAgent(a)) continue;
    const who = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (who.isOrphan || !who.teamId || !who.laneId) continue;
    if (whoCandidate(a, { teams, wantTeamId: who.teamId, wantLane: who.laneId })?.role !== "lead") continue;
    const key = `${who.teamId}/${who.laneId}`;
    if (!byLane.has(key)) byLane.set(key, { team: who.teamId, lane: who.laneId, cands: [] });
    byLane.get(key).cands.push(a);
  }
  const out = [];
  for (const { team, lane, cands } of byLane.values()) {
    const r = resolveLeadWinner(cands);
    const picked = r.winner ? [r.winner] : r.conflict ? cands.filter((a) => (r.contenders ?? []).includes(a.id)) : [];
    for (const a of picked) out.push({ leadId: a.id, team, lane, title: String(a.title ?? a.name ?? "").split(" · ")[0].trim() || null });
  }
  return out;
}

/**
 * idea-604: a lead whose only lane holders have no shell listed yet (held until the runner's first after-turn probe, which
 * lands within the park grace) is not prompted at once: its ask waits this long for that probe, which usually comes back
 * clean (auto-drain). Still unprobed, or real shells, after it: asked. The lead counts as not drained meanwhile.
 */
export const UNPROBED_ASK_GRACE_MS = 60_000;

/**
 * The runner's /health body as the loop's held list { ids, work }, or null (unknown: nobody auto-drained). idea-604: an
 * unreported heldWork stays null (not {}), so heldShells reads it as "shells unknown", never as unprobed. Bug36 L2: a
 * held count the ids do not match is inconsistent and unknown (same rule as restart-runtime healthHeldTruth).
 */
export function heldListFromHealth(h) {
  if (!h || typeof h !== "object" || !Array.isArray(h.heldAgents)) return null;
  if (h.held !== undefined && h.held !== h.heldAgents.length) return null;
  return { ids: h.heldAgents, work: h.heldWork && typeof h.heldWork === "object" && !Array.isArray(h.heldWork) ? h.heldWork : null };
}

/**
 * idea-402: per live lead, may the server record its drain now? { ok: true } | { ok: false, ids, unprobedOnly } where
 * unprobedOnly = every holder has no shell listed yet (restart-coord heldShells, the same reading `vs restart` defers on;
 * no work map or no entry for a holder reads as shells). null = no verdicts (held list or agent list unknown): nobody is
 * auto-drained. `held` is the runner's raw { ids, work } (work null when the runner did not report heldWork).
 */
export function autoDrainVerdicts(leads, held, agents, teams = loadTeamsRegistry()) {
  if (!Array.isArray(leads) || !held || !Array.isArray(held.ids) || !Array.isArray(agents)) return null;
  // Bug36 M1: a held id with no record in `agents` (spawned since the list, or the archived list failed) is a shell of
  // unknown lane: laneHolders would read it as nobody's and auto-drain its own lead. Fail closed: no verdicts at all.
  const known = new Set(agents.map((a) => String((a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a)?.id ?? "")));
  if (held.ids.some((id) => !known.has(String(id)))) return null;
  const out = {};
  for (const l of leads) {
    const b = laneHolders(l.leadId, { held, agents, teams, callerTeam: l.team, callerLane: l.lane });
    if (b.refusal) continue; // unknown for this lead: asked
    out[l.leadId] = b.ids.length ? { ok: false, ids: b.ids, unprobedOnly: heldShells(held, b.ids).unprobedOnly } : { ok: true };
  }
  return out;
}

export const RUNNING = new Set(["running", "initializing", "starting", "working", "queued"]); // idea-786: also the runner supervisor's busy gate
/**
 * B11a: `leads` minus the leads of asleep Squads whose lane has nothing running (no running agent, no runner-held work), so
 * a sleeping Squad gets no drain ask (it counts as drained / gone) and is not woken to lift a hold. An asleep lane that still
 * runs something keeps its lead: sleep never kills, so that work must still drain before the restart.
 */
export function dropAsleepLeads(leads, agents, teams, asleep, held = null) {
  if (!Array.isArray(leads) || !asleep?.size) return leads;
  const list = (Array.isArray(agents) ? agents : []).map((a) => (a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a));
  const busy = new Set();
  for (const a of list) {
    if (!a || !isLiveAgent(a) || !RUNNING.has(String(a.status ?? "").toLowerCase())) continue;
    const who = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (who.teamId && who.laneId) busy.add(`${who.teamId}/${who.laneId}`.toLowerCase());
  }
  return leads.filter((l) => {
    if (!asleep.has(String(l.team ?? "").toLowerCase())) return true;
    return busy.has(`${l.team}/${l.lane}`.toLowerCase()) || (held?.byLead?.[l.leadId]?.length ?? 0) > 0;
  });
}

/** The runner's held list ({ ids, work }) grouped by the holders' live leads (restart-coord holderLeads). */
export function heldByLead(held, agents, teams = loadTeamsRegistry()) {
  if (!held || !Array.isArray(held.ids)) return null;
  const { leads, unresolved, gone = [] } = holderLeads(held.ids, agents, teams);
  const work = held.work && typeof held.work === "object" ? held.work : {};
  const entry = (id) => ({ agentId: id, work: (work[id] ?? []).map((w) => ({ pid: w.pid, cmd: cleanTail(heldCmdRedacted(w.cmd || w.name), 80) })) }); // idea-475 R2: host paths redacted before the filter and cut
  return {
    byLead: Object.fromEntries(leads.map((l) => [l.leadId, l.heldAgents.map(entry)])),
    unresolved: unresolved.map((u) => ({ ...entry(u.agentId), reason: u.reason })),
    gone: gone.map((g) => ({ ...entry(g.agentId), reason: g.reason })), // idea-475: owner archived/exited, blocks no lead
  };
}

/** Tip `token` from a drained line matches the request's tip: equal, or one a >= 7-char prefix of the other (short/long hash). */
export function tipMatches(token, tip) {
  const a = String(token ?? "").toLowerCase();
  const b = String(tip ?? "").toLowerCase();
  if (!a) return true; // a bare 'drained restart' logged after the request
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * agent id -> first ts of a 'drained restart [<tip>]' restart-feedback line at or after sinceMs, from every team log. Each
 * log is read from its end and stops at a line stamped before stopMs (append-only; DRAIN_LOG_SLACK_MS covers writers that
 * land out of order), so a loop tick reads only what is new since its last scan.
 */
export function drainedSince(home, { sinceMs, stopMs = sinceMs, tip }) {
  const out = new Map();
  const root = path.join(vsHomeOf(home), "teams");
  let teams = [];
  try { teams = fs.readdirSync(root); } catch { return out; }
  const stop = Math.min(stopMs, sinceMs) - DRAIN_LOG_SLACK_MS;
  for (const team of teams) {
    try {
      for (const line of linesFromEndSync(path.join(root, team, "log.jsonl"))) {
        let e;
        try { e = JSON.parse(line.replace(/^﻿/, "")); } catch { continue; }
        const ts = Date.parse(e?.ts ?? "");
        if (ts < stop) break;
        if (e?.type !== "metric" || !(ts >= sinceMs)) continue;
        const m = DRAINED_RE.exec(String(e.text ?? ""));
        if (!m || !tipMatches(m[1], tip)) continue;
        const id = String(e.agent ?? "").trim();
        if (id && (!out.has(id) || out.get(id) > e.ts)) out.set(id, e.ts);
      }
    } catch { continue; }
  }
  return out;
}

/** restart-<ts>.json records in `home`, newest first (the newest `max`). */
export function restartResults(home, max = 8) {
  const dir = vsHomeOf(home);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^restart-.*\.json$/.test(n)).sort().reverse().slice(0, max).map((n) => {
    try { return { file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }; } catch { return null; }
  }).filter(Boolean);
}

/**
 * idea-653: the running vs restart script's own progress (scripts/restart-runtime.mjs PROGRESS_FILE, mirrored: the script
 * imports built-ins only) for the firing request `req`: { pid, startedAt, phase, at, waitDeadline?, running?, held?,
 * heldAgents?, alive }. null when there is no progress file, it is unreadable, or it belongs to an earlier run (started
 * before this fire). `alive` is read here, before the caller reads the results: a script that has exited wrote its result
 * file first, so a dead pid with no result is a script that died without one.
 */
export const PROGRESS_FILE = "vs-restart-progress.json";
export function readRestartProgress(home, req, { alive = pidAlive } = {}) {
  if (!req?.firedAt) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(vsHomeOf(home), PROGRESS_FILE), "utf8")); } catch { return null; }
  if (!p || typeof p !== "object" || !Number.isInteger(p.pid) || p.pid <= 0) return null;
  const fired = Date.parse(req.firedAt);
  if (!((Date.parse(p.startedAt ?? "") || 0) >= fired - RESULT_SLACK_MS)) return null;
  let up = false;
  try { up = Boolean(alive(p.pid)); } catch { up = true; } // unknown: never read as dead
  return { ...p, alive: up };
}

/** idea-653: one status line for a firing request's script progress. */
export function progressLine(p, now = Date.now()) {
  if (!p) return null;
  const head = `  vs restart pid ${p.pid}${p.alive ? "" : " (EXITED)"}: ${p.phase ?? "?"}`;
  if (p.phase === "waiting") {
    const left = Math.round((Date.parse(p.waitDeadline ?? "") - now) / 60_000);
    const who = Array.isArray(p.heldAgents) && p.heldAgents.length ? `: ${p.heldAgents.slice(0, 6).join(", ")}` : "";
    const dl = Number.isFinite(left) ? `, wait deadline ${p.waitDeadline} (${left >= 0 ? `in ${left} min` : `${-left} min ago`}; then held work defers, running turns are cut)` : "";
    return `${head} for runner idle (${p.running ?? "?"} running, ${p.held ?? "?"} held${who})${dl}; updated ${p.at ?? "?"}`;
  }
  if (p.phase === "finished") return `${head}${p.ok === false ? " (not ok)" : ""}${p.resultFile ? `, result ${path.basename(p.resultFile)}` : ""}; updated ${p.at ?? "?"}`;
  return `${head}; updated ${p.at ?? "?"}`;
}

// ---- the state machine ----------------------------------------------------------------------------------------------

function event(req, at, text) {
  req.events = [...(req.events ?? []), { at, text }].slice(-EVENTS_MAX);
}
function abort(req, at, reason) {
  req.state = "aborted";
  req.abortedAt = at;
  req.abortReason = reason;
  event(req, at, reason);
}
const leadName = (l) => `${l.lane} lead ${l.leadId}${l.title ? ` (${l.title})` : ""}`;
const heldLine = (list) => (list ?? []).map((h) => (h.work?.length ? `${h.agentId} (${h.work.map((w) => `pid ${w.pid}: ${w.cmd}`).join(", ")})` : h.agentId)).join(", ");

/** The drain ask (no double quotes or backticks: it may be pasted into a shell). idea-369: names the lane's held work. */
export function requestAskText(req, lead, held, now = Date.now()) {
  // idea-371 L2: minutes LEFT at ask time (a lead asked later in the drain window is not told the full initial duration).
  const left = Math.max(0, Math.round((Date.parse(req.deadline) - now) / 60000));
  return `Restart request ${req.id} (tip ${req.tip}${req.needs ? `, needs ${req.needs}` : ""}) from ${req.requestedBy}${req.team ? ` (Squad ${req.team}${req.scope === "team" ? " only" : ", all Squads are asked: the restart is machine-wide"})` : ""}: the server restarts the runtime once every live lead has drained, or at ${req.deadline} (~${left} min) regardless. ` +
    `Please drain: let running suites finish or stop what is not needed (vs stop <agent> --background, idle agents only), hold new background suites (the runner already refuses new background shells until the restart is done), then run: vs log restart-feedback '${DRAINED_TEXT} ${req.tip}'. ` +
    (held?.length ? `The runner holds background work in your lane right now: ${heldLine(held)}; it must finish or be stopped before your drain counts. ` : "") +
    `You get '${DONE_TEXT}' after the restart; lift the hold then. Progress: vs restart status.`;
}

/** Asked leads that still block the fire: not drained (and not gone), or drained while the runner still holds their work. */
export function pendingLeads(req) {
  const out = [];
  for (const [leadId, a] of Object.entries(req.asked ?? {})) {
    if (req.gone?.[leadId]) continue; // a lead that died or retired counts as drained
    const held = req.held?.byLead?.[leadId] ?? [];
    const why = a.holdoff ? "not drained, not asked yet (its lane's holders have no shell listed: waiting for their first probe)" : "not drained";
    if (!req.drained?.[leadId]) out.push({ leadId, ...a, reason: held.length ? `${why}; runner holds ${heldLine(held)}` : why });
    else if (held.length) out.push({ leadId, ...a, reason: `logged '${DRAINED_TEXT}' but the runner still holds ${heldLine(held)}` });
  }
  return out;
}

/**
 * One step for the open request `req` (mutated in place). Inputs: `leads` (liveLeads(), null = runner unreachable),
 * `drained` (drainedSince() map), `held` (heldByLead(); undefined = not read, null = unknown), `results` (restartResults(),
 * read while firing), `verdicts` (autoDrainVerdicts(); null = none, every new lead is asked), `progress` (readRestartProgress(),
 * read while firing BEFORE the results; idea-653: a dead script pid with no result aborts). Returns the side effects for the driver, which persists `req` BEFORE running any of them:
 * { kind: "ask", leadId, text } | { kind: "log", text } | { kind: "fire" } | { kind: "send", leadId, text }.
 */
export function stepRequest(req, { now = Date.now(), leads = null, drained = null, held = undefined, results = [], asleep = null, verdicts = null, progress = null } = {}) {
  const actions = [];
  const at = iso(now);
  req.asked ??= {};
  req.drained ??= {};
  req.gone ??= {};
  const close = () => notifyClosed(req, at, actions, asleep);
  if (TERMINAL.has(req.state)) return close();
  if (req.state === "queued") {
    // idea-674: nothing happens before the window: no asks, no held list kept, no deadline running.
    const win = Date.parse(req.windowAt ?? "");
    if (!Number.isFinite(win)) {
      abort(req, at, "queued request has no valid windowAt: nothing was asked, nothing fired; request again");
      return close();
    }
    if (now < win) return actions;
    const min = Number.isInteger(req.deadlineMin) && req.deadlineMin >= 1 ? req.deadlineMin : DEFAULT_DEADLINE_MIN;
    req.state = "requested";
    req.requestedAt = at;
    req.deadline = iso(now + min * 60_000);
    const tips = Array.isArray(req.tips) && req.tips.length > 1 ? ` (batched tips ${req.tips.join(", ")})` : "";
    event(req, at, `restart window ${req.windowAt} open: drain starts for tip ${req.tip}${tips}, deadline ${min} min`);
    actions.push({ kind: "log", text: `restart-request ${req.id} window ${req.windowAt} open: draining for ${req.tip}${tips}, deadline ${req.deadline}` });
  }
  if (held !== undefined) req.held = held ? { at, ...held } : null;
  // idea-402: verdicts count only with this tick's held list and lead list (fail safe: stale or missing data auto-drains nobody).
  const v = leads && held ? (verdicts ?? null) : null;

  if (req.state === "requested" || req.state === "draining") {
    if (leads) {
      const auto = [];
      const ask = (l, a) => {
        delete a.quiet;
        delete a.holdoff;
        a.promptedAt = at;
        actions.push({ kind: "ask", leadId: l.leadId, text: requestAskText(req, l, req.held?.byLead?.[l.leadId], now) });
      };
      const autoDrain = (l, a) => {
        delete a.holdoff;
        a.auto = at;
        req.drained[l.leadId] = at;
        auto.push(l);
      };
      for (const l of leads) {
        if (l.leadId === req.requestedBy) continue;
        if (req.scope === "team" && req.team && l.team !== req.team) continue;
        const verdict = v?.[l.leadId];
        let a = req.asked[l.leadId];
        if (!a) {
          a = req.asked[l.leadId] = { team: l.team, lane: l.lane, title: l.title ?? null, askedAt: at };
          if (verdict?.ok) { a.quiet = true; autoDrain(l, a); }
          else if (verdict?.unprobedOnly) { a.quiet = true; a.holdoff = at; }
          else ask(l, a);
          continue;
        }
        if (req.gone[l.leadId]) continue;
        if (req.drained[l.leadId]) {
          // An auto-drained lead that was never prompted and whose lane now shows real shells: the drain is withdrawn and the
          // lead asked (it would otherwise block silently until the deadline). Unprobed-only holders just block until probed.
          if (a.auto && a.quiet && verdict && !verdict.ok && !verdict.unprobedOnly) {
            delete req.drained[l.leadId];
            delete a.auto;
            event(req, at, `${leadName({ leadId: l.leadId, ...a })}: auto-drain withdrawn, the runner holds ${verdict.ids.join(", ")}`);
            ask(l, a);
          }
          continue;
        }
        if (verdict?.ok) { autoDrain(l, a); continue; } // a prompted lead whose work finished is drained without a turn
        if (a.holdoff) {
          if (verdict?.unprobedOnly && now - Date.parse(a.holdoff) < UNPROBED_ASK_GRACE_MS) continue;
          ask(l, a);
        }
      }
      const live = new Set(leads.map((l) => l.leadId));
      for (const id of Object.keys(req.asked)) {
        if (!live.has(id) && !req.gone[id]) { req.gone[id] = at; event(req, at, `${leadName({ leadId: id, ...req.asked[id] })} is gone: counts as drained`); }
      }
      const asks = actions.filter((x) => x.kind === "ask").length;
      if (req.state === "requested") {
        req.state = "draining";
        req.drainingAt = at;
        const holding = Object.values(req.asked).filter((a) => a.holdoff).length;
        event(req, at, `drain asks to ${asks} live lead(s); ${auto.length} auto-drained (runner holds no work in their lanes, not prompted)${holding ? `; ${holding} ask(s) held until the holders' first probe` : ""}`);
      } else {
        if (asks) event(req, at, `drain asks to ${asks} lead(s)`);
      }
      if (auto.length) {
        if (req.state === "draining" && req.drainingAt !== at) event(req, at, `auto-drained ${auto.length} lead(s): ${auto.map((l) => `${l.team}/${l.lane}`).join(", ")}`);
        actions.push({ kind: "log", text: `restart-request ${req.id} auto-drained ${auto.length} lead(s), the runner holds no work in their lanes (no prompt): ${auto.map((l) => `${l.lane} ${l.leadId}`).join(", ")}` });
      }
    }
    for (const [id, ts] of drained ?? []) {
      if (!req.asked[id]) continue; // non-asked agents change nothing
      // A lead that logged its own drain took a turn on it: it gets the close notice to lift its hold, like an asked lead.
      delete req.asked[id].quiet;
      delete req.asked[id].holdoff;
      if (req.drained[id]) continue; // duplicates (or already auto-drained) change nothing else
      req.drained[id] = ts;
      event(req, at, `${leadName({ leadId: id, ...req.asked[id] })} drained`);
    }
    const past = now >= Date.parse(req.deadline);
    if (req.state === "requested") {
      if (!past) return actions;
      abort(req, at, "deadline passed before the runner listed any lead: no drain asks went out, nothing fired");
      return close();
    }
    const pend = pendingLeads(req);
    // idea-402: a server-recorded (auto) drain only stands on THIS tick's held list: with it unknown now, the request waits
    // (the deadline still fires as before). Self-reported drains keep their existing behavior.
    // Bug36 L1: per lead, not just "some verdicts": an auto drain whose lead has no ok verdict on this tick (unknown, or a
    // holder laneHolders counts but heldByLead does not, e.g. a vs.parent child) does not let the request fire.
    const autoStale = Object.entries(req.asked).some(([id, a]) => a.auto && req.drained[id] && !req.gone[id] && !v?.[id]?.ok);
    if (!pend.length && !autoStale) {
      req.state = "ready";
      req.readyAt = at;
      req.readyReason = "all-drained";
      const n = Object.keys(req.asked).length;
      event(req, at, `ready: all ${n} asked lead(s) drained or gone`);
      actions.push({ kind: "log", text: `restart-request ${req.id} ready: all ${n} asked lead(s) drained or gone; firing vs restart for ${req.tip}` });
    } else if (past) {
      req.state = "ready";
      req.readyAt = at;
      req.readyReason = "deadline";
      req.laggards = pend.map(({ leadId, team, lane, title, reason }) => ({ leadId, team, lane, title, reason }));
      const who = req.laggards.map((l) => `${leadName(l)} [${l.reason}]`).join("; ") || "none (auto-drains unconfirmed)";
      event(req, at, `deadline passed; not drained: ${who}`);
      actions.push({ kind: "log", text: `restart-request ${req.id} deadline passed; firing vs restart for ${req.tip} anyway (restart-runtime still waits for idle and defers rather than kill); not drained: ${who}` });
    }
  }

  if (req.state === "ready") {
    req.state = "firing";
    req.firedAt = at;
    event(req, at, "firing vs restart");
    actions.push({ kind: "fire" });
    return actions;
  }

  if (req.state === "firing") {
    if (req.launch && req.launch.ok === false) {
      abort(req, at, `vs restart did not launch: ${req.launch.error}`);
    } else {
      const fired = Date.parse(req.firedAt ?? "") || now;
      const r = (results ?? []).find((x) => x && !x.dryRun && (Date.parse(x.startedAt ?? "") || 0) >= fired - RESULT_SLACK_MS);
      if (r?.ok) {
        req.state = "done";
        req.doneAt = at;
        req.result = { file: r.file ?? null, ok: true, finishedAt: r.finishedAt ?? null };
        event(req, at, `restart done (${r.file ? path.basename(r.file) : "result"})`);
      } else if (r) {
        req.result = { file: r.file ?? null, ok: false, finishedAt: r.finishedAt ?? null };
        abort(req, at, r.deferred ? deferredAbortReason(r) : `the restart failed: ${cleanHead(redactHostPathTokens(r.errors?.[0] ?? "no error recorded"), 300)}`);
      } else if (progress && progress.alive === false) {
        // idea-653: the script that ran this fire has exited and left no result (a crash, a kill): nothing will finish it.
        abort(req, at, `the vs restart script (pid ${progress.pid}) exited without a result (last phase: ${progress.phase ?? "?"} at ${progress.at ?? "?"}); nothing was restarted after that point. See its log in ~/.vibesquad/logs, then request again`);
      } else if (now - fired > FIRING_TIMEOUT_MS) {
        abort(req, at, `no restart result within ${FIRING_TIMEOUT_MS / 3600_000}h of the fire`);
      }
    }
    if (TERMINAL.has(req.state)) return close();
  }
  return actions;
}

/**
 * Once per finished request: log the outcome and tell every prompted lead still live to lift its hold. idea-402: a lead
 * that was never prompted (quiet: auto-drained, or its ask still held) has no hold to lift and is not woken; the team-log
 * line names how many were left out, and vs restart status shows each.
 */
function notifyClosed(req, at, actions, asleep = null) {
  if (req.notifiedAt) return actions;
  req.notifiedAt = at;
  const done = req.state === "done";
  // idea-398 fix round: a restart after a skipped sync ran the old runtime; never let its done line read as a clean one.
  const stale = req.sync && req.sync.ok === false ? `; ${req.sync.note ?? notUpdatedNote({ tip: req.tip, reason: req.sync.reason })}` : "";
  const quiet = Object.keys(req.asked ?? {}).filter((id) => req.asked[id]?.quiet && !req.gone?.[id]).length;
  const q = quiet ? ` [${quiet} auto-drained lead(s) not woken]` : "";
  // The note goes before the stale tail on a done line (it must not be cut by fitLog), after the reason on an abort line.
  actions.push({ kind: "log", text: done ? `${DONE_TEXT} ${req.tip} (restart-request ${req.id})${q}${stale}` : `restart-request ${req.id} aborted${q}: ${req.abortReason}${stale}` });
  const text = done ? `${doneText(at)} (restart-request ${req.id}, tip ${req.tip})${stale}`
    : `Restart request ${req.id} (tip ${req.tip}) was aborted: ${req.abortReason}${stale}. No restart is pending from it; lift your background-suite hold.`;
  for (const id of Object.keys(req.asked ?? {})) {
    if (req.gone?.[id]) continue;
    if (asleep?.has?.(String(req.asked[id]?.team ?? "").toLowerCase())) continue; // B11a: an asleep Squad is not woken
    if (req.asked[id]?.quiet) continue; // idea-402: never prompted, nothing to lift
    actions.push({ kind: "send", leadId: id, text });
  }
  return actions;
}

// ---- status ---------------------------------------------------------------------------------------------------------

/** "in 3h 05m" | "in 12 min" | "due now (next server tick)" for a window time. */
export function windowCountdown(at, now = Date.now()) {
  const ms = Date.parse(at ?? "") - now;
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "due now (next server tick)";
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatRequestStatus(req, now = Date.now(), { progress = null } = {}) {
  if (!req) return "no restart request (vs restart request <tip> [--deadline <min>] [--urgent --reason <why>])";
  const mins = (t) => Math.round((Date.parse(t) - now) / 60000);
  const queued = req.state === "queued";
  const when = queued
    ? `window ${req.windowAt} (${windowCountdown(req.windowAt, now)}), drain deadline ${req.deadlineMin} min after the window opens`
    : `deadline ${req.deadline}${TERMINAL.has(req.state) ? "" : ` (${mins(req.deadline) >= 0 ? `in ${mins(req.deadline)} min` : `${-mins(req.deadline)} min ago`})`}`;
  const lines = [`restart request ${req.id}: ${req.state}${req.urgent ? " URGENT" : ""} (tip ${req.tip}${req.needs ? `, needs ${req.needs}` : ""}, by ${req.requestedBy}${req.scope === "team" ? `, ${req.team} Squad only` : ", all Squads"}, created ${req.createdAt}, ${when})`];
  if (queued) lines.push("  queued: no lead is asked and the runner holds nothing until the window opens (vs restart abort cancels it; --urgent drains now)");
  if (Array.isArray(req.tips) && req.tips.length > 1) lines.push(`  batched tips: ${req.tips.join(", ")} (restarting to ${req.tip})`);
  if (req.urgent) lines.push(`  urgent${req.urgentReason ? `: ${req.urgentReason}` : " (no reason given)"}${req.promotedAt ? `; promoted from the ${req.windowAt} window at ${req.promotedAt}` : ""}`);
  else if (req.windowAt && !queued) lines.push(`  window ${req.windowAt}; drain started ${req.requestedAt ?? "?"}`);
  const asked = Object.entries(req.asked ?? {});
  const settled = asked.filter(([id]) => req.drained?.[id] || req.gone?.[id]).length;
  if (asked.length) lines.push(`  leads: ${settled}/${asked.length} drained or gone`);
  for (const [id, a] of asked) {
    const held = req.held?.byLead?.[id] ?? [];
    const st = req.gone?.[id] ? `gone ${req.gone[id]} (counts as drained)`
      : req.drained?.[id] ? `drained ${req.drained[id]}${a.auto ? ` (auto: runner holds no work in its lane${a.quiet ? ", not prompted" : ""})` : ""}`
      : a.holdoff ? `NOT drained (ask held since ${a.holdoff}: its holders have no shell listed yet, waiting for their first probe)` : "NOT drained";
    lines.push(`  - ${leadName({ leadId: id, ...a })}: ${st}${a.error ? `; ask failed: ${a.error}` : ""}${held.length ? `; runner holds ${heldLine(held)}` : ""}`);
  }
  if (req.held?.gone?.length) lines.push(`  held by a gone owner (counted drainable): ${req.held.gone.map((u) => `${heldLine([u])} (${u.reason})`).join("; ")}`);
  if (req.held?.unresolved?.length) lines.push(`  held with no lead resolved: ${req.held.unresolved.map((u) => `${heldLine([u])} (${u.reason})`).join("; ")}`);
  // idea-674 review L1: a queued request reads no held list by design (held stays null until the window opens).
  if (req.held === null && !TERMINAL.has(req.state) && req.state !== "queued") lines.push("  runner held list: unknown (runner unreachable or older)");
  if (req.laggards?.length) lines.push(`  fired at the deadline without: ${req.laggards.map((l) => `${leadName(l)} [${l.reason}]`).join("; ")}`);
  if (req.sync) lines.push(req.sync.ok ? `  synced ${req.sync.at}: runtime at ${String(req.sync.commit ?? "?").slice(0, 7)}${req.sync.built ? " (dist rebuilt)" : ""}` : `  sync-skipped reason=${req.sync.reason} (${req.sync.at})${req.sync.note ? `; ${req.sync.note}` : ""}`);
  else if (needsBuild(req.needs) && !TERMINAL.has(req.state)) lines.push("  needs build: sync-runtime (build if stale) runs right before the fire");
  if (req.firedAt) lines.push(`  fired ${req.firedAt}${req.launch ? (req.launch.ok ? " (vs restart launched)" : ` (launch failed: ${req.launch.error})`) : ""}`);
  if (req.state === "firing") lines.push(progressLine(progress, now) ?? (req.launch?.ok ? "  vs restart progress: none yet (the script writes vs-restart-progress.json once it holds the restart lock)" : "  vs restart progress: not launched yet"));
  if (req.result?.file) lines.push(`  result: ${req.result.file}`);
  if (req.abortReason) lines.push(`  aborted: ${req.abortReason}`);
  for (const e of (req.events ?? []).slice(-6)) lines.push(`  ${e.at}  ${e.text}`);
  return lines.join("\n");
}

// ---- the driver -----------------------------------------------------------------------------------------------------

/** idea-398: does the request's --needs list carry the Live-Needs `build` token? */
export function needsBuild(needs) {
  return String(needs ?? "").toLowerCase().split(/[\s,]+/).includes("build");
}

/**
 * The source checkout the live runtime was synced from: the runtime's build-stamp.json records its git common dir
 * (`<repo>/.git`). null when there is no stamp or it names no main checkout.
 */
export function syncRepoRoot(env = process.env) {
  const runtime = runtimeDirOf(env);
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(runtime, "build-stamp.json"), "utf8"))?.repo;
    if (typeof repo !== "string" || path.basename(repo).toLowerCase() !== ".git") return null;
    return path.dirname(path.resolve(repo));
  } catch { return null; }
}

const SYNC_TIMEOUT_MS = 20 * 60_000; // sync-runtime's own lock staleMs: it outlasts a vite build
/**
 * Run `<repo>/server/sync-runtime.mjs` (its git guard, drain guard, build-if-stale and copy) async, so the loop never
 * blocks. Never --force and never the owner's drain override: a guard that says no is reported, not bypassed.
 * Returns { ok: true, commit, built } | { ok: false, reason }.
 */
export function runSyncAsync({ env = process.env, repoRoot = syncRepoRoot(env), timeoutMs = SYNC_TIMEOUT_MS } = {}) {
  if (!repoRoot) return Promise.resolve({ ok: false, reason: "the live runtime has no build-stamp.json naming its source checkout" });
  const script = path.join(repoRoot, "server", "sync-runtime.mjs");
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, reason: `no server/sync-runtime.mjs in ${repoRoot}` });
  const resultFile = path.join(os.tmpdir(), `vs-sync-result-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  const e = { ...env, VIBESQUAD_SYNC_RESULT: resultFile, VIBESQUAD_SYNC_FORCE: "", VIBESQUAD_IGNORE_DRAIN: "" };
  for (const k of AGENT_ENV_KEYS) delete e[k];
  return new Promise((resolve) => {
    let out = "";
    let child;
    const done = (r) => { try { fs.rmSync(resultFile, { force: true }); } catch {} resolve(r); };
    try {
      child = spawn(process.execPath, [script], { env: e, cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) { done({ ok: false, reason: `sync-runtime did not start: ${clean(err?.message ?? err, 200)}` }); return; }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (b) => { out = (out + b).slice(-4000); });
    child.stderr.on("data", (b) => { out = (out + b).slice(-4000); });
    child.on("error", (err) => { clearTimeout(timer); done({ ok: false, reason: `sync-runtime did not start: ${clean(err?.message ?? err, 200)}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res = null;
      try { res = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch {}
      if (res?.synced) return done({ ok: true, commit: res.commit ?? null, built: Boolean(res.built) });
      const why = timedOut ? `sync-runtime timed out after ${Math.round(timeoutMs / 60_000)} min`
        : res?.skipped ? `skipped: ${res.skipped}`
        : res?.refused ? `refused: ${res.refused}`
        : res?.error ? `failed: ${clean(res.error, 200)}`
        : res ? "sync-runtime reported no sync"
        : `sync-runtime exited ${code} without a result (${out.trim().split(/\r?\n/).pop() ?? ""})`;
      done({ ok: false, reason: why });
    });
  });
}

/**
 * Where the live runtime stands against the request's tip when its sync did not run: the runtime build-stamp commit and
 * `git rev-list --count <that>..<tip>` in the source checkout (async: the loop never blocks). Unknown parts are null.
 */
export function runtimeLagAsync(req, { env = process.env, repoRoot = syncRepoRoot(env) } = {}) {
  const runtime = runtimeDirOf(env);
  let sha = null;
  try { sha = JSON.parse(fs.readFileSync(path.join(runtime, "build-stamp.json"), "utf8"))?.commit ?? null; } catch {}
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) sha = null;
  if (!sha || !repoRoot || !TIP_RE.test(String(req?.tip ?? ""))) return Promise.resolve({ sha, behind: null });
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "rev-list", "--count", `${sha}..${req.tip}`], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      const n = Number.parseInt(String(out ?? "").trim(), 10);
      resolve({ sha, behind: !err && Number.isFinite(n) ? n : null });
    });
  });
}

/** The 11-20 02:54 regression guard: the one phrase every restart-done line and watch ping carries after a skipped sync. */
export function notUpdatedNote({ sha = null, behind = null, tip = "?", reason = "unknown" } = {}) {
  return `runtime NOT updated: still ${sha ? String(sha).slice(0, 7) : "?"}, ${Number.isInteger(behind) ? behind : "?"} behind ${tip}, reason ${fitLog(clean(reason, 1000), NOTE_REASON_MAX)}`;
}

/** vs log rejects text over 240 chars (cli/vs.mjs MAX_TEXT, vibesquad-api POST /log): an over-long line is lost, not cut. */
export const LOG_MAX = 240;
const FEEDBACK_MAX = LOG_MAX - "restart-feedback: ".length; // the CLI prefixes metric subtypes
const NOTE_REASON_MAX = 80; // keeps 'restart-done <tip> (restart-request <id>); <note>' inside FEEDBACK_MAX
/** Head-preserving cut to `max` chars (the important part of every line here comes first). */
export function fitLog(text, max = LOG_MAX) {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/** The restart-feedback line for a pre-fire sync outcome (idea-398). */
export function syncFeedbackText(req, r) {
  if (r?.ok) {
    const sha = String(r.commit ?? "").slice(0, 7) || "?";
    const off = r.commit && /^[0-9a-f]{7,40}$/i.test(req.tip) && !tipMatches(req.tip, r.commit) ? `; HEAD ${sha} is not the requested tip ${req.tip}` : "";
    return `restart-request ${req.id} synced the runtime to ${sha}${r.built ? " (dist rebuilt)" : ""} before vs restart (needs build)${off}`;
  }
  // With the note (the loop always adds it) the reason lives in the note: one line, inside the log limit.
  if (r?.note) return `sync-skipped (restart-request ${req.id}, needs build), vs restart fires anyway: ${r.note}`;
  return `sync-skipped reason=${clean(r?.reason ?? "unknown", 300)} (restart-request ${req.id}, tip ${req.tip}, needs build): firing vs restart on the runtime as last synced`;
}

/** The needs-you line for the Overlord's lane when the restart fires on old code (idea-398 fix round, Hub13). */
export function notUpdatedNeedsYouText(req, note) {
  return fitLog(`restart-request ${req.id} fires vs restart on old code: ${note}. Fix the reason, sync, request again.`);
}

const VS_CLI = path.resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const AGENT_ENV_KEYS = ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_ROLE", "VS_LANE", "VS_TEAM", "VS_ORD", "VS_PROFILE"];

/**
 * One `vs` call as the owner's shell (agent identity stripped, as restart-runtime's runVs), async: the server loop never blocks.
 * idea-572: the `node vs.mjs` child is created in the off-loop worker (server/git-spawn.mjs execOffLoop). A plain spawn() here
 * still paid the synchronous CreateProcess on the server loop: loop-lag 11-22 08:23-09:38Z, 34 stalls / 52s (max 4.8s) during
 * one restart drain's asks and logs. Same contract: { ok, out } on exit 0, else { ok:false, error } (last 300 chars of
 * stdout+stderr, or the exit/failure reason); killed at timeoutMs; never rejects. `exec` is a test seam.
 */
export function runVsAsync(args, { env = process.env, timeoutMs = 60_000, exec = execOffLoop } = {}) {
  const e = { ...env };
  for (const k of AGENT_ENV_KEYS) delete e[k];
  return Promise.resolve()
    .then(() => exec(process.execPath, [VS_CLI, ...args], { cwd: path.dirname(path.dirname(VS_CLI)), env: e, timeoutMs, maxBuffer: 8 * 1024 * 1024 }))
    .then((r) => {
      const text = `${r?.out ?? ""}${r?.err ?? ""}`.trim().slice(-300);
      if (r?.ok) return { ok: true, out: text };
      return { ok: false, error: text || (typeof r?.code === "number" ? `exit ${r.code}` : String(r?.msg || "failed").slice(0, 300)) };
    })
    .catch((err) => ({ ok: false, error: String(err?.message ?? err).slice(0, 300) }));
}

/** idea-695: `vs restart` args for a request's fire: `--requester <id>` when an agent (not the owner) requested it. */
export function fireArgs(req) {
  const by = String(req?.requestedBy ?? "");
  return by && by !== "owner" && /^[A-Za-z0-9][\w.-]{0,63}$/.test(by) ? ["--requester", by] : [];
}

/**
 * The server loop. Deps (all injectable for tests): listAgents() -> runner agents, heldList() -> { ids, work } | null,
 * listAgentsWithArchived() -> the same list plus archived records (read only when a held id is not in listAgents(), so an
 * archived holder resolves as a gone owner, not "not in the runner's agent list"; idea-475 R2),
 * runVs(args) -> { ok, error? } (logs, sends), fire() -> { ok, error? } (the existing `vs restart` path), teams() -> registry.
 * tick() reads the inputs outside the lock, steps under it, persists, then runs the effects; it never overlaps itself.
 */
export function createRestartRequestLoop({
  home,
  listAgents,
  listAgentsWithArchived = null,
  heldList = async () => null,
  runVs = (args) => runVsAsync(args),
  // idea-695: the fire names the request's requester, so its own held work does not hold or defer the restart it asked for.
  fire = (req) => runVsAsync(["restart", ...fireArgs(req)], { timeoutMs: 120_000 }),
  sync = () => runSyncAsync(),
  runtimeLag = (req) => runtimeLagAsync(req),
  teams = () => loadTeamsRegistry(),
  // B11a: lowercased ids of asleep Squads, read each tick (mtime-cached).
  asleepTeams = () => asleepTeamIds(readTeamsConfig()),
  now = () => Date.now(),
  tickMs = TICK_MS,
  log = () => {},
  // idea-476: { set(req), clear(id) } over the runner's /drain/request; the default holds nothing (tests, no runner).
  drain = null,
  // idea-653: the firing request's script progress (readRestartProgress); a test seam for the pid check.
  progressOf = (req) => readRestartProgress(home, req),
} = {}) {
  let busy = null;
  // The request id this process last set the runner drain for; null once released. `undefined` at start: an earlier server
  // process (a server restart mid-request) may have set one, so the first release clears whatever request drain the runner
  // holds instead of leaving it to its TTL.
  let drainHeld;

  async function holdDrain(req) {
    if (!drain) return;
    try { await drain.set(req); drainHeld = req.id; } catch (e) { log(`restart-request ${req.id}: runner drain not set (${e?.message ?? e}); new background work is not refused`); }
  }
  async function releaseDrain() {
    if (!drain || drainHeld === null) return;
    const id = drainHeld ?? null;
    try { await drain.clear(id); drainHeld = null; } catch (e) { log(`restart-request ${id ?? "(earlier process)"}: runner drain not cleared (${e?.message ?? e}); it lapses within ${REQUEST_DRAIN_TTL_MS / 60_000} min`); }
  }
  let scanned = null; // { id, at }: the last drained-log scan for this request (in memory: a restarted server rescans once)
  let timer = null;

  const logArgs = (req, text) => ["log", "restart-feedback", fitLog(text, FEEDBACK_MAX), ...(req.team && req.lane ? ["--team", req.team, "--lane", req.lane] : [])];

  async function run() {
    let cur;
    try { cur = readRestartRequest(home); } catch (e) {
      // Fail closed both ways (idea-476): an unreadable request file is no open request. Background starts are NOT refused
      // (a drain held on a file nobody can read would block every lane's suites until it lapses), and nothing is stepped,
      // so no lead is marked drained and nothing fires. Logged every tick until the file is readable again.
      log(`restart-request: ${REQUEST_FILE} unreadable (${e?.message ?? e}): runner drain released, background starts allowed, no lead marked drained, nothing fired`);
      await releaseDrain();
      return { state: null, actions: [], unreadable: true };
    }
    if (!cur || TERMINAL.has(cur.state)) await releaseDrain();
    if (!cur || (TERMINAL.has(cur.state) && cur.notifiedAt)) return { state: cur?.state ?? null, actions: [] };
    const open = !TERMINAL.has(cur.state) && cur.state !== "firing";
    // idea-674: a queued request before its window reads nothing (no agent list, held list or log scan): it only waits.
    const due = cur.state !== "queued" || !(now() < Date.parse(cur.windowAt ?? ""));
    let leads = null;
    let held;
    let drained = null;
    let results = [];
    let asleep = null;
    let verdicts = null;
    try { asleep = asleepTeams(); } catch { asleep = null; }
    const scanAt = now();
    if (open && due) {
      let agents = null;
      try { agents = await listAgents(); } catch (e) { log(`restart-request: agent list failed: ${e?.message ?? e}`); }
      if (Array.isArray(agents)) {
        const reg = teams();
        leads = liveLeads(agents, reg);
        let h = null;
        try { h = await heldList(); } catch { h = null; }
        let holders = agents;
        if (h && listAgentsWithArchived && Array.isArray(h.ids) && h.ids.some((id) => !agents.some((a) => a?.id === id))) {
          try { const all = await listAgentsWithArchived(); if (Array.isArray(all)) holders = all; } catch (e) { log(`restart-request: archived agent list failed: ${e?.message ?? e}`); }
        }
        held = h ? heldByLead(h, holders, reg) : null;
        leads = dropAsleepLeads(leads, agents, reg, asleep, held);
        // idea-402: the same lane check a lead's own drained log must pass, per lead (null without a held list: fail safe).
        try { verdicts = h ? autoDrainVerdicts(leads, h, holders, reg) : null; } catch (e) { verdicts = null; log(`restart-request: auto-drain check failed (${e?.message ?? e}); every lead is asked`); }
      }
      // idea-674: drains count from when the drain started (requestedAt; a queued request about to open: this scan), never
      // from a queued request's creation, when no lead had been asked. Older files carry no requestedAt: createdAt.
      const sinceMs = cur.state === "queued" ? scanAt : Date.parse(cur.requestedAt ?? cur.createdAt);
      drained = drainedSince(home, { sinceMs, stopMs: scanned?.id === cur.id ? scanned.at : sinceMs, tip: cur.tip });
    }
    let progress = null;
    if (!open && cur.state === "firing") {
      try { progress = progressOf(cur); } catch { progress = null; } // idea-653: read before the results (see readRestartProgress)
      results = restartResults(home);
    }
    const { req, actions } = await mutateAsync(home, (doc) => {
      if (!doc.current || doc.current.id !== cur.id) return { req: doc.current, actions: [] };
      return { req: doc.current, actions: stepRequest(doc.current, { now: now(), leads, drained, held, results, asleep, verdicts, progress }) };
    });
    if (open && due) scanned = { id: cur.id, at: scanAt };
    // The drain follows the stepped state (requestHoldsDrain): held while the request is open and until its vs restart
    // launch is recorded, released once it launched, finished or was aborted.
    if (requestHoldsDrain(req, now())) await holdDrain(req);
    else await releaseDrain();
    // Effects, after the state that caused them is on disk (an ask is never re-sent, a fire never repeated).
    const outcomes = {};
    for (const a of actions) {
      if (a.kind === "fire") {
        // idea-398: --needs build syncs (and rebuilds) first. firedAt is already on disk, so a crash here never fires twice.
        if (needsBuild(req.needs)) {
          let s;
          try { s = await sync(req); } catch (e) { s = { ok: false, reason: String(e?.message ?? e) }; }
          if (!s?.ok) {
            let lag = null;
            try { lag = await runtimeLag(req); } catch {}
            s = { ...s, ok: false, note: notUpdatedNote({ sha: lag?.sha ?? null, behind: lag?.behind ?? null, tip: req.tip, reason: s?.reason ?? "unknown" }) };
          }
          const text = syncFeedbackText(req, s);
          await mutateAsync(home, (doc) => {
            if (doc.current?.id !== req.id) return;
            const at = iso(now());
            doc.current.sync = s?.ok ? { ok: true, at, commit: s.commit ?? null, built: Boolean(s.built) } : { ok: false, at, reason: clean(s?.reason ?? "unknown", 300), note: s.note };
            event(doc.current, at, s?.ok ? `synced the runtime to ${String(s.commit ?? "?").slice(0, 7)}` : `sync-skipped reason=${clean(s?.reason ?? "unknown", 200)}`);
          });
          log(text);
          const lr = await runVs(logArgs(req, text)).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
          if (!lr?.ok) log(`restart-request ${req.id}: sync log failed: ${lr?.error}`);
          if (!s?.ok) {
            // Never silent (11-20 02:54): a needs-you in the requester's lane, and the requesting Overlord told directly.
            const ny = notUpdatedNeedsYouText(req, s.note);
            const nr = await runVs(["log", "needs-you", ny, ...(req.team && req.lane ? ["--team", req.team, "--lane", req.lane] : [])]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
            if (!nr?.ok) log(`restart-request ${req.id}: needs-you log failed: ${nr?.error}`);
            if (req.requestedBy && req.requestedBy !== "owner") {
              const sr = await runVs(["send", req.requestedBy, ny]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
              if (!sr?.ok) log(`restart-request ${req.id}: send to ${req.requestedBy} failed: ${sr?.error}`);
            }
          }
        }
        let r;
        try { r = await fire(req); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
        await mutateAsync(home, (doc) => {
          if (doc.current?.id === req.id) doc.current.launch = { ok: Boolean(r?.ok), at: iso(now()), ...(r?.ok ? { out: clean(r.out, 300) } : { error: clean(r?.error ?? "unknown", 300) }) };
        });
        log(`restart-request ${req.id}: vs restart ${r?.ok ? "launched" : `failed: ${r?.error}`}`);
        continue;
      }
      const r = await runVs(a.kind === "log" ? logArgs(req, a.text) : ["send", a.leadId, a.text]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (a.kind === "ask") outcomes[a.leadId] = r;
      if (!r?.ok) log(`restart-request ${req.id}: ${a.kind}${a.leadId ? ` ${a.leadId}` : ""} failed: ${r?.error}`);
    }
    if (Object.keys(outcomes).length) {
      await mutateAsync(home, (doc) => {
        if (doc.current?.id !== req.id) return;
        for (const [id, r] of Object.entries(outcomes)) {
          const a = doc.current.asked?.[id];
          if (!a) continue;
          if (r?.ok) a.sentAt = iso(now());
          else a.error = clean(r?.error ?? "unknown", 200);
        }
      });
    }
    return { state: req?.state ?? null, actions };
  }

  const loop = {
    /** One step; concurrent calls share the running one. */
    tick() {
      if (!busy) busy = run().finally(() => { busy = null; });
      return busy;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void loop.tick().catch((e) => log(`restart-request tick failed: ${e?.message ?? e}`)), tickMs);
      timer.unref?.();
      void loop.tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return loop;
}

/** The runner POST /drain/request body for an open request (its id scopes the later DELETE). */
export function requestDrainBody(req, ttlMs = REQUEST_DRAIN_TTL_MS) {
  return { id: req.id, tip: req.tip, ttlMs, reason: `restart request ${req.id} for ${req.tip} (${req.state})` };
}

/** The production loop on the real home: the shared runner backend's agent list and /health held list. */
export async function startRestartRequestLoop({ home, log = (l) => console.warn(l) } = {}) {
  const { sharedRunnerBackend } = await import("./backend/index.mjs");
  const backend = sharedRunnerBackend();
  const loop = createRestartRequestLoop({
    home,
    log,
    listAgents: () => backend.listAgents(),
    listAgentsWithArchived: () => backend.listAgents({ filter: { includeArchived: true } }),
    heldList: async () => heldListFromHealth(await backend.rc.request("GET", "/health", undefined, { restartWait: false })),
    drain: {
      set: (req) => backend.rc.request("POST", "/drain/request", requestDrainBody(req), { restartWait: false }),
      clear: (id) => backend.rc.request("DELETE", "/drain/request", { id }, { restartWait: false }),
    },
  });
  loop.start();
  return loop;
}
