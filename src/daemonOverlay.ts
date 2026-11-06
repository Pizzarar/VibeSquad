import type { RunnerStatus } from "./runnerBridge";

/** The VS runner's own event stream: "unknown" until it has opened once (or when the runner is off). */
export type RunnerConn = "unknown" | "up" | "down";

/** What the connection banner renders: nothing, the blocking scrim, or a non-blocking runner notice. */
export type OverlayKind = "none" | "scrim" | "runner-notice";

/**
 * True when Paseo is actually in play: the runner is off (Paseo is the transport), the user enabled/pinned Paseo,
 * or a Paseo-backed agent exists. With the runner cutover default none of these hold, so Paseo stays silent.
 */
export function usesPaseoBackend(runner: RunnerStatus | null, agentIds: Iterable<string>): boolean {
  if (runner && !runner.enabled) return true;
  if (runner?.paseo?.expected || (runner?.paseoLanes ?? []).length > 0) return true;
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
 * Only the VS runner (or, in a remote relay session, Paseo as the transport) can block the UI.
 * A Paseo-only failure never does, except the daemon-password LOCKED form when Paseo is in use.
 */
export function decideOverlay(i: OverlayInput): OverlayKind {
  if (i.remote) return i.paseoDown ? "scrim" : "none";
  if (i.paseoDown && i.authFailureReason && i.usesPaseo) return "scrim";
  return i.runnerConn === "down" ? "runner-notice" : "none";
}

/** Header dot: Paseo's state only when Paseo is in use, otherwise the runner's. */
export function statusDot(i: { remote: boolean; usesPaseo: boolean; paseoConn: string; runnerConn: RunnerConn }): { conn: string; title: string } {
  if (i.remote || i.usesPaseo) return { conn: i.paseoConn, title: `daemon: ${i.paseoConn}` };
  const conn = i.runnerConn === "up" ? "connected" : i.runnerConn === "down" ? "disconnected" : "connecting";
  return { conn, title: `runner: ${conn}` };
}
