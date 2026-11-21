// Coordinated drain for `vs restart` (docs/PLAN_COORDINATED_DRAIN.md D1-D3). A restart that defers on background work
// names each holder's lane lead and a ready-to-send drain ask; a rerun within DRAIN_WINDOW_MS is refused until every
// named lead has logged `vs log restart-feedback "drained restart"`; a restart that then succeeds logs
// `restart-feedback: restart-done` and tells each asked lead, so they lift the hold. No new verb or log type: the
// handshake rides the existing restart-feedback metric subtype (stored as type "metric", text "restart-feedback: ...").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toAgent } from "./backend/runner-backend.mjs";
import { linesFromEndSync } from "./log-tail.mjs";
import { loadTeamsRegistry, resolveAgentIdentity, resolveLeadWinner, whoCandidate } from "./identity.mjs";
import { localTokenPath, readLocalToken } from "./local-token.mjs";

export const DRAIN_WINDOW_MS = 30 * 60000; // D2: a rerun this soon after a deferral needs every named lead's drain
export const DONE_CHAIN_MAX_MS = 24 * 3600000; // D3: deferrals older than this are not a live hold any more
export const DRAINED_TEXT = "drained restart";
export const DONE_TEXT = "restart-done";
const DRAINED_RE = /^restart-feedback:\s*drained restart\b/i;

/**
 * Group held agent ids by their lane's live lead, the `vs who lead` way: the holder's Squad/lane from its labels
 * (resolveAgentIdentity), the lane's lead candidates through whoCandidate, the winner through resolveLeadWinner.
 * Returns { leads: [{ team, lane, leadId, leadTitle, heldAgents }], unresolved: [{ agentId, reason }] }.
 */
export function holderLeads(heldIds, rawAgents, teams = loadTeamsRegistry()) {
  // The restart script hands over the runner's raw GET /agents?full=1 records (identity under meta.labels, no top-level labels);
  // whoCandidate / resolveAgentIdentity read the toAgent() shape. Fed raw, every lead read as a label-less worker and the
  // holder fell back to its cwd's lane ("no live lead in vibesquad/vibesquad", idea-215). Normalise records that carry meta.
  const list = (Array.isArray(rawAgents) ? rawAgents : []).map((a) => (a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a));
  const byId = new Map(list.map((a) => [a?.id, a]));
  const leads = new Map();
  const unresolved = [];
  for (const id of heldIds ?? []) {
    const a = byId.get(id);
    if (!a) { unresolved.push({ agentId: id, reason: "not in the runner's agent list" }); continue; }
    const who = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (who.isOrphan || !who.teamId || !who.laneId) { unresolved.push({ agentId: id, reason: "no Squad/lane label" }); continue; }
    // The holder's spawner (vs.parent) first: a live lead of the holder's lane is its owner by construction. Then the Squad/lane lookup.
    let winner = null;
    const parent = byId.get(String(a.labels?.["vs.parent"] ?? ""));
    if (parent && whoCandidate(parent, { teams, wantTeamId: who.teamId, wantLane: who.laneId })?.role === "lead") winner = parent;
    if (!winner) {
      const candidates = list.filter((x) => whoCandidate(x, { teams, wantTeamId: who.teamId, wantLane: who.laneId })?.role === "lead");
      const r = resolveLeadWinner(candidates);
      if (r.conflict) { unresolved.push({ agentId: id, reason: `lead CONFLICT in ${who.teamId}/${who.laneId}` }); continue; }
      winner = r.winner;
    }
    if (!winner) { unresolved.push({ agentId: id, reason: `no live lead in ${who.teamId}/${who.laneId}` }); continue; }
    const key = winner.id;
    if (!leads.has(key)) leads.set(key, { team: who.teamId, lane: who.laneId, leadId: winner.id, leadTitle: String(winner.title ?? winner.name ?? "").split(" · ")[0].trim() || null, heldAgents: [] });
    leads.get(key).heldAgents.push(id);
  }
  return { leads: [...leads.values()], unresolved };
}

/** A 'drained restart [<tip>]' self-report as the log stores it (the CLI prefixes the restart-feedback subtype). */
export const isDrainedFeedback = (text) => DRAINED_RE.test(String(text ?? "").trim());

