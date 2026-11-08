// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, SKY_COLUMNS, SKY_FRAME_URL, SKY_POPOVER_SELECTOR, SKY_WALL_URL, SKY_URL, TAKEOVER_FALLBACK, TAKEOVER_URL, faceBg, faceContain, hasFaceMode, skyAssets, skyEffectiveOpen, skyEscCloses, skyExit, skyFaceClick, skyOutsideCloses, skyRiffMode, skyWallStyle, skyZonesFor, takeoverVisible, type SkyCan, type SkyOpen, type SkyZone, type TakeoverModel } from "./skyZonesLogic";
import type { FaceBot, FaceMode } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useFacesModel, useImageOk, usePrefersReducedMotion, useSkyCrtModel, useTakeoverClock, useTakeoverModel, useTheme } from "./useBotFace";

const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

/** G6-fix2: the bot's whole face, as big as an integer scale fits (contain, never cropped), centred on a per-bot gutter colour. */
function ZoneFace({
  zone,
  faces,
  force,
  takeover,
  expanded,
}: {
  zone: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  force: FaceMode | null;
  /** Riff only (G7): the overlay sheet when takeover.json + the theme PNG both load; null → the CSS dissolve. */
  takeover?: TakeoverModel | null;
  expanded?: boolean;
}) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const isRiff = zone.bot === "riffbot";
  // G7: the overlay clock. The sheet is used only when json AND the theme PNG are present (same skip-if-absent as G4).
  const sheetOk = useImageOk(isRiff && takeover ? TAKEOVER_URL(theme) : null);
  const sheet = sheetOk ? takeover : null;
  const clock = useTakeoverClock(!!expanded && isRiff, sheet?.fps ?? TAKEOVER_FALLBACK.fps, sheet?.frames.length ?? 0, reduced);
  const showSheet = !!sheet && takeoverVisible(clock.pos, !!expanded, reduced);
  // Riff keeps playing scared underneath until the reverse has finished, then goes idle.
  const holdScared = showSheet && !force && hasFaceMode(faces, "riffbot", "scared");
  const face = useBotFace(zone.bot, zone.pose ? { pose: zone.pose } : null, faces, { theme, reduced, force: force ?? (holdScared ? "scared" : null) });
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
  const bg = faceBg(faces, zone.bot, theme);
  const { k, left, top } = faceContain(cell, box);
  const tk = sheet ? faceContain(sheet.cell, box) : null;
  const tf = sheet?.frames[clock.frame];
  return (
    <span className="sky-face-stage" aria-hidden="true" style={bg ? ({ ["--sky-face-bg-custom" as string]: bg } as React.CSSProperties) : undefined}>
      <span ref={stage} className="sky-face-area" data-testid={`sky-face-area-${zone.bot}`}>
      {k > 0 && (
        <span
          className={`sky-face${face.frame ? "" : " is-blank"}`}
          data-testid={`sky-face-${zone.bot}`}
          data-face-mode={face.mode}
          style={{ width: cell.w, height: cell.h, left, top, transform: `scale(${k})`, ...face.style }}
        />
      )}
      {showSheet && sheet && tk && tf && tk.k > 0 && (
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
      {isRiff && !sheet && !reduced && <span className={`sky-takeover-fallback${expanded ? " is-on" : ""}`} data-testid="sky-takeover-fallback" />}
    </span>
  );
}

/**
 * One sky TV or one chat panel. `panel` false = the TV: just the bot's portrait filling the screen (plus the static / Spin Up
 * states when it has no agent). `panel` true = the bot's chat (messages + composer, no drawer) laid over the right TV.
 */
function Zone({
  zone,
  faces,
  frameStyle,
  panel = false,
  force = null,
  takeover = null,
  taken = false,
  clickable = false,
  isOpen = false,
  openLabel,
  onFace,
  onClose,
  onSuccessor,
  onSpinUp,
  busy = false,
}: {
  zone: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  panel?: boolean;
  /** Forced face mode (Riff scared while the Overlord has taken it over). */
  force?: FaceMode | null;
  /** G7 overlay sheet model (Riff's TV only). */
  takeover?: TakeoverModel | null;
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
}) {
  const label = LABEL[zone.bot];
  openLabel ??= label;
  const off = zone.bot === "overlord" && !zone.agentId; // a closed Overlord keeps its zone (history + Resume)
  const idle = !panel && zone.bot === "riffbot" && !zone.agentId; // RiffBot not running: dimmed whole face + a bottom Spin Up strip
  return (
    <section
      className={`sky-zone sky-zone-${zone.bot}${panel ? " sky-chat-panel" : ""}${off ? " is-off" : ""}${idle ? " is-idle" : ""}${frameStyle ? " has-frame" : ""}`}
      style={frameStyle ?? undefined}
      data-testid={panel ? `sky-chat-${zone.bot}` : `sky-zone-${zone.bot}`}
      data-sky-bot={zone.bot}
      data-agent={zone.agentId ?? ""}
      aria-label={`${label} chat`}
      hidden={panel && !isOpen}
    >
      {!panel && !off && <ZoneFace zone={zone} faces={faces} force={force} takeover={takeover} expanded={taken} />}
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
      <span className="sky-crt-name">{label}</span>
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

export function SkyZones({
  view,
  onSuccessor,
  onSpinUp,
  onSpinUpOverlord,
  overlordBusy = false,
}: {
  view: TeamView;
  onSuccessor: (id: string) => void;
  /** App's onSpinUpPin (the Spin Up button's path): starts a fresh RiffBot session or resumes a dormant one. */
  onSpinUp?: (pin: Pin) => void;
  /** Spawn the hub lead (Spin Up / Resume Overlord); the new agent lands in the right zone once the store has it. */
  onSpinUpOverlord?: (view: TeamView) => void;
  overlordBusy?: boolean;
}) {
  const zones = skyZonesFor(view);
  const faces = useFacesModel();
  const theme = useTheme();
  // @art assets are optional: probe each, skip the absent ones (CSS gradient sky + CSS bezel stay).
  const crt = useSkyCrtModel();
  const { skyUrl, frameStyle } = skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) }, crt);
  const takeover = useTakeoverModel();
  const { hub } = zones;
  // G8c: the wall between the TVs. Art from sky-crt.json `wall` when its PNG loads, else the CSS ink seam. Absolute: takes no grid space.
  const wallUrl = crt?.wall ? SKY_WALL_URL(theme) : null;
  const wallStyle = skyWallStyle(crt?.wall, crt?.scale ?? 1, useImageOk(wallUrl) ? wallUrl : null);

  // G8: the TVs never resize. `openRaw` is set by clicks only; the Overlord talking never opens anything.
  const can: SkyCan = { riffbot: !!zones.riffbot.agentId, overlord: !!zones.overlord.member };
  const [openRaw, setOpen] = useState<SkyOpen>(null);
  const open = skyEffectiveOpen(openRaw, can); // the Overlord closing under an open chat drops back to rest
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef<SkyOpen>(null);
  openRef.current = open;
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
  return (
    <div
      ref={root}
      className={`sky-zones${skyUrl ? " has-sky-art" : ""}${open ? ` is-open is-open-${open}` : ""}`}
      data-testid="sky-zones"
      data-open={open ?? "none"}
      style={{ ["--sky-cols" as string]: SKY_COLUMNS, ...(skyUrl ? { backgroundImage: `url(${skyUrl})` } : null) }}
    >
      <Zone zone={zones.riffbot} faces={faces} frameStyle={frameStyle} force={skyRiffMode(open, hasFaceMode(faces, "riffbot", "scared"))} takeover={takeover} taken={open === "overlord"} clickable={clickable("riffbot")} isOpen={open !== null} openLabel={open ? LABEL[open] : undefined} onFace={() => onFace("riffbot")} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <Zone zone={zones.overlord} faces={faces} frameStyle={frameStyle} clickable={clickable("overlord")} isOpen={open === "overlord"} onFace={() => onFace("overlord")} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
      <Zone panel zone={zones.riffbot} faces={faces} frameStyle={frameStyle} isOpen={open === "riffbot"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinRiff} />
      <span className={`sky-wall${wallStyle ? " has-art" : ""}`} data-testid="sky-wall" aria-hidden="true" style={wallStyle ?? undefined} />
      <Zone panel zone={zones.overlord} faces={faces} frameStyle={frameStyle} isOpen={open === "overlord"} onClose={() => setOpen(skyExit)} onSuccessor={onSuccessor} onSpinUp={spinOverlord} busy={overlordBusy} />
    </div>
  );
}
