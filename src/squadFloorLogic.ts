// Squad floor Phase 2 — pure model (docs/PLAN_SQUAD_FLOOR_P2.md block F1).
// No React, no DOM: load/validate floor+cast JSON, placeholder layout, seat assignment,
// overflow, pose from agent state, ride transitions, role→sprite fallback, floor "!" markers
// and the integer render scale. The tower UI (F2, src/SquadFloor.tsx) draws this.
// Imports stay pure: kindOfAttention is shared with the badge/queue logic; teams.ts / pins.ts
// are imported type-only so node --test never loads React.

import { kindOfAttention } from "./attentionItems.ts";
import { castVariant } from "./cast.ts"; // @art owns cast.ts: import only
import type { Member } from "./teams.ts";

// ── JSON shapes (the @art contract, docs/PLAN_NEON_OFFICE.md) ─────────────────

export type Rect = { x: number; y: number; w: number; h: number };
export type Frame = { x: number; y: number };
export type Pose = "work" | "needs" | "idle" | "ride";

export type CastModel = {
  version: number;
  /** Cell size in native px (cast.json `cell`, e.g. 32). */
  cell: number;
  anchor: string;
  /** role name → pose → frames (each frame is the top-left of a `cell` square in the sheet). */
  roles: Record<string, Record<Pose, Frame[]>>;
  /** v2: role → its variants (each a full pose set). Empty for v1; roles without variants only have `roles`. */
  variants: Record<string, Record<Pose, Frame[]>[]>;
  bubble: { x: number; y: number; w: number; h: number; offset: { x: number; y: number } };
  /** role → nearest drawn role, used when a role is missing from `roles`. May be `{}`. */
  fallback: Record<string, string>;
};

export type TeamSlices = {
  lead: Rect;
  buddyOffice: Rect;
  /** One desk per worker seat, in stable order. */
  desks: Rect[];
  /** 72x32 overflow queue by the team's door (S1); optional. */
  lobby?: Rect;
  /** F4b: the wall stats TV's screen glass (about 40x28 floor px); optional. When valid, overflow workers show as blips on it instead of in the lobby. */
  statsTv?: Rect;
  /** HP6: the painted (blank) team-name plate on the wall; the UI letters the team name onto it. Optional (skip-if-absent). */
  sign?: Rect;
};

export type PenthouseModel = {
  plate: string;
  w: number;
  h: number;
  riffbot: { seat: Rect; lounge: Rect };
  overlord: { seat: Rect; crtWall: Rect };
  elevatorTop: Rect;
  /** `roof-front-{theme}.png` exists and is drawn over the penthouse sprites. */
  front?: boolean;
};

/** Art10 top band (floor.json `screens`): two big CRTs [RiffBot | lift top | Overlord] that replace the penthouse. */
export type ScreensModel = {
  plate: string;
  w: number;
  h: number;
  /** `roof-front-{theme}.png` (lift car front + glass corners) is drawn over the faces. */
  front?: boolean;
  /** Glass rects (a face cell: faces.json cell w x h). */
  riffbot: Rect;
  overlord: Rect;
  elevatorTop: Rect;
};

export type FloorModel = {
  /** Plate size from floor.json `w`/`h` (HP5: the ground strip is cropped, so the height is no longer 360); absent = the native 640x360. */
  size?: { w: number; h: number };
  teamA: TeamSlices;
  teamB: TeamSlices;
  elevator: { doorA: Rect; doorB: Rect; car: Rect; /** HP6: the lift readout slot, and the ‹ › call-button plates beside the doors; each optional. */ counter?: Rect; callPrev?: Rect; callNext?: Rect };
  /** Old top band (S1). Used only when `screens` is absent; the placeholder supplies one when neither exists. */
  penthouse?: PenthouseModel;
  /** Art10 CRT screens; wins over `penthouse`. */
  screens?: ScreensModel;
  /** `floor-front-{theme}.png` exists and is drawn over the y-sorted sprites (floor.json `"front": true`). */
  front?: boolean;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const VARIANT_POSES: Pose[] = ["work", "needs", "idle", "ride"];
const fail = <T,>(reason: string): Validation<T> => ({ ok: false, reason });
const rectOf = (v: unknown): Rect | null =>
  isObject(v) && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h)
    ? { x: v.x as number, y: v.y as number, w: v.w as number, h: v.h as number }
    : null;
const frameOf = (v: unknown): Frame | null =>
  isObject(v) && isNum(v.x) && isNum(v.y) ? { x: v.x as number, y: v.y as number } : null;

// ── 1. Validate floor.json / cast.json (already-parsed JSON, or undefined) ────

function teamSlicesOf(v: unknown): TeamSlices | null {
  if (!isObject(v)) return null;
  const lead = rectOf(v.lead);
  const buddyOffice = rectOf(v.buddyOffice);
  if (!lead || !buddyOffice || !Array.isArray(v.desks)) return null;
  const desks: Rect[] = [];
  for (const d of v.desks) {
    const r = rectOf(d);
    if (!r) return null;
    desks.push(r);
  }
  const lobby = v.lobby === undefined ? undefined : rectOf(v.lobby) ?? undefined;
  // A statsTv with a non-positive size can't hold a blip: drop it so the team falls back to the lobby.
  const tv = v.statsTv === undefined ? null : rectOf(v.statsTv);
  const statsTv = tv && tv.w > 0 && tv.h > 0 ? tv : undefined;
  const sg = v.sign === undefined ? null : rectOf(v.sign);
  const sign = sg && sg.w > 0 && sg.h > 0 ? sg : undefined;
  return { lead, buddyOffice, desks, ...(lobby ? { lobby } : {}), ...(statsTv ? { statsTv } : {}), ...(sign ? { sign } : {}) };
}

