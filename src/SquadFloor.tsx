// Squad floor phase 2 — the Hypnospace office tower on the hub page (docs/PLAN_SQUAD_FLOOR_P2.md block F2).
// Pure model lives in src/squadFloorLogic.ts (F1): we only fetch the @art contract, draw the plates and
// sprites, and wire clicks/hover. Nothing about the cast sheet is hardcoded: cell size, frames and the
// bubble all come from cast.json.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { openPinMember } from "./pinFocus";
import { useUiScale } from "./uiScale";
import { chromeSmallAdvance, CHROME_SMALL_CELL_H, chromeSmallCell, chromeSmallGlyphStyle } from "./chromeFont";
import { useImageOk, usePrefersReducedMotion, useTheme, type Theme } from "./useBotFace";
import { gridPinsForSquad, hubPinForSquad, pinsForSquad, type Pin } from "./pins";
import {
  bandLayers,
  blipMotion,
  buildTower,
  clampFloorIndex,
  cursorOffset,
  FLOOR_CURSOR_JSON_URL,
  fetchFloorJson,
  FLOOR_BLINK_MS,
  FLOOR_INDEX_KEY,
  floorCounterText,
  fitSignText,
  signTextWidth,
  floorFitScale,
  floorKitScale,
  riderSpot,
  floorNativeSize,
  floorOrPlaceholder,
  isTypingTarget,
  LOBBY_MAX_SHOWN,
  needsYouArrows,
  pagingDir,
  parseStoredFloor,
  placeholderFloor,
  POSE_FPS,
  RIDE_MS,
  sliceAnchor,
  sortByAnchorY,
  spriteFrame,
  stepFloorIndex,
  tvBlips,
  tvCountText,
  transitionRiders,
  validateCast,
  validateFloorCursor,
  type CastModel,
  type FloorCursor,
  type FloorModel,
  type Frame,
  type Rect,
  type SeatedAgent,
  type TeamFloorPlacement,
  type Tower,
  type TowerTeam,
} from "./squadFloorLogic";
import type { TeamView } from "./teams";

export type SquadFloorProps = {
  view: TeamView;
};

// Theme, reduced-motion, image probing and the CRT faces live in src/useBotFace.ts (the sky zones draw the faces).

// ── Art URLs (the @art contract; hardcode nothing about the sheet itself) ──────
const CAST_URL = (theme: Theme) => `/office/cast-${theme}.png`;
const FLOOR_URL = (theme: Theme) => `/office/floor-${theme}.png`;
const CURSOR_URL = (theme: Theme) => `/office/floor-cursor-${theme}.png`;
const FLOOR_FRONT_URL = (theme: Theme) => `/office/floor-front-${theme}.png`;

// ── Pin → tower mapping (the F1 buildTower is the model; we only supply inputs) ─
function towerTeamOf(pin: Pin): TowerTeam {
  return { laneId: pin.lane.id, name: pin.lane.name, lead: pin.lead, buddy: pin.brainstorm, workers: pin.workers };
}

/** The squad tower from a TeamView: penthouse (RiffBot = hub Buddy, Overlord = hub lead) + floors in pin order. */
export function towerForView(view: TeamView, floor?: FloorModel): Tower {
  const hub = hubPinForSquad(view);
  const { pinned } = gridPinsForSquad(view);
  return buildTower({
    hubBuddy: hub?.brainstorm ?? null,
    hubLead: hub?.lead ?? null,
    teams: pinned.map(towerTeamOf),
  }, floor);
}

