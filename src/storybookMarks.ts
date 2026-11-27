// Storybook V6 owner marks, client side (pure). Maps a snapshot entity to the text_review.csv row it marks (the same row
// identity server/storybook/marks.mjs uses), overlays the server's marks, and counts group progress. No IO here.
import type { EntityIndex, SbEntity } from "./storybookLogic";

export type MarkAction = "ok" | "redo" | "edit" | "clear";
export type MarkTarget = { file: string; data_path: string; where_seen: string; line: string; seen: string };
export type Mark = { target: MarkTarget; action: MarkAction; note?: string; text?: string; contract?: string };
export type ServerMark = { key: string; file: string; line: string; data_path: string; where_seen: string; status: string; note: string; contracts: Record<string, string>; rewrite: string; text: string; hashOk: boolean };
export type MarksState = { exists: boolean; branch: string | null; pending: number; marks: ServerMark[]; head?: string | null; autoCommitError?: string };
/**
 * What a row shows: ok / redo / edit (OWNER-OK with the owner's own rewrite), or none. `draft`: an OK that approved the
 * drafted rewrite (owner_rewrite equals the draft the row carried before review), shown as "OK (draft)", not "Edited".
 */
export type MarkState = { kind: "ok" | "redo" | "edit" | "none"; note: string; rewrite: string; contractNote: string; draft?: boolean };

/** The label a mark state reads as. */
export function markLabel(st: MarkState): string {
  if (st.kind === "ok") return st.draft ? "OK (draft)" : "OK";
  return st.kind === "redo" ? "Redo" : st.kind === "edit" ? "Edited" : "";
}

/** review_pack csv_unsafe. */
export const csvUnsafe = (v: unknown): string => { const s = String(v ?? ""); return s.length >= 2 && s[0] === "'" && "+-=@".includes(s[1]) ? s.slice(1) : s; };
export function normDataPath(dp: unknown): string {
  const s = String(dp ?? "").trim();
  if (!s) return "";
  try { return JSON.stringify(JSON.parse(s)); } catch { return s; }
}
/** Same identity as marks.mjs rowKey: data rows by (file, data_path), code rows by (file, where_seen, text). */
export function targetKey(t: { file: string; data_path?: string; where_seen?: string; seen?: string; current_text?: string }): string {
  const dp = normDataPath(t.data_path);
  return dp ? `d\u0000${t.file}\u0000${dp}` : `t\u0000${t.file}\u0000${t.where_seen ?? ""}\u0000${csvUnsafe(t.current_text ?? t.seen ?? "")}`;
}

/** A csv-backed line entity -> its sheet row; null for lines that are not in text_review.csv (e.g. raid_story twins). */
export function lineTarget(e: SbEntity | null | undefined): MarkTarget | null {
  const d = e?.data;
  if (!e || e.kind !== "line" || !d || d.origin !== "csv" || typeof d.file !== "string" || !d.file) return null;
  return { file: d.file, data_path: String(d.data_path ?? ""), where_seen: String(d.where_seen ?? ""), line: String(d.line ?? ""), seen: String(d.current_text ?? "") };
}

/** Contract type -> the ContractSystem.gd contract_title() template row it renders from (by text, not line: lines move). */
const CONTRACT_TEMPLATE: Record<string, RegExp> = { deliver: /^Deliver\b/, kill: /^Eliminate\b/, pack: /^Wipe\b/, mastery: /\bpractice for\b/, extract: /^Extract\b/ };
export function contractTemplateLine(contract: SbEntity, lines: SbEntity[]): SbEntity | null {
  const re = CONTRACT_TEMPLATE[String(contract.data?.type ?? "")];
  if (!re) return null;
  return lines.find((l) => l.data?.origin === "csv" && /(^|\/)ContractSystem\.gd$/.test(String(l.data?.file ?? "")) && l.data?.id === "contract_title" && re.test(csvUnsafe(l.data?.current_text))) ?? null;
}

