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
    /** Squad/lane working dir for a hub with no agent yet (fetchHubCwd); only asked when no hub member has a cwd. */
    resolveCwd?: (hub: Pin) => Promise<string | null | undefined>;
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
  // Same order as server/brainstorm.mjs: the agent's own cwd, else the Squad/lane folder from the registry.
  const cwd = hub.brainstorm?.agent.cwd || inHub.find((m) => m.agent.cwd)?.agent.cwd || (await deps.resolveCwd?.(hub).catch(() => null));
  if (!cwd) throw new Error(`No working directory known for the ${view.team.name ?? view.team.id} hub: add a project folder to the Squad`);
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

/** The hub lane's working dir from the server's laneWorkingDir (brainstorm-summary GET), or null. Needs no agent. */
export async function fetchHubCwd(hub: Pin, doFetch: typeof fetch = fetch): Promise<string | null> {
  const res = await doFetch(`/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(hub.lane.id)}&teamId=${encodeURIComponent(hub.squad.id)}`);
  const body = (await res.json().catch(() => ({}))) as { cwd?: unknown };
  return res.ok && typeof body.cwd === "string" && body.cwd ? body.cwd : null;
}

/** H3: the failed Spin Up error to show on the hub page, only while the focus is the hub lane's. */
export function hubSpinUpError(focus: { laneId: string; spinUpError?: string | null } | null | undefined, hub: Pin | null | undefined): string | null {
  return focus && hub && focus.laneId === hub.lane.id ? focus.spinUpError || null : null;
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
 * Which TVs open a chat. Keyed on the zone's agentId, not its live `member`: a closed Overlord keeps its zone (history + Resume Overlord,
 * member is null) and must stay clickable; with no Overlord at all (no agentId) the TV is static + Spin Up and nothing opens.
 */
export const skyCanOpen = (z: Pick<SkyZones, "riffbot" | "overlord">): SkyCan => ({ riffbot: !!z.riffbot.agentId, overlord: !!z.overlord.agentId });
/** The slam clock's first `prev open`: a chat that mounts already open (a Tower mini-face jump) still plays the slam once. */
export const slamPrevOpenOnMount = (open: boolean, playOnMount: boolean): boolean => (playOnMount ? false : open);
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
/** Open popovers/dialogs that own Esc before the sky does. */
export const SKY_ESC_POPOVER_SELECTOR = ".modal-back, [role='dialog'], [role='menu'], [role='listbox'], .composer-menu, .attn-pop, .pin-menu-list, .drawer-config-menu[open], .drawer-features-menu, .drawer-sandbox-panel, .brainstorm-inbox-popover";
/** Portalled sky-owned surfaces (portal targets with data-sky-owner, compact header, and config popover) that must not trigger outside-close on pointerdown. */
export const SKY_OWNER_SELECTOR = "[data-sky-owner], .drawer-head-compact, .drawer-config-popover";
/** Anything that owns Esc / outside clicks before the sky does: modals, menus, the composer's slash/mention menus, the needs-you popover, header popovers, and [data-sky-owner] portal targets. */
export const SKY_POPOVER_SELECTOR = `${SKY_ESC_POPOVER_SELECTOR}, ${SKY_OWNER_SELECTOR}`;
/** Esc closes the sky chat only when it is open, nothing already handled the key, and no popover/dialog is up to be dismissed first. */
export const skyEscCloses = (open: SkyOpen, defaultPrevented: boolean, popoverOpen: boolean): boolean => {
  const activePopover = popoverOpen && (typeof document === "undefined" || !document.querySelector(SKY_OWNER_SELECTOR) || !!document.querySelector(`${SKY_ESC_POPOVER_SELECTOR}:not([hidden])`));
  return open !== null && !defaultPrevented && !activePopover;
};
/** A pointerdown closes the sky chat only when it lands outside the sky AND outside any (portalled) popover/dialog or [data-sky-owner] portal target. */
export const skyOutsideCloses = (insideSky: boolean, insidePopover: boolean, insideOwner = false): boolean => !insideSky && !insidePopover && !insideOwner;
/** Forced RiffBot face while the Overlord has taken it over: `scared`, or `idle` when faces.json has none; null → normal talk/needs/blink. */
export const skyRiffMode = (open: SkyOpen, riffHasScared: boolean): Extract<FaceMode, "scared" | "idle"> | null => (open === "overlord" ? (riffHasScared ? "scared" : "idle") : null);
export const hasFaceMode = (faces: FacesModel | null, bot: FaceBot, mode: FaceMode): boolean => !!faces?.bots[bot]?.[mode]?.length;

