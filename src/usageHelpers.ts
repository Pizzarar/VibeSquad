// Pure helpers for UsageDashboard (.ts so node tests can import them).

import type { InboxCard } from "./types";

export type LimitRow = {
  provider: string;
  window: string;
  usedPct: number;
  resetsAt: string | null;
  source?: string;
  at?: string;
  burnPctPerHour: number;
  etaToCap: string | null;
  poolAgents?: { count: number; agentIds: string[]; text: string };
};

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  "antigravity-cli": "Gemini",
  "antigravity-cli/claude-gpt": "Gemini plan · 3rd-party models (Claude/GPT)",
};
export const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? p;

/** Hover text for a limit card's name; only the Antigravity 3rd-party pool needs one. */
export function limitTooltip(l: Pick<LimitRow, "provider" | "poolAgents">): string | undefined {
  if (l.provider !== "antigravity-cli/claude-gpt") return undefined;
  return `Google Antigravity's built-in 3rd-party model pool (Claude/GPT through your Gemini plan), separate from the Anthropic Claude subscription. Used here by: ${l.poolAgents?.text ?? "0 VibeSquad agents (used outside VibeSquad)"}.`;
}
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
  successRate?: number | null;
  successBasis?: string;
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
  usageReview?: UsageReview;
  cohorts?: Cohorts;
  floor?: Floor;
  savings?: Savings;
  byWorkflow?: WorkflowRow[];
  squad?: string | null;
  squads?: string[];
  autonomy?: Autonomy;
  readyTime?: ReadyTime | null;
  compaction?: CompactionStats | null;
};

/** usa-24 autonomy block (server/providers-catalog.mjs getUsage). Ratios are null when their denominator is 0. */
export type SquadAutonomyRow = {
  squad: string; mergedUnits: number; turns: number; costUsd: number; firstTryPassRate: number | null; avgReviewRounds: number | null;
  costPerUnit: number | null; ownerTouches: number; unitsPerOwnerTouch: number | null; longestUnassistedStreak: number; stalls: number; medianUnblockMs: number | null;
};
export type Autonomy = {
  ownerTouches: { total: number; needsYou: number; you: number; xsquadInput: number; perMergedUnit: number | null; unitsPerOwnerTouch: number | null; perHandoff: number | null };
  unassistedStreak: { current: number; longest: number };
  stalls: { total: number; blockers: number; failRuns: number; medianUnblockMs: number | null; p90UnblockMs: number | null };
  planAutonomy: { handoffs: number; mergedUnits: number; unitsPerHandoff: number | null; avgPlanCycleMs: number | null };
  bySquad: SquadAutonomyRow[];
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
  successRate: number | null;
  successBasis: string;
  mergedUnits: number;
  avgReviewRounds: number;
  costPerMergedUnit: number | null;
  fixRate: number;
  workPct: number | null;
};

const IMPLEMENTER_ROLES = new Set(["worker", "implementer"]);

const RAW_PROFILE_ID = /^agent_profile_/i;
export const ORPHAN_PROFILE_LABEL = "(unlabelled profile)";

/** Raw `agent_profile_*` ids (profile deleted or never named) collapse to one readable label. */
export function humanizeProfile(profile: string): string {
  return RAW_PROFILE_ID.test(profile || "") ? ORPHAN_PROFILE_LABEL : profile;
}

/** Combine two folded rows' success scores: weight by merged units (implementer basis) or runs (otherwise); null only if both are. */
function mergeSuccess(a: ProfileView, b: ProfileView): { successRate: number | null; successBasis: string } {
  if (a.successRate === null || b.successRate === null) {
    const keep = a.successRate !== null ? a : b;
    return { successRate: keep.successRate, successBasis: keep.successRate === null ? a.successBasis : keep.successBasis };
  }
  const byUnits = a.successBasis === "implementer-first-try-pass";
  const wa = byUnits ? a.mergedUnits : a.runs;
  const wb = byUnits ? b.mergedUnits : b.runs;
  return { successRate: wa + wb > 0 ? (a.successRate * wa + b.successRate * wb) / (wa + wb) : a.successRate, successBasis: a.successBasis };
}

