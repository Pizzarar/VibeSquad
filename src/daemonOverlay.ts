/** The VS runner's own event stream: "unknown" until it has opened once. */
export type RunnerConn = "unknown" | "up" | "down";

/** What the connection banner renders: nothing, or a non-blocking header pill. */
export type OverlayKind = "none" | "pill";

export type OverlayInput = { runnerConn: RunnerConn };

/** Nothing blocks the UI: a runner problem is a header pill that opens Diagnostics. */
export function decideOverlay(i: OverlayInput): OverlayKind {
  return i.runnerConn === "down" ? "pill" : "none";
}

/** Header pill text for a connection problem. */
export function pillText(_i: OverlayInput): string {
  return "Runner disconnected · reconnecting";
}

/** Header dot: the runner stream's state. */
export function statusDot(i: { runnerConn: RunnerConn }): { conn: string; title: string } {
  const conn = i.runnerConn === "up" ? "connected" : i.runnerConn === "down" ? "disconnected" : "connecting";
  return { conn, title: `runner: ${conn}` };
}