/** `floor` is the tower floor index the member sat on (the penthouse bots no longer ride; they live in the sky zones), so its ride starts at that floor's elevator. */
type FlatMember = { agentId: string; title: string; role: string; variant: number; floor: number };
function towerMembers(tower: Tower): FlatMember[] {
  const out: FlatMember[] = [];
  let floor = 0;
  const push = (s: SeatedAgent | null) => s && out.push({ agentId: s.agentId, title: s.title, role: s.role, variant: s.variant, floor });
  const team = (p: TeamFloorPlacement) => {
    push(p.lead);
    push(p.buddy);
    p.desks.forEach(push);
    p.tv.forEach(push);
    p.lobby.forEach(push);
  };
  for (const f of tower.floors) {
    floor = f.index;
    team(f.teamA);
    if (f.teamB) team(f.teamB);
  }
  return out;
}

// ── Small render pieces ────────────────────────────────────────────────────────

const POSE_LABEL: Record<string, string> = { work: "working", needs: "needs you", idle: "idle", ride: "riding" };

type Anchor = { x: number; y: number };
/** One drawable character in a band; the band y-sorts these by anchor. */
type BandItem = { agent: SeatedAgent; anchor: Anchor; onOpen: () => void };

/** The FS-b arrow: the sheet url + its json, only when both loaded (skip-if-absent) and motion is allowed to play. */
type CursorArt = { model: FloorCursor; url: string; reduced: boolean };

type SeatProps = {
  item: BandItem;
  /** Hover / keyboard focus (:focus-visible) reports the seat so the band can draw the selector arrow above the front overlay. */
  onPoint: (kind: "hover" | "focus", agentId: string | null) => void;
  cast: CastModel | null;
  sheet: string | null;
  frameIndex: number;
};

function Seat({ item: { agent, anchor, onOpen }, cast, sheet, frameIndex, onPoint }: SeatProps) {
  const frame: Frame | null = cast ? spriteFrame(cast, agent.role, agent.pose, frameIndex, agent.variant) : null;
  const hasSprite = !!(sheet && frame);
  const status = POSE_LABEL[agent.pose] ?? agent.pose;
  return (
    <button
      type="button"
      className={`sq-floor-char${hasSprite ? "" : " is-fallback"}`}
      data-testid={`sq-floor-char-${agent.agentId}`}
      title={`${agent.title} · ${status}`}
      style={{ left: anchor.x, top: anchor.y, ...(cast ? { width: cast.cell, height: cast.cell } : {}) }}
      onClick={onOpen}
      onMouseEnter={() => onPoint("hover", agent.agentId)}
      onMouseLeave={() => onPoint("hover", null)}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && onPoint("focus", agent.agentId)}
      onBlur={() => onPoint("focus", null)}
    >
      {hasSprite ? (
        <span
          className="sq-floor-sprite"
          style={{ backgroundImage: `url(${sheet})`, backgroundPosition: `-${frame.x}px -${frame.y}px` }}
        />
      ) : (
        <span className="sq-floor-sprite sq-floor-sprite-fallback" />
      )}
    </button>
  );
}

/** The FS-b selector arrow, drawn in the bubbles layer (above the front overlay) over the hovered / keyboard-focused seat. */
function SeatCursor({ anchor, cast, cursor }: { anchor: Anchor; cast: CastModel; cursor: CursorArt }) {
  const at = cursorOffset(cast, cursor.model);
  return (
    <span
      className="sq-floor-cursor"
      aria-hidden="true"
      style={
        {
          left: anchor.x + at.x,
          top: anchor.y + at.y,
          width: cursor.model.cell.w,
          height: cursor.model.cell.h,
          backgroundImage: `url(${cursor.url})`,
          "--cur-w": `${cursor.model.cell.w}px`,
          "--cur-frames": cursor.model.frames,
          ...(cursor.reduced ? { animation: "none" } : { animationDuration: `${cursor.model.frames / cursor.model.fps}s` }),
        } as unknown as CSSProperties
      }
    />
  );
}

