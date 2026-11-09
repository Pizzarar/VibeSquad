// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, skyCanOpen, SKY_COLUMNS, SKY_FRAME_URL, SKY_POPOVER_SELECTOR, SKY_WALL_URL, SKY_URL, TAKEOVER_FALLBACK, TAKEOVER_FALLBACK_MS, TAKEOVER_LABEL_URL, TAKEOVER_URL, SLAM_PUFF_URL, faceBg, faceContain, hasFaceMode, skyAssets, skyEffectiveOpen, skyEscCloses, skyExit, skyFaceClick, skyLeftBot, skyOutsideCloses, skyRiffMode, skyWallFallbackStyle, skyWallStyle, skyZonesFor, slamFaceForce, slamPuffBox, slamPuffPoints, slamPuffScale, slamRiffForce, slamTransform, takeoverLabelGeom, takeoverLanded, takeoverVisible, type SkyBot, type SkyCan, type SkyOpen, type SkyZone, type SlamPuff, type SlamView, type TakeoverLabel, type TakeoverModel } from "./skyZonesLogic";
import type { FaceBot, FaceMode } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useDpr, useFacesModel, useImageOk, usePrefersReducedMotion, useSkyCrtModel, useSlamClock, useSlamPuffModel, useTakeoverClock, useTakeoverLabelModel, useTakeoverModel, useTheme } from "./useBotFace";

const LABEL: Record<SkyBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

/** G7 overlay state for Riff's TV: the sheet (only when takeover.json AND the theme PNG load) and its clock. Lives in Zone so the label scrawl (T1) shares the same clock as the face overlay. */
function useTakeoverState(isRiff: boolean, takeover: TakeoverModel | null, expanded: boolean) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const sheetOk = useImageOk(isRiff && takeover ? TAKEOVER_URL(theme) : null);
  const sheet = sheetOk ? takeover : null;
  const clock = useTakeoverClock(expanded && isRiff, sheet?.fps ?? TAKEOVER_FALLBACK.fps, sheet?.frames.length ?? 0, reduced);
  return { sheet, clock };
}

