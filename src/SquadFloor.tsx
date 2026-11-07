// Squad floor phase 2 — the Hypnospace office tower on the hub page (docs/PLAN_SQUAD_FLOOR_P2.md block F2).
// Pure model lives in src/squadFloorLogic.ts (F1): we only fetch the @art contract, draw the plates and
// sprites, and wire clicks/hover. Nothing about the cast sheet is hardcoded: cell size, frames and the
// bubble all come from cast.json.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { openPinMember } from "./pinFocus";
import { gridPinsForSquad, hubPinForSquad, pinsForSquad, type Pin } from "./pins";
import {
  bandLayers,
  buildTower,
  FLOOR_NATIVE_HEIGHT,
  FLOOR_NATIVE_WIDTH,
  floorOrPlaceholder,
  integerScale,
  LOBBY_MAX_SHOWN,
  placeholderFloor,
  POSE_FPS,
  RIDE_MS,
  sliceAnchor,
  sortByAnchorY,
  spriteFrame,
  transitionRiders,
  validateCast,
  type CastModel,
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
  /** The same handler HubBar uses to open RiffBot (src/HubBar.tsx onOpen). */
  onOpenRiffBot: (pin: Pin) => void | Promise<unknown>;
};

// ── Theme (U1 `[data-theme]`, dark when absent) ────────────────────────────────
const readTheme = (): "dark" | "light" =>
  typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

function useTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() => readTheme());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const update = () => setTheme(readTheme());
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// ── Art URLs (the @art contract; hardcode nothing about the sheet itself) ──────
const CAST_URL = (theme: "dark" | "light") => `/office/cast-${theme}.png`;
const FLOOR_URL = (theme: "dark" | "light") => `/office/floor-${theme}.png`;
const ROOF_URL = (theme: "dark" | "light") => `/office/roof-${theme}.png`;
const FLOOR_FRONT_URL = (theme: "dark" | "light") => `/office/floor-front-${theme}.png`;
const ROOF_FRONT_URL = (theme: "dark" | "light") => `/office/roof-front-${theme}.png`;

/** True once an image at `url` loads (per theme); resets to false on error so the caller falls back to boxes. */
function useImageOk(url: string | null): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!url) {
      setOk(false);
      return;
    }
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setOk(true);
    img.onerror = () => alive && setOk(false);
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return ok;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// ── Pin → tower mapping (the F1 buildTower is the model; we only supply inputs) ─
function towerTeamOf(pin: Pin): TowerTeam {
  return { laneId: pin.lane.id, name: pin.lane.name, lead: pin.lead, buddy: pin.brainstorm, workers: pin.workers };
}

/** The squad tower from a TeamView: penthouse (RiffBot = hub Buddy, Overlord = hub lead) + floors in pin order. */
export function towerForView(view: TeamView): Tower {
  const hub = hubPinForSquad(view);
  const { pinned } = gridPinsForSquad(view);
  return buildTower({
    hubBuddy: hub?.brainstorm ?? null,
    hubLead: hub?.lead ?? null,
    teams: pinned.map(towerTeamOf),
  });
}