/** The needs-you bubble; drawn above the front overlay so it is never hidden. */
function SeatBubble({ item: { agent, anchor }, cast, sheet }: { item: BandItem; cast: CastModel | null; sheet: string | null }) {
  const frame: Frame | null = cast ? spriteFrame(cast, agent.role, agent.pose, 0, agent.variant) : null;
  if (agent.pose !== "needs" || !cast || !sheet || !frame) return null;
  return (
    <span
      className="sq-floor-bubble"
      aria-hidden="true"
      style={{
        left: anchor.x + cast.bubble.offset.x,
        top: anchor.y + cast.bubble.offset.y,
        width: cast.bubble.w,
        height: cast.bubble.h,
        backgroundImage: `url(${sheet})`,
        backgroundPosition: `-${cast.bubble.x}px -${cast.bubble.y}px`,
      }}
    />
  );
}

/**
 * One band in 3/4 top-down draw order (bandLayers): plate → y-sorted sprites → front overlay → bubbles.
 * The front overlay is `pointer-events: none`, so character clicks pass through it.
 */
function Band({
  plate,
  wall,
  items,
  extras,
  overlays,
  frontSrc,
  cast,
  sheet,
  frameIndex,
  cursor,
}: {
  plate: ReactNode;
  /** Wall fixtures (the stats TV): drawn right after the plate, under the sprites and the front overlay. */
  wall?: ReactNode;
  items: BandItem[];
  extras?: ReactNode;
  /** Drawn in the bubbles layer, above the front overlay (needs indicators, +N). */
  overlays?: ReactNode;
  frontSrc: string | null;
  cast: CastModel | null;
  sheet: string | null;
  frameIndex: number;
  cursor: CursorArt | null;
}) {
  const sorted = sortByAnchorY(items);
  // Hover and keyboard focus are tracked apart: leaving with the mouse must not hide the arrow of a seat that still has :focus-visible.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pointed = hoveredId ?? focusedId;
  const onPoint = (kind: "hover" | "focus", id: string | null) => (kind === "hover" ? setHoveredId(id) : setFocusedId(id));
  const pointedItem = cursor && cast ? sorted.find((it) => it.agent.agentId === pointed) : undefined;
  const layers = bandLayers(!!frontSrc);
  return (
    <>
      {layers.map((layer) => {
        switch (layer) {
          case "plate":
            return <span key={layer} style={{ display: "contents" }}>{plate}{wall}</span>;
          case "sprites":
            return (
              <span key={layer} style={{ display: "contents" }}>
                {sorted.map((it) => (
                  <Seat key={it.agent.agentId} item={it} cast={cast} sheet={sheet} frameIndex={frameIndex} onPoint={onPoint} />
                ))}
                {extras}
              </span>
            );
          case "front":
            return <img key={layer} className="sq-floor-front" src={frontSrc!} alt="" draggable={false} />;
          case "bubbles":
            return (
              <span key={layer} style={{ display: "contents" }}>
                {sorted.map((it) => (
                  <SeatBubble key={it.agent.agentId} item={it} cast={cast} sheet={sheet} />
                ))}
                {pointedItem && cast && cursor && <SeatCursor anchor={pointedItem.anchor} cast={cast} cursor={cursor} />}
                {overlays}
              </span>
            );
        }
      })}
    </>
  );
}

