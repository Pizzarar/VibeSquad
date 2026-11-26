import { etClock } from "./etTime.ts";
// Storybook view logic (SB5): pure, no React / DOM, so it is unit-testable (test/storybook-view-logic.test.mjs).
// Data contract: the SB1 snapshot (server/storybook/schema.mjs). Read-only: nothing here writes anything.

export type SbSource = { path: string; line: number | null };
export type SbLink = { rel: string; kind: string; id: string };
export type SbEntity = {
  id: string;
  kind: string;
  display: string;
  aliases: string[];
  source: SbSource;
  links: SbLink[];
  production: string | null;
  data: Record<string, any>;
};
export type SbFinding = {
  check: string;
  severity: "error" | "warn" | "info";
  entityRef: { kind: string; id: string } | null;
  msg: string;
  source: SbSource | null;
};
export type SbSnapshot = {
  schemaVersion: number;
  project: string;
  ref: string;
  sha: string;
  generatedAt: string;
  entities: SbEntity[];
  findings: SbFinding[];
  warnings: string[];
  audit?: { signal: string; severity: string; msg?: string }[];
};

export type SbCategory = "missing" | "broken" | "inconsistent" | "unreviewed";
export const SB_CATEGORIES: SbCategory[] = ["missing", "broken", "inconsistent", "unreviewed"];
export const SB_CATEGORY_LABEL: Record<SbCategory, string> = {
  missing: "Missing",
  broken: "Broken",
  inconsistent: "Inconsistent",
  unreviewed: "Unreviewed",
};

export type EntityIndex = { get(kind: string, id: string): SbEntity | null; all: SbEntity[]; byKind(kind: string): SbEntity[] };

export const entityKey = (kind: string, id: string): string => `${kind}\u0000${id}`;

export function indexEntities(entities: SbEntity[]): EntityIndex {
  const byKey = new Map<string, SbEntity>();
  const kinds = new Map<string, SbEntity[]>();
  for (const e of entities) {
    const k = entityKey(e.kind, e.id);
    if (byKey.has(k)) continue;
    byKey.set(k, e);
    const arr = kinds.get(e.kind);
    if (arr) arr.push(e);
    else kinds.set(e.kind, [e]);
  }
  return { get: (kind, id) => byKey.get(entityKey(kind, id)) ?? null, all: [...byKey.values()], byKind: (kind) => [...(kinds.get(kind) ?? [])] };
}

/** Owner mapping: #1/#2/#5 Broken; #3/#4/#6/#7/#9/#10/#11 Inconsistent; #8 Missing. #12 (lore contradictions, v1.1) is Inconsistent. */
export function findingCategory(check: string): SbCategory | null {
  switch (check) {
    case "#1": case "#2": case "#5":
      return "broken";
    case "#3": case "#4": case "#6": case "#7": case "#9": case "#10": case "#11": case "#12":
      return "inconsistent";
    case "#8":
      return "missing";
    default:
      return null;
  }
}

/** A text row is Unreviewed when it came from text_review.csv (has a `status`) and that status is not OWNER-OK. */
export function isUnreviewedLine(e: SbEntity): boolean {
  if (e.kind !== "line") return false;
  const st = e.data?.status;
  if (typeof st !== "string") return false;
  return st.trim().toUpperCase() !== "OWNER-OK";
}

export type ListItem = {
  key: string;
  category: SbCategory;
  check: string | null; // "#n" for checker findings, null for Unreviewed rows
  severity: "error" | "warn" | "info";
  msg: string;
  entityRef: { kind: string; id: string } | null;
  source: SbSource | null;
};

