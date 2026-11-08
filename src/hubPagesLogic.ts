// Hub pages (docs/PLAN_HUB_PAGES.md HP1-HP3): pure helpers for the Sky / Tower switcher and the shared skyline backdrop.
import { safeDpr } from "./skyZonesLogic.ts";
import type { FaceBot } from "./squadFloorLogic.ts";

export type HubPage = "sky" | "tower";
export const HUB_PAGES: readonly HubPage[] = ["sky", "tower"];
export const HUB_PAGE_KEY = "vs.hubPage";

/** Anything but a known page reads as the Sky page (the default landing). */
export function parseHubPage(v: unknown): HubPage {
  return v === "tower" ? "tower" : "sky";
}

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
export function readHubPage(s: Store | null = store()): HubPage {
  try {
    return parseHubPage(s?.getItem(HUB_PAGE_KEY));
  } catch {
    return "sky";
  }
}
export function writeHubPage(page: HubPage, s: Store | null = store()): void {
  try {
    s?.setItem(HUB_PAGE_KEY, page);
  } catch {
    /* private mode / quota: the choice just doesn't persist */
  }
}

/** A mini face click: the Sky page, with that bot's chat open. */
export function miniFaceJump(bot: FaceBot): { page: HubPage; open: FaceBot } {
  return { page: "sky", open: bot };
}

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
