import { useSyncExternalStore } from "react";

export const UI_SCALE_STORAGE_KEY = "vibesquad.uiScale";
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_STEP = 0.1;
export const UI_SCALE_SLIDER_STEP = 0.05;
export const UI_SCALE_PRESETS = [1.0, 1.15, 1.25, 1.5, 1.75] as const;
/** Chat text scale: unset (null) follows the UI scale; set, it is the effective scale inside the chat regions. */
export const CHAT_SCALE_STORAGE_KEY = "vibesquad.chatScale";

const HUD_DURATION_MS = 1800;

export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

export function detectDefaultUiScale(): number {
  if (typeof window === "undefined") return 1.0;
  const screenWidth = window.screen?.width ?? 0;
  const dpr = window.devicePixelRatio || 1;
  if (screenWidth >= 3840 && dpr <= 1.25) {
    return 1.25;
  }
  return 1.0;
}

export function readStoredUiScale(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < UI_SCALE_MIN || parsed > UI_SCALE_MAX) {
      return null;
    }
    return clampUiScale(parsed);
  } catch {
    return null;
  }
}

export function readStoredChatScale(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHAT_SCALE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < UI_SCALE_MIN || parsed > UI_SCALE_MAX) return null;
    return clampUiScale(parsed);
  } catch {
    return null;
  }
}

let currentScale: number = readStoredUiScale() ?? detectDefaultUiScale();
/** null = follow the UI scale. */
let chatOverride: number | null = readStoredChatScale();
let hudVisible = false;
let hudTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * U3 painted kit: one kit pixel is drawn as a whole number of DEVICE pixels (never fractional), so 9-slice frames,
 * buttons and grain stay crisp at any app zoom x OS scale. The nominal size is 2 CSS px per kit pixel; we pick the
 * nearest whole device-px count n = round(2 * zoom * dpr) and expose its CSS length as --u3-px (= n / (zoom * dpr)).
 */
export function kitPixel(dpr: number, zoom: number): { device: number; css: number } {
  const eff = Math.max(0.1, (Number.isFinite(dpr) && dpr > 0 ? dpr : 1) * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1));
  const device = Math.max(1, Math.round(2 * eff));
  return { device, css: device / eff };
}

export function applyKitPixelToDom(scale: number = currentScale): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const { device, css } = kitPixel(window.devicePixelRatio || 1, clampUiScale(scale));
  const root = document.documentElement;
  // +0.0001px keeps float error from rounding a device px down in border/background sizing.
  root.style.setProperty("--u3-px", `${(css + 0.0001).toFixed(4)}px`);
  root.dataset.u3Px = String(device);
}

/** Effective chat scale for a UI scale and an optional override (null = follow). */
export function effectiveChatScale(ui: number, override: number | null): number {
  return override === null ? clampUiScale(ui) : clampUiScale(override);
}

/** Counter-zoom for chat regions under the root zoom: root zoom x this = the chat scale. */
export function chatZoom(ui: number, override: number | null): number {
  const u = clampUiScale(ui);
  return Math.round((effectiveChatScale(u, override) / u) * 10000) / 10000;
}

/**
 * Chat regions run at ui x chatZoom = chatScale, so their kit pixel is snapped for the chat scale (SS3):
 * --u3-px-chat replaces --u3-px inside the counter-zoomed containers (see styles.css).
 */
export function applyChatScaleToDom(ui: number = currentScale, override: number | null = chatOverride): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  const eff = effectiveChatScale(ui, override);
  const { device, css } = kitPixel(window.devicePixelRatio || 1, eff);
  root.style.setProperty("--chat-zoom", String(chatZoom(ui, override)));
  root.style.setProperty("--u3-px-chat", `${(css + 0.0001).toFixed(4)}px`);
  root.dataset.chatScale = String(Math.round(eff * 100));
  root.dataset.u3PxChat = String(device);
}

export function applyUiScaleToDom(scale: number = currentScale): void {
  if (typeof document === "undefined") return;
  const s = clampUiScale(scale);
  const root = document.documentElement;
  root.style.setProperty("--vs-ui-scale", String(s));
  root.style.zoom = String(s);
  root.dataset.uiScale = String(Math.round(s * 100));
  applyKitPixelToDom(s);
  applyChatScaleToDom(s);
}

