import { useSyncExternalStore } from "react";

/** ONE shared wall-clock tick (R5 L1): the tab title/favicon and the Needs-you count read the same `now`, so they cross the stall boundary together. */
export const NOW_TICK_MS = 30_000;

let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of [...listeners]) l();
    }, NOW_TICK_MS);
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => current;

export function useNowTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
