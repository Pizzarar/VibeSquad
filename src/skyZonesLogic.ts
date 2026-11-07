// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): the pure zone→agent mapping. RiffBot is the hub Buddy (left),
// the Overlord is the hub lead (right). No React here so it is unit-testable under node.
import { hubPinForSquad, type Pin } from "./pins.ts";
import { poseFor, type FaceBot, type Pose } from "./squadFloorLogic.ts";
import type { Member, TeamView } from "./teams.ts";

export type SkyZone = {
  bot: FaceBot;
  /** The live agent behind the zone, or null (RiffBot not started / no Overlord on duty). */
  member: Member | null;
  agentId: string | null;
  /** Face pose input for faceMode(); an absent agent reads as idle. */
  pose: Pose | null;
};

export type SkyZones = { hub: Pin | null; riffbot: SkyZone; overlord: SkyZone };

const zoneOf = (bot: FaceBot, member: Member | null): SkyZone => ({
  bot,
  member,
  agentId: member?.agent.id ?? null,
  pose: member ? poseFor(member) : null,
});

/** Left zone = hub Buddy (RiffBot), right zone = hub lead (Overlord). Never the same agent twice. */
export function skyZonesFor(view: TeamView | null | undefined): SkyZones {
  const hub = hubPinForSquad(view);
  const riffbot = hub?.brainstorm ?? null;
  const overlord = hub?.lead && hub.lead.agent.id !== riffbot?.agent.id ? hub.lead : null;
  return { hub, riffbot: zoneOf("riffbot", riffbot), overlord: zoneOf("overlord", overlord) };
}

/** Agent ids the sky zones own; the hub page shows the normal focus view for any other agent. */
export function skyZoneIds(zones: SkyZones): string[] {
  return [zones.riffbot.agentId, zones.overlord.agentId].filter((id): id is string => !!id);
}

export type OverlordState = "live" | "none";
export const overlordState = (zones: SkyZones): OverlordState => (zones.overlord.member ? "live" : "none");
export const NO_OVERLORD_TEXT = "no Overlord on duty";
