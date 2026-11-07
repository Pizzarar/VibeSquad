import type { RunnerStatus } from "./runnerBridge";

/** The VS runner's own event stream: "unknown" until it has opened once (or when the runner is off). */
export type RunnerConn = "unknown" | "up" | "down";

/** What the connection banner renders: nothing, the blocking scrim (remote relay only), or a non-blocking header pill. */
export type OverlayKind = "none" | "scrim" | "pill";

/**
 * True when Paseo is actually in play: the runner is off (Paseo is the transport), the user enabled/pinned Paseo,
 * or a Paseo-backed agent exists. With the runner cutover default none of these hold, so Paseo stays silent.
 */
export function usesPaseoBackend(runner: RunnerStatus | null, agentIds: Iterable<string>): boolean {
  if (runner && !runner.enabled) return true;
  if (runner?.defaultBackend === "paseo" || (runner?.paseoLanes ?? []).length > 0) return true;
  for (const id of agentIds) if (!id.startsWith("rn-")) return true;
  return false;
}

export type OverlayInput = {
  remote: boolean;
  runnerConn: RunnerConn;
  /** Paseo conn and status are both not "connected". */
  paseoDown: boolean;
  authFailureReason: "password_required" | "incorrect_password" | null;
  usesPaseo: boolean;
};

/**
 * Locally nothing blocks the UI: a runner or Paseo problem is a header pill that opens Diagnostics (where the
 * unlock form lives). Only a remote relay session, where Paseo is the transport, keeps the scrim and its re-pair actions.
 */
export function decideOverlay(i: OverlayInput): OverlayKind {
  if (i.remote) return i.paseoDown ? "scrim" : "none";
  if (i.runnerConn === "down") return "pill";
  return i.paseoDown && i.usesPaseo ? "pill" : "none";
}

/** Paseo's own down state: remote relay has no runner, so there the combined conn is Paseo; locally it is the Paseo socket alone. */
export function paseoIsDown(i: { remote: boolean; conn: string; status: string; paseoConn: boolean }): boolean {
  return i.remote ? i.conn !== "connected" && i.status !== "connected" : !i.paseoConn;
}

/** Header pill text for a local connection problem. */
export function pillText(i: Pick<OverlayInput, "runnerConn" | "authFailureReason">): string {
  if (i.runnerConn === "down") return "Runner disconnected · reconnecting";
  if (i.authFailureReason) return "VS server locked · see Diagnostics";
  return "VS server disconnected · reconnecting";
}

/** The quiet header dot also shows for the legacy "daemon expected" flag, which alone never counts as using Paseo. */
export function showsPaseoDot(runner: RunnerStatus | null, agentIds: Iterable<string>): boolean {
  return usesPaseoBackend(runner, agentIds) || !!runner?.paseo?.expected;
}

/** Header dot: Paseo's state only when Paseo is in use, otherwise the runner's. */
export function statusDot(i: { remote: boolean; usesPaseo: boolean; paseoConn: string; runnerConn: RunnerConn }): { conn: string; title: string } {
  if (i.remote || i.usesPaseo) return { conn: i.paseoConn, title: `daemon: ${i.paseoConn}` };
  const conn = i.runnerConn === "up" ? "connected" : i.runnerConn === "down" ? "disconnected" : "connecting";
  return { conn, title: `runner: ${conn}` };
}
