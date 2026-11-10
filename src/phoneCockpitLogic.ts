// E1 (docs/PLAN_ANDROID_END_STATE.md Phase 2): pure rules for the strict phone cockpit. No React, no DOM: test/phone-cockpit.test.mjs imports this directly.

/** Phone viewport cutoff; matches the existing `@media (max-width: 600px)` mobile rules in styles.css. */
export const PHONE_MAX_WIDTH = 600;

/** The cockpit mounts instead of the desktop shell on the Android APK/WebView or on a phone-width viewport. */
export function isPhoneShell(isAndroidUa: boolean, viewportWidth: number): boolean {
  return isAndroidUa || (viewportWidth > 0 && viewportWidth <= PHONE_MAX_WIDTH);
}

export type PhoneSurface = "overlord" | "riffbot" | "buddy";

/** Overlord is the landing tab only while something needs the owner; otherwise RiffBot (pitch ideas, spin up lanes). */
export function defaultSurface(needsYou: number): PhoneSurface {
  return needsYou > 0 ? "overlord" : "riffbot";
}

/** The Buddy tab only exists while a Buddy lane is open; without one it falls back to Overlord. */
export function effectiveSurface(surface: PhoneSurface, buddyLaneId: string | null): PhoneSurface {
  return surface === "buddy" && !buddyLaneId ? "overlord" : surface;
}

/** `Home PC · Online` / `Home PC · Reconnecting…` / `Home PC · Offline`, from the runner connection state. */
export function hostHealthLine(runnerConn: "up" | "down" | string, hostLabel = "Home PC"): { text: string; tone: "ok" | "warn" | "bad" } {
  if (runnerConn === "up") return { text: `${hostLabel} · Online`, tone: "ok" };
  if (runnerConn === "down") return { text: `${hostLabel} · Offline`, tone: "bad" };
  return { text: `${hostLabel} · Reconnecting…`, tone: "warn" };
}

/**
 * Buddy-jump contract for E2: anything (a Decision Card button, a deep link) calls `openBuddy(laneId)`;
 * the mounted cockpit subscribes and switches to the Active Buddy tab. `n` makes a repeat request for the same lane observable.
 */
export type BuddyRequest = { laneId: string; n: number } | null;
let buddyRequest: BuddyRequest = null;
const listeners = new Set<() => void>();

export function openBuddy(laneId: string): void {
  const id = laneId.trim().replace(/^@/, "");
  if (!id) return;
  buddyRequest = { laneId: id, n: (buddyRequest?.n ?? 0) + 1 };
  listeners.forEach((l) => l());
}

export function getBuddyRequest(): BuddyRequest {
  return buddyRequest;
}

export function subscribeBuddyRequest(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Test seam. */
export function resetBuddyRequest(): void {
  buddyRequest = null;
}
