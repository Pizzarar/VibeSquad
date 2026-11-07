// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, SKY_FRAME_URL, SKY_URL, TAKEOVER_FALLBACK, TAKEOVER_URL, faceBg, faceContain, hasFaceMode, skyAssets, skyColumns, skyLayout, skyZonesFor, takeoverVisible, type SkyZone, type TakeoverModel } from "./skyZonesLogic";
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
  const stage = useRef<HTMLSpanElement>(null); // the face box: the part of the zone the chat does not cover
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

function Zone({
  zone,
  faces,
  frameStyle,
  force = null,
  takeover = null,
  squeezed = false,
  onReclaim,
  onSuccessor,
  onSpinUp,
  busy = false,
}: {
  zone: SkyZone;
  /** Riff while the Overlord is expanded: its chat is hidden, so the strip itself is the keyboard way back (a11y). */
  squeezed?: boolean;
  /** Hand the sky back to this zone (50/50) and move focus into its composer. */
  onReclaim?: () => void;
  faces: ReturnType<typeof useFacesModel>;
  /** Forced face mode (Riff scared while the Overlord is expanded). */
  force?: FaceMode | null;
  /** G7 overlay sheet model (Riff's zone only). */
  takeover?: TakeoverModel | null;
  /** The @art sky-CRT bezel as a border-image style (from sky-crt.json + PNG) when both exist; null → the CSS bezel. */
  frameStyle: Record<string, string> | null;
  onSuccessor: (id: string) => void;
  /** Start (no Buddy) or resume (dormant) RiffBot: App's onSpinUpPin, the same path as the Spin Up button. */
  onSpinUp?: () => void;
  /** The Overlord spawn is running: its Spin Up / Resume button is disabled. */
  busy?: boolean;
}) {
  const label = LABEL[zone.bot];
  const off = zone.bot === "overlord" && !zone.agentId; // a closed Overlord keeps its zone (history + Resume)
  return (
    <section
      className={`sky-zone sky-zone-${zone.bot}${off ? " is-off" : ""}${frameStyle ? " has-frame" : ""}`}
      style={frameStyle ?? undefined}
      data-testid={`sky-zone-${zone.bot}`}
      data-sky-bot={zone.bot}
      data-agent={zone.agentId ?? ""}
      aria-label={squeezed ? `${label} chat, press to expand` : `${label} chat`}
      // Squeezed: tabbable (0). Otherwise -1, not absent, so the focused strip doesn't lose focus the moment it un-squeezes.
      tabIndex={onReclaim ? (squeezed ? 0 : -1) : undefined}
      onFocus={(e) => squeezed && e.target === e.currentTarget && onReclaim?.()}
      onKeyDown={(e) => {
        if (squeezed && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onReclaim?.();
        }
      }}
    >
      {!off && <ZoneFace zone={zone} faces={faces} force={force} takeover={takeover} expanded={squeezed} />}
      <span className="sky-crt-name">{label}</span>
      <div className="sky-crt-body">
        {zone.agentId ? (
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
        ) : off ? (
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

  // G6: "Overlord active" = focus/click inside its zone, or it is talking. Pure decision in skyLayout().
  const [focus, setFocus] = useState<FaceBot | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const layout = skyLayout({
    overlordLive: !!zones.overlord.member,
    overlordFocused: focus === "overlord",
    overlordTalking: zones.overlord.pose === "work",
    riffFocused: focus === "riffbot",
    riffHasScared: hasFaceMode(faces, "riffbot", "scared"),
  });
  const zoneOf = (t: EventTarget | null): FaceBot | null => {
    const el = t instanceof Element ? t.closest<HTMLElement>("[data-sky-bot]") : null;
    return el && root.current?.contains(el) ? (el.dataset.skyBot as FaceBot) : null;
  };
  const onFocusIn = (e: React.FocusEvent) => setFocus(zoneOf(e.target));
  const onFocusOut = (e: React.FocusEvent) => {
    if (!e.relatedTarget || zoneOf(e.relatedTarget) !== zoneOf(e.target)) setFocus(zoneOf(e.relatedTarget));
  };
  // A click in a zone's chat (even on plain text) counts; a click anywhere else, or Escape, hands the sky back.
  useEffect(() => {
    const down = (e: PointerEvent) => setFocus(zoneOf(e.target));
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFocus(null);
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
  // Riff's chat is hidden while squeezed; this is the keyboard path back: 50/50 (riffFocused), then into its composer.
  const reclaimRiff = () => {
    setFocus("riffbot");
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-sky-bot="riffbot"] textarea')?.focus());
  };
  // Zone bezel on both sides: the sky-crt border-image widths when it is drawn, else the 7px CSS border.
  const bezelH = crt && frameStyle ? (crt.slice.left + crt.slice.right) * crt.scale : 14;
  const cols = skyColumns(layout, faces?.cell ?? { w: 48 }, bezelH);
  return (
    <div
      ref={root}
      className={`sky-zones${skyUrl ? " has-sky-art" : ""}${layout.expanded ? " is-expanded" : ""}`}
      data-testid="sky-zones"
      data-expanded={layout.expanded ? "overlord" : "none"}
      style={{ ["--sky-cols" as string]: cols, ...(skyUrl ? { backgroundImage: `url(${skyUrl})` } : null) }}
      onFocus={onFocusIn}
      onBlur={onFocusOut}
    >
      <Zone zone={zones.riffbot} faces={faces} frameStyle={frameStyle} force={layout.riffMode} takeover={takeover} squeezed={layout.expanded} onReclaim={reclaimRiff} onSuccessor={onSuccessor} onSpinUp={hub && onSpinUp ? () => onSpinUp(hub) : undefined} />
      <Zone zone={zones.overlord} faces={faces} frameStyle={frameStyle} onSuccessor={onSuccessor} onSpinUp={hub && onSpinUpOverlord ? () => onSpinUpOverlord(view) : undefined} busy={overlordBusy} />
    </div>
  );
}
