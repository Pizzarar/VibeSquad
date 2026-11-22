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

/**
 * Does the focused lane have a drawer in the middle? True with a focused Buddy, and also when a Lead / worker of the lane
 * is the active tab while the Buddy is missing (pinFocus.agentId null): without that the "no drawer" layout hid the
 * clicked agent and showed the Spin Up panel instead. Sky zone bots never count: the sky owns them.
 */
export function focusDrawerOpen(focusAgentId: string | null | undefined, activeId: string | null | undefined, laneMemberIds: ReadonlySet<string>, zoneIds: readonly string[]): boolean {
  return !!focusAgentId || (!!activeId && laneMemberIds.has(activeId) && !zoneIds.includes(activeId));
}

type Attrs = { setAttribute(n: string, v: string): void; getAttribute(n: string): string | null; removeAttribute(n: string): void };
const isAttrs = (a: unknown): a is Attrs => !!a && typeof (a as Attrs).setAttribute === "function" && typeof (a as Attrs).getAttribute === "function" && typeof (a as Attrs).removeAttribute === "function";

/** idea-528 m6: mark the trigger (or right-clicked row) while its menu is open; the returned cleanup unmarks it. */
export function markCtxAnchor(anchor: unknown): () => void {
  if (!isAttrs(anchor)) return () => {};
  const popup = Boolean(anchor.getAttribute("aria-haspopup"));
  anchor.setAttribute("data-ctx-open", "true");
  if (popup) anchor.setAttribute("aria-expanded", "true");
  return () => {
    anchor.removeAttribute("data-ctx-open");
    if (popup) anchor.removeAttribute("aria-expanded");
  };
}

/** idea-528 m7: Tab in an open menu always closes it; a button trigger also takes focus back (and Tab is swallowed) so focus never drops to the document. */
export function ctxTabAction(anchor: unknown): { refocusAnchor: boolean } {
  return { refocusAnchor: !!anchor && (anchor as { tagName?: string }).tagName === "BUTTON" };
}

// idea-543 mi5: the last menu trigger, so a confirm opened from a menu item (Stop all / Kill / Remove lane) can hand focus back on Cancel / Escape.
type Focusable = { focus(): void; isConnected?: boolean };
let lastCtxAnchor: unknown = null;
export function rememberCtxAnchor(anchor: unknown): void {
  lastCtxAnchor = anchor ?? null;
}
/** Forget the remembered trigger (menu dismissed, or an item ran that opened no confirm). */
export function clearCtxAnchor(): void {
  lastCtxAnchor = null;
}
const usableTarget = (x: unknown): x is Focusable => {
  const t = x as { tagName?: string; isConnected?: boolean; focus?: unknown } | null | undefined;
  return !!t && typeof t.focus === "function" && t.isConnected !== false && t.tagName !== "BODY" && t.tagName !== "HTML";
};
/**
 * Where focus should return to when a confirm closes: the remembered trigger when usable, else the focused element, else null
 * (body / documentElement / detached count as nothing: leave focus alone). Consumes the trigger, so it is used once.
 * Call synchronously where the confirm is requested, never from an effect.
 */
export function captureFocusReturn(active?: unknown): unknown {
  const a = lastCtxAnchor;
  lastCtxAnchor = null;
  return usableTarget(a) ? a : usableTarget(active) ? active : null;
}
/** A confirm request stamped with its focus-return target, captured synchronously at request time. */
export function withFocusReturn<T extends object>(r: T | null, active?: unknown): (T & { returnTo: unknown }) | null {
  return r ? { ...r, returnTo: captureFocusReturn(active) } : null;
}
/** Focus `target` when it is still attached; returns whether it did. A removed row (confirmed delete) is skipped. */
export function restoreFocusReturn(target: unknown): boolean {
  const t = target as Partial<Focusable> | null | undefined;
  if (!usableTarget(t)) return false;
  t.focus();
  // A right-clicked row (.boring-conv-line) is a plain div (focus() is a no-op): fall back to that row's own ⋯ / first button, never a document-wide query.
  const d = typeof document === "undefined" ? null : document;
  const q = t as { querySelector?: (s: string) => Partial<Focusable> | null };
  if (d && d.activeElement !== (t as unknown) && typeof q.querySelector === "function") (q.querySelector(".boring-row-menu-btn") ?? q.querySelector("button"))?.focus?.();
  return true;
}