/** HP6 additive elevator slots: each kept only when it is a rect with a positive size. */
function slotRects(e: Record<string, unknown>): { counter?: Rect; callPrev?: Rect; callNext?: Rect } {
  const out: { counter?: Rect; callPrev?: Rect; callNext?: Rect } = {};
  for (const k of ["counter", "callPrev", "callNext"] as const) {
    const r = e[k] === undefined ? null : rectOf(e[k]);
    if (r && r.w > 0 && r.h > 0) out[k] = r;
  }
  return out;
}

function penthouseOf(v: unknown): PenthouseModel | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v) || typeof v.plate !== "string" || !isNum(v.w) || !isNum(v.h)) return undefined;
  const riffbot = isObject(v.riffbot) ? { seat: rectOf(v.riffbot.seat), lounge: rectOf(v.riffbot.lounge) } : null;
  const overlord = isObject(v.overlord) ? { seat: rectOf(v.overlord.seat), crtWall: rectOf(v.overlord.crtWall) } : null;
  const elevatorTop = rectOf(v.elevatorTop);
  if (!riffbot?.seat || !riffbot.lounge || !overlord?.seat || !overlord.crtWall || !elevatorTop) return undefined;
  return {
    plate: v.plate as string,
    w: v.w as number,
    h: v.h as number,
    riffbot: { seat: riffbot.seat, lounge: riffbot.lounge },
    overlord: { seat: overlord.seat, crtWall: overlord.crtWall },
    elevatorTop,
    ...(v.front === true ? { front: true } : {}),
  };
}

function screensOf(v: unknown): ScreensModel | undefined {
  if (!isObject(v) || typeof v.plate !== "string" || !isNum(v.w) || !isNum(v.h)) return undefined;
  const riffbot = rectOf(v.riffbot);
  const overlord = rectOf(v.overlord);
  const elevatorTop = rectOf(v.elevatorTop);
  if (!riffbot || !overlord || !elevatorTop) return undefined;
  return { plate: v.plate, w: v.w as number, h: v.h as number, riffbot, overlord, elevatorTop, ...(v.front === true ? { front: true } : {}) };
}

/** Validate floor.json. Unknown extra fields are ignored; `lobby` and `penthouse` are optional (S1 growth). */
export function validateFloor(json: unknown): Validation<FloorModel> {
  if (!isObject(json)) return fail("floor.json is not an object");
  const teamA = teamSlicesOf(json.teamA);
  if (!teamA) return fail("floor.json teamA is missing lead, buddyOffice or desks");
  const teamB = teamSlicesOf(json.teamB);
  if (!teamB) return fail("floor.json teamB is missing lead, buddyOffice or desks");
  const elevator =
    isObject(json.elevator) && rectOf(json.elevator.doorA) && rectOf(json.elevator.doorB) && rectOf(json.elevator.car)
      ? { doorA: rectOf(json.elevator.doorA)!, doorB: rectOf(json.elevator.doorB)!, car: rectOf(json.elevator.car)!, ...slotRects(json.elevator) }
      : null;
  if (!elevator) return fail("floor.json elevator is missing doorA, doorB or car");
  const penthouse = penthouseOf(json.penthouse);
  const screens = screensOf(json.screens);
  const size = isNum(json.w) && isNum(json.h) && json.w > 0 && json.h > 0 ? { w: json.w, h: json.h } : null;
  return { ok: true, value: { ...(size ? { size } : {}), teamA, teamB, elevator, ...(penthouse ? { penthouse } : {}), ...(screens ? { screens } : {}), ...(json.front === true ? { front: true } : {}) } };
}

/** Validate cast.json. Unknown roles/poses/fields are kept; `fallback` may be `{}`; nothing about the sheet is hardcoded. */
export function validateCast(json: unknown): Validation<CastModel> {
  if (!isObject(json)) return fail("cast.json is not an object");
  const cell = json.cell;
  if (!isNum(cell) || cell <= 0) return fail("cast.json cell must be a positive number");
  if (!isObject(json.roles) || Object.keys(json.roles).length === 0) return fail("cast.json roles is missing or empty");
  const roles: Record<string, Record<Pose, Frame[]>> = {};
  const variants: Record<string, Record<Pose, Frame[]>[]> = {};
  const poseFrames = (role: string, pose: string, frames: unknown): Validation<Frame[]> => {
    if (!Array.isArray(frames) || frames.length === 0) return fail(`cast.json role "${role}" pose "${pose}" has no frames`);
    const cells: Frame[] = [];
    for (const f of frames) {
      const frame = frameOf(f);
      if (!frame) return fail(`cast.json role "${role}" pose "${pose}" has an invalid frame`);
      cells.push(frame);
    }
    return { ok: true, value: cells };
  };
  for (const [role, poses] of Object.entries(json.roles)) {
    if (!isObject(poses)) return fail(`cast.json role "${role}" is not an object`);
    const rolePoses = {} as Record<Pose, Frame[]>;
    for (const [pose, frames] of Object.entries(poses)) {
      if (pose === "variants") continue; // v2, parsed below
      const r = poseFrames(role, pose, frames);
      if (!r.ok) return fail(r.reason);
      rolePoses[pose as Pose] = r.value;
    }
    // v2: roles.X.variants[i] = {work,needs,idle,ride}; the compat x,y on each variant is not a pose and is ignored.
    if (poses.variants !== undefined) {
      if (!Array.isArray(poses.variants) || poses.variants.length === 0) return fail(`cast.json role "${role}" variants must be a non-empty array`);
      const list: Record<Pose, Frame[]>[] = [];
      for (const v of poses.variants) {
        if (!isObject(v)) return fail(`cast.json role "${role}" has an invalid variant`);
        const vp = {} as Record<Pose, Frame[]>;
        for (const pose of VARIANT_POSES) {
          if (v[pose] === undefined) continue;
          const r = poseFrames(role, pose, v[pose]);
          if (!r.ok) return fail(r.reason);
          vp[pose] = r.value;
        }
        list.push(vp);
      }
      variants[role] = list;
      // v1 keys (variant 0) win when present; a role that only has variants uses variant 0 as its base.
      for (const pose of VARIANT_POSES) if (!rolePoses[pose] && list[0][pose]) rolePoses[pose] = list[0][pose];
    }
    roles[role] = rolePoses;
  }
  const bubble =
    isObject(json.bubble) &&
    isNum(json.bubble.x) &&
    isNum(json.bubble.y) &&
    isNum(json.bubble.w) &&
    isNum(json.bubble.h) &&
    isObject(json.bubble.offset) &&
    isNum(json.bubble.offset.x) &&
    isNum(json.bubble.offset.y)
      ? {
          x: json.bubble.x as number,
          y: json.bubble.y as number,
          w: json.bubble.w as number,
          h: json.bubble.h as number,
          offset: { x: json.bubble.offset.x as number, y: json.bubble.offset.y as number },
        }
      : null;
  if (!bubble) return fail("cast.json bubble is missing or invalid");
  const fallback: Record<string, string> = {};
  if (json.fallback !== undefined) {
    if (!isObject(json.fallback)) return fail("cast.json fallback must be an object");
    for (const [k, v] of Object.entries(json.fallback)) if (typeof v === "string") fallback[k] = v;
  }
  return {
    ok: true,
    value: {
      version: isNum(json.version) ? (json.version as number) : 0,
      cell: cell as number,
      anchor: typeof json.anchor === "string" ? (json.anchor as string) : "bottom-centre",
      roles,
      variants,
      bubble,
      fallback,
    },
  };
}

