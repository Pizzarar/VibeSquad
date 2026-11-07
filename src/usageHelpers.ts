// Pure helpers for UsageDashboard (.ts so node tests can import them).

export type LimitRow = {
  provider: string;
  window: string;
  usedPct: number;
  resetsAt: string | null;
  source?: string;
  at?: string;
  burnPctPerHour: number;
  etaToCap: string | null;
};
export type Stats = { turns: number; costUsd: number; inputTokens: number; outputTokens: number; avgTokensPerTurn: number };
export type LaneRow = Stats & {
  lane: string;
  agents: number;
  restarts: number;
  handoffs: number;
  coordinationShare: number;
};
export type RoleRow = Stats & { role: string };
export type PerLane = { lane: string; mergedUnits: number; reviewRounds: number; avgReviewRounds: number; costPerMergedUnit: number };
export type LoopRow = { agentId: string; lane: string; role: string; title?: string; turns: number };
export type UsageData = {
  limits: LimitRow[];
  lanes: LaneRow[];
  byRole: RoleRow[];
  coordination?: { coordinationTokens: number; executionTokens: number; coordinationShare: number };
  merged?: { perLane: PerLane[] };
  loops?: { threshold: number; flagged: LoopRow[] };
};

export function relTime(ms: number, now: number): string {
  const d = ms - now;
  const a = Math.abs(d);
  const m = Math.round(a / 60_000);
  const txt = m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
  return d >= 0 ? `in ${txt}` : `${txt} ago`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayTime(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function etaText(l: LimitRow): string {
  if (l.etaToCap) return `hits cap ~${dayTime(Date.parse(l.etaToCap))}`;
  return l.burnPctPerHour > 0 ? "won't cap before reset" : "idle · no burn";
}

export type SortKey = "lane" | "tokens" | "costUsd" | "turns" | "avg" | "coord" | "restarts" | "handoffs" | "merged" | "rounds" | "costUnit";
export type Row = {
  lane: string; tokens: number; costUsd: number; turns: number; avg: number; coord: number; restarts: number; handoffs: number;
  merged: number; rounds: number | null; costUnit: number | null; looped: number;
};
export function buildRows(d: UsageData): Row[] {
  const per = new Map((d.merged?.perLane ?? []).map((p) => [p.lane, p]));
  const loops = new Map<string, number>();
  for (const f of d.loops?.flagged ?? []) loops.set(f.lane, (loops.get(f.lane) ?? 0) + 1);
  return (d.lanes ?? []).map((l) => {
    const p = per.get(l.lane);
    return {
      lane: l.lane, tokens: l.inputTokens + l.outputTokens, costUsd: l.costUsd, turns: l.turns, avg: l.avgTokensPerTurn,
      coord: l.coordinationShare, restarts: l.restarts, handoffs: l.handoffs, merged: p?.mergedUnits ?? 0,
      rounds: p ? p.avgReviewRounds : null, costUnit: p ? p.costPerMergedUnit : null, looped: loops.get(l.lane) ?? 0,
    };
  });
}

export function sortRows(rows: Row[], key: SortKey, dir: 1 | -1): Row[] {
  return [...rows].sort((a, b) => {
    const x = a[key] as string | number | null;
    const y = b[key] as string | number | null;
    if (x === null && y === null) return a.lane.localeCompare(b.lane);
    if (x === null) return 1; // nulls always last
    if (y === null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
    return c * dir || a.lane.localeCompare(b.lane);
  });
}


/** Fold "former-*" (replaced) roles into their live role so the split stays brainstorm/lead/worker. Order: brainstorm, lead, worker, then others. */
export function foldRoles(roles: RoleRow[]): RoleRow[] {
  const m = new Map<string, RoleRow>();
  for (const r of roles) {
    const role = (r.role || "unknown").toLowerCase().replace(/^former[-_ ]/, "");
    const t = m.get(role);
    if (!t) { m.set(role, { ...r, role }); continue; }
    t.turns += r.turns; t.costUsd += r.costUsd; t.inputTokens += r.inputTokens; t.outputTokens += r.outputTokens;
  }
  const order = ["brainstorm", "lead", "worker"];
  return [...m.values()]
    .map((r) => ({ ...r, avgTokensPerTurn: r.turns ? Math.round((r.inputTokens + r.outputTokens) / r.turns) : 0 }))
    .sort((x, y) => (order.indexOf(x.role) + 1 || 99) - (order.indexOf(y.role) + 1 || 99));
}
