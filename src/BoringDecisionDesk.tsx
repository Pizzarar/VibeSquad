import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEMO } from "./demoFlag";
import { demoLog, type FeedEntry } from "./demo";
import { formatAge } from "./attentionItems";
import { laneCode, laneDisplayName } from "./boringLocation";
import { isHubPin, isLive, liveBuddyId, pinsForSquad, quickBugsChipState } from "./pins";
import { skyZonesFor } from "./skyZonesLogic";
import type { FolderDef, TeamView } from "./teams";
import { cleanTitle } from "./ui";
import {
  applyActivePreset,
  applyAllPreset,
  buildDecisionPills,
  countHiddenStaged,
  countVisibleDecisions,
  decisionFilterPresetState,
  filterDecisionItems,
  readDecisionFilterOverrides,
  toggleDecisionPill,
  visibleSquadIds,
  writeDecisionFilterOverrides,
  type DecisionFilterOverrides,
} from "./decisionFilter";

// @desk D4 (docs/PLAN_DESK_DECISION_DESK.md): cross-Squad Decision Desk.
// One landing page: live status strip per lane (grouped by Squad), oldest-first decision feed
// (yes/no with lean pre-selected, 1-line answer box, off-screen strip), and sticky batch Send with 5s Undo.

/** Placement lean (PLAN_DESK_DECISION_DESK.md): flip to false to make Decision Desk sidebar-only. */
export const DECISION_DESK_DEFAULT_LANDING = true;

/**
 * Lean policy (UX R37 M1). true = explicit opt-in: an unstaged lean renders as a dashed *suggestion* (aria-pressed=false) and only
 * ships after the owner taps it or `Use all leans`. Flip to false for option (a): every lean is auto-staged when its card arrives.
 */
export const DECISION_LEANS_OPT_IN = true;

/** Lanes idle with no event for this long fold into one `+N quiet` line per Squad (UX R37 M2). */
export const QUIET_LANE_MS = 2 * 60 * 60_000;

/** Wide layout (strip in a right rail beside the feed): a viewport this wide leaves the main area ~1600px (UX R37 M2). */
export const DECISION_RAIL_QUERY = "(min-width: 1900px)";

function useWideRail(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DECISION_RAIL_QUERY).matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DECISION_RAIL_QUERY);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Undo window before batch answers are dispatched (ms). */
export const DECISION_UNDO_MS = 5000;

export type DecisionKind = "yesno" | "answer" | "offscreen" | "";

export type DecisionItem = {
  id: string;
  source?: "log" | "label";
  squad: string;
  squadName?: string;
  lane: string;
  askerId?: string;
  asker?: { id: string; title: string; live: boolean };
  ask: string;
  decides?: string;
  lean?: string;
  alts?: string[];
  kind?: DecisionKind | string;
  structured?: boolean;
  /** D3 Assistant pass may infer fields on unstructured needs-you entries; optional. */
  inferred?: boolean;
  /** D3 Assistant pass may group near-duplicate asks under one card; optional. */
  sourceIds?: string[];
  groupSize?: number;
  rawText?: string;
  ts: number;
  at?: string;
  ageMs?: number;
};

export type DecisionRowType = "yesno" | "answer" | "offscreen";

export type StagedChoice =
  | { choice: "lean" }
  | { choice: `alt:${number}` }
  | { choice: "not" }
  | { choice: "reply"; text: string }
  | { choice: "dismiss" };

export type AnswerPayloadItem = {
  id: string;
  choice: "lean" | `alt:${number}` | "not" | "reply" | "dismiss";
  text?: string;
};

export type AnswerResultItem = {
  id: string;
  choice: string;
  status: "delivered" | "dismissed" | "rejected" | "failed";
  target?: string;
  via?: string;
  error?: string;
  already?: boolean;
};

export type StatusLaneLine = {
  key: string;
  squadId: string;
  laneId: string;
  label: string;
  code: string;
  leadState: "running" | "idle" | "needs-you" | "error" | "none";
  lastEvent: string;
  lastEventType: "done" | "decision" | "";
  age: string;
  openAgentId: string | null;
  /** Newest event/activity timestamp (ms); 0 when unknown. */
  lastTs: number;
  /** Open feed decisions waiting on the owner for this lane (UX R37 m1). */
  openDecisions: number;
};

export type StatusSquadGroup = {
  squadId: string;
  squadName: string;
  view: TeamView;
  lanes: StatusLaneLine[];
};

// ---- Pure helpers (unit-tested under node) ----------------------------------------------------

/** Classify an item into one of the three Decision Desk row types. */
export function classifyDecisionRow(item: Pick<DecisionItem, "kind" | "lean">): DecisionRowType {
  if (item.kind === "offscreen") return "offscreen";
  if (item.kind === "yesno") return "yesno";
  if (item.kind === "answer") return "answer";
  return item.lean && item.lean.trim() ? "yesno" : "answer";
}

/** Group open feed items (excluding offscreen) by Squad, preserving oldest-first order inside each Squad and across Squads. */
export function groupFeedBySquad(items: DecisionItem[]): { squad: string; squadName: string; items: DecisionItem[] }[] {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const bySquad = new Map<string, { squad: string; squadName: string; items: DecisionItem[] }>();
  for (const item of sorted) {
    const key = item.squad.toLowerCase();
    let grp = bySquad.get(key);
    if (!grp) {
      grp = { squad: item.squad, squadName: item.squadName || item.squad, items: [] };
      bySquad.set(key, grp);
    }
    grp.items.push(item);
  }
  return [...bySquad.values()];
}

/** UX R38 m3: order the status strip's Squads like the feed (Squads with feed items first, in feed order); the rest keep their order. */
export function orderStripLikeFeed<T extends { squadId: string }>(groups: readonly T[], feed: readonly { squad: string }[]): T[] {
  const rank = new Map(feed.map((g, i) => [g.squad.toLowerCase(), i] as const));
  const r = (g: T) => rank.get(g.squadId.toLowerCase()) ?? feed.length;
  return groups.map((g, i) => ({ g, i })).sort((a, b) => r(a.g) - r(b.g) || a.i - b.i).map((x) => x.g);
}

/** Build the POST /__vibesquad/decisions/answer payload from staged selections, in feed order. */
export function buildAnswerBatch(items: DecisionItem[], staged: Readonly<Record<string, StagedChoice>>): AnswerPayloadItem[] {
  const out: AnswerPayloadItem[] = [];
  for (const item of items) {
    const sel = staged[item.id];
    if (!sel) continue;
    if (sel.choice === "reply") {
      const text = sel.text.trim();
      if (!text) continue;
      out.push({ id: item.id, choice: "reply", text });
    } else {
      out.push({ id: item.id, choice: sel.choice });
    }
  }
  return out;
}

