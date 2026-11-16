// Pure, import-free: which conditions put the 32px status strip under the Normal agent header (UX_REVIEW 2.6).
/** UX_REVIEW 2.6: context % at which the meter + status strip appear. */
export const BORING_CTX_WARN_PCT = 72;
/** A running agent with no update for this long counts as stalled in the Normal status strip. */
export const BORING_STALL_SECONDS = 90;

/** R3.2: Needs you lists a quiet agent as stalled only after this long (the header strip keeps the shorter 90s hint). */
export const BORING_NEEDS_YOU_STALL_SECONDS = 600;

/**
 * Pure R3.2 rule: stalled for Needs you = running, no pending permission, no update for ~10 min, and no tool call in flight
 * (`toolRunningSeconds` is the running-tool age the header strip already derives; null/undefined = none running).
 */
export function boringNeedsYouStalled(input: { status?: string | null; hasPendingPermission: boolean; idleSeconds: number; toolRunningSeconds?: number | null }): boolean {
  if (input.status !== "running" || input.hasPendingPermission) return false;
  if (input.toolRunningSeconds != null) return false;
  return input.idleSeconds >= BORING_NEEDS_YOU_STALL_SECONDS;
}

export type BoringStripReason = { kind: "stalled" | "handoff" | "context"; text: string };

/** Pure: which conditions put the 32px strip under the header. Order = urgency. */
export function boringHeaderStrip(input: {
  status?: string | null;
  updatedAt?: string | null;
  hasPendingPermission: boolean;
  ctxPct: number | null;
  planHandedOff: boolean;
  nowMs: number;
  /** R2.6: the header already shows the ctx meter; the strip then repeats context only when it carries the Hand off action. */
  meterShown?: boolean;
  canHandoff?: boolean;
}): BoringStripReason[] {
  const out: BoringStripReason[] = [];
  const updated = Date.parse(input.updatedAt ?? "");
  if (input.status === "running" && !input.hasPendingPermission && !Number.isNaN(updated)) {
    const idle = Math.max(0, Math.floor((input.nowMs - updated) / 1000));
    if (idle >= BORING_STALL_SECONDS) out.push({ kind: "stalled", text: `Stalled: no update for ${idle >= 120 ? `${Math.round(idle / 60)}m` : `${idle}s`}` });
  }
  if (input.planHandedOff) out.push({ kind: "handoff", text: "Handoff due: plan handed to Lead" });
  if (input.ctxPct != null && input.ctxPct >= BORING_CTX_WARN_PCT && (!input.meterShown || input.canHandoff)) out.push({ kind: "context", text: `Context ${Math.round(input.ctxPct)}% full` });
  return out;
}
