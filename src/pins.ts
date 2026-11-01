// Pinned teams (docs/PLAN_PINNED_FEATURES.md): the team (a lane in teams.json) is the place the owner
// clicks; its Brainstorm, Lead and Workers are swappable occupants behind it.
// This file is the shared contract for the pinned-team UI. Keep it pure (no fetch, no React):
// steps 1 (sidebar + grid), 2 (focus rail) and 3 (resolver + quick start) all build on it.
import type { LaneDef, Member, TeamDef, TeamView } from "./teams.ts";
import { brainstormUsedTokens } from "./teams.ts";

export type PinState = "pinned" | "done";

/** Extra lane fields stored in teams.json. Lanes without `state` count as pinned. */
export type PinFields = {
  state?: PinState;
  /** ISO time the team was marked complete. */
  doneAt?: string;
  /** Fixed sort order inside the squad; falls back to teams.json order. */
  order?: number;
  /** Profile name of the last Brainstorm, reused when the pin quick-starts. */
  lastProfile?: string;
};

export type PinLane = LaneDef & PinFields;

export type Pin = {
  squad: TeamDef;
  lane: PinLane;
  state: PinState;
  order: number;
  /** The live main Brainstorm, or null when the pin has to quick-start one. */
  brainstorm: Member | null;
  /** The live lead, or null. */
  lead: Member | null;
  /** Live workers (not retired, not archived). */
  workers: Member[];
  needsYou: number;
  running: number;
  /** Context tokens used by the live Brainstorm (0 when none). */
  contextUsed: number;
};

export type PinResolution =
  | { kind: "live"; agent: Member }
  | { kind: "quick-start"; squadId: string; laneId: string; profile: string | null; briefPath: string };

/** Lane briefs live in the VibeSquad repo for every squad (server/brainstorm.mjs reads them there). */
export const briefPathFor = (laneId: string): string => `docs/brainstorm/${laneId}.md`;

export const pinStateOf = (lane: LaneDef): PinState => ((lane as PinLane).state === "done" ? "done" : "pinned");

const isLive = (m: Member | null | undefined): m is Member =>
  Boolean(m) && !m!.agent.archivedAt && m!.agent.status !== "closed";

const live = (ms: Member[]) => ms.filter(isLive);

/** Build the pins for one squad. Pins are ordered by `order`, then by teams.json order. The "_other" bucket is never a pin. */
export function pinsForSquad(view: TeamView): { pinned: Pin[]; done: Pin[] } {
  const pins = view.lanes
    .filter((l) => l.lane.id !== "_other")
    .map((l, i): Pin => {
      const lane = l.lane as PinLane;
      const brainstorm = isLive(l.brainstorm) ? l.brainstorm : null;
      const workers = live(l.members.filter((m) => m.kind === "worker"));
      return {
        squad: view.team,
        lane,
        state: pinStateOf(lane),
        order: lane.order ?? i,
        brainstorm,
        lead: isLive(l.lead) ? l.lead : null,
        workers,
        needsYou: l.members.filter((m) => m.attention && m.attention.tone !== "finished" && m.kind !== "old-lead").length,
        running: l.members.filter((m) => m.agent.status === "running").length,
        contextUsed: brainstorm ? brainstormUsedTokens(brainstorm.agent) : 0,
      };
    })
    .sort((a, b) => a.order - b.order);
  return { pinned: pins.filter((p) => p.state === "pinned"), done: pins.filter((p) => p.state === "done") };
}

/** Decide what clicking a pin does: open the live Brainstorm, or quick-start one from the brief. */
export function resolvePin(pin: Pin): PinResolution {
  if (pin.brainstorm) return { kind: "live", agent: pin.brainstorm };
  return {
    kind: "quick-start",
    squadId: pin.squad.id,
    laneId: pin.lane.id,
    profile: pin.lane.lastProfile ?? null,
    briefPath: briefPathFor(pin.lane.id),
  };
}

/** Returns a copy of the squad list with one lane's pin fields patched (for saveTeams). */
export function patchLane(teams: TeamDef[], squadId: string, laneId: string, patch: Partial<PinFields>): TeamDef[] {
  return teams.map((t) =>
    t.id !== squadId ? t : { ...t, lanes: t.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l)) },
  );
}