// ── G7 virus takeover overlay (docs/PLAN_SKY_GODS_C2B.md): the Overlord's glitch front eats Riff's TV ──
export const TAKEOVER_URL = (theme: SkyTheme) => `/office/takeover-${theme}.png`;
export const TAKEOVER_JSON_URL = "/office/takeover.json";
/** T1: takeover-label.json (@art): the sticker's art-px size, scale, and the art point `at` that sits on the chip point `anchor.chip` (fractions of the chip's width/height). */
export type TakeoverLabel = { w: number; h: number; scale: number; chip: [number, number]; at: [number, number] };
export const TAKEOVER_LABEL_JSON_URL = "/office/takeover-label.json";
const pair = (v: unknown, dflt: [number, number]): [number, number] | null =>
  v === undefined ? dflt : Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1]] : null;
export function validateTakeoverLabel(json: unknown): { ok: true; value: TakeoverLabel } | { ok: false; error: string } {
  if (!json || typeof json !== "object") return { ok: false, error: "not an object" };
  const { w, h, scale, anchor } = json as Record<string, unknown>;
  if (!posNum(w) || !posNum(h)) return { ok: false, error: "w/h must be > 0" };
  if (scale !== undefined && !posNum(scale)) return { ok: false, error: "scale must be > 0" };
  if (anchor !== undefined && (!anchor || typeof anchor !== "object")) return { ok: false, error: "bad anchor" };
  const an = (anchor ?? {}) as Record<string, unknown>;
  const chip = pair(an.chip, [0, 0.5]);
  const at = pair(an.at, [0, 0]);
  if (!chip || !at) return { ok: false, error: "bad anchor" };
  return { ok: true, value: { w, h, scale: (scale as number | undefined) ?? 1, chip, at } };
}
export type TakeoverModel = { cell: { w: number; h: number }; fps: number; frames: { x: number; y: number }[] };
export const TAKEOVER_LABEL_URL = (theme: SkyTheme) => `/office/takeover-label-${theme}.png`;
/**
 * Sticker box, in CSS px relative to the chip's offset parent: k = crispScale(scale, dpr) CSS px per art px; size w*k × h*k;
 * the art point `at` sits on the chip point (chip.fx × width, chip.fy × height); left/top snapped to whole device px.
 */
export function takeoverLabelGeom(label: TakeoverLabel, chip: { left: number; top: number; width: number; height: number }, dpr = 1): { left: number; top: number; width: number; height: number } {
  const k = crispScale(label.scale, dpr);
  return {
    left: snapPx(chip.left + chip.width * label.chip[0] - label.at[0] * k, dpr),
    top: snapPx(chip.top + chip.height * label.chip[1] - label.at[1] * k, dpr),
    width: label.w * k,
    height: label.h * k,
  };
}
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
  const value: TakeoverModel = { cell: { w, h }, fps, frames: out };
  return { ok: true, value };
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