// ── 2. Built-in placeholder layout (same JSON shape as floor.json) ────────────

/** Native floor size per the contract (one plate, two teams). */
export const FLOOR_NATIVE_WIDTH = 640;
export const FLOOR_NATIVE_HEIGHT = 360;

/** The plate's native size: floor.json `w`/`h` when given, else the 640x360 contract. */
export function floorNativeSize(floor: Pick<FloorModel, "size">): { w: number; h: number } {
  return floor.size ?? { w: FLOOR_NATIVE_WIDTH, h: FLOOR_NATIVE_HEIGHT };
}

/** Built-in placeholder floor.json shape (640x360 floor + 640x200 penthouse + lobby slices). */
export function placeholderFloor(): FloorModel {
  const desk = (x: number, y: number): Rect => ({ x, y, w: 48, h: 36 });
  return {
    teamA: {
      lead: { x: 16, y: 16, w: 48, h: 40 },
      buddyOffice: { x: 200, y: 16, w: 80, h: 48 },
      desks: [desk(16, 140), desk(72, 140), desk(128, 140), desk(16, 220), desk(72, 220), desk(128, 220)],
      lobby: { x: 208, y: 300, w: 72, h: 32 },
    },
    teamB: {
      lead: { x: 576, y: 16, w: 48, h: 40 },
      buddyOffice: { x: 360, y: 16, w: 80, h: 48 },
      desks: [desk(496, 140), desk(440, 140), desk(384, 140), desk(496, 220), desk(440, 220), desk(384, 220)],
      lobby: { x: 360, y: 300, w: 72, h: 32 },
    },
    elevator: {
      doorA: { x: 304, y: 220, w: 14, h: 44 },
      doorB: { x: 322, y: 220, w: 14, h: 44 },
      car: { x: 300, y: 96, w: 40, h: 130 },
    },
    penthouse: {
      plate: "roof",
      w: FLOOR_NATIVE_WIDTH,
      h: 200,
      riffbot: { seat: { x: 48, y: 96, w: 48, h: 40 }, lounge: { x: 16, y: 16, w: 180, h: 120 } },
      overlord: { seat: { x: 544, y: 96, w: 48, h: 40 }, crtWall: { x: 448, y: 16, w: 176, h: 120 } },
      elevatorTop: { x: 300, y: 8, w: 40, h: 160 },
    },
  };
}

/** The validated floor, or the placeholder when floor.json is missing or invalid. */
export function floorOrPlaceholder(json: unknown): FloorModel {
  const v = validateFloor(json);
  return v.ok ? v.value : placeholderFloor();
}

// ── Seats, overflow and tower model ───────────────────────────────────────────

export const DESK_COUNT = 6;
export const LOBBY_MAX_SHOWN = 3;
/** Ride animation length (~2s, a named constant). */
export const RIDE_MS = 2000;
/** Work/needs frames play at about 2 fps. */
export const POSE_FPS = 2;

export type SeatKind = "lead" | "buddyOffice" | "desk" | "lobby" | "tv" | "riffbot" | "overlord";

export type SeatedAgent = {
  agentId: string;
  title: string;
  /** Cast role name (after any member-role → cast-role naming, e.g. brainstorm → "buddy"). */
  role: string;
  pose: Pose;
  /** Look-alike column: castVariant(agentId), the same one the icon uses, so floor sprite = icon. */
  variant: number;
  seat: SeatKind;
  /** 0-based desk slot for `desk` seats. */
  desk?: number;
};

export type TeamFloorPlacement = {
  laneId: string;
  name: string;
  lead: SeatedAgent | null;
  buddy: SeatedAgent | null;
  /** At most DESK_COUNT (or the floor's desk count when buildTower gets a floor), in stable (oldest-spawn-first) order. */
  desks: SeatedAgent[];
  /** F4b: every overflow worker, oldest first, when the floor has a valid `statsTv` (drawn as blips; the lobby is then empty). */
  tv: SeatedAgent[];
  /** At most LOBBY_MAX_SHOWN overflow workers. */
  lobby: SeatedAgent[];
  /** How many more overflow workers than the lobby shows ("+N"). */
  lobbyOverflow: number;
};

export type Floor = {
  /** 0 = the top floor, just below the penthouse. */
  index: number;
  teamA: TeamFloorPlacement;
  /** null on the last floor when there are an odd number of teams. */
  teamB: TeamFloorPlacement | null;
  /** Any needs-you agent on the floor → "!" marker. */
  needsYou: boolean;
};