/** Checker findings plus one Unreviewed item per non-OWNER-OK csv text row. Unmapped checks are dropped. */
export function buildListItems(snap: Pick<SbSnapshot, "entities" | "findings">): ListItem[] {
  const out: ListItem[] = [];
  snap.findings.forEach((f, i) => {
    const category = findingCategory(f.check);
    if (!category) return;
    out.push({ key: `f${i}`, category, check: f.check, severity: f.severity, msg: f.msg, entityRef: f.entityRef, source: f.source });
  });
  for (const e of snap.entities) {
    if (!isUnreviewedLine(e)) continue;
    const st = String(e.data.status || "(no status)");
    out.push({
      key: `u${entityKey(e.kind, e.id)}`,
      category: "unreviewed",
      check: null,
      severity: "info",
      msg: `${st}: ${truncate(String(e.data.text ?? e.display), 90)}`,
      entityRef: { kind: e.kind, id: e.id },
      source: e.source,
    });
  }
  return out;
}

export function countByCategory(items: ListItem[]): Record<SbCategory, number> {
  const c: Record<SbCategory, number> = { missing: 0, broken: 0, inconsistent: 0, unreviewed: 0 };
  for (const it of items) c[it.category]++;
  return c;
}

/** Empty `active` means "no filter" (show all). */
export function filterItems(items: ListItem[], active: ReadonlySet<SbCategory>): ListItem[] {
  return active.size === 0 ? items : items.filter((i) => active.has(i.category));
}

