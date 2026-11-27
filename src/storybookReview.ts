// Review queue logic (PLAN_STORYBOOK_V2 V3, wave 2): pure, no React / DOM, unit-tested in test/storybook-review.test.mjs.
// Turns the snapshot's text lines, contract templates and lore into ONE ordered list of rows the owner reads top to bottom:
// story first, then flavor, then toasts/system/UI; grouped by speaker (people) or screen/file (system text). Read-only.
import { cleanTodo, entityKey, fmtSource, lineSpeakerKey, plainText, titleCase, type EntityIndex, type ListItem, type SbEntity } from "./storybookLogic.ts";

export type RowClass = "story" | "flavor" | "contracts" | "ui";
export const ROW_CLASSES: RowClass[] = ["story", "flavor", "contracts", "ui"];
export const ROW_CLASS_LABEL: Record<RowClass, string> = { story: "Story", flavor: "Flavor & quips", contracts: "Contracts", ui: "Toasts, system & UI" };
export const ROW_CLASS_HELP: Record<RowClass, string> = {
  story: "Dialogue, bios, lore and quest text. Read these first.",
  flavor: "Item and enemy copy; trader quips and encouragement.",
  contracts: "Contract titles and details as the player sees them.",
  ui: "Toasts, button labels and system text. Check length, not prose.",
};

export type ReviewRow = {
  id: string; // entityKey(kind,id): the stable row id (V6 OK/Redo/Edit actions and "→ line" jumps hang off this)
  kind: string;
  entityId: string;
  cls: RowClass;
  group: string; // group label inside the class
  groupId: string;
  speaker: string; // display name ("" = none)
  speakerRef: { kind: string; id: string } | null; // the trader/squad/enemy entity that speaks it, when one exists
  text: string; // the FULL line, never truncated
  title: string | null; // contract rows: the rendered title (text = detail line)
  file: string;
  keyPath: string; // data_path / template id / entity id: the "key" half of the subtitle
  line: number | null;
  status: string | null; // text_review.csv status, e.g. STORY-TODO / OWNER-OK
  unreviewed: boolean;
  placeholder: boolean;
  tooLong: string | null; // short reason from check #18, e.g. "98 chars, default toast cap 90"
  haystack: string;
};

const ORIGIN_LABEL: Record<string, string> = {
  trader_relations: "Trader relations", raid_story: "Raid story", long_haul: "Long haul", squad: "Squad roster", encouragement: "Encouragement", csv: "Other text",
};
const asClass = (v: unknown): RowClass => (v === "story" || v === "flavor" || v === "ui" ? v : "ui");

/** Display name of a line's speaker (trader/squad/enemy entity name, fixed names for system/party/narrator). */
export function speakerName(e: SbEntity, idx: EntityIndex): string {
  const key = lineSpeakerKey(e);
  const i = key.indexOf(":");
  const kind = key.slice(0, i), id = key.slice(i + 1);
  if (key === "system:system") return "System";
  if (key === "party:squad") return "Squad";
  if (key === "narrator:narrator") return "Narrator";
  if (kind === "system") return titleCase(id.replace(/_/g, " "));
  const ent = kind === "legacy" ? null : idx.byKind(kind).find((x) => x.id.toLowerCase() === id) ?? null;
  return ent?.display ?? (typeof e.data?.speaker === "string" && e.data.speaker ? e.data.speaker : titleCase(id));
}

export const tooLongReason = (msg: string): string => {
  const m = /\b(text|owner_rewrite) is (\d+) (chars|sentences) \(([^)]*)\)/.exec(msg);
  if (m) return `${m[1] === "owner_rewrite" ? "rewrite " : ""}${m[2]} ${m[3]}, ${m[4]}`;
  const stripped = msg.replace(/^too long:\s*/i, "").replace(/:\s*"[^"]*"$/, "").trim();
  return stripped && stripped.toLowerCase() !== "too long" ? stripped : "over budget";
};

