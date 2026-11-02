// Pure logic for the Paseo attention bridge: alert dedupe between the daemon's attention event and
// VS's snapshot-diff path, and the "clear the workspace only when it is quiet" rule. No imports.

export type AlertTone = "permission" | "error" | "needs-you" | "finished";
export type AttentionReason = "finished" | "error" | "permission";

export const DEDUPE_WINDOW_MS = 15_000;

export const toneOfReason = (r: AttentionReason): AlertTone => r;

/**
 * One claim per (agent, tone) inside the window: whichever path (daemon event or snapshot diff) gets
 * there first alerts, the other one stays quiet.
 */
export function createAlertDedupe(windowMs = DEDUPE_WINDOW_MS) {
  const last = new Map<string, number>();
  return {
    claim(agentId: string, tone: AlertTone, now: number): boolean {
      const key = `${agentId}:${tone}`;
      const prev = last.get(key);
      if (prev !== undefined && now - prev < windowMs) return false;
      last.set(key, now);
      if (last.size > 500) for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
      return true;
    },
    reset: () => last.clear(),
  };
}

export type EventDecision = "skip" | "alert";

/** Whether a daemon attention event should raise an alert here (shouldNotify and the pref gate it). */
export function decideEvent(
  ev: { shouldNotify: boolean; reason: AttentionReason },
  alertOn: (tone: AlertTone) => boolean,
): EventDecision {
  return ev.shouldNotify && alertOn(toneOfReason(ev.reason)) ? "alert" : "skip";
}

type WsAgent = { id: string; workspaceId?: string | null };

/**
 * The workspace to clear on the daemon after VS cleared `agentId`'s attention, or null when there is
 * nothing to clear (no workspace id) or another live agent in it still needs attention.
 */
export function workspaceToClear<A extends WsAgent>(
  agentId: string,
  agents: Iterable<A>,
  needsAttention: (a: A) => boolean,
): string | null {
  let ws: string | null = null;
  const all = [...agents];
  const self = all.find((a) => a.id === agentId);
  ws = self?.workspaceId || null;
  if (!ws) return null;
  for (const a of all) if (a.id !== agentId && a.workspaceId === ws && needsAttention(a)) return null;
  return ws;
}
