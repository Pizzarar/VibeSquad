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
/** Optional `wall` (H1e contract): the always-present divider between the two TVs. width = source px wide; scale = its own scale (falls back to the bezel's); slice = vertical 3-slice caps (source px); repeat = how the middle tiles. The art is always /office/sky-wall-{theme}.png. */
export type SkyWall = { width: number; scale?: number; slice?: { top: number; bottom: number }; repeat: SkyCrtRepeat };
export type SkyCrtModel = { slice: { top: number; right: number; bottom: number; left: number }; scale: number; repeat: SkyCrtRepeat; wall?: SkyWall };
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
  const wall = parseWall((json as Record<string, unknown>).wall);
  return { ok: true, value: { slice: { top, right, bottom, left }, scale, repeat: repeat ?? "stretch", ...(wall ? { wall } : null) } };
}
const nonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
/** Optional: a bad `wall` (width not a positive int, not an object) is ignored, never an error - the 2px CSS ink seam stays. A bad slice / scale / repeat falls back to none / the bezel's / round. */
export function parseWall(raw: unknown): SkyWall | null {
  if (!raw || typeof raw !== "object") return null;
  const { width, scale, slice, repeat } = raw as Record<string, unknown>;
  if (!posInt(width)) return null;
  const sl = slice && typeof slice === "object" ? (slice as Record<string, unknown>) : null;
  return {
    width,
    ...(typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? { scale } : null),
    ...(sl && nonNegInt(sl.top) && nonNegInt(sl.bottom) && (sl.top > 0 || sl.bottom > 0) ? { slice: { top: sl.top, bottom: sl.bottom } } : null),
    repeat: repeat === "stretch" ? "stretch" : "round",
  };
}
export const SKY_WALL_URL = (theme: SkyTheme) => `/office/sky-wall-${theme}.png`;
/** The 2px CSS ink seam, snapped to whole device px (1.2 dpr: 2 device px = 1.667 css px) so it is crisp too; at dpr 1 it is the plain 2px. */
export function skyWallFallbackStyle(dpr = 1): Record<string, string> {
  const d = safeDpr(dpr);
  const n = Math.max(1, Math.round(2 * d));
  return { width: `${n / d}px`, marginLeft: `-${Math.floor(n / 2) / d}px` };
}
/** Inline style for the wall element when its art loaded: width = width x (wall.scale ?? bezel scale), pixelated, vertical 3-slice when `slice` is given. null (no wall / no art) -> the CSS ink seam. */
export function skyWallStyle(wall: SkyWall | undefined, bezelScale: number, url: string | null, dpr = 1): Record<string, string> | null {
  if (!wall || !url) return null;
  const k = crispScale(wall.scale ?? bezelScale, dpr); // whole device px per source px
  const d = safeDpr(dpr);
  const width = `${snapPx(wall.width * k, d)}px`;
  const base = { width, marginLeft: `-${Math.floor((wall.width * k * d) / 2) / d}px`, background: "none", imageRendering: "pixelated" };
  if (!wall.slice) return { ...base, backgroundImage: `url(${url})`, backgroundSize: `${width} auto`, backgroundRepeat: "repeat-y" };
  const { top, bottom } = wall.slice;
  return {
    ...base,
    borderStyle: "solid",
    borderWidth: `${top * k}px 0 ${bottom * k}px`,
    borderImageSource: `url(${url})`,
    borderImageSlice: `${top} 0 ${bottom} fill`,
    borderImageRepeat: wall.repeat,
  };
}
/** json → the zone's border-image style: width = slice × scale per side, slice + `fill`, crisp pixels. */
export function skyCrtStyle(model: SkyCrtModel, url: string, dpr = 1): Record<string, string> {
  const { top, right, bottom, left } = model.slice;
  const k = crispScale(model.scale, dpr); // G8e: whole device px per source px, so the 9-slice edges stay sharp at 120% zoom
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
  dpr = 1,
): { skyUrl: string | null; frameUrl: string | null; frameStyle: Record<string, string> | null } {
  const frameUrl = ok.frame && crt ? SKY_FRAME_URL(theme) : null;
  return { skyUrl: ok.sky ? SKY_URL(theme) : null, frameUrl, frameStyle: frameUrl && crt ? skyCrtStyle(crt, frameUrl, dpr) : null };
}

/**
 * G6-fix2/2b big face: the largest whole-number scale at which the WHOLE cell fits the box (contain, never crop).
 * Centred horizontally (side letterbox only), anchored to the BOTTOM so the suit meets the bottom edge; any vertical
 * slack goes at the top. The gutters are filled by the bot's background colour. k is at least 1 (a box smaller than one
 * cell is the only case that crops). Returns `k` 0 until the box has a size.
 */
