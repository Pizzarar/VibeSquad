// Pinned teams step 2 (docs/PLAN_PINNED_FEATURES.md §2): which pinned Team is focused in the middle.
// The focused Brainstorm is an ordinary panes.ts tab, so swapping pins never remounts a drawer: the
// old one stays mounted (hidden) with its scroll and draft, the new one is shown. This store only
// decides the layout: the grid ("home"), or one focused Team with the other pins in the right rail.
// The focus follows the pin, not the agent: a restarted Brainstorm is followed, a retired one leaves
// the pin focused with "Start fresh Brainstorm" (src/pinFocusLogic.ts has the rules).
import { useSyncExternalStore } from "react";
import { isRetiredAgent } from "./identity";
import { closeTab, getPanes, openAgent, subscribePanes, toggleSplit } from "./panes";
import { getPaseoState, subscribePaseo } from "./paseo";
import { openPin } from "./PinGrid";
import { focusDrawerOpen, hubOpenAgent } from "./ctxMenuLogic";
import { isLiveUrlAgent, levelUp, loadSavedFocus, planRestore, reconcilePinFocus, saveFocus, savedFocusForUrl, startsOnGrid } from "./pinFocusLogic";
import { getPref, getRestoreLastView } from "./prefs";
import { dormantBuddyId, hubPinForSquad, isHubPin, liveBuddyId, pinsForSquad, type Pin } from "./pins";
import { subscribeTeams, type TeamView } from "./teams";
import { derived, subscribeTree } from "./ui";

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
  /** Inline error when Spin Up fails, cleared when changing pins or starting a new Spin Up. */
  spinUpError?: string | null;
};

export type PinFocusSnapshot = {
  focus: PinFocus | null;
  /** Back on the grid: the panes stay mounted (scroll, drafts) but hidden until something else opens. */
  home: boolean;
  /** The active tab when we went home; opening anything else leaves "home". */
  homeActive: string | null;
  /** One level above the squad page: the grid of all squads. Only meaningful while home is true. */
  squadsHome: boolean;
  /** Error from the most recent Spin Up failure on the focused pin, or null. */
  spinUpError: string | null;
};

type State = PinFocusSnapshot;

// Start on the grid even if tabs were restored from last session, unless "Reopen last view" is on and a tab was
// saved (then the restored panes show); a ?agent= deep link shows its drawer.
const deepLinked = typeof location !== "undefined" && new URLSearchParams(location.search).has("agent");
// The ?agent= the page was opened with. App's URL sync pushes ?agent=<active tab> before the daemon connects, so
// tryRestore must not re-read location.search or it mistakes the restored tab for a deep link.
const initialUrlAgent = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("agent");
// R5-4: an explicit ?team= (no ?agent=) beats a saved pin of another squad.
const initialUrlTeam = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("team");
const startOnSquadsHome = !deepLinked && typeof location !== "undefined" && new URLSearchParams(location.search).get("view") === "squads";
const startHome = startsOnGrid({
  deepLinked,
  viewSquads: startOnSquadsHome,
  restoreLastView: getRestoreLastView(),
  savedLeftTab: getPanes().leftActiveId,
});
let state: State = { focus: null, home: startHome, homeActive: startHome ? getPanes().leftActiveId : null, squadsHome: startOnSquadsHome, spinUpError: null };
let seq = 0;
const listeners = new Set<() => void>();

const store = typeof localStorage === "undefined" ? undefined : localStorage;

