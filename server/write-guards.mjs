import { createHash } from "node:crypto";

// Security S4 helpers shared by the write handlers (inbox, brainstorm, lead handoff).

/**
 * Text pasted inside a `--- BEGIN x --- / --- END x ---` prompt block can't close that block or open a
 * fake one: marker-shaped lines get a leading "> " so they read as quoted content.
 */
export function defangPromptFences(text) {
  return String(text ?? "").replace(/^([ \t]*)(-{3,}[ \t]*(?:BEGIN|END)\b)/gim, "$1> $2");
}

/** sha1 of a brief's text; a write that sends a stale one gets 409 instead of overwriting newer edits. */
export function contentRevision(text) {
  return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex");
}

/** Rolling-window counter: `take()` is false once `max` calls landed in the last `windowMs`. */
export function createWindowLimiter({ max, windowMs = 60_000, now = Date.now }) {
  let stamps = [];
  return {
    take() {
      const t = now();
      stamps = stamps.filter((s) => s > t - windowMs);
      if (stamps.length >= max) return false;
      stamps.push(t);
      return true;
    },
    reset() {
      stamps = [];
    },
  };
}

// Provider ids ("claude", "antigravity-cli") and model ids ("claude-opus-5-5", "gemini-4-argon").
const SPAWN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
export const isSpawnId = (s) => typeof s === "string" && SPAWN_ID.test(s);
