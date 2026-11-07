// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): the pure zone→agent mapping. RiffBot is the hub Buddy (left),
// the Overlord is the hub lead (right). No React here so it is unit-testable under node.
import { dormantBuddyId, hubPinForSquad, type Pin } from "./pins.ts";
import { poseFor, type FaceBot, type FaceMode, type FacesModel, type Pose } from "./squadFloorLogic.ts";
import { ordOf, type Member, type TeamView } from "./teams.ts";

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

/** The hub's closed-but-unarchived lead (newest first), shown read-only with Resume Overlord while no live Overlord exists. */
export function dormantOverlordMember(view: TeamView | null | undefined, hub: Pin | null): Member | null {
  if (!view || !hub || hub.lead) return null;
  const lane = hub.lane.id.toLowerCase();
  const closed = (view.members ?? []).filter(
    (m) => m.kind === "lead" && (m.laneId ?? "").toLowerCase() === lane && !m.agent.archivedAt && m.agent.status === "closed",
  );
  closed.sort((a, b) => (b.agent.updatedAt ?? "").localeCompare(a.agent.updatedAt ?? ""));
  return closed[0] ?? null;
}

/** Left zone = hub Buddy (RiffBot), right zone = hub lead (Overlord). Never the same agent twice. */
export function skyZonesFor(view: TeamView | null | undefined): SkyZones {
  const hub = hubPinForSquad(view);
  const riffbot = hub?.brainstorm ?? null;
  const overlord = hub?.lead && hub.lead.agent.id !== riffbot?.agent.id ? hub.lead : null;
  const dormant = !!hub && !!riffbot && dormantBuddyId(hub) === riffbot.agent.id;
  // A live Overlord wins; otherwise a closed one keeps its history in the zone (member stays null: nobody is on duty).
  const closedLead = overlord ? null : dormantOverlordMember(view, hub);
  const overlordZone: SkyZone = closedLead ? { bot: "overlord", member: null, agentId: closedLead.agent.id, dormant: true, pose: null } : zoneOf("overlord", overlord);
  return { hub, riffbot: zoneOf("riffbot", riffbot, dormant), overlord: overlordZone };
}

/** The slice of a profile the Overlord spawn needs (src/profiles.ts Profile satisfies it). */
export type OverlordProfile = {
  name: string;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
};
export type OverlordSpawnReq = {
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
  approvalPolicy?: string;
  sandbox?: string;
  shareMcp?: boolean;
  title: string;
  labels: Record<string, string>;
  prompt: string;
  cwd: string;
};
export const OVERLORD_PROFILES = ["Lead - Claude", "Lead - Gemini"] as const;
export const OVERLORD_TITLE = "Overlord";

/** The Lead profile name for the Squad's Overlord: the previous Overlord's own Lead profile, else by provider like HandoffModal (antigravity-cli → Gemini, else Claude). */
export function overlordProfileName(view: TeamView | null | undefined): string {
  const prev = dormantOverlordMember(view, hubPinForSquad(view));
  const p = (prev?.agent.labels as Record<string, string> | undefined)?.profile;
  if (p === "Lead - Gemini" || p === "Lead - Claude") return p;
  return prev?.agent.provider?.startsWith("antigravity-cli") ? "Lead - Gemini" : "Lead - Claude";
}

const spinning = new Map<string, Promise<string>>();
/** True while a Spin Up / Resume Overlord spawn is running for this Squad. */
export const overlordStarting = (squadId: string): boolean => spinning.has(squadId.toLowerCase());

/**
 * Spawn the hub lead (role=lead on the Squad's hub lane) through the same primitive a lead handoff uses.
 * A live Overlord is returned as is, concurrent calls for one Squad share one spawn, and any closed unarchived
 * hub lead is retired once the successor spawned, so it cannot resurface as a dormant "(old) Overlord". The sky zone shows the new
 * agent as soon as it lands in the store.
 */