export type Tower = {
  penthouse: { riffbot: SeatedAgent | null; overlord: SeatedAgent | null };
  floors: Floor[];
};

/** A Team as the tower sees it; F2 maps a Pin → this (lead/buddy/workers). */
export type TowerTeam = {
  laneId: string;
  name: string;
  lead: Member | null;
  buddy: Member | null;
  workers: Member[];
};

export type TowerInput = {
  /** The hub Buddy (RiffBot). */
  hubBuddy: Member | null;
  /** The hub lane's live lead (Overlord). */
  hubLead: Member | null;
  /** Pinned teams in squad pin order, 2 per floor. */
  teams: TowerTeam[];
};

const labelsOf = (m: Pick<Member, "agent">): Record<string, string> => (m.agent.labels ?? {}) as Record<string, string>;

/** Retired leads (old-lead kind, or a former-lead label) are never drawn. */
export function isRetiredLead(m: Pick<Member, "kind" | "agent">): boolean {
  if (m.kind === "old-lead") return true;
  return labelsOf(m).role === "former-lead";
}

const isLiveMember = (m: Member | null | undefined): m is Member =>
  m != null && !m.agent.archivedAt && m.agent.status !== "closed";

/** The cast role name for a member: lead → "lead", Buddy → "buddy", worker → its agentType (else "unknown"). */
export function roleForMember(m: Pick<Member, "kind" | "agentType">): string {
  switch (m.kind) {
    case "lead":
      return "lead";
    case "old-lead":
      return "retired-lead";
    case "brainstorm":
      return "buddy";
    case "worker":
      return m.agentType || "unknown";
  }
}

// ── 5. Pose from state ────────────────────────────────────────────────────────

/** running → work; any needs-you (permission / needs-you / error) → needs; alive-not-running → idle; closed/archived → ride. */
export function poseFor(m: Pick<Member, "agent" | "attention">): Pose {
  const a = m.agent;
  if (a.archivedAt || a.status === "closed") return "ride";
  const kind = kindOfAttention(m);
  if (kind !== null && kind !== "finished") return "needs";
  if (a.status === "running") return "work";
  return "idle";
}

/** Workers are seated only while working or needing you; leads, Buddies, RiffBot and the Overlord sit idle too. */
export const isSeatedWorkerPose = (pose: Pose): boolean => pose === "work" || pose === "needs";

/** Agents present in `prev` but gone from `next`: animate `ride` for ~RIDE_MS, then drop them. */
export function transitionRiders(
  prev: readonly { agent: { id: string } }[],
  next: readonly { agent: { id: string } }[],
): string[] {
  const gone = new Set(next.map((m) => m.agent.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of prev) {
    if (seen.has(m.agent.id)) continue;
    seen.add(m.agent.id);
    if (!gone.has(m.agent.id)) out.push(m.agent.id);
  }
  return out;
}

// ── 6. Role → sprite lookup with fallback ─────────────────────────────────────

/**
 * Frames for a role+pose, following `fallback` when the role (or that pose) is missing. A v2 role picks
 * `variants[variant % n]` (falling back to its base poses when that variant lacks the pose). Null when unresolvable.
 */
export function roleFrames(cast: CastModel, role: string, pose: Pose, variant = 0): Frame[] | null {
  const seen = new Set<string>();
  let cur = role;
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const vs = cast.variants?.[cur];
    const picked = vs && vs.length > 0 ? vs[((variant % vs.length) + vs.length) % vs.length]?.[pose] : undefined;
    const frames = picked && picked.length > 0 ? picked : cast.roles[cur]?.[pose];
    if (frames && frames.length > 0) return frames;
    const next = cast.fallback[cur];
    if (!next) return null;
    cur = next;
  }
}

/** The sprite cell for a role+pose at a frame index (reduced motion → index 0) and variant; null when the role can't resolve. */
export function spriteFrame(cast: CastModel, role: string, pose: Pose, frameIndex = 0, variant = 0): Frame | null {
  const frames = roleFrames(cast, role, pose, variant);
  if (!frames) return null;
  return frames[((frameIndex % frames.length) + frames.length) % frames.length] ?? null;
}

// ── 7. Floor "!" markers ──────────────────────────────────────────────────────

/** Which floor indexes carry a needs-you agent. */
export function needsYouFloors(floors: readonly Floor[]): number[] {
  return floors.filter((f) => f.needsYou).map((f) => f.index);
}

// ── 8. Integer render scale ───────────────────────────────────────────────────

/**
 * The CSS-px scale for the 640-wide native floor: the largest whole *device*-pixel multiple that fits `panelWidth`,
 * `floor(panelWidth * dpr / 640) / dpr` (crisp at any devicePixelRatio, and it fills the column at 4K where whole
 * CSS-px steps leave up to half the width empty). 0 when that is under 1 CSS px (narrower than the native floor).
 */
export function integerScale(panelWidth: number, dpr = 1): number {
  const ratio = Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  if (!Number.isFinite(panelWidth) || panelWidth < FLOOR_NATIVE_WIDTH) return 0;
  const scale = Math.floor((panelWidth * ratio) / FLOOR_NATIVE_WIDTH) / ratio;
  return scale >= 1 ? scale : 0;
}

// ── CRT faces (faces.json, Art10) ─────────────────────────────────────────────

export type FaceBot = "riffbot" | "overlord";
export type FaceMode = "idle" | "blink" | "talk" | "needs" | "lookDown" | "scared" | "smacked" | "dizzy" | "shove";
/** Modes read from faces.json. `idle` is required; every other mode is optional (`lookDown` C2b G4, `scared` C2b G6: Riff while the Overlord is expanded, `shove` RS-c: Riff while his chat window swings into the Overlord, `smacked`/`dizzy` RS-b: the Overlord when Riff's window slams into him / after it closes). Unknown keys are ignored. */
const FACE_MODES: FaceMode[] = ["idle", "blink", "talk", "needs", "lookDown", "scared", "smacked", "dizzy", "shove"];