/** Match the newest `done` or `decision` log entry for a lane (matches by laneId, `@code`, or code). */
export function lastLaneLogEvent(entries: FeedEntry[], laneId: string, code: string): { text: string; type: "done" | "decision"; ts: string } | null {
  const targets = new Set<string>();
  if (laneId) targets.add(laneId.toLowerCase());
  if (code) {
    const c = code.replace(/^@/, "").toLowerCase();
    targets.add(c);
    targets.add(`@${c}`);
  }
  let best: { text: string; type: "done" | "decision"; ts: string; t: number } | null = null;
  for (const e of entries) {
    if (e.type !== "done" && e.type !== "decision") continue;
    const el = String(e.lane ?? "").trim().toLowerCase();
    if (!el || !targets.has(el)) continue;
    const t = Date.parse(e.ts);
    const ms = Number.isFinite(t) ? t : 0;
    if (!best || ms >= best.t) best = { text: e.text, type: e.type, ts: e.ts, t: ms };
  }
  return best ? { text: best.text, type: best.type, ts: best.ts } : null;
}

/** Does an open decision belong to this strip lane? Matches lane id or `@code`; the Desk line takes hub-level asks. */
export function decisionMatchesLane(item: Pick<DecisionItem, "squad" | "lane">, squadId: string, laneId: string, code: string): boolean {
  if (item.squad.toLowerCase() !== squadId.toLowerCase()) return false;
  const l = String(item.lane ?? "").replace(/^@/, "").trim().toLowerCase();
  if (laneId === "_desk") return l === "" || l === "desk" || l === "hub" || l === squadId.toLowerCase();
  return l === laneId.toLowerCase() || (Boolean(code) && l === code.replace(/^@/, "").toLowerCase());
}

/** A lane is quiet when it has nothing for the owner: idle/no lead, no open decision, and no event within QUIET_LANE_MS. */
export function isQuietLane(line: StatusLaneLine, now: number): boolean {
  if (line.openDecisions > 0) return false;
  if (line.leadState !== "idle" && line.leadState !== "none") return false;
  return !line.lastTs || now - line.lastTs > QUIET_LANE_MS;
}

/** Split one Squad's lanes into the always-visible lines (Desk first, then lanes needing the owner, then the rest) and the quiet fold. */
export function splitQuietLanes(lanes: StatusLaneLine[], now: number): { shown: StatusLaneLine[]; quiet: StatusLaneLine[] } {
  const rank = (l: StatusLaneLine) => (l.openDecisions > 0 || l.leadState === "needs-you" || l.leadState === "error" ? 0 : 1);
  const desk = lanes.filter((l) => l.laneId === "_desk");
  const rest = lanes.filter((l) => l.laneId !== "_desk");
  const quiet = rest.filter((l) => isQuietLane(l, now));
  const live = rest.filter((l) => !isQuietLane(l, now));
  const sorted = [...live.filter((l) => rank(l) === 0), ...live.filter((l) => rank(l) === 1)];
  return { shown: [...desk, ...sorted], quiet };
}

/** Footer counts that explain each other: total = here (feed) + off-screen (UX R37 m2). */
export function decisionSummary(items: Pick<DecisionItem, "kind" | "lean">[]): string {
  if (items.length === 0) return "All clear across Squads";
  const off = items.filter((i) => classifyDecisionRow(i) === "offscreen").length;
  return `${items.length} open · ${items.length - off} here · ${off} off-screen`;
}

function leadStateOf(lead: { agent: { status?: string }; attention?: { tone?: string } | null } | null | undefined, needsYou: number): StatusLaneLine["leadState"] {
  if (!lead) return needsYou > 0 ? "needs-you" : "none";
  if (lead.agent.status === "error" || lead.attention?.tone === "error") return "error";
  if (needsYou > 0 || (lead.attention && lead.attention.tone !== "finished")) return "needs-you";
  if (lead.agent.status === "running") return "running";
  return "idle";
}

/** Build the live status strip grouped by Squad: one compact line per lane (Desk, Bugs if present, and every pinned lane). */
export function buildStatusStrip(views: TeamView[], logsByTeam: Readonly<Record<string, FeedEntry[]>>, now = Date.now(), openItems: readonly DecisionItem[] = []): StatusSquadGroup[] {
  return views.map((view) => {
    const entries = logsByTeam[view.team.id] ?? [];
    const zones = skyZonesFor(view);
    const bugs = quickBugsChipState(view);
    const lanes: StatusLaneLine[] = [];
    const openFor = (laneId: string, code: string) => openItems.filter((i) => decisionMatchesLane(i, view.team.id, laneId, code)).length;
    const tsOf = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

    // Hub / Desk line (Overlord)
    const hubEv = lastLaneLogEvent(entries, view.team.id, "") ?? lastLaneLogEvent(entries, "hub", "");
    const ov = zones.overlord.member;
    const ovNeeds = ov?.attention && ov.attention.tone !== "finished" ? 1 : 0;
    lanes.push({
      key: `${view.team.id}|_desk`,
      squadId: view.team.id,
      laneId: "_desk",
      label: "Desk",
      code: "",
      leadState: leadStateOf(ov, ovNeeds),
      lastEvent: hubEv?.text ?? "",
      lastEventType: hubEv?.type ?? "",
      age: hubEv ? formatAge(Date.parse(hubEv.ts), now) : ov?.agent.updatedAt ? formatAge(Date.parse(ov.agent.updatedAt), now) : "",
      openAgentId: zones.overlord.agentId ?? zones.riffbot.agentId ?? null,
      lastTs: hubEv ? tsOf(hubEv.ts) : tsOf(ov?.agent.updatedAt),
      openDecisions: openFor("_desk", ""),
    });

    // Bugs line if the Squad has a Bugs lane
    if (bugs.pin) {
      const bEv = lastLaneLogEvent(entries, bugs.pin.lane.id, "bug");
      lanes.push({
        key: `${view.team.id}|_bugs`,
        squadId: view.team.id,
        laneId: bugs.pin.lane.id,
        label: "Bugs",
        code: "@bug",
        leadState: leadStateOf(bugs.pin.lead, bugs.needsYou),
        lastEvent: bEv?.text ?? "",
        lastEventType: bEv?.type ?? "",
        age: bEv ? formatAge(Date.parse(bEv.ts), now) : "",
        openAgentId: (isLive(bugs.pin.lead) ? bugs.pin.lead?.agent.id : null) ?? liveBuddyId(bugs.pin) ?? null,
        lastTs: bEv ? tsOf(bEv.ts) : 0,
        openDecisions: openFor(bugs.pin.lane.id, "@bug"), // the @bug code already matches lane "bug" asks: count each once
      });
    }

    // Feature lanes
    const pinned = pinsForSquad(view).pinned.filter((p) => !isHubPin(p) && p.lane.id !== view.team.id && p.lane.id !== bugs.pin?.lane.id);
    for (const pin of pinned) {
      const name = laneDisplayName(view.team, pin.lane.id, [pin.lane]);
      const code = laneCode({ lanes: [...(view.team.lanes ?? []), ...(pin.lane.dynamic ? [] : [pin.lane])] }, pin.lane.id);
      const ev = lastLaneLogEvent(entries, pin.lane.id, code);
      const lead = pin.lead;
      const openAgentId = (isLive(lead) ? lead?.agent.id : null) ?? liveBuddyId(pin) ?? null;
      const stamp = ev ? Date.parse(ev.ts) : lead?.agent.updatedAt ? Date.parse(lead.agent.updatedAt) : pin.brainstorm?.agent.updatedAt ? Date.parse(pin.brainstorm.agent.updatedAt) : NaN;
      lanes.push({
        key: `${view.team.id}|${pin.lane.id}`,
        squadId: view.team.id,
        laneId: pin.lane.id,
        label: name,
        code,
        leadState: leadStateOf(lead, pin.needsYou ?? 0),
        lastEvent: ev?.text ?? "",
        lastEventType: ev?.type ?? "",
        age: Number.isFinite(stamp) ? formatAge(stamp, now) : "",
        openAgentId,
        lastTs: Number.isFinite(stamp) ? stamp : 0,
        openDecisions: openFor(pin.lane.id, code),
      });
    }

    return { squadId: view.team.id, squadName: view.team.name, view, lanes };
  });
}