// devicePixelRatio changes (window moved between monitors, OS scale change, browser zoom) re-snap the kit pixel.
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => { applyKitPixelToDom(); applyChatScaleToDom(); });
  try {
    const watch = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", () => { applyKitPixelToDom(); applyChatScaleToDom(); watch(); }, { once: true });
    };
    watch();
  } catch {
    // matchMedia resolution queries unsupported: the resize listener still covers browser zoom
  }
}

export function getUiScale(): number {
  return currentScale;
}

/** Effective chat scale (the override, or the UI scale when following). */
export function getChatScale(): number {
  return effectiveChatScale(currentScale, chatOverride);
}

/** null when chat text follows the UI scale. */
export function getChatScaleOverride(): number | null {
  return chatOverride;
}

export function isUiScaleHudVisible(): boolean {
  return hudVisible;
}

export function showUiScaleHud(): void {
  hudVisible = true;
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    hudVisible = false;
    hudTimer = null;
    notify();
  }, HUD_DURATION_MS);
  notify();
}

export function setUiScale(nextScale: number, options?: { showHud?: boolean; persist?: boolean }): number {
  const clamped = clampUiScale(nextScale);
  currentScale = clamped;
  if (options?.persist !== false && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage errors in restricted contexts
    }
  }
  applyUiScaleToDom(clamped);
  if (options?.showHud) {
    showUiScaleHud();
  } else {
    notify();
  }
  return clamped;
}

/** Set the chat text scale; null clears the override so chat follows the UI scale again. */
export function setChatScale(next: number | null, options?: { showHud?: boolean; persist?: boolean }): number {
  chatOverride = next === null ? null : clampUiScale(next);
  if (options?.persist !== false && typeof window !== "undefined") {
    try {
      if (chatOverride === null) window.localStorage.removeItem(CHAT_SCALE_STORAGE_KEY);
      else window.localStorage.setItem(CHAT_SCALE_STORAGE_KEY, String(chatOverride));
    } catch {
      // Ignore storage errors in restricted contexts
    }
  }
  applyChatScaleToDom(currentScale, chatOverride);
  if (options?.showHud) showUiScaleHud();
  else notify();
  return getChatScale();
}

export function stepUiScale(delta: number, showHud = true): number {
  return setUiScale(currentScale + delta, { showHud });
}

export function resetUiScale(showHud = true): number {
  return setUiScale(1.0, { showHud });
}

export function cycleUiScalePreset(showHud = true): number {
  const idx = UI_SCALE_PRESETS.findIndex((p) => Math.abs(p - currentScale) < 0.01);
  const next = UI_SCALE_PRESETS[(idx + 1) % UI_SCALE_PRESETS.length];
  return setUiScale(next, { showHud });
}

export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUiScale(): number {
  return useSyncExternalStore(subscribeUiScale, getUiScale, () => 1.0);
}

/** Effective chat scale; re-renders on UI or chat scale change. */
export function useChatScale(): number {
  return useSyncExternalStore(subscribeUiScale, getChatScale, () => 1.0);
}

/** Whether chat text follows the UI scale. */
export function useChatScaleLinked(): boolean {
  return useSyncExternalStore(subscribeUiScale, () => chatOverride === null, () => true);
}

export function useUiScaleHud(): boolean {
  return useSyncExternalStore(subscribeUiScale, isUiScaleHudVisible, () => false);
}

export function handleUiScaleKeyDown(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
    e.preventDefault();
    stepUiScale(UI_SCALE_STEP, true);
    return true;
  }
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") {
    e.preventDefault();
    stepUiScale(-UI_SCALE_STEP, true);
    return true;
  }
  if (!e.shiftKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")) {
    e.preventDefault();
    resetUiScale(true);
    return true;
  }
  return false;
}

// Initialize on module load in browser environments
if (typeof document !== "undefined") {
  applyUiScaleToDom(currentScale);
}