const SUCCESS_BASIS_LABEL: Record<string, string> = {
  "implementer-first-try-pass": "Implementer: merged units that passed review on the first try",
  "reviewer-pass-lines": "Reviewer: runs that ended with a PASS verdict",
  "no-signal": "No reliable log signal for this role (plan done / handoff accepted are not recorded)",
};
/** Success cell text: percent, or `—` when the role has no signal. */
export const successText = (p: Pick<ProfileView, "successRate">): string => pctText(p.successRate);
export const successTooltip = (p: Pick<ProfileView, "successBasis">): string => SUCCESS_BASIS_LABEL[p.successBasis] ?? p.successBasis;

export function buildProfiles(d: UsageData): ProfileView[] {
  const out = new Map<string, ProfileView>();
  const msByKey = new Map<string, { work: number; idle: number }>();
  for (const p of d.byProfile ?? []) {
    const total = (p.workingMs ?? 0) + (p.idleMs ?? 0);
    const view: ProfileView = {
      key: `${p.provider}|${humanizeProfile(p.profile)}|${p.role}`,
      profile: humanizeProfile(p.profile),
      provider: p.provider,
      role: p.role,
      runs: p.runs ?? 0,
      turns: p.turns ?? 0,
      avgTurnsPerRun: p.avgTurnsPerRun ?? 0,
      passRate: p.passRate ?? 0,
      // role-specific success; rows from an older server (no successRate) fall back to passRate
      successRate: p.successBasis === undefined ? (p.passRate ?? 0) : (p.successRate ?? null),
      successBasis: p.successBasis ?? "reviewer-pass-lines",
      mergedUnits: p.mergedUnits ?? 0,
      avgReviewRounds: p.avgReviewRounds ?? 0,
      costPerMergedUnit: p.costPerMergedUnit ?? null,
      fixRate: p.fixAfterMergeRate ?? 0,
      workPct: total > 0 ? (p.workingMs ?? 0) / total : null,
    };
    const ms = msByKey.get(view.key) ?? { work: 0, idle: 0 };
    ms.work += p.workingMs ?? 0;
    ms.idle += p.idleMs ?? 0;
    msByKey.set(view.key, ms);
    const prev = out.get(view.key);
    if (!prev) {
      out.set(view.key, view);
      continue;
    }
    // Folded orphan ids: combine with run/unit weights so the merged row stays honest.
    const runs = prev.runs + view.runs;
    const units = prev.mergedUnits + view.mergedUnits;
    const wRun = (a: number, b: number) => (runs > 0 ? (a * prev.runs + b * view.runs) / runs : 0);
    const wUnit = (a: number, b: number) => (units > 0 ? (a * prev.mergedUnits + b * view.mergedUnits) / units : 0);
    const cost = prev.costPerMergedUnit === null && view.costPerMergedUnit === null ? null : wUnit(prev.costPerMergedUnit ?? 0, view.costPerMergedUnit ?? 0);
    out.set(view.key, {
      ...prev,
      runs,
      turns: prev.turns + view.turns,
      avgTurnsPerRun: runs > 0 ? (prev.turns + view.turns) / runs : 0,
      passRate: wRun(prev.passRate, view.passRate),
      ...mergeSuccess(prev, view),
      mergedUnits: units,
      avgReviewRounds: wUnit(prev.avgReviewRounds, view.avgReviewRounds),
      costPerMergedUnit: cost,
      fixRate: wUnit(prev.fixRate, view.fixRate),
      workPct: ms.work + ms.idle > 0 ? ms.work / (ms.work + ms.idle) : null,
    });
  }
  return [...out.values()];
}

// ---- usa-16: Bug Chaser inbox view (pure; cards come from IdeaInbox's useInboxCards)

export type InboxFilter = "all" | "queue" | "accepted" | "closed";
export const INBOX_FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "ALL" },
  { key: "queue", label: "IN QUEUE" },
  { key: "accepted", label: "ACCEPTED" },
  { key: "closed", label: "REJECTED" },
];
export const BUG_CHASER_LANE = "bug-chaser";
export const PERFECTION_LANE = "perfection";

/** Bucket a card for the filter pills. Closed wins over accepted; accepted wins over queue. */
export function inboxBucket(c: Pick<InboxCard, "status" | "topicAgentId"> & { deliveredAt?: string | null }): Exclude<InboxFilter, "all"> {
  if (c.status === "rejected" || c.status === "archived") return "closed";
  if (c.status === "accepted" || c.status === "handed-off" || c.topicAgentId || c.deliveredAt) return "accepted";
  return "queue";
}

