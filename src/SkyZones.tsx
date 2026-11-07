// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, SKY_FRAME_URL, SKY_URL, faceScale, skyAssets, skyZonesFor, type SkyZone } from "./skyZonesLogic";
import type { FaceBot } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useFacesModel, useImageOk, usePrefersReducedMotion, useTheme } from "./useBotFace";

const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

function ZoneFace({ zone, faces }: { zone: SkyZone; faces: ReturnType<typeof useFacesModel> }) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const face = useBotFace(zone.bot, zone.pose ? { pose: zone.pose } : null, faces, { theme, reduced });
  // Cell size comes from faces.json (never hardcoded); until it loads, a blank placeholder box.
  const cell = faces?.cell ?? { w: 48, h: 48 };
  const k = faceScale(cell);
  return (
    <span className="sky-face-box" style={{ width: cell.w * k, height: cell.h * k }}>
      <span
        className={`sky-face${face.frame ? "" : " is-blank"}`}
        data-testid={`sky-face-${zone.bot}`}
        data-face-mode={face.mode}
        aria-hidden="true"
        style={{ width: cell.w, height: cell.h, transform: `scale(${k})`, ...face.style }}
      />
    </span>
  );
}

function Zone({
  zone,
  faces,
  frameUrl,
  onSuccessor,
  onSpinUp,
}: {
  zone: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  /** The @art sky-CRT bezel when it exists; null → the CSS bezel. */
  frameUrl: string | null;
  onSuccessor: (id: string) => void;
  /** Start (no Buddy) or resume (dormant) RiffBot: App's onSpinUpPin, the same path as the Spin Up button. */
  onSpinUp?: () => void;
}) {
  const label = LABEL[zone.bot];
  const off = zone.bot === "overlord" && !zone.member;
  return (
    <section
      className={`sky-zone sky-zone-${zone.bot}${off ? " is-off" : ""}${frameUrl ? " has-frame" : ""}`}
      data-testid={`sky-zone-${zone.bot}`}
      data-agent={zone.agentId ?? ""}
      aria-label={`${label} chat`}
    >
      <header className="sky-crt-head">
        <ZoneFace zone={zone} faces={faces} />
        <span className="sky-crt-name">{label}</span>
      </header>
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
      {frameUrl && <img className="sky-crt-frame" data-testid={`sky-frame-${zone.bot}`} src={frameUrl} alt="" draggable={false} />}
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
  const { skyUrl, frameUrl } = skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) });
  const { hub } = zones;
  return (
    <div className={`sky-zones${skyUrl ? " has-sky-art" : ""}`} data-testid="sky-zones" style={skyUrl ? { backgroundImage: `url(${skyUrl})` } : undefined}>
      <Zone zone={zones.riffbot} faces={faces} frameUrl={frameUrl} onSuccessor={onSuccessor} onSpinUp={hub && onSpinUp ? () => onSpinUp(hub) : undefined} />
      <Zone zone={zones.overlord} faces={faces} frameUrl={frameUrl} onSuccessor={onSuccessor} />
    </div>
  );
}
