// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, SKY_COLUMNS, SKY_FRAME_URL, SKY_POPOVER_SELECTOR, SKY_WALL_URL, SKY_URL, TAKEOVER_FALLBACK, TAKEOVER_FALLBACK_MS, TAKEOVER_LABEL_URL, TAKEOVER_URL, SLAM, SLAM_PUFF_URL, faceBg, faceContain, hasFaceMode, skyAssets, skyEffectiveOpen, skyEscCloses, skyExit, skyFaceClick, skyLeftBot, skyOutsideCloses, skyRiffMode, skyWallFallbackStyle, skyWallStyle, skyZonesFor, slamFaceForce, slamPuffBox, slamPuffPoints, slamPuffScale, slamRect, slamTransform, takeoverLabelGeom, takeoverLanded, takeoverVisible, type SkyCan, type SkyOpen, type SkyZone, type SlamPuff, type SlamView, type TakeoverLabel, type TakeoverModel } from "./skyZonesLogic";
import type { FaceBot, FaceMode } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useDpr, useFacesModel, useImageOk, usePrefersReducedMotion, useSkyCrtModel, useSlamClock, useSlamPuffModel, useTakeoverClock, useTakeoverLabelModel, useTakeoverModel, useTheme } from "./useBotFace";

const SLAM_STEPS = SLAM.zoomSteps;
const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

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
  const bg = faceBg(faces, shown, theme);
  const dpr = useDpr();
  const { k, left, top } = faceContain(cell, box, dpr);
  const tk = sheet ? faceContain(sheet.cell, box, dpr) : null;
  const tf = sheet?.frames[clock.frame];
  return (
    <span className="sky-face-stage" aria-hidden="true" style={bg ? ({ ["--sky-face-bg-custom" as string]: bg } as React.CSSProperties) : undefined}>
      <span ref={stage} className="sky-face-area" data-testid={`sky-face-area-${zone.bot}`}>
      {k > 0 && (
        <span
          className={`sky-face${face.frame ? "" : " is-blank"}`}
          data-testid={`sky-face-${zone.bot}`}
          data-face-bot={shown}
          data-face-mode={face.mode}
          style={{ width: cell.w, height: cell.h, left, top, transform: `scale(${k})`, ...face.style }}
        />
      )}
      {showSheet && !landed && sheet && tk && tf && tk.k > 0 && (
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
      )}
      </span>
      {fallback && <span key={fb.play} className={`sky-takeover-fallback${fb.play ? " is-play" : ""}`} data-testid="sky-takeover-fallback" />}
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
  /** RS-b: the slam applies to this zone: `held` = the chat waits for the zoom-rect to land; `shake` = the transform vars on the sky root move it (shake / squash). */
  fx?: { held?: boolean; shake?: boolean } | null;
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
  const idle = !panel && zone.bot === "riffbot" && !zone.agentId; // RiffBot not running: dimmed whole face + a bottom Spin Up strip
  return (
    <section
      className={`sky-zone sky-zone-${zone.bot}${panel ? " sky-chat-panel" : ""}${off ? " is-off" : ""}${idle ? " is-idle" : ""}${frameStyle ? " has-frame" : ""}${fx?.held ? " is-slam-held" : ""}${fx?.shake ? " is-slam-fx" : ""}`}
      style={frameStyle ?? undefined}
      data-testid={panel ? `sky-chat-${zone.bot}` : `sky-zone-${zone.bot}`}
      data-sky-bot={zone.bot}
      data-agent={zone.agentId ?? ""}
      aria-label={`${label} chat`}
      hidden={panel && !isOpen}
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
      <span ref={chip} className={`sky-crt-name${struck ? " is-struck" : ""}${labelArt && geom ? " has-art" : ""}${reduced ? " is-still" : ""}`} data-testid={`sky-name-${zone.bot}${panel ? "-panel" : ""}`} role={scrawl ? "img" : undefined} aria-label={scrawl ? (struck ? "Overlord (takeover)" : label) : undefined}>
        <span className="sky-crt-name-text">{label}</span>
        {scrawl && !(labelArt && geom) && <span className={`sky-label-scrawl${struck ? " is-on" : ""}`} data-testid="sky-label-scrawl" aria-hidden="true">OVERLORD</span>}
      </span>
      {scrawl && labelArt && geom && (
        <span className={`sky-label-art${struck ? " is-on" : ""}${reduced ? " is-still" : ""}`} data-testid="sky-label-art" aria-hidden="true" style={{ ...geom, backgroundImage: `url(${TAKEOVER_LABEL_URL(theme)})` }} />
      )}
      {panel && (
        <button type="button" className="sky-chat-close" data-testid={`sky-chat-close-${zone.bot}`} aria-label={`Close ${label} chat`} onClick={onClose}>
          ✕
        </button>
      )}
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

/** RS-b: the zoom-rect outlines and the slam-puff, drawn over the whole sky (absolute, never takes a click). Rects come from the live TV boxes. */
function SlamFx({ root, view, faces, puff, closing }: { root: React.RefObject<HTMLDivElement | null>; view: SlamView; faces: ReturnType<typeof useFacesModel>; puff: SlamPuff | null; closing: boolean }) {
  const theme = useTheme();
  const dpr = useDpr();
  const box = useRef<HTMLSpanElement>(null);
  const puffOk = useImageOk(puff ? SLAM_PUFF_URL(theme) : null);
  const live = view.zoomStep !== null || view.puffFrame !== null;
  const host = live ? box.current?.getBoundingClientRect() : undefined;
  const rel = (sel: string) => {
    const r = host ? root.current?.querySelector(sel)?.getBoundingClientRect() : undefined;
    return r && host ? { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height } : null;
  };
  const from = rel('[data-testid="sky-zone-riffbot"]');
  const to = rel('[data-testid="sky-zone-overlord"]');
  const bw = Math.max(1, Math.round(3 * dpr)) / dpr; // dots are 3 device px
  // The outline of this step plus the one before it (Win95 leaves a short trail): the previous step is one down opening, one up closing.
  const steps = view.zoomStep === null ? [] : [closing ? view.zoomStep + 1 : view.zoomStep - 1, view.zoomStep].filter((n) => n >= 1 && n <= SLAM_STEPS);
  let k = 0;
  if (view.puffFrame !== null) {
    const area = root.current?.querySelector('[data-testid="sky-face-area-overlord"]');
    k = slamPuffScale(puff?.scale ?? 3, area ? faceContain(faces?.cell ?? { w: 80, h: 48 }, { w: area.clientWidth, h: area.clientHeight }, dpr).k : 0, dpr);
  }
  const frame = puff && view.puffFrame !== null ? puff.frames[view.puffFrame] : null;
  return (
    <span ref={box} className="sky-slam-fx" aria-hidden="true" data-testid="sky-slam-fx" data-zoom-step={view.zoomStep ?? ""} data-puff-frame={view.puffFrame ?? ""}>
      {from &&
        to &&
        steps.map((n) => {
          const r = slamRect(from, to, n, SLAM_STEPS, dpr);
          return <span key={n} className="sky-zoom-rect" data-testid="sky-zoom-rect" data-step={n} style={{ ...r, borderWidth: bw }} />;
        })}
      {to && puff && puffOk && frame && k > 0 &&
        slamPuffPoints(to).map((pt, i) => {
          const b = slamPuffBox(pt, { w: puff.frameW, h: puff.frameH }, k, dpr);
          return (
            <span
              key={i}
              className="sky-slam-puff"
              data-testid="sky-slam-puff"
              style={{ left: b.left, top: b.top, width: puff.frameW, height: puff.frameH, transform: `scale(${k})`, backgroundImage: `url(${SLAM_PUFF_URL(theme)})`, backgroundPosition: `-${frame.x}px -${frame.y}px` }}
            />
          );
        })}
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
  const { skyUrl, frameStyle } = skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) }, crt, dpr);
  const takeover = useTakeoverModel();
  const labelModel = useTakeoverLabelModel();
  const reduced = usePrefersReducedMotion();
  const puff = useSlamPuffModel();
  const { hub } = zones;
  // G8c: the wall between the TVs. Art from sky-crt.json `wall` when its PNG loads, else the CSS ink seam. Absolute: takes no grid space.
  const wallUrl = crt?.wall ? SKY_WALL_URL(theme) : null;
  const wallStyle = skyWallStyle(crt?.wall, crt?.scale ?? 1, useImageOk(wallUrl) ? wallUrl : null, dpr);

  // G8: the TVs never resize. `openRaw` is set by clicks only; the Overlord talking never opens anything.
  const can: SkyCan = { riffbot: !!zones.riffbot.agentId, overlord: !!zones.overlord.member };
  const [openRaw, setOpen] = useState<SkyOpen>(initialOpen);
  const open = skyEffectiveOpen(openRaw, can); // the Overlord closing under an open chat drops back to rest
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef<SkyOpen>(null);
  openRef.current = open;
  // RS-b: Riff's window zooms out of his TV and slams into the Overlord; the clock restarts on every open/close of it.
  const slam = useSlamClock(open === "riffbot", reduced, puff);
  const slamOpening = open === "riffbot" && !slam.windowShown;
  const slamOn = slam.squash || slam.shakeDx !== 0;
  const slamStyle: Record<string, string> = {};
  const tvTf = slamTransform(slam.shakeDx, false, dpr);
  const panelTf = slamTransform(slam.shakeDx, slam.squash, dpr);
  if (tvTf) slamStyle["--slam-tv-tf"] = tvTf;
  if (panelTf) slamStyle["--slam-panel-tf"] = panelTf;
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
  const onFace = (tv: FaceBot) => setOpen((o) => skyFaceClick(skyEffectiveOpen(o, can), tv, can));
  // While a chat is open the left TV is the open bot's face (clickable to close); the right TV is under the chat.
  const clickable = (tv: FaceBot) => (open !== null ? tv === "riffbot" : can[tv]);
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
      <Zone zone={zones.riffbot} lander={zones.overlord} faces={faces} frameStyle={frameStyle} force={skyRiffMode(open, hasFaceMode(faces, "riffbot", "scared"))} takeover={takeover} labelModel={labelModel} taken={open === "overlord"} clickable={clickable("riffbot")} isOpen={open !== null} openLabel={open ? LABEL[open] : undefined} onFace={() => onFace("riffbot")} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <Zone zone={zones.overlord} faces={faces} frameStyle={frameStyle} force={slamFaceForce(slam, faces)} fx={slamOn ? { shake: true } : null} clickable={clickable("overlord")} isOpen={open === "overlord"} onFace={() => onFace("overlord")} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
      <Zone panel zone={zones.riffbot} faces={faces} frameStyle={frameStyle} fx={slamOpening || slamOn ? { held: slamOpening, shake: slamOn } : null} isOpen={open === "riffbot"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <SlamFx root={root} view={slam} faces={faces} puff={puff} closing={open !== "riffbot"} />
      <span className={`sky-wall${wallStyle ? " has-art" : ""}`} data-testid="sky-wall" aria-hidden="true" style={wallStyle ?? skyWallFallbackStyle(dpr)} />
      <Zone panel zone={zones.overlord} faces={faces} frameStyle={frameStyle} isOpen={open === "overlord"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
    </div>
  );
}
