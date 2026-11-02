import { useSyncExternalStore } from "react";
import { popClosed, pushClosed } from "./sessionLifecycle";
import { pruneView } from "./quickwins";
import { getRestoreLastView } from "./prefs";

// Open agent tabs, the optional 2-pane split and focus mode, outside React state. Rows, cards and
// tabs subscribe to the one slice they draw (`useAgentPane(id)`), so opening or switching a tab
// re-renders only what changed, never the whole roster.
//
// Mounting: the last MAX_MOUNTED viewed tabs keep their <AgentDrawer> mounted (hidden with
// display:none) so scroll position, timeline and composer survive. The pane actives are always
// mounted. An evicted tab stays in the tab bar; its draft lives on in drafts.ts.

export type Pane = "left" | "right";
export type OpenMode = "active" | "other" | "background";

export const MAX_MOUNTED = 8;
const PANES_KEY = "vs.panes.v1";
const FOCUS_KEY = "vs.focus";

export type PanesState = {
  leftTabs: string[];
  rightTabs: string[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  split: boolean;
  activePane: Pane;
  focus: boolean;
  /** Mobile (<600px) rail sheet. Not persisted. */
  sheet: boolean;
  /** Mounted drawers in first-mount order. Order is stable so React never moves (and resets) a DOM node. */
  mounted: string[];
  /** Recently closed tab ids, newest last. Not persisted. */
  closedTabs: string[];
};

const other = (p: Pane): Pane => (p === "left" ? "right" : "left");
const tabsKey = (p: Pane) => (p === "left" ? "leftTabs" : "rightTabs");
const activeKey = (p: Pane) => (p === "left" ? "leftActiveId" : "rightActiveId");

// Most recently viewed first. Drives eviction only; render order comes from `mounted`.
let recent: string[] = [];

function load(): PanesState {
  let saved: Partial<PanesState> = {};
  try {
    if (!getRestoreLastView()) throw new Error("app.restoreLastView is off");
    saved = JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}") ?? {};
  } catch {
    /* corrupt or unavailable: start empty */
  }
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);
  const leftTabs = ids(saved.leftTabs);
  const rightTabs = ids(saved.rightTabs).filter((id) => !leftTabs.includes(id));
  const pick = (tabs: string[], id: unknown) => (typeof id === "string" && tabs.includes(id) ? id : (tabs[0] ?? null));
  let s: PanesState = {
    leftTabs,
    rightTabs,
    leftActiveId: pick(leftTabs, saved.leftActiveId),
    rightActiveId: pick(rightTabs, saved.rightActiveId),
    split: !!saved.split && rightTabs.length > 0,
    activePane: saved.activePane === "right" ? "right" : "left",
    focus: localStorage.getItem(FOCUS_KEY) === "1",
    sheet: false,
    mounted: [],
    closedTabs: [],
  };
  if (!s.split) s = { ...s, leftTabs: [...leftTabs, ...rightTabs], rightTabs: [], rightActiveId: null, activePane: "left" };
  // Old deep links (?agent=) open as a tab.
  const linked = new URLSearchParams(location.search).get("agent");
  if (linked) s = place(s, linked, s.activePane, false);
  return settle(s, [s.leftActiveId, s.rightActiveId]);
}

