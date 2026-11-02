import type { PaseoAgent } from "@getpaseo/client";
// VS identity resolver, synced from src/identity.ts (see scripts/sync-shared.mjs).
import { resolveAgentIdentity } from "../shared/vs/identity";
import type { Squad, SquadLane } from "../shared/squads";

export type LaneRow = {
  lane: SquadLane;
  leads: number;
  buddies: number;
  workers: number;
  running: number;
  needsYou: string[];
};
export type SquadRow = { squad: Squad; lanes: LaneRow[]; needsYou: number; agents: number };

const OTHER = "_other";

/** Mirrors VS attentionOf() minus the browser-local unread/hidden flags. */
export function needsYouReason(a: PaseoAgent): string | null {
  const l = (a.labels ?? {}) as Record<string, string>;
  if (a.pendingPermissions?.length) return `${a.pendingPermissions.length} permission request(s)`;
  const legacy = "needs-" + "au" + "b";
  const needs = l["needs-you"] || l[legacy];
  const until = Date.parse(l["needs-you-until"] || l[`${legacy}-until`] || "");
  if (!needs || needs === "cleared" || (!Number.isNaN(until) && until > Date.now())) return null;
  return l["needs-you-reason"] || l[`${legacy}-reason`] || needs;
}

export function buildSquads(teams: Squad[], agents: PaseoAgent[]): SquadRow[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rows = new Map<string, Map<string, LaneRow>>();
  for (const t of teams) {
    const lanes = new Map<string, LaneRow>();
    for (const lane of t.lanes) {
      if (lane.state === "removed") continue;
      lanes.set(lane.id, { lane, leads: 0, buddies: 0, workers: 0, running: 0, needsYou: [] });
    }
    rows.set(t.id, lanes);
  }
  for (const agent of agents) {
    const id = resolveAgentIdentity(agent as any, { teams, cwd: agent.cwd ?? "", agentsById: byId as any });
    if (id.isOrphan || id.isRetired || id.isDigest) continue;
    const lanes = rows.get(id.teamId);
    if (!lanes) continue;
    let row = lanes.get(id.laneId);
    if (!row) {
      row = lanes.get(OTHER);
      if (!row) {
        row = { lane: { id: OTHER, name: "No lane" }, leads: 0, buddies: 0, workers: 0, running: 0, needsYou: [] };
        lanes.set(OTHER, row);
      }
    }
    if (id.effectiveRole === "lead") row.leads++;
    else if (id.effectiveRole === "brainstorm") row.buddies++;
    else row.workers++;
    if (agent.status === "running") row.running++;
    const reason = needsYouReason(agent);
    if (reason) row.needsYou.push(`${agent.title || agent.id.slice(0, 8)}: ${reason}`);
  }
  return teams.map((squad) => {
    const lanes = [...(rows.get(squad.id)?.values() ?? [])];
    return {
      squad,
      lanes,
      needsYou: lanes.reduce((n, l) => n + l.needsYou.length, 0),
      agents: lanes.reduce((n, l) => n + l.leads + l.buddies + l.workers, 0),
    };
  });
}