/** All reviewable rows: text lines, every contract template (rendered), lore entries (not the whole-doc bodies). Entity order is kept inside a group. */
export function buildReviewRows(entities: SbEntity[], idx: EntityIndex, items: ListItem[]): ReviewRow[] {
  const long = new Map<string, string>();
  for (const it of items) if (it.category === "toolong" && it.entityRef) {
    const k = entityKey(it.entityRef.kind, it.entityRef.id);
    const r = tooLongReason(it.msg);
    const prev = long.get(k);
    long.set(k, prev && !prev.includes(r) ? `${prev}; ${r}` : r);
  }
  const rows: ReviewRow[] = [];
  const push = (r: Omit<ReviewRow, "haystack" | "groupId" | "tooLong">) => {
    const tooLong = long.get(r.id) ?? null;
    rows.push({ ...r, tooLong, groupId: `${r.cls}\u0000${r.group}`, haystack: [r.text, r.title, r.speaker, r.keyPath, r.file, r.group, r.entityId].filter(Boolean).join("\n").toLowerCase() });
  };
  for (const e of entities) {
    const d = e.data ?? {};
    if (e.kind === "line") {
      const speaker = speakerName(e, idx);
      const origin = String(d.origin ?? "");
      const cls = asClass(d.rowClass);
      const sk = lineSpeakerKey(e), si = sk.indexOf(":");
      const named = !/^(system|party|narrator):/.test(sk); // a person: group under their name
      const rawGroup = typeof d.group === "string" ? d.group.trim() : "";
      const isSystemScreen = sk.startsWith("system:") && sk !== "system:system";
      const group = named
        ? speaker
        : rawGroup
          ? (isSystemScreen && rawGroup.toLowerCase() === sk.slice(7) ? titleCase(rawGroup.replace(/_/g, " ")) : rawGroup)
          : (isSystemScreen ? speaker : ORIGIN_LABEL[origin] ?? "Other text");
      const st = typeof d.status === "string" && d.status.trim() ? d.status.trim() : null;
      const sref = idx.get(sk.slice(0, si), e.links.find((l) => l.rel === "spoken_by")?.id ?? sk.slice(si + 1)) ? { kind: sk.slice(0, si), id: e.links.find((l) => l.rel === "spoken_by")?.id ?? sk.slice(si + 1) } : null;
      push({
        id: entityKey(e.kind, e.id), kind: e.kind, entityId: e.id, cls, group, speaker, speakerRef: sref, text: cleanTodo(String(d.text ?? e.display)), title: null,
        file: e.source?.path ?? String(d.file ?? ""), keyPath: origin === "csv" ? String(d.data_path || (e.source?.line ? `line ${e.source.line}` : "")) : e.id, line: e.source?.line ?? null,
        status: st, unreviewed: st != null && st.toUpperCase() !== "OWNER-OK", placeholder: e.production === "placeholder",
      });
    } else if (e.kind === "contract") {
      const r = d.rendered as { title?: string; detail?: string } | undefined;
      const trader = idx.get("trader", String(d.trader ?? ""))?.display ?? String(d.trader ?? "");
      push({
        id: entityKey(e.kind, e.id), kind: e.kind, entityId: e.id, cls: "contracts", group: `Contracts · ${trader || "no trader"}`, speaker: trader, speakerRef: idx.get("trader", String(d.trader ?? "")) ? { kind: "trader", id: String(d.trader) } : null,
        text: r?.detail ?? "", title: r?.title ?? e.id, file: e.source?.path ?? "data/contracts.json", keyPath: e.id, line: e.source?.line ?? null,
        status: null, unreviewed: false, placeholder: false,
      });
    } else if (e.kind === "lore" && d.lore_kind !== "doc") {
      push({
        id: entityKey(e.kind, e.id), kind: e.kind, entityId: e.id, cls: "story", group: `Lore · ${titleCase(String(d.lore_kind ?? "entry").replace(/_/g, " "))}`, speaker: "", speakerRef: null,
        text: plainText(String(d.text ?? e.display)), title: e.display, file: e.source?.path ?? "", keyPath: e.id, line: e.source?.line ?? null,
        status: null, unreviewed: false, placeholder: e.production === "placeholder",
      });
    }
  }
  return rows;
}

