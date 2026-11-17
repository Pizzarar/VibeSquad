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
    "tierA-security": { model: "claude-opus-5-5", effort: "high" },
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

// ---------------------------------------------------------------------------------------------------------------------
// Tier ladder (docs/PLAN_PROFILES_ROLE_ONLY.md P5a): provider -> tier -> {model, effort}. Stakes pick a tier
// (tierA-* -> top, mechanical -> cheap, normal -> the role's default tier, see server/role-route.mjs). Same override
// file as above; its old per-stakes keys are read onto top/cheap. The per-stakes view above (DEFAULT_STAKES_LADDER,
// loadStakesLadder, resolveStakesRoute) stays as-is for the live spawn hook until P5c switches it to resolveRoute.
// Fable is explicit-only (never a rung): an override rung naming a fable model is dropped.

export const TIERS = ["top", "mid", "cheap"];

/** A rung with no `effort` falls back to the role's per-provider effort (server/role-route.mjs ROLE_TABLE). */
export const DEFAULT_TIER_LADDER = deepFreeze({
  claude: {
    top: { model: "claude-opus-5-5", effort: "high" },
    mid: { model: "claude-sonnet-5-5", effort: "medium" },
    cheap: { model: "claude-sonnet-5-5", effort: "low" },
  },
  "antigravity-cli": {
    top: { model: "gemini-4-argon", effort: "high" },
    mid: { model: "gemini-4-argon" },
    cheap: { model: "gemini-3.8-flash" },
  },
  opencode: {
    top: { model: "deepseek/deepseek-v4-pro", effort: "high" },
    mid: { model: "deepseek/deepseek-v4-pro" },
    cheap: { model: "deepseek/deepseek-v4-pro" },
  },
});

/** Old per-stakes override keys -> tier, in apply order (later wins): tierA-security beats tierA-invariant on top. */
const LEGACY_STAKES_TIER_KEYS = [
  ["mechanical", "cheap"],
  ["tierA-invariant", "top"],
  ["tierA-security", "top"],
];

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

/** The tier stakes force, or null when the role's default tier applies (normal / missing / unknown). */
export function stakesTier(stakes) {
  const s = normalizeStakes(stakes);
  if (s === "tierA-security" || s === "tierA-invariant") return "top";
  if (s === "mechanical") return "cheap";
  return null;
}

function cleanRung(rung) {
  if (!rung || typeof rung !== "object" || Array.isArray(rung)) return null;
  const clean = {};
  if (typeof rung.model === "string" && rung.model.trim()) clean.model = rung.model.trim();
  if (typeof rung.effort === "string" && rung.effort.trim()) clean.effort = rung.effort.trim();
  if (clean.model && /fable/i.test(clean.model)) return null; // Fable: explicit-only, never a rung
  return clean;
}

/**
 * Defaults with ~/.vibesquad/stakes-ladder.json merged on top, field by field (an override rung's model/effort replace
 * the default's; fields it omits keep the default). Tier keys (top/mid/cheap) win over old per-stakes keys for the same
 * tier. Unknown providers in the file get their own rungs. Read-only: never rewrites the file. Bad file = defaults.
 */
export function loadTierLadder(file = stakesLadderPath()) {
  const out = {};
  for (const [fam, rungs] of Object.entries(DEFAULT_TIER_LADDER)) {
    out[fam] = {};
    for (const [tier, rung] of Object.entries(rungs)) out[fam][tier] = { ...rung };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return out;
  }
  const src = raw && typeof raw === "object" && raw.ladder && typeof raw.ladder === "object" ? raw.ladder : raw;
  if (!src || typeof src !== "object" || Array.isArray(src)) return out;
  for (const [prov, rungs] of Object.entries(src)) {
    const fam = normalizeProviderFamily(prov);
    if (!fam || !rungs || typeof rungs !== "object" || Array.isArray(rungs)) continue;
    const merged = {};
    for (const [stakesKey, tier] of LEGACY_STAKES_TIER_KEYS) {
      const clean = cleanRung(rungs[stakesKey]);
      if (clean) merged[tier] = { ...(merged[tier] ?? {}), ...clean };
    }
    for (const tier of TIERS) {
      const clean = cleanRung(rungs[tier]);
      if (clean) merged[tier] = { ...(merged[tier] ?? {}), ...clean };
    }
    if (!Object.keys(merged).length) continue;
    out[fam] = out[fam] ?? {};
    for (const [tier, rung] of Object.entries(merged)) out[fam][tier] = { ...(out[fam][tier] ?? {}), ...rung };
  }
  return out;
}