export type FacesModel = {
  /** Cell size of one face frame in the sheet (128x96). */
  cell: { w: number; h: number };
  fps: number;
  /** Frame counts come from the json, never hardcoded. */
  bots: Partial<Record<FaceBot, Partial<Record<FaceMode, Frame[]>>>>;
  /** Optional per-bot, per-theme gutter colour (`<bot>.bg = {dark, light}`); kept only when both keys are valid colours. */
  bg?: Partial<Record<FaceBot, { dark: string; light: string }>>;
};

/** Conservative CSS colour check (hex, rgb[a]/hsl[a](...), or a plain keyword); nothing that could carry url()/var()/;. */
export const isCssColor = (v: unknown): v is string =>
  typeof v === "string" &&
  (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ||
    /^(?:rgb|hsl)a?\(\s*[-+0-9.%]+(?:\s*[, /]\s*[-+0-9.%]+(?:deg)?){2,3}\s*\)$/i.test(v) ||
    /^[a-z]{3,20}$/i.test(v));

/** Validate faces.json: `cell {w,h}`, `fps`, and per bot a list of frames for idle/blink/talk/needs. */
export function validateFaces(json: unknown): Validation<FacesModel> {
  if (!isObject(json)) return fail("faces.json is not an object");
  const cell = isObject(json.cell) && isNum(json.cell.w) && isNum(json.cell.h) && json.cell.w > 0 && json.cell.h > 0 ? { w: json.cell.w as number, h: json.cell.h as number } : null;
  if (!cell) return fail("faces.json cell must be {w,h}");
  const fps = isNum(json.fps) && json.fps > 0 ? (json.fps as number) : 3;
  const bots: FacesModel["bots"] = {};
  const bg: NonNullable<FacesModel["bg"]> = {};
  for (const bot of ["riffbot", "overlord"] as FaceBot[]) {
    const raw = json[bot];
    if (raw === undefined) continue;
    if (!isObject(raw)) return fail(`faces.json ${bot} is not an object`);
    const modes: Partial<Record<FaceMode, Frame[]>> = {};
    for (const mode of FACE_MODES) {
      if (raw[mode] === undefined) continue;
      const frames = Array.isArray(raw[mode]) ? (raw[mode] as unknown[]).map(frameOf) : [];
      if (frames.length === 0 || frames.some((f) => f === null)) return fail(`faces.json ${bot} ${mode} has no valid frames`);
      modes[mode] = frames as Frame[];
    }
    if (!modes.idle) return fail(`faces.json ${bot} needs an idle face`);
    bots[bot] = modes;
    // Only {dark, light} with both valid; anything else (a plain string, one key, a bad colour) → the whole field is ignored, the CSS variable stays.
    if (isObject(raw.bg) && isCssColor(raw.bg.dark) && isCssColor(raw.bg.light)) bg[bot] = { dark: raw.bg.dark, light: raw.bg.light };
  }
  if (!bots.riffbot && !bots.overlord) return fail("faces.json has neither riffbot nor overlord");
  return { ok: true, value: { cell, fps, bots, ...(Object.keys(bg).length ? { bg } : null) } };
}

/** Face mode: talk while the bot is running, needs on needs-you (pose "needs" already folds kindOfAttention), else blink/idle. No agent → idle. */
export function faceMode(agent: Pick<SeatedAgent, "pose"> | null, blinking = false): FaceMode {
  if (!agent) return "idle";
  if (agent.pose === "needs") return "needs";
  if (agent.pose === "work") return "talk";
  return blinking ? "blink" : "idle";
}

/** C2b G4: once @art ships `lookDown` frames for a bot (the gods watching the tower) it replaces plain idle; until then idle. */
export function idleFaceMode(faces: FacesModel | null, bot: FaceBot): FaceMode {
  return faces?.bots[bot]?.lookDown?.length ? "lookDown" : "idle";
}

/** The face cell for a bot+mode at a tick (falls back to idle when the mode is missing); null when the bot has no faces. */
export function faceFrame(faces: FacesModel, bot: FaceBot, mode: FaceMode, tick = 0): Frame | null {
  const modes = faces.bots[bot];
  const frames = modes?.[mode] ?? modes?.idle;
  if (!frames || frames.length === 0) return null;
  return frames[((tick % frames.length) + frames.length) % frames.length] ?? null;
}

/** Random blink spacing: every 3-8 s (rand in [0,1)), the blink face holds for BLINK_MS. */
export const BLINK_MIN_MS = 3000;
export const BLINK_MAX_MS = 8000;
export const BLINK_MS = 300;
export const nextBlinkDelay = (rand: number): number => Math.round(BLINK_MIN_MS + Math.min(Math.max(rand, 0), 1) * (BLINK_MAX_MS - BLINK_MIN_MS));

export type TopBand = { kind: "screens" | "penthouse"; w: number; h: number; elevatorTop: Rect; front: boolean };

/** The top band: Art10 `screens` when present, else the old `penthouse`, else the placeholder penthouse (old path only when neither exists). */
export function topBand(floor: FloorModel): TopBand {
  if (floor.screens) {
    const s = floor.screens;
    return { kind: "screens", w: s.w, h: s.h, elevatorTop: s.elevatorTop, front: s.front === true };
  }
  const p = floor.penthouse ?? placeholderFloor().penthouse!;
  return { kind: "penthouse", w: p.w, h: p.h, elevatorTop: p.elevatorTop, front: p.front === true };
}

/** Band draw order (3/4 top-down, docs/PLAN_NEON_OFFICE.md "Camera"): plate, y-sorted sprites, front overlay (only when floor.json says so), bubbles. */
export function bandLayers(front: boolean): ("plate" | "sprites" | "front" | "bubbles")[] {
  return front ? ["plate", "sprites", "front", "bubbles"] : ["plate", "sprites", "bubbles"];
}

