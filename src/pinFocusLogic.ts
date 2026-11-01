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
