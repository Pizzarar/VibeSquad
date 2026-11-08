// Hub pages (docs/PLAN_HUB_PAGES.md HP1-HP3): a Sky / Tower switcher over one shared skyline backdrop. The Sky page is the
// two sky-CRT chats; the Tower page is a slim sky band (mini RiffBot + Overlord faces) over the tower. The needs-you strip
// shows on both. The page choice persists; there is no animation, so the switch is instant under reduced motion too.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { HUB_BACKDROP_JSON, HUB_BACKDROP_URL, HUB_PAGES, backdropStyle, miniFaceJump, readHubPage, validateHubBackdrop, writeHubPage, type HubBackdrop, type HubPage } from "./hubPagesLogic";
import { SKY_URL, faceBg, faceContain, skyZonesFor, type SkyOpen } from "./skyZonesLogic";
import type { FaceBot } from "./squadFloorLogic";
import type { TeamView } from "./teams";
import { useBotFace, useDpr, useFacesModel, useImageOk, usePrefersReducedMotion, useTheme } from "./useBotFace";

const LABEL: Record<FaceBot, string> = { riffbot: "RiffBot", overlord: "Overlord" };
const PLATE_INSET = 6; // .sq-floor-tower's bottom padding: the plate's bottom edge sits this far above the page bottom

function useHubBackdrop(): HubBackdrop | null {
  const [model, setModel] = useState<HubBackdrop | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(HUB_BACKDROP_JSON)
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined)
      .then((json) => alive && setModel(validateHubBackdrop(json)));
    return () => {
      alive = false;
    };
  }, []);
  return model;
}

/** The shared layer behind both pages: the A1 skyline when json + PNG load, else today's sky band over a gradient. */
function Backdrop({ width }: { width: number }) {
  const theme = useTheme();
  const dpr = useDpr();
  const model = useHubBackdrop();
  const artOk = useImageOk(model ? HUB_BACKDROP_URL(theme) : null);
  const skyOk = useImageOk(!artOk ? SKY_URL(theme) : null);
  if (model && artOk) return <div className="hub-backdrop has-art" data-testid="hub-backdrop" aria-hidden="true" style={backdropStyle(model, width, theme, dpr, PLATE_INSET)} />;
  return <div className={`hub-backdrop is-fallback${skyOk ? " has-sky-band" : ""}`} data-testid="hub-backdrop" aria-hidden="true" style={skyOk ? { backgroundImage: `url(${SKY_URL(theme)})` } : undefined} />;
}

/** A small live face (idle / talk from the agent's pose) that jumps to the Sky page with that bot's chat open. */
function MiniFace({ view, bot, onJump }: { view: TeamView; bot: FaceBot; onJump: (bot: FaceBot) => void }) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const dpr = useDpr();
  const faces = useFacesModel();
  const zone = skyZonesFor(view)[bot];
  const face = useBotFace(bot, zone.pose ? { pose: zone.pose } : null, faces, { theme, reduced });
  const cell = faces?.cell ?? { w: 48, h: 48 };
  const box = { w: cell.w * 2, h: cell.h * 2 };
  const { k, left, top } = faceContain(cell, box, dpr);
  const bg = faceBg(faces, bot, theme);
  return (
    <button type="button" className={`hub-mini-face hub-mini-${bot}`} data-testid={`hub-mini-${bot}`} aria-label={`Open ${LABEL[bot]} chat`} onClick={() => onJump(bot)}>
      <span className="hub-mini-screen" style={{ width: box.w, height: box.h, ...(bg ? ({ ["--sky-face-bg-custom" as string]: bg } as React.CSSProperties) : null) }}>
        {k > 0 && <span className={`sky-face${face.frame ? "" : " is-blank"}`} data-testid={`hub-mini-face-${bot}`} data-face-mode={face.mode} style={{ width: cell.w, height: cell.h, left, top, transform: `scale(${k})`, ...face.style }} />}
      </span>
      <span className="hub-mini-name">{LABEL[bot]}</span>
    </button>
  );
}

export function HubPages({
  view,
  sky,
  strip,
  tower,
  agentOpen = false,
}: {
  view: TeamView;
  /** The Sky page body; `open` is the bot whose chat should start open (a mini-face jump), else null. */
  sky: (open: SkyOpen) => ReactNode;
  /** The needs-you strip (same node on both pages). */
  strip: ReactNode;
  /** The tower, drawn inside a fixed-height, non-scrolling box. */
  tower: ReactNode;
  /** Another agent is open on the hub lane: the sky steps aside, so no pages: the strip and tower stack as before. */
  agentOpen?: boolean;
}) {
  const [page, setPage] = useState<HubPage>(() => readHubPage());
  const [jump, setJump] = useState<SkyOpen>(null);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => es.forEach((e) => setWidth(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const choose = (p: HubPage) => {
    setJump(null);
    setPage(p);
    writeHubPage(p);
  };
  const onJump = (bot: FaceBot) => {
    const j = miniFaceJump(bot);
    setJump(j.open);
    setPage(j.page);
    writeHubPage(j.page);
  };
  if (agentOpen) return <>{strip}{tower}</>;
  return (
    <div ref={root} className="hub-pages" data-testid="hub-pages" data-page={page}>
      <Backdrop width={width} />
      <div className="hub-tabs" role="tablist" aria-label="Hub page" data-testid="hub-tabs">
        {HUB_PAGES.map((p) => (
          <button key={p} type="button" role="tab" className={`hub-tab${page === p ? " is-on" : ""}`} data-testid={`hub-tab-${p}`} aria-selected={page === p} onClick={() => choose(p)}>
            {p === "sky" ? "Sky" : "Tower"}
          </button>
        ))}
      </div>
      {page === "sky" ? (
        <div className="hub-sky-page" data-testid="hub-sky-page">
          {sky(jump)}
          {strip}
        </div>
      ) : (
        <div className="hub-tower-page" data-testid="hub-tower-page">
          <div className="hub-tower-sky" data-testid="hub-tower-sky">
            <MiniFace view={view} bot="riffbot" onJump={onJump} />
            <MiniFace view={view} bot="overlord" onJump={onJump} />
          </div>
          {strip}
          <div className="hub-tower-box" data-testid="hub-tower-box">
            {tower}
          </div>
        </div>
      )}
    </div>
  );
}