/** Stable y-sort by anchor: the lower anchor (bigger y) draws later, so it is in front. */
export function sortByAnchorY<T extends { anchor: { y: number } }>(items: readonly T[]): T[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => a.item.anchor.y - b.item.anchor.y || a.i - b.i).map((e) => e.item);
}

/** The sprite anchor point: bottom-centre of a slice (its feet sit on the slice's bottom-centre). */
export function sliceAnchor(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
}

// ── Tower builder ─────────────────────────────────────────────────────────────

/** Spawn order: oldest spawn first (createdAt, then updatedAt, then id for stability). */
function spawnOrder(a: Member, b: Member): number {
  const at = (m: Member): number => {
    const raw = m.agent as { createdAt?: string; updatedAt?: string };
    const t = Date.parse(raw.createdAt ?? raw.updatedAt ?? "");
    return Number.isFinite(t) ? t : Infinity;
  };
  return at(a) - at(b) || a.agent.id.localeCompare(b.agent.id);
}

const seat = (m: Member, seatKind: SeatKind, desk?: number): SeatedAgent => ({
  agentId: m.agent.id,
  title: m.agent.title ?? m.agent.id.slice(0, 8),
  role: roleForMember(m),
  pose: poseFor(m),
  variant: castVariant(m.agent.id),
  seat: seatKind,
  ...(desk !== undefined ? { desk } : {}),
});

/** Desks per row on the floor plate (desks 0-2 top, 3-5 bottom); side-by-side means the same row. */
export const DESKS_PER_ROW = 3;

/**
 * Reorder desk assignment (never the agents' looks) so identical sprites don't sit side by side: fill slots in
 * order, taking the earliest remaining item whose key differs from the left neighbour in the same row; when every
 * remaining item matches, take the earliest anyway. Stable: with no clash the order is unchanged.
 */
export function spreadNeighbours<T>(items: readonly T[], keyOf: (item: T) => string, rowSize = DESKS_PER_ROW): T[] {
  const left = [...items];
  const out: T[] = [];
  while (left.length > 0) {
    const slot = out.length;
    const leftKey = slot % rowSize === 0 ? null : keyOf(out[slot - 1]);
    const at = left.findIndex((it) => leftKey === null || keyOf(it) !== leftKey);
    out.push(left.splice(at < 0 ? 0 : at, 1)[0]);
  }
  return out;
}

function placeTeam(t: TowerTeam, slices?: TeamSlices): TeamFloorPlacement {
  const lead = t.lead && isLiveMember(t.lead) && !isRetiredLead(t.lead) ? seat(t.lead, "lead") : null;
  const buddy = t.buddy && isLiveMember(t.buddy) && !isRetiredLead(t.buddy) ? seat(t.buddy, "buddyOffice") : null;
  // Done workers go home: only running (work) and needs-you workers are seated; an idle worker with
  // no needs-you is "out for the day" (the floor animates its ride, then it is gone).
  const workers = [...(t.workers ?? [])]
    .filter((w): w is Member => isLiveMember(w) && !isRetiredLead(w) && isSeatedWorkerPose(poseFor(w)))
    .sort(spawnOrder);
  const deskCount = slices ? slices.desks.length : DESK_COUNT;
  const desks = spreadNeighbours(workers.slice(0, deskCount).map((w) => seat(w, "desk")), (a) => `${a.role}:${a.variant}`).map((a, i) => ({ ...a, desk: i }));
  const overflow = workers.slice(deskCount);
  // F4b: with a statsTv every overflow worker is a blip on the wall TV; without one, the old lobby + "+N".
  if (slices?.statsTv) {
    return { laneId: t.laneId, name: t.name, lead, buddy, desks, tv: overflow.map((w) => seat(w, "tv")), lobby: [], lobbyOverflow: 0 };
  }
  const lobby = overflow.slice(0, LOBBY_MAX_SHOWN).map((w) => seat(w, "lobby"));
  const lobbyOverflow = Math.max(0, overflow.length - LOBBY_MAX_SHOWN);
  return { laneId: t.laneId, name: t.name, lead, buddy, desks, tv: [], lobby, lobbyOverflow };
}

const needsYouOn = (p: TeamFloorPlacement | null): boolean =>
  p !== null && [p.lead, p.buddy, ...p.desks, ...p.tv, ...p.lobby].some((s) => s && s.pose === "needs");

/** Penthouse first, then floors top-down in squad pin order, 2 teams per floor. With a `floor`, each team's desk count and statsTv come from its slices. */
export function buildTower(input: TowerInput, floor?: FloorModel): Tower {
  const penthouse = {
    riffbot:
      input.hubBuddy && isLiveMember(input.hubBuddy)
        ? { agentId: input.hubBuddy.agent.id, title: input.hubBuddy.agent.title ?? input.hubBuddy.agent.id.slice(0, 8), role: "riffbot", pose: poseFor(input.hubBuddy), variant: castVariant(input.hubBuddy.agent.id), seat: "riffbot" as const }
        : null,
    overlord:
      input.hubLead && isLiveMember(input.hubLead)
        ? { agentId: input.hubLead.agent.id, title: input.hubLead.agent.title ?? input.hubLead.agent.id.slice(0, 8), role: "overlord", pose: poseFor(input.hubLead), variant: castVariant(input.hubLead.agent.id), seat: "overlord" as const }
        : null,
  };
  const floors: Floor[] = [];
  for (let i = 0; i < input.teams.length; i += 2) {
    const teamA = placeTeam(input.teams[i], floor?.teamA);
    const teamB = i + 1 < input.teams.length ? placeTeam(input.teams[i + 1], floor?.teamB) : null;
    floors.push({ index: floors.length, teamA, teamB, needsYou: needsYouOn(teamA) || needsYouOn(teamB) });
  }
  return { penthouse, floors };
}

// ── Stats TV blips (F4b) ──────────────────────────────────────────────────────

