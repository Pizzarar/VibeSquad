// Review queue logic (PLAN_STORYBOOK_V2 V3, wave 2): pure, no React / DOM, unit-tested in test/storybook-review.test.mjs.
// Turns the snapshot's text lines, contract templates and lore into ONE ordered list of rows the owner reads top to bottom:
// story first, then flavor, then toasts/system/UI; grouped by speaker (people) or screen/file (system text). Read-only.
import { cleanTodo, entityKey, fmtSource, lineSpeakerKey, plainText, titleCase, type EntityIndex, type ListItem, type SbEntity } from "./storybookLogic";

export type RowClass = "story" | "flavor" | "ui";
export const ROW_CLASSES: RowClass[] = ["story", "flavor", "ui"];
export const ROW_CLASS_LABEL: Record<RowClass, string> = { story: "Story", flavor: "Flavor & quips", ui: "Toasts, system & UI" };
export const ROW_CLASS_HELP: Record<RowClass, string> = {
  story: "Dialogue, bios, lore and quest text. Read these first.",
  flavor: "Item, enemy and contract copy; trader quips and encouragement.",
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
  const ent = kind === "legacy" ? null : idx.byKind(kind).find((x) => x.id.toLowerCase() === id) ?? null;
  return ent?.display ?? (typeof e.data?.speaker === "string" && e.data.speaker ? e.data.speaker : titleCase(id));
}

const tooLongReason = (msg: string): string => {
  const m = /text is (\d+) chars \(([^)]*)\)/.exec(msg);
  return m ? `${m[1]} chars, ${m[2]}` : "too long";
};

/** All reviewable rows: text lines, every contract template (rendered), lore entries (not the whole-doc bodies). Entity order is kept inside a group. */
export function buildReviewRows(entities: SbEntity[], idx: EntityIndex, items: ListItem[]): ReviewRow[] {
  const long = new Map<string, string>();
  for (const it of items) if (it.category === "toolong" && it.entityRef) long.set(entityKey(it.entityRef.kind, it.entityRef.id), tooLongReason(it.msg));
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
      const named = !/^(system|party|narrator):/.test(lineSpeakerKey(e)); // a person: group under their name
      const group = named ? speaker : typeof d.group === "string" && d.group ? d.group : ORIGIN_LABEL[origin] ?? "Other text";
      const st = typeof d.status === "string" && d.status.trim() ? d.status.trim() : null;
      const sk = lineSpeakerKey(e), si = sk.indexOf(":");
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
        id: entityKey(e.kind, e.id), kind: e.kind, entityId: e.id, cls: "flavor", group: `Contracts · ${trader || "no trader"}`, speaker: trader, speakerRef: idx.get("trader", String(d.trader ?? "")) ? { kind: "trader", id: String(d.trader) } : null,
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

/** Story first. Groups: people (alphabetical) before screens/files, contracts last; rows keep source order. */
export function groupRows(rows: ReviewRow[]): ReviewClassBlock[] {
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
    out.push({ cls, label: ROW_CLASS_LABEL[cls], n, groups: [...m.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)) });
  }
  return out;
}

export type ReviewFilter = { query: string; classes: ReadonlySet<RowClass>; tooLong: boolean; unreviewed: boolean };
export const NO_FILTER: ReviewFilter = { query: "", classes: new Set(), tooLong: false, unreviewed: false };

/** One search box: every whitespace-separated word must appear in the row's text, title, speaker, key, file or group. */
export function filterRows(rows: ReviewRow[], f: ReviewFilter): ReviewRow[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (f.classes.size === 0 || f.classes.has(r.cls)) && (!f.tooLong || r.tooLong != null) && (!f.unreviewed || r.unreviewed) && words.every((w) => r.haystack.includes(w)));
}

const SEARCH_KINDS = ["trader", "squad", "enemy", "location", "item", "room", "skill", "quest_step"];
/** Entities (people, places, items, steps) whose name, id or alias matches the query: shown as chips next to the line results. */
export function searchEntities(idx: EntityIndex, query: string, max = 12): SbEntity[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: SbEntity[] = [];
  for (const k of SEARCH_KINDS) for (const e of idx.byKind(k)) {
    const h = [e.display, e.id, ...(e.aliases ?? [])].join(" ").toLowerCase();
    if (words.every((w) => h.includes(w))) { out.push(e); if (out.length >= max) return out; }
  }
  return out;
}

export const rowSubtitle = (r: ReviewRow): string => [r.file && (r.line && r.kind !== "line" ? fmtSource({ path: r.file, line: r.line }) : r.file), r.keyPath].filter(Boolean).join(" · ");

export const classCounts = (rows: ReviewRow[]): Record<RowClass, number> => {
  const c: Record<RowClass, number> = { story: 0, flavor: 0, ui: 0 };
  for (const r of rows) c[r.cls]++;
  return c;
};
