import { useCallback, useSyncExternalStore } from "react";

// Unsent text survives agent/team switches and reloads. The in-memory map is the source of truth
// (updated on every keystroke); localStorage writes are debounced. Subscribers are per key, so typing
// only re-renders the component that called useDraft(key).
const PREFIX = "vs.draft:";
const DEBOUNCE_MS = 300;

const mem = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(key: string) {
  try {
    const v = mem.get(key);
    if (v) localStorage.setItem(PREFIX + key, v);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable or full: memory copy still works */
  }
}

function flush() {
  clearTimeout(timer);
  timer = undefined;
  for (const k of pending) persist(k);
  pending.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.hidden && flush());
}

export function getDraft(key: string): string {
  let v = mem.get(key);
  if (v === undefined) {
    try {
      v = localStorage.getItem(PREFIX + key) ?? "";
    } catch {
      v = "";
    }
    mem.set(key, v);
  }
  return v;
}

export function setDraft(key: string, value: string): void {
  if (getDraft(key) === value) return;
  mem.set(key, value);
  pending.add(key);
  clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
  listeners.get(key)?.forEach((l) => l());
}

export function clearDraft(key: string): void {
  setDraft(key, "");
  // Clearing is a deliberate action: persist right away so a reload cannot resurrect sent text.
  pending.delete(key);
  persist(key);
}

function subscribe(key: string, cb: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(key);
  };
}

export function useDraft(key: string, fallback = ""): [string, (next: string) => void, () => void] {
  const sub = useCallback((cb: () => void) => subscribe(key, cb), [key]);
  const stored = useSyncExternalStore(sub, () => getDraft(key));
  const set = useCallback((next: string) => setDraft(key, next), [key]);
  const clear = useCallback(() => clearDraft(key), [key]);
  return [stored || fallback, set, clear];
}
