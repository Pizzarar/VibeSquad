import { etClock, etDate } from "./etTime.ts";
import type { SbProgress } from "./storybookProgress.ts";
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
  arc?: SbArc; // server/storybook/unlocks.mjs (V5)
  glossary?: SbGlossary; // server/storybook/glossary.mjs (V10)
  progress?: SbProgress; // server/storybook/progress.mjs (V12)
};

export type SbGlossaryCanonical = {
  id: string;
  term: string;
  variants: string[];
  note: string;
  source?: SbSource | null;
};
export type SbGlossaryBanned = {
  id: string;
  term: string;
  display?: string;
  note: string;
  source?: SbSource | null;
};
export type SbGlossaryRule = {
  id: string;
  title: string;
  description: string;
  source?: SbSource | null;
};
export type SbGlossary = {
  source: { path: string; seeded: boolean };
  playerWord: string;
  canonical: SbGlossaryCanonical[];
  banned: SbGlossaryBanned[];
  nameStyleRules: SbGlossaryRule[];
};

export type SbArcGate = { type: string; id?: string | null; level?: number | null; unlock_order?: number; trader?: string; rep?: number };
export type SbArcStep = { id: string; index: number; task: string | null; stage: number; gates: SbArcGate[]; rep_after: number; lines: { id: string; field: string }[]; basis: string[] };
export type SbArcTrader = { trader: string; display: string; level_0: boolean; steps: SbArcStep[]; chain_rep: number; reactions: string[] };
export type SbPlayItem = { pos: number; kind: "map" | "reveal" | "quest_step" | "contract"; id: string; ref?: string; label: string; trader: string | null; stage: number; gates: SbArcGate[]; basis: string[] };
export type SbArc = { arcs: SbArcTrader[]; playOrder: SbPlayItem[]; gaps: { kind: string; id: string; why: string }[]; notDerivable: string[]; tiedStages: number[] };