/**
 * idea-476 (2): may `callerId` log 'drained restart' now? The runner's held list ({ ids, work }, its /health, checked
 * against live pids) is the truth, not the self-report: while any agent of the caller's lane holds background work the
 * drain is refused, naming each holder and its pids. "The caller's lane" is every held agent that holderLeads gives to
 * the caller (what the restart request's pendingLeads counts), the caller's own children (vs.parent), the caller itself,
 * and any holder whose Squad + lane resolve to the caller's (a retired predecessor lead and its workers included).
 * Fail closed: without a readable held list or agent list nothing is recorded as drained. Returns null (may log) or the
 * refusal reason.
 */
export function drainedLogRefusal(callerId, { held, agents, teams = loadTeamsRegistry(), callerTeam = null, callerLane = null } = {}) {
  const id = String(callerId ?? "");
  if (!held || !Array.isArray(held.ids)) return "not recorded as drained: the runner's held background work could not be read (runner down, booting or too old to report it). Retry once the runner answers; vs restart status shows what it holds.";
  if (!held.ids.length) return null;
  if (!Array.isArray(agents)) return "not recorded as drained: the runner holds background work and its agent list could not be read, so it is unknown whose. Retry in a moment.";
  const list = agents.map((a) => (a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a));
  const byId = new Map(list.map((a) => [a?.id, a]));
  // A holder's Squad/lane through the registry (aliases resolve); an agent the registry cannot place falls back to its raw
  // team + lane labels, so an unregistered lane still blocks its own lead rather than reading as nobody's.
  const laneOf = (a) => {
    if (!a) return null;
    const w = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (w && !w.isOrphan && w.teamId && w.laneId) return `${w.teamId}/${w.laneId}`;
    const team = a.labels?.team ?? a.team;
    const lane = a.labels?.lane ?? a.lane;
    return team && lane ? `${team}/${lane}` : null;
  };
  // The caller's lane: the server-verified caller identity first (callerTeam/callerLane), else its roster record.
  const mine = callerTeam && callerLane ? laneOf({ id, cwd: "", labels: { team: callerTeam, lane: callerLane, role: "lead" } }) : laneOf(byId.get(id));
  const blockers = new Set(holderLeads(held.ids, list, teams).leads.filter((l) => l.leadId === id).flatMap((l) => l.heldAgents));
  for (const h of held.ids) {
    const a = byId.get(h);
    if (h === id || (a && String(a.labels?.["vs.parent"] ?? "") === id) || (mine && laneOf(a) === mine)) blockers.add(h);
  }
  if (!blockers.size) return null;
  const ids = [...blockers];
  return `not drained: the runner still holds background work in your lane: ${ids.map((h) => { const w = workLine(held.work, h); return w ? `${h} (${w})` : h; }).join("; ")}. ` +
    `Let it finish, or stop it (${ids.map((h) => `vs stop ${h} --background`).join("; ")}; idle agents only), then log the drain again.`;
}

/** The ask a restarter sends a holder lead (no double quotes or backticks: it pastes into `vs send <id> "..."` in any shell). */
export function drainAskText(lead, at) {
  const holders = lead.heldAgents.map((id) => { const w = workLine(lead.heldWork, id); return w ? `${id} (${w})` : id; }).join(", ");
  return `Restart pending (vs restart deferred ${at ?? "just now"}): ${holders} in your lane hold background work. ` +
    `Please drain: let running suites finish, or stop what is not needed with vs stop <agent> --background (e.g. ${lead.heldAgents.map((id) => `vs stop ${id} --background`).join("; ")}; idle agents only, kills each shell's whole tree), hold new background suites, then run: vs log restart-feedback '${DRAINED_TEXT}'. ` +
    `You will get '${DONE_TEXT}' after the restart; lift the hold then.`;
}