/** Triage inbox scope: bug-chaser or perfection lane cards, plus any card a usage review sent. */
export function isTriageCard(c: Pick<InboxCard, "laneId" | "source">): boolean {
  const lane = String(c.laneId ?? "").toLowerCase();
  return lane === BUG_CHASER_LANE || lane === PERFECTION_LANE || Boolean(c.source?.startsWith("usage-review"));
}

export function bugInboxCards(cards: InboxCard[]): InboxCard[] {
  return cards.filter(isTriageCard).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export type LaneBadge = { key: string; label: string };
export function inboxLaneBadge(laneId: string | undefined): LaneBadge {
  const lane = String(laneId ?? "").toLowerCase();
  if (lane === BUG_CHASER_LANE) return { key: "bug", label: "Bug" };
  if (lane === PERFECTION_LANE) return { key: "perfection", label: "Perfection" };
  return { key: "other", label: lane || "other" };
}

export function inboxCounts(cards: InboxCard[]): Record<InboxFilter, number> {
  const n: Record<InboxFilter, number> = { all: cards.length, queue: 0, accepted: 0, closed: 0 };
  for (const c of cards) n[inboxBucket(c)] += 1;
  return n;
}

export function filterInbox(cards: InboxCard[], f: InboxFilter): InboxCard[] {
  return f === "all" ? cards : cards.filter((c) => inboxBucket(c) === f);
}

export type InboxFromKey = "opus" | "gemini" | "bug" | "perfection" | "other";
/** Mail-style sender for the CRT row: usage-review cards name the reviewing model, the rest name their lane. */
export function inboxFrom(c: Pick<InboxCard, "laneId" | "source">): { key: InboxFromKey; label: string } {
  const s = (c.source ?? "").toLowerCase();
  if (s === "usage-review:opus") return { key: "opus", label: "OPUS" };
  if (s === "usage-review:gemini") return { key: "gemini", label: "GEM" };
  const lane = inboxLaneBadge(c.laneId);
  if (lane.key === "bug") return { key: "bug", label: "BUG" };
  if (lane.key === "perfection") return { key: "perfection", label: "PERF" };
  return { key: "other", label: lane.label.toUpperCase() };
}

export function inboxStatusLabel(c: Pick<InboxCard, "status" | "topicAgentId">): string {
  const b = inboxBucket(c);
  return b === "closed" ? (c.status === "rejected" ? "Rejected" : "Closed") : b === "accepted" ? "In flight" : "Queued";
}

export function inboxIdLabel(id: string): string {
  return `#${id}`;
}

const money = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

export function profileSummary(profiles: unknown[]): string {
  return `Implementer / Profile comparison · ${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
}

export function workflowSummary(savings: { routingSavingsUsd: number; parallelSpeedup: number | null } | null | undefined, modes: number): string {
  const parts = ["Savings & Workflow Era"];
  if (savings) parts.push(`saved ${usdText(savings.routingSavingsUsd)} vs Opus`, `${speedupText(savings.parallelSpeedup)} speedup`);
  parts.push(`${modes} mode${modes === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function rolesSummary(coordShare: number | null | undefined, loops: number, storms: number): string {
  const split = typeof coordShare === "number" && Number.isFinite(coordShare) ? `coord ${pctText(coordShare)} / exec ${pctText(1 - coordShare)}` : "coord — / exec —";
  return `Roles, Loops & Storms · ${split} · ${loops} loop${loops === 1 ? "" : "s"} · ${storms} storm${storms === 1 ? "" : "s"}`;
}

export function efficiencySummary(cohorts: { recent: { firstTryPassRate?: number | null } } | null | undefined, floor: { cleanShare: number | null; cleanCostPerUnit: number | null } | null | undefined): string {
  const parts = ["Efficiency & Clean-Run Floor"];
  if (cohorts) parts.push(`1st-try PASS ${pctText(cohorts.recent.firstTryPassRate)}`);
  if (floor) parts.push(`clean ${pctText(floor.cleanShare)} (${usdText(floor.cleanCostPerUnit)}/unit)`);
  return parts.join(" · ");
}

/** Persistence key for a collapsible dashboard section. */
export const usageOpenKey = (id: string): string => `vs.usage.open.${id}`;

/** One-line rollups for the collapsed detail tables. */
export function laneSummary(rows: { costUsd: number; merged: number; looped?: number }[]): string {
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  const merged = rows.reduce((s, r) => s + r.merged, 0);
  const loops = rows.reduce((s, r) => s + (r.looped ?? 0), 0);
  return `Lane breakdown · ${rows.length} lane${rows.length === 1 ? "" : "s"} · ${money(cost)} · ${merged} merged · ${loops} loop${loops === 1 ? "" : "s"}`;
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

// ---- usa-8: Opus & Gemini usage review section

export type ReviewResult = { ok: boolean; text?: string; error?: string; ms?: number };
export type UsageReviewRecord = {
  at: string;
  trigger: string;
  interval: string;
  turnsAtRun: number;
  opus: ReviewResult;
  gemini: ReviewResult;
};
export type UsageReview = {
  interval: string;
  inFlight: boolean;
  last: UsageReviewRecord | null;
  nextAt: string | null;
  waitingForTurns: boolean;
  history: UsageReviewRecord[];
};

export const USAGE_REVIEW_INTERVALS = ["off", "6h", "12h", "1d", "3d", "5d", "2w"] as const;
export type UsageReviewInterval = (typeof USAGE_REVIEW_INTERVALS)[number];
export const USAGE_REVIEW_LABELS: Record<UsageReviewInterval, string> = {
  off: "Off", "6h": "6h", "12h": "12h", "1d": "1d", "3d": "3d", "5d": "5d", "2w": "2w",
};

/** Status line for the review section: `off`, `waiting for new turns`, `never reviewed`, or `last reviewed … · next in …` / `… · due`. */
export function usageReviewStatus(r: UsageReview | null | undefined, now: number): string {
  if (!r) return "";
  if (r.interval === "off") return "off";
  if (r.waitingForTurns) return "waiting for new turns";
  if (!r.last) return "never reviewed";
  const parts = [`last reviewed ${relTime(Date.parse(r.last.at), now)}`];
  if (r.nextAt) {
    const next = Date.parse(r.nextAt);
    if (Number.isFinite(next)) parts.push(next <= now ? "due" : `next in ${dur(next - now)}`);
  }
  return parts.join(" · ");
}

/** Split a model's free-text brief into display lines, stripping common bullet markers and blank lines. */
export function splitBullets(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•·]\s*|\d+[.)]\s*)/, "").trim())
    .filter(Boolean);
}