// ── RS-c Riff swing-window slam (docs/PLAN_RIFF_SWING.md): Riff's chat window swings on a hinge into the Overlord's TV ──
export type SlamDir = "rest" | "open" | "close";
/** The slam clock: `t` ms since the open/close began. `rest` = nothing animating (t 0). */
export type SlamState = { dir: SlamDir; t: number };
export const SLAM_REST: SlamState = { dir: "rest", t: 0 };
/** Timings (ms). The window swings in on its hinge (ease-in, ~300ms), hits (1-frame squash, bezel shake, puff, SMACK star), recoils off the Overlord's TV (back to nearly edge-on, held through the shake so his hurt face is on show) and then swings back flat (settleMs). Close swings it shut gently. */
export const SLAM = { swingMs: 300, closeMs: 300, squashMs: 90, shakeMs: 240, shakeStepMs: 30, recoilMs: 20, settleMs: 200, dizzyMs: 1000 } as const;
/** The swing: rotateY(deg) about the hinge edge. Opens from SWING_FROM_DEG (nearly edge-on, outer edge toward the viewer) to flat; the hit recoils to SWING_REBOUND_DEG (the outer edge swung AWAY, so the window leaves his TV face uncovered), holds, then eases flat. */
export const SWING_FROM_DEG = -80;
export const SWING_REBOUND_DEG = 88;
/** The smear is drawn for this slice of the open swing (progress 0..1): the fast part, just before the hit. */
export const SWING_SMEAR: readonly [number, number] = [0.45, 1];
/** Bezel shake offsets (CSS px at 1080; 2-3px), one per shakeStepMs, ending still. */
export const SLAM_SHAKE_DX: readonly number[] = [9, -9, 7, -7, 5, -5, 2, -2];
/** Squash on the landing frame: wider and shorter, anchored on the bottom edge. */
export const SLAM_SQUASH = { x: 1.08, y: 0.92 } as const;
/** Ease-in (accelerating to the hit) and ease-in-out (the gentle close). */
export const swingEaseIn = (p: number): number => { const c = Math.min(1, Math.max(0, p)); return c * c * c; };
export const swingEaseInOut = (p: number): number => { const c = Math.min(1, Math.max(0, p)); return c * c * (3 - 2 * c); };

/** @art slam-puff.json (RS-a): a one-row sheet of `frames` cells, played once at `ms` per frame; `scale` is the 1080 integer scale. RS-c adds optional `smack` (impact star) and `smear` (window-edge smear) cells on the same sheet. */
export type SlamSmack = { frameW: number; frameH: number; frames: { x: number; y: number }[]; ms: number };
export type SlamSmear = { frameW: number; frameH: number; frame: { x: number; y: number }; edgeX: number; slice: { top: number; bottom: number } };
export type SlamPuff = { frameW: number; frameH: number; frames: { x: number; y: number }[]; scale: number; ms: number; smack?: SlamSmack; smear?: SlamSmear };
export const SLAM_PUFF_JSON_URL = "/office/slam-puff.json";
export const SLAM_PUFF_URL = (theme: SkyTheme) => `/office/slam-puff-${theme}.png`;
const xyList = (list: unknown): { x: number; y: number }[] | null => {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: { x: number; y: number }[] = [];
  for (const f of list) {
    if (f && typeof f === "object" && frameNum((f as { x?: unknown }).x) && frameNum((f as { y?: unknown }).y)) out.push({ x: (f as { x: number }).x, y: (f as { y: number }).y });
    else return null;
  }
  return out;
};
/** Optional keys: anything invalid is dropped (the effect is skipped), never an error for the whole sheet. */
function readSmack(j: unknown): SlamSmack | undefined {
  if (!j || typeof j !== "object") return undefined;
  const { frameW, frameH, frameList, ms } = j as Record<string, unknown>;
  const frames = xyList(frameList);
  return posInt(frameW) && posInt(frameH) && frames ? { frameW, frameH, frames, ms: posNum(ms) ? ms : 90 } : undefined;
}
function readSmear(j: unknown): SlamSmear | undefined {
  if (!j || typeof j !== "object") return undefined;
  const { frameW, frameH, frameList, edgeX, slice } = j as Record<string, unknown>;
  const frames = xyList(frameList);
  const sl = slice && typeof slice === "object" ? (slice as Record<string, unknown>) : {};
  const top = frameNum(sl.top) ? sl.top : 0;
  const bottom = frameNum(sl.bottom) ? sl.bottom : 0;
  if (!posInt(frameW) || !posInt(frameH) || !frames || top + bottom >= frameH) return undefined;
  return { frameW, frameH, frame: frames[0], edgeX: frameNum(edgeX) && edgeX <= frameW ? edgeX : frameW, slice: { top, bottom } };
}
export function validateSlamPuff(json: unknown): { ok: true; value: SlamPuff } | { ok: false; error: string } {
  if (!json || typeof json !== "object") return { ok: false, error: "not an object" };
  const { frameW, frameH, frames, frameList, scale, ms, smack, smear } = json as Record<string, unknown>;
  if (!posInt(frameW) || !posInt(frameH)) return { ok: false, error: "frameW/frameH must be positive integers" };
  const list: { x: number; y: number }[] = [];
  if (Array.isArray(frameList) && frameList.length > 0) {
    for (const f of frameList) {
      if (f && typeof f === "object" && frameNum((f as { x?: unknown }).x) && frameNum((f as { y?: unknown }).y)) list.push({ x: (f as { x: number }).x, y: (f as { y: number }).y });
      else return { ok: false, error: "bad frame" };
    }
  } else if (posInt(frames)) {
    for (let i = 0; i < frames; i++) list.push({ x: i * frameW, y: 0 });
  } else return { ok: false, error: "frames missing" };
  return { ok: true, value: { frameW, frameH, frames: list, scale: posInt(scale) ? scale : 3, ms: posNum(ms) ? ms : 60, smack: readSmack(smack), smear: readSmear(smear) } };
}

