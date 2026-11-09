// Command palette list windowing: compact by default. An empty query shows the top PALETTE_COMPACT rows plus a "Show all (N)" row; typing searches everything.
export const PALETTE_COMPACT = 12;
export const PALETTE_MAX = 60;

export type PaletteWindow<T> = {
  rows: T[];
  /** Rows held back behind the "Show all" row (0 = no such row). */
  hidden: number;
  /** Selectable entries: the rows plus the Show-all row when present. */
  count: number;
};

/** `matches` is the already-filtered list. Only an empty (blank) query is compacted, and only until expanded. */
export function paletteWindow<T>(matches: T[], q: string, expanded: boolean): PaletteWindow<T> {
  const all = matches.slice(0, PALETTE_MAX);
  const compact = !expanded && !q.trim() && all.length > PALETTE_COMPACT;
  const rows = compact ? all.slice(0, PALETTE_COMPACT) : all;
  const hidden = all.length - rows.length;
  return { rows, hidden, count: rows.length + (hidden > 0 ? 1 : 0) };
}
