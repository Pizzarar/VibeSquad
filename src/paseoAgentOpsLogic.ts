// Pure logic for agent ops (delete guard, bulk-stop targets). No imports so node --test can load it.
// Labels, never titles, decide roles.

export type OpAgent = {
  id: string;
  title?: string | null;
  cwd?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
};

const roleOf = (a: OpAgent) => String(a.labels?.role ?? "");
const isLive = (a: OpAgent) => !a.archivedAt && a.status !== "closed";

/** Live Lead/Buddy agents get an extra warning line before a permanent delete. */
export function deleteGuard(a: OpAgent): { warning: string | null } {
  const role = roleOf(a);
  if (isLive(a) && (role === "lead" || role === "brainstorm")) {
    const what = role === "lead" ? "Lead" : "Buddy";
    return { warning: `This is a live ${what}. Deleting it removes the ${what} for its lane and can orphan attached workers.` };
  }
  return { warning: null };
}

export type StopScope = { teamId: string } | { cwd: string };
export type StopCandidate = { agent: OpAgent; teamId?: string | null };

const normCwd = (p: string | null | undefined) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Running, non-archived agents inside the scope. */
export function bulkStopTargets(cands: StopCandidate[], scope: StopScope): OpAgent[] {
  return cands
    .filter(({ agent, teamId }) => {
      if (agent.archivedAt || agent.status !== "running") return false;
      return "teamId" in scope ? teamId === scope.teamId : !!normCwd(scope.cwd) && normCwd(agent.cwd) === normCwd(scope.cwd);
    })
    .map((c) => c.agent);
}

/** Distinct cwds that currently have running agents, with counts (for the palette). */
export function runningCwds(agents: OpAgent[]): { cwd: string; count: number }[] {
  const map = new Map<string, { cwd: string; count: number }>();
  for (const a of agents) {
    if (a.archivedAt || a.status !== "running" || !a.cwd) continue;
    const k = normCwd(a.cwd);
    const cur = map.get(k);
    if (cur) cur.count++;
    else map.set(k, { cwd: a.cwd, count: 1 });
  }
  return [...map.values()].sort((x, y) => y.count - x.count);
}