/** G6-fix2: the bot's whole face, as big as an integer scale fits (contain, never cropped), centred on a per-bot gutter colour. */
function ZoneFace({
  zone,
  lander,
  faces,
  force,
  tks,
  expanded,
}: {
  zone: SkyZone;
  /** Riff's TV only (G8f): the Overlord's zone, whose face this TV ends on once the takeover has landed. */
  lander?: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  force: FaceMode | null;
  /** Riff only (G7): the overlay sheet + clock (sheet null → the CSS dissolve). */
  tks: ReturnType<typeof useTakeoverState>;
  expanded?: boolean;
}) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const isRiff = zone.bot === "riffbot";
  const { sheet, clock } = tks;
  const showSheet = !!sheet && takeoverVisible(clock.pos, !!expanded, reduced);
  // G8f: the takeover is the transition. Landed (fully in) = the Overlord's face, normal talk/idle; Riff keeps playing
  // scared underneath until then, and again from the first reverse frame until the overlay is gone, then goes idle.
  // No sheet: the CSS dissolve (cover in, then clear) swaps the face under full cover, halfway through its own run.
  const fallback = isRiff && !sheet && !reduced;
  const [fb, setFb] = useState({ landed: false, play: 0 });
  const fbFirst = useRef(true);
  useEffect(() => {
    if (!fallback) return;
    if (fbFirst.current) {
      fbFirst.current = false;
      if (expanded) setFb((f) => ({ ...f, landed: true }));
      return;
    }
    setFb((f) => ({ ...f, play: f.play + 1 }));
    const t = setTimeout(() => setFb((f) => ({ ...f, landed: !!expanded })), TAKEOVER_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [expanded, fallback]);
  const landed = isRiff && !!lander && (sheet ? takeoverLanded(clock.pos, !!expanded, sheet.frames.length, reduced) : reduced ? !!expanded : fb.landed);
  const shown = isRiff ? skyLeftBot(landed) : zone.bot; // the Overlord's own TV never swaps (landed is Riff-only)
  const shownZone = landed && lander ? lander : zone;
  const holdScared = !landed && showSheet && !force && hasFaceMode(faces, "riffbot", "scared");
  const face = useBotFace(shown, shownZone.pose ? { pose: shownZone.pose } : null, faces, { theme, reduced, force: landed ? null : (force ?? (holdScared ? "scared" : null)) });
  const bg = faceBg(faces, shown, theme);
  const dpr = useDpr();
  const tf = sheet?.frames[clock.frame];
  return (
    <FaceStage
      testBot={zone.bot}
      shown={shown}
      faces={faces}
      face={face}
      bg={bg}
      overlay={(box) => {
        const tk = sheet ? faceContain(sheet.cell, box, dpr) : null;
        return showSheet && !landed && sheet && tk && tf && tk.k > 0 ? (
          <span
            className="sky-takeover"
            data-testid="sky-takeover"
            data-frame={clock.frame}
            style={{
              width: sheet.cell.w,
              height: sheet.cell.h,
              left: tk.left,
              top: tk.top,
              transform: `scale(${tk.k})`,
              backgroundImage: `url(${TAKEOVER_URL(theme)})`,
              backgroundPosition: `-${tf.x}px -${tf.y}px`,
            }}
          />
        ) : null;
      }}
    >
      {fallback && <span key={fb.play} className={`sky-takeover-fallback${fb.play ? " is-play" : ""}`} data-testid="sky-takeover-fallback" />}
    </FaceStage>
  );
}

/** The shared bezel look (RiffBot / Overlord zones and the Perfection angel strip): the sky-crt.json border-image style once its art loads, and the sky PNG. Both null → the CSS bezel / gradient. */
export function useSkyBezel() {
  const theme = useTheme();
  const crt = useSkyCrtModel();
  const dpr = useDpr();
  return skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) }, crt, dpr);
}

/**
 * The CRT screen of a bezel: the bot's whole face as big as an integer device-pixel scale fits (contain, bottom-anchored, never cropped),
 * on its gutter colour. `overlay(box)` draws extra art on the stage (the takeover sheet); children sit beside the face area (the fallback dissolve).
 */
export function FaceStage({
  testBot,
  shown,
  faces,
  face,
  bg,
  overlay,
  onScale,
  children,
}: {
  /** Suffix of the test ids (`sky-face-<testBot>`). */
  testBot: string;
  /** The bot whose face is drawn (`data-face-bot`). */
  shown: FaceBot;
  faces: ReturnType<typeof useFacesModel>;
  face: ReturnType<typeof useBotFace>;
  bg: string | null;
  overlay?: (box: { w: number; h: number }) => React.ReactNode;
  /** Reports the integer scale the face is drawn at (CSS px per art px; 0 until measured). */
  onScale?: (k: number) => void;
  children?: React.ReactNode;
}) {
  // Cell size comes from faces.json (never hardcoded); until it loads, a blank stage.
  const cell = faces?.cell ?? { w: 48, h: 48 };
  const stage = useRef<HTMLSpanElement>(null); // the face box: the whole TV screen (G8: no chat under it)
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dpr = useDpr();
  const { k, left, top } = faceContain(cell, box, dpr);
  useEffect(() => onScale?.(k), [k, onScale]);
  return (
    <span className="sky-face-stage" aria-hidden="true" style={bg ? ({ ["--sky-face-bg-custom" as string]: bg } as React.CSSProperties) : undefined}>
      <span ref={stage} className="sky-face-area" data-testid={`sky-face-area-${testBot}`}>
      {k > 0 && (
        <span
          className={`sky-face${face.frame ? "" : " is-blank"}`}
          data-testid={`sky-face-${testBot}`}
          data-face-bot={shown}
          data-face-mode={face.mode}
          data-face-k={k}
          style={{ width: cell.w, height: cell.h, left, top, transform: `scale(${k})`, ...face.style }}
        />
      )}
      {overlay?.(box)}
      </span>
      {children}
    </span>
  );
}

