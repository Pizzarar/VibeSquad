import { gridPinsForSquad, quickBugsChipState, resolveQuickBugsLane, type Pin } from "./pins.ts";
import type { Member, TeamView } from "./teams.ts";
// E1 (docs/PLAN_ANDROID_END_STATE.md Phase 2): pure rules for the strict phone cockpit. No React, no DOM: test/phone-cockpit.test.mjs imports this directly.

/** Phone viewport cutoff; matches the existing `@media (max-width: 600px)` mobile rules in styles.css. */
export const PHONE_MAX_WIDTH = 600;

/** The cockpit mounts instead of the desktop shell on the Android APK/WebView or on a phone-width viewport. */
export function isPhoneShell(isAndroidUa: boolean, viewportWidth: number): boolean {
  return isAndroidUa || (viewportWidth > 0 && viewportWidth <= PHONE_MAX_WIDTH);
}

export type PhoneSurface = "overlord" | "riffbot" | "bugs" | "buddy";

/** Overlord is the landing tab only while something needs the owner; otherwise RiffBot (pitch ideas, spin up lanes). */
export function defaultSurface(needsYou: number): PhoneSurface {
  return needsYou > 0 ? "overlord" : "riffbot";
}

/** The Buddy tab only exists while a Buddy lane is open; without one it falls back to Overlord. */
export function effectiveSurface(surface: PhoneSurface, buddyLaneId: string | null): PhoneSurface {
  return surface === "buddy" && !buddyLaneId ? "overlord" : surface;
}

/** Restart states that show in the host line (H1): queued -> "Restart queued"; requested/draining/ready -> "Draining for restart…"; firing -> "Restarting host…". Anything else (done/aborted/none) is quiet. */
const RESTART_LINES: Record<string, string> = { queued: "Restart queued", requested: "Draining for restart…", draining: "Draining for restart…", ready: "Draining for restart…", firing: "Restarting host…" };
export function restartStateLabel(restartState?: string | null): string | null {
  return (restartState && RESTART_LINES[restartState]) || null;
}

export type HostRestartReq = { id?: string; state: string } | null;
/** Identity of the parent's host restart prop: changes when a new request appears or its state moves (idea-894). */
export function hostRestartKey(fromHost?: HostRestartReq): string {
  return fromHost ? `${fromHost.id ?? ""}|${fromHost.state}` : "";
}
/**
 * The restart the drawer shows. A locally fetched/posted request (`local`, stamped with the host key it was taken under) wins
 * only while the parent's status prop is unchanged since; any newer prop (new id, state move, or cleared) supersedes it.
 */
export function pickLiveRestart(local: { req: HostRestartReq; hostKey: string } | undefined, fromHost?: HostRestartReq): HostRestartReq {
  if (local && local.hostKey === hostRestartKey(fromHost)) return local.req;
  return fromHost ?? null;
}

/** `Home PC · Online` / `· Reconnecting…` / `· Offline`, from the runner connection state; an active restart window overrides the text. */
export function hostHealthLine(runnerConn: "up" | "down" | string, hostLabel = "Home PC", restartState?: string | null): { text: string; tone: "ok" | "warn" | "bad" } {
  const label = hostLabel || "Home PC";
  const restart = restartStateLabel(restartState);
  if (restart) return { text: `${label} · ${restart}`, tone: "warn" };
  if (runnerConn === "up") return { text: `${label} · Online`, tone: "ok" };
  if (runnerConn === "down") return { text: `${label} · Offline`, tone: "bad" };
  return { text: `${label} · Reconnecting…`, tone: "warn" };
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

export type PhoneLaneState = "live" | "idle" | "none";
export type PhoneLaneRow = { pin: Pin; laneId: string; name: string; state: PhoneLaneState };

/**
 * idea-463 (Trinity audit HIGH #3): the Squad's standing Bugs lane as a permanent bottom tab beside Overlord and RiffBot.
 * Reuses `quickBugsPinForSquad` via `quickBugsChipState` (src/pins.ts), so the lane match and needs-you count are the desktop Bugs chip's.
 */
export type PhoneBugsSurface = { laneId: string | null; aliases: string[]; pin: Pin | null; member: Member | null; needsYou: number };

export function phoneBugsSurface(view: TeamView | undefined): PhoneBugsSurface {
  const { pin, needsYou } = quickBugsChipState(view);
  if (!pin) return { laneId: null, aliases: [], pin: null, member: null, needsYou: 0 };
  return { laneId: pin.lane.id, aliases: pin.lane.aliases ?? [], pin, member: pin.brainstorm ?? pin.lead ?? null, needsYou };
}

/** True when `laneId` (an `openBuddy` request or a drawer row) names the Squad's Bugs lane, by id or alias, case-insensitive. */
export function isBugsLane(bugs: Pick<PhoneBugsSurface, "laneId" | "aliases">, laneId: string | null | undefined): boolean {
  const id = laneId?.trim().replace(/^@/, "").toLowerCase();
  if (!id || !bugs.laneId) return false;
  return bugs.laneId.toLowerCase() === id || bugs.aliases.some((a) => a.toLowerCase() === id);
}

/** The ⋯ drawer's lane list: every pinned feature lane of the Squad (no-agent lanes from `vs pin new` included). The Bugs lane is excluded: it is a Trinity tab, not a feature lane (idea-463). */
export function phoneLaneRows(view: TeamView | undefined): PhoneLaneRow[] {
  if (!view) return [];
  const bugsId = resolveQuickBugsLane(view.team)?.id.toLowerCase();
  return gridPinsForSquad(view).pinned.filter((pin) => pin.lane.id.toLowerCase() !== bugsId).map((pin) => ({
    pin,
    laneId: pin.lane.id,
    name: pin.lane.name,
    state: !pin.brainstorm ? "none" : pin.brainstorm.agent.status === "running" ? "live" : "idle",
  }));
}
