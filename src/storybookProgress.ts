// Storybook V12 progress types and pure presentation/overlay helpers (no React/DOM, no rollup logic).
// The server computes the rollup once per snapshot (server/storybook/progress.mjs); this module formats labels
// and applies the live V6 marks delta in O(marks.length) so marking moves the bar immediately.
import type { ServerMark } from "./storybookMarks";

export type ProgressAreaId = "traders" | "locations" | "squad" | "items" | "ui";
export type ProgressTextBucket = "ok" | "draft" | "rewrite" | "todo";

export type ProgressTextCounts = {
  ok: number;
  draft: number;
  rewrite: number;
  todo: number;
  total: number;
};

export type ProgressArtCounts = {
  tracked: boolean;
  final: number;
  draft: number;
  placeholder: number;
  missing: number;
  total: number;
};

export type ProgressEntry = {
  id: string;
  label: string;
  kind?: string;
  text: ProgressTextCounts;
  art: ProgressArtCounts;
};

export type ProgressMarkEntry = {
  base: ProgressTextBucket;
  area: ProgressAreaId;
  entities: string[];
};

export type SbProgress = {
  areas: ProgressEntry[];
  entities: Record<string, ProgressEntry>;
  lineAreas: Record<string, ProgressAreaId>;
  markIndex: Record<string, ProgressMarkEntry>;
  artTracked: boolean;
};

export const PROGRESS_BUCKET_LABEL: Record<ProgressTextBucket, string> = {
  ok: "OK",
  draft: "draft",
  rewrite: "needs rewrite",
  todo: "todo",
};

export const PROGRESS_AREA_LABEL: Record<ProgressAreaId, string> = {
  traders: "Traders",
  locations: "Maps & locations",
  squad: "Squad",
  items: "Items",
  ui: "UI & system",
};

/** Map a V6 ServerMark.status (or csv status) into one of the 4 text buckets. */
export function statusBucket(status: string | null | undefined, production?: string | null): ProgressTextBucket {
  const s = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (s === "OWNER-OK" || s === "OK" || s === "FINAL") return "ok";
  if (s === "NEEDS-REWRITE" || s === "REDO") return "rewrite";
  if (s === "DRAFT" || s === "VERIFY" || s === "AI-DRAFT") return "draft";
  if (s === "STORY-TODO" || s === "TODO" || s === "PLACEHOLDER" || s === "MISSING") return "todo";
  if (production === "final") return "ok";
  if (production === "needs-review") return "rewrite";
  if (production === "ai-draft") return "draft";
  return "todo";
}

/**
 * Apply live V6 session marks on top of the server-computed snapshot progress in O(marks.length).
 * Returns the original object untouched when there are no marks to apply.
 */
export function applyLiveMarks(progress: SbProgress | null | undefined, marks: ServerMark[] | null | undefined): SbProgress | null {
  if (!progress) return null;
  if (!marks || marks.length === 0) return progress;

  const areas = progress.areas.map((a) => ({ ...a, text: { ...a.text } }));
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const entities: Record<string, ProgressEntry> = { ...progress.entities };
  const clonedEntities = new Set<string>();

  const cloneEntity = (ek: string): ProgressEntry | null => {
    const cur = entities[ek];
    if (!cur) return null;
    if (!clonedEntities.has(ek)) {
      entities[ek] = { ...cur, text: { ...cur.text } };
      clonedEntities.add(ek);
    }
    return entities[ek];
  };

  let changed = false;
  for (const m of marks) {
    const idx = progress.markIndex[m.key];
    if (!idx) continue;
    const next = statusBucket(m.status);
    if (next === idx.base) continue;
    changed = true;
    const area = areaById.get(idx.area);
    if (area && area.text[idx.base] > 0) {
      area.text[idx.base]--;
      area.text[next]++;
    }
    for (const ek of idx.entities) {
      const ent = cloneEntity(ek);
      if (ent && ent.text[idx.base] > 0) {
        ent.text[idx.base]--;
        ent.text[next]++;
      }
    }
  }

  return changed ? { ...progress, areas, entities } : progress;
}

/** Honest text readout for art production counts, or "" when art is not tracked for this entry. */
export function formatArtSummary(art: ProgressArtCounts | null | undefined): string {
  if (!art || !art.tracked || art.total === 0) return "";
  const details: string[] = [];
  if (art.draft > 0) details.push(`${art.draft} draft`);
  if (art.placeholder > 0) details.push(`${art.placeholder} placeholder`);
  if (art.missing > 0) details.push(`${art.missing} missing`);
  if (details.length === 0) return `art ${art.final}/${art.total} final`;
  return `art ${art.final}/${art.total} (${details.join(", ")})`;
}

/** Honest text readout for a bar's aria-label / summary (e.g. "Traders: 41 OK · 12 draft · 30 todo · art 3/7 (4 draft)"). */
export function formatProgressSummary(entry: ProgressEntry): string {
  const parts: string[] = [];
  if (entry.text.total === 0) {
    parts.push("0 lines");
  } else {
    if (entry.text.ok > 0) parts.push(`${entry.text.ok} OK`);
    if (entry.text.draft > 0) parts.push(`${entry.text.draft} draft`);
    if (entry.text.rewrite > 0) parts.push(`${entry.text.rewrite} needs rewrite`);
    if (entry.text.todo > 0) parts.push(`${entry.text.todo} todo`);
  }
  const art = formatArtSummary(entry.art);
  if (art) parts.push(art);
  return `${entry.label}: ${parts.join(" · ")}`;
}

/** Percentage width (0..100) for one text segment. */
export function segmentPct(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}