/** `floor` is the tower floor index the member sat on (-1 = the penthouse), so its ride starts at that floor's elevator. */
type FlatMember = { agentId: string; title: string; role: string; floor: number };
function towerMembers(tower: Tower): FlatMember[] {
  const out: FlatMember[] = [];
  let floor = -1;
  const push = (s: SeatedAgent | null) => s && out.push({ agentId: s.agentId, title: s.title, role: s.role, floor });
  const team = (p: TeamFloorPlacement) => {
    push(p.lead);
    push(p.buddy);
    p.desks.forEach(push);
    p.lobby.forEach(push);
  };
  push(tower.penthouse.riffbot);
  push(tower.penthouse.overlord);
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

type SeatProps = {
  item: BandItem;
  cast: CastModel | null;
  sheet: string | null;
  frameIndex: number;
};

function Seat({ item: { agent, anchor, onOpen }, cast, sheet, frameIndex }: SeatProps) {
  const frame: Frame | null = cast ? spriteFrame(cast, agent.role, agent.pose, frameIndex) : null;
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

/** The needs-you bubble; drawn above the front overlay so it is never hidden. */
function SeatBubble({ item: { agent, anchor }, cast, sheet }: { item: BandItem; cast: CastModel | null; sheet: string | null }) {
  const frame: Frame | null = cast ? spriteFrame(cast, agent.role, agent.pose, 0) : null;
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
  items,
  extras,
  frontSrc,
  cast,
  sheet,
  frameIndex,
}: {
  plate: ReactNode;
  items: BandItem[];
  extras?: ReactNode;
  frontSrc: string | null;
  cast: CastModel | null;
  sheet: string | null;
  frameIndex: number;
}) {
  const sorted = sortByAnchorY(items);
  const layers = bandLayers(!!frontSrc);
  return (
    <>
      {layers.map((layer) => {
        switch (layer) {
          case "plate":
            return <span key={layer} style={{ display: "contents" }}>{plate}</span>;
          case "sprites":
            return (
              <span key={layer} style={{ display: "contents" }}>
                {sorted.map((it) => (
                  <Seat key={it.agent.agentId} item={it} cast={cast} sheet={sheet} frameIndex={frameIndex} />
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
              </span>
            );
        }
      })}
    </>
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

function PlateBoxes({ rects, className }: { rects: Rect[]; className?: string }) {
  return (
    <>
      {rects.map((r, i) => (
        <span key={i} className={`sq-floor-box ${className ?? ""}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      ))}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SquadFloor({ view, onOpenRiffBot }: SquadFloorProps) {
  const tower = useMemo(() => towerForView(view), [view]);
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

  const floorImgOk = useImageOk(FLOOR_URL(theme));
  const roofImgOk = useImageOk(ROOF_URL(theme));
  const castImgOk = useImageOk(CAST_URL(theme));
  // Front overlays are opt-in per floor.json (`"front": true`); absent → skip.
  const floorFrontOk = useImageOk(floor.front ? FLOOR_FRONT_URL(theme) : null);
  const roofFrontOk = useImageOk(floor.penthouse?.front ? ROOF_FRONT_URL(theme) : null);
  const sheet = cast && castImgOk ? CAST_URL(theme) : null;

  // Load the art JSON; missing/invalid → F1 placeholder layout (and no sprites when cast.json is absent).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/office/floor.json")
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined),
      fetch("/office/cast.json")
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined),
    ]).then(([floorJson, castJson]) => {
      if (cancelled) return;
      setFloor(floorOrPlaceholder(floorJson));
      const v = validateCast(castJson);
      setCast(v.ok ? v.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Measure the panel width for the integer scale (native 640px wide, min 1x).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelWidth(e.contentRect.width);
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
  const scale = integerScale(panelWidth, dpr);

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
      setRiders((rs) => [...rs, ...gone.map((id) => ({ start, ...(byId.get(id) ?? { agentId: id, title: id.slice(0, 8), role: "unknown", floor: -1 }) }))]);
    }
    prevMembersRef.current = next;
  }, [tower, reduced]);
  useEffect(() => {
    if (!riders.length) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setRiders((rs) => rs.filter((r) => now - r.start < RIDE_MS));
    }, RIDE_MS + 50);
    return () => clearTimeout(t);
  }, [riders]);

  const openAgent = useCallback(
    (laneId: string, agentId: string) => {
      const pin = pinsByLane.get(laneId);
      if (pin) openPinMember(pin, agentId);
    },
    [pinsByLane],
  );

  const floorRefs = useRef<(HTMLDivElement | null)[]>([]);
  const penthouse = floor.penthouse ?? placeholderFloor().penthouse!;

  // A rider starts at the elevator of the floor it sat on and rises for RIDE_MS.
  const ridersOn = (floorIndex: number, elevator: Rect): ReactNode =>
    riders
      .filter((r) => r.floor === floorIndex)
      .map((r, i) => {
        const frame = cast ? spriteFrame(cast, r.role, "ride", 0) : null;
        return (
          <span
            key={r.agentId}
            className="sq-floor-rider"
            title={`${r.title} · riding`}
            style={{
              left: elevator.x + elevator.w / 2 + (i % 2 === 0 ? -6 : 6),
              top: elevator.y + elevator.h,
              animationDuration: `${RIDE_MS}ms`,
              ...(cast ? { width: cast.cell, height: cast.cell } : {}),
            }}
          >
            {sheet && frame ? (
              <span className="sq-floor-sprite" style={{ backgroundImage: `url(${sheet})`, backgroundPosition: `-${frame.x}px -${frame.y}px` }} />
            ) : (
              <span className="sq-floor-sprite sq-floor-sprite-fallback" />
            )}
          </span>
        );
      });

  const penthouseItems: BandItem[] = [];
  const { riffbot: riffAgent, overlord: overlordAgent } = tower.penthouse;
  if (riffAgent) penthouseItems.push({ agent: riffAgent, anchor: sliceAnchor(penthouse.riffbot.seat), onOpen: () => openAgent(hub?.lane.id ?? "", riffAgent.agentId) });
  if (overlordAgent) penthouseItems.push({ agent: overlordAgent, anchor: sliceAnchor(penthouse.overlord.seat), onOpen: () => openAgent(hub?.lane.id ?? "", overlordAgent.agentId) });

  const bandStyle = (w: number, h: number): CSSProperties => ({
    width: w,
    height: h,
    ...(scale > 1 ? { transform: `scale(${scale})`, transformOrigin: "top left" } : {}),
  });

  const towerScale = (w: number, h: number): CSSProperties => ({ width: w * scale, height: h * scale });

  const floorBoxes: ReactNode = (
    <>
      <PlateBoxes rects={[floor.teamA.lead, floor.teamA.buddyOffice, ...floor.teamA.desks, ...(floor.teamA.lobby ? [floor.teamA.lobby] : [])]} />
      <PlateBoxes rects={[floor.teamB.lead, floor.teamB.buddyOffice, ...floor.teamB.desks, ...(floor.teamB.lobby ? [floor.teamB.lobby] : [])]} />
      <PlateBoxes className="sq-floor-box-elevator" rects={[floor.elevator.car, floor.elevator.doorA, floor.elevator.doorB]} />
    </>
  );

  return (
    <section className="sq-floor" data-testid="squad-floor" aria-label="Squad floor" ref={rootRef}>
      {scale >= 1 && (
        <div className="sq-floor-tower">
          {/* Penthouse [RiffBot lounge | elevator top | Overlord office] */}
          <div className="sq-floor-band-wrap" style={towerScale(penthouse.w, penthouse.h)}>
            <div className="sq-floor-band" style={bandStyle(penthouse.w, penthouse.h)}>
              <Band
                cast={cast}
                sheet={sheet}
                frameIndex={frameIndex}
                frontSrc={roofFrontOk ? ROOF_FRONT_URL(theme) : null}
                items={penthouseItems}
                plate={
                  <>
                    {roofImgOk ? (
                      <img className="sq-floor-plate" src={ROOF_URL(theme)} alt="" draggable={false} style={{ width: penthouse.w, height: penthouse.h }} />
                    ) : (
                      <PlateBoxes rects={[penthouse.riffbot.lounge, penthouse.riffbot.seat, penthouse.overlord.crtWall, penthouse.overlord.seat, penthouse.elevatorTop]} />
                    )}
                    {hub && (
                      <button
                        type="button"
                        className="sq-floor-lounge"
                        data-testid="sq-floor-lounge"
                        title="Open RiffBot"
                        style={{ left: penthouse.riffbot.lounge.x, top: penthouse.riffbot.lounge.y, width: penthouse.riffbot.lounge.w, height: penthouse.riffbot.lounge.h }}
                        onClick={() => void Promise.resolve(onOpenRiffBot(hub)).catch(() => {})}
                      />
                    )}
                  </>
                }
                extras={ridersOn(-1, penthouse.elevatorTop)}
              />
            </div>
          </div>

          {/* Floors, top-down in squad pin order, two teams per floor. */}
          {tower.floors.map((f, i) => (
            <div
              key={f.index}
              ref={(el) => {
                floorRefs.current[i] = el;
              }}
              className="sq-floor-band-wrap"
              style={towerScale(FLOOR_NATIVE_WIDTH, FLOOR_NATIVE_HEIGHT)}
            >
              <div className="sq-floor-band" style={bandStyle(FLOOR_NATIVE_WIDTH, FLOOR_NATIVE_HEIGHT)}>
                <Band
                  cast={cast}
                  sheet={sheet}
                  frameIndex={frameIndex}
                  frontSrc={floorFrontOk ? FLOOR_FRONT_URL(theme) : null}
                  items={[
                    ...teamItems(f.teamA, floor.teamA, (agentId) => openAgent(f.teamA.laneId, agentId)),
                    ...(f.teamB ? teamItems(f.teamB, floor.teamB, (agentId) => openAgent(f.teamB!.laneId, agentId)) : []),
                  ]}
                  plate={
                    floorImgOk ? (
                      <img className="sq-floor-plate" src={FLOOR_URL(theme)} alt="" draggable={false} style={{ width: FLOOR_NATIVE_WIDTH, height: FLOOR_NATIVE_HEIGHT }} />
                    ) : (
                      floorBoxes
                    )
                  }
                  extras={
                    <>
                      <LobbyPlus placement={f.teamA} lobby={floor.teamA.lobby} />
                      {f.teamB && <LobbyPlus placement={f.teamB} lobby={floor.teamB.lobby} />}
                      {ridersOn(f.index, floor.elevator.car)}
                    </>
                  }
                />
              </div>
              {f.needsYou && (
                <button
                  type="button"
                  className="sq-floor-mark"
                  data-testid={`sq-floor-mark-${f.index}`}
                  title="Someone needs you on this floor"
                  onClick={() => floorRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
                >
                  !
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
