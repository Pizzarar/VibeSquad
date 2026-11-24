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
  return truncate(s.replace(/["'`<>[\]{}()|#;&\\]/g, " "), max) || "?";
}

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
      const label = e.kind === "quest_step" ? `${e.data?.index ?? ""}. ${mermaidLabel(cleanTodo(e.display))}` : mermaidLabel(e.display);
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
      edges.push(`  ${sn} -.->|${l.rel.replace(/_/g, " ")}| ${nodeFor(t)}`);
    }
  }
  return { code: ["flowchart LR", ...decl, ...edges].join("\n"), nodes, empty: chain.steps.length === 0 };
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
      return { id, speaker: entity?.display ?? card?.display ?? id, card, entity, lines };
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
  if (status >= 200 && status < 300 && body && Array.isArray(body.entities)) {
    const snap: SbSnapshot = { ...body, findings: Array.isArray(body.findings) ? body.findings : [], warnings: Array.isArray(body.warnings) ? body.warnings : [] };
    return { kind: "ok", snap };
  }
  return { kind: "error", message: String(body?.error ?? `HTTP ${status}`) };
}

/** Interpret POST refresh. fetched=false → the hourly rate limit held the fetch back; show the server's message. */
export function interpretRefresh(status: number, body: any): { snap: SbSnapshot | null; notice: string | null; error: string | null } {
  if (status === 404) return { snap: null, notice: null, error: NO_STORYBOOK };
  if (status < 200 || status >= 300) return { snap: null, notice: null, error: String(body?.error ?? `HTTP ${status}`) };
  const snapRaw = body?.snapshot ?? (Array.isArray(body?.entities) ? body : null);
  const loaded = snapRaw ? interpretLoad(200, snapRaw) : null;
  const snap = loaded && loaded.kind === "ok" ? loaded.snap : null;
  const notice = body?.fetched === false ? rateLimitNotice(body) : null;
  return { snap, notice, error: null };
}

export const shortSha = (sha: string): string => sha.slice(0, 8);

/** Message for fetched=false: server message if it sent one, else the hourly limit (+ next allowed time when given). */
export function rateLimitNotice(body: any): string {
  if (typeof body?.message === "string" && body.message) return body.message;
  const base = body?.skipped === "rate-limited" || !body?.skipped ? "Refresh is limited to one fetch per hour; showing the pinned sha." : `Fetch skipped (${String(body.skipped)}); showing the pinned sha.`;
  const next = Number(body?.nextAllowedAt);
  if (!Number.isFinite(next) || next <= 0) return base;
  const t = new Date(next).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${base} Next fetch allowed after ${t}.`;
}
