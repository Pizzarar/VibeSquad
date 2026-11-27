// The Gemini model ids routing and pickers use (N1, 2026-11-21): ONE place to change when Google ships the next one.
// A leaf module (no imports) so provider-failover, stakes-ladder, profile-aliases and src/ can all read it without cycles.
//
// `agy models` ids carry the effort as a suffix (gemini-4-neon-{low,medium,high,xhigh}); profiles + ladders name the bare
// family id and pass the effort as thinkingOptionId, and runner/adapters/acp.mjs pickModel() picks the advertised variant.

/** Top/mid-tier Gemini (leads, Buddies, reviewers, implementers, Tier A). Was gemini-4-argon until N1. */
export const GEMINI_TOP_MODEL = "gemini-4-neon";
/**
 * X2 (@per PLAN_PER_CRUNCH_1127, idea-1118): Gemini Carbon, the third Implement arm (exp6-arm.mjs ARMS.carbon). Not a ladder
 * rung: only a stakes=normal `Implement` pick of the carbon arm runs it. `agy models` (11-27) advertises
 * gemini-4-carbon-{low,medium,high} (no xhigh); acp pickModel maps the bare id to the -medium variant.
 */
export const GEMINI_CARBON_MODEL = "gemini-4-carbon";
/** Cheap-tier Gemini (scouts, pre-check, mechanical). Unchanged by N1. */
export const GEMINI_CHEAP_MODEL = "gemini-3.8-flash";
/** Top/mid-tier DeepSeek on opencode (Work Order - DSP, Senior Reasoning - DSP). */
export const DEEPSEEK_TOP_MODEL = "deepseek/deepseek-v4-pro";
/** Cheap-tier DeepSeek on opencode (mechanical stakes, cheap rung; Mechanical/Audit - DSF). R7 2026-11-25. */
export const DEEPSEEK_CHEAP_MODEL = "deepseek/deepseek-flash";

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

// R10 (@per, 2026-11-25): Claude served through the Antigravity CLI (agy) is its own quota family, "agy-claude". The
// runner provider stays antigravity-cli; the model id names the effort as a suffix (agy has no bare claude ids, no
// Haiku, no xhigh/max — R9 spike). The family has its own cap key and pool rows (antigravity-cli/claude-gpt).
/** Routing family id for Claude on agy. Never "claude" (direct) and never "antigravity-cli" (Gemini). */
export const AGY_CLAUDE_FAMILY = "agy-claude";
/** Top-rung Claude on agy (exact advertised id; effort is the suffix). */
export const AGY_CLAUDE_TOP_MODEL = "claude-opus-5-5-high";
/** Mid-rung Claude on agy (exact advertised id; effort is the suffix). */
export const AGY_CLAUDE_MID_MODEL = "claude-sonnet-5-5-medium";
/** A suffixed agy Claude id ("claude-sonnet-5-5-medium"). Direct-claude ids never carry an effort suffix. */
export const AGY_CLAUDE_SUFFIXED_RE = /^claude-(?:opus|sonnet)-.+-(?:low|medium|high)$/i;

/** True for a Claude id agy can serve (opus/sonnet; agy has no Haiku). Pair it with the provider before deciding a family. */
export function isAgyClaudeModel(model) {
  return typeof model === "string" && /^claude-(?:opus|sonnet)-/i.test(model.trim());
}