/** What the clock needs of the art: puff + smack frame counts / ms. */
export type SlamFxTiming = { frames: number; ms: number; smackFrames?: number; smackMs?: number };
export const slamFxTiming = (p: SlamPuff | null): SlamFxTiming | null => (p ? { frames: p.frames.length, ms: p.ms, smackFrames: p.smack?.frames.length ?? 0, smackMs: p.smack?.ms ?? 0 } : null);
/** Length of the hit's effects: the longer of the puff and the SMACK star. */
export const slamFxMs = (p?: SlamFxTiming | null): number => (p ? Math.max(p.frames * p.ms, (p.smackFrames ?? 0) * (p.smackMs ?? 0)) : 0);

/** Whole timeline length. Open: the swing, then the landing effects (the longer of the shake and the puff/star). Close: the swing shut + the dizzy second run together. */
export function slamTotalMs(dir: SlamDir, fxMs = 0): number {
  if (dir === "open") return SLAM.swingMs + Math.max(SLAM_HIT_MS, fxMs);
  if (dir === "close") return Math.max(SLAM.closeMs, SLAM.dizzyMs);
  return 0;
}
/** A fresh clock for an open/close flip (reduced motion → rest: the swap is instant). */
export const slamStart = (open: boolean, reduced: boolean): SlamState => (reduced ? SLAM_REST : { dir: open ? "open" : "close", t: 0 });
/** One tick: advance `t`, and fall back to rest once the timeline is done. */
export function slamAdvance(s: SlamState, dtMs: number, fxMs = 0): SlamState {
  if (s.dir === "rest") return s;
  const t = s.t + Math.max(0, dtMs);
  return t >= slamTotalMs(s.dir, fxMs) ? SLAM_REST : { dir: s.dir, t };
}

export type SlamView = {
  /** Swing rotateY in deg about the hinge (0 = flat), or null when the window is not swinging (nothing applied). Per-frame: NOT part of slamKey. */
  swing: number | null;
  /** True while the swing/bounce is running (the panel carries the transform): the coarse, keyed form of `swing`. */
  swinging: boolean;
  /** Closing: the panel stays up until it has swung shut. */
  closing: boolean;
  /** The smear frame is drawn on the window's outer edge (the fast part of the open swing). */
  smear: boolean;
  /** Riff shoves: his shove face on the left TV through the swing and the hit. */
  shove: boolean;
  squash: boolean;
  /** Bezel shake offset in CSS px at 1080 (0 = still). */
  shakeDx: number;
  /** Puff frame index, or null (not landed yet / done). */
  puffFrame: number | null;
  /** SMACK star frame index at the hit, or null. */
  smackFrame: number | null;
  /** Face the Overlord's TV is forced to: smacked from the hit, dizzy after the close; null = normal. */
  face: "smacked" | "dizzy" | null;
};
export const SLAM_IDLE_VIEW: SlamView = { swing: null, swinging: false, closing: false, smear: false, shove: false, squash: false, shakeDx: 0, puffFrame: null, smackFrame: null, face: null };

