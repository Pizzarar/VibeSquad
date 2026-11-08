// Shared bot-face plumbing (docs/PLAN_SKY_GODS_C2B.md G2): theme, reduced-motion, image probing, faces.json
// loading and the talk/needs/blink/idle mode logic. The tower no longer draws faces; the sky zones do.
import { useEffect, useRef, useState } from "react";
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
import {
  SKY_CRT_JSON_URL,
  TAKEOVER_JSON_URL,
  takeoverAdvance,
  takeoverFrameAt,
  dprMediaQuery,
  safeDpr,
  takeoverSettled,
  validateSkyCrt,
  validateTakeover,
  type SkyCrtModel,
  type TakeoverModel,
} from "./skyZonesLogic";

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

/** G8e: the live device-pixel ratio (page zoom included). 1 without a window. Re-arms a matchMedia(resolution) listener after every change. */
export function useDpr(): number {
  const read = () => (typeof window === "undefined" ? 1 : safeDpr(window.devicePixelRatio));
  const [dpr, setDpr] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(dprMediaQuery(dpr));
    const onChange = () => setDpr(read());
    onChange();
    mq.addEventListener?.("change", onChange);
    // Zoom also resizes the viewport; some engines / emulation never fire the resolution query, so re-read on resize too (same value = no re-render).
    window.addEventListener("resize", onChange);
    return () => {
      mq.removeEventListener?.("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [dpr]);
  return dpr;
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

/** An optional @art json, fetched once; missing/invalid → null so the caller keeps its CSS fallback. */
function useJsonModel<T>(url: string, validate: (json: unknown) => { ok: true; value: T } | { ok: false }): T | null {
  const [model, setModel] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined)
      .then((json) => {
        if (cancelled) return;
        const m = validate(json);
        setModel(m.ok ? m.value : null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return model;
}

/** sky-crt.json, loaded once; missing/invalid → null (the sky zones keep the CSS bezel). */
export const useSkyCrtModel = (): SkyCrtModel | null => useJsonModel(SKY_CRT_JSON_URL, validateSkyCrt);

/** takeover.json (G7), loaded once; missing/invalid → null (the CSS dissolve plays instead). */
export const useTakeoverModel = (): TakeoverModel | null => useJsonModel(TAKEOVER_JSON_URL, validateTakeover);

/**
 * G7 overlay clock: steps through `n` frames at `fps` while `expanded`, holds the last, and runs back down on collapse.
 * A flip mid-play reverses from the frame it is on (the position lives in a ref). Returns the frame to draw and `pos`
 * (0 = fully out). Reduced motion or no sheet (n = 0): no clock.
 */
export function useTakeoverClock(expanded: boolean, fps: number, n: number, reduced: boolean): { frame: number; pos: number } {
  const posRef = useRef(0);
  const keyRef = useRef("0:false");
  const [pos, setPos] = useState(0);
  useEffect(() => {
    if (reduced || n < 1) {
      posRef.current = 0;
      keyRef.current = "0:false";
      setPos(0);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      posRef.current = takeoverAdvance(posRef.current, expanded, now - last, fps, n);
      last = now;
      // Re-render only when the drawn frame or the in/out state changes.
      const key = `${takeoverFrameAt(posRef.current, n)}:${posRef.current > 0}`;
      if (key !== keyRef.current) {
        keyRef.current = key;
        setPos(posRef.current);
      }
      if (!takeoverSettled(posRef.current, expanded, n)) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [expanded, fps, n, reduced]);
  return { frame: takeoverFrameAt(pos, Math.max(1, n)), pos };
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
  opts: { theme: Theme; reduced: boolean; /** G6: play this mode regardless of the agent (Riff scared while the Overlord is expanded). */ force?: FaceMode | null },
): BotFace {
  const { theme, reduced, force } = opts;
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
  const mode = force ?? (base === "idle" ? idleFaceMode(faces, bot) : base); // lookDown replaces idle once it exists
  const frame = faces && sheetOk ? faceFrame(faces, bot, mode, reduced ? 0 : tick) : null;
  return {
    mode,
    frame,
    sheetUrl,
    style: frame ? { backgroundImage: `url(${sheetUrl})`, backgroundPosition: `-${frame.x}px -${frame.y}px` } : {},
  };
}