export function spinUpOverlord(
  view: TeamView,
  deps: {
    spawn: (req: OverlordSpawnReq) => Promise<{ id: string }>;
    /** Retire a closed predecessor (App passes retireAgent). */
    retire?: (m: Member) => Promise<unknown>;
    profile: OverlordProfile | undefined;
    profileName: string;
    defaults?: { modeId?: string; approvalPolicy?: string; sandbox?: string; shareMcp?: boolean };
  },
): Promise<string> {
  const hub = hubPinForSquad(view);
  if (!hub) return Promise.reject(new Error("No hub lane for this Squad"));
  if (hub.lead) return Promise.resolve(hub.lead.agent.id);
  const key = view.team.id.toLowerCase();
  const pending = spinning.get(key);
  if (pending) return pending;
  const run = doSpinUp(view, hub, deps).finally(() => spinning.delete(key));
  spinning.set(key, run);
  return run;
}

async function doSpinUp(view: TeamView, hub: Pin, deps: Parameters<typeof spinUpOverlord>[1]): Promise<string> {
  const lane = hub.lane.id;
  const inHub = (view.members ?? []).filter((m) => (m.laneId ?? "").toLowerCase() === lane.toLowerCase());
  const cwd = hub.brainstorm?.agent.cwd || inHub.find((m) => m.agent.cwd)?.agent.cwd;
  if (!cwd) throw new Error("No working directory known for the hub; start RiffBot first");
  const ord = Math.max(0, ...inHub.filter((m) => m.kind === "lead" || m.kind === "old-lead").map((m) => ordOf(m.agent))) + 1;
  const p = deps.profile;
  const gemini = deps.profileName === "Lead - Gemini";
  const profileName = p?.name ?? deps.profileName;
  const squad = view.team.id;
  const labels = { team: squad, lane, lead: lane, role: "lead", profile: profileName, ord: String(ord) };
  const prompt = `You are the Overlord (hub lead) of the ${view.team.name ?? squad} Squad. Read AGENTS.md and your role pack, then run \`vs log --since-me\` and \`vs who all\` to catch up on every lane.`;
  const r = await deps.spawn({
    provider: p?.provider ?? (gemini ? "antigravity-cli" : "claude"),
    model: p?.model ?? (gemini ? "gemini-4-argon" : "claude-opus-5-5"),
    modeId: p?.modeId ?? deps.defaults?.modeId,
    thinkingOptionId: p?.thinkingOptionId,
    featureValues: p?.featureValues,
    notes: p?.notes,
    approvalPolicy: deps.defaults?.approvalPolicy,
    sandbox: deps.defaults?.sandbox,
    shareMcp: deps.defaults?.shareMcp,
    title: OVERLORD_TITLE,
    labels,
    prompt,
    cwd,
  });
  // Only after the successor exists: a failed spawn leaves the dormant Overlord (history + Resume) untouched.
  for (const m of inHub) {
    if (m.kind === "lead" && !m.agent.archivedAt && m.agent.status === "closed") await deps.retire?.(m)?.catch?.(() => {});
  }
  return r.id;
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
 * G6-fix2/2b big face: the largest whole-number scale at which the WHOLE cell fits the box (contain, never crop).
 * Centred horizontally (side letterbox only), anchored to the BOTTOM so the suit meets the bottom edge; any vertical
 * slack goes at the top. The gutters are filled by the bot's background colour. k is at least 1 (a box smaller than one
 * cell is the only case that crops). Returns `k` 0 until the box has a size.
 */
export function faceContain(cell: { w: number; h: number }, box: { w: number; h: number }): { k: number; left: number; top: number } {
  if (!(box.w > 0 && box.h > 0) || !(cell.w > 0 && cell.h > 0)) return { k: 0, left: 0, top: 0 };
  const k = Math.max(1, Math.floor(Math.min(box.w / cell.w, box.h / cell.h)));
  return { k, left: Math.round((box.w - cell.w * k) / 2), top: box.h - cell.h * k };
}