/** "pid 4242: bash tools/run_suite.sh ..." for one agent's held shells (the runner's /health heldWork), "" when unknown. */
function workLine(heldWork, id) {
  const clean = (t) => String(t ?? "").replace(/[^\w .,:;=/@%+~#()[\]{}<>|&*?!$'-]+/g, " ").trim().slice(-80); // no quote, backtick or newline: it pastes into vs send "..."
  return (heldWork?.[id] ?? []).map((w) => `pid ${w.pid}: ${clean(w.cmd ?? w.name)}`).join(", ");
}

export function doneText(at) {
  return `${DONE_TEXT}: the VS restart finished${at ? ` (${at})` : ""}. Lift your background-suite hold.`;
}

/** The deferral's error line: who to ask, what to wait for, no timer retries, the owner gate. */
export function deferralMessage({ held, heldAgents, waitSec, leads, unresolved, heldWork }) {
  const hw = (l) => l.heldWork ?? heldWork;
  const ask = leads.map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""} holds ${l.heldAgents.map((id) => { const w = workLine(hw(l), id); return w ? `${id} (${w})` : id; }).join(", ")}`);
  const miss = unresolved.map((u) => `${u.agentId} (${u.reason})`);
  return `deferred: ${held} agent(s) still hold background work after ${waitSec}s (${heldAgents.join(", ") || "ids unknown"}). ` +
    (ask.length ? `Ask these leads to drain and hold background suites: ${ask.join("; ")}. ` : "") +
    (heldAgents.length ? `Idle holders can be stopped with ${heldAgents.map((id) => `vs stop ${id} --background`).join("; ")} (kills each shell's whole tree). ` : "") +
    (miss.length ? `No lead resolved for: ${miss.join("; ")}; find who owns it. ` : "") +
    `Wait for each lead's vs log restart-feedback '${DRAINED_TEXT}', then rerun vs restart (it refuses until they have); after it succeeds the leads get '${DONE_TEXT}' to lift the hold. ` +
    `No timer retries; --kill-background needs the owner's per-run OK.`;
}

/** restart-<ts>.json results in `dir`, newest first (file names sort by their ISO start time). */
function restartResults(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^restart-.*\.json$/.test(n)).sort().reverse().map((n) => {
    try { return { file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }; } catch { return null; }
  }).filter(Boolean);
}

/**
 * The deferred restarts since the last successful one (within maxAgeMs of `now`; dry runs and other failures skipped).
 * Returns null when there is none. `latest` is the newest deferral, `since` the chain's first
 * start (a drain logged after it counts), `leads` the union of every named lead (merged by leadId).
 */
export function deferralChain(dir, { now = Date.now(), maxAgeMs = DONE_CHAIN_MAX_MS } = {}) {
  const chain = [];
  for (const r of restartResults(dir)) {
    if (r.dryRun) continue;
    if (r.ok) break; // a restart went through: everything before it is settled
    if (now - (Date.parse(r.finishedAt ?? r.startedAt) || 0) > maxAgeMs) break;
    if (r.deferred) chain.push(r); // a failed non-deferred run (e.g. server not healthy) keeps the asked leads holding
  }
  if (!chain.length) return null;
  const leads = new Map();
  for (const r of chain) for (const l of r.deferred.leads ?? []) {
    const prev = leads.get(l.leadId);
    leads.set(l.leadId, prev ? { ...prev, heldAgents: [...new Set([...prev.heldAgents, ...l.heldAgents])] } : { ...l, heldAgents: [...l.heldAgents] });
  }
  const latest = chain[0];
  return { latest, since: chain[chain.length - 1].startedAt, leads: [...leads.values()], latestLeads: latest.deferred.leads ?? [] };
}

/** Team-log lines are appended with a ts taken just before the append, so writers can land a little out of order. */
export const DRAIN_LOG_SLACK_MS = 5 * 60000;

/**
 * Lead ids that logged `restart-feedback: drained restart` at or after `since`, from each team's log.jsonl under vsHome.
 * Reads each log from the end (idea-233): once a line is stamped more than DRAIN_LOG_SLACK_MS before `since`, every
 * older line is too (the log is append-only), so reading stops there instead of parsing the whole multi-MB log.
 */
export function drainedLeadIds(vsHome, teamIds, since) {
  const sinceMs = Date.parse(since ?? "") || 0;
  const stopMs = sinceMs - DRAIN_LOG_SLACK_MS;
  const out = new Set();
  for (const team of new Set(teamIds)) {
    try {
      for (const line of linesFromEndSync(path.join(vsHome, "teams", String(team), "log.jsonl"))) {
        let e;
        try { e = JSON.parse(line.replace(/^﻿/, "")); } catch { continue; }
        const ts = Date.parse(e?.ts ?? "");
        if (ts < stopMs) break; // NaN (no/garbled ts) never stops the scan
        if (e?.type === "metric" && ts >= sinceMs && DRAINED_RE.test(String(e.text ?? ""))) out.add(String(e.agent ?? ""));
      }
    } catch { continue; } // no log for this Squad
  }
  return out;
}

/**
 * The lane's live lead now, the `vs who lead` way (whoCandidate + resolveLeadWinner over the runner's agent list).
 * { ids: [lead ids whose drain counts], none: true when the lane has no live lead any more }.
 */
function currentLaneLeads(agents, teams, team, lane) {
  const candidates = agents.filter((x) => whoCandidate(x, { teams, wantTeamId: team, wantLane: lane })?.role === "lead");
  const { winner, conflict, contenders = [] } = resolveLeadWinner(candidates);
  if (winner) return { ids: [winner.id], none: false };
  if (conflict) return { ids: contenders, none: false };
  return { ids: [], none: true };
}

/**
 * D2 retry guard: when the newest restart deferred less than DRAIN_WINDOW_MS ago, every lead it named must have logged a
 * drain after that deferral ended (R2 M1: not the chain's first start, so a drain before a later deferral, or one logged
 * while the deferral was still waiting, never satisfies it). With `agents` (the runner's list, the `vs who lead` source),
 * a drain by the lane's CURRENT live lead counts too (R2 M2: the named lead handed off or retired), and a lane with no
 * live lead any more is skipped (returned in `skipped`). Without an agent list (or an empty one) only the named lead
 * counts and nothing is skipped (fail closed). `agents` may be a thunk, called only when a named lead is still undrained.
 *
 * Ideas 228 + 229: a lead's 'drained restart' is a self-report, not the truth. With `held` (the runner's /health held list,
 * checked against live pids: an id array, { ids, work } or a thunk returning either), the runner decides: a named lead
 * whose held agents the runner no longer holds is done whether or not it logged a drain (returned in `cleared`), and one
 * whose agents are still held stays pending even after logging 'drained' (`stillHeld`, `drainedButHeld`, `heldWork`).
 * Without a held list (runner down, older runner, a throwing thunk) the self-report rule above stands (fail closed).
 * Returns { pending: [lead...], skipped: [lead...], cleared: [lead...], deferral, since }.
 */
export function drainGuard(vsHome, { now = Date.now(), agents = null, teams = null, held = null } = {}) {
  const chain = deferralChain(vsHome, { now, maxAgeMs: DRAIN_WINDOW_MS });
  if (!chain) return { pending: [], skipped: [], cleared: [], deferral: null };
  const since = chain.latest.finishedAt ?? chain.latest.startedAt;
  const need = chain.latestLeads;
  const drained = drainedLeadIds(vsHome, need.map((l) => l.team), since);
  const truth = heldTruth(held);
  let list;
  let reg = null;
  const pending = [];
  const skipped = [];
  const cleared = [];
  for (const l of need) {
    let still = null; // with the runner's held list: what of this lead's still holds (a drained log never settles that)
    if (truth) {
      const stillHeld = (l.heldAgents ?? []).filter((id) => truth.ids.has(id));
      if (!stillHeld.length) { cleared.push(l); continue; } // the runner holds none of them: nothing left to drain
      still = { stillHeld, heldWork: Object.fromEntries(stillHeld.filter((id) => truth.work[id]?.length).map((id) => [id, truth.work[id]])) };
    }
    if (!still && drained.has(l.leadId)) continue;
    if (list === undefined) {
      let got = null;
      try { got = typeof agents === "function" ? agents() : agents; } catch { got = null; }
      list = Array.isArray(got) && got.length ? got : null;
      if (list) reg = teams ?? loadTeamsRegistry();
    }
    if (list) {
      const cur = currentLaneLeads(list, reg, l.team, l.lane);
      if (cur.none) { skipped.push(l); continue; }
      if (!still && cur.ids.some((id) => drained.has(id))) continue;
      pending.push({ ...l, currentLeadIds: cur.ids.filter((id) => id !== l.leadId), ...(still ? { ...still, drainedButHeld: drained.has(l.leadId) || cur.ids.some((id) => drained.has(id)) } : {}) });
      continue;
    }
    pending.push(still ? { ...l, ...still, drainedButHeld: drained.has(l.leadId) } : l);
  }
  return { pending, skipped, cleared, deferral: chain.latest, since };
}

/** The runner's held list in one shape ({ ids: Set, work: { id: [{ pid, cmd }] } }), or null when unknown. */
function heldTruth(held) {
  let got = held;
  try { if (typeof got === "function") got = got(); } catch { return null; }
  if (Array.isArray(got)) return { ids: new Set(got.map(String)), work: {} };
  if (got && typeof got === "object" && Array.isArray(got.ids)) return { ids: new Set(got.ids.map(String)), work: got.work && typeof got.work === "object" ? got.work : {} };
  return null;
}

/** One line for the lanes the guard skipped because they have no live lead any more ('' when none). */
export function drainSkippedNote(skipped) {
  if (!skipped?.length) return "";
  return `skipped (no live lead in the lane any more): ${skipped.map((l) => `${l.team}/${l.lane} (named lead ${l.leadId}, held ${l.heldAgents.join(", ")})`).join("; ")}.`;
}

export function drainGuardMessage({ pending, skipped = [], deferral }, now = Date.now()) {
  const ago = Math.max(0, Math.round((now - (Date.parse(deferral?.finishedAt ?? deferral?.startedAt ?? "") || now)) / 60000));
  const plain = pending.filter((l) => !l.stillHeld);
  const held = pending.filter((l) => l.stillHeld);
  const who = plain.map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""}${l.currentLeadIds?.length ? ` (now ${l.currentLeadIds.join(", ")})` : ""} [holds ${l.heldAgents.join(", ")}]`).join("; ");
  const skip = drainSkippedNote(skipped);
  return `vs restart: refused: the last restart deferred ${ago} min ago on background work` +
    (plain.length ? `, and these leads have not logged vs log restart-feedback '${DRAINED_TEXT}' yet: ${who}. ` +
      `Ask each to drain and hold background suites (ready-to-send asks: ${deferral?.file ?? "the restart-<ts>.json"} deferred.leads[].ask), wait for every 'drained', then rerun vs restart. ` : ". ") +
    (held.length ? `The runner still holds background work for: ${held.map(stillHeldLine).join("; ")}. ` +
      `A 'drained' log is not enough while the runner holds it: wait for the work to finish, or have it stopped (runner POST /agents/<id>/stop-background kills each shell's whole tree), then rerun vs restart. ` : "") +
    (skip ? `${skip[0].toUpperCase()}${skip.slice(1)} ` : "") +
    `No timer retries; --kill-background needs the owner's per-run OK.`;
}

function stillHeldLine(l) {
  const work = (id) => (l.heldWork?.[id] ?? []).map((w) => `pid ${w.pid}: ${String(w.cmd ?? w.name ?? "").trim().slice(-80)}`).join(", ");
  const ids = l.stillHeld.map((id) => (work(id) ? `${id} (${work(id)})` : id)).join(", ");
  return `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""} ${l.drainedButHeld ? `logged '${DRAINED_TEXT}' but the runner still holds` : "has not drained; the runner still holds"} ${ids}`;
}

/**
 * idea-197 (docs/PLAN_PER_POST03.md P4): the D2 window seen from the suite-slot and runtime-sync side. While the newest
 * restart deferred less than DRAIN_WINDOW_MS ago and none has gone through since (the same deferralChain the D2 guard
 * reads), its named leads were asked to hold background suites until 'restart-done'. A new full suite or a runtime sync
 * started now is fresh work the restart has to wait out, so those entry points refuse. Read only: no log, no new verb.
 * Returns null when no drain is pending, else { deferral, leads, ageMin, leftMin }.
 */
export function restartDrainPending(vsHome, { now = Date.now() } = {}) {
  const chain = deferralChain(vsHome, { now, maxAgeMs: DRAIN_WINDOW_MS });
  if (!chain) return null;
  const at = Date.parse(chain.latest.finishedAt ?? chain.latest.startedAt ?? "") || now;
  return {
    deferral: chain.latest,
    leads: chain.latestLeads,
    ageMin: Math.max(0, Math.round((now - at) / 60000)),
    leftMin: Math.max(1, Math.ceil((at + DRAIN_WINDOW_MS - now) / 60000)),
  };
}

/** The refusal line for `action` ("npm test", "sync-runtime") while restartDrainPending() is non-null. */
export function drainPendingMessage(action, pending, hint = "") {
  const who = (pending.leads ?? []).map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""}`).join("; ");
  return `${action} refused: a VS restart is waiting on a coordinated drain (it deferred ${pending.ageMin} min ago, ` +
    `${pending.deferral?.file ?? "~/.vibesquad/restart-<ts>.json"}${who ? `; leads asked to drain: ${who}` : ""}). ` +
    `Full suites and runtime syncs hold until the restart goes through (the asked leads get '${DONE_TEXT}') ` +
    `or the ${DRAIN_WINDOW_MS / 60000}-min drain window ends (~${pending.leftMin} min left); rerun then, no timer retries.` +
    (hint ? ` ${hint}` : "") +
    ` Owner override (the owner's shell only, per-run OK, logged as restart-feedback): rerun with ${DRAIN_OVERRIDE_FLAG} or ${DRAIN_OVERRIDE_ENV}=1.`;
}

// The owner's override for the suite-slot and sync guards, in the style of `vs restart --kill-background`: owner's shell
// only (no agent identity, the local token readable), per run, and never silent: each use logs one restart-feedback line.
export const DRAIN_OVERRIDE_FLAG = "--ignore-drain";
export const DRAIN_OVERRIDE_ENV = "VIBESQUAD_IGNORE_DRAIN";

export function drainOverrideRequested(argv = [], env = process.env) {
  return argv.includes(DRAIN_OVERRIDE_FLAG) || String(env[DRAIN_OVERRIDE_ENV] ?? "").trim() === "1";
}

/** The owner's shell, the way cli/vs.mjs ownerProofFromEnv decides it (kept in step by hand: vs.mjs is the CLI entry). */
export function drainOverrideOwner(env = process.env) {
  if (["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN"].some((k) => String(env[k] ?? "").trim())) return false;
  const base = String(env.VIBESQUAD_HOME || "").trim() || (env.USERPROFILE || env.HOME ? path.join(String(env.USERPROFILE || env.HOME), ".vibesquad") : "");
  return Boolean(base && readLocalToken(localTokenPath(base)));
}

const VS_CLI = path.resolve(import.meta.dirname, "..", "cli", "vs.mjs");
/** One `vs` call from the owner's shell. Never throws: { ok } or { ok: false, error }. */
function runVsLog(args, env = process.env) {
  const r = spawnSync(process.execPath, [VS_CLI, ...args], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.status === 0) return { ok: true };
  const out = String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim();
  return { ok: false, error: out.split(String.fromCharCode(10))[0].trim().slice(0, 200) };
}

/**
 * The idea-197 guard for one entry point (`action`: "npm test", "sync-runtime"). No pending drain: { ok: true }.
 * A pending drain without the override, or with it from a non-owner shell: { ok: false, message }. With the owner's
 * override: { ok: true, overridden: true, logged, note }, after one `vs log restart-feedback "drain-override <action> ..."`
 * line in the first asked lead's lane (so the leads holding their suites see who went ahead). A failed log does not undo
 * the owner's OK; the note says so and asks to tell the leads.
 */
export function checkDrainGuard(action, { vsHome, env = process.env, override = false, now = Date.now(), hint = "", logVs = runVsLog } = {}) {
  let pending = null;
  try { pending = restartDrainPending(vsHome, { now }); } catch { pending = null; } // an unreadable home leaves the entry as it was
  if (!pending) return { ok: true };
  if (!override) return { ok: false, pending, message: drainPendingMessage(action, pending, hint) };
  if (!drainOverrideOwner(env)) {
    return { ok: false, pending, message: `${action} ${DRAIN_OVERRIDE_FLAG}: needs the owner's per-run OK; only the owner's shell may pass it (an agent or Overlord may not). ` + drainPendingMessage(action, pending, hint) };
  }
  const lead = pending.leads?.[0];
  const file = pending.deferral?.file ? path.basename(pending.deferral.file) : "restart-<ts>.json";
  const text = `drain-override ${action}: the owner went ahead during the coordinated drain (restart deferred ${pending.ageMin} min ago, ${file})`;
  const logged = logVs(["log", "restart-feedback", text, ...(lead ? ["--team", lead.team, "--lane", lead.lane] : [])], env);
  const note = logged.ok
    ? `${action}: ${DRAIN_OVERRIDE_FLAG}: going ahead during the coordinated drain (owner's per-run OK; logged restart-feedback in ${lead ? `${lead.team}/${lead.lane}` : "the log"}).`
    : `${action}: ${DRAIN_OVERRIDE_FLAG}: going ahead during the coordinated drain (owner's per-run OK), but the restart-feedback log failed (${logged.error}); tell the asked leads.`;
  return { ok: true, overridden: true, pending, logged, text, note };
}