/** HP6: a team name lettered onto its painted sign plate with the small chrome font (1 sheet px = 1 plate px, so it stays crisp at any integer floor scale). */
function TeamSign({ sign, name, testId }: { sign?: Rect; name: string | null; testId: string }) {
  if (!sign) return null;
  const vacant = name === null;
  const label = vacant ? "VACANT" : name;
  const fit = fitSignText(label, sign.w, chromeSmallAdvance);
  // The 13px glyph cells stay 1:1 (the sign rect is 16 tall, so x1.5 would not fit); when the name fits with the cells butted edge to edge
  // (no negative margins, no overlapping outlines) it is drawn that way, else it keeps the tracked/tight fit.
  const open = !fit.ellipsis && signTextWidth(fit.text, chromeSmallCell, 0) <= sign.w - 2;
  const used = [...fit.text].reduce((n, ch) => n + (open ? chromeSmallCell(ch) : Math.max(chromeSmallAdvance(ch) + fit.track, 1)), 0);
  const top = Math.floor((sign.h - CHROME_SMALL_CELL_H) / 2); // centred in the rect (floor.json), not a fixed -1
  return (
    <span
      className={`sq-floor-sign${vacant ? " is-vacant" : ""}`}
      data-testid={testId}
      data-fit={fit.ellipsis ? "ellipsis" : open ? "open" : fit.track ? "tight" : "full"}
      role="img"
      aria-label={vacant ? "No team on this side" : name}
      title={vacant ? "No team on this side" : name}
      style={{ left: sign.x, top: sign.y, width: sign.w, height: sign.h }}
    >
      <span className="sq-floor-sign-text" aria-hidden="true" style={{ left: Math.max(Math.floor((sign.w - used) / 2), 1), top }}>
        {[...fit.text].map((ch, i) => {
          const st = chromeSmallGlyphStyle(ch, fit.track, open);
          return st ? <span key={i} className="sq-floor-sign-glyph" style={st} /> : null;
        })}
      </span>
    </span>
  );
}

/** HP6: while someone rides, the closed doors painted on the plate would hide the rider, so draw the doors open on the car interior. */
function LiftOpen({ doorA, doorB, car, kit }: { doorA: Rect; doorB: Rect; car: Rect; kit: number }) {
  // Covers the painted closed doors edge to edge (the whole door height, no closed-door strip left under it); every number is a floor.json rect.
  const x = doorA.x;
  const w = doorB.x + doorB.w - doorA.x;
  const panel = { width: Math.round(3 * kit) };
  return (
    <span className="sq-floor-lift-open" data-testid="sq-floor-lift-open" aria-hidden="true" style={{ left: x, top: doorA.y, width: w, height: doorA.h }}>
      <span className="sq-floor-lift-open-car" style={{ left: car.x - x, top: car.y - doorA.y, width: car.w, height: car.h }} />
      <span className="sq-floor-lift-open-door is-left" style={panel} />
      <span className="sq-floor-lift-open-door is-right" style={panel} />
    </span>
  );
}

function LiftPager({ elevator, current, count, arrows, onPrev, onNext }: { elevator: FloorModel["elevator"]; current: number; count: number; arrows: { prev: boolean; next: boolean }; onPrev: () => void; onNext: () => void }) {
  const { counter, callPrev, callNext } = elevator;
  const at = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });
  return (
    <span className="sq-floor-lift" role="group" aria-label="Lift: change floor" data-testid="sq-floor-lift">
      {counter && (
        <span className="sq-floor-counter" data-testid="sq-floor-counter" aria-live="polite" aria-label={`Floor ${floorCounterText(current)} of ${count}`} style={at(counter)}>
          {floorCounterText(current)}
        </span>
      )}
      {callPrev && (
        <button
          type="button"
          className={`sq-floor-arrow${arrows.prev ? " has-needs" : ""}`}
          data-testid="sq-floor-prev"
          aria-label={arrows.prev ? "Previous floor (someone needs you up there)" : "Previous floor"}
          title="Previous floor (←)"
          disabled={current <= 0}
          style={at(callPrev)}
          onClick={onPrev}
        />
      )}
      {callNext && (
        <button
          type="button"
          className={`sq-floor-arrow${arrows.next ? " has-needs" : ""}`}
          data-testid="sq-floor-next"
          aria-label={arrows.next ? "Next floor (someone needs you down there)" : "Next floor"}
          title="Next floor (→)"
          disabled={current >= count - 1}
          style={at(callNext)}
          onClick={onNext}
        />
      )}
    </span>
  );
}

