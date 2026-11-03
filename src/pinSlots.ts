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
