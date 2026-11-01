import { useSyncExternalStore } from "react";

export const UI_SCALE_STORAGE_KEY = "vibesquad.uiScale";
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_STEP = 0.1;
export const UI_SCALE_SLIDER_STEP = 0.05;
export const UI_SCALE_PRESETS = [1.0, 1.15, 1.25, 1.5, 1.75] as const;

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

let currentScale: number = readStoredUiScale() ?? detectDefaultUiScale();
let hudVisible = false;
let hudTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function applyUiScaleToDom(scale: number = currentScale): void {
  if (typeof document === "undefined") return;
  const s = clampUiScale(scale);
  const root = document.documentElement;
  root.style.setProperty("--vs-ui-scale", String(s));
  root.style.zoom = String(s);
  root.dataset.uiScale = String(Math.round(s * 100));
}

export function getUiScale(): number {
  return currentScale;
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