/** A blip is a BLIP_PX square; four make a 2x2 cluster, clusters sit on a BLIP_CLUSTER_PITCH grid inside the glass. */
export const BLIP_PX = 3;
export const BLIP_GAP = 1;
export const BLIP_CLUSTER = 2 * BLIP_PX + BLIP_GAP; // 7
export const BLIP_CLUSTER_PITCH = BLIP_CLUSTER + 1; // 8
/** Glass margin, and the bottom strip kept for the heartbeat line + count. */
export const TV_PAD = 2;
export const TV_FOOTER = 6;

export type TvBlip = { agent: SeatedAgent; x: number; y: number; tone: "work" | "needs" };

/** How many blips fit a statsTv glass (clusters of 4, row-major). */
export function tvCapacity(tv: Rect): number {
  const cols = Math.max(0, Math.floor((tv.w - 2 * TV_PAD + 1) / BLIP_CLUSTER_PITCH));
  const rows = Math.max(0, Math.floor((tv.h - TV_PAD - TV_FOOTER + 1) / BLIP_CLUSTER_PITCH));
  return cols * rows * 4;
}

/**
 * Blip positions (TV-local px) for the overflow workers, in the given (spawn) order: fill a 2x2 cluster, then the next
 * cluster along the row, then the next row. Blips past `tvCapacity` are not drawn (the count in the corner stays true).
 */
export function tvBlips(tv: Rect, agents: readonly SeatedAgent[]): TvBlip[] {
  const cols = Math.max(1, Math.floor((tv.w - 2 * TV_PAD + 1) / BLIP_CLUSTER_PITCH));
  return agents.slice(0, tvCapacity(tv)).map((agent, i) => {
    const cluster = Math.floor(i / 4);
    const slot = i % 4;
    return {
      agent,
      x: TV_PAD + (cluster % cols) * BLIP_CLUSTER_PITCH + (slot % 2) * (BLIP_PX + BLIP_GAP),
      y: TV_PAD + Math.floor(cluster / cols) * BLIP_CLUSTER_PITCH + Math.floor(slot / 2) * (BLIP_PX + BLIP_GAP),
      tone: agent.pose === "needs" ? "needs" : "work",
    };
  });
}

/** Blip motion: working pulses (~1Hz, staggered), needs-you blinks pink; reduced motion is a static dot (needs stays pink). */
export function blipMotion(tone: "work" | "needs", reduced: boolean): "none" | "pulse" | "blink" {
  if (reduced) return "none";
  return tone === "needs" ? "blink" : "pulse";
}

/** The 2-digit corner count, capped at 99. */
export const tvCountText = (n: number): string => String(Math.min(99, Math.max(0, Math.trunc(n)))).padStart(2, "0");

// ── HP4: floor paging (one floor per screen, TV-channel < >) ──────────────────

export const FLOOR_INDEX_KEY = "vs.squadFloor.index";
/** CRT blink: collapse to a line, swap the floor, open again. Each half; reduced motion skips both. */
export const FLOOR_BLINK_MS = 100;

/** Keep a floor index inside 0..count-1 (0 when there are no floors or the value is not a number). */
export function clampFloorIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.trunc(count) - 1);
}

/** One step (-1 = previous/up, +1 = next/down). Clamped at the ends: no wrap. */
export function stepFloorIndex(index: number, dir: -1 | 1, count: number): number {
  return clampFloorIndex(clampFloorIndex(index, count) + dir, count);
}

/** The persisted index, clamped to the current tower; junk or absent storage → 0. */
export function parseStoredFloor(raw: string | null | undefined, count: number): number {
  if (raw == null || raw.trim() === "") return 0;
  return clampFloorIndex(Number(raw), count);
}

/** The lift readout: 1-based, two digits ("07"). */
export function floorCounterText(index: number): string {
  return String(Math.max(Math.trunc(index) + 1, 1)).padStart(2, "0");
}

// ── HP6: team-name signs (chrome small font, plate px) ───────────────────────

/** Small chrome font cells are 13 tall with a 10px ink; advances are in sheet px, drawn 1:1 in plate px. */
export type SignText = { text: string; track: 0 | -1; ellipsis: boolean };
const SIGN_INSET = 4; // 2px of plate border either side
const SIGN_ELLIPSIS = "...";

/** Width of `text` in plate px at a tracking (advance + track per glyph, floor 1), plus 2px of trailing outline. */
export function signTextWidth(text: string, adv: (ch: string) => number, track: 0 | -1): number {
  let w = 2;
  for (const ch of text) w += Math.max(adv(ch) + track, 1);
  return w;
}

/**
 * Fit a team name onto a sign `maxW` plate px wide: natural tracking first, then one step tighter, then cut
 * letters and add "..." (the full name stays in the tooltip). Empty names give an empty text.
 */
export function fitSignText(name: string, maxW: number, adv: (ch: string) => number): SignText {
  const text = name.trim().replace(/\s+/g, " ").toUpperCase();
  const room = maxW - SIGN_INSET;
  if (!text) return { text: "", track: 0, ellipsis: false };
  for (const track of [0, -1] as const) if (signTextWidth(text, adv, track) <= room) return { text, track, ellipsis: false };
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const cut = chars.join("").trimEnd() + SIGN_ELLIPSIS;
    if (signTextWidth(cut, adv, -1) <= room) return { text: cut, track: -1, ellipsis: true };
  }
  return { text: SIGN_ELLIPSIS, track: -1, ellipsis: true };
}

/** A dot on the prev arrow when needs-you sits on an earlier floor, on the next arrow when it sits on a later one. */
export function needsYouArrows(floors: readonly Floor[], current: number): { prev: boolean; next: boolean } {
  const idx = needsYouFloors(floors);
  return { prev: idx.some((i) => i < current), next: idx.some((i) => i > current) };
}

/** ←/PgUp page up, →/PgDn page down; modified keys never page. */
export function pagingDir(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): -1 | 0 | 1 {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return 0;
  if (e.key === "ArrowLeft" || e.key === "PageUp") return -1;
  if (e.key === "ArrowRight" || e.key === "PageDown") return 1;
  return 0;
}

