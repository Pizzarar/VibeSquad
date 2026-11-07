// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): the pure zone→agent mapping. RiffBot is the hub Buddy (left),
// the Overlord is the hub lead (right). No React here so it is unit-testable under node.
import { dormantBuddyId, hubPinForSquad, type Pin } from "./pins.ts";
import { poseFor, type FaceBot, type Pose } from "./squadFloorLogic.ts";
import type { Member, TeamView } from "./teams.ts";

export type SkyZone = {
  bot: FaceBot;
  /** The live agent behind the zone, or null (RiffBot not started / no Overlord on duty). */
  member: Member | null;
  agentId: string | null;
  /** RiffBot only: a closed Buddy with history. The zone keeps its (read-only) chat and offers Resume instead of the picker. */
  dormant: boolean;
  /** Face pose input for faceMode(); an absent agent reads as idle. */
  pose: Pose | null;
};

export type SkyZones = { hub: Pin | null; riffbot: SkyZone; overlord: SkyZone };

const zoneOf = (bot: FaceBot, member: Member | null, dormant = false): SkyZone => ({
  bot,
  member,
  agentId: member?.agent.id ?? null,
  dormant,
  pose: member && !dormant ? poseFor(member) : null,
});

/** Left zone = hub Buddy (RiffBot), right zone = hub lead (Overlord). Never the same agent twice. */
export function skyZonesFor(view: TeamView | null | undefined): SkyZones {
  const hub = hubPinForSquad(view);
  const riffbot = hub?.brainstorm ?? null;
  const overlord = hub?.lead && hub.lead.agent.id !== riffbot?.agent.id ? hub.lead : null;
  const dormant = !!hub && !!riffbot && dormantBuddyId(hub) === riffbot.agent.id;
  return { hub, riffbot: zoneOf("riffbot", riffbot, dormant), overlord: zoneOf("overlord", overlord) };
}

/** Agent ids the sky zones own; the hub page shows the normal focus view for any other agent. */
export function skyZoneIds(zones: SkyZones): string[] {
  return [zones.riffbot.agentId, zones.overlord.agentId].filter((id): id is string => !!id);
}

export type OverlordState = "live" | "none";
export const overlordState = (zones: SkyZones): OverlordState => (zones.overlord.member ? "live" : "none");
export const NO_OVERLORD_TEXT = "no Overlord on duty";

/** The queue strip in the clouds: a thin cloud-height line while nobody needs you, the full chip row otherwise. */
export type QueueStripState = "empty" | "open";
export const queueStripState = (count: number): QueueStripState => (count > 0 ? "open" : "empty");

// ── G4 asset swap-in: every @art asset is optional; an absent one is skipped (same rule as the `front` overlays) ──
export type SkyTheme = "dark" | "light";
export const SKY_URL = (theme: SkyTheme) => `/office/sky-${theme}.png`;
/** The sky-CRT bezel (transparent screen hole), one per theme. */
export const SKY_FRAME_URL = (theme: SkyTheme) => `/office/sky-crt-${theme}.png`;
/** sky-crt.json: the 9-slice of the sky-CRT bezel PNG (source px), the integer-or-not px scale, and how the edges tile. */
export const SKY_CRT_JSON_URL = "/office/sky-crt.json";
export type SkyCrtRepeat = "stretch" | "round";
export type SkyCrtModel = { slice: { top: number; right: number; bottom: number; left: number }; scale: number; repeat: SkyCrtRepeat };
const posInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
/** Validate sky-crt.json. Slice sides must be positive ints, scale > 0, repeat (optional) stretch|round; anything else → not ok (CSS bezel stays). */
export function validateSkyCrt(json: unknown): { ok: true; value: SkyCrtModel } | { ok: false; error: string } {
  if (!json || typeof json !== "object") return { ok: false, error: "not an object" };
  const { slice, scale, repeat } = json as Record<string, unknown>;
  if (!slice || typeof slice !== "object") return { ok: false, error: "slice missing" };
  const { top, right, bottom, left } = slice as Record<string, unknown>;
  if (!posInt(top) || !posInt(right) || !posInt(bottom) || !posInt(left)) return { ok: false, error: "slice sides must be positive integers" };
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return { ok: false, error: "scale must be > 0" };
  if (repeat !== undefined && repeat !== "stretch" && repeat !== "round") return { ok: false, error: "repeat must be stretch|round" };
  return { ok: true, value: { slice: { top, right, bottom, left }, scale, repeat: repeat ?? "stretch" } };
}
/** json → the zone's border-image style: width = slice × scale per side, slice + `fill`, crisp pixels. */
export function skyCrtStyle(model: SkyCrtModel, url: string): Record<string, string> {
  const { top, right, bottom, left } = model.slice;
  const k = model.scale;
  return {
    borderStyle: "solid",
    borderWidth: `${top * k}px ${right * k}px ${bottom * k}px ${left * k}px`,
    borderImageSource: `url(${url})`,
    borderImageSlice: `${top} ${right} ${bottom} ${left} fill`,
    borderImageRepeat: model.repeat,
    imageRendering: "pixelated",
  };
}

export type SkyAssetOk = { sky: boolean; frame: boolean };
/** URLs to draw: a probe that failed (absent file) yields null, so the CSS gradient sky / CSS bezel stay. The bezel also needs a valid sky-crt.json. */
export function skyAssets(
  theme: SkyTheme,
  ok: SkyAssetOk,
  crt: SkyCrtModel | null = null,
): { skyUrl: string | null; frameUrl: string | null; frameStyle: Record<string, string> | null } {
  const frameUrl = ok.frame && crt ? SKY_FRAME_URL(theme) : null;
  return { skyUrl: ok.sky ? SKY_URL(theme) : null, frameUrl, frameStyle: frameUrl && crt ? skyCrtStyle(crt, frameUrl) : null };
}

/** Crisp face size: the largest integer scale of the faces.json cell that fits `targetH` px (min 1). Cell size always comes from faces.json. */
export function faceScale(cell: { w: number; h: number }, targetH = 144): number {
  return Math.max(1, Math.floor(targetH / Math.max(1, cell.h)));
}
