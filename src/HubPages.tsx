// Hub view (docs/PLAN_HUB_PAGES.md HP5): one view, no tabs. The big RiffBot + Overlord TVs band on top, the needs-you strip,
// then one floor filling the rest of the height with its bottom edge flush to the page bottom, all over the A1 skyline backdrop
// (visible left and right of the floor).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HUB_BACKDROP_JSON, HUB_BACKDROP_URL, backdropStyle, isShortCssHeight, validateHubBackdrop, type HubBackdrop } from "./hubPagesLogic";
import { SKY_URL } from "./skyZonesLogic";
import { fetchFloorJson, peekFloorJson, floorNativeSize, floorNeedCssPx, floorOrPlaceholder } from "./squadFloorLogic";
import { useUiScale } from "./uiScale";
import { useDpr, useImageOk, useTheme } from "./useBotFace";

const PLATE_INSET = 0; // HP5: the floor plate sits flush on the page bottom (no road / ground strip, no gap)

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

/** The floor plate's native size from floor.json (the placeholder 640x360 until it loads): the floor box must hold this many device px, so the TVs band yields. */
function useFloorNative(): { w: number; h: number } {
  const [size, setSize] = useState(() => floorNativeSize(floorOrPlaceholder(peekFloorJson().json)));
  useEffect(() => {
    let alive = true;
    fetchFloorJson().then((json) => alive && setSize(floorNativeSize(floorOrPlaceholder(json))));
    return () => {
      alive = false;
    };
  }, []);
  return size;
}

/** The layer behind the TVs and the floor: the A1 skyline when json + PNG load, else today's sky band over a gradient. */
function Backdrop({ width }: { width: number }) {
  const theme = useTheme();
  const dpr = useDpr();
  const model = useHubBackdrop();
  const artOk = useImageOk(model ? HUB_BACKDROP_URL(theme) : null);
  const skyOk = useImageOk(!artOk ? SKY_URL(theme) : null);
  if (model && artOk) return <div className="hub-backdrop has-art" data-testid="hub-backdrop" aria-hidden="true" style={backdropStyle(model, width, theme, dpr, PLATE_INSET)} />;
  return <div className={`hub-backdrop is-fallback${skyOk ? " has-sky-band" : ""}`} data-testid="hub-backdrop" aria-hidden="true" style={skyOk ? { backgroundImage: `url(${SKY_URL(theme)})` } : undefined} />;
}

export function HubPages({
  sky,
  strip,
  tower,
  agentOpen = false,
}: {
  /** The TVs band (RiffBot + Overlord sky zones). */
  sky: ReactNode;
  /** The needs-you strip. */
  strip: ReactNode;
  /** The tower, drawn inside a box that fills the rest of the height and never scrolls. */
  tower: ReactNode;
  /** Another agent is open on the hub lane: the sky steps aside, so the strip and tower stack as before. */
  agentOpen?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pageH, setPageH] = useState(0);
  const [vh, setVh] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 1080));
  const uiScale = useUiScale();
  const shortHeight = isShortCssHeight(vh, uiScale);
  // FF-ui: the floor box is never shorter than the floor at 1 device px per native px; the TVs band (flex-shrink) gives up the height.
  const native = useFloorNative();
  const floorNeed = floorNeedCssPx(native.h, useDpr(), uiScale, width, native.w);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => es.forEach((e) => { setWidth(e.contentRect.width); setPageH(e.contentRect.height); }));
    ro.observe(el);
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [agentOpen]); // the root div only exists while the agent is not open
  if (agentOpen) return <>{strip}{tower}</>;
  return (
    <div ref={root} className="hub-pages" data-testid="hub-pages" data-short-height={shortHeight ? "true" : undefined} style={{ "--floor-need": `${floorNeed}px`, ...(pageH > 0 ? { "--hub-page-h": `${pageH}px` } : null) } as CSSProperties}>
      <Backdrop width={width} />
      <div className="hub-sky-page" data-testid="hub-sky-page">
        {sky}
      </div>
      {strip}
      <div className="hub-tower-box" data-testid="hub-tower-box">
        {tower}
      </div>
    </div>
  );
}
