// Narrow-window rails: below RAIL_NARROW_CSS_PX the left sidebar and the right pin rail start as compact icon strips so the hub floor
// gets the width (floorFitScale lands on a whole multiple instead of the fractional last resort). Expanding is per session; at
// or above the limit the old behaviour holds (sidebar uses its saved preference, the rail is always open).
import { useEffect, useState, useSyncExternalStore } from "react";
import { isNarrowViewport, parseOverride } from "./railCollapseLogic";
import { getUiScale, subscribeUiScale } from "./uiScale";

export { PIN_RAIL_SESSION_KEY, RAIL_NARROW_CSS_PX, SIDEBAR_SESSION_KEY, isNarrowViewport, parseOverride, railCollapsed } from "./railCollapseLogic";

export function useNarrowViewport(): boolean {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1920 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const zoom = useSyncExternalStore(subscribeUiScale, getUiScale, () => 1);
  return isNarrowViewport(w, zoom);
}

const listeners = new Set<() => void>();
const read = (key: string): boolean | null => {
  try {
    return parseOverride(sessionStorage.getItem(key));
  } catch {
    return null;
  }
};

/** Per-session "collapsed" override for one rail (null = never toggled this session). */
export function useRailOverride(key: string): [boolean | null, (collapsed: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(key),
    () => null,
  );
  const set = (collapsed: boolean) => {
    try {
      sessionStorage.setItem(key, collapsed ? "1" : "0");
    } catch {}
    listeners.forEach((l) => l());
  };
  return [value, set];
}
