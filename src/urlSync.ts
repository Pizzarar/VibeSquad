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

// Round 2 (Review-Gemini M1): the reverse order also happens. A vs:select-agent notification opens the agent first; BoringApp publishes it
// in that commit but switches the team (onSelectSquad) from its landing effect, i.e. one commit LATER. If anything else fires the sync in
// that first commit (pinsHome / pinLayout flips), the live agent is ahead of the team. So the live agent is trusted only when its owning
// project (the one BoringApp's landing would select: `teamOf`) is the team being written, or it has no known owner. Otherwise the
// render-time value stands in (pre-B2 behaviour): it still matches the current team, so that commit writes nothing new.

/** The `?agent=` App's URL sync writes. Normal: the agent BoringApp has on screen, read live (`liveShown`; undefined = BoringApp not
 * mounted, the active tab stands in) unless it belongs to another project than `team` (its team lands next commit: use `rendered`).
 * Psycho / phone: the render-time value App already derived. */
export function urlSyncAgent(o: { boring: boolean; liveShown: string | null | undefined; activeAgentId: string | null; rendered: string | null; team: string | null; teamOf: (agentId: string) => string | null }): string | null {
  if (!o.boring) return o.rendered;
  if (o.liveShown === undefined) return o.activeAgentId;
  if (o.liveShown === null) return null;
  const owner = o.teamOf(o.liveShown);
  return owner && owner !== o.team ? o.rendered : o.liveShown;
}

// U1 (idea-997/895): the screen keys that are not an agent: an empty Desk slot card (?slot=) and the Overview sub-tab (?tab=). BoringApp
// publishes them tagged with their project (setBoringScreenKeys); like urlSyncAgent they are trusted only for the team being written.
type ScreenKeys = { team: string | null; slot: "overlord" | "riffbot" | "bugs" | null; tab: "inbox" | "standup" | null };
/** The ?slot= / ?tab= App's URL sync writes. Psycho / phone: none. Normal: the live published keys (`live`, read at effect time) when they
 * belong to `team`, else the render-time ones (`rendered`) when those do, else none (that project's default Overview). BoringApp not
 * mounted (live undefined, e.g. the Storybook takeover): keep the URL's own keys (`kept`), so its entry still names the screen to return to. */
export function urlSyncScreen(o: { boring: boolean; live: ScreenKeys | undefined; rendered: ScreenKeys | undefined; team: string | null; kept: { slot?: ScreenKeys["slot"]; tab?: ScreenKeys["tab"] } }): { slot: ScreenKeys["slot"]; tab: ScreenKeys["tab"] } {
  if (!o.boring) return { slot: null, tab: null };
  if (o.live === undefined) return { slot: o.kept.slot ?? null, tab: o.kept.tab ?? null };
  const k = o.live.team === o.team ? o.live : o.rendered && o.rendered.team === o.team ? o.rendered : null;
  return k ? { slot: k.slot, tab: k.tab } : { slot: null, tab: null };
}