/** Lines to render for one model's last review: `[]` empty, `["error: …"]` when it failed, else the split bullets. */
export function reviewBullets(result: ReviewResult | null | undefined): string[] {
  if (!result) return [];
  if (!result.ok) return [result.error ? `error: ${result.error}` : "error: review failed"];
  return splitBullets(result.text);
}

/** Optimistically apply a fresh usageReview payload onto an existing usage snapshot (after a POST). */
export function withUsageReview(data: UsageData, review: UsageReview | null | undefined): UsageData {
  if (!review) return data;
  return { ...data, usageReview: review };
}

// ---- usa-11: efficiency trend, clean-run floor, savings & A/B workflow era

export type CohortStats = {
  units: number;
  firstTryPassRate: number | null;
  avgReviewRounds: number | null;
  costPerUnit: number | null;
  tokensPerUnit: number | null;
  avgUnitCycleMs: number | null;
  fixAfterMergeRate: number | null;
};
export type CohortKey = "firstTryPassRate" | "avgReviewRounds" | "costPerUnit" | "avgUnitCycleMs" | "fixAfterMergeRate";
export type Cohorts = { recent: CohortStats; prior: CohortStats; delta: Partial<Record<CohortKey | "tokensPerUnit", number | null>> };
export type Floor = {
  cleanCostUsd: number;
  cleanShare: number | null;
  wasteShare: number | null;
  cleanCostPerUnit: number | null;
  cleanTokensPerUnit: number | null;
  reworkCostUsd: number;
  loopAndAbandonedCostUsd: number;
  fixAfterMergeCostUsd: number;
  restartOverheadCostUsd: number;
};
export type Savings = {
  routingSavingsUsd: number;
  soloOpusBaselineUsd: number;
  actualCostUsd: number;
  routingSavingsPct: number | null;
  contextSavingsTokens: number;
  monolithicBaselineTokens: number;
  parallelSpeedup: number | null;
  totalLocChanged: number;
  costPer100Loc: number | null;
  costPerMergedUnit: number | null;
};
export type WorkflowRow = {
  workflowMode: string;
  units: number;
  firstTryPassRate: number;
  avgReviewRounds: number;
  costUsd: number;
  costPerUnit: number | null;
  costPer100Loc: number | null;
  tokensPerUnit: number;
  avgUnitCycleMs: number | null;
  fixAfterMergeRate: number;
  costCoverage: number;
};

