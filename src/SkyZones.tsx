// Sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G1): two sky-CRT zones above the tower. RiffBot (hub Buddy) on the
// left, the Overlord (hub lead) on the right. Each zone is a CRT bezel with the bot's face and that bot's live
// chat, rendered by the same DrawerSlot AgentPanes uses, so nothing about the chat is re-implemented. Every
// zone owns its own agent, drawer and composer; nothing is shared between them.
import { DrawerSlot } from "./AgentPanes";
import type { Pin } from "./pins";
import { NO_OVERLORD_TEXT, skyZonesFor, type SkyZone } from "./skyZonesLogic";
import type { FaceBot } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useFacesModel, usePrefersReducedMotion, useTheme } from "./useBotFace";

const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };

function ZoneFace({ zone, faces }: { zone: SkyZone; faces: ReturnType<typeof useFacesModel> }) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const face = useBotFace(zone.bot, zone.pose ? { pose: zone.pose } : null, faces, { theme, reduced });
  const cell = faces?.cell ?? { w: 128, h: 96 };
  return (
    <span
      className={`sky-face${face.frame ? "" : " is-blank"}`}
      data-testid={`sky-face-${zone.bot}`}
      data-face-mode={face.mode}
      aria-hidden="true"
      style={{ width: cell.w, height: cell.h, ...face.style }}
    />
  );
}

function Zone({
  zone,
  faces,
  onSuccessor,
  onStart,
}: {
  zone: SkyZone;
  faces: ReturnType<typeof useFacesModel>;
  onSuccessor: (id: string) => void;
  onStart?: () => void;
}) {
  const label = LABEL[zone.bot];
  const off = zone.bot === "overlord" && !zone.member;
  return (
    <section
      className={`sky-zone sky-zone-${zone.bot}${off ? " is-off" : ""}`}
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
          <DrawerSlot id={zone.agentId} pane="left" shown onSuccessor={onSuccessor} />
        ) : off ? (
          <div className="sky-static" data-testid="sky-static-overlord" role="status">
            <span className="sky-static-text">{NO_OVERLORD_TEXT}</span>
          </div>
        ) : (
          <div className="sky-static" data-testid="sky-idle-riffbot" role="status">
            <span className="sky-static-text">RiffBot is not running</span>
            {onStart && (
              <button type="button" className="btn small" data-testid="sky-start-riffbot" onClick={onStart}>
                Start RiffBot
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
  onStartRiffBot,
}: {
  view: TeamView;
  onSuccessor: (id: string) => void;
  /** Same handler HubBar uses to quick-start RiffBot (App onQuickStart). */
  onStartRiffBot?: (pin: Pin) => void | Promise<unknown>;
}) {
  const zones = skyZonesFor(view);
  const faces = useFacesModel();
  const { hub } = zones;
  return (
    <div className="sky-zones" data-testid="sky-zones">
      <Zone zone={zones.riffbot} faces={faces} onSuccessor={onSuccessor} onStart={hub && onStartRiffBot ? () => void Promise.resolve(onStartRiffBot(hub)).catch(() => {}) : undefined} />
      <Zone zone={zones.overlord} faces={faces} onSuccessor={onSuccessor} />
    </div>
  );
}