function teamItems(placement: TeamFloorPlacement, slices: FloorModel["teamA"], onOpen: (agentId: string) => void): BandItem[] {
  const out: BandItem[] = [];
  const add = (agent: SeatedAgent | null, anchor: Anchor | null) => {
    if (agent && anchor) out.push({ agent, anchor, onOpen: () => onOpen(agent.agentId) });
  };
  add(placement.lead, sliceAnchor(slices.lead));
  add(placement.buddy, sliceAnchor(slices.buddyOffice));
  placement.desks.forEach((d, i) => {
    const rect = slices.desks[d.desk ?? i];
    add(d, rect ? sliceAnchor(rect) : null);
  });
  const lobby = slices.lobby;
  placement.lobby.forEach((l, i) => {
    if (!lobby) return;
    const step = lobby.w / LOBBY_MAX_SHOWN;
    add(l, { x: lobby.x + step * (i + 0.5), y: lobby.y + lobby.h });
  });
  return out;
}

function LobbyPlus({ placement, lobby }: { placement: TeamFloorPlacement; lobby?: Rect }) {
  if (placement.lobbyOverflow <= 0 || !lobby) return null;
  return (
    <span className="sq-floor-plus" style={{ left: lobby.x + lobby.w + 4, top: lobby.y + lobby.h }}>
      +{placement.lobbyOverflow}
    </span>
  );
}

/**
 * F4b: overflow workers as blips inside the stats TV glass. One focusable button per blip (aria-label + tooltip),
 * click opens that agent like a seated worker. No overflow → a dim idle scanline; the TV never disappears.
 */
function StatsTv({ placement, tv, reduced, onOpen }: { placement: TeamFloorPlacement; tv?: Rect; reduced: boolean; onOpen: (agentId: string) => void }) {
  if (!tv) return null;
  const blips = tvBlips(tv, placement.tv);
  return (
    <span
      className={`sq-floor-tv${placement.tv.length ? "" : " is-idle"}${reduced ? " is-reduced" : ""}`}
      data-testid={`sq-floor-tv-${placement.laneId}`}
      role="group"
      aria-label={`Overflow workers: ${placement.tv.length}`}
      style={{ left: tv.x, top: tv.y, width: tv.w, height: tv.h }}
    >
      {blips.map(({ agent, x, y, tone }, i) => {
        const status = POSE_LABEL[agent.pose] ?? agent.pose;
        const motion = blipMotion(tone, reduced);
        return (
          <button
            key={agent.agentId}
            type="button"
            className={`sq-floor-blip ${tone === "needs" ? "is-needs" : "is-work"}${motion === "blink" ? " is-blink" : motion === "pulse" ? " is-pulse" : ""}`}
            data-testid={`sq-floor-blip-${agent.agentId}`}
            aria-label={`${agent.title}, ${status}`}
            title={`${agent.title} · ${status}`}
            style={{ left: x, top: y, animationDelay: `${(i % 7) * -140}ms` }}
            onClick={() => onOpen(agent.agentId)}
          />
        );
      })}
      <span className="sq-floor-tv-beat" aria-hidden="true" />
      {placement.tv.length > 0 && (
        <span className="sq-floor-tv-count" aria-hidden="true">
          {tvCountText(placement.tv.length)}
        </span>
      )}
    </span>
  );
}

