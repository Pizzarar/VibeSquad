// Squad floor Phase 2 — pure model (docs/PLAN_SQUAD_FLOOR_P2.md block F1).
// No React, no DOM: load/validate floor+cast JSON, placeholder layout, seat assignment,
// overflow, pose from agent state, ride transitions, role→sprite fallback, floor "!" markers
// and the integer render scale. The tower UI (F2, src/SquadFloor.tsx) draws this.
// Imports stay pure: kindOfAttention is shared with the badge/queue logic; teams.ts / pins.ts
// are imported type-only so node --test never loads React.

import { kindOfAttention } from "./attentionItems.ts";
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

export type FloorModel = {
  teamA: TeamSlices;
  teamB: TeamSlices;
  elevator: { doorA: Rect; doorB: Rect; car: Rect };
  /** Present once S1 lands; the placeholder supplies one meanwhile. */
  penthouse?: PenthouseModel;
  /** `floor-front-{theme}.png` exists and is drawn over the y-sorted sprites (floor.json `"front": true`). */
  front?: boolean;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
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
  return { lead, buddyOffice, desks, ...(lobby ? { lobby } : {}) };
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

/** Validate floor.json. Unknown extra fields are ignored; `lobby` and `penthouse` are optional (S1 growth). */
export function validateFloor(json: unknown): Validation<FloorModel> {
  if (!isObject(json)) return fail("floor.json is not an object");
  const teamA = teamSlicesOf(json.teamA);
  if (!teamA) return fail("floor.json teamA is missing lead, buddyOffice or desks");
  const teamB = teamSlicesOf(json.teamB);
  if (!teamB) return fail("floor.json teamB is missing lead, buddyOffice or desks");
  const elevator =
    isObject(json.elevator) && rectOf(json.elevator.doorA) && rectOf(json.elevator.doorB) && rectOf(json.elevator.car)
      ? { doorA: rectOf(json.elevator.doorA)!, doorB: rectOf(json.elevator.doorB)!, car: rectOf(json.elevator.car)! }
      : null;
  if (!elevator) return fail("floor.json elevator is missing doorA, doorB or car");
  const penthouse = penthouseOf(json.penthouse);
  return { ok: true, value: { teamA, teamB, elevator, ...(penthouse ? { penthouse } : {}), ...(json.front === true ? { front: true } : {}) } };
}

/** Validate cast.json. Unknown roles/poses/fields are kept; `fallback` may be `{}`; nothing about the sheet is hardcoded. */
export function validateCast(json: unknown): Validation<CastModel> {
  if (!isObject(json)) return fail("cast.json is not an object");
  const cell = json.cell;
  if (!isNum(cell) || cell <= 0) return fail("cast.json cell must be a positive number");
  if (!isObject(json.roles) || Object.keys(json.roles).length === 0) return fail("cast.json roles is missing or empty");
  const roles: Record<string, Record<Pose, Frame[]>> = {};
  for (const [role, poses] of Object.entries(json.roles)) {
    if (!isObject(poses)) return fail(`cast.json role "${role}" is not an object`);
    const rolePoses = {} as Record<Pose, Frame[]>;
    for (const [pose, frames] of Object.entries(poses)) {
      if (!Array.isArray(frames) || frames.length === 0) return fail(`cast.json role "${role}" pose "${pose}" has no frames`);
      const cells: Frame[] = [];
      for (const f of frames) {
        const frame = frameOf(f);
        if (!frame) return fail(`cast.json role "${role}" pose "${pose}" has an invalid frame`);
        cells.push(frame);
      }
      rolePoses[pose as Pose] = cells;
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
      bubble,
      fallback,
    },
  };
}

// ── 2. Built-in placeholder layout (same JSON shape as floor.json) ────────────

/** Native floor size per the contract (one plate, two teams). */
export const FLOOR_NATIVE_WIDTH = 640;
export const FLOOR_NATIVE_HEIGHT = 360;

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

export type SeatKind = "lead" | "buddyOffice" | "desk" | "lobby" | "riffbot" | "overlord";

export type SeatedAgent = {
  agentId: string;
  title: string;
  /** Cast role name (after any member-role → cast-role naming, e.g. brainstorm → "buddy"). */
  role: string;
  pose: Pose;
  seat: SeatKind;
  /** 0-based desk slot for `desk` seats. */
  desk?: number;
};

export type TeamFloorPlacement = {
  laneId: string;
  name: string;
  lead: SeatedAgent | null;
  buddy: SeatedAgent | null;
  /** At most DESK_COUNT, in stable (oldest-spawn-first) order. */
  desks: SeatedAgent[];
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

/** Frames for a role+pose, following `fallback` when the role (or that pose) is missing. Null when unresolvable. */
export function roleFrames(cast: CastModel, role: string, pose: Pose): Frame[] | null {
  const seen = new Set<string>();
  let cur = role;
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const frames = cast.roles[cur]?.[pose];
    if (frames && frames.length > 0) return frames;
    const next = cast.fallback[cur];
    if (!next) return null;
    cur = next;
  }
}

/** The sprite cell for a role+pose at a frame index (reduced motion → index 0); null when the role can't resolve. */
export function spriteFrame(cast: CastModel, role: string, pose: Pose, frameIndex = 0): Frame | null {
  const frames = roleFrames(cast, role, pose);
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
  seat: seatKind,
  ...(desk !== undefined ? { desk } : {}),
});

