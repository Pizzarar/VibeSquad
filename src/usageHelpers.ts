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
  // v2 (usa-5): all optional so an older payload still renders.
  workingMs?: number;
  idleMs?: number;
  workPct?: number;
  avgUnitCycleMs?: number | null;
  planCycleMs?: number | null;
  planCycles?: number[];
  fixAfterMergeCount?: number;
  fixAfterMergeRate?: number;
};
export type RoleRow = Stats & { role: string };
export type PerLane = {
  lane: string;
  mergedUnits: number;
  reviewRounds: number;
  avgReviewRounds: number;
  costPerMergedUnit: number;
  // v2 (usa-5)
  avgUnitCycleMs?: number | null;
  fixAfterMergeCount?: number;
  fixAfterMergeRate?: number;
};
export type LoopRow = { agentId: string; lane: string; role: string; title?: string; turns: number };
export type SpawnStorm = {
  lane: string;
  role: string;
  count: number;
  windowMs: number;
  firstAt: string;
  lastAt: string;
  zeroTurnExits: number;
};
export type ProfileRow = {
  provider: string;
  profile: string;
  role: string;
  runs: number;
  turns: number;
  avgTurnsPerRun: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  workingMs: number;
  idleMs: number;
  passCount: number;
  passRate: number;
  loopCount: number;
  mergedUnits: number;
  reviewRounds: number;
  avgReviewRounds: number;
  costPerMergedUnit: number | null;
  fixAfterMergeCount: number;
  fixAfterMergeRate: number;
  avgUnitCycleMs: number | null;
};
export type UsageData = {
  limits: LimitRow[];
  lanes: LaneRow[];
  byRole: RoleRow[];
  coordination?: { coordinationTokens: number; executionTokens: number; coordinationShare: number };
  merged?: { perLane: PerLane[] };
  loops?: { threshold: number; flagged: LoopRow[] };
  byProfile?: ProfileRow[];
  spawnStorms?: SpawnStorm[];
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

/** Human duration from ms: `42m`, `3.1h`, `1.2d`, or `—` for missing/negative. */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

/** Fraction (0..1) -> `NN%`, or `—` for missing. */
export function pctText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** Work fraction (0..1) -> `NN% / NN%` work/idle split, or `—` for missing. */
export function workIdlePct(workPct: number | null | undefined): string {
  if (workPct === null || workPct === undefined || !Number.isFinite(workPct)) return "—";
  const w = Math.round(workPct * 100);
  return `${w}% / ${100 - w}%`;
}

/** One-line spawn-retry storm text: `lane · role · N spawns in Xm` (or `N zero-turn exits`). */
export function stormText(s: SpawnStorm): string {
  const mins = Math.max(1, Math.round((s.windowMs ?? 0) / 60_000));
  const tail = s.zeroTurnExits > 0 ? `${s.zeroTurnExits} zero-turn exits` : `${s.count} spawns in ${mins}m`;
  return `${s.lane} · ${s.role} · ${tail}`;
}

export type SortKey = "lane" | "tokens" | "costUsd" | "turns" | "avg" | "coord" | "restarts" | "handoffs" | "merged" | "rounds" | "costUnit" | "workPct" | "cycle" | "fixRate";
export type Row = {
  lane: string; tokens: number; costUsd: number; turns: number; avg: number; coord: number; restarts: number; handoffs: number;
  merged: number; rounds: number | null; costUnit: number | null; looped: number;
  workPct: number | null; unitCycleMs: number | null; planCycleMs: number | null; fixRate: number | null;
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
      workPct: typeof l.workPct === "number" ? l.workPct : null,
      unitCycleMs: l.avgUnitCycleMs ?? p?.avgUnitCycleMs ?? null,
      planCycleMs: l.planCycleMs ?? null,
      fixRate: l.fixAfterMergeRate ?? p?.fixAfterMergeRate ?? null,
    };
  });
}

const SORT_FIELD: Record<SortKey, keyof Row> = {
  lane: "lane", tokens: "tokens", costUsd: "costUsd", turns: "turns", avg: "avg", coord: "coord",
  restarts: "restarts", handoffs: "handoffs", merged: "merged", rounds: "rounds", costUnit: "costUnit",
  workPct: "workPct", cycle: "unitCycleMs", fixRate: "fixRate",
};

export function sortRows(rows: Row[], key: SortKey, dir: 1 | -1): Row[] {
  const field = SORT_FIELD[key];
  return [...rows].sort((a, b) => {
    const x = a[field] as string | number | null;
    const y = b[field] as string | number | null;
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

// ---- v2: implementer / profile comparison (usa-6)

/** One display row of the profile comparison table, with work% and fix rate normalised to fractions. */
export type ProfileView = {
  key: string;
  profile: string;
  provider: string;
  role: string;
  runs: number;
  turns: number;
  avgTurnsPerRun: number;
  passRate: number;
  mergedUnits: number;
  avgReviewRounds: number;
  costPerMergedUnit: number | null;
  fixRate: number;
  workPct: number | null;
};

const IMPLEMENTER_ROLES = new Set(["worker", "implementer"]);

export function buildProfiles(d: UsageData): ProfileView[] {
  return (d.byProfile ?? []).map((p) => {
    const total = (p.workingMs ?? 0) + (p.idleMs ?? 0);
    return {
      key: `${p.provider}|${p.profile}|${p.role}`,
      profile: p.profile,
      provider: p.provider,
      role: p.role,
      runs: p.runs ?? 0,
      turns: p.turns ?? 0,
      avgTurnsPerRun: p.avgTurnsPerRun ?? 0,
      passRate: p.passRate ?? 0,
      mergedUnits: p.mergedUnits ?? 0,
      avgReviewRounds: p.avgReviewRounds ?? 0,
      costPerMergedUnit: p.costPerMergedUnit ?? null,
      fixRate: p.fixAfterMergeRate ?? 0,
      workPct: total > 0 ? (p.workingMs ?? 0) / total : null,
    };
  });
}

/** Implementers first, then by merged units desc, then name. */
export function sortProfiles(rows: ProfileView[]): ProfileView[] {
  return [...rows].sort((a, b) => {
    const ai = IMPLEMENTER_ROLES.has((a.role || "").toLowerCase()) ? 0 : 1;
    const bi = IMPLEMENTER_ROLES.has((b.role || "").toLowerCase()) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (b.mergedUnits !== a.mergedUnits) return b.mergedUnits - a.mergedUnits;
    return a.profile.localeCompare(b.profile) || a.provider.localeCompare(b.provider);
  });
}
