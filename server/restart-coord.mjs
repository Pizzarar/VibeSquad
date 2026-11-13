// Coordinated drain for `vs restart` (docs/PLAN_COORDINATED_DRAIN.md D1-D3). A restart that defers on background work
// names each holder's lane lead and a ready-to-send drain ask; a rerun within DRAIN_WINDOW_MS is refused until every
// named lead has logged `vs log restart-feedback "drained restart"`; a restart that then succeeds logs
// `restart-feedback: restart-done` and tells each asked lead, so they lift the hold. No new verb or log type: the
// handshake rides the existing restart-feedback metric subtype (stored as type "metric", text "restart-feedback: ...").
import fs from "node:fs";
import path from "node:path";
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
export function holderLeads(heldIds, agents, teams = loadTeamsRegistry()) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a?.id, a]));
  const leads = new Map();
  const unresolved = [];
  for (const id of heldIds ?? []) {
    const a = byId.get(id);
    if (!a) { unresolved.push({ agentId: id, reason: "not in the runner's agent list" }); continue; }
    const who = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (who.isOrphan || !who.teamId || !who.laneId) { unresolved.push({ agentId: id, reason: "no Squad/lane label" }); continue; }
    const candidates = list.filter((x) => whoCandidate(x, { teams, wantTeamId: who.teamId, wantLane: who.laneId })?.role === "lead");
    const { winner, conflict } = resolveLeadWinner(candidates);
    if (conflict) { unresolved.push({ agentId: id, reason: `lead CONFLICT in ${who.teamId}/${who.laneId}` }); continue; }
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
 * D2 retry guard: when the newest restart deferred less than DRAIN_WINDOW_MS ago, every lead it named must have logged a
 * drain since the deferral chain began. Returns { pending: [lead...], deferral } (pending empty = go).
 */
export function drainGuard(vsHome, { now = Date.now() } = {}) {
  const chain = deferralChain(vsHome, { now, maxAgeMs: DRAIN_WINDOW_MS });
  if (!chain) return { pending: [], deferral: null };
  const need = chain.latestLeads;
  const drained = drainedLeadIds(vsHome, need.map((l) => l.team), chain.since);
  return { pending: need.filter((l) => !drained.has(l.leadId)), deferral: chain.latest, since: chain.since };
}

export function drainGuardMessage({ pending, deferral }, now = Date.now()) {
  const ago = Math.max(0, Math.round((now - (Date.parse(deferral?.finishedAt ?? deferral?.startedAt ?? "") || now)) / 60000));
  const who = pending.map((l) => `${l.lane} lead ${l.leadId}${l.leadTitle ? ` (${l.leadTitle})` : ""} [holds ${l.heldAgents.join(", ")}]`).join("; ");
  return `vs restart: refused: the last restart deferred ${ago} min ago on background work, and these leads have not logged vs log restart-feedback '${DRAINED_TEXT}' yet: ${who}. ` +
    `Ask each to drain and hold background suites (ready-to-send asks: ${deferral?.file ?? "the restart-<ts>.json"} deferred.leads[].ask), wait for every 'drained', then rerun vs restart. ` +
    `No timer retries; --kill-background needs the owner's per-run OK.`;
}