/** Paging keys must not fire while the user types (or drives a select / slider). */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Scale for a single floor in a fixed box: a whole device-pixel multiple, never below 1 device px per native px.
 * `zoom` is the root UI zoom (src/uiScale.ts): the box is measured in zoomed CSS px, so a device px is 1 / (dpr x zoom) of a CSS px and the
 * snap must use that product (SS5: at 1080 + UI 150% the old dpr-only snap gave a 1.5x shimmer and a clipped floor).
 * - The largest whole multiple that fits both ways, `k / (dpr x zoom)`, with 1 device px of measuring slack (zoom rounding).
 * - Art rule (FF-ui): no 1/2..1/4 fractions. The hub gives the floor a box of at least floorNeedCssPx (the TVs band yields the height), so a
 *   normal window always lands on k >= 1.
 * - Last resort, only when the box is narrower than the native floor (960 device px wide: a hub column under ~960 / zoom CSS px) or the
 *   caller gives no height room: fit fractionally so the floor is never clipped and never 0. 0 only when there is no width yet.
 */
export function floorFitScale(boxW: number, boxH: number, dpr = 1, nativeW = FLOOR_NATIVE_WIDTH, nativeH = FLOOR_NATIVE_HEIGHT, zoom = 1): number {
  if (!Number.isFinite(boxW) || boxW <= 0) return 0;
  const ratio = (Number.isFinite(dpr) && dpr >= 1 ? dpr : 1) * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const hasH = Number.isFinite(boxH) && boxH > 0;
  const room = (w: number, h: number) => Math.min((w * ratio) / nativeW, hasH ? (h * ratio) / nativeH : Infinity);
  const whole = Math.floor(room(boxW + 1 / ratio, boxH + 1 / ratio) + 1e-9);
  if (whole >= 1) return whole / ratio;
  return room(boxW, boxH) / ratio; // last resort: fractional fit rather than clip or vanish
}

/** The floor plate's art scale against the 640-wide contract (floor.json w / 640): 1.5 for the x1.5 kit. Per-px CSS/TS numbers derive from this. */
export function floorKitScale(size: { w: number }): number {
  return size.w > 0 ? size.w / FLOOR_NATIVE_WIDTH : 1;
}

/**
 * CSS px (in the root-zoomed space) the floor needs to be drawn at 1 device px per native px: native height / (dpr x zoom), rounded up.
 * The hub keeps the floor box at least this tall; the sky TVs band yields the rest. When the column is narrower than the native floor
 * (`colW` CSS px, 0 = unknown) 1x cannot fit sideways anyway (last-resort fractional fit in floorFitScale), so the need shrinks with the
 * width the floor will really be drawn at, and the TVs keep the height the floor cannot use.
 */
export function floorNeedCssPx(nativeH: number, dpr = 1, zoom = 1, colW = 0, nativeW = FLOOR_NATIVE_WIDTH): number {
  const ratio = (Number.isFinite(dpr) && dpr >= 1 ? dpr : 1) * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const sideways = colW > 0 && nativeW > 0 ? Math.min(1, (colW * ratio) / nativeW) : 1;
  return Math.ceil((nativeH * sideways) / ratio);
}

/** A rider's spot over the lift: the first rider stands on the car's centre line (car.x + car.w/2); more alternate either side by 6 contract px x the kit scale. `rise` is the ride travel (12 contract px x kit). */
export function riderSpot(car: Rect, index: number, kit: number): { left: number; top: number; rise: number } {
  const side = index === 0 ? 0 : index % 2 === 1 ? 1 : -1;
  return { left: car.x + car.w / 2 + side * Math.ceil(index / 2) * 6 * kit, top: car.y + car.h - 2 * kit, rise: 12 * kit };
}

// ── FS-b: keyboard-focus selector arrow (floor-cursor.json, Art9) ─────────────

export const FLOOR_CURSOR_JSON_URL = "/office/floor-cursor.json";

export type FloorCursor = { cell: { w: number; h: number }; frames: number; fps: number; anchor: { x: number; y: number } };

export function validateFloorCursor(json: unknown): Validation<FloorCursor> {
  if (!isObject(json)) return { ok: false, reason: "floor-cursor.json is not an object" };
  const pos = (v: unknown): v is number => isNum(v) && v > 0;
  const c = json.cell;
  const a = json.anchor;
  if (!isObject(c) || !pos(c.w) || !pos(c.h)) return { ok: false, reason: "cell must be {w,h} > 0" };
  if (!isObject(a) || !isNum(a.x) || !isNum(a.y)) return { ok: false, reason: "anchor must be {x,y}" };
  if (!pos(json.frames) || !Number.isInteger(json.frames)) return { ok: false, reason: "frames must be an integer > 0" };
  if (!pos(json.fps)) return { ok: false, reason: "fps must be > 0" };
  return { ok: true, value: { cell: { w: c.w, h: c.h }, frames: json.frames, fps: json.fps, anchor: { x: a.x, y: a.y } } };
}

/**
 * Where the arrow cell sits, relative to the seat anchor (floor art px; the band's integer scale multiplies it).
 * The tip (`anchor` pixel of frame 0) lands on seat.x, and the cell sits 1.5 cell-heights above the sprite cell top
 * (FF-ui: clear of tall hair; the old bubble-offset rule put it at -12 and it touched the hair). Derived from cast.cell and floor-cursor.json only.
 */
export function cursorOffset(cast: Pick<CastModel, "cell">, cursor: FloorCursor): { x: number; y: number } {
  return { x: -cursor.anchor.x, y: -cast.cell - Math.round(cursor.cell.h * 1.5) };
}

/** The same placement in the seat button's own box (its top-left is seat − (cell/2, cell)). */
export function cursorInButton(cast: Pick<CastModel, "cell">, cursor: FloorCursor): { left: number; top: number } {
  const o = cursorOffset(cast, cursor);
  return { left: o.x + cast.cell / 2, top: o.y + cast.cell };
}
