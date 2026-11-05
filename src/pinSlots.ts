// Pin-focus layout slots: the focused Brainstorm's DrawerHeader keeps its state in the drawer but portals its
// compact bar into PinFocusBar ("bar") and its inspector into the PinRail's Active Buddy Card ("card").
import { useSyncExternalStore } from "react";

type Slot = "bar" | "card";
const els: Record<Slot, HTMLElement | null> = { bar: null, card: null };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Ref callback for the element that hosts a slot. */
export const slotRef = (slot: Slot) => (el: HTMLElement | null) => {
  if (els[slot] === el) return;
  els[slot] = el;
  listeners.forEach((l) => l());
};

export const usePinSlot = (slot: Slot) => useSyncExternalStore(subscribe, () => els[slot]);

// The rail collapses to a 64px icon strip at <=900px and hides the Active Buddy Card (styles.css), so nothing may be portalled there.
const NARROW = "(max-width: 900px)";
const subscribeNarrow = (l: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(NARROW);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};
export const useRailCardVisible = () =>
  useSyncExternalStore(subscribeNarrow, () => !(typeof matchMedia === "function" && matchMedia(NARROW).matches));