/** Length of the whole hit phase after the contact: recoil + hold (the shake) + settle back flat. */
export const SLAM_HIT_MS = SLAM.shakeMs + SLAM.settleMs;
/** The hinge angle at `t` ms into an open: the swing in, then the hit's recoil (fast out, held while the Overlord shows his hurt face), then the settle flat. */
export function swingAngleOpen(t: number): number {
  if (t < SLAM.swingMs) return SWING_FROM_DEG * (1 - swingEaseIn(t / SLAM.swingMs));
  const lt = t - SLAM.swingMs;
  if (lt < SLAM.recoilMs) return SWING_REBOUND_DEG * (1 - (1 - lt / SLAM.recoilMs) ** 2);
  if (lt < SLAM.shakeMs) return SWING_REBOUND_DEG;
  return lt >= SLAM_HIT_MS ? 0 : SWING_REBOUND_DEG * (1 - swingEaseInOut((lt - SLAM.shakeMs) / SLAM.settleMs));
}
/** Close: a gentle swing shut (ease-in-out), flat → edge-on. */
export const swingAngleClose = (t: number): number => SWING_FROM_DEG * swingEaseInOut(t / SLAM.closeMs) + 0;

/** Everything the UI draws at one moment of the slam clock. Reduced motion (or rest) = the plain end state. */
export function slamView(s: SlamState, reduced: boolean, fx?: SlamFxTiming | null): SlamView {
  if (reduced || s.dir === "rest") return SLAM_IDLE_VIEW;
  if (s.dir === "close") {
    const shut = s.t < SLAM.closeMs;
    return { ...SLAM_IDLE_VIEW, swing: shut ? swingAngleClose(s.t) : null, swinging: shut, closing: shut, face: s.t < SLAM.dizzyMs ? "dizzy" : null };
  }
  if (s.t < SLAM.swingMs) {
    const p = s.t / SLAM.swingMs;
    return { ...SLAM_IDLE_VIEW, swing: swingAngleOpen(s.t), swinging: true, smear: p >= SWING_SMEAR[0] && p < SWING_SMEAR[1], shove: true, face: null };
  }
  const lt = s.t - SLAM.swingMs; // ms since the hit
  const pf = fx && fx.frames > 0 ? Math.floor(lt / fx.ms) : -1;
  const sf = fx && fx.smackFrames && fx.smackMs ? Math.floor(lt / fx.smackMs) : -1;
  const bouncing = lt < SLAM_HIT_MS;
  return {
    ...SLAM_IDLE_VIEW,
    swing: bouncing ? swingAngleOpen(s.t) : null,
    swinging: bouncing,
    shove: bouncing,
    squash: lt < SLAM.squashMs,
    shakeDx: lt < SLAM.shakeMs ? (SLAM_SHAKE_DX[Math.floor(lt / SLAM.shakeStepMs)] ?? 0) : 0,
    puffFrame: pf >= 0 && fx && pf < fx.frames ? pf : null,
    smackFrame: sf >= 0 && fx && sf < (fx.smackFrames ?? 0) ? sf : null,
    face: "smacked",
  };
}
/** Stable string of a view; the clock re-renders only when it changes (the per-frame `swing` angle is written straight to the DOM instead). */
export const slamKey = (v: SlamView): string => `${v.swinging ? 1 : 0}:${v.closing ? 1 : 0}:${v.smear ? 1 : 0}:${v.shove ? 1 : 0}:${v.squash ? 1 : 0}:${v.shakeDx}:${v.puffFrame ?? "-"}:${v.smackFrame ?? "-"}:${v.face ?? "-"}`;

/** The mode to force on the Overlord's face: the slam's, skipped when faces.json lacks that key. */
export const slamFaceForce = (v: SlamView, faces: FacesModel | null): Extract<FaceMode, "smacked" | "dizzy"> | null => (v.face && hasFaceMode(faces, "overlord", v.face) ? v.face : null);
/** Riff's own face while he shoves the window; skipped when faces.json lacks `shove`. */
export const slamRiffForce = (v: SlamView, faces: FacesModel | null): Extract<FaceMode, "shove"> | null => (v.shove && hasFaceMode(faces, "riffbot", "shove") ? "shove" : null);

