// One roster filter + char budget for every boot-context builder (Who's here, In flight, hubTeamsBlock).
// docs/PLAN_LEAN_BOOT_1109.md B2. Fill order: the lead, running workers, the last lane log lines, then `+N more`.
import { effectiveAgentRole, isDigestAgent, isLiveAgent, normalizeRoleLabel } from "./identity.mjs";

/** Hard cap on generated boot context (chars), beyond the brief and the rules. */
export const BOOT_CONTEXT_BUDGET = 4000;
export const MORE_WORKERS_HINT = "→ vs who all";

export function laneOfAgent(agent) {
  const l = agent?.labels ?? {};
  return String(l.lane || l.lead || "").trim().toLowerCase();
}

const stamp = (a) => Date.parse(a?.createdAt ?? a?.updatedAt ?? "") || 0;
const newestFirst = (a, b) => stamp(b) - stamp(a) || (Date.parse(b?.updatedAt ?? "") || 0) - (Date.parse(a?.updatedAt ?? "") || 0) || String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
const isClosed = (a) => String(a?.status ?? "").toLowerCase() === "closed";

/** A worker is "in flight" only with a real turn: running or starting, queued for a slot, or waiting on a permission. Finished runner workers report idle (parked maps to idle), so non-closed is not enough. */
export function hasActiveTurn(a) {
  if (Boolean(a?.queued)) return true;
  return ["running", "initializing", "starting", "queued"].includes(String(a?.status ?? "").toLowerCase());
}

/**
 * The lead and the running workers of one lane. A running (non-closed) lead beats a closed one. A closed lead counts
 * only when it is the newest lead in the lane AND resumable (dd4bf51: a parked or lost lead still reads as the lane's lead).
 * Workers: non-closed only; closed or resumable-closed ones are history, not "in flight".
 * `buddies` are live Brainstorm agents (titles for Who's here).
 */
export function bootRoster(agents, laneId) {
  const want = String(laneId ?? "").trim().toLowerCase();
  const inLane = (Array.isArray(agents) ? agents : [])
    .map((a) => a?.agent ?? a)
    .filter((a) => a && typeof a === "object" && !isDigestAgent(a) && laneOfAgent(a) === want);
  const ofRole = (role) => inLane.filter((a) => effectiveAgentRole(a) === role);
  const leads = inLane.filter((a) => normalizeRoleLabel(a) === "lead").filter((a) => !a.archivedAt && !a.archived && !a.internal).sort(newestFirst);
  const running = leads.filter((a) => isLiveAgent(a) && !isClosed(a));
  const lead = running[0] ?? (leads[0] && isLiveAgent(leads[0]) ? leads[0] : null);
  const workers = ofRole("worker").filter((a) => isLiveAgent(a) && !isClosed(a) && hasActiveTurn(a)).sort(newestFirst);
  const buddies = ofRole("brainstorm").filter((a) => isLiveAgent(a) && !isClosed(a));
  return { lead, workers, buddies };
}

/** Add rows from `rows` while they fit in `room` chars (each row costs its length + 1 newline). Returns { kept, used, dropped }. */
export function fitRows(rows, room) {
  const kept = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.length + 1 > room) break;
    kept.push(r);
    used += r.length + 1;
  }
  return { kept, used, dropped: rows.length - kept.length };
}