/** The sheet row an entity's marks go to, and the contract id when it is a per-contract note. */
export function entityTarget(e: SbEntity | null | undefined, lines: SbEntity[]): { target: MarkTarget; contract?: string; template?: SbEntity } | null {
  if (!e) return null;
  if (e.kind === "contract") {
    const tl = contractTemplateLine(e, lines);
    const t = lineTarget(tl);
    return t && tl ? { target: t, contract: e.id, template: tl } : null;
  }
  const t = lineTarget(e);
  return t ? { target: t } : null;
}

/** Server marks by row key. */
export const marksByKey = (marks: ServerMark[]): Map<string, ServerMark> => new Map(marks.map((m) => [m.key, m]));

/**
 * The mark a row shows. With a review session the branch's sheet is the truth; before one exists, the snapshot's own
 * status (main's sheet) is.
 */
export function markState(e: SbEntity | null | undefined, lines: SbEntity[], byKey: Map<string, ServerMark>, exists: boolean): MarkState {
  const none: MarkState = { kind: "none", note: "", rewrite: "", contractNote: "" };
  const hit = entityTarget(e, lines);
  if (!hit) return none;
  const m = byKey.get(targetKey(hit.target));
  if (hit.contract) {
    // a contract shows its own note; the shared template's OK/Redo shows only when the note is absent
    const cn = m?.contracts?.[hit.contract] ?? "";
    if (cn) return { kind: m?.status === "OWNER-OK" ? "ok" : "redo", note: "", rewrite: "", contractNote: cn };
  }
  if (m) {
    if (m.status !== "OWNER-OK") return { kind: "redo", note: m.note, rewrite: m.rewrite, contractNote: "" };
    if (!m.rewrite) return { kind: "ok", note: m.note, rewrite: "", contractNote: "" };
    const drafted = draftRewrite(hit.template ?? e);
    return drafted && csvUnsafe(m.rewrite) === drafted ? { kind: "ok", note: m.note, rewrite: m.rewrite, contractNote: "", draft: true } : { kind: "edit", note: m.note, rewrite: m.rewrite, contractNote: "" };
  }
  if (exists) return none;
  const d = (hit.template ?? e)?.data ?? {};
  const st = String(d.status ?? "").trim();
  if (st === "OWNER-OK") return { kind: d.owner_rewrite ? "edit" : "ok", note: "", rewrite: csvUnsafe(d.owner_rewrite), contractNote: "" };
  if (st === "NEEDS-REWRITE") return { kind: "redo", note: csvUnsafe(d.owner_note), rewrite: "", contractNote: "" };
  return none;
}

/** The drafted (not owner-approved) rewrite on a row, shown so OK visibly approves it. */
export function draftRewrite(e: SbEntity | null | undefined): string {
  const d = e?.data;
  return d && d.origin === "csv" ? csvUnsafe(d.owner_rewrite) : "";
}

/** One line for the session bar after End session: subject + sha, plus anything the owner must know. */
export function commitSummary(b: { committed?: string | null; subject?: string; lost?: number; write?: string } | null): string {
  if (!b?.committed) return "Nothing to commit";
  const parts = [`${b.subject ?? "committed"} (${String(b.committed).slice(0, 8)})`];
  if (b.lost) parts.push(`${b.lost} mark(s) lost in review_pack --write`);
  if (b.write === "missing") parts.push("review_pack --write not run (python or tools/review_pack.py missing): run it before --check");
  return parts.join(" · ");
}

/** Group progress: rows that can be marked, and how many carry an owner mark. */
export function progress(states: MarkState[]): { done: number; total: number } {
  return { done: states.filter((s) => s.kind !== "none").length, total: states.length };
}

/** Build one mark per target for a batch ("OK all" / "Redo all with one note"), skipping rows that already carry a mark. */
export function batchMarks(entities: SbEntity[], lines: SbEntity[], byKey: Map<string, ServerMark>, exists: boolean, action: "ok" | "redo", note?: string): Mark[] {
  const out: Mark[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    if (markState(e, lines, byKey, exists).kind !== "none") continue;
    const hit = entityTarget(e, lines);
    if (!hit) continue;
    const k = `${targetKey(hit.target)}\u0000${hit.contract ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ target: hit.target, action, ...(note ? { note } : {}), ...(hit.contract ? { contract: hit.contract } : {}) });
  }
  return out;
}

export const allLines = (idx: EntityIndex): SbEntity[] => idx.byKind("line");
