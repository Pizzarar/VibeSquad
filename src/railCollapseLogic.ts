// Pure rules for the narrow-window rails (hook + storage live in src/railCollapse.ts).

/** Viewport width (CSS px at UI zoom 1) under which the rails start collapsed. */
export const RAIL_NARROW_CSS_PX = 1600;
export const SIDEBAR_SESSION_KEY = "vibesquad.sidebarOpen.session";
export const PIN_RAIL_SESSION_KEY = "vibesquad.pinRailOpen.session";

/** Layout width is the window width over the root UI zoom (src/uiScale.ts). */
export function isNarrowViewport(innerWidth: number, zoom = 1): boolean {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Number.isFinite(innerWidth) && innerWidth / z < RAIL_NARROW_CSS_PX;
}

/** Narrow: the session override when the user toggled it, else collapsed. Wide: `wide` (the saved sidebar preference, or false for the rail). */
export function railCollapsed(narrow: boolean, override: boolean | null, wide: boolean): boolean {
  return narrow ? (override ?? true) : wide;
}

export function parseOverride(raw: string | null | undefined): boolean | null {
  return raw === "1" ? true : raw === "0" ? false : null;
}