/** Recompute the mounted set: both actives, then the most recent, capped at MAX_MOUNTED. */
function settle(s: PanesState, touched: (string | null)[] = []): PanesState {
  const open = new Set([...s.leftTabs, ...s.rightTabs]);
  for (const id of touched.reverse()) if (id) recent = [id, ...recent.filter((x) => x !== id)];
  recent = recent.filter((id) => open.has(id));
  const actives = [s.leftActiveId, s.split ? s.rightActiveId : null].filter((x): x is string => !!x);
  const keep = new Set(actives);
  for (const id of recent) {
    if (keep.size >= MAX_MOUNTED) break;
    keep.add(id);
  }
  const mounted = s.mounted.filter((id) => keep.has(id));
  for (const id of keep) if (!mounted.includes(id)) mounted.push(id);
  return { ...s, mounted: sameIds(mounted, s.mounted) ? s.mounted : mounted };
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Put `id` in `pane` (moving it out of the other pane), optionally making it that pane's active tab. */
function place(s: PanesState, id: string, pane: Pane, activate = true): PanesState {
  const from = paneIn(s, id);
  let next = s;
  if (from && from !== pane) next = remove(next, id);
  const tabs = next[tabsKey(pane)];
  const n: PanesState = { ...next, [tabsKey(pane)]: tabs.includes(id) ? tabs : [...tabs, id] };
  if (activate || !n[activeKey(pane)]) n[activeKey(pane)] = id;
  if (pane === "right") n.split = true;
  return n;
}

/** Drop `id` from whichever pane holds it; collapse the split when a pane runs empty. */
function remove(s: PanesState, id: string): PanesState {
  const pane = paneIn(s, id);
  if (!pane) return s;
  const tabs = s[tabsKey(pane)];
  const i = tabs.indexOf(id);
  const rest = tabs.filter((x) => x !== id);
  let n: PanesState = { ...s, [tabsKey(pane)]: rest };
  if (s[activeKey(pane)] === id) n[activeKey(pane)] = rest[Math.min(i, rest.length - 1)] ?? null;
  if (n.split && !n.rightTabs.length) n = { ...n, split: false, activePane: "left" };
  else if (n.split && !n.leftTabs.length)
    n = { ...n, leftTabs: n.rightTabs, leftActiveId: n.rightActiveId, rightTabs: [], rightActiveId: null, split: false, activePane: "left" };
  return n;
}

const paneIn = (s: PanesState, id: string): Pane | null =>
  s.leftTabs.includes(id) ? "left" : s.rightTabs.includes(id) ? "right" : null;

export const paneOfAgent = (id: string): Pane => paneIn(state, id) ?? state.activePane;

let state: PanesState = load();
const listeners = new Set<() => void>();

function commit(next: PanesState, touched: (string | null)[] = []) {
  next = settle(next, touched);
  if (next === state) return;
  const prev = state;
  state = next;
  if (
    prev.leftTabs !== next.leftTabs ||
    prev.rightTabs !== next.rightTabs ||
    prev.leftActiveId !== next.leftActiveId ||
    prev.rightActiveId !== next.rightActiveId ||
    prev.split !== next.split ||
    prev.activePane !== next.activePane
  ) {
    const { leftTabs, rightTabs, leftActiveId, rightActiveId, split, activePane } = next;
    try {
      localStorage.setItem(PANES_KEY, JSON.stringify({ leftTabs, rightTabs, leftActiveId, rightActiveId, split, activePane }));
    } catch {
      /* storage full: tabs still work for this session */
    }
  }
  if (prev.focus !== next.focus) localStorage.setItem(FOCUS_KEY, next.focus ? "1" : "0");
  listeners.forEach((l) => l());
}

/** After a restore, drop tabs whose agent is gone or archived so no pane sits on a ghost. */
export function pruneRestoredTabs(live: (id: string) => boolean) {
  const { leftTabs, rightTabs, leftActiveId, rightActiveId, split, activePane } = state;
  const p = pruneView({ leftTabs, rightTabs, leftActiveId, rightActiveId, split, activePane }, live);
  if (sameIds(p.leftTabs, leftTabs) && sameIds(p.rightTabs, rightTabs)) return;
  commit({ ...state, ...p }, [p.leftActiveId, p.rightActiveId]);
}

export const subscribePanes = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const getPanes = () => state;

// ---- actions -------------------------------------------------------------------------

/**
 * Open an agent. "active": focus its tab wherever it is, else add it to the active pane.
 * "other": open in the other pane (opens the split). "background": add a tab without switching.
 */
export function openAgent(id: string, mode: OpenMode = "active") {
  const s = { ...state, sheet: false };
  const at = paneIn(s, id);
  if (mode === "background") return commit(at ? s : place(s, id, s.activePane, false));
  if (mode === "other") {
    const target = other(s.activePane);
    // The active pane's only tab can't leave it empty; just show it.
    if (at === s.activePane && s[tabsKey(at)].length === 1) return commit({ ...s, [activeKey(at)]: id }, [id]);
    return commit({ ...place(s, id, target), activePane: target }, [id]);
  }
  const pane = at ?? s.activePane;
  commit({ ...place(s, id, pane), activePane: pane }, [id]);
}

/**
 * Open `id` in `pane` (defaults to the pane holding `replaceId` or `state.activePane`),
 * replacing `replaceId` in-place in that tab strip if provided.
 */
export function openAgentInTab(id: string, pane?: Pane, replaceId?: string) {
  const s = { ...state, sheet: false };
  const targetPane: Pane = pane ?? (replaceId ? paneIn(s, replaceId) : null) ?? s.activePane;
  let next = s;
  if (replaceId && replaceId !== id) {
    const oldPane = paneIn(next, replaceId);
    if (oldPane) {
      const tk = tabsKey(oldPane);
      const ak = activeKey(oldPane);
      const tabs = next[tk];
      const idx = tabs.indexOf(replaceId);
      if (idx >= 0 && oldPane === targetPane) {
        const replaced = tabs.map((t, i) => (i === idx ? id : t)).filter((t, i, arr) => arr.indexOf(t) === i);
        next = {
          ...next,
          [tk]: replaced,
          [ak]: id,
          activePane: targetPane,
          ...(targetPane === "right" ? { split: true } : {}),
        };
        return commit(next, [id]);
      }
      next = remove(next, replaceId);
    }
  }
  next = place(next, id, targetPane, true);
  commit({ ...next, activePane: targetPane }, [id]);
}

export function activateTab(pane: Pane, id: string) {
  if (state[activeKey(pane)] === id && state.activePane === pane) return;
  commit({ ...state, [activeKey(pane)]: id, activePane: pane }, [id]);
}

export function closeTab(id: string) {
  const n = remove(state, id);
  commit(n === state ? n : { ...n, closedTabs: pushClosed(state.closedTabs, id) }, [n.leftActiveId, n.rightActiveId]);
}

/** Reopen the most recently closed tab that is not already open (Ctrl+Shift+T). */
export function reopenClosedTab() {
  const { id, rest } = popClosed(state.closedTabs, (x) => paneIn(state, x) !== null);
  if (!id) return commit({ ...state, closedTabs: rest });
  commit({ ...place({ ...state, closedTabs: rest }, id, state.activePane), activePane: state.activePane }, [id]);
}

/** Move a tab to `to` (default: the other pane). Opens the split when needed. */
export function moveTab(id: string, to?: Pane) {
  const from = paneIn(state, id);
  if (!from) return;
  const target = to ?? other(from);
  if (target === from) return activateTab(from, id);
  // Moving the only left tab right would empty the left pane: keep it, there is nothing to split.
  if (target === "right" && state.leftTabs.length === 1) return;
  const n = place(state, id, target);
  commit({ ...n, activePane: n.split || target === "left" ? target : "left" }, [id]);
}

export function setActivePane(pane: Pane) {
  if (state.activePane === pane || (pane === "right" && !state.split)) return;
  commit({ ...state, activePane: pane });
}

/** Split on: an empty right pane waits for Shift+click. Split off: right tabs fold into the left. */
export function toggleSplit() {
  if (!state.split) return commit({ ...state, split: true, activePane: "right" });
  const { leftTabs, rightTabs, leftActiveId, rightActiveId } = state;
  commit({
    ...state,
    split: false,
    activePane: "left",
    leftTabs: [...leftTabs, ...rightTabs],
    rightTabs: [],
    leftActiveId: leftActiveId ?? rightActiveId,
    rightActiveId: null,
  });
}

/** Ctrl+1..9: the nth tab of the active pane. */
export function activateNth(n: number) {
  const pane = state.activePane;
  const id = state[tabsKey(pane)][n];
  if (id) activateTab(pane, id);
}

export const setFocus = (focus: boolean) => state.focus !== focus && commit({ ...state, focus });
export const toggleFocus = () => setFocus(!state.focus);
export const setSheet = (sheet: boolean) => state.sheet !== sheet && commit({ ...state, sheet });

/**
 * How a click asked to open something: Shift = other pane, Ctrl/Cmd/middle button = background tab.
 * Read from the event being dispatched, so every existing `onPick(id)` call site gets it for free.
 */
export function modeFromEvent(e: Event | undefined = window.event): OpenMode {
  if (!e || !("shiftKey" in e)) return "active";
  const m = e as MouseEvent;
  if (m.shiftKey) return "other";
  if (m.ctrlKey || m.metaKey || (m.type === "auxclick" && m.button === 1)) return "background";
  return "active";
}

// ---- selectors -----------------------------------------------------------------------

export const usePanes = () => useSyncExternalStore(subscribePanes, getPanes);

/** Which pane holds this agent's tab. Re-renders a row only when its own answer flips. */
export const useAgentPane = (id: string): Pane | null => useSyncExternalStore(subscribePanes, () => paneIn(state, id));

/** On screen right now (the active tab of a visible pane). */
export const isShown = (s: PanesState, id: string) => s.leftActiveId === id || (s.split && s.rightActiveId === id);
export const useIsShown = (id: string) => useSyncExternalStore(subscribePanes, () => isShown(state, id));

export const useFocusMode = () => useSyncExternalStore(subscribePanes, () => state.focus);
export const useClosedTabCount = () => useSyncExternalStore(subscribePanes, () => state.closedTabs.length);
export const useHasTabs = () => useSyncExternalStore(subscribePanes, () => state.leftTabs.length > 0);
