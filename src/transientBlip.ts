// Transient API errors that the server auto-retry already recovered from render as a small
// "signal interrupted" blip instead of a ⚠ error. Reuses the A4 classifier; no new patterns.
import type { PaseoAgent } from "./agentTypes";
import { classifyTransientError } from "./antigravity.ts";

export const BLIP_LINES = [
  "📡 signal interrupted · retried",
  "packet vaporized · rerouting",
  "📡 static on the line · reconnected",
  "carrier lost · found it again",
] as const;

/** Deterministic: same seq/index always gives the same line, so re-renders never flicker. */
export function blipLine(seed: number): string {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return BLIP_LINES[n % BLIP_LINES.length];
}

/** Does the raw error text match the existing transient classifier (retryable kinds only)? */
export function isTransientErrorText(text: unknown): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const c = classifyTransientError({ status: "error", lastError: raw } as unknown as PaseoAgent);
  return !!c?.retryable;
}

type Item = { item?: any; seqStart?: number } | null | undefined;

// Items that prove the agent carried on after the error.
const ACTIVITY = new Set(["assistant_message", "reasoning", "tool_call", "todo", "user_message"]);

/**
 * Blip vs error for the timeline item at `index`: a blip only when the error is transient AND a later
 * item shows activity. The last item (retries ran out, agent errored/idle) stays a ⚠ error.
 */
export function transientBlip(entries: Item[], index: number): { raw: string; line: string } | null {
  const it = entries[index]?.item;
  if (!it || it.type !== "error") return null;
  const raw = String(it.message ?? it.error ?? "");
  if (!isTransientErrorText(raw)) return null;
  for (let i = index + 1; i < entries.length; i++) {
    if (ACTIVITY.has(entries[i]?.item?.type)) return { raw, line: blipLine(entries[index]?.seqStart ?? index) };
  }
  return null;
}