/** Gutter colour around a contained face: faces.json `<bot>.bg[theme]` when the field is valid, else null → the per-theme `--sky-face-bg-*` CSS variable. */
export const faceBg = (faces: FacesModel | null, bot: FaceBot, theme: SkyTheme): string | null => faces?.bg?.[bot]?.[theme] ?? null;

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

// ── G7 virus takeover overlay (docs/PLAN_SKY_GODS_C2B.md): the Overlord's glitch front eats Riff's squeezed screen ──
export const TAKEOVER_URL = (theme: SkyTheme) => `/office/takeover-${theme}.png`;
export const TAKEOVER_JSON_URL = "/office/takeover.json";
export type TakeoverModel = { cell: { w: number; h: number }; fps: number; frames: { x: number; y: number }[] };
const posNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const frameNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
/**
 * Validate takeover.json. Frames are {x,y} objects or bare numbers (= x, y 0); cell sides > 0, fps > 0, at least one frame.
 * Anything invalid → not ok, and the whole overlay is treated as absent (the CSS dissolve plays instead).
 */
export function validateTakeover(json: unknown): { ok: true; value: TakeoverModel } | { ok: false; error: string } {
  if (!json || typeof json !== "object") return { ok: false, error: "not an object" };
  const { cell, fps, frames } = json as Record<string, unknown>;
  if (!cell || typeof cell !== "object") return { ok: false, error: "cell missing" };
  const { w, h } = cell as Record<string, unknown>;
  if (!posNum(w) || !posNum(h)) return { ok: false, error: "cell sides must be > 0" };
  if (!posNum(fps)) return { ok: false, error: "fps must be > 0" };
  if (!Array.isArray(frames) || frames.length < 1) return { ok: false, error: "frames must hold at least one frame" };
  const out: { x: number; y: number }[] = [];
  for (const f of frames) {
    if (frameNum(f)) out.push({ x: f, y: 0 });
    else if (f && typeof f === "object" && frameNum((f as { x?: unknown }).x) && frameNum((f as { y?: unknown }).y)) out.push({ x: (f as { x: number }).x, y: (f as { y: number }).y });
    else return { ok: false, error: "bad frame" };
  }
  return { ok: true, value: { cell: { w, h }, fps, frames: out } };
}
/** Whole-overlay length in ms. */
export const takeoverDurationMs = (m: Pick<TakeoverModel, "fps" | "frames">): number => (m.frames.length * 1000) / m.fps;
/** The CSS dissolve fallback has no sheet: eight blocky steps at the sheet's usual 13 fps (≈615 ms). */
export const TAKEOVER_FALLBACK: Pick<TakeoverModel, "fps"> & { steps: number } = { fps: 13, steps: 8 };
export const TAKEOVER_FALLBACK_MS = Math.round((TAKEOVER_FALLBACK.steps * 1000) / TAKEOVER_FALLBACK.fps);

/**
 * One tick of the overlay clock. `pos` is elapsed frames in [0, n]: expanding runs it up to n (held on the last frame),
 * collapsing runs it back down to 0 (overlay gone, Riff idle). A flip simply changes the direction of the same `pos`,
 * so it reverses from the current frame instead of restarting.
 */
export function takeoverAdvance(pos: number, expanded: boolean, dtMs: number, fps: number, n: number): number {
  const d = (Math.max(0, dtMs) * fps) / 1000;
  return Math.min(n, Math.max(0, expanded ? pos + d : pos - d));
}
/** Frame to draw at `pos` (the last one is held at pos = n). */
export const takeoverFrameAt = (pos: number, n: number): number => Math.min(n - 1, Math.max(0, Math.floor(pos)));
/** Drawn while expanded or still reversing; gone once fully reversed. Reduced motion never draws it. */
export const takeoverVisible = (pos: number, expanded: boolean, reduced: boolean): boolean => !reduced && (expanded || pos > 0);
/** Nothing left to animate: expanded and fully in, or collapsed and fully out. */
export const takeoverSettled = (pos: number, expanded: boolean, n: number): boolean => (expanded ? pos >= n : pos <= 0);