// ---- Demo fallback (12 items across 3 Squads; zero personal identifiers) ----------------------

export function demoDecisionItems(now = Date.now()): DecisionItem[] {
  const m = (mins: number) => now - mins * 60_000;
  return [
    { id: "ny-00000000000000000001", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "demo-desk-ld", asker: { id: "demo-desk-ld", title: "Desk · Lead 2", live: true }, ask: "Make Decision Desk the default Normal landing page?", decides: "Sets whether opening the app lands on Decision Desk or Project Overview", lean: "Yes, default landing + sidebar entry", alts: ["Sidebar entry only"], kind: "yesno", structured: true, ts: m(95) },
    { id: "ny-00000000000000000002", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "ade", askerId: "demo-ade-ld", asker: { id: "demo-ade-ld", title: "ADE · Lead 1", live: true }, ask: "Merge URL history cleanup into master now?", decides: "Ships U1+U2 Back/Forward fixes ahead of the next beta cut", lean: "Merge after green suite", alts: ["Hold for D4 bundle"], kind: "yesno", structured: true, ts: m(82) },
    { id: "ny-00000000000000000003", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "bug", askerId: "demo-bug-ld", asker: { id: "demo-bug-ld", title: "Bugs · Lead 1", live: true }, ask: "Which default timeout (ms) should idle worker health checks use?", decides: "Controls when quiet workers flip to stalled in the sidebar", lean: "", alts: [], kind: "answer", structured: true, ts: m(74) },
    { id: "ny-00000000000000000004", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "release-desk", askerId: "demo-rel-ld", asker: { id: "demo-rel-ld", title: "Release · Lead 1", live: true }, ask: "Sign and publish v1.14.2 beta to the desktop updater", decides: "Pushes the signed installer to beta testers", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(66) },
    { id: "ny-00000000000000000005", source: "log", squad: "efi", squadName: "Main Game Project", lane: "quests", askerId: "demo-q-ld", asker: { id: "demo-q-ld", title: "Quests · Lead 3", live: true }, ask: "Keep daily bounty resets at 00:00 UTC or align to server midnight?", decides: "Changes quest rollover timing for all players", lean: "Keep 00:00 UTC", alts: ["Align to server local midnight", "Rolling 24h per player"], kind: "yesno", structured: true, ts: m(58) },
    { id: "ny-00000000000000000006", source: "log", squad: "efi", squadName: "Main Game Project", lane: "combat", askerId: "demo-c-ld", asker: { id: "demo-c-ld", title: "Combat · Lead 1", live: true }, ask: "Drop legacy parry buffer window from 180ms to 120ms?", decides: "Tightens parry timing across melee weapons", lean: "Drop to 120ms", alts: ["Try 150ms first"], kind: "yesno", structured: true, inferred: true, ts: m(49) },
    { id: "ny-00000000000000000007", source: "log", squad: "efi", squadName: "Main Game Project", lane: "world", askerId: "demo-w-ld", asker: { id: "demo-w-ld", title: "World · Lead 2", live: true }, ask: "What max player cap should the harbor zone use for stress tests?", decides: "Sets the bot spawn count in the harbor benchmark", lean: "", alts: [], kind: "answer", structured: true, ts: m(41) },
    { id: "ny-00000000000000000008", source: "log", squad: "efi", squadName: "Main Game Project", lane: "audio", askerId: "demo-a-ld", asker: { id: "demo-a-ld", title: "Audio · Lead 1", live: true }, ask: "Playtest the rain reverb mix on studio headphones", decides: "Unblocks final mastering of ambient weather stems", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(34) },
    { id: "ny-00000000000000000009", source: "log", squad: "studio-tools", squadName: "Studio Tools", lane: "exporter", askerId: "demo-ex-ld", asker: { id: "demo-ex-ld", title: "Exporter · Lead 1", live: true }, ask: "Switch sprite atlas packing from shelf to maxrects?", decides: "Cuts atlas VRAM by ~18% and regenerates sprite manifests", lean: "Switch to maxrects", alts: ["Keep shelf packer"], kind: "yesno", structured: true, sourceIds: ["ny-00000000000000000009", "ny-00000000000000000019"], groupSize: 2, ts: m(27) },
    { id: "ny-00000000000000000010", source: "log", squad: "studio-tools", squadName: "Studio Tools", lane: "importer", askerId: "demo-im-ld", asker: { id: "demo-im-ld", title: "Importer · Lead 1", live: true }, ask: "Allow non-power-of-two textures in dev builds?", decides: "Relaxes asset import validation outside release builds", lean: "Warn in dev, error in release", alts: ["Error everywhere"], kind: "yesno", structured: true, ts: m(19) },
    { id: "ny-00000000000000000011", source: "log", squad: "studio-tools", squadName: "Studio Tools", lane: "ci", askerId: "demo-ci-ld", asker: { id: "demo-ci-ld", title: "CI · Lead 1", live: true }, ask: "Which artifact retention window (days) do we want for nightly builds?", decides: "Sets storage cleanup policy on the build bucket", lean: "", alts: [], kind: "answer", structured: true, ts: m(12) },
    { id: "ny-00000000000000000012", source: "log", squad: "studio-tools", squadName: "Studio Tools", lane: "billing", askerId: "demo-bi-ld", asker: { id: "demo-bi-ld", title: "Billing · Lead 1", live: true }, ask: "Approve the $20/mo build-cache storage upgrade", decides: "Increases remote cache quota for CI runners", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(6) },
  ];
}