/** The zone transform under the slam: the shake (snapped to device px) and the landing squash (pinned on the bottom edge by the caller); null = none. */
export function slamTransform(dx: number, squash: boolean, dpr = 1): string | null {
  const t = [dx ? `translateX(${snapPx(dx, dpr)}px)` : "", squash ? `scale(${SLAM_SQUASH.x}, ${SLAM_SQUASH.y})` : ""].filter(Boolean).join(" ");
  return t || null;
}
/** Perspective distance as a multiple of the window width: scales with the window, so the swing looks the same at every size. */
export const SWING_PERSPECTIVE_K = 1.8;
/**
 * Perspective distance (px) for a window `widthPx` wide at hinge angle `deg`. The outer edge (toward the viewer for deg < 0) projects to
 * W*cos(a)*P/(P - W*sin(a)); P >= W*cot(a/2) keeps that <= W, i.e. the edge never leaves the flat window's own box (so it stays inside the sky band
 * and the smear is never pushed out of it). Capped so the near-flat angles stay finite.
 */
export function swingPerspectivePx(deg: number, widthPx: number): number {
  const w = widthPx > 0 ? widthPx : 1;
  const a = (Math.abs(deg) * Math.PI) / 180;
  if (deg >= 0 || a < 0.02) return w * SWING_PERSPECTIVE_K;
  return w * Math.min(60, Math.max(SWING_PERSPECTIVE_K, 1 / Math.tan(a / 2)));
}
/** Where the window's outer edge lands (px from the hinge) at angle `deg` under swingPerspectivePx: the projected edge the layout has to keep in bounds. */
export function swingEdgeX(deg: number, widthPx: number): number {
  const a = (deg * Math.PI) / 180;
  const p = swingPerspectivePx(deg, widthPx);
  const z = -widthPx * Math.sin(a); // deg < 0: the outer edge comes toward the viewer
  return (widthPx * Math.cos(a) * p) / (p - z);
}
/** The CSS transform of the hinge angle (perspective + rotateY; the origin is the hinge edge, set in CSS). */
export const swingTransform = (deg: number, widthPx = 1000): string => `perspective(${Math.round(swingPerspectivePx(deg, widthPx))}px) rotateY(${Math.round(deg * 100) / 100}deg)`;

export type Rect = { left: number; top: number; width: number; height: number };
/** The face k at 1080 that slam-puff.json's `scale` (3) was drawn against: the puff grows with the face from there (so the burst keeps its size relative to the Overlord at 4K@120%). */
export const SLAM_FACE_K_1080 = 7;
/** Puff scale (CSS px per art px): the art's `scale` at the 1080 face k, grown in step with the face k elsewhere, always whole device px. */
export const slamPuffScale = (puffScale: number, faceK: number, dpr = 1): number => crispScale(faceK > 0 ? (puffScale * faceK) / SLAM_FACE_K_1080 : puffScale, dpr);
/** A puff cell's box centred on a window-edge point, snapped to whole device px. */
export function slamPuffBox(at: { x: number; y: number }, cell: { w: number; h: number }, k: number, dpr = 1, bounds?: { width: number; height: number } | null): Rect {
  const width = cell.w * k;
  const height = cell.h * k;
  let left = at.x - width / 2;
  let top = at.y - height / 2;
  if (bounds && bounds.width >= width && bounds.height >= height) { // keep the whole puff inside the FX box (the sky's edge clips it otherwise)
    left = Math.min(Math.max(left, 0), bounds.width - width);
    top = Math.min(Math.max(top, 0), bounds.height - height);
  }
  return { left: snapPx(left, dpr), top: snapPx(top, dpr), width, height };
}
/** The four window corners where the puffs go off. */
export const slamPuffPoints = (r: Rect): { x: number; y: number }[] => [
  { x: r.left, y: r.top },
  { x: r.left + r.width, y: r.top },
  { x: r.left, y: r.top + r.height },
  { x: r.left + r.width, y: r.top + r.height },
];
