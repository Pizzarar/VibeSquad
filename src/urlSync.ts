// @desk B1: how App's URL-sync effect writes history while (or after) a Back/Forward pop settles.
// A pop re-derives mode + selection over several renders (stale render → BoringAde's navGen effect → boringShown catches up).
// While a pop is armed the sync NEVER pushes: a pushState there would wipe the Forward stack. It rewrites the entry in place (replace) —
// not "skip" — so a transient URL never lingers and an unrepresentable popped URL (unknown agent / team gone) is corrected in place.

export type PopArm = { url: string; giveUp: boolean };

export type UrlWrite = { write: boolean; replace: boolean; pop: PopArm | null };

/** Decide the history write for one run of the URL sync. `next` = URL derived from the screen; `current` = location.search. */
export function urlSyncDecision(o: { next: string; current: string; pop: PopArm | null; storybookReplace: () => boolean }): UrlWrite {
  const { next, current, pop } = o;
  if (next === current) return { write: false, replace: false, pop: pop && next === pop.url ? null : pop }; // settled (screen reached the popped URL)
  if (pop) return { write: true, replace: true, pop: pop.giveUp || next === pop.url ? null : pop }; // never pushState during a pop
  return { write: true, replace: o.storybookReplace(), pop: null };
}