/**
 * One sky TV or one chat panel. `panel` false = the TV: just the bot's portrait filling the screen (plus the static / Spin Up
 * states when it has no agent). `panel` true = the bot's chat (messages + composer, no drawer) laid over the right TV.
 */
function Zone({
  zone,
  lander,
  faces,
  frameStyle,
  panel = false,
  force = null,
  takeover = null,
  labelModel = null,
  taken = false,
  clickable = false,
  isOpen = false,
  openLabel,
  onFace,
  onClose,
  onSuccessor,
  onSpinUp,
  busy = false,
  fx = null,
  slamArt = null,
}: {
  zone: SkyZone;
  /** Riff's TV: the Overlord's zone (its face lands here when the Overlord's chat is open). */
  lander?: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  panel?: boolean;
  /** Forced face mode (Riff scared while the Overlord has taken it over). */
  force?: FaceMode | null;
  /** G7 overlay sheet model (Riff's TV only). */
  takeover?: TakeoverModel | null;
  /** T1: takeover-label.json (size + anchor of the scrawl sticker); null → no sticker (CSS scrawl). */
  labelModel?: TakeoverLabel | null;
  /** The Overlord's takeover is on (this is Riff's TV): the overlay plays in, and reverses when it ends. */
  taken?: boolean;
  /** The TV's face is a button (open / close). */
  clickable?: boolean;
  /** Panel: this bot's chat is the one showing. TV: a chat is open (aria-expanded). */
  isOpen?: boolean;
  /** The bot whose chat is open (the left TV shows its face): names the close button. Defaults to this TV's bot. */
  openLabel?: string;
  onFace?: () => void;
  onClose?: () => void;
  /** The @art sky-CRT bezel as a border-image style (from sky-crt.json + PNG) when both exist; null → the CSS bezel. */
  frameStyle: Record<string, string> | null;
  onSuccessor: (id: string) => void;
  /** Start (no Buddy) or resume (dormant) RiffBot: App's onSpinUpPin, the same path as the Spin Up button. */
  onSpinUp?: () => void;
  /** The Overlord spawn is running: its Spin Up / Resume button is disabled. */
  busy?: boolean;
  /** RS-b/RS-c: the slam applies to this zone: `shake` = the transform vars on the sky root move it (hinge swing / shake / squash); `closing` = the panel stays up until it has swung shut; `smear` = draw the smear on the window's outer edge. */
  fx?: { shake?: boolean; closing?: boolean; smear?: boolean } | null;
  /** RS-c: Riff's panel only: the slam art, probed at rest so the smear never loads mid-swing. */
  slamArt?: SlamPuff | null;
}) {
  const label = LABEL[zone.bot];
  // T1: Riff's TV label gets struck through with OVERLORD scrawled over it while the takeover is on (in with it, reversed when it ends).
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const scrawl = !panel && zone.bot === "riffbot";
  const tks = useTakeoverState(scrawl, takeover, taken);
  const labelArt = useImageOk(scrawl && labelModel ? TAKEOVER_LABEL_URL(theme) : null);
  // In with the takeover, reversed when it ends (same clock as the face overlay); reduced motion shows the end state at once.
  const chip = useRef<HTMLSpanElement>(null);
  const [chipBox, setChipBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const dpr = useDpr();
  useLayoutEffect(() => {
    const el = chip.current;
    if (!el || !scrawl) return;
    const measure = () => setChipBox((b) => (b && b.left === el.offsetLeft && b.top === el.offsetTop && b.width === el.offsetWidth && b.height === el.offsetHeight ? b : { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrawl]);
  const geom = labelModel && chipBox ? takeoverLabelGeom(labelModel, chipBox, dpr) : null;
  const struck = scrawl && (reduced ? taken : takeoverVisible(tks.clock.pos, taken, reduced));
  openLabel ??= label;
  const off = zone.bot === "overlord" && !zone.agentId; // a closed Overlord keeps its zone (history + Resume)
  // RS-c: the motion smear on the swinging window's outer edge (9-sliced vertically: top cap, 8-row tiles, bottom cap), skipped without the art.
  const sec = useRef<HTMLElement>(null);
  const smearArt = slamArt?.smear;
  const smearLoaded = useImageOk(panel && smearArt ? SLAM_PUFF_URL(theme) : null) && !!smearArt;
  const smearOn = smearLoaded && !!fx?.smear;
  const smearK = smearOn && slamArt && sec.current ? slamPuffScale(slamArt.scale, faceContain(faces?.cell ?? { w: 80, h: 48 }, { w: sec.current.clientWidth, h: sec.current.clientHeight }, dpr).k, dpr) : 0;
  const idle = !panel && zone.bot === "riffbot" && !zone.agentId; // RiffBot not running: dimmed whole face + a bottom Spin Up strip
  return (
    <section
      ref={sec}
      className={`sky-zone sky-zone-${zone.bot}${panel ? " sky-chat-panel" : ""}${off ? " is-off" : ""}${idle ? " is-idle" : ""}${frameStyle ? " has-frame" : ""}${fx?.closing ? " is-slam-closing" : ""}${fx?.shake ? " is-slam-fx" : ""}`}
      style={frameStyle ?? undefined}
      data-testid={panel ? `sky-chat-${zone.bot}` : `sky-zone-${zone.bot}`}
      data-sky-bot={zone.bot}
      data-agent={zone.agentId ?? ""}
      aria-label={`${label} chat`}
      hidden={panel && !isOpen && !fx?.closing}
    >
      {!panel && !off && <ZoneFace zone={zone} lander={lander} faces={faces} force={force} tks={tks} expanded={taken} />}
      {!panel && clickable && (
        <button
          type="button"
          className="sky-face-hit"
          data-testid={`sky-face-hit-${zone.bot}`}
          aria-label={isOpen ? `Close ${openLabel} chat` : `Open ${label} chat`}
          aria-expanded={isOpen}
          onClick={onFace}
        />
      )}
      {!panel && (
        <span ref={chip} className={`sky-crt-name${struck ? " is-struck" : ""}${labelArt && geom ? " has-art" : ""}${reduced ? " is-still" : ""}`} data-testid={`sky-name-${zone.bot}`} role={scrawl ? "img" : undefined} aria-label={scrawl ? (struck ? "Overlord (takeover)" : label) : undefined}>
          <span className="sky-crt-name-text">{label}</span>
          {scrawl && !(labelArt && geom) && <span className={`sky-label-scrawl${struck ? " is-on" : ""}`} data-testid="sky-label-scrawl" aria-hidden="true">OVERLORD</span>}
        </span>
      )}
      {scrawl && labelArt && geom && (
        <span className={`sky-label-art${struck ? " is-on" : ""}${reduced ? " is-still" : ""}`} data-testid="sky-label-art" aria-hidden="true" style={{ ...geom, backgroundImage: `url(${TAKEOVER_LABEL_URL(theme)})` }} />
      )}
      {panel && (
        <button type="button" className="sky-chat-close" data-testid={`sky-chat-close-${zone.bot}`} aria-label={`Close ${label} chat`} onClick={onClose}>
          ✕
        </button>
      )}
      {panel && smearOn && smearArt && smearK > 0 && sec.current && <SwingSmear art={smearArt} url={SLAM_PUFF_URL(theme)} k={smearK} width={sec.current.clientWidth} height={sec.current.clientHeight} />}
      <div className="sky-crt-body">
        {panel ? (
          zone.agentId ? (
            <>
              {zone.dormant && onSpinUp && (
                <div className="sky-resume" data-testid={zone.bot === "overlord" ? "sky-resume-overlord-bar" : "sky-resume-riffbot"}>
                  <span className="muted small">This chat is closed (history below).</span>
                  <button type="button" className="btn ok small" data-testid={zone.bot === "overlord" ? "sky-resume-overlord" : "sky-resume-btn"} disabled={busy} onClick={onSpinUp}>
                    Resume {label}
                  </button>
                </div>
              )}
              <DrawerSlot id={zone.agentId} pane="left" shown chatOnly onSuccessor={onSuccessor} />
            </>
          ) : null
        ) : zone.agentId ? null : off ? (
          <div className="sky-static" data-testid="sky-static-overlord" role="status">
            <span className="sky-static-text">{NO_OVERLORD_TEXT}</span>
            {onSpinUp && (
              <button type="button" className="btn small" data-testid="sky-start-overlord" disabled={busy} onClick={onSpinUp}>
                {busy ? "Starting…" : "Spin Up Overlord"}
              </button>
            )}
          </div>
        ) : (
          <div className="sky-static" data-testid="sky-idle-riffbot" role="status">
            <span className="sky-static-text">RiffBot is not running</span>
            {onSpinUp && (
              <button type="button" className="btn small" data-testid="sky-start-riffbot" onClick={onSpinUp}>
                Spin Up RiffBot
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** RS-c: the smear art stretched down the window's outer edge: top cap + 8-row tiles + bottom cap (art px, scaled by k); the cell's edge column sits on the window edge. */
function SwingSmear({ art, url, k, width, height }: { art: NonNullable<SlamPuff["smear"]>; url: string; k: number; width: number; height: number }) {
  const artH = height / k;
  const { top, bottom } = art.slice;
  const rows = 8;
  const tiles = Math.max(0, Math.ceil((artH - top - bottom) / rows));
  const cell = (y: number, h: number, at: Record<string, number>, key: string) => (
    <span key={key} className="sky-swing-smear-cell" style={{ ...at, width: art.frameW, height: h, backgroundImage: `url(${url})`, backgroundPosition: `-${art.frame.x}px -${art.frame.y + y}px` }} />
  );
  return (
    <span className="sky-swing-smear" data-testid="sky-swing-smear" aria-hidden="true" style={{ width: art.frameW, height: artH, left: width - art.edgeX * k, transform: `scale(${k})` }}>
      {cell(0, top, { top: 0 }, "t")}
      {Array.from({ length: tiles }, (_, i) => cell(top, rows, { top: top + i * rows }, `m${i}`))}
      {cell(art.frameH - bottom, bottom, { bottom: 0 }, "b")}
    </span>
  );
}

/** RS-b/RS-c: the slam-puff bursts and the SMACK star, drawn over the whole sky (absolute, never takes a click). Positions come from the live TV boxes. */
function SlamFx({ root, view, faces, puff }: { root: React.RefObject<HTMLDivElement | null>; view: SlamView; faces: ReturnType<typeof useFacesModel>; puff: SlamPuff | null }) {
  const theme = useTheme();
  const dpr = useDpr();
  const box = useRef<HTMLSpanElement>(null);
  const puffOk = useImageOk(puff ? SLAM_PUFF_URL(theme) : null);
  const live = view.puffFrame !== null || view.smackFrame !== null;
  const host = live ? box.current?.getBoundingClientRect() : undefined;
  const rel = (sel: string) => {
    const r = host ? root.current?.querySelector(sel)?.getBoundingClientRect() : undefined;
    return r && host ? { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height } : null;
  };
  const to = rel('[data-testid="sky-zone-overlord"]');
  let k = 0;
  if (live) {
    const area = root.current?.querySelector('[data-testid="sky-face-area-overlord"]');
    k = slamPuffScale(puff?.scale ?? 3, area ? faceContain(faces?.cell ?? { w: 80, h: 48 }, { w: area.clientWidth, h: area.clientHeight }, dpr).k : 0, dpr);
  }
  const frame = puff && view.puffFrame !== null ? puff.frames[view.puffFrame] : null;
  const smack = puff?.smack;
  const star = smack && view.smackFrame !== null ? smack.frames[view.smackFrame] : null;
  const sprite = (key: string, testid: string, b: { left: number; top: number }, cell: { w: number; h: number }, at: { x: number; y: number }) => (
    <span key={key} className="sky-slam-puff" data-testid={testid} style={{ left: b.left, top: b.top, width: cell.w, height: cell.h, transform: `scale(${k})`, backgroundImage: `url(${SLAM_PUFF_URL(theme)})`, backgroundPosition: `-${at.x}px -${at.y}px` }} />
  );
  return (
    <span ref={box} className="sky-slam-fx" aria-hidden="true" data-testid="sky-slam-fx" data-puff-frame={view.puffFrame ?? ""} data-smack-frame={view.smackFrame ?? ""}>
      {to && puff && puffOk && frame && k > 0 && slamPuffPoints(to).map((pt, i) => sprite(String(i), "sky-slam-puff", slamPuffBox(pt, { w: puff.frameW, h: puff.frameH }, k, dpr, host), { w: puff.frameW, h: puff.frameH }, frame))}
      {to && smack && puffOk && star && k > 0 && sprite("smack", "sky-slam-smack", slamPuffBox({ x: to.left + to.width / 2, y: to.top + to.height / 2 }, { w: smack.frameW, h: smack.frameH }, k, dpr), { w: smack.frameW, h: smack.frameH }, star)}
    </span>
  );
}

export function SkyZones({
  view,
  onSuccessor,
  onSpinUp,
  onSpinUpOverlord,
  overlordBusy = false,
  initialOpen = null,
}: {
  view: TeamView;
  onSuccessor: (id: string) => void;
  /** App's onSpinUpPin (the Spin Up button's path): starts a fresh RiffBot session or resumes a dormant one. */
  onSpinUp?: (pin: Pin) => void;
  /** Spawn the hub lead (Spin Up / Resume Overlord); the new agent lands in the right zone once the store has it. */
  onSpinUpOverlord?: (view: TeamView) => void;
  overlordBusy?: boolean;
  /** HP3: the chat that starts open (a mini-face click on the Tower page); later clicks behave as usual. */
  initialOpen?: SkyOpen;
}) {
  const zones = skyZonesFor(view);
  const faces = useFacesModel();
  const theme = useTheme();
  // @art assets are optional: probe each, skip the absent ones (CSS gradient sky + CSS bezel stay).
  const crt = useSkyCrtModel();
  const dpr = useDpr();
  const { skyUrl, frameStyle } = useSkyBezel();
  const takeover = useTakeoverModel();
  const labelModel = useTakeoverLabelModel();
  const reduced = usePrefersReducedMotion();
  const puff = useSlamPuffModel();
  const { hub } = zones;
  // G8c: the wall between the TVs. Art from sky-crt.json `wall` when its PNG loads, else the CSS ink seam. Absolute: takes no grid space.
  const wallUrl = crt?.wall ? SKY_WALL_URL(theme) : null;
  const wallStyle = skyWallStyle(crt?.wall, crt?.scale ?? 1, useImageOk(wallUrl) ? wallUrl : null, dpr);

  // G8: the TVs never resize. `openRaw` is set by clicks only; the Overlord talking never opens anything.
  const can: SkyCan = skyCanOpen(zones);
  const [openRaw, setOpen] = useState<SkyOpen>(initialOpen);
  const open = skyEffectiveOpen(openRaw, can); // the Overlord closing under an open chat drops back to rest
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef<SkyOpen>(null);
  openRef.current = open;
  // RS-c: Riff's window swings on its hinge into the Overlord's TV; the clock restarts on every open/close of it (the hinge angle goes to --slam-swing on the root every frame).
  const slam = useSlamClock(open === "riffbot", reduced, puff, initialOpen === "riffbot", root);
  const slamOn = slam.squash || slam.shakeDx !== 0 || slam.swinging;
  const slamStyle: Record<string, string> = {};
  const tvTf = slamTransform(slam.shakeDx, slam.squash, dpr);
  if (tvTf) slamStyle["--slam-tv-tf"] = tvTf;
  if (tvTf) slamStyle["--slam-panel-tf"] = tvTf;
  // Esc, or a click anywhere outside the sky, closes whatever is open. Clicks inside are the faces' / chat's / ✕'s own handlers.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (skyOutsideCloses(!!t && !!root.current?.contains(t), !!t?.closest(SKY_POPOVER_SELECTOR)) || !t) setOpen(skyExit);
    };
    const key = (e: KeyboardEvent) => {
      // At rest Esc is the app's (up to Squads Home); with a popover/dialog up (slash menu, modal) Esc dismisses that first.
      if (e.key !== "Escape" || !skyEscCloses(openRef.current, e.defaultPrevented, !!document.querySelector(`${SKY_POPOVER_SELECTOR}:not([hidden])`))) return;
      e.preventDefault(); // this Esc closed the chat; the app's own Esc handler honours defaultPrevented
      setOpen(skyExit);
      const a = document.activeElement;
      if (a instanceof HTMLElement && root.current?.contains(a)) a.blur();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  const onFace = (tv: SkyBot) => setOpen((o) => skyFaceClick(skyEffectiveOpen(o, can), tv, can));
  // While a chat is open the left TV is the open bot's face (clickable to close); the right TV is under the chat.
  const clickable = (tv: SkyBot) => (open !== null ? tv === "riffbot" : can[tv]);
  const spinRiff = hub && onSpinUp ? () => onSpinUp(hub) : undefined;
  const spinOverlord = hub && onSpinUpOverlord ? () => onSpinUpOverlord(view) : undefined;
  // Built outside the JSX: a nested template literal in className defeats test/css-classes.test.mjs's token scan.
  const zonesClass = ["sky-zones", skyUrl ? "has-sky-art" : "", open ? "is-open" : "", open ? "is-open-" + open : ""].filter(Boolean).join(" ");
  return (
    <div
      ref={root}
      className={zonesClass}
      data-testid="sky-zones"
      data-open={open ?? "none"}
      style={{ ["--sky-cols" as string]: SKY_COLUMNS, ...(skyUrl ? { backgroundImage: `url(${skyUrl})` } : null), ...slamStyle }}
    >
      <Zone zone={zones.riffbot} lander={zones.overlord} faces={faces} frameStyle={frameStyle} force={skyRiffMode(open, hasFaceMode(faces, "riffbot", "scared")) ?? slamRiffForce(slam, faces)} takeover={takeover} labelModel={labelModel} taken={open === "overlord"} clickable={clickable("riffbot")} isOpen={open !== null} openLabel={open ? LABEL[open] : undefined} onFace={() => onFace("riffbot")} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <Zone zone={zones.overlord} faces={faces} frameStyle={frameStyle} force={slamFaceForce(slam, faces)} fx={slamOn ? { shake: true } : null} clickable={clickable("overlord")} isOpen={open === "overlord"} onFace={() => onFace("overlord")} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
      <Zone panel zone={zones.riffbot} slamArt={puff} faces={faces} frameStyle={frameStyle} fx={slamOn || slam.closing ? { shake: slamOn, closing: slam.closing, smear: slam.smear } : null} isOpen={open === "riffbot"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <SlamFx root={root} view={slam} faces={faces} puff={puff} />
      <span className={`sky-wall${wallStyle ? " has-art" : ""}`} data-testid="sky-wall" aria-hidden="true" style={wallStyle ?? skyWallFallbackStyle(dpr)} />
      <Zone panel zone={zones.overlord} faces={faces} frameStyle={frameStyle} isOpen={open === "overlord"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
    </div>
  );
}
