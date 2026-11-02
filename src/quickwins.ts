// Pure logic for the "feels like an app" quick wins: tab title/favicon count, relative timestamps,
// transcript find, rename key handling, restore-last-view. No React, no DOM, so tests import it directly.

// ---- tab title / favicon --------------------------------------------------------------
export const BASE_TITLE = "VibeSquad";

/** Total needs-you across team views (the same numbers the pink badges show; archived/closed never count). */
export const attentionTotal = (views: ReadonlyArray<{ needsYou: number }>): number =>
  views.reduce((n, v) => n + Math.max(0, v.needsYou || 0), 0);

export const tabTitle = (count: number, base = BASE_TITLE): string => (count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base);

// ---- timestamps ----------------------------------------------------------------------
// Visible text comes from prefs.formatTimestamp (one source of truth with the Settings home); this is only the tooltip.
export const fullTime = (iso?: string | null): string => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
};

// ---- inline rename --------------------------------------------------------------------
export type RenameAction = "save" | "cancel" | null;
export const renameKeyAction = (key: string): RenameAction => (key === "Enter" ? "save" : key === "Escape" ? "cancel" : null);

/** What to do with an edited name: nothing when blank or unchanged. */
export const renameOutcome = (draft: string, current: string): string | null => {
  const next = draft.trim();
  return next && next !== current ? next : null;
};

// ---- restore last view ----------------------------------------------------------------
export type SavedView = {
  leftTabs: string[];
  rightTabs: string[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  split: boolean;
  activePane: "left" | "right";
};

export const EMPTY_VIEW: SavedView = { leftTabs: [], rightTabs: [], leftActiveId: null, rightActiveId: null, split: false, activePane: "left" };

/** Drop tabs whose agent is gone or archived, then repair actives and split. Never throws. */
export function pruneView(saved: SavedView, live: (id: string) => boolean): SavedView {
  const keep = (ids: string[]) => ids.filter(live);
  const leftTabs = keep(saved.leftTabs);
  let rightTabs = keep(saved.rightTabs);
  const pick = (tabs: string[], id: string | null) => (id && tabs.includes(id) ? id : (tabs[0] ?? null));
  let split = saved.split && rightTabs.length > 0;
  let left = leftTabs;
  if (!leftTabs.length && rightTabs.length) {
    left = rightTabs;
    rightTabs = [];
    split = false;
  }
  if (!split) {
    left = [...left, ...rightTabs];
    rightTabs = [];
  }
  return {
    leftTabs: left,
    rightTabs,
    leftActiveId: pick(left, saved.leftActiveId),
    rightActiveId: split ? pick(rightTabs, saved.rightActiveId) : null,
    split,
    activePane: split && saved.activePane === "right" ? "right" : "left",
  };
}

// ---- delayed busy ---------------------------------------------------------------------
export const BUSY_DELAY_MS = 300;