/** Metrics shown as cohort tiles, in display order. `higherIsBetter` drives the good/bad colouring. */
export const COHORT_METRICS: { key: CohortKey; label: string; higherIsBetter: boolean; kind: "pct" | "rounds" | "usd" | "dur" }[] = [
  { key: "firstTryPassRate", label: "1st-try PASS %", higherIsBetter: true, kind: "pct" },
  { key: "avgReviewRounds", label: "Rev rounds/unit", higherIsBetter: false, kind: "rounds" },
  { key: "costPerUnit", label: "Cost/unit", higherIsBetter: false, kind: "usd" },
  { key: "avgUnitCycleMs", label: "Cycle/unit", higherIsBetter: false, kind: "dur" },
  { key: "fixAfterMergeRate", label: "Fix rate", higherIsBetter: false, kind: "pct" },
];

/** Dollar text from a raw float: `—` for null/NaN, 2 decimals (3 below 10 cents so small costs stay visible). */
export function usdText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.1) return `$${n.toFixed(3)}`;
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

/** Token count: `—` for missing, `1.2k` / `3.4M` otherwise. */
export function tokText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  return a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

export type DeltaDir = "up" | "down" | "flat" | "none";
export type Trend = "good" | "bad" | "flat" | "none";

/** Direction arrow + whether the change is an improvement. null/NaN delta -> `none`; |delta| < eps -> `flat`. */
export function deltaTrend(delta: number | null | undefined, higherIsBetter: boolean, eps = 1e-9): { dir: DeltaDir; trend: Trend } {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return { dir: "none", trend: "none" };
  if (Math.abs(delta) < eps) return { dir: "flat", trend: "flat" };
  const up = delta > 0;
  return { dir: up ? "up" : "down", trend: up === higherIsBetter ? "good" : "bad" };
}

/** Format a metric value by kind (`pct` fraction, `rounds` 1dp, `usd`, `dur` ms). */
export function cohortValueText(kind: "pct" | "rounds" | "usd" | "dur", v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (kind === "pct") return pctText(v);
  if (kind === "rounds") return v.toFixed(1);
  if (kind === "usd") return usdText(v);
  return dur(v);
}

/** Signed delta text with arrow, e.g. `▲ +12%`, `▼ -$0.40`, `— no prior` when missing, `• 0` when flat. */
export function deltaText(kind: "pct" | "rounds" | "usd" | "dur", delta: number | null | undefined): string {
  const { dir } = deltaTrend(delta, true);
  if (dir === "none") return "— no prior";
  if (dir === "flat") return "• no change";
  const d = delta as number;
  const sign = d > 0 ? "+" : "-";
  const a = Math.abs(d);
  const body = kind === "pct" ? `${Math.round(a * 100)}%` : kind === "rounds" ? a.toFixed(1) : kind === "usd" ? usdText(a) : dur(a);
  return `${dir === "up" ? "▲" : "▼"} ${sign}${body}`;
}

export type FloorSegment = { key: "clean" | "rework" | "loops" | "fixes" | "restarts"; label: string; usd: number; share: number };

/** Stacked-bar segments (clean + 4 waste buckets) with share of the segment total (so widths sum to 100% even if clean was clamped). */
export function floorSegments(f: Floor | null | undefined): FloorSegment[] {
  if (!f) return [];
  const raw: [FloorSegment["key"], string, number][] = [
    ["clean", "Clean shipping", f.cleanCostUsd],
    ["rework", "Rework (r2+)", f.reworkCostUsd],
    ["loops", "Loops/Abandoned", f.loopAndAbandonedCostUsd],
    ["fixes", "Post-merge fixes", f.fixAfterMergeCostUsd],
    ["restarts", "Restarts", f.restartOverheadCostUsd],
  ];
  const vals = raw.map(([, , v]) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((s, v) => s + v, 0);
  return raw.map(([key, label], i) => ({ key, label, usd: vals[i], share: total > 0 ? vals[i] / total : 0 }));
}

/** Parallel speedup as `1.8x`, `—` when missing. */
export function speedupText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}

