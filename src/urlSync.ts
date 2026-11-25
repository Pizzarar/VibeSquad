// @desk B1: how App's URL-sync effect writes history around a Back/Forward pop.
// A pop re-derives mode + selection over several renders (stale render → BoringAde's navGen effect → team/selection catch up). App owns the
// pop alone: onPop records `popTarget` (the popped location.search); the first user input (capture-phase pointerdown/keydown) clears it.
// While it is set the sync NEVER pushes: it replaces in place (so a transient or healed URL never lingers, and Forward is never wiped),
// and when the screen reaches the popped URL it restores that URL if a transient replace moved it, and ends the pop. Nothing depends on BoringApp being mounted.

export type UrlWrite = { write: boolean; replace: boolean; endPop: boolean };

/** Decide the history write for one run of the URL sync. `next` = URL derived from the screen; `current` = location.search. */
export function urlSyncDecision(o: { next: string; current: string; popTarget: string | null; storybookReplace: () => boolean }): UrlWrite {
  const { next, current, popTarget } = o;
  if (popTarget !== null) {
    // Reached the popped URL: settled. A stale render may have replaced the entry with a transient URL, so restore it in place (still never a push).
    if (next === popTarget) return { write: next !== current, replace: true, endPop: true };
    if (next === current) return { write: false, replace: true, endPop: false };
    o.storybookReplace(); // drain a stale Storybook one-shot so the next user nav can push
    return { write: true, replace: true, endPop: false };
  }
  if (next === current) return { write: false, replace: false, endPop: false };
  return { write: true, replace: o.storybookReplace(), endPop: false };
}