export type ReviewGroup = { id: string; label: string; rows: ReviewRow[] };
export type ReviewClassBlock = { cls: RowClass; label: string; n: number; groups: ReviewGroup[] };

/** Put quest-step title rows immediately before their matching story rows (W3 friction 13). */
export function orderStepTitlesFirst(rows: ReviewRow[]): ReviewRow[] {
  const stepPart = (r: ReviewRow): { key: string; field: "title" | "story" } | null => {
    const m1 = /^(.+,\s*)"(title|story)"(\s*\])$/.exec(r.keyPath);
    if (m1) return { key: `${r.file}\u0000${m1[1]}${m1[3]}`, field: m1[2] as "title" | "story" };
    const m2 = /^(.+)\.(title|story)$/.exec(r.keyPath);
    if (m2) return { key: `${r.file}\u0000${m2[1]}`, field: m2[2] as "title" | "story" };
    return null;
  };
  const titleByKey = new Map<string, ReviewRow>();
  const seenStory = new Set<string>();
  for (const r of rows) {
    const p = stepPart(r);
    if (p?.field === "title") titleByKey.set(p.key, r);
    else if (p?.field === "story") seenStory.add(p.key);
  }
  const moved = new Set<ReviewRow>();
  const out: ReviewRow[] = [];
  for (const r of rows) {
    if (moved.has(r)) continue;
    const p = stepPart(r);
    if (p?.field === "story") {
      const t = titleByKey.get(p.key);
      if (t && !moved.has(t)) { out.push(t); moved.add(t); }
      out.push(r);
      continue;
    }
    if (p?.field === "title" && seenStory.has(p.key)) {
      if (!moved.has(r)) { out.push(r); moved.add(r); }
      continue;
    }
    out.push(r);
  }
  return out;
}

/** Story first. Groups: exact search match first (when searching), then people (alphabetical) before screens/files, contracts last; title rows before story rows. */
export function groupRows(rows: ReviewRow[], query = ""): ReviewClassBlock[] {
  const q = query.trim().toLowerCase();
  const out: ReviewClassBlock[] = [];
  for (const cls of ROW_CLASSES) {
    const m = new Map<string, ReviewGroup>();
    let n = 0;
    for (const r of rows) {
      if (r.cls !== cls) continue;
      n++;
      (m.get(r.groupId) ?? m.set(r.groupId, { id: r.groupId, label: r.group, rows: [] }).get(r.groupId)!).rows.push(r);
    }
    if (!n) continue;
    const rank = (g: ReviewGroup) => (g.label.startsWith("Contracts") ? 2 : /^(Screen|Data|System|Docs?|File):/.test(g.label) ? 1 : 0);
    const matchRank = (g: ReviewGroup) => {
      if (!q) return 0;
      const l = g.label.toLowerCase();
      if (l === q || l === `contracts · ${q}`) return 0;
      if (l.startsWith(q)) return 1;
      return 2;
    };
    const groups = [...m.values()]
      .map((g) => ({ ...g, rows: orderStepTitlesFirst(g.rows) }))
      .sort((a, b) => matchRank(a) - matchRank(b) || rank(a) - rank(b) || a.label.localeCompare(b.label));
    out.push({ cls, label: ROW_CLASS_LABEL[cls], n, groups });
  }
  return out;
}

export type ReviewFilter = { query: string; classes: ReadonlySet<RowClass>; tooLong: boolean; unreviewed: boolean; speakerKey?: string | null };
export const NO_FILTER: ReviewFilter = { query: "", classes: new Set(), tooLong: false, unreviewed: false, speakerKey: null };