// ---- Shared decision feed store (keeps sidebar `Decisions · N` badge synced with the page) ----

type DecisionStoreState = {
  items: DecisionItem[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  demoFallback: boolean;
};

let storeState: DecisionStoreState = { items: [], loaded: false, loading: false, error: null, demoFallback: false };
const storeSubs = new Set<() => void>();
let inFlightFetch: Promise<void> | null = null;

function setStore(next: Partial<DecisionStoreState>) {
  storeState = { ...storeState, ...next };
  for (const f of storeSubs) f();
}

const subscribeStore = (f: () => void) => {
  storeSubs.add(f);
  return () => void storeSubs.delete(f);
};

export function resetDecisionStoreForTest() {
  storeState = { items: [], loaded: false, loading: false, error: null, demoFallback: false };
  inFlightFetch = null;
  filterOverrides = null;
}

export async function refreshDecisions(): Promise<void> {
  if (inFlightFetch) return inFlightFetch;
  if (typeof fetch !== "function") return;
  setStore({ loading: true });
  inFlightFetch = (async () => {
    try {
      const res = await fetch("/__vibesquad/decisions", { headers: { accept: "application/json" } });
      if (!res.ok) {
        if (DEMO) {
          setStore({
            items: storeState.demoFallback ? storeState.items : demoDecisionItems(),
            loaded: true,
            loading: false,
            error: null,
            demoFallback: true,
          });
          return;
        }
        const body = await res.json().catch(() => ({}));
        setStore({ loaded: true, loading: false, error: body?.error || `Could not load decisions (${res.status})` });
        return;
      }
      const data = await res.json();
      const items = Array.isArray(data?.items) ? (data.items as DecisionItem[]) : [];
      setStore({ items, loaded: true, loading: false, error: null, demoFallback: false });
    } catch (e) {
      if (DEMO) {
        setStore({
          items: storeState.demoFallback ? storeState.items : demoDecisionItems(),
          loaded: true,
          loading: false,
          error: null,
          demoFallback: true,
        });
      } else {
        setStore({ loaded: true, loading: false, error: String((e as Error)?.message ?? e) });
      }
    } finally {
      inFlightFetch = null;
    }
  })();
  return inFlightFetch;
}

let decisionViewOpen = false;
const decisionViewSubs = new Set<() => void>();
export function setBoringDecisionView(open: boolean) {
  if (open === decisionViewOpen) return;
  decisionViewOpen = open;
  for (const f of decisionViewSubs) f();
}
const subscribeDecisionView = (f: () => void) => {
  decisionViewSubs.add(f);
  return () => void decisionViewSubs.delete(f);
};
export const getBoringDecisionView = () => decisionViewOpen;
export const useBoringDecisionView = () => useSyncExternalStore(subscribeDecisionView, getBoringDecisionView, () => false);

const EMPTY_OVERRIDES: DecisionFilterOverrides = {};
let filterOverrides: DecisionFilterOverrides | null = null;
const filterSubs = new Set<() => void>();
function getFilterOverrides(): DecisionFilterOverrides {
  if (filterOverrides === null) filterOverrides = readDecisionFilterOverrides();
  return filterOverrides;
}
function setFilterOverrides(next: DecisionFilterOverrides) {
  filterOverrides = next;
  writeDecisionFilterOverrides(next);
  for (const f of filterSubs) f();
}
const subscribeFilterOverrides = (f: () => void) => {
  filterSubs.add(f);
  return () => void filterSubs.delete(f);
};

/** Sidebar hook: subscribes to the filtered open decision count and keeps it fresh in the background. */
export function useDecisionCount(views: readonly TeamView[] = [], folders: readonly FolderDef[] = []): number {
  const s = useSyncExternalStore(subscribeStore, () => storeState, () => storeState);
  const overrides = useSyncExternalStore(subscribeFilterOverrides, getFilterOverrides, () => EMPTY_OVERRIDES);
  useEffect(() => {
    void refreshDecisions();
    if (typeof window === "undefined") return;
    const h = window.setInterval(() => void refreshDecisions(), 15_000);
    return () => window.clearInterval(h);
  }, []);
  return useMemo(() => countVisibleDecisions(views, folders, s.items, overrides), [views, folders, s.items, overrides]);
}

async function dispatchAnswerBatch(batch: AnswerPayloadItem[]): Promise<{ ok: boolean; results: AnswerResultItem[]; error?: string }> {
  if (storeState.demoFallback) {
    const closed = new Set(batch.map((b) => b.id));
    setStore({ items: storeState.items.filter((i) => !closed.has(i.id)) });
    return { ok: true, results: batch.map((b) => ({ id: b.id, choice: b.choice, status: b.choice === "dismiss" ? "dismissed" : "delivered" })) };
  }
  const res = await fetch("/__vibesquad/decisions/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: batch }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, results: [], error: body?.error || `Answer request failed (${res.status})` };
  const results = Array.isArray(body?.results) ? (body.results as AnswerResultItem[]) : [];
  const closed = new Set(results.filter((r) => r.status === "delivered" || r.status === "dismissed" || r.already).map((r) => r.id));
  if (closed.size > 0) setStore({ items: storeState.items.filter((i) => !closed.has(i.id)) });
  return { ok: Boolean(body?.ok), results };
}

// ---- Component --------------------------------------------------------------------------------

type PendingSend = {
  batch: AnswerPayloadItem[];
  deadline: number;
  remainingSec: number;
};

export function BoringDecisionDesk({
  views,
  folders = [],
  now,
  onOpenAgent,
  onOpenProject,
  undoMs = DECISION_UNDO_MS,
}: {
  views: TeamView[];
  folders?: FolderDef[];
  now: number;
  onOpenAgent?: (view: TeamView, agentId: string) => void;
  onOpenProject?: (teamId: string) => void;
  undoMs?: number;
}) {
  const store = useSyncExternalStore(subscribeStore, () => storeState, () => storeState);
  const overrides = useSyncExternalStore(subscribeFilterOverrides, getFilterOverrides, () => EMPTY_OVERRIDES);
  const [staged, setStaged] = useState<Record<string, StagedChoice>>({});
  const [logsByTeam, setLogsByTeam] = useState<Record<string, FeedEntry[]>>({});
  const [logRev, setLogRev] = useState(0);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const wide = useWideRail();
  const [quietOpen, setQuietOpen] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const teamKey = views.map((v) => v.team.id).join("|");

  // Load decisions on mount and publish the active Decision Desk view for App's URL sync (?view=decisions).
  useEffect(() => {
    setBoringDecisionView(true);
    void refreshDecisions();
    return () => setBoringDecisionView(false);
  }, []);

  // Load per-Squad logs for the live status strip (refetches when logRev bumps after sending).
  useEffect(() => {
    if (typeof fetch !== "function" || views.length === 0) return;
    let live = true;
    void Promise.all(
      views.map(async (v) => {
        try {
          const res = await fetch(`/__vibesquad/log?team=${encodeURIComponent(v.team.id)}`);
          if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows)) return [v.team.id, rows as FeedEntry[]] as const;
          }
        } catch {}
        return [v.team.id, DEMO ? demoLog() : []] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      const next: Record<string, FeedEntry[]> = {};
      for (const [id, rows] of pairs) next[id] = rows;
      setLogsByTeam(next);
    });
    return () => { live = false; };
  }, [teamKey, logRev]);

  // Clean up timers on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  const updateOverrides = (next: DecisionFilterOverrides) => {
    setFilterOverrides(next);
  };

  const pills = useMemo(() => buildDecisionPills(views, folders, store.items, overrides), [views, folders, store.items, overrides]);
  const presetState = useMemo(() => decisionFilterPresetState(pills.all), [pills.all]);
  const visibleIds = useMemo(() => visibleSquadIds(pills.all), [pills.all]);
  const visibleItems = useMemo(() => filterDecisionItems(store.items, visibleIds), [store.items, visibleIds]);
  const visibleViews = useMemo(() => views.filter((v) => visibleIds.has(v.team.id.toLowerCase())), [views, visibleIds]);

  const statusGroups = useMemo(() => buildStatusStrip(visibleViews, logsByTeam, now, visibleItems), [visibleViews, logsByTeam, now, visibleItems]);
  const offscreenItems = useMemo(() => visibleItems.filter((i) => classifyDecisionRow(i) === "offscreen"), [visibleItems]);
  const feedItems = useMemo(() => visibleItems.filter((i) => classifyDecisionRow(i) !== "offscreen"), [visibleItems]);
  const squadFeed = useMemo(() => groupFeedBySquad(feedItems), [feedItems]);
  const stripGroups = useMemo(() => orderStripLikeFeed(statusGroups, squadFeed), [statusGroups, squadFeed]);
  const batch = useMemo(() => buildAnswerBatch(visibleItems, staged), [visibleItems, staged]);
  const hiddenStagedCount = useMemo(() => countHiddenStaged(store.items, visibleIds, staged), [store.items, visibleIds, staged]);
  const unstagedLeanIds = useMemo(
    () => feedItems.filter((i) => classifyDecisionRow(i) === "yesno" && Boolean(i.lean) && !staged[i.id]).map((i) => i.id),
    [feedItems, staged],
  );

  // Option (a) of UX R37 M1: auto-stage each lean once when its card first arrives (the owner can still toggle it off).
  const autoLeaned = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (DECISION_LEANS_OPT_IN) return;
    const fresh = feedItems.filter((i) => classifyDecisionRow(i) === "yesno" && Boolean(i.lean) && !autoLeaned.current.has(i.id));
    if (fresh.length === 0) return;
    for (const i of fresh) autoLeaned.current.add(i.id);
    setStaged((cur) => {
      const next = { ...cur };
      for (const i of fresh) if (!next[i.id]) next[i.id] = { choice: "lean" };
      return next;
    });
  }, [feedItems]);

  const cancelPending = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setPending(null);
  };

  const toggleChoice = (id: string, next: StagedChoice) => {
    if (pending || sending) return;
    setBanner(null);
    setStaged((cur) => {
      const prev = cur[id];
      if (prev && prev.choice === next.choice && (prev.choice !== "reply" || (next.choice === "reply" && prev.text === next.text))) {
        const copy = { ...cur };
        delete copy[id];
        return copy;
      }
      return { ...cur, [id]: next };
    });
  };

  const setReplyText = (id: string, text: string) => {
    if (pending || sending) return;
    setBanner(null);
    setStaged((cur) => {
      if (!text.trim()) {
        if (!(id in cur)) return cur;
        const copy = { ...cur };
        delete copy[id];
        return copy;
      }
      return { ...cur, [id]: { choice: "reply", text } };
    });
  };

  const stageAllLeans = () => {
    if (pending || sending || unstagedLeanIds.length === 0) return;
    setBanner(null);
    setStaged((cur) => {
      const next = { ...cur };
      for (const id of unstagedLeanIds) next[id] = { choice: "lean" };
      return next;
    });
  };

  const executeBatch = async (toSend: AnswerPayloadItem[]) => {
    cancelPending();
    setSending(true);
    setBanner(null);
    try {
      const res = await dispatchAnswerBatch(toSend);
      if (res.error) {
        setBanner({ tone: "err", text: res.error });
        return;
      }
      const nextErrs: Record<string, string> = {};
      const succeeded = new Set<string>();
      for (const r of res.results) {
        if (r.status === "delivered" || r.status === "dismissed" || r.already) succeeded.add(r.id);
        else nextErrs[r.id] = r.error || "Delivery failed";
      }
      setRowErrors(nextErrs);
      setStaged((cur) => {
        const copy = { ...cur };
        for (const id of succeeded) delete copy[id];
        return copy;
      });
      const okCount = res.results.filter((r) => r.status === "delivered" || r.status === "dismissed").length;
      const failCount = Object.keys(nextErrs).length;
      if (failCount > 0) setBanner({ tone: "err", text: `Sent ${okCount}; ${failCount} failed (kept open below).` });
      else setBanner({ tone: "ok", text: `Sent ${okCount} ${okCount === 1 ? "answer" : "answers"}.` });
      await refreshDecisions();
      setLogRev((n) => n + 1);
    } finally {
      setSending(false);
    }
  };

  const startSend = () => {
    if (batch.length === 0 || sending || pending) return;
    const toSend = [...batch];
    const deadline = Date.now() + undoMs;
    setBanner(null);
    setPending({ batch: toSend, deadline, remainingSec: Math.max(1, Math.ceil(undoMs / 1000)) });
    tickRef.current = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      setPending((p) => (p ? { ...p, remainingSec: Math.max(1, Math.ceil(left / 1000)) } : null));
    }, 250);
    timerRef.current = setTimeout(() => {
      void executeBatch(toSend);
    }, undoMs);
  };

  const openAsker = (item: DecisionItem) => {
    if (!onOpenAgent || !item.asker?.id) return;
    const v = views.find((x) => x.team.id.toLowerCase() === item.squad.toLowerCase());
    if (v) onOpenAgent(v, item.asker.id);
  };

  const jumpToOffscreen = () => document.querySelector('[data-testid="boring-decision-offscreen"]')?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  const offscreenCount = offscreenItems.length;
  const stripRef = useRef<HTMLElement | null>(null);
  const stripLaneCount = stripGroups.reduce((n, g) => n + g.lanes.length, 0);
  const [stripScrollMore, setStripScrollMore] = useState(false);
  const updateStripScroll = () => {
    const el = stripRef.current;
    if (!el || wide) {
      setStripScrollMore(false);
      return;
    }
    setStripScrollMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  };
  useEffect(() => {
    updateStripScroll();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(updateStripScroll) : 0;
    const onResize = () => updateStripScroll();
    if (typeof window !== "undefined") window.addEventListener("resize", onResize);
    const el = stripRef.current;
    const ro = typeof ResizeObserver === "function" && el ? new ResizeObserver(updateStripScroll) : null;
    if (ro && el) {
      ro.observe(el);
      // Also watch the inner content: lane add/remove without a group-count change resizes it, not the capped box.
      const inner = el.querySelector(".boring-decision-strip-groups");
      if (inner) ro.observe(inner);
    }
    return () => {
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [wide, stripGroups.length, stripLaneCount, quietOpen]);
  const leadStateLabel = (l: StatusLaneLine) => {
    const s = l.leadState;
    if (l.openDecisions > 0 && (s === "idle" || s === "none" || s === "running")) return `waiting · ${l.openDecisions}`;
    return leadStateLabelRaw(s);
  };
  const leadStateLabelRaw = (s: StatusLaneLine["leadState"]) =>
    s === "running" ? "running" : s === "needs-you" ? "needs you" : s === "error" ? "error" : s === "idle" ? "idle" : "no lead";

  return (
    <div className={`boring-decision-desk${wide ? " is-wide" : ""}`} data-testid="boring-decision-desk">
      <header className="boring-decision-head">
        <span className="boring-decision-sub" title="Open decisions = shown in the feed here + off-screen items below">
          <span data-testid="boring-decision-summary">
            {visibleItems.length === 0 && store.items.length > 0 ? "0 open in selected projects" : decisionSummary(visibleItems)}
          </span>
          {offscreenCount > 0 && (
            <button type="button" className="boring-decision-offscreen-link" data-testid="boring-decision-offscreen-link" onClick={jumpToOffscreen}>
              jump to off-screen
            </button>
          )}
        </span>
        <button type="button" className="boring-decision-refresh" data-testid="boring-decision-refresh" disabled={store.loading} onClick={() => { void refreshDecisions(); setLogRev((n) => n + 1); }}>
          {store.loading ? "Refreshing…" : "Refresh"}
        </button>
        {pills.all.length > 0 && (
          <div className="boring-decision-pills" data-testid="boring-decision-pills" role="region" aria-label="Filter by project">
            <div className="boring-decision-pill-presets">
              <button
                type="button"
                className={`boring-decision-pill-preset${presetState.isActivePreset ? " on" : ""}`}
                data-testid="boring-decision-preset-active"
                aria-pressed={presetState.isActivePreset}
                onClick={() => updateOverrides(applyActivePreset())}
              >
                Active
              </button>
              <button
                type="button"
                className={`boring-decision-pill-preset${presetState.isAllPreset ? " on" : ""}`}
                data-testid="boring-decision-preset-all"
                aria-pressed={presetState.isAllPreset}
                onClick={() => updateOverrides(applyAllPreset(pills.all))}
              >
                All
              </button>
            </div>
            {pills.awake.length > 0 && (
              <div className="boring-decision-pill-group" data-testid="boring-decision-pills-awake">
                {pills.awake.map((p) => (
                  <button
                    key={p.squadId}
                    type="button"
                    className={`boring-decision-pill${p.active ? " on" : ""}`}
                    data-testid={`boring-decision-pill-${p.squadId}`}
                    aria-pressed={p.active}
                    aria-label={`${p.squadName}, ${p.openCount} open`}
                    onClick={() => updateOverrides(toggleDecisionPill(overrides, p.squadId, p.asleep))}
                  >
                    <span className="boring-decision-pill-name">{p.squadName}</span>
                    <span className="boring-decision-pill-count">{p.openCount}</span>
                  </button>
                ))}
              </div>
            )}
            {pills.onHold.length > 0 && (
              <div className="boring-decision-pill-group is-on-hold" data-testid="boring-decision-pills-on-hold">
                <span className="boring-decision-pill-group-label" title="In an asleep folder. Click a pill to show anyway.">Asleep</span>
                {pills.onHold.map((p) => (
                  <button
                    key={p.squadId}
                    type="button"
                    className={`boring-decision-pill is-asleep${p.active ? " on" : ""}`}
                    data-testid={`boring-decision-pill-${p.squadId}`}
                    data-asleep="true"
                    aria-pressed={p.active}
                    aria-label={`${p.squadName}, ${p.openCount} open`}
                    title="In an asleep folder. Click to show anyway."
                    onClick={() => updateOverrides(toggleDecisionPill(overrides, p.squadId, p.asleep))}
                  >
                    <span className="boring-decision-pill-name">{p.squadName}</span>
                    <span className="boring-decision-pill-count">{p.openCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      {store.error && (
        <div className="boring-decision-alert err" role="alert" data-testid="boring-decision-error">
          {store.error}
        </div>
      )}

      {/* 1. Decision Feed: grouped by Squad, oldest first (comes first in stacked layout < 1900px; left column in .is-wide) */}
      <section className="boring-decision-feed" data-testid="boring-decision-feed" aria-label="Decision feed">
        <div className="boring-decision-section-head">
          <h2 className="boring-decision-section-title">Decisions</h2>
          <span className="boring-decision-section-meta">Oldest first · {feedItems.length}</span>
        </div>
        {feedItems.length === 0 && offscreenItems.length === 0 && store.loaded && (
          <div className="boring-decision-empty" data-testid="boring-decision-empty">
            {store.items.length > 0 ? (
              <>
                <span>
                  {`No open decisions in the selected projects (${store.items.length} ${store.items.length === 1 ? "item" : "items"} hidden by the filter).`}
                </span>
                <button
                  type="button"
                  className="boring-decision-pill-preset"
                  data-testid="boring-decision-empty-show-all"
                  onClick={() => updateOverrides(applyAllPreset(pills.all))}
                >
                  Show all
                </button>
              </>
            ) : (
              "No open decisions right now. Lanes are running on their own."
            )}
          </div>
        )}
        {squadFeed.map((grp) => (
          <div key={grp.squad} className="boring-decision-squad-group" data-testid={`boring-decision-squad-${grp.squad}`}>
            <div className="boring-decision-squad-label">
              <span>{grp.squadName}</span>
              <span className="boring-decision-squad-count">{grp.items.length}</span>
            </div>
            <div className="boring-decision-cards">
              {grp.items.map((item) => {
                const rowType = classifyDecisionRow(item);
                const sel = staged[item.id];
                const isStaged = Boolean(sel);
                const age = formatAge(item.ts, now);
                const askerLabel = item.asker?.title ? cleanTitle(item.asker.title) : item.askerId || "";
                const groupCount = item.groupSize && item.groupSize > 1 ? item.groupSize : Array.isArray(item.sourceIds) && item.sourceIds.length > 1 ? item.sourceIds.length : 0;
                const leanStaged = sel?.choice === "lean";
                return (
                  <article
                    key={item.id}
                    className={`boring-decision-card${isStaged ? " staged" : ""}`}
                    data-testid={`boring-decision-card-${item.id}`}
                    data-row-type={rowType}
                  >
                    <div className="boring-decision-card-meta">
                      <span className="boring-decision-lane-pill">{item.lane ? `@${item.lane.replace(/^@/, "")}` : "Desk"}</span>
                      {askerLabel && (
                        <button type="button" className="boring-decision-asker" onClick={() => openAsker(item)}>
                          {askerLabel}
                        </button>
                      )}
                      {item.inferred && (
                        <span className="boring-decision-inferred" data-testid={`boring-decision-inferred-${item.id}`} title="Structured fields inferred from free-text needs-you">
                          inferred
                        </span>
                      )}
                      {groupCount > 0 && (
                        <span className="boring-decision-grouped" data-testid={`boring-decision-grouped-${item.id}`} title={`Covers ${groupCount} grouped asks`}>
                          {`×${groupCount} grouped`}
                        </span>
                      )}
                      {age && <span className="boring-decision-age">{age}</span>}
                    </div>

                    <div className="boring-decision-ask">{item.ask}</div>
                    {item.decides && (
                      <div className="boring-decision-decides">
                        <span className="boring-decision-decides-label">Decides:</span> {item.decides}
                      </div>
                    )}

                    {rowType === "yesno" ? (
                      <div className="boring-decision-choices" role="group" aria-label={`Options for ${item.ask}`}>
                        {item.lean && (
                          <button
                            type="button"
                            className={`boring-decision-choice is-lean${leanStaged ? " selected staged" : " suggested"}`}
                            data-testid={`boring-decision-lean-${item.id}`}
                            aria-pressed={leanStaged}
                            disabled={Boolean(pending) || sending}
                            onClick={() => toggleChoice(item.id, { choice: "lean" })}
                          >
                            <span className="boring-decision-choice-tag">{sel?.choice === "lean" ? "✓ Lean" : "Lean"}</span>
                            <span>{item.lean}</span>
                          </button>
                        )}
                        {(item.alts ?? []).map((alt, idx) => {
                          const key = `alt:${idx}` as const;
                          const on = sel?.choice === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              className={`boring-decision-choice${on ? " selected staged" : ""}`}
                              data-testid={`boring-decision-alt-${item.id}-${idx}`}
                              aria-pressed={on}
                              disabled={Boolean(pending) || sending}
                              onClick={() => toggleChoice(item.id, { choice: key })}
                            >
                              {alt}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className={`boring-decision-choice is-not${sel?.choice === "not" ? " selected staged" : ""}`}
                          data-testid={`boring-decision-not-${item.id}`}
                          aria-pressed={sel?.choice === "not"}
                          disabled={Boolean(pending) || sending}
                          onClick={() => toggleChoice(item.id, { choice: "not" })}
                        >
                          Not that
                        </button>
                      </div>
                    ) : (
                      <div className="boring-decision-answer-row">
                        <input
                          type="text"
                          className="boring-decision-input"
                          data-testid={`boring-decision-input-${item.id}`}
                          aria-label={`Answer for ${item.ask}`}
                          placeholder="One-line answer…"
                          disabled={Boolean(pending) || sending}
                          value={sel?.choice === "reply" ? sel.text : ""}
                          onChange={(e) => setReplyText(item.id, e.target.value)}
                        />
                        <button
                          type="button"
                          className={`boring-decision-dismiss${sel?.choice === "dismiss" ? " staged" : ""}`}
                          data-testid={`boring-decision-dismiss-${item.id}`}
                          disabled={Boolean(pending) || sending}
                          onClick={() => toggleChoice(item.id, { choice: "dismiss" })}
                        >
                          {sel?.choice === "dismiss" ? "✓ Dismiss" : "Dismiss"}
                        </button>
                      </div>
                    )}

                    {rowErrors[item.id] && (
                      <div className="boring-decision-row-err" role="alert">
                        {rowErrors[item.id]}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* 2. Off-screen strip: hands-on test, money/keys, release (follows feed in both stacked & tab order) */}
      {offscreenItems.length > 0 && (
        <section className="boring-decision-offscreen" data-testid="boring-decision-offscreen" aria-label="Off-screen items">
          <div className="boring-decision-section-head">
            <h2 className="boring-decision-section-title">Off-screen · Test, money &amp; release</h2>
            <span className="boring-decision-section-meta">{offscreenItems.length}</span>
          </div>
          <div className="boring-decision-offscreen-list">
            {offscreenItems.map((item) => {
              const sel = staged[item.id];
              const age = formatAge(item.ts, now);
              return (
                <div
                  key={item.id}
                  className={`boring-decision-offscreen-row${sel ? " staged" : ""}`}
                  data-testid={`boring-decision-offscreen-${item.id}`}
                >
                  <div className="boring-decision-offscreen-main">
                    <div className="boring-decision-card-meta">
                      <span className="boring-decision-offscreen-squad">{item.squadName || item.squad}</span>
                      <span className="boring-decision-lane-pill">{item.lane ? `@${item.lane.replace(/^@/, "")}` : "Desk"}</span>
                      {item.inferred && <span className="boring-decision-inferred">inferred</span>}
                      {age && <span className="boring-decision-age">{age}</span>}
                    </div>
                    <div className="boring-decision-ask">{item.ask}</div>
                    {item.decides && (
                      <div className="boring-decision-decides">
                        <span className="boring-decision-decides-label">Decides:</span> {item.decides}
                      </div>
                    )}
                  </div>
                  <div className="boring-decision-offscreen-actions">
                    <button
                      type="button"
                      className={`boring-decision-choice${sel?.choice === "reply" ? " selected staged" : ""}`}
                      data-testid={`boring-decision-done-${item.id}`}
                      disabled={Boolean(pending) || sending}
                      onClick={() => toggleChoice(item.id, { choice: "reply", text: "Done off-screen" })}
                    >
                      {sel?.choice === "reply" ? "✓ Done" : "Mark done"}
                    </button>
                    <button
                      type="button"
                      className={`boring-decision-dismiss${sel?.choice === "dismiss" ? " staged" : ""}`}
                      data-testid={`boring-decision-dismiss-${item.id}`}
                      disabled={Boolean(pending) || sending}
                      onClick={() => toggleChoice(item.id, { choice: "dismiss" })}
                    >
                      {sel?.choice === "dismiss" ? "✓ Dismiss" : "Dismiss"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Live Status Strip: one line per lane, grouped by Squad (after off-screen & scroll-capped < 1900px; right rail in .is-wide) */}
      <section
        ref={stripRef}
        className={`boring-decision-strip${!wide && stripScrollMore ? " has-scroll-more" : ""}`}
        data-testid="boring-decision-strip"
        data-scroll-more={!wide && stripScrollMore ? "true" : undefined}
        onScroll={updateStripScroll}
        aria-label="Squad status"
      >
        <div className="boring-decision-section-head">
          <h2 className="boring-decision-section-title">Live Status</h2>
          <span className="boring-decision-section-meta">{statusGroups.reduce((n, g) => n + g.lanes.length, 0)} lanes</span>
        </div>
        <div className="boring-decision-strip-groups">
          {stripGroups.map((g) => (
            <div key={g.squadId} className="boring-decision-strip-squad" data-testid={`boring-decision-strip-squad-${g.squadId}`}>
              <button type="button" className="boring-decision-strip-squad-btn" onClick={() => onOpenProject?.(g.squadId)}>
                {g.squadName}
              </button>
              <div className="boring-decision-strip-lanes">
                {(() => {
                  const { shown, quiet } = splitQuietLanes(g.lanes, now);
                  const open = Boolean(quietOpen[g.squadId]);
                  const lines = open ? [...shown, ...quiet] : shown;
                  return (
                    <>
                      {lines.map((lane) => {
                        const waiting = lane.openDecisions > 0 && (lane.leadState === "idle" || lane.leadState === "none" || lane.leadState === "running");
                        const stClass = waiting ? "needs-you" : lane.leadState;
                        return (
                          <button
                            key={lane.key}
                            type="button"
                            className="boring-decision-strip-line"
                            data-testid={`boring-decision-strip-lane-${g.squadId}-${lane.laneId}`}
                            onClick={() => (lane.openAgentId && onOpenAgent ? onOpenAgent(g.view, lane.openAgentId) : onOpenProject?.(g.squadId))}
                          >
                            <span className={`boring-decision-dot st-${stClass}`} aria-hidden="true" />
                            <span className="boring-decision-strip-lane-name">{lane.label}</span>
                            <span className="boring-decision-code-slot">{lane.code ? <code className="boring-decision-code" title={lane.code}>{lane.code}</code> : null}</span>
                            <span className={`boring-decision-strip-state st-${stClass}`}>{leadStateLabel(lane)}</span>
                            <span className="boring-decision-strip-event" title={lane.lastEvent || undefined}>
                              {lane.lastEvent ? (
                                <>
                                  {lane.lastEventType && <span className="boring-decision-ev-tag">{lane.lastEventType}</span>}
                                  <span>{lane.lastEvent}</span>
                                </>
                              ) : (
                                <span className="boring-decision-muted">No recent done/decision</span>
                              )}
                            </span>
                            {lane.age && <span className="boring-decision-age">{lane.age}</span>}
                          </button>
                        );
                      })}
                      {quiet.length > 0 && (
                        <button
                          type="button"
                          className="boring-decision-quiet-btn"
                          data-testid={`boring-decision-strip-quiet-${g.squadId}`}
                          aria-expanded={open}
                          title={open ? "Fold quiet lanes" : `${quiet.map((q) => q.label).join(", ")}: idle, no event in the last 2h`}
                          onClick={() => setQuietOpen((cur) => ({ ...cur, [g.squadId]: !cur[g.squadId] }))}
                        >
                          {open ? `− hide ${quiet.length} quiet` : `+${quiet.length} quiet`}
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
        {!wide && <div className="boring-decision-strip-fade" data-testid="boring-decision-strip-fade" aria-hidden="true" />}
      </section>

      {/* 4. Sticky batch Send bar with 5s Undo */}
      <footer className="boring-decision-bar" data-testid="boring-decision-bar">
        <div className="boring-decision-bar-status" role="status" aria-live="polite">
          {pending ? (
            <span className="boring-decision-undo-msg" data-testid="boring-decision-undo-msg">
              {`Sending ${pending.batch.length} ${pending.batch.length === 1 ? "answer" : "answers"} in ${pending.remainingSec}s…`}
            </span>
          ) : banner ? (
            <span className={`boring-decision-banner ${banner.tone}`} data-testid="boring-decision-banner">
              {banner.text}
            </span>
          ) : (
            <span className="boring-decision-bar-hint">
              {batch.length > 0
                ? `${batch.length} ready to send${unstagedLeanIds.length > 0 ? ` · ${unstagedLeanIds.length} ${unstagedLeanIds.length === 1 ? "lean" : "leans"} not included` : ""}`
                : unstagedLeanIds.length > 0
                  ? `${unstagedLeanIds.length} ${unstagedLeanIds.length === 1 ? "lean" : "leans"} not included. Tap a lean, pick an option, or type an answer.`
                  : "Pick an option or type an answer to queue a batch."}
            </span>
          )}
        </div>
        <div className="boring-decision-bar-actions">
          {pending ? (
            <>
              <button type="button" className="boring-decision-undo-btn" data-testid="boring-decision-undo-btn" onClick={cancelPending}>
                Undo
              </button>
              <button type="button" className="boring-decision-send-btn" data-testid="boring-decision-send-now-btn" onClick={() => void executeBatch(pending.batch)}>
                Send now
              </button>
            </>
          ) : (
            <>
              {unstagedLeanIds.length > 0 && (
                <button type="button" className="boring-decision-leans-btn" data-testid="boring-decision-stage-leans" disabled={sending} onClick={stageAllLeans}>
                  {`Use all leans (${unstagedLeanIds.length})`}
                </button>
              )}
              <button
                type="button"
                className="boring-decision-send-btn"
                data-testid="boring-decision-send-btn"
                disabled={batch.length === 0 || sending}
                onClick={startSend}
              >
                {sending
                  ? "Sending…"
                  : `Send ${batch.length} ${batch.length === 1 ? "answer" : "answers"}${hiddenStagedCount > 0 ? ` (+${hiddenStagedCount} hidden)` : ""}`}
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