function set(next: Partial<State>) {
  state = { ...state, ...(next.focus === null && !("spinUpError" in next) ? { spinUpError: null } : {}), ...next };
  // The focused pin survives a reload (squad + lane, not agent id). Leaving the pinned layout forgets it.
  if ("focus" in next) saveFocus(store, state.focus ? { squadId: state.focus.squadId, laneId: state.focus.laneId } : null);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const getPinFocus = () => state.focus;
export const usePinFocus = () => useSyncExternalStore(subscribe, () => state.focus);
export const getSpinUpError = () => state.focus?.spinUpError ?? state.spinUpError;
export const useSpinUpError = () => useSyncExternalStore(subscribe, getSpinUpError);
export const usePinsHome = () => useSyncExternalStore(subscribe, () => state.home);
export const getPinsHome = () => state.home;
export const getSquadsHome = () => state.home && !state.focus && state.squadsHome;
export const useSquadsHome = () => useSyncExternalStore(subscribe, getSquadsHome);

const show = (id: string) => {
  if (getPanes().split) toggleSplit(); // one drawer on screen: fold the split, nothing remounts
  openAgent(id);
};

/** The focused pin as the rail sees it right now. */
function focusedPin(f: PinFocus): Pin | null {
  const view = derived().views.find((v) => v.team.id === f.squadId);
  if (!view) return null;
  const { pinned, done } = pinsForSquad(view, { includeHidden: true });
  const hub = hubPinForSquad(view);
  return [...pinned, ...done].find((p) => p.lane.id === f.laneId) ?? (hub?.lane.id === f.laneId ? hub : null);
}

/** Every agent of a pin's lane: its Buddy, Lead, workers and topic Buddies. */
export function laneMemberIdsOf(pin: Pin | null): Set<string> {
  const ids = new Set<string>();
  if (!pin) return ids;
  if (pin.brainstorm) ids.add(pin.brainstorm.agent.id);
  if (pin.lead) ids.add(pin.lead.agent.id);
  for (const m of [...pin.workers, ...pin.topicBrainstorms]) ids.add(m.agent.id);
  return ids;
}

let reconciling = false;
function reconcile() {
  const active = getPanes().leftActiveId;
  if (state.home && !state.focus && active !== state.homeActive) return set({ home: false, homeActive: null, squadsHome: false });
  const f = state.focus;
  if (!f || reconciling) return;
  const pin = focusedPin(f);
  const liveId = pin ? liveBuddyId(pin) : null;
  const d = reconcilePinFocus(f, liveId ?? (pin ? dormantBuddyId(pin) : null), active, laneMemberIdsOf(pin));
  if (d.kind === "keep") return;
  reconciling = true;
  try {
    if (d.kind === "exit") set({ focus: null });
    else if (d.kind === "gone") set({ focus: { ...f, agentId: null, gone: true, held: active } });
    else {
      // A closed Buddy is followed with the Spin Up picker still shown above its history.
      set({ focus: { ...f, agentId: d.agentId, gone: !liveId, held: null } });
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
 * Focus a pin: its existing Brainstorm (or past former-brainstorm) opens in the middle at once;
 * if there is no session yet, show the empty focus view with an explicit "Spin Up" button without auto-spawning.
 */
export async function focusPin(pin: Pin): Promise<string | null> {
  // Dormant pin (no Buddy, or only a closed one): never auto-spawn. Show the Spin Up profile picker instead.
  const live = liveBuddyId(pin);
  const dormant = live ? null : dormantBuddyId(pin);
  if (dormant) {
    // Closed/lost Buddy with history: open it read-only and keep the picker above it. Never auto-spawn or resume.
    set({
      focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: dormant, gone: true, held: null, seq: ++seq, spinUpError: null },
      home: false,
      homeActive: null,
      squadsHome: false,
      spinUpError: null,
    });
    show(dormant);
    return dormant;
  }
  if (!live) {
    set({
      focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: null, gone: true, held: getPanes().leftActiveId, seq: ++seq, spinUpError: null },
      home: false,
      homeActive: null,
      squadsHome: false,
      spinUpError: null,
    });
    return null;
  }
  const mine = ++seq;
  // Set the focus before opening so the reconcile on the panes change sees the expected tab.
  set({
    focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: live, gone: false, held: null, seq: mine, spinUpError: null },
    home: false,
    homeActive: null,
    squadsHome: false,
    spinUpError: null,
  });
  show(live);
  focusComposerSoon(live);
  return live;
}

/** Is this agent the focused pin's Buddy, Lead, worker or topic Buddy? */
export const useInFocusedLane = (agentId: string): boolean =>
  useSyncExternalStore(subscribeTree, () => {
    const f = state.focus;
    return !!f && (f.agentId === agentId || laneMemberIdsOf(focusedPin(f)).has(agentId));
  });

const subscribeDrawer = (l: () => void) => {
  const offs = [subscribe(l), subscribeTree(l), subscribePanes(l)];
  return () => offs.forEach((off) => off());
};
/** The hub's Sky zone bots (RiffBot = Buddy, Overlord = Lead), mirroring skyZonesFor without importing it. */
const hubZoneIds = (pin: Pin): string[] => [pin.brainstorm?.agent.id, pin.lead?.agent.id].filter((x): x is string => !!x);
/** Is there a drawer in the middle for the focused lane (see focusDrawerOpen)? One answer for the header, rail, layout class and drawer header. */
export const useFocusDrawerOpen = (): boolean =>
  useSyncExternalStore(subscribeDrawer, () => {
    const f = state.focus;
    if (!f) return false;
    const pin = focusedPin(f);
    return focusDrawerOpen(f.agentId, getPanes().leftActiveId, laneMemberIdsOf(pin), pin && isHubPin(pin) ? hubZoneIds(pin) : []);
  });

// A rail click on a Sky bot must open its chat on the hub's sky (the sky keeps the chat in local state): HubPages watches this.
let skyReq: { bot: "riffbot" | "overlord" | null; n: number } = { bot: null, n: 0 };
const skyListeners = new Set<() => void>();
export const getSkyRequest = () => skyReq;
export const subscribeSkyRequest = (l: () => void) => (skyListeners.add(l), () => void skyListeners.delete(l));
export const useSkyRequest = () => useSyncExternalStore(subscribeSkyRequest, getSkyRequest);

/**
 * Open one of a pin's own agents (Lead, worker, topic Buddy or the Buddy) in the middle while the pin stays
 * focused and the rail stays visible. A pin that isn't focused yet is focused first.
 */
export function openPinMember(pin: Pin, agentId: string) {
  const f = state.focus;
  if (!f || f.squadId !== pin.squad.id || f.laneId !== pin.lane.id) void focusPin(pin);
  show(agentId);
  if (isHubPin(pin) && (agentId === pin.brainstorm?.agent.id || agentId === pin.lead?.agent.id)) {
    skyReq = { bot: agentId === pin.brainstorm?.agent.id ? "riffbot" : "overlord", n: skyReq.n + 1 };
    skyListeners.forEach((l) => l());
  }
}

/** Explicitly spin up a Brainstorm / RiffBot chat for a selected pin when the user clicks Spin Up. */
export async function spinUpPin(pin: Pin, profile?: string, openPinFn: typeof openPin = openPin): Promise<string> {
  const mine = ++seq;
  const active = getPanes().leftActiveId;
  set({
    focus: { squadId: pin.squad.id, laneId: pin.lane.id, agentId: null, gone: false, held: active, seq: mine, spinUpError: null },
    home: false,
    homeActive: null,
    squadsHome: false,
    spinUpError: null,
  });
  try {
    const id = openPinFn !== openPin ? await openPinFn(pin, profile) : profile ? await openPin(pin, profile) : await openPin(pin);
    if (!id) throw new Error("Could not start Brainstorm session");
    const f = state.focus;
    if (f?.seq === mine && f.agentId !== id) {
      set({ focus: { ...f, agentId: id, gone: false, held: null, spinUpError: null }, spinUpError: null });
      show(id);
    }
    if (state.focus?.seq === mine) focusComposerSoon(id);
    return id;
  } catch (err: any) {
    const spinUpError = err?.message || String(err);
    const f = state.focus;
    if (f?.seq === mine) set({ focus: { ...f, gone: true, held: getPanes().leftActiveId, spinUpError }, spinUpError });
    throw err;
  }
}

/** Is a non-sky agent open on the focused hub lane (its chat takes the middle, the sky steps aside)? */
function hubChatOpen(f: PinFocus, hub: Pin, view: TeamView | undefined): boolean {
  if (!view) return false;
  return hubOpenAgent(f.agentId, getPanes().leftActiveId, laneMemberIdsOf(hub), hubZoneIds(hub));
}

/** Esc / ⊞: one level up. Chat → squad page → Squads Home. The drawers stay mounted, hidden, so drafts and scroll survive. */
export function exitPinFocus() {
  // Psycho: the Squad's hub page (RiffBot + Overlord TVs over the Office Tower) is the one Squad home. Esc from any other lane,
  // or from a hub agent's chat, lands on it; Esc from the hub page itself goes up to Squads Home.
  const f = state.focus;
  if (f) {
    const view = derived().views.find((v) => v.team.id === f.squadId);
    const hub = hubPinForSquad(view);
    if (hub && !(hub.lane.id === f.laneId && !hubChatOpen(f, hub, view))) {
      void focusPin(hub).catch(() => {});
      return;
    }
  }
  const up = levelUp({ focused: !!state.focus, home: state.home, squadsHome: state.squadsHome });
  if (up === "none") return;
  set({ focus: null, home: true, squadsHome: up === "squads-home", homeActive: getPanes().leftActiveId });
}

/** Go to the grid of all squads (breadcrumb "Squads", the squad page's ⊞). */
export function enterSquadsHome() {
  if (getSquadsHome()) return;
  set({ focus: null, home: true, squadsHome: true, homeActive: getPanes().leftActiveId });
}

/** Show the active squad's page (opening a squad from Squads Home, the sidebar or the breadcrumb). */
export function exitSquadsHome() {
  set({ focus: null, home: true, squadsHome: false, homeActive: getPanes().leftActiveId });
}

// R5-4: the agent Normal has on screen (undefined while BoringApp is not mounted). App's URL sync names it as ?agent=.
let boringShown: string | null | undefined;
const boringShownSubs = new Set<() => void>();
export function setBoringShownAgent(id: string | null | undefined) {
  if (id === boringShown) return;
  boringShown = id;
  for (const f of boringShownSubs) f();
}
const subscribeBoringShown = (f: () => void) => {
  boringShownSubs.add(f);
  return () => void boringShownSubs.delete(f);
};
export const useBoringShownAgent = () => useSyncExternalStore(subscribeBoringShown, () => boringShown, () => undefined);

/** Leave the pinned layout entirely (FULL, focus mode): the panes show as usual again. */
export function clearPinFocus() {
  if (state.focus || state.home) set({ focus: null, home: false, homeActive: null, squadsHome: false });
}

/**
 * After a pin or rail click opens a Brainstorm, put the cursor in its composer so typing works at once.
 * The drawer may still be mounting (quick start), so retry for about a second; give up if the user
 * already focused another field or the pin changed.
 */
export function focusComposerSoon(agentId: string) {
  if (typeof document === "undefined") return;
  const started = Date.now();
  const sel = `:is(.agent-panes, .sky-zone) .pane-slot[data-agent="${CSS.escape(agentId)}"] .composer textarea`;
  const tick = () => {
    if (state.focus?.agentId !== agentId) return;
    const ta0 = document.querySelector<HTMLTextAreaElement>(sel);
    const cur = document.activeElement as HTMLElement | null;
    // Don't steal focus from another field the user moved to meanwhile.
    if (cur && cur !== ta0 && (/^(INPUT|TEXTAREA|SELECT)$/.test(cur.tagName) || cur.isContentEditable)) return;
    const ta = document.querySelector<HTMLTextAreaElement>(sel);
    if (ta && ta.offsetParent !== null) {
      ta.focus({ preventScroll: true });
      if (document.activeElement === ta) return;
    }
    if (Date.now() - started < 1200) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Reload restore: the focused pin comes back; a stale ?agent= never leaves an empty rail ──────
let restored = typeof location === "undefined";
function tryRestore() {
  if (restored) return;
  const ps = getPaseoState();
  // R6-1: wait for the whole first roster snapshot, not "connected with one agent": the stream opens before the
  // snapshot, and a partial map makes a late-sorting ?agent= look stale (closeTab → Overview).
  if (!ps.rosterLoaded) return;
  restored = true;
  if (state.focus) return;
  if (state.home && state.squadsHome) return; // ?view=squads in the URL wins over the saved pin
  const savedFocus = loadSavedFocus(store);
  const saved = savedFocusForUrl(savedFocus, { team: initialUrlTeam, agent: initialUrlAgent, normal: getPref("app.vibe") === "boring" });
  const urlAgent = initialUrlAgent;
  const urlAgentRow = urlAgent ? ps.agents.get(urlAgent) : undefined;
  const urlLive = !!urlAgent && isLiveUrlAgent(urlAgentRow, isRetiredAgent(urlAgentRow));
  let pin: Pin | undefined;
  if (saved) {
    const view = derived().views.find((v) => v.team.id === saved.squadId);
    const hubPin = view ? hubPinForSquad(view) : null;
    pin = view ? (pinsForSquad(view, { includeHidden: true }).pinned.find((p) => p.lane.id === saved.laneId) ?? (hubPin?.lane.id === saved.laneId ? hubPin : undefined)) : undefined;
  }
  const plan = planRestore({
    saved,
    urlAgent,
    urlAgentLive: urlLive,
    pinBrainstorm: pin ? liveBuddyId(pin) : undefined,
  });
  if (plan.kind === "none") return;
  if (plan.closeStale) closeTab(plan.closeStale);
  if (plan.kind === "home") return set({ focus: null, home: true, squadsHome: false, homeActive: getPanes().leftActiveId });
  const seqNow = ++seq;
  if (plan.agentId) {
    set({ focus: { squadId: plan.squadId, laneId: plan.laneId, agentId: plan.agentId, gone: false, held: null, seq: seqNow }, home: false, homeActive: null, squadsHome: false });
    show(plan.agentId);
  } else {
    set({ focus: { squadId: plan.squadId, laneId: plan.laneId, agentId: null, gone: true, held: getPanes().leftActiveId, seq: seqNow }, home: false, homeActive: null, squadsHome: false });
  }
}
subscribePaseo(tryRestore);
tryRestore();