export const LOW_COST_COVERAGE = 0.8;
/** True when under 80% of a workflow's units have a known (non-zero) cost, i.e. non-Claude cost may be missing. */
export function lowCostCoverage(coverage: number | null | undefined): boolean {
  return typeof coverage === "number" && Number.isFinite(coverage) && coverage < LOW_COST_COVERAGE;
}

/** Workflow rows sorted by units desc then mode; tolerates a missing array. */
export function sortWorkflows(rows: WorkflowRow[] | null | undefined): WorkflowRow[] {
  return [...(rows ?? [])].sort((a, b) => b.units - a.units || a.workflowMode.localeCompare(b.workflowMode));
}

export const USAGE_EXPORT_MD_URL = "/__vibesquad/providers/usage-export?format=md";

/** Squad filter persistence + URLs (usa-25). */
export const USAGE_SQUAD_KEY = "vs.usage.squad";
export const USAGE_URL = "/__vibesquad/providers/usage";
export const squadQuery = (squad: string | null | undefined): string => (squad ? `squad=${encodeURIComponent(squad)}` : "");
export const usageUrl = (squad: string | null | undefined): string => (squad ? `${USAGE_URL}?${squadQuery(squad)}` : USAGE_URL);
export const usageExportMdUrl = (squad: string | null | undefined): string => (squad ? `${USAGE_EXPORT_MD_URL}&${squadQuery(squad)}` : USAGE_EXPORT_MD_URL);

/** Pill label: `efi` -> `EFI` (short ids), `vibesquad` -> `Vibesquad`; the server id stays the filter value. */
export function squadLabel(id: string): string {
  if (!id) return id;
  return id.length <= 3 ? id.toUpperCase() : id.charAt(0).toUpperCase() + id.slice(1);
}

/** A stored/clicked squad only counts while the server still lists it (or before the list arrives). */
export function validSquad(squad: string | null | undefined, squads: string[] | null | undefined): string | null {
  if (!squad) return null;
  return !squads || squads.length === 0 || squads.includes(squad) ? squad : null;
}

const ratioText = (n: number | null | undefined): string => (typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : "—");

/** One-line collapsed header for the Autonomy section. */
export function autonomySummary(a: Autonomy | null | undefined, squad: string | null | undefined): string {
  const scope = squad ? squadLabel(squad) : "All Squads";
  if (!a) return `Autonomy & Dogfood · ${scope} · no data`;
  return `Autonomy & Dogfood · ${scope} · ${ratioText(a.ownerTouches.unitsPerOwnerTouch)} units/touch · streak ${a.unassistedStreak.current} (best ${a.unassistedStreak.longest}) · ${a.stalls.total} stall${a.stalls.total === 1 ? "" : "s"}`;
}

export type AutonomyTile = { key: string; label: string; value: string; sub: string };

/** The five KPI tiles of the scorecard strip. */
export function autonomyTiles(a: Autonomy): AutonomyTile[] {
  const o = a.ownerTouches;
  return [
    { key: "units-per-touch", label: "Units / Owner Touch", value: ratioText(o.unitsPerOwnerTouch), sub: `${o.total} touches (needs-you ${o.needsYou}, you ${o.you}, xsquad ${o.xsquadInput})` },
    { key: "streak", label: "Unassisted Merge Streak", value: String(a.unassistedStreak.current), sub: `longest ${a.unassistedStreak.longest}` },
    { key: "needs-you-per-unit", label: "Needs-You / Unit", value: ratioText(o.perMergedUnit), sub: `${ratioText(o.perHandoff)} touches / handoff` },
    { key: "stalls", label: "Stalls & Median Unblock", value: dur(a.stalls.medianUnblockMs), sub: `${a.stalls.total} stalls (${a.stalls.blockers} blocker, ${a.stalls.failRuns} FAIL) · p90 ${dur(a.stalls.p90UnblockMs)}` },
    { key: "units-per-handoff", label: "Units / Plan Handoff", value: ratioText(a.planAutonomy.unitsPerHandoff), sub: `${a.planAutonomy.handoffs} handoffs -> ${a.planAutonomy.mergedUnits} units` },
  ];
}