export function toggleCategory(active: ReadonlySet<SbCategory>, c: SbCategory): Set<SbCategory> {
  const n = new Set(active);
  if (n.has(c)) n.delete(c);
  else n.add(c);
  return n;
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ── Grouping ────────────────────────────────────────────────────────────────────

const byIndexThenId = (a: SbEntity, b: SbEntity): number => (Number(a.data?.index) || 0) - (Number(b.data?.index) || 0) || a.id.localeCompare(b.id);

export type QuestChain = { trader: SbEntity | null; traderId: string; steps: SbEntity[] };

/** One chain per trader that has quest steps, steps ordered by data.index. Traders with chains sort by display name. */
export function questChains(idx: EntityIndex): QuestChain[] {
  const by = new Map<string, SbEntity[]>();
  for (const s of idx.byKind("quest_step")) {
    const t = String(s.data?.trader ?? s.links.find((l) => l.rel === "trader")?.id ?? "");
    if (!t) continue;
    (by.get(t) ?? by.set(t, []).get(t)!).push(s);
  }
  return [...by.entries()]
    .map(([traderId, steps]) => ({ traderId, trader: idx.get("trader", traderId), steps: steps.sort(byIndexThenId) }))
    .sort((a, b) => (a.trader?.display ?? a.traderId).localeCompare(b.trader?.display ?? b.traderId));
}

const NODE_SHAPE: Record<string, (label: string) => string> = {
  quest_step: (l) => `["${l}"]`,
  enemy: (l) => `("${l}")`,
  location: (l) => `(["${l}"])`,
  item: (l) => `("${l}")`,
  room: (l) => `["${l}"]`,
  skill: (l) => `("${l}")`,
};

/** Mermaid-safe label: no quotes/brackets/pipes/newlines, bounded length. */
export function mermaidLabel(s: string, max = 38): string {
  return truncate(s.replace(/["'`<>[\]{}()|#;&%\\\r\n]/g, " "), max) || "?";
}

/** Chains longer than this lay out top-down so the web stays readable (a 16-step LR strip fits to ~40px tall). */
export const LONG_CHAIN = 5;

export type ChainGraph = { code: string; nodes: Record<string, SbEntity>; empty: boolean };

/**
 * Flowchart text for one trader chain: step → step in order, each step linked to the enemy / location / item / room it
 * targets (every non-`trader` link whose target resolves). Node ids are n0, n1…; `nodes` maps them back to entities
 * so a hover/tap on a rendered node can open its card. Dangling links are skipped (the checks report those).
 */
export function chainToMermaid(chain: QuestChain, idx: EntityIndex): ChainGraph {
  const nodes: Record<string, SbEntity> = {};
  const idOf = new Map<string, string>();
  const decl: string[] = [];
  const edges: string[] = [];
  const nodeFor = (e: SbEntity): string => {
    const k = entityKey(e.kind, e.id);
    let n = idOf.get(k);
    if (!n) {
      n = `n${idOf.size}`;
      idOf.set(k, n);
      nodes[n] = e;
      const shape = NODE_SHAPE[e.kind] ?? NODE_SHAPE.item;
      const label = e.kind === "quest_step" ? `${mermaidLabel(String(e.data?.index ?? ""), 8)}. ${mermaidLabel(cleanTodo(e.display))}` : mermaidLabel(e.display);
      decl.push(`  ${n}${shape(label)}`);
    }
    return n;
  };
  let prev: string | null = null;
  for (const s of chain.steps) {
    const sn = nodeFor(s);
    if (prev) edges.push(`  ${prev} --> ${sn}`);
    prev = sn;
    for (const l of s.links) {
      if (l.rel === "trader") continue;
      const t = idx.get(l.kind, l.id);
      if (!t) continue;
      edges.push(`  ${sn} -.->|${mermaidLabel(l.rel.replace(/_/g, " "), 24)}| ${nodeFor(t)}`);
    }
  }
  return { code: [chain.steps.length > LONG_CHAIN ? "flowchart TD" : "flowchart LR", ...decl, ...edges].join("\n"), nodes, empty: chain.steps.length === 0 };
}

export const cleanTodo = (s: string): string => s.replace(/^\s*STORY-TODO:\s*/i, "");

export type LocationView = {
  location: SbEntity;
  quests: SbEntity[];
  enemies: { entity: SbEntity | null; id: string; minS: number | null; maxS: number | null; boss: boolean }[];
  contracts: SbEntity[];
  lore: SbEntity[];
  lines: SbEntity[];
};

/** Everything that points at a location, or that the location lists in its enemy pool. */
export function locationView(loc: SbEntity, idx: EntityIndex): LocationView {
  const pointsHere = (e: SbEntity) => e.links.some((l) => l.kind === "location" && l.id === loc.id);
  const enemies: LocationView["enemies"] = [];
  const pool = Array.isArray(loc.data?.enemy_pool) ? loc.data.enemy_pool : [];
  for (const p of pool) enemies.push({ id: String(p.id), entity: idx.get("enemy", String(p.id)), minS: numOrNull(p.min_time_seconds), maxS: numOrNull(p.max_time_seconds), boss: false });
  const boss = loc.data?.boss;
  if (boss && typeof boss === "object" && boss.enemy_id) {
    enemies.push({ id: String(boss.enemy_id), entity: idx.get("enemy", String(boss.enemy_id)), minS: numOrNull(boss.at_seconds), maxS: null, boss: true });
  }
  const contracts = idx.byKind("contract").filter((c) => pointsHere(c) || (c.data?.location && c.data.location === loc.id));
  return {
    location: loc,
    quests: idx.byKind("quest_step").filter(pointsHere).sort(byIndexThenId),
    enemies,
    contracts,
    lore: idx.byKind("lore").filter(pointsHere),
    lines: idx.byKind("line").filter(pointsHere),
  };
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function fmtWindow(minS: number | null, maxS: number | null): string {
  const f = (s: number) => (s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m${s % 60}s`);
  if (minS == null && maxS == null) return "any time";
  if (maxS == null) return `from ${f(minS as number)}`;
  return `${f(minS ?? 0)}–${f(maxS)}`;
}

export type CharacterView = { id: string; speaker: string; card: SbEntity | null; entity: SbEntity | null; lines: SbEntity[] };

/** Lowercased speaker key of a text line: csv rows carry a display name ("Popper"), others an id ("popper", "narrator"). */
export function lineSpeaker(e: SbEntity): string {
  const link = e.links.find((l) => l.rel === "spoken_by");
  return String(link?.id ?? e.data?.speaker ?? "").toLowerCase();
}

/** One entry per speaker that has lines or a voice card, sorted by line count desc then name. */
export function characterViews(idx: EntityIndex): CharacterView[] {
  const speakers = new Map<string, SbEntity[]>();
  for (const l of idx.byKind("line")) {
    const s = lineSpeaker(l);
    if (!s) continue;
    (speakers.get(s) ?? speakers.set(s, []).get(s)!).push(l);
  }
  for (const c of idx.byKind("voice_card")) if (!speakers.has(c.id.toLowerCase())) speakers.set(c.id.toLowerCase(), []);
  return [...speakers.entries()]
    .map(([id, lines]) => {
      const card = idx.get("voice_card", id) ?? idx.byKind("voice_card").find((c) => c.id.toLowerCase() === id) ?? null;
      const entity = idx.get("trader", id) ?? idx.get("squad", id) ?? idx.get("enemy", id);
      return { id, speaker: entity?.display ?? card?.display ?? titleCase(id), card, entity, lines };
    })
    .sort((a, b) => b.lines.length - a.lines.length || a.speaker.localeCompare(b.speaker));
}

// ── Cards ───────────────────────────────────────────────────────────────────────

export type EntityCard = {
  title: string;
  kindLabel: string;
  text: string;
  speaker: string | null;
  area: string | null;
  status: string | null;
  ownerNote: string | null;
  source: string;
};

export const fmtSource = (s: SbSource | null | undefined): string => (s ? (s.line ? `${s.path}:${s.line}` : s.path) : "");

/** Card fields for the hover/tap popover: text, speaker, area, status, owner_note, source file:line. */
export function entityCard(e: SbEntity, idx: EntityIndex): EntityCard {
  const d = e.data ?? {};
  const areaLink = e.links.find((l) => l.kind === "location");
  const area = areaLink ? idx.get("location", areaLink.id)?.display ?? areaLink.id : typeof d.where_seen === "string" && d.where_seen ? d.where_seen : typeof d.group === "string" && d.group ? d.group : null;
  const speakerRaw = e.kind === "line" ? lineSpeaker(e) : e.kind === "quest_step" ? String(d.trader ?? "") : "";
  const speaker = speakerRaw ? (idx.get("trader", speakerRaw) ?? idx.get("squad", speakerRaw))?.display ?? (typeof d.speaker === "string" && d.speaker ? d.speaker : speakerRaw) : null;
  const text =
    e.kind === "quest_step" ? [cleanTodo(String(d.story ?? "")), taskText(d.task)].filter(Boolean).join("\n") :
    e.kind === "line" || e.kind === "lore" ? String(d.text ?? e.display) :
    e.kind === "enemy" ? `HP ${d.hp ?? "?"} · ATK ${d.attack ?? "?"} · DEF ${d.defense ?? "?"}${d.boss ? " · boss" : ""}` :
    e.kind === "location" ? `${d.threat_tier ? `${d.threat_tier} threat · ` : ""}raid ${d.default_raid_seconds ?? "?"}s` :
    typeof d.description === "string" ? d.description : "";
  const status = typeof d.status === "string" && d.status ? d.status : e.production;
  return {
    title: e.kind === "quest_step" ? cleanTodo(e.display) : e.display,
    kindLabel: e.kind.replace(/_/g, " "),
    text,
    speaker,
    area,
    status: status ?? null,
    ownerNote: typeof d.owner_note === "string" && d.owner_note ? d.owner_note : null,
    source: fmtSource(e.source),
  };
}

export function taskText(task: any): string {
  if (!task || typeof task !== "object") return "";
  const t = String(task.type ?? "");
  const q = task.qty ? ` ×${task.qty}` : "";
  if (t === "deliver") return `Deliver ${task.item_id ?? "?"}${q}`;
  if (t === "kill") return `Kill ${task.enemy_id ?? "?"}${q}${task.location ? ` @ ${task.location}` : ""}`;
  if (t === "reach") return `Reach ${task.room ?? "?"}${task.level ? ` lv ${task.level}` : ""}`;
  return t;
}

// ── Fetch result handling ──────────────────────────────────────────────────────

export type LoadState =
  | { kind: "loading" }
  | { kind: "none" } // 404: no Storybook for this project yet
  | { kind: "error"; message: string }
  | { kind: "ok"; snap: SbSnapshot };

export const NO_STORYBOOK = "No Storybook for this project yet";

/** Interpret a GET /api/storybook/:project response (status + parsed body). */
export function interpretLoad(status: number, body: any): LoadState {
  if (status === 404) return { kind: "none" };
  if (status >= 200 && status < 300 && body && Array.isArray(body.entities) && typeof body.sha === "string") {
    const snap: SbSnapshot = { ...body, findings: Array.isArray(body.findings) ? body.findings : [], warnings: Array.isArray(body.warnings) ? body.warnings : [] };
    return { kind: "ok", snap };
  }
  return { kind: "error", message: String(body?.error ?? `HTTP ${status}`) };
}

/**
 * Interpret POST /api/storybook/:project/refresh (SB4 contract): the snapshot fields come FLAT, plus `fetched` (bool) and
 * `nextFetchAt` (ISO string | null). fetched=false → the hourly limit held the fetch back; show the notice. `status` is a short
 * line for the header ("Up to date · checked 9:14 AM") so a refresh that changes nothing still shows a result.
 */
export type RefreshOutcome = { snap: SbSnapshot | null; notice: string | null; status: string | null; error: string | null };
export function interpretRefresh(status: number, body: any, now: number = Date.now()): RefreshOutcome {
  if (status === 404) return { snap: null, notice: null, status: null, error: NO_STORYBOOK };
  if (status < 200 || status >= 300) return { snap: null, notice: null, status: null, error: String(body?.error ?? `HTTP ${status}`) };
  const loaded = interpretLoad(200, body);
  const snap = loaded.kind === "ok" ? loaded.snap : null;
  const notice = body?.fetched === false ? rateLimitNotice(body) : null;
  const t = fmtClock(now);
  return { snap, notice, status: body?.fetched === false ? `Checked ${t} · next fetch ${fmtClock(body?.nextFetchAt) || "later"}` : `Up to date · checked ${t}`, error: null };
}

const fmtClock = (v: unknown): string => {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? etClock(ms) : "";
};

export const shortSha = (sha: unknown): string => (typeof sha === "string" ? sha.slice(0, 8) : "");

/** Message for fetched=false: server message if it sent one, else the hourly limit (+ the next fetch time from `nextFetchAt`). */
export function rateLimitNotice(body: any): string {
  if (typeof body?.message === "string" && body.message) return body.message;
  const base = body?.skipped === "rate-limited" || !body?.skipped ? "Refresh is limited to one fetch per hour; showing the pinned sha." : `Fetch skipped (${String(body.skipped)}); showing the pinned sha.`;
  const t = fmtClock(body?.nextFetchAt);
  return t ? `${base} Next fetch allowed after ${t}.` : base;
}

// ── Plain-language labels (UX R18 m1) ─────────────────────────────────────────

export const SB_CATEGORY_HELP: Record<SbCategory, string> = {
  broken: "A reference points at something that does not exist, or a required link is missing.",
  inconsistent: "Two places disagree: order, ownership, values or wording do not line up.",
  missing: "Something that should exist is not there yet.",
  unreviewed: "A text row from text_review.csv that the owner has not marked OWNER-OK.",
};

export const CHECK_NAME: Record<string, string> = {
  "#1": "dangling reference", "#2": "dangling reference", "#5": "dangling reference",
  "#3": "mismatch", "#4": "mismatch", "#6": "mismatch", "#7": "mismatch", "#9": "mismatch", "#10": "mismatch", "#11": "mismatch",
  "#8": "missing piece", "#12": "lore contradiction",
};
export const checkLabel = (c: string): string => CHECK_NAME[c] ?? c;

/** Strip the Markdown noise (**bold**, `code`, # headings, leading list dashes) from lore/vibe text. */
export const plainText = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ");

/** Speaker id → readable name when no entity/card names it ("narrator" → "Narrator"). */
export const titleCase = (s: string): string => s.replace(/(^|[\s_-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());

// ── Overview + Findings split (V2) ──────────────────────────────────────────────

/** Findings scopes: Problems = real checker findings; Text to review = the unreviewed text inventory; Story issues = coherence checks (J4-2). */
export type FindingScope = "problems" | "story" | "text" | "all";
export const FINDING_SCOPES: FindingScope[] = ["problems", "story", "text", "all"];
export const FINDING_SCOPE_LABEL: Record<FindingScope, string> = { problems: "Problems", story: "Story issues", text: "Text to review", all: "All" };
export const FINDING_SCOPE_HELP: Record<FindingScope, string> = {
  problems: "Real findings from the checks: broken references, mismatches, missing pieces.",
  story: "Coherence checks only: speaker and voice-card rules, duplicate ids or names, quest title vs task mismatches, and lore contradictions.",
  text: "The text inventory: rows from text_review.csv the owner has not marked OWNER-OK. Not problems, just lines to read.",
  all: "Everything above, together.",
};
/** Story-coherence checks (J4-2): #4 speaker/voice rules, #7 id/display collisions, #11 title vs task, #12 lore contradictions. */
export const STORY_CHECKS: ReadonlySet<string> = new Set(["#4", "#7", "#11", "#12"]);
export const isTextToReview = (it: ListItem): boolean => it.category === "unreviewed";
export const isProblem = (it: ListItem): boolean => !isTextToReview(it);
export const isStoryIssue = (it: ListItem): boolean => it.check != null && STORY_CHECKS.has(it.check);

export function scopeItems(items: ListItem[], scope: FindingScope): ListItem[] {
  switch (scope) {
    case "problems": return items.filter(isProblem);
    case "story": return items.filter(isStoryIssue);
    case "text": return items.filter(isTextToReview);
    default: return items;
  }
}

export function scopeCounts(items: ListItem[]): Record<FindingScope, number> {
  const c: Record<FindingScope, number> = { problems: 0, story: 0, text: 0, all: items.length };
  for (const it of items) { if (isTextToReview(it)) c.text++; else c.problems++; if (isStoryIssue(it)) c.story++; }
  return c;
}

/** The tab badge counts Problems only. */
export const problemCount = (items: ListItem[]): number => scopeCounts(items).problems;

const KIND_PLURAL: Record<string, string> = { quest_step: "Quest steps", voice_card: "Voice cards", lore: "Lore entries", enemy: "Enemies", squad: "Squad members", line: "Text lines" };
export const kindLabel = (kind: string): string => KIND_PLURAL[kind] ?? `${titleCase(kind.replace(/_/g, " "))}s`;

/** Entity kinds present, largest first. */
export function kindCounts(entities: SbEntity[]): { kind: string; label: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entities) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
  return [...m.entries()].map(([kind, n]) => ({ kind, label: kindLabel(kind), n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

export const AUDIT_SIGNALS = ["coverage", "integrity", "cohesion", "signoff"] as const;
export const AUDIT_LABEL: Record<string, string> = { coverage: "Coverage", integrity: "Integrity", cohesion: "Cohesion", signoff: "Sign-off" };
export const AUDIT_HELP: Record<string, string> = {
  coverage: "Things that should exist but do not: missing slots, no art.",
  integrity: "References that point at nothing.",
  cohesion: "Places that disagree with each other.",
  signoff: "Pieces still placeholder, AI-generated or awaiting review.",
};
/** Counts per F2 audit signal from snapshot.audit (null when the snapshot has no audit data). */
export function auditCounts(audit: SbSnapshot["audit"]): Record<string, number> | null {
  if (!Array.isArray(audit)) return null;
  const c: Record<string, number> = Object.fromEntries(AUDIT_SIGNALS.map((s) => [s, 0]));
  for (const f of audit) if (f && Object.hasOwn(c, f.signal)) c[f.signal]++;
  return c;
}

/** Which tab shows a kind, if any (Overview kind chips link there). */
export function kindTab(kind: string): string | null {
  if (kind === "quest_step") return "quests";
  if (kind === "location") return "world";
  if (kind === "trader" || kind === "squad" || kind === "voice_card" || kind === "line") return "cast";
  return null;
}
