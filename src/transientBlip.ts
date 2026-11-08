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
export type Blip = { raw: string; line: string };

// Items that prove the agent carried on after the error. user_message is excluded on purpose: the
// server auto-retry posts one after every transient failure, so it says nothing about recovery.
const ACTIVITY = new Set(["assistant_message", "reasoning", "tool_call", "todo"]);

function defaultFormat(err: any): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  if (typeof err.text === "string") return err.text;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * One reverse pass over the (already cut/rewound) entries: an error is a blip only when it is transient
 * and activity follows it before the next error. The last error stays a ⚠ while the agent is in "error".
 * `fmt` should be the same text formatter the error row uses (Timeline passes formatToolError).
 */
export function recoveredBlips(
  entries: Item[],
  agentStatus?: string,
  fmt: (err: any) => string = defaultFormat,
): Map<object, Blip> {
  const out = new Map<object, Blip>();
  let recovered = false;
  let lastError = true;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const t = e?.item?.type;
    if (t === "error") {
      const stuck = lastError && agentStatus === "error";
      lastError = false;
      if (recovered && !stuck) {
        const raw = fmt(e!.item.message ?? e!.item.error);
        if (isTransientErrorText(raw)) out.set(e as object, { raw, line: blipLine(e!.seqStart ?? i) });
      }
      recovered = false;
    } else if (ACTIVITY.has(t)) recovered = true;
  }
  return out;
}
