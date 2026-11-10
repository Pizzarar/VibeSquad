// Routing by stakes (docs/PLAN_ROUTING_BY_STAKES.md): a spawn's `stakes` label picks a model + effort
// from a per-provider ladder, keyed by the provider the spawn ends up on AFTER the existing failover.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeProviderFamily } from "./provider-failover.mjs";

export const STAKES_VALUES = ["tierA-security", "tierA-invariant", "normal", "mechanical"];

/** A rung with no `model` keeps the profile's model; no `effort` keeps the profile's effort. */
export const DEFAULT_STAKES_LADDER = {
  claude: {
    "tierA-security": { model: "claude-fable-5-1", effort: "high" },
    "tierA-invariant": { model: "claude-opus-5-5", effort: "high" },
    mechanical: { model: "claude-sonnet-5-5", effort: "low" },
  },
  "antigravity-cli": {
    "tierA-security": { model: "gemini-4-argon", effort: "high" },
    "tierA-invariant": { model: "gemini-4-argon", effort: "high" },
    mechanical: { model: "gemini-3.8-flash" },
  },
  opencode: {
    "tierA-security": { effort: "high" },
    "tierA-invariant": { effort: "high" },
    mechanical: {},
  },
};

export function stakesLadderPath() {
  const base = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return join(base, "stakes-ladder.json");
}

export function normalizeStakes(raw) {
  const s = String(raw ?? "").trim();
  return STAKES_VALUES.includes(s) ? s : "normal";
}

/** Defaults with per-provider/per-stakes rungs from ~/.vibesquad/stakes-ladder.json merged on top. Bad file = defaults. */
export function loadStakesLadder(file = stakesLadderPath()) {
  const out = {};
  for (const [fam, rungs] of Object.entries(DEFAULT_STAKES_LADDER)) out[fam] = { ...rungs };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  const src = raw && typeof raw === "object" && raw.ladder && typeof raw.ladder === "object" ? raw.ladder : raw;
  if (!src || typeof src !== "object" || Array.isArray(src)) return out;
  for (const [prov, rungs] of Object.entries(src)) {
    const fam = normalizeProviderFamily(prov);
    if (!fam || !rungs || typeof rungs !== "object") continue;
    for (const [stakes, rung] of Object.entries(rungs)) {
      if (!STAKES_VALUES.includes(stakes) || stakes === "normal" || !rung || typeof rung !== "object") continue;
      const clean = {};
      if (typeof rung.model === "string" && rung.model.trim()) clean.model = rung.model.trim();
      if (typeof rung.effort === "string" && rung.effort.trim()) clean.effort = rung.effort.trim();
      out[fam] = { ...(out[fam] ?? {}), [stakes]: clean };
    }
  }
  return out;
}

/**
 * @param provider  provider the spawn ends up on (after failover)
 * @param profile   matched profile ({model, thinkingOptionId}) or null
 * @param stakes    raw stakes label; missing/unknown = normal
 * @param explicit  caller-passed fields that must be kept: true (both) or {model, effort} booleans; merged per field
 * @returns {{stakes, model, effort, reason: "ladder"|"explicit"|"explicit+ladder"|"default", apply: boolean}}
 *   apply = the ladder rewrites the spawn. On apply, model/effort are the rung's values for the fields the caller did not
 *   pass (undefined = leave that field alone, e.g. a rung without a model); otherwise they are the profile's.
 */
export function resolveStakesRoute(provider, profile, stakes, explicit, opts = {}) {
  const s = normalizeStakes(stakes);
  const base = { stakes: s, model: profile?.model || undefined, effort: profile?.thinkingOptionId || undefined };
  const keep = explicit === true ? { model: true, effort: true } : { model: Boolean(explicit?.model), effort: Boolean(explicit?.effort) };
  if (keep.model && keep.effort) return { ...base, reason: "explicit", apply: false };
  if (s === "normal") return { ...base, reason: keep.model || keep.effort ? "explicit" : "default", apply: false };
  const ladder = opts.ladder ?? loadStakesLadder();
  const rung = ladder[normalizeProviderFamily(provider)]?.[s];
  const model = keep.model ? undefined : rung?.model || undefined;
  const effort = keep.effort ? undefined : rung?.effort || undefined;
  if (!model && !effort) return { ...base, reason: keep.model || keep.effort ? "explicit" : "default", apply: false };
  return { stakes: s, model, effort, reason: keep.model || keep.effort ? "explicit+ladder" : "ladder", apply: true };
}
