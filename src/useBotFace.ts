// Shared bot-face plumbing (docs/PLAN_SKY_GODS_C2B.md G2): theme, reduced-motion, image probing, faces.json
// loading and the talk/needs/blink/idle mode logic. The tower no longer draws faces; the sky zones do.
import { useEffect, useState } from "react";
import {
  BLINK_MS,
  faceFrame,
  faceMode,
  idleFaceMode,
  nextBlinkDelay,
  validateFaces,
  type FaceBot,
  type FaceMode,
  type FacesModel,
  type Frame,
  type SeatedAgent,
} from "./squadFloorLogic";

export type Theme = "dark" | "light";

// ── Theme (U1 `[data-theme]`, dark when absent) ────────────────────────────────
const readTheme = (): Theme =>
  typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
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

export function usePrefersReducedMotion(): boolean {
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

/** True once an image at `url` loads (per theme); resets to false on error so the caller falls back. A null url is "absent". */
export function useImageOk(url: string | null): boolean {
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

export const FACE_URL = (bot: FaceBot, theme: Theme) => `/office/face-${bot}-${theme}.png`;

/** faces.json, loaded once; missing/invalid → null (callers fall back to a plain bezel). */
export function useFacesModel(): FacesModel | null {
  const [faces, setFaces] = useState<FacesModel | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/office/faces.json")
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined)
      .then((json) => {
        if (cancelled) return;
        const f = validateFaces(json);
        setFaces(f.ok ? f.value : null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return faces;
}

export type BotFace = {
  mode: FaceMode;
  frame: Frame | null;
  /** Ready-to-spread CSS for the face cell (empty when the sheet or faces.json is absent). */
  style: { backgroundImage?: string; backgroundPosition?: string };
  sheetUrl: string;
};

/**
 * One bot's face: talk while running, needs on needs-you, random blink otherwise. Reduced motion freezes the
 * ticker and the blinker (frame 0, never "blink"). `agent` null → idle (the zone shows static instead).
 */
export function useBotFace(
  bot: FaceBot,
  agent: Pick<SeatedAgent, "pose"> | null,
  faces: FacesModel | null,
  opts: { theme: Theme; reduced: boolean },
): BotFace {
  const { theme, reduced } = opts;
  const sheetUrl = FACE_URL(bot, theme);
  const sheetOk = useImageOk(faces?.bots[bot] ? sheetUrl : null);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced || !faces) return;
    const t = setInterval(() => setTick((n) => n + 1), Math.round(1000 / faces.fps));
    return () => clearInterval(t);
  }, [reduced, faces]);

  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (reduced || !faces) {
      setBlinking(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setBlinking(true);
        timer = setTimeout(() => {
          if (!alive) return;
          setBlinking(false);
          loop();
        }, BLINK_MS);
      }, nextBlinkDelay(Math.random()));
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reduced, faces]);

  const base = faceMode(agent, blinking && !reduced);
  const mode = base === "idle" ? idleFaceMode(faces, bot) : base; // lookDown replaces idle once it exists
  const frame = faces && sheetOk ? faceFrame(faces, bot, mode, reduced ? 0 : tick) : null;
  return {
    mode,
    frame,
    sheetUrl,
    style: frame ? { backgroundImage: `url(${sheetUrl})`, backgroundPosition: `-${frame.x}px -${frame.y}px` } : {},
  };
}
