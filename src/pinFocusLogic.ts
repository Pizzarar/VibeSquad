// Pinned teams step 2: the pure decisions behind src/pinFocus.ts and the focus bar's Esc key.
// No React, no DOM, no Paseo: test/pins-focus.test.mjs runs these under plain node.

export type FocusSnapshot = {
  /** The Brainstorm shown in the middle; null while starting or after it went away. */
  agentId: string | null;
  /** The pin's Brainstorm went away (retired, archived, auto-retired) and none replaced it yet. */
  gone: boolean;
  /** While agentId is null: the panes' active tab at that moment. Opening anything else exits. */
  held: string | null;
};

export type FocusDecision =
  | { kind: "keep" }
  /** The pin has a (new) live Brainstorm: show it in the middle. `open` = it isn't the active tab yet. */
  | { kind: "follow"; agentId: string; open: boolean }
  /** The focused Brainstorm is gone: keep the pin focused and offer "Start fresh Brainstorm". */
  | { kind: "gone" }
  /** Something unrelated was opened over the focused drawer: leave the pinned layout. */
  | { kind: "exit" };

/**
 * Reconcile the focused pin with the pin's live Brainstorm (`live`, from pinsForSquad) and the
 * panes' active tab (`active`). Runs on every Paseo, teams and panes change.
 */
export function reconcilePinFocus(f: FocusSnapshot, live: string | null, active: string | null): FocusDecision {
  // A restart / successor / quick start elsewhere: the pin follows its Brainstorm.
  if (live && live !== f.agentId) return { kind: "follow", agentId: live, open: active !== live };
  // Starting or gone: the middle shows no drawer, so a different tab opening means "go there".
  if (!f.agentId) return active !== f.held ? { kind: "exit" } : { kind: "keep" };
  if (!live) return { kind: "gone" };
  // live === f.agentId: only an unrelated tab taking the middle ends the focus.
  return active !== f.agentId ? { kind: "exit" } : { kind: "keep" };
}

export type EscContext = {
  /** A modal or dialog is open. */
  inModal: boolean;
  /** The key came from inside a permission card. */
  inPerm: boolean;
  /** Where the key came from: the focused drawer's composer, another text field, or neither. */
  target: "composer" | "field" | "none";
  /** The focused Brainstorm's unsent draft (from the draft store). */
  draft: string;
};

/** Esc goes back to the grid only with an empty composer and from nowhere that handles Esc itself. */
export function escGoesHome(c: EscContext): boolean {
  if (c.inModal || c.inPerm || c.target === "field") return false;
  return !c.draft.trim();
}

// ── Persistence across a full reload ─────────────────────────────────────────
// Keyed by squad + lane (never agent id: Brainstorms get replaced). Storage is injected so node tests run it.
export type SavedFocus = { squadId: string; laneId: string };
type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const FOCUS_KEY = "vibesquad.pinFocus";
export const doneShelfKey = (squadId: string) => `vibesquad.doneShelfOpen.${squadId}`;

export function loadSavedFocus(kv: KV | undefined): SavedFocus | null {
  try {
    const v = JSON.parse(kv?.getItem(FOCUS_KEY) ?? "null");
    return v && typeof v.squadId === "string" && typeof v.laneId === "string" ? { squadId: v.squadId, laneId: v.laneId } : null;
  } catch {
    return null;
  }
}

export function saveFocus(kv: KV | undefined, f: SavedFocus | null) {
  try {
    if (f) kv?.setItem(FOCUS_KEY, JSON.stringify({ squadId: f.squadId, laneId: f.laneId }));
    else kv?.removeItem(FOCUS_KEY);
  } catch {}
}

export const loadDoneShelfOpen = (kv: KV | undefined, squadId: string): boolean => {
  try {
    return kv?.getItem(doneShelfKey(squadId)) === "1";
  } catch {
    return false;
  }
};

export function saveDoneShelfOpen(kv: KV | undefined, squadId: string, open: boolean) {
  try {
    if (open) kv?.setItem(doneShelfKey(squadId), "1");
    else kv?.removeItem(doneShelfKey(squadId));
  } catch {}
}

export type RestorePlan =
  | { kind: "none" }
  /** The URL names an agent that is gone and nothing else is saved: land on the grid, never an empty rail. */
  | { kind: "home"; closeStale: string }
  /** Focus the saved pin: its current Brainstorm, or (agentId null) the Start fresh view. */
  | { kind: "pin"; squadId: string; laneId: string; agentId: string | null; closeStale: string | null };

/**
 * Decide the startup focus. `pinBrainstorm`: undefined = the saved pin no longer exists (or is done),
 * null = it has no live Brainstorm, string = its live Brainstorm. `urlAgentLive`: the ?agent= agent still exists.
 */
export function planRestore(a: {
  saved: SavedFocus | null;
  urlAgent: string | null;
  urlAgentLive: boolean;
  pinBrainstorm: string | null | undefined;
}): RestorePlan {
  const stale = a.urlAgent && !a.urlAgentLive ? a.urlAgent : null;
  if (a.saved && a.pinBrainstorm !== undefined) {
    // A live URL agent that isn't this pin's Brainstorm is an explicit deep link: leave it alone.
    if (a.urlAgent && a.urlAgentLive && a.urlAgent !== a.pinBrainstorm) return { kind: "none" };
    return { kind: "pin", squadId: a.saved.squadId, laneId: a.saved.laneId, agentId: a.pinBrainstorm, closeStale: stale };
  }
  return stale ? { kind: "home", closeStale: stale } : { kind: "none" };
}
