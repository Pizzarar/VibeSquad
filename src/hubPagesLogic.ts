// Hub view (docs/PLAN_HUB_PAGES.md HP1-HP5): pure helpers for the shared skyline backdrop.
import { safeDpr } from "./skyZonesLogic.ts";

export const HUB_BACKDROP_URL = (theme: "dark" | "light") => `/office/hub-backdrop-${theme}.png`;
export const HUB_BACKDROP_JSON = "/office/hub-backdrop.json";

export type HubBackdrop = { w: number; h: number; groundY: number; top: { dark: string; light: string } };

/** hub-backdrop.json (A1): size, ground line, and the sky colour above the tile. Null when unusable (-> the fallback band). */
export function validateHubBackdrop(json: unknown): HubBackdrop | null {
  const j = json as { w?: unknown; h?: unknown; groundY?: unknown; repeat?: unknown; top?: { dark?: unknown; light?: unknown } } | null;
  if (!j || typeof j !== "object") return null;
  const pos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!pos(j.w) || !pos(j.h) || typeof j.groundY !== "number" || j.repeat !== "x") return null;
  if (typeof j.top?.dark !== "string" || typeof j.top?.light !== "string") return null;
  return { w: j.w, h: j.h, groundY: j.groundY, top: { dark: j.top.dark, light: j.top.light } };
}

/** The same whole-device-pixel scale the floor plate uses (640 native): floor(width * dpr / 640) / dpr, at least 1. */
export function backdropScale(width: number, native: number, dpr = 1): number {
  const d = safeDpr(dpr);
  if (!Number.isFinite(width) || width < native) return 1;
  return Math.max(1, Math.floor((width * d) / native + 1e-9) / d);
}

/**
 * Tile x = w/2 sits under the tower's centre; the bottom row sits `plateInset` px above the page bottom (the plate bottom);
 * repeat-x. The left offset is snapped to a device pixel so the art never blurs.
 */
export function backdropStyle(model: HubBackdrop, width: number, theme: "dark" | "light", dpr = 1, plateInset = 0): Record<string, string> {
  const d = safeDpr(dpr);
  const s = backdropScale(width, 640, d);
  const tileW = model.w * s;
  const left = Math.round(((width - tileW) / 2) * d) / d;
  return {
    backgroundColor: model.top[theme],
    backgroundImage: `url(${HUB_BACKDROP_URL(theme)})`,
    backgroundRepeat: "repeat-x",
    backgroundSize: `${tileW}px ${model.h * s}px`,
    backgroundPosition: `${left}px calc(100% - ${plateInset}px)`,
  };
}
