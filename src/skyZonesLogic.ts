// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): the pure zone→agent mapping. RiffBot is the hub Buddy (left),
// the Overlord is the hub lead (right). No React here so it is unit-testable under node.
import { dormantBuddyId, hubPinForSquad, type Pin } from "./pins.ts";
import { poseFor, type FaceBot, type FaceMode, type FacesModel, type Pose } from "./squadFloorLogic.ts";
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

/**
 * G6-fix2 big face: the largest whole-number scale at which the WHOLE cell fits the box (contain, never crop), centred
 * with whole-px offsets; the gutters on the long axis are filled by the bot's background colour. k is at least 1
 * (a box smaller than one cell is the only case that crops). Returns `k` 0 until the box has a size.
 */
export function faceContain(cell: { w: number; h: number }, box: { w: number; h: number }): { k: number; left: number; top: number } {
  if (!(box.w > 0 && box.h > 0) || !(cell.w > 0 && cell.h > 0)) return { k: 0, left: 0, top: 0 };
  const k = Math.max(1, Math.floor(Math.min(box.w / cell.w, box.h / cell.h)));
  return { k, left: Math.round((box.w - cell.w * k) / 2), top: Math.round((box.h - cell.h * k) / 2) };
}

/** Gutter colour around a contained face: faces.json `<bot>.bg` when valid, else null → the per-theme `--sky-face-bg-*` CSS variable. */
export const faceBg = (faces: FacesModel | null, bot: FaceBot): string | null => faces?.bg?.[bot] ?? null;

/**
 * Smallest width of Riff's squeezed strip: two whole cells of face plus both bezel sides, so the scared face stays at
 * scale >= 2 however narrow the hub column gets. `bezelH` = left+right border widths in px.
 */
export const riffMinWidth = (cell: { w: number }, bezelH: number): number => 2 * cell.w + bezelH;
/** The grid-template-columns value for a layout: Riff never narrower than riffMinWidth while squeezed; the Overlord takes the rest. */
export function skyColumns(layout: SkyLayout, cell: { w: number }, bezelH: number): string {
  const riffMin = layout.expanded ? riffMinWidth(cell, bezelH) : 0;
  return `minmax(${riffMin}px, ${layout.widths.riffbot}fr) minmax(0, ${layout.widths.overlord}fr)`;
}

// ── G6 Overlord expand ────────────────────────────────────────────────────────
/** Share of the sky the Overlord zone takes while it is active (Riff keeps the rest). */
export const OVERLORD_EXPAND_PCT = 70;
export type SkyLayoutInput = {
  /** A live Overlord is on duty; without one nothing ever expands (the static fills its zone). */
  overlordLive: boolean;
  /** Focus (composer focus or a click in its chat) is inside the Overlord zone. */
  overlordFocused: boolean;
  /** The Overlord is running (talking). */
  overlordTalking: boolean;
  /** Focus is inside RiffBot's zone: the person is working with Riff, so a talking Overlord does not squeeze it. */
  riffFocused?: boolean;
  /** faces.json has a `riffbot.scared` mode. */
  riffHasScared: boolean;
};
export type SkyLayout = {
  expanded: boolean;
  /** Grid fractions, RiffBot then Overlord (sum 100). */
  widths: { riffbot: number; overlord: number };
  /** Forced RiffBot face while squeezed: `scared`, or `idle` when faces.json has none; null → the normal talk/needs/blink logic. */
  riffMode: Extract<FaceMode, "scared" | "idle"> | null;
};
/** Overlord active → 70/30 and Riff scared (idle when `scared` is absent); otherwise 50/50. RiffBot activity never expands. */
export function skyLayout(i: SkyLayoutInput): SkyLayout {
  const expanded = i.overlordLive && (i.overlordFocused || (i.overlordTalking && !i.riffFocused));
  return expanded
    ? { expanded, widths: { riffbot: 100 - OVERLORD_EXPAND_PCT, overlord: OVERLORD_EXPAND_PCT }, riffMode: i.riffHasScared ? "scared" : "idle" }
    : { expanded, widths: { riffbot: 50, overlord: 50 }, riffMode: null };
}
export const hasFaceMode = (faces: FacesModel | null, bot: FaceBot, mode: FaceMode): boolean => !!faces?.bots[bot]?.[mode]?.length;