export function faceContain(cell: { w: number; h: number }, box: { w: number; h: number }, dpr = 1): { k: number; left: number; top: number } {
  if (!(box.w > 0 && box.h > 0) || !(cell.w > 0 && cell.h > 0)) return { k: 0, left: 0, top: 0 };
  const d = safeDpr(dpr);
  // G8e: the scale is a whole number of DEVICE pixels per art pixel (kd), so every art pixel lands on the same number of
  // screen pixels; the CSS scale is kd / dpr. Offsets are device-pixel multiples too. At dpr 1 this is the old integer CSS scale.
  const kd = Math.max(1, Math.floor(Math.min(box.w / cell.w, box.h / cell.h) * d + 1e-9));
  const k = kd / d;
  return { k, left: Math.round(((box.w - cell.w * k) / 2) * d) / d, top: Math.floor(box.h * d - cell.h * kd + 1e-9) / d };
}
/** A usable device-pixel ratio: finite and >= 1 (anything else, SSR/tests included, is 1). */
export const safeDpr = (dpr: unknown): number => (typeof dpr === "number" && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1);
/** The matchMedia query that flips when the page zoom / monitor changes the ratio away from `dpr` (re-armed with the new ratio each time). */
export const dprMediaQuery = (dpr: number): string => `(resolution: ${safeDpr(dpr)}dppx)`;
/**
 * G8e: CSS px per source px for art that is drawn by a CSS border-image / width (bezel, wall): the largest whole number of
 * DEVICE px per source px at or below `scale` x dpr (an exact integer product is kept as is), divided back to CSS px.
 */
export function crispScale(scale: number, dpr = 1): number {
  const d = safeDpr(dpr);
  const dev = scale * d;
  const kd = Math.abs(dev - Math.round(dev)) < 1e-6 ? Math.round(dev) : Math.floor(dev);
  return Math.max(1, kd) / d;
}
/** A CSS length (px) rounded to a whole number of device px. */
export const snapPx = (px: number, dpr = 1): number => Math.round(px * safeDpr(dpr)) / safeDpr(dpr);

/** Gutter colour around a contained face: faces.json `<bot>.bg[theme]` when the field is valid, else null → the per-theme `--sky-face-bg-*` CSS variable. */
export const faceBg = (faces: FacesModel | null, bot: FaceBot, theme: SkyTheme): string | null => faces?.bg?.[bot]?.[theme] ?? null;

// ── G8 fixed TVs (docs/PLAN_SKY_GODS_C2B.md): both TVs are always 50/50; which chat is open is explicit click state ──
/** The two TVs never resize: a fixed 50/50 grid. (G6's 70/30 Overlord expand is gone.) */
export const SKY_COLUMNS = "minmax(0, 1fr) minmax(0, 1fr)";
/** Which bot's chat is open over the right TV; null = rest (portraits only). Set by clicks only, never by focus or talking. */
export type SkyOpen = FaceBot | null;
/** Who can be opened: RiffBot needs a chat agent (live or dormant); the Overlord needs to be live (no static, no closed one). */
export type SkyCan = { riffbot: boolean; overlord: boolean };
/**
 * A click on a TV's face. At rest the bot opens (if it can). While anything is open the left TV shows the open bot's face
 * (Riff's own, or the Overlord that took it over), so clicking it again closes; the right TV is under the chat and cannot be clicked.
 */
export function skyFaceClick(open: SkyOpen, tv: FaceBot, can: SkyCan): SkyOpen {
  if (open !== null) return tv === "riffbot" ? null : open;
  return can[tv] ? tv : null;
}
/** Esc, a click outside the sky, or the chat's ✕. */
export const skyExit = (_open: SkyOpen): SkyOpen => null;
/** The Overlord going away (closed, killed) while its chat is open drops back to rest; an open RiffBot with no chat agent too. */
export const skyEffectiveOpen = (open: SkyOpen, can: SkyCan): SkyOpen => (open && can[open] ? open : null);
/** Anything that owns Esc / outside clicks before the sky does: modals, menus, the composer's slash/mention menus, the needs-you popover. */
export const SKY_POPOVER_SELECTOR = ".modal-back, [role='dialog'], [role='menu'], [role='listbox'], .composer-menu, .attn-pop, .pin-menu-list";
/** Esc closes the sky chat only when it is open, nothing already handled the key, and no popover/dialog is up to be dismissed first. */
export const skyEscCloses = (open: SkyOpen, defaultPrevented: boolean, popoverOpen: boolean): boolean => open !== null && !defaultPrevented && !popoverOpen;
/** A pointerdown closes the sky chat only when it lands outside the sky AND outside any (portalled) popover/dialog. */
export const skyOutsideCloses = (insideSky: boolean, insidePopover: boolean): boolean => !insideSky && !insidePopover;
/** Forced RiffBot face while the Overlord has taken it over: `scared`, or `idle` when faces.json has none; null → normal talk/needs/blink. */
export const skyRiffMode = (open: SkyOpen, riffHasScared: boolean): Extract<FaceMode, "scared" | "idle"> | null => (open === "overlord" ? (riffHasScared ? "scared" : "idle") : null);
export const hasFaceMode = (faces: FacesModel | null, bot: FaceBot, mode: FaceMode): boolean => !!faces?.bots[bot]?.[mode]?.length;

// ── G7 virus takeover overlay (docs/PLAN_SKY_GODS_C2B.md): the Overlord's glitch front eats Riff's TV ──
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
/** G8f: the takeover has landed once expanded and fully in (or at once under reduced motion; the no-sheet dissolve lands on its own timer): the left TV now shows the Overlord's face. */
export const takeoverLanded = (pos: number, expanded: boolean, n: number, reduced: boolean): boolean => expanded && (reduced || pos >= n);
/** G8f: which bot's face the left TV shows. Riff at rest and while the takeover plays in/out; the Overlord once it has landed. */
export const skyLeftBot = (landed: boolean): FaceBot => (landed ? "overlord" : "riffbot");
/** Nothing left to animate: expanded and fully in, or collapsed and fully out. */
export const takeoverSettled = (pos: number, expanded: boolean, n: number): boolean => (expanded ? pos >= n : pos <= 0);
