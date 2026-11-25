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

// @desk B2: one history entry per navigation. A cross-project nav sets the team (App state) and BoringApp's selection in ONE batch, but
// BoringApp publishes the agent it shows (`setBoringShownAgent`) from its own effect. Child effects run before App's URL-sync effect in
// the same commit, yet App's render-time `useBoringShownAgent()` value is still the previous agent there, so the sync used to push a
// mixed `team=<new>&agent=<prev>` entry and then a second entry once the store re-render arrived. Reading the live store at effect time
// gives the URL of the final selection in the commit that changes it: one push, no interim entry.

/** The `?agent=` App's URL sync writes. Normal: the agent BoringApp has on screen, read live (`liveShown`; undefined = BoringApp not
 * mounted, the active tab stands in). Psycho / phone: the render-time value App already derived. */
export function urlSyncAgent(o: { boring: boolean; liveShown: string | null | undefined; activeAgentId: string | null; rendered: string | null }): string | null {
  if (!o.boring) return o.rendered;
  return o.liveShown === undefined ? o.activeAgentId : o.liveShown;
}
