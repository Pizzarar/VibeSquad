// Pinned teams step 2 (docs/PLAN_PINNED_FEATURES.md §2): which pinned Team is focused in the middle.
// The focused Brainstorm is an ordinary panes.ts tab, so swapping pins never remounts a drawer: the
// old one stays mounted (hidden) with its scroll and draft, the new one is shown. This store only
// decides the layout: the grid ("home"), or one focused Team with the other pins in the right rail.
import { useSyncExternalStore } from "react";
import { getPanes, openAgent, subscribePanes, toggleSplit } from "./panes";
import { openPin } from "./pinActions";
import type { Pin } from "./pins";

export type PinFocus = {
  squadId: string;
  laneId: string;
  /** The Brainstorm shown in the middle; null while a quick start is still spawning it. */
  agentId: string | null;
  /** Bumped on every focus change so the swap animation can key off it. */
  seq: number;
};

type State = {
  focus: PinFocus | null;
  /** Back on the grid: the panes stay mounted (scroll, drafts) but hidden until something else opens. */
  home: boolean;
  /** The active tab when we went home; opening anything else leaves "home". */
  homeActive: string | null;
};

// Start on the grid even if tabs were restored from last session; a ?agent= deep link shows its drawer.
const deepLinked = typeof location !== "undefined" && new URLSearchParams(location.search).has("agent");
let state: State = { focus: null, home: !deepLinked, homeActive: deepLinked ? null : getPanes().leftActiveId };
let seq = 0;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const getPinFocus = () => state.focus;
export const usePinFocus = () => useSyncExternalStore(subscribe, () => state.focus);
export const usePinsHome = () => useSyncExternalStore(subscribe, () => state.home);

// Opening some other agent (an alert badge, FULL, a deep link) ends the pinned layout, so the rail
// never sits next to a drawer it doesn't describe.
subscribePanes(() => {
  const active = getPanes().leftActiveId;
  if (state.focus?.agentId && active !== state.focus.agentId) set({ focus: null });
  else if (state.home && active !== state.homeActive) set({ home: false, homeActive: null });
});

const show = (id: string) => {
  if (getPanes().split) toggleSplit(); // one drawer on screen: fold the split, nothing remounts
  openAgent(id);
};

/**
 * Focus a pin: its live Brainstorm opens in the middle at once, or a fresh one quick-starts from the
 * brief (the middle says "Starting…" meanwhile). Resolves with the agent id; rejects if the start fails.
 */
export async function focusPin(pin: Pin): Promise<string> {
  const mine = ++seq;
  const live = pin.brainstorm?.agent.id ?? null;
  // Set the focus before opening so the panes listener sees the expected active tab.
  set({ focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: live, seq: mine }, home: false, homeActive: null });
  if (live) {
    show(live);
    return live;
  }
  try {
    const id = await openPin(pin);
    if (state.focus?.seq === mine) {
      set({ focus: { ...state.focus, agentId: id } });
      show(id);
    }
    return id;
  } catch (e) {
    if (state.focus?.seq === mine) set({ focus: null });
    throw e;
  }
}

/** Esc / ⊞: back to the grid. The drawers stay mounted, hidden, so drafts and scroll survive. */
export function exitPinFocus() {
  if (!state.focus && state.home) return;
  set({ focus: null, home: true, homeActive: getPanes().leftActiveId });
}

/** Leave the pinned layout entirely (FULL, focus mode): the panes show as usual again. */
export function clearPinFocus() {
  if (state.focus || state.home) set({ focus: null, home: false, homeActive: null });
}