export type SbCategory = "missing" | "broken" | "inconsistent" | "unreviewed" | "toolong";
export const SB_CATEGORIES: SbCategory[] = ["missing", "broken", "inconsistent", "unreviewed", "toolong"];
export const SB_CATEGORY_LABEL: Record<SbCategory, string> = {
  missing: "Missing",
  broken: "Broken",
  inconsistent: "Inconsistent",
  unreviewed: "Unreviewed",
  toolong: "Too long",
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

/** Owner mapping: #18 Too long (V3); #1/#2/#5/#13 Broken; #3/#4/#6/#7/#9/#10/#11/#12/#14/#16/#17/#19 Inconsistent; #8/#15 Missing. */
export function findingCategory(check: string): SbCategory | null {
  switch (check) {
    case "#1": case "#2": case "#5": case "#13":
      return "broken";
    case "#3": case "#4": case "#6": case "#7": case "#9": case "#10": case "#11": case "#12": case "#14": case "#16": case "#17": case "#19":
      return "inconsistent";
    case "#8": case "#15":
      return "missing";
    case "#18":
      return "toolong";
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
  /** V3: a #8 STORY-TODO code comment (no entity). Lives in the Dev TODOs bucket, never in the Problems count. */
  dev?: boolean;
};

/** Checker findings plus one Unreviewed item per non-OWNER-OK csv text row. Unmapped checks are dropped. */
export function buildListItems(snap: Pick<SbSnapshot, "entities" | "findings">): ListItem[] {
  const out: ListItem[] = [];
  snap.findings.forEach((f, i) => {
    const category = findingCategory(f.check);
    if (!category) return;
    out.push({ key: `f${i}`, category, check: f.check, severity: f.severity, msg: f.msg, entityRef: f.entityRef, source: f.source, ...(isDevTodoFinding(f) ? { dev: true } : {}) });
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
  const c: Record<SbCategory, number> = { missing: 0, broken: 0, inconsistent: 0, unreviewed: 0, toolong: 0 };
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

/** Mermaid-safe label: no quotes/brackets/pipes/newlines, bounded length (preserves apostrophes). */
export function mermaidLabel(s: string, max = 38): string {
  return truncate(s.replace(/["`<>[\]{}()|#;&%\\\r\n]/g, " "), max) || "?";
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
      if (l.rel === "trader" || l.rel === "spoken_by" || l.rel === "said_at") continue; // V1 identity links duplicate trader / at_location here
      const t = idx.get(l.kind, l.id);
      if (!t) continue;
      edges.push(`  ${sn} -.->|${mermaidLabel(l.rel.replace(/_/g, " "), 24)}| ${nodeFor(t)}`);
    }
  }
  return { code: [chain.steps.length > LONG_CHAIN ? "flowchart TD" : "flowchart LR", ...decl, ...edges].join("\n"), nodes, empty: chain.steps.length === 0 };
}

/** Player-facing title of a contract (V9 rendered template), falling back to its raw id only when nothing is rendered. */
export const contractTitle = (c: SbEntity): string => {
  const t = c.data?.rendered?.title;
  return typeof t === "string" && t.trim() ? t.trim() : c.display;
};
/** Chip label of a text line on a sheet: its group / speaker, never the raw `csv` origin. */
export const lineChipLabel = (l: SbEntity): string => {
  const d = l.data ?? {};
  const g = typeof d.group === "string" ? d.group.trim() : "";
  const origin = String(d.origin ?? "");
  return g || (origin && origin !== "csv" ? titleCase(origin.replace(/_/g, " ")) : "") || (typeof d.speaker === "string" && d.speaker ? d.speaker : "Text line");
};
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

export type CharacterView = { id: string; speaker: string; card: SbEntity | null; entity: SbEntity | null; lines: SbEntity[]; kind: string; inferred: number };

/** Lowercased speaker id of a text line (legacy shape, id only; use lineSpeakerKey for identity): csv rows carry a display name, others an id. */
export function lineSpeaker(e: SbEntity): string {
  const link = e.links.find((l) => l.rel === "spoken_by");
  return String(link?.id ?? e.data?.speaker ?? "").toLowerCase();
}

/** Speaker identity of a line as `kind:id` (V1): adapter speakerKind/speakerId, else the spoken_by link, else the legacy speaker string, else System. Never empty. */
export function lineSpeakerKey(e: SbEntity): string {
  const d = e.data ?? {};
  if (typeof d.speakerKind === "string" && d.speakerKind && typeof d.speakerId === "string" && d.speakerId) return `${d.speakerKind}:${d.speakerId.toLowerCase()}`;
  const link = e.links.find((l) => l.rel === "spoken_by");
  if (link) return `${link.kind}:${link.id.toLowerCase()}`;
  const legacy = typeof d.speaker === "string" ? d.speaker.trim().toLowerCase() : "";
  return legacy ? `legacy:${legacy}` : "system:system";
}

/** Characters-tab key for any entity that can be opened there (line / trader / squad / voice card); null for others. */
export function speakerKeyOf(e: SbEntity): string | null {
  if (e.kind === "line") return lineSpeakerKey(e);
  if (e.kind === "trader" || e.kind === "squad") return `${e.kind}:${e.id.toLowerCase()}`;
  if (e.kind === "voice_card") return `${String(e.data?.speakerKind ?? "trader")}:${String(e.data?.speakerId ?? e.id).toLowerCase()}`;
  return null;
}

const FIXED_SPEAKER_NAMES: Record<string, string> = { "system:system": "System", "party:squad": "Squad", "narrator:narrator": "Narrator" };

/** One entry per (kind,id) speaker that has lines or a voice card (squad-x cards fold into squad member x), sorted by line count desc then name. */
export function characterViews(idx: EntityIndex): CharacterView[] {
  const speakers = new Map<string, SbEntity[]>();
  for (const l of idx.byKind("line")) {
    const k = lineSpeakerKey(l);
    (speakers.get(k) ?? speakers.set(k, []).get(k)!).push(l);
  }
  const cards = new Map<string, SbEntity>();
  for (const c of idx.byKind("voice_card")) {
    const k = speakerKeyOf(c)!;
    cards.set(k, c);
    if (!speakers.has(k)) speakers.set(k, []);
  }
  return [...speakers.entries()]
    .map(([key, lines]) => {
      const i = key.indexOf(":");
      const kind = key.slice(0, i);
      const sid = key.slice(i + 1);
      const card = cards.get(key) ?? null;
      const entity = kind === "trader" || kind === "squad" || kind === "enemy" ? idx.byKind(kind).find((x) => x.id.toLowerCase() === sid) ?? null : null;
      const inferred = lines.filter((l) => l.data?.speakerSource === "inferred").length;
      return { id: key, kind, speaker: entity?.display ?? card?.display ?? FIXED_SPEAKER_NAMES[key] ?? (kind === "system" ? titleCase(sid.replace(/_/g, " ")) : titleCase(sid)), card, entity, lines, inferred };
    })
    .sort((a, b) => b.lines.length - a.lines.length || a.speaker.localeCompare(b.speaker));
}

export type CastGroups = { traders: CharacterView[]; squad: CharacterView[]; screens: CharacterView[] };

/** W3 rider (friction 4): group Cast speakers into Traders / Squad / Screens and disambiguate party:squad vs system:squad. */
export function groupCharacterViews(chars: CharacterView[]): CastGroups {
  const traders: CharacterView[] = [];
  const squad: CharacterView[] = [];
  const screens: CharacterView[] = [];
  for (const c of chars) {
    if (c.kind === "trader") traders.push(c);
    else if (c.kind === "squad") squad.push(c);
    else if (c.id === "party:squad") squad.push({ ...c, speaker: "Squad (party)" });
    else if (c.id === "system:squad") screens.push({ ...c, speaker: "Squad screen" });
    else if (c.kind === "party") squad.push(c);
    else screens.push(c);
  }
  return { traders, squad, screens };
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
  const speakerRaw = e.kind === "line" ? lineSpeakerKey(e) : e.kind === "quest_step" ? `trader:${String(d.trader ?? "")}` : "";
  const [spKind, ...spRest] = speakerRaw.split(":");
  const spId = spRest.join(":");
  const speaker = spId ? (spKind === "trader" || spKind === "squad" ? idx.get(spKind, spId)?.display : null) ?? FIXED_SPEAKER_NAMES[speakerRaw] ?? (spKind === "system" ? titleCase(spId.replace(/_/g, " ")) : null) ?? (typeof d.speaker === "string" && d.speaker ? d.speaker : titleCase(spId)) : null;
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
  toolong: "Player-facing text longer than its screen budget (check #18): it will not fit.",
};

export const CHECK_NAME: Record<string, string> = {
  "#1": "dangling reference", "#2": "dangling reference", "#5": "dangling reference",
  "#3": "mismatch", "#4": "mismatch", "#6": "mismatch", "#7": "mismatch", "#9": "mismatch", "#10": "mismatch", "#11": "mismatch",
  "#8": "missing piece", "#12": "lore contradiction", "#18": "too long",
  "#13": "unobtainable item", "#14": "orphan item", "#15": "item has no story",
  "#16": "term consistency", "#17": "naming / id drift", "#19": "lore vs roster",
};
export const checkLabel = (c: string): string => CHECK_NAME[c] ?? c;

/** Strip the Markdown noise (**bold**, `code`, # headings, leading list dashes) from lore/vibe text. */
export const plainText = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ");

/** Speaker id → readable name when no entity/card names it ("narrator" → "Narrator"). */
export const titleCase = (s: string): string => s.replace(/(^|[\s_-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());

// ── Overview + Findings split (V2) ──────────────────────────────────────────────

/** Findings scopes: Problems = real checker findings; Text to review = the unreviewed text inventory; Story issues = coherence checks (J4-2). */
export type FindingScope = "problems" | "story" | "coverage" | "other" | "text" | "toolong" | "dev" | "all";
export const FINDING_SCOPES: FindingScope[] = ["problems", "story", "coverage", "other", "text", "toolong", "dev", "all"];
export const FINDING_SCOPE_LABEL: Record<FindingScope, string> = { problems: "Problems", story: "Story issues", coverage: "Coverage", other: "Other checks", text: "Text to review", toolong: "Too long", dev: "Dev TODOs", all: "All" };
export const FINDING_SCOPE_HELP: Record<FindingScope, string> = {
  problems: "Broken references plus story issues. Story still to write is under Coverage; doc drift and orphan items under Other checks.",
  coverage: "Story not written yet: items with no story line (#15) and STORY-TODO placeholders on entities (#8). Writing work, not breakage.",
  other: "Checks worth a look that are not story breakage: doc vs data drift (#3), repeated templates (#6), pronoun and tone notes (#9, #10), orphan items (#14).",
  story: "Coherence checks only: speaker and voice-card rules, duplicate ids or names, quest title vs task mismatches, and lore contradictions.",
  text: "The text inventory: rows from text_review.csv the owner has not marked OWNER-OK. Not problems, just lines to read.",
  toolong: "Text longer than its screen budget (check #18). Fix by trimming the copy or raising the pinned length_budget.",
  dev: "STORY-TODO comments left in the game code (.gd). Notes for developers, not story problems.",
  all: "Everything above, together.",
};
/** The Problems tab has no "All" pill: scope "all" is only valid while a signal card's checks filter is active, else it falls back to Problems (no unreviewed-text leak). */
export const effectiveScope = (scope: FindingScope, checks: ReadonlySet<string> | null | undefined): FindingScope => (scope === "all" && !checks ? "problems" : scope);
/** Story-coherence checks (J4-2): #4 speaker/voice rules, #7 id/display collisions, #11 title vs task, #12 lore contradictions, #19 lore vs roster. */
export const STORY_CHECKS: ReadonlySet<string> = new Set(["#4", "#7", "#11", "#12", "#19"]);
export const isTextToReview = (it: ListItem): boolean => it.category === "unreviewed";
/** V6: story not written yet (#8 entity STORY-TODO, #15 item with no story): Coverage, not a problem. */
export const isCoverage = (it: ListItem): boolean => it.category === "missing" && !it.dev;
/** V6 (lead decision): Problems = broken + story issues ONLY. Text rows, Too long, Dev TODOs and Coverage never count. */
export const isProblem = (it: ListItem): boolean => !isTextToReview(it) && !isTooLong(it) && !it.dev && !isCoverage(it) && (it.category === "broken" || isStoryIssue(it));
/** V6: checker findings that are neither a Problem nor Coverage / Too long / Dev (doc drift #3, orphan #14, #6/#9/#10). */
export const isOtherCheck = (it: ListItem): boolean => !isTextToReview(it) && !isTooLong(it) && !it.dev && !isCoverage(it) && !isProblem(it);
export const isTooLong = (it: ListItem): boolean => it.category === "toolong";
export const isDevTodo = (it: ListItem): boolean => it.dev === true;
/** #8 findings with no entity are the `# STORY-TODO` comments in .gd source (V3). */
export const isDevTodoFinding = (f: Pick<SbFinding, "check" | "entityRef">): boolean => f.check === "#8" && !f.entityRef;
export const isStoryIssue = (it: ListItem): boolean => it.check != null && STORY_CHECKS.has(it.check);

export function scopeItems(items: ListItem[], scope: FindingScope): ListItem[] {
  switch (scope) {
    case "problems": return items.filter(isProblem);
    case "story": return items.filter(isStoryIssue);
    case "coverage": return items.filter(isCoverage);
    case "other": return items.filter(isOtherCheck);
    case "text": return items.filter(isTextToReview);
    case "toolong": return items.filter(isTooLong);
    case "dev": return items.filter(isDevTodo);
    default: return items;
  }
}

export function scopeCounts(items: ListItem[]): Record<FindingScope, number> {
  const c: Record<FindingScope, number> = { problems: 0, story: 0, coverage: 0, other: 0, text: 0, toolong: 0, dev: 0, all: items.length };
  for (const it of items) { if (isTextToReview(it)) c.text++; else if (isTooLong(it)) c.toolong++; else if (it.dev) c.dev++; else if (isCoverage(it)) c.coverage++; else if (isProblem(it)) c.problems++; else c.other++; if (isStoryIssue(it)) c.story++; }
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
  if (kind === "quest_step" || kind === "contract" || kind === "skill") return "quests";
  if (kind === "location" || kind === "lore" || kind === "room") return "world";
  if (kind === "trader" || kind === "squad" || kind === "voice_card" || kind === "enemy" || kind === "art_slot") return "cast";
  if (kind === "item" || kind === "recipe") return "items";
  if (kind === "line") return "review";
  return null;
}

// ── V4: navigation, entity sheets, items ────────────────────────────────────────

export type ItemFilter = "all" | "orphan" | "no-story" | "unobtainable";
export const ITEM_FILTERS: ItemFilter[] = ["all", "unobtainable", "orphan", "no-story"];
export const ITEM_FILTER_LABEL: Record<ItemFilter, string> = {
  all: "All items",
  unobtainable: "Unobtainable (#13)",
  orphan: "Orphan (#14)",
  "no-story": "No story (#15)",
};

export type NavTarget = {
  tab: "home" | "review" | "quests" | "world" | "cast" | "items" | "problems";
  sel?: string;
  jump?: string;
  scope?: FindingScope;
  category?: SbCategory | null;
  itemFilter?: ItemFilter;
};

/** Resolve any entity chip / RefPopover / finding target to its destination tab + sheet selection. */
export function entityNavTarget(e: SbEntity): NavTarget | null {
  if (e.kind === "location") return { tab: "world", sel: e.id };
  if (e.kind === "quest_step") return { tab: "quests", sel: String(e.data?.trader ?? e.id), jump: entityKey(e.kind, e.id) };
  if (e.kind === "trader" || e.kind === "squad" || e.kind === "voice_card") return { tab: "cast", sel: speakerKeyOf(e) ?? "system:system" };
  if (e.kind === "enemy") return { tab: "cast", sel: `enemy:${e.id.toLowerCase()}` };
  if (e.kind === "item") return { tab: "items", sel: e.id };
  if (e.kind === "line") return { tab: "review", sel: e.id, jump: entityKey(e.kind, e.id) };
  if (e.kind === "contract") {
    const tid = typeof e.data?.trader === "string" && e.data.trader ? e.data.trader : e.links.find((l) => l.kind === "trader")?.id;
    return tid ? { tab: "cast", sel: `trader:${tid.toLowerCase()}` } : { tab: "quests" };
  }
  if (e.kind === "recipe") {
    const outId = typeof e.data?.result_id === "string" && e.data.result_id ? e.data.result_id : e.links.find((l) => l.rel === "produces" && l.kind === "item")?.id;
    return outId ? { tab: "items", sel: outId } : { tab: "items" };
  }
  if (e.kind === "lore") {
    const loc = e.links.find((l) => l.kind === "location");
    if (loc) return { tab: "world", sel: loc.id };
    const en = e.links.find((l) => l.kind === "enemy");
    if (en) return { tab: "cast", sel: `enemy:${en.id.toLowerCase()}` };
    return { tab: "world" };
  }
  if (e.kind === "room") return { tab: "world" };
  return null;
}

/** Map an F2 audit signal card on Home to the filtered Problems / Review view it counts. */
export function auditSignalTarget(signal: string): NavTarget {
  switch (signal) {
    case "integrity": return { tab: "problems", scope: "problems", category: "broken" };
    case "cohesion": return { tab: "problems", scope: "all", category: "inconsistent" }; // V6: #3/#6/#9/#10 live in Other checks, not Problems
    case "coverage": return { tab: "problems", scope: "coverage", category: null };
    case "signoff": return { tab: "review", scope: "text", category: null };
    default: return { tab: "problems", scope: "problems", category: null };
  }
}

/** Findings directly targeting one entity. */
export function entityFindings(e: SbEntity, findings: SbFinding[]): SbFinding[] {
  return findings.filter((f) => f.entityRef && f.entityRef.kind === e.kind && f.entityRef.id === e.id);
}

const ITEM_SOURCE_RELS = new Set([
  "drops", "sells", "produces",
  "first_clear_unique", "kill_valuable", "key_drop", "locked_room_loot", "container_loot", "long_haul_loot",
]);
const ITEM_USE_RELS = new Set(["wants_item", "item", "ingredient", "upgrade_material"]);

export type ItemLinkRow = { kind: string; id: string; rel: string; label: string; entity: SbEntity | null };
export type ItemSheetData = {
  item: SbEntity;
  hasDescription: boolean;
  sources: ItemLinkRow[];
  uses: ItemLinkRow[];
  lines: SbEntity[];
  findings: SbFinding[];
  isOrphan: boolean;
  isNoStory: boolean;
  isUnobtainable: boolean;
};

/** Full sheet derivation for one item: sources, uses, text lines, findings, and #13/#14/#15 flags. */
export function itemSheetData(item: SbEntity, idx: EntityIndex, findings: SbFinding[]): ItemSheetData {
  const sources: ItemLinkRow[] = [];
  const uses: ItemLinkRow[] = [];
  const lines: SbEntity[] = [];
  let required = false;

  for (const ns of Array.isArray(item.data?.node_sources) ? item.data.node_sources : []) {
    sources.push({ kind: String(ns.kind ?? "node"), id: String(ns.id ?? ""), rel: String(ns.kind ?? "node"), label: String(ns.label ?? ns.id ?? ""), entity: null });
  }
  for (const eu of Array.isArray(item.data?.extra_uses) ? item.data.extra_uses : []) {
    uses.push({ kind: String(eu.kind ?? "use"), id: String(eu.id ?? ""), rel: String(eu.kind ?? "use"), label: String(eu.label ?? eu.id ?? ""), entity: null });
  }
  for (const e of idx.all) {
    for (const l of e.links) {
      if (l.kind !== "item" || l.id !== item.id) continue;
      if (ITEM_SOURCE_RELS.has(l.rel)) {
        sources.push({ kind: e.kind, id: e.id, rel: l.rel, label: e.display, entity: e });
      }
      if (ITEM_USE_RELS.has(l.rel)) {
        uses.push({ kind: e.kind, id: e.id, rel: l.rel, label: e.display, entity: e });
        if ((e.kind === "quest_step" && l.rel === "wants_item") || (e.kind === "contract" && l.rel === "item")) required = true;
      }
      if (e.kind === "line") lines.push(e);
    }
  }
  const ownFindings = entityFindings(item, findings);
  const hasDescription = typeof item.data?.description === "string" && item.data.description.trim().length > 0;
  const isUnobtainable = ownFindings.some((f) => f.check === "#13") || (required && sources.length === 0);
  const isOrphan = ownFindings.some((f) => f.check === "#14") || (sources.length === 0 && uses.length === 0);
  const isNoStory = ownFindings.some((f) => f.check === "#15"); // the engine's #15 only: a client fallback rule made the tab count (240) disagree with Problems/Coverage (232)
  return { item, hasDescription, sources, uses, lines, findings: ownFindings, isOrphan, isNoStory, isUnobtainable };
}

export type EnemySheetData = {
  enemy: SbEntity;
  look: SbEntity | null;
  missingDescription: boolean;
  spawns: { location: SbEntity; minS: number | null; maxS: number | null; boss: boolean }[];
  drops: SbEntity[];
  quests: SbEntity[];
  contracts: SbEntity[];
  lines: SbEntity[];
  findings: SbFinding[];
};

/** Full sheet derivation for one enemy: CONTENT_BREADTH look line, missing-description flag, spawns, drops, quests/contracts, findings. */
export function enemySheetData(enemy: SbEntity, idx: EntityIndex, findings: SbFinding[]): EnemySheetData {
  const look = idx.byKind("lore").find((l) => l.data?.lore_kind === "enemy_look" && l.links.some((lk) => lk.kind === "enemy" && lk.id === enemy.id)) ?? null;
  const missingDescription = !(typeof enemy.data?.description === "string" && enemy.data.description.trim().length > 0);
  const spawns: EnemySheetData["spawns"] = [];
  for (const loc of idx.byKind("location")) {
    const pool = Array.isArray(loc.data?.enemy_pool) ? loc.data.enemy_pool : [];
    for (const p of pool) if (String(p.id) === enemy.id) spawns.push({ location: loc, minS: numOrNull(p.min_time_seconds), maxS: numOrNull(p.max_time_seconds), boss: false });
    if (loc.data?.boss?.enemy_id === enemy.id) spawns.push({ location: loc, minS: numOrNull(loc.data.boss.at_seconds), maxS: null, boss: true });
  }
  const drops = enemy.links.filter((l) => l.rel === "drops" && l.kind === "item").map((l) => idx.get("item", l.id)).filter((x): x is SbEntity => x !== null);
  const quests = idx.byKind("quest_step").filter((q) => q.links.some((l) => l.kind === "enemy" && l.id === enemy.id)).sort(byIndexThenId);
  const contracts = idx.byKind("contract").filter((c) => c.links.some((l) => l.kind === "enemy" && l.id === enemy.id));
  const lines = idx.byKind("line").filter((l) => l.links.some((lk) => lk.kind === "enemy" && lk.id === enemy.id));
  return { enemy, look, missingDescription, spawns, drops, quests, contracts, lines, findings: entityFindings(enemy, findings) };
}

// ── V8: what changed since the owner's last session (server/storybook/changes.mjs) + Home signal/tile routing ──────────

export type SbChangeRow = { id?: string; key: string; text?: string; old?: string; new?: string; file?: string; reason?: string; why?: string };
export type SbChanges = {
  first: boolean;
  from: { sha: string; at: string; total: number } | null;
  to: { sha: string; ref?: string | null; generatedAt?: string | null; total: number };
  sameSha?: boolean;
  counts: { new: number; changed: number; gone: number; goneBy?: Record<string, number> };
  newIds?: string[]; changedIds?: string[];
  new: SbChangeRow[]; changed: SbChangeRow[]; gone: SbChangeRow[];
  capped?: number | null;
};

/** One-line "since <date, sha>" label for the Home card (ET). */
export function changesSince(ch: SbChanges): string {
  if (!ch.from) return "";
  return `${etClock(ch.from.at) ? `${etDate(ch.from.at)} ${etClock(ch.from.at)}` : ""}${ch.from.sha ? `, ${shortSha(ch.from.sha)}` : ""}`.replace(/^, /, "");
}
export const changesTotal = (ch: SbChanges): number => ch.counts.new + ch.counts.changed + ch.counts.gone;

/** V8: Review-tab changed/added row lookup. `changed` holds old text for the capped sample; `changedIds` holds every changed row id. */
export type TextChanges = { changed: Record<string, string>; changedIds: ReadonlySet<string>; added: ReadonlySet<string> } | null;

/** Build the Review-tab TextChanges lookup from /changes. Uses all changedIds/newIds so Changed filter + count match Home past the 500-row sample cap. */
export function buildTextChanges(changes: SbChanges | null | undefined): TextChanges {
  if (!changes || changes.first) return null;
  const changed: Record<string, string> = {};
  const changedIds = new Set<string>();
  for (const id of changes.changedIds ?? []) if (id) changedIds.add(entityKey("line", id));
  for (const c of changes.changed) {
    if (!c.id) continue;
    const k = entityKey("line", c.id);
    changed[k] = c.old ?? "";
    changedIds.add(k);
  }
  const added = new Set((changes.newIds ?? []).map((id) => entityKey("line", id)));
  return changedIds.size || added.size ? { changed, changedIds, added } : null;
}

export function isRowChanged(rowId: string, changes: TextChanges): boolean {
  return changes != null && (changes.changedIds.has(rowId) || Object.hasOwn(changes.changed, rowId) || changes.added.has(rowId));
}
/** "181 hidden dev strings, 108 merged duplicates, 0 removed in EFI": the answer to "why did my line count drop?". */
export function goneBreakdown(ch: SbChanges): string {
  const g = ch.counts.goneBy;
  if (!g) return "";
  const parts: string[] = [];
  if (g["dev-string"]) parts.push(`${g["dev-string"]} dev/validation string${g["dev-string"] === 1 ? "" : "s"} Storybook now hides`);
  if (g.twin) parts.push(`${g.twin} duplicate${g.twin === 1 ? "" : "s"} merged into their text_review row`);
  if (g.efi) parts.push(`${g.efi} removed or rewritten in EFI`);
  return parts.join(", ");
}

/** The audit signal each check feeds (mirror of server/registry/audit.mjs CHECK_SIGNALS; #18 is shown under Too long). */
export const SIGNAL_CHECKS: Record<string, string[]> = {
  integrity: ["#1", "#2", "#5", "#7", "#13", "#14"],
  cohesion: ["#3", "#4", "#6", "#9", "#10", "#11", "#12"],
  coverage: ["#15"],
};
export type SignalCard = { n: number; rest: number; note: string; target: NavTarget & { checks?: string[] } };
/** Findings scope a signal card opens (V6): integrity/cohesion checks span Problems + Other checks, coverage (#15) lives in Coverage. */
const SIGNAL_SCOPE: Record<string, FindingScope> = { integrity: "all", cohesion: "all", coverage: "coverage" };
const SIGNAL_REST: Record<string, string> = {
  coverage: "more are text/lore slots or art not made yet (asset lists, not Problems rows)",
  integrity: "more are asset-level references not shown as rows",
  cohesion: "more are Too long notes (their own list under Problems)",
  signoff: "more are placeholder or AI-draft entities (art, items), not text rows",
};
/**
 * Home signal card: the number is the count of rows the click OPENS, so the card and the list agree. Anything the audit counts
 * that is not a row in that list is shown as "+N …" with the reason, not hidden (W1/W2 friction 7: 232 vs 322, 13 vs 2, 30 vs 39, 4216 vs 3327).
 */
export function signalCard(signal: string, items: ListItem[], audit: Record<string, number> | null): SignalCard {
  const total = audit?.[signal] ?? 0;
  if (signal === "signoff") {
    const n = items.filter(isTextToReview).length;
    const rest = Math.max(0, total - n);
    return { n, rest, note: rest ? `+${rest} ${SIGNAL_REST.signoff}` : "", target: { tab: "review", scope: "text", category: null } };
  }
  const checks = SIGNAL_CHECKS[signal] ?? [];
  const set = new Set(checks);
  // V6 scopes: Problems = broken + story only, so a signal's checks span scopes (#14 orphans and #3/#6/#9/#10 sit in Other checks,
  // #15 in Coverage). Open the scope that holds them all, filtered to the signal's checks; count exactly those rows.
  const scope = SIGNAL_SCOPE[signal] ?? "problems";
  const n = scopeItems(items, scope).filter((it) => it.check != null && set.has(it.check)).length;
  const rest = Math.max(0, total - n);
  return { n, rest, note: rest ? `+${rest} ${SIGNAL_REST[signal] ?? "not shown as rows"}` : "", target: { tab: "problems", scope, category: null, checks } };
}

// ── W3 riders: Play order titles & unordered grouping (friction 7) ──────────────

export function playItemLabel(p: SbPlayItem, idx: EntityIndex): string | undefined {
  if (p.kind === "reveal") return p.label;
  if (p.kind === "contract") {
    const rendered = idx.get("contract", p.id)?.data?.rendered?.title;
    return typeof rendered === "string" && rendered.trim() ? rendered : cleanTodo(p.label || p.id);
  }
  return undefined;
}

export type UnorderedPlayGroup = { trader: string; display: string; items: SbPlayItem[] };
export type PlayOrderPartition = { ordered: SbPlayItem[]; unordered: UnorderedPlayGroup[]; unorderedCount: number };

/** Split playOrder into genuinely ordered items vs entries whose unlock rule is not in EFI data (grouped per trader). */
export function partitionPlayOrder(arc: SbArc, idx: EntityIndex): PlayOrderPartition {
  const gapKeys = new Set(arc.gaps.map((g) => `${g.kind}:${g.id}`));
  const lockedTraders = new Set(arc.arcs.filter((a) => !a.level_0).map((a) => a.trader));
  const ordered: SbPlayItem[] = [];
  const byTrader = new Map<string, SbPlayItem[]>();
  let unorderedCount = 0;
  for (const p of arc.playOrder) {
    const isUnordered =
      gapKeys.has(`${p.kind}:${p.id}`) ||
      p.gates.some((g) => g.type === "trader_unlock") ||
      (p.stage === 0 && p.trader != null && lockedTraders.has(p.trader));
    if (isUnordered) {
      const tid = p.trader ?? "";
      (byTrader.get(tid) ?? byTrader.set(tid, []).get(tid)!).push(p);
      unorderedCount++;
    } else {
      ordered.push({ ...p, pos: ordered.length + 1 });
    }
  }
  const unordered: UnorderedPlayGroup[] = [...byTrader.entries()]
    .map(([trader, items]) => ({
      trader,
      display: trader ? cleanTodo(idx.get("trader", trader)?.display ?? trader) : "Other",
      items,
    }))
    .sort((a, b) => a.display.localeCompare(b.display));
  return { ordered, unordered, unorderedCount };
}
