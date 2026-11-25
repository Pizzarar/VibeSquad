// @desk B1: how App's URL-sync effect writes history around a Back/Forward pop.
// A pop re-derives mode + selection over several renders (stale render → BoringAde's navGen effect → team/selection catch up), and the
// derived URL can legitimately differ from the popped one (mixed team/agent entry healed in place). So a pop is NOT ended by URL equality:
// onPop sets `popActive`; only the first user input (capture-phase pointerdown/keydown) or a newer pop ends it (App). While active every
// write is replace-if-differs — never a push — so Forward is never wiped and Back is never trapped. Nothing depends on BoringApp.

export type UrlWrite = { write: boolean; replace: boolean };

/** Decide the history write for one run of the URL sync. `next` = URL derived from the screen; `current` = location.search. */
export function urlSyncDecision(o: { next: string; current: string; popActive: boolean; storybookReplace: () => boolean }): UrlWrite {
  const { next, current } = o;
  if (next === current) return { write: false, replace: o.popActive };
  if (o.popActive) {
    o.storybookReplace(); // drain a stale Storybook one-shot so the next user nav can push
    return { write: true, replace: true };
  }
  return { write: true, replace: o.storybookReplace() };
}