function PlateBoxes({ rects, className }: { rects: Rect[]; className?: string }) {
  return (
    <>
      {rects.map((r, i) => (
        <span key={i} className={`sq-floor-box ${className ?? ""}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      ))}
    </>
  );
}

type ImageState = "loading" | "ok" | "error";

/** Like useImageOk, but tells "still loading" from "failed" (the error fallback must not flash while the art loads). */
function useImageState(url: string): ImageState {
  const [state, setState] = useState<{ url: string; s: ImageState }>({ url, s: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ url, s: "loading" });
    const img = new Image();
    img.onload = () => alive && setState({ url, s: "ok" });
    img.onerror = () => alive && setState({ url, s: "error" });
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return state.url === url ? state.s : "loading";
}

function readStoredFloor(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(FLOOR_INDEX_KEY);
  } catch {
    return null;
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SquadFloor({ view }: SquadFloorProps) {
  const hub = useMemo(() => hubPinForSquad(view), [view]);
  const pinsByLane = useMemo(() => {
    const { pinned, done } = pinsForSquad(view);
    const map = new Map<string, Pin>();
    for (const p of [...pinned, ...done]) map.set(p.lane.id, p);
    if (hub) map.set(hub.lane.id, hub);
    return map;
  }, [view, hub]);

  const theme = useTheme();
  const reduced = usePrefersReducedMotion();

  const [floor, setFloor] = useState<FloorModel>(() => placeholderFloor());
  const [cast, setCast] = useState<CastModel | null>(null);
  const [cursorModel, setCursorModel] = useState<FloorCursor | null>(null);
  // The tower follows the loaded floor: desk count and statsTv (overflow → blips) come from floor.json.
  const tower = useMemo(() => towerForView(view, floor), [view, floor]);

  // The plate is "loading" until it settles: only a failed load shows the placeholder boxes (a loading one shows nothing, no flash of bare boxes).
  const floorArt = useImageState(FLOOR_URL(theme));
  const castImgOk = useImageOk(CAST_URL(theme));
  // Front overlays are opt-in per floor.json (`"front": true`); absent → skip. The image starts loading with the JSON, not after it.
  const floorFrontImgOk = useImageOk(FLOOR_FRONT_URL(theme));
  const floorFrontOk = floorFrontImgOk && !!floor.front;
  const sheet = cast && castImgOk ? CAST_URL(theme) : null;
  const cursorImgOk = useImageOk(CURSOR_URL(theme));
  const cursor: CursorArt | null = cast && cursorModel && cursorImgOk ? { model: cursorModel, url: CURSOR_URL(theme), reduced } : null;

  // Load the art JSON; missing/invalid → F1 placeholder layout (and no sprites when cast.json is absent).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchFloorJson(),
      fetch(FLOOR_CURSOR_JSON_URL)
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined),
      fetch("/office/cast.json")
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined),
    ]).then(([floorJson, cursorJson, castJson]) => {
      if (cancelled) return;
      setFloor(floorOrPlaceholder(floorJson));
      const v = validateCast(castJson);
      setCast(v.ok ? v.value : null);
      const cv = validateFloorCursor(cursorJson);
      setCursorModel(cv.ok ? cv.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Measure the stage (the box left over above the lift bar): the floor scales to fit both ways, never scrolls.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setBox({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Device-pixel integer scale: re-measure on zoom / monitor change (both fire `resize`).
  const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const uiZoom = useUiScale();
  const native = floorNativeSize(floor);
  const scale = floorFitScale(box.w, box.h, dpr, native.w, native.h, uiZoom);

  // HP4 paging: one floor per screen, persisted; `blink` is the CRT collapse (out) / open (in) around the swap.
  const floorCount = tower.floors.length;
  const [storedIdx, setStoredIdx] = useState(() => parseStoredFloor(readStoredFloor(), Number.MAX_SAFE_INTEGER));
  const current = clampFloorIndex(storedIdx, floorCount);
  const [blink, setBlink] = useState<"out" | "in" | null>(null);
  const busyRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const goRef = useRef<(dir: -1 | 1) => void>(() => {});
  goRef.current = (dir) => {
    const next = stepFloorIndex(current, dir, floorCount);
    if (next === current || busyRef.current) return;
    const commit = () => {
      setStoredIdx(next);
      try {
        localStorage.setItem(FLOOR_INDEX_KEY, String(next));
      } catch {
        /* storage blocked: paging still works, it just will not persist */
      }
    };
    if (reduced) return commit();
    busyRef.current = true;
    setBlink("out");
    timers.current.push(
      setTimeout(() => {
        commit();
        setBlink("in");
        timers.current.push(
          setTimeout(() => {
            setBlink(null);
            busyRef.current = false;
          }, FLOOR_BLINK_MS),
        );
      }, FLOOR_BLINK_MS),
    );
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = pagingDir(e);
      if (!dir || e.defaultPrevented || isTypingTarget(e.target as HTMLElement | null)) return;
      e.preventDefault();
      goRef.current(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const arrows = needsYouArrows(tower.floors, current);

  // Work/needs frames play at POSE_FPS; reduced motion freezes on frame 0.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setTick((n) => n + 1), Math.round(1000 / POSE_FPS));
    return () => clearInterval(t);
  }, [reduced]);
  const frameIndex = reduced ? 0 : tick;

  // Closed/archived agents ride the elevator for RIDE_MS on the transition, then vanish.
  type Rider = FlatMember & { start: number };
  const prevMembersRef = useRef<FlatMember[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  useEffect(() => {
    const next = towerMembers(tower);
    const prev = prevMembersRef.current;
    const gone = reduced
      ? []
      : transitionRiders(
          prev.map((m) => ({ agent: { id: m.agentId } })),
          next.map((m) => ({ agent: { id: m.agentId } })),
        );
    if (gone.length) {
      const byId = new Map(prev.map((m) => [m.agentId, m]));
      const start = Date.now();
      setRiders((rs) => [...rs, ...gone.map((id) => ({ start, ...(byId.get(id) ?? { agentId: id, title: id.slice(0, 8), role: "unknown", variant: 0, floor: -1 }) }))]);
    }
    prevMembersRef.current = next;
  }, [tower, reduced]);
  useEffect(() => {
    if (!riders.length) return;
    // Each rider expires at its own start + RIDE_MS; the timer targets the earliest one.
    const nextExpiry = Math.min(...riders.map((r) => r.start + RIDE_MS));
    const t = setTimeout(() => {
      const now = Date.now();
      setRiders((rs) => rs.filter((r) => now < r.start + RIDE_MS));
    }, Math.max(0, nextExpiry - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [riders]);

  const openAgent = useCallback(
    (laneId: string, agentId: string) => {
      const pin = pinsByLane.get(laneId);
      if (pin) openPinMember(pin, agentId);
    },
    [pinsByLane],
  );

  // A rider starts at the elevator of the floor it sat on and rises for RIDE_MS.
  const ridersOn = (floorIndex: number, elevator: Rect): ReactNode =>
    riders
      .filter((r) => r.floor === floorIndex)
      .map((r, i) => {
        const frame = cast ? spriteFrame(cast, r.role, "ride", 0, r.variant) : null;
        const spot = riderSpot(elevator, i, floorKitScale(native));
        return (
          <span
            key={r.agentId}
            className="sq-floor-rider"
            title={`${r.title} · riding`}
            style={
              {
                left: spot.left,
                top: spot.top,
                "--ride-rise": `${spot.rise}px`,
                animationDuration: `${RIDE_MS}ms`,
                ...(cast ? { width: cast.cell, height: cast.cell } : {}),
              } as CSSProperties
            }
          >
            {sheet && frame ? (
              <span className="sq-floor-sprite" style={{ backgroundImage: `url(${sheet})`, backgroundPosition: `-${frame.x}px -${frame.y}px` }} />
            ) : (
              <span className="sq-floor-sprite sq-floor-sprite-fallback" />
            )}
          </span>
        );
      });

  const bandStyle = (w: number, h: number): CSSProperties => ({
    width: w,
    height: h,
    ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: "top left" } : {}),
  });

  const towerScale = (w: number, h: number): CSSProperties => ({ width: w * scale, height: h * scale });

  const floorBoxes: ReactNode = (
    <>
      <PlateBoxes rects={[floor.teamA.lead, floor.teamA.buddyOffice, ...floor.teamA.desks, ...(floor.teamA.lobby ? [floor.teamA.lobby] : [])]} />
      <PlateBoxes rects={[floor.teamB.lead, floor.teamB.buddyOffice, ...floor.teamB.desks, ...(floor.teamB.lobby ? [floor.teamB.lobby] : [])]} />
      <PlateBoxes className="sq-floor-box-tv" rects={[...(floor.teamA.statsTv ? [floor.teamA.statsTv] : []), ...(floor.teamB.statsTv ? [floor.teamB.statsTv] : [])]} />
      <PlateBoxes className="sq-floor-box-elevator" rects={[floor.elevator.car, floor.elevator.doorA, floor.elevator.doorB]} />
    </>
  );

  return (
    <section className="sq-floor" data-testid="squad-floor" aria-label="Squad floor" >
      <div className="sq-floor-stage" ref={stageRef}>
        {scale > 0 && (
        <div className="sq-floor-tower">
          {/* One floor per screen (squad pin order, two teams per floor); < > in the lift bar page it. */}
          {tower.floors.slice(current, current + 1).map((f) => (
            <div
              key={f.index}
              className={`sq-floor-band-wrap${blink ? ` is-blink-${blink}` : ""}`}
              data-testid="sq-floor-page"
              data-floor={f.index}
              style={towerScale(native.w, native.h)}
            >
              <div className="sq-floor-band" style={bandStyle(native.w, native.h)}>
                <Band
                  cast={cast}
                  sheet={sheet}
                  frameIndex={frameIndex}
                  cursor={cursor}
                  frontSrc={floorFrontOk ? FLOOR_FRONT_URL(theme) : null}
                  items={[
                    ...teamItems(f.teamA, floor.teamA, (agentId) => openAgent(f.teamA.laneId, agentId)),
                    ...(f.teamB ? teamItems(f.teamB, floor.teamB, (agentId) => openAgent(f.teamB!.laneId, agentId)) : []),
                  ]}
                  plate={
                    floorArt === "ok" ? (
                      <img className="sq-floor-plate" src={FLOOR_URL(theme)} alt="" draggable={false} style={{ width: native.w, height: native.h }} />
                    ) : floorArt === "error" ? (
                      floorBoxes
                    ) : null
                  }
                  wall={
                    <>
                      <StatsTv placement={f.teamA} tv={floor.teamA.statsTv} reduced={reduced} onOpen={(id) => openAgent(f.teamA.laneId, id)} />
                      {f.teamB && <StatsTv placement={f.teamB} tv={floor.teamB.statsTv} reduced={reduced} onOpen={(id) => openAgent(f.teamB!.laneId, id)} />}
                      {riders.some((r) => r.floor === f.index) && <LiftOpen doorA={floor.elevator.doorA} doorB={floor.elevator.doorB} car={floor.elevator.car} kit={floorKitScale(native)} />}
                    </>
                  }
                  extras={ridersOn(f.index, floor.elevator.car)}
                  overlays={
                    <>
                      <LobbyPlus placement={f.teamA} lobby={floor.teamA.lobby} />
                      {f.teamB && <LobbyPlus placement={f.teamB} lobby={floor.teamB.lobby} />}
                      <TeamSign sign={floor.teamA.sign} name={f.teamA.name} testId="sq-floor-sign-a" />
                      <TeamSign sign={floor.teamB.sign} name={f.teamB ? f.teamB.name : null} testId="sq-floor-sign-b" />
                      {floorCount > 0 && <LiftPager elevator={floor.elevator} current={current} count={floorCount} arrows={arrows} onPrev={() => goRef.current(-1)} onNext={() => goRef.current(1)} />}
                    </>
                  }
                />
              </div>
              {f.needsYou && (
                <span className="sq-floor-mark" data-testid={`sq-floor-mark-${f.index}`} title="Someone needs you on this floor">
                  !
                </span>
              )}
            </div>
          ))}
        </div>
        )}
      </div>
    </section>

  );
}
