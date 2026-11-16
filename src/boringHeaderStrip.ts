// Pure, import-free: which conditions put the 32px status strip under the Normal agent header (UX_REVIEW 2.6).
/** UX_REVIEW 2.6: context % at which the meter + status strip appear. */
export const BORING_CTX_WARN_PCT = 72;
/** A running agent with no update for this long counts as stalled in the Normal status strip. */
export const BORING_STALL_SECONDS = 90;

/** R3.2: Needs you lists a quiet agent as stalled only after this long (the header strip keeps the shorter 90s hint). */
export const BORING_NEEDS_YOU_STALL_SECONDS = 600;

/** R4-1: an open tool call with no timeout of its own counts as hung after this long (its own timeout, when it has one, replaces it). */
export const BORING_TOOL_CEILING_SECONDS = 3600;

/** R5-5: grace over a tool's own timeout before it counts as hung, so a Bash about to self-timeout isn't flagged first. */
export const BORING_TOOL_GRACE_SECONDS = 60;

/** R5-5: one display cap for tool names (Gemini publishes a whole script as the name): first word of the command, ~24 chars. */
export function shortToolName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length > 24 ? `${first.slice(0, 23)}…` : first;
}

/** R5-5: one format for a hung tool's running time (header strip + Needs-you reason): whole minutes, at least 1. */
export function formatToolMinutes(seconds: number): string {
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

export type BoringNeedsYouStall = { kind: "quiet"; idleSeconds: number } | { kind: "tool"; toolSeconds: number };

/**
 * Pure R4-1 rule (docs/UX_REVIEW_R4.md option a), the ONE stall rule for Needs you, its count and every badge:
 *   stalled = running, no pending permission, AND either
 *     quiet: no update for BORING_NEEDS_YOU_STALL_SECONDS (10m) and no tool call in flight, or
 *     tool:  the oldest open tool call has run for >= its ceiling (the tool's own timeout + 60s grace, else BORING_TOOL_CEILING_SECONDS = 60m).
 * `toolRunningSeconds` = age of the oldest open tool call (null/undefined = none in flight).
 */
export function boringNeedsYouStall(input: {
  status?: string | null;
  hasPendingPermission: boolean;
  idleSeconds: number;
  toolRunningSeconds?: number | null;
  toolCeilingSeconds?: number | null;
}): BoringNeedsYouStall | null {
  if (input.status !== "running" || input.hasPendingPermission) return null;
  if (input.toolRunningSeconds != null) {
    const c = input.toolCeilingSeconds;
    const ceiling = c != null && Number.isFinite(c) && c > 0 ? c + BORING_TOOL_GRACE_SECONDS : BORING_TOOL_CEILING_SECONDS;
    return input.toolRunningSeconds >= ceiling ? { kind: "tool", toolSeconds: input.toolRunningSeconds } : null;
  }
  return input.idleSeconds >= BORING_NEEDS_YOU_STALL_SECONDS ? { kind: "quiet", idleSeconds: input.idleSeconds } : null;
}

/** Boolean form of boringNeedsYouStall. */
export const boringNeedsYouStalled = (input: Parameters<typeof boringNeedsYouStall>[0]): boolean => boringNeedsYouStall(input) !== null;

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