/** usa-26 ready-time + compaction blocks (server/providers-catalog.mjs buildReadyTime/buildCompaction). All ms; null = no data. */
export type ReadyGroup = {
  provider: string; count: number; queuedCount: number; queuedShare: number | null;
  medianFirstResponseMs: number | null; p90FirstResponseMs: number | null;
  medianFirstResponseExclQueueMs: number | null; p90FirstResponseExclQueueMs: number | null;
  medianReadyMs: number | null; p90ReadyMs: number | null;
  medianReadyExclQueueMs: number | null; p90ReadyExclQueueMs: number | null;
  medianQueuedMs: number | null; p90QueuedMs: number | null;
};
export type ReadyTime = { overall: ReadyGroup | null; byProvider: ReadyGroup[]; baseline: { paseoSpawnMedianMs: number; runnerSpawnMedianMs: number } };
export type CompactionStats = {
  runs: number; totalCostUsd: number; avgCostUsd: number | null; totalTokens: number; avgTokens: number | null;
  tokensSaved: number; handoffRuns: number; restartOverheadCostUsd: number; avgHandoffCostUsd: number | null;
};

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Sub-minute-friendly latency: `450ms`, `3.2s`, then dur() (`2m`, `1.1h`); `—` for missing. */
export function msText(ms: number | null | undefined): string {
  if (!isNum(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return dur(ms);
}

/** `med / p90` pair, `—` when both missing. */
export const medP90Text = (med: number | null | undefined, p90: number | null | undefined): string => (isNum(med) || isNum(p90) ? `${msText(med)} / ${msText(p90)}` : "—");

/** Spawn speedup pill: `0.45s vs 165s · ~367x faster`; `—` when the baseline is unusable. */
export function readyPillText(r: ReadyTime | null | undefined): string {
  const b = r?.baseline;
  if (!b || !isNum(b.paseoSpawnMedianMs) || !isNum(b.runnerSpawnMedianMs) || b.runnerSpawnMedianMs <= 0) return "—";
  const secs = (ms: number) => (ms < 10_000 ? parseFloat((ms / 1000).toFixed(2)).toString() : String(Math.round(ms / 1000)));
  return `${secs(b.runnerSpawnMedianMs)}s vs ${secs(b.paseoSpawnMedianMs)}s · ~${Math.round(b.paseoSpawnMedianMs / b.runnerSpawnMedianMs)}x faster`;
}

/** Collapsed header for the Ready-Time section. */
export function readyTimeSummary(r: ReadyTime | null | undefined, c?: CompactionStats | null): string {
  const o = r?.overall;
  if (!o || !o.count) return "Ready Time & Compaction · no data";
  const comp = c && c.runs ? ` · ${c.runs} compaction${c.runs === 1 ? "" : "s"}` : "";
  return `Ready Time & Compaction · ${o.count} run${o.count === 1 ? "" : "s"} · 1st response ${msText(o.medianFirstResponseExclQueueMs)} med (excl queue) · queue ${pctText(o.queuedShare)}${comp}`;
}

export type ReadyTile = { key: string; label: string; value: string; sub: string };

/** KPI tiles: First Response excl/incl queue, Queue Share, Compaction vs Handoff cost. Missing data renders `—`. */
export function readyTimeTiles(r: ReadyTime | null | undefined, c: CompactionStats | null | undefined): ReadyTile[] {
  const o = r?.overall ?? null;
  const usdOrDash = (n: number | null | undefined) => (isNum(n) ? usdText(n) : "—");
  return [
    { key: "first-response-excl", label: "1st Response (excl queue)", value: msText(o?.medianFirstResponseExclQueueMs), sub: `p90 ${msText(o?.p90FirstResponseExclQueueMs)}` },
    { key: "first-response-incl", label: "1st Response (incl queue)", value: msText(o?.medianFirstResponseMs), sub: `p90 ${msText(o?.p90FirstResponseMs)}` },
    { key: "queue-share", label: "Queue Share", value: pctText(o?.queuedShare), sub: o ? `${o.queuedCount} of ${o.count} runs · wait med ${msText(o.medianQueuedMs)}` : "no runs" },
    {
      key: "compaction-vs-handoff", label: "Compaction vs Handoff",
      value: c ? `${usdOrDash(c.avgCostUsd)} vs ${usdOrDash(c.avgHandoffCostUsd)}` : "—",
      sub: c ? `${c.runs} compaction${c.runs === 1 ? "" : "s"} · ${tokText(c.tokensSaved)} tok saved · ${c.handoffRuns} handoff${c.handoffRuns === 1 ? "" : "s"}` : "no data",
    },
  ];
}