/** Speaker filter key for an entity chip that can filter Review rows to one exact speaker (null for non-speakers). */
export function speakerEntityKey(e: SbEntity): string | null {
  if (e.kind === "trader" || e.kind === "squad" || e.kind === "enemy") return `${e.kind}:${e.id.toLowerCase()}`;
  if (e.kind === "voice_card") return `${String(e.data?.speakerKind ?? "trader")}:${String(e.data?.speakerId ?? e.id).toLowerCase()}`;
  return null;
}

/** One search box: every whitespace-separated word must appear in the row's text, title, speaker, key, file or group. */
export function filterRows(rows: ReviewRow[], f: ReviewFilter): ReviewRow[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const sk = f.speakerKey ? f.speakerKey.toLowerCase() : null;
  return rows.filter((r) =>
    (f.classes.size === 0 || f.classes.has(r.cls))
    && (!f.tooLong || r.tooLong != null)
    && (!f.unreviewed || r.unreviewed)
    && (!sk || (r.speakerRef != null && `${r.speakerRef.kind}:${r.speakerRef.id.toLowerCase()}` === sk))
    && words.every((w) => r.haystack.includes(w)),
  );
}

const SEARCH_KINDS = ["trader", "squad", "enemy", "location", "item", "room", "skill", "quest_step"];
/** Entities (people, places, items, steps) whose name, id or alias matches the query: exact display matches rank first (W3 friction 9). */
export function searchEntities(idx: EntityIndex, query: string, max = 12): SbEntity[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { e: SbEntity; score: number; kindOrd: number }[] = [];
  for (let ki = 0; ki < SEARCH_KINDS.length; ki++) {
    for (const e of idx.byKind(SEARCH_KINDS[ki])) {
      const disp = e.display.toLowerCase();
      const id = e.id.toLowerCase();
      const aliases = (e.aliases ?? []).map((a) => a.toLowerCase());
      const h = [disp, id, ...aliases].join(" ");
      if (!words.every((w) => h.includes(w))) continue;
      const score =
        disp === q ? 0 :
        id === q || aliases.includes(q) ? 1 :
        disp.startsWith(q) ? 2 :
        disp.split(/\W+/).includes(q) ? 3 : 4;
      scored.push({ e, score, kindOrd: ki });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.kindOrd - b.kindOrd || a.e.display.localeCompare(b.e.display));
  return scored.slice(0, max).map((s) => s.e);
}

export const rowSubtitle = (r: ReviewRow): string => [r.file && (r.line && r.kind !== "line" ? fmtSource({ path: r.file, line: r.line }) : r.file), r.keyPath].filter(Boolean).join(" · ");

export const classCounts = (rows: ReviewRow[]): Record<RowClass, number> => {
  const c: Record<RowClass, number> = { story: 0, flavor: 0, contracts: 0, ui: 0 };
  for (const r of rows) c[r.cls]++;
  return c;
};

// V8: word-level old -> new diff for changed rows.
export type DiffSeg = { t: string; k: "same" | "del" | "add" };
/** Word-level old -> new diff (LCS over whitespace-split tokens). Pure; capped so a pathological pair stays cheap. */
export function wordDiff(a: string, b: string, maxTokens = 400): DiffSeg[] {
  const x = a.split(/(\s+)/).filter((s) => s !== ""), y = b.split(/(\s+)/).filter((s) => s !== "");
  if (x.length > maxTokens || y.length > maxTokens) return [{ t: a, k: "del" }, { t: b, k: "add" }];
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffSeg[] = [];
  const push = (t: string, k: DiffSeg["k"]) => { const l = out[out.length - 1]; if (l && l.k === k) l.t += t; else out.push({ t, k }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push(x[i], "same"); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push(x[i++], "del");
    else push(y[j++], "add");
  }
  while (i < n) push(x[i++], "del");
  while (j < m) push(y[j++], "add");
  return out;
}

