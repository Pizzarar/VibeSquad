// The Gemini model ids routing and pickers use (N1, Aub 2026-11-21): ONE place to change when Google ships the next one.
// A leaf module (no imports) so provider-failover, stakes-ladder, profile-aliases and src/ can all read it without cycles.
//
// `agy models` ids carry the effort as a suffix (gemini-4-neon-{low,medium,high,xhigh}); profiles + ladders name the bare
// family id and pass the effort as thinkingOptionId, and runner/adapters/acp.mjs pickModel() picks the advertised variant.

/** Top/mid-tier Gemini (leads, Buddies, reviewers, implementers, Tier A). Was gemini-4-argon until N1. */
export const GEMINI_TOP_MODEL = "gemini-4-neon";
/** Cheap-tier Gemini (scouts, pre-check, mechanical). Unchanged by N1. */
export const GEMINI_CHEAP_MODEL = "gemini-3.8-flash";

/** Retired model family id -> its replacement. Read by the profiles.json load-time migration (server/profiles.mjs). */
export const RETIRED_MODEL_IDS = Object.freeze({
  "gemini-4-argon": GEMINI_TOP_MODEL, // N1: Argon deprecated, price doubles 2026-12-01
});

/**
 * A retired model id -> its replacement, keeping a "provider/" prefix and an effort suffix: "gemini-4-argon" ->
 * "gemini-4-neon", "gemini-4-argon-high" -> "gemini-4-neon-high". Anything else (incl. non-strings) comes back as-is,
 * so it is idempotent.
 */
export function migrateModelId(model) {
  if (typeof model !== "string") return model;
  const m = /^((?:[^/]+\/)?)(.+?)(-(?:minimal|low|medium|high|xhigh|max))?$/i.exec(model.trim());
  if (!m) return model;
  const [, prefix, base, suffix = ""] = m;
  const next = RETIRED_MODEL_IDS[base.toLowerCase()];
  return next ? `${prefix}${next}${suffix}` : model;
}
