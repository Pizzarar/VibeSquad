// Pinned teams step 2 (docs/PLAN_PINNED_FEATURES.md §2): which pinned Team is focused in the middle.
// The focused Brainstorm is an ordinary panes.ts tab, so swapping pins never remounts a drawer: the
// old one stays mounted (hidden) with its scroll and draft, the new one is shown. This store only
// decides the layout: the grid ("home"), or one focused Team with the other pins in the right rail.
// The focus follows the pin, not the agent: a restarted Brainstorm is followed, a retired one leaves
// the pin focused with "Start fresh Brainstorm" (src/pinFocusLogic.ts has the rules).
import { useSyncExternalStore } from "react";
import { getPanes, openAgent, subscribePanes, toggleSplit } from "./panes";
import { subscribePaseo } from "./paseo";
import { openPin } from "./pinActions";
import { reconcilePinFocus } from "./pinFocusLogic";
import { pinsForSquad, type Pin } from "./pins";
import { subscribeTeams } from "./teams";
import { derived } from "./ui";

export type PinFocus = {
  squadId: string;
  laneId: string;
  /** The Brainstorm shown in the middle; null while a quick start spawns it, or after it went away. */
  agentId: string | null;
  /** The pin's Brainstorm was retired / archived and nothing replaced it: offer "Start fresh Brainstorm". */
  gone: boolean;
  /** While agentId is null: the active tab at that moment (opening anything else exits). */
  held: string | null;
  /** Bumped on every pin change so the swap animation and stale quick starts can key off it. */
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

const show = (id: string) => {
  if (getPanes().split) toggleSplit(); // one drawer on screen: fold the split, nothing remounts
  openAgent(id);
};

/** The focused pin's live Brainstorm id right now, as the rail sees it. */
function liveBrainstorm(f: PinFocus): string | null {
  const view = derived().views.find((v) => v.team.id === f.squadId);
  if (!view) return null;
  const { pinned, done } = pinsForSquad(view);
  return [...pinned, ...done].find((p) => p.lane.id === f.laneId)?.brainstorm?.agent.id ?? null;
}

let reconciling = false;
function reconcile() {
  const active = getPanes().leftActiveId;
  if (state.home && !state.focus && active !== state.homeActive) return set({ home: false, homeActive: null });
  const f = state.focus;
  if (!f || reconciling) return;
  const d = reconcilePinFocus(f, liveBrainstorm(f), active);
  if (d.kind === "keep") return;
  reconciling = true;
  try {
    if (d.kind === "exit") set({ focus: null });
    else if (d.kind === "gone") set({ focus: { ...f, agentId: null, gone: true, held: active } });
    else {
      set({ focus: { ...f, agentId: d.agentId, gone: false, held: null } });
      if (d.open) show(d.agentId);
    }
  } finally {
    reconciling = false;
  }
}

subscribePanes(reconcile);
subscribePaseo(reconcile);
subscribeTeams(reconcile);

/**
 * Focus a pin: its live Brainstorm opens in the middle at once, or a fresh one quick-starts from the
 * brief (the middle says "Starting…" meanwhile). Resolves with the agent id; rejects if the start fails.
 */
export async function focusPin(pin: Pin): Promise<string> {
  const mine = ++seq;
  const live = pin.brainstorm?.agent.id ?? null;
  const active = getPanes().leftActiveId;
  // Set the focus before opening so the reconcile on the panes change sees the expected tab.
  set({
    focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: live, gone: false, held: live ? null : active, seq: mine },
    home: false,
    homeActive: null,
  });
  if (live) {
    show(live);
    return live;
  }
  try {
    const id = await openPin(pin);
    const f = state.focus;
    if (f?.seq === mine && f.agentId !== id) {
      set({ focus: { ...f, agentId: id, gone: false, held: null } });
      show(id);
    }
    return id;
  } catch (e) {
    // Keep the pin focused; a failed fresh start goes back to offering "Start fresh Brainstorm".
    const f = state.focus;
    if (f?.seq === mine) set({ focus: { ...f, gone: true, held: getPanes().leftActiveId } });
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
