// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, SKY_FRAME_URL, SKY_URL, faceBg, faceContain, hasFaceMode, skyAssets, skyColumns, skyLayout, skyZonesFor, type SkyZone } from "./skyZonesLogic";
import type { FaceBot, FaceMode } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useFacesModel, useImageOk, usePrefersReducedMotion, useSkyCrtModel, useTheme } from "./useBotFace";

const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

/** G6-fix2: the bot's whole face, as big as an integer scale fits (contain, never cropped), centred on a per-bot gutter colour. */
function ZoneFace({ zone, faces, force }: { zone: SkyZone; faces: ReturnType<typeof useFacesModel>; force: FaceMode | null }) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const face = useBotFace(zone.bot, zone.pose ? { pose: zone.pose } : null, faces, { theme, reduced, force });
  // Cell size comes from faces.json (never hardcoded); until it loads, a blank stage.
  const cell = faces?.cell ?? { w: 48, h: 48 };
  const stage = useRef<HTMLSpanElement>(null);
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
  const bg = faceBg(faces, zone.bot);
  const { k, left, top } = faceContain(cell, box);
  return (
    <span ref={stage} className="sky-face-stage" aria-hidden="true" style={bg ? ({ ["--sky-face-bg-custom" as string]: bg } as React.CSSProperties) : undefined}>
      {k > 0 && (
        <span
          className={`sky-face${face.frame ? "" : " is-blank"}`}
          data-testid={`sky-face-${zone.bot}`}
          data-face-mode={face.mode}
          style={{ width: cell.w, height: cell.h, left, top, transform: `scale(${k})`, ...face.style }}
        />
      )}
    </span>
  );
}

function Zone({
  zone,
  faces,
  frameStyle,
  force = null,
  squeezed = false,
  onReclaim,
  onSuccessor,
  onSpinUp,
}: {
  zone: SkyZone;
  /** Riff while the Overlord is expanded: its chat is hidden, so the strip itself is the keyboard way back (a11y). */
  squeezed?: boolean;
  /** Hand the sky back to this zone (50/50) and move focus into its composer. */
  onReclaim?: () => void;
  faces: ReturnType<typeof useFacesModel>;
  /** Forced face mode (Riff scared while the Overlord is expanded). */
  force?: FaceMode | null;
  /** The @art sky-CRT bezel as a border-image style (from sky-crt.json + PNG) when both exist; null → the CSS bezel. */
  frameStyle: Record<string, string> | null;
  onSuccessor: (id: string) => void;
  /** Start (no Buddy) or resume (dormant) RiffBot: App's onSpinUpPin, the same path as the Spin Up button. */
  onSpinUp?: () => void;
}) {
  const label = LABEL[zone.bot];
  const off = zone.bot === "overlord" && !zone.member;
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
      {!off && <ZoneFace zone={zone} faces={faces} force={force} />}
      <span className="sky-crt-name">{label}</span>
      <div className="sky-crt-body">
        {zone.agentId ? (
          <>
            {zone.dormant && onSpinUp && (
              <div className="sky-resume" data-testid="sky-resume-riffbot">
                <span className="muted small">This chat is closed (history below).</span>
                <button type="button" className="btn ok small" data-testid="sky-resume-btn" onClick={onSpinUp}>
                  Resume RiffBot
                </button>
              </div>
            )}
            <DrawerSlot id={zone.agentId} pane="left" shown onSuccessor={onSuccessor} />
          </>
        ) : off ? (
          <div className="sky-static" data-testid="sky-static-overlord" role="status">
            <span className="sky-static-text">{NO_OVERLORD_TEXT}</span>
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
}: {
  view: TeamView;
  onSuccessor: (id: string) => void;
  /** App's onSpinUpPin (the Spin Up button's path): starts a fresh RiffBot session or resumes a dormant one. */
  onSpinUp?: (pin: Pin) => void;
}) {
  const zones = skyZonesFor(view);
  const faces = useFacesModel();
  const theme = useTheme();
  // @art assets are optional: probe each, skip the absent ones (CSS gradient sky + CSS bezel stay).
  const crt = useSkyCrtModel();
  const { skyUrl, frameStyle } = skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) }, crt);
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
      <Zone zone={zones.riffbot} faces={faces} frameStyle={frameStyle} force={layout.riffMode} squeezed={layout.expanded} onReclaim={reclaimRiff} onSuccessor={onSuccessor} onSpinUp={hub && onSpinUp ? () => onSpinUp(hub) : undefined} />
      <Zone zone={zones.overlord} faces={faces} frameStyle={frameStyle} onSuccessor={onSuccessor} />
    </div>
  );
}
