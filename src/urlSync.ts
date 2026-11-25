// @desk B1: how App's URL-sync effect writes history while (or after) a Back/Forward pop settles.
// A pop re-derives mode + selection over several renders (stale render → BoringAde's navGen effect → team/selection catch up).
// The pop ends when BoringAde says it has settled (onPopSettled) — never by comparing URLs: the settled URL legitimately differs from the
// popped one (mixed team/agent entry healed in place, unknown team falling back, non-canonical query order).
// Until then the sync NEVER pushes and never clears the arm. It rewrites in place (replace, not skip) so a transient URL never lingers.

/** Armed by onPop. `settleGen` = the popSettledGen value that marks the settle (Infinity until BoringAde reports). */
export type PopArm = { settleGen: number };

export type UrlWrite = { write: boolean; replace: boolean; pop: PopArm | null };

/** Decide the history write for one run of the URL sync. `next` = URL derived from the screen; `current` = location.search;
 *  `settledGen` = the popSettledGen this render closed over (so the stale render that fires BoringAde's effect is not "after the settle"). */
export function urlSyncDecision(o: { next: string; current: string; pop: PopArm | null; settledGen: number; storybookReplace: () => boolean }): UrlWrite {
  const { next, current, pop } = o;
  const settled = !!pop && o.settledGen >= pop.settleGen;
  const after = settled ? null : pop; // the run after the settle ends the pop unconditionally
  if (pop) {
    const sb = next !== current ? o.storybookReplace() : false; // drain the one-shot so a stale Storybook close can't turn the next user nav into a replace
    void sb;
    return { write: next !== current, replace: true, pop: after };
  }
  if (next === current) return { write: false, replace: false, pop: null };
  return { write: true, replace: o.storybookReplace(), pop: null };
}