function placeTeam(t: TowerTeam): TeamFloorPlacement {
  const lead = t.lead && isLiveMember(t.lead) && !isRetiredLead(t.lead) ? seat(t.lead, "lead") : null;
  const buddy = t.buddy && isLiveMember(t.buddy) && !isRetiredLead(t.buddy) ? seat(t.buddy, "buddyOffice") : null;
  const workers = [...(t.workers ?? [])]
    .filter((w): w is Member => isLiveMember(w) && !isRetiredLead(w))
    .sort(spawnOrder);
  const desks = workers.slice(0, DESK_COUNT).map((w, i) => seat(w, "desk", i));
  const overflow = workers.slice(DESK_COUNT);
  const lobby = overflow.slice(0, LOBBY_MAX_SHOWN).map((w) => seat(w, "lobby"));
  const lobbyOverflow = Math.max(0, overflow.length - LOBBY_MAX_SHOWN);
  return { laneId: t.laneId, name: t.name, lead, buddy, desks, lobby, lobbyOverflow };
}

const needsYouOn = (p: TeamFloorPlacement | null): boolean =>
  p !== null && [p.lead, p.buddy, ...p.desks, ...p.lobby].some((s) => s && s.pose === "needs");

/** Penthouse first, then floors top-down in squad pin order, 2 teams per floor. */
export function buildTower(input: TowerInput): Tower {
  const penthouse = {
    riffbot:
      input.hubBuddy && isLiveMember(input.hubBuddy)
        ? { agentId: input.hubBuddy.agent.id, title: input.hubBuddy.agent.title ?? input.hubBuddy.agent.id.slice(0, 8), role: "riffbot", pose: poseFor(input.hubBuddy), seat: "riffbot" as const }
        : null,
    overlord:
      input.hubLead && isLiveMember(input.hubLead)
        ? { agentId: input.hubLead.agent.id, title: input.hubLead.agent.title ?? input.hubLead.agent.id.slice(0, 8), role: "overlord", pose: poseFor(input.hubLead), seat: "overlord" as const }
        : null,
  };
  const floors: Floor[] = [];
  for (let i = 0; i < input.teams.length; i += 2) {
    const teamA = placeTeam(input.teams[i]);
    const teamB = i + 1 < input.teams.length ? placeTeam(input.teams[i + 1]) : null;
    floors.push({ index: floors.length, teamA, teamB, needsYou: needsYouOn(teamA) || needsYouOn(teamB) });
  }
  return { penthouse, floors };
}
