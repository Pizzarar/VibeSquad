// Coordinated drain for `vs restart` (docs/PLAN_COORDINATED_DRAIN.md D1-D3). A restart that defers on background work
// names each holder's lane lead and a ready-to-send drain ask; a rerun within DRAIN_WINDOW_MS is refused until every
// named lead has logged `vs log restart-feedback "drained restart"`; a restart that then succeeds logs
// `restart-feedback: restart-done` and tells each asked lead, so they lift the hold. No new verb or log type: the
// handshake rides the existing restart-feedback metric subtype (stored as type "metric", text "restart-feedback: ...").
import fs from "node:fs";
import path from "node:path";
import { toAgent } from "./backend/runner-backend.mjs";
import { loadTeamsRegistry, resolveAgentIdentity, resolveLeadWinner, whoCandidate } from "./identity.mjs";

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

/** The ask a restarter sends a holder lead (no double quotes or backticks: it pastes into `vs send <id> "..."` in any shell). */
export function drainAskText(lead, at) {
  return `Restart pending (vs restart deferred ${at ?? "just now"}): ${lead.heldAgents.join(", ")} in your lane hold background work. ` +
    `Please drain: let running suites finish, hold new background suites, then run: vs log restart-feedback '${DRAINED_TEXT}'. ` +
    `You will get '${DONE_TEXT}' after the restart; lift the hold then.`;
}

export function doneText(at) {
  return `${DONE_TEXT}: the VS restart finished${at ? ` (${at})` : ""}. Lift your background-suite hold.`;
}

/** The deferral's error line: who to ask, what to wait for, no timer retries, the owner gate. */
export function deferralMessage({ held, heldAgents, waitSec, leads, unresolved }) {
  const ask = leads.map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""} holds ${l.heldAgents.join(", ")}`);
  const miss = unresolved.map((u) => `${u.agentId} (${u.reason})`);
  return `deferred: ${held} agent(s) still hold background work after ${waitSec}s (${heldAgents.join(", ") || "ids unknown"}). ` +
    (ask.length ? `Ask these leads to drain and hold background suites: ${ask.join("; ")}. ` : "") +
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

/** Lead ids that logged `restart-feedback: drained restart` at or after `since`, from each team's log.jsonl under vsHome. */
export function drainedLeadIds(vsHome, teamIds, since) {
  const sinceMs = Date.parse(since ?? "") || 0;
  const out = new Set();
  for (const team of new Set(teamIds)) {
    let raw = "";
    try { raw = fs.readFileSync(path.join(vsHome, "teams", String(team), "log.jsonl"), "utf8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line.replace(/^﻿/, "")); } catch { continue; }
      if (e?.type === "metric" && DRAINED_RE.test(String(e.text ?? "")) && (Date.parse(e.ts ?? "") || 0) >= sinceMs) out.add(String(e.agent ?? ""));
    }
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
 * Returns { pending: [lead...], skipped: [lead...], deferral, since }.
 */
export function drainGuard(vsHome, { now = Date.now(), agents = null, teams = null } = {}) {
  const chain = deferralChain(vsHome, { now, maxAgeMs: DRAIN_WINDOW_MS });
  if (!chain) return { pending: [], skipped: [], deferral: null };
  const since = chain.latest.finishedAt ?? chain.latest.startedAt;
  const need = chain.latestLeads;
  const drained = drainedLeadIds(vsHome, need.map((l) => l.team), since);
  let list;
  let reg = null;
  const pending = [];
  const skipped = [];
  for (const l of need) {
    if (drained.has(l.leadId)) continue;
    if (list === undefined) {
      let got = null;
      try { got = typeof agents === "function" ? agents() : agents; } catch { got = null; }
      list = Array.isArray(got) && got.length ? got : null;
      if (list) reg = teams ?? loadTeamsRegistry();
    }
    if (list) {
      const cur = currentLaneLeads(list, reg, l.team, l.lane);
      if (cur.none) { skipped.push(l); continue; }
      if (cur.ids.some((id) => drained.has(id))) continue;
      pending.push({ ...l, currentLeadIds: cur.ids.filter((id) => id !== l.leadId) });
      continue;
    }
    pending.push(l);
  }
  return { pending, skipped, deferral: chain.latest, since };
}

/** One line for the lanes the guard skipped because they have no live lead any more ('' when none). */
export function drainSkippedNote(skipped) {
  if (!skipped?.length) return "";
  return `skipped (no live lead in the lane any more): ${skipped.map((l) => `${l.team}/${l.lane} (named lead ${l.leadId}, held ${l.heldAgents.join(", ")})`).join("; ")}.`;
}

export function drainGuardMessage({ pending, skipped = [], deferral }, now = Date.now()) {
  const ago = Math.max(0, Math.round((now - (Date.parse(deferral?.finishedAt ?? deferral?.startedAt ?? "") || now)) / 60000));
  const who = pending.map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""}${l.currentLeadIds?.length ? ` (now ${l.currentLeadIds.join(", ")})` : ""} [holds ${l.heldAgents.join(", ")}]`).join("; ");
  const skip = drainSkippedNote(skipped);
  return `vs restart: refused: the last restart deferred ${ago} min ago on background work, and these leads have not logged vs log restart-feedback '${DRAINED_TEXT}' yet: ${who}. ` +
    `Ask each to drain and hold background suites (ready-to-send asks: ${deferral?.file ?? "the restart-<ts>.json"} deferred.leads[].ask), wait for every 'drained', then rerun vs restart. ` +
    (skip ? `${skip[0].toUpperCase()}${skip.slice(1)} ` : "") +
    `No timer retries; --kill-background needs the owner's per-run OK.`;
}
