// Pure rules for the shared context menu and the hub's open-agent decision. No imports so node --test can load it.

type Containing = { contains(n: unknown): boolean };

/**
 * Does a scroll event dismiss the open menu? The menu is position:fixed at the click point, so only a scroll that moves
 * its anchor (an ancestor of the clicked control, or the document) invalidates it. A scroll anywhere else (a streaming
 * chat auto-scrolling) must not: on a live app that closed a menu opened from a click within a frame, so it never showed.
 */
export function scrollClosesCtxMenu(scrolled: unknown, anchor: unknown): boolean {
  if (!anchor) return true;
  const s = scrolled as Partial<Containing> | null | undefined;
  if (!s || typeof s.contains !== "function") return true; // window / document-like targets: the page itself scrolled
  return s.contains(anchor);
}

/**
 * Is a non-Sky agent taking the middle of the Squad hub? The focus normally holds the Buddy (a Sky zone bot), and a rail
 * click on a Lead / worker only changes the active tab, so the tab must decide: the active tab when it is one of the
 * hub lane's own agents, else the focused agent. Sky zone bots keep the sky.
 */
export function hubOpenAgent(focusAgentId: string | null | undefined, activeId: string | null | undefined, laneMemberIds: ReadonlySet<string>, zoneIds: readonly string[]): boolean {
  const shown = activeId && laneMemberIds.has(activeId) ? activeId : focusAgentId;
  return !!shown && !zoneIds.includes(shown);
}
