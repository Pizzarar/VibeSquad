// Role-only routing (docs/PLAN_PROFILES_ROLE_ONLY.md P5a, idea-77): a profile names a ROLE; the model + effort come from
// one ladder: role default tier x stakes -> tier -> provider rung (server/stakes-ladder.mjs DEFAULT_TIER_LADDER).
// Pure: no file reads, no globals written. The caller passes the ladders (loadTierLadder()/loadStakesLadder() for the
// user override) and the capped providers. Not wired into the spawn hook yet (P5c). Stored roles (profiles.json schema
// v2, P5b) come in as opts.roles from server/profiles-v2.mjs loadRoles(); ROLE_TABLE is the default.
// Legacy profile names (Workaround, removed in P5f) do NOT use the tier ladder: they replay today's routing exactly
// (failover hop profiles + the old per-stakes ladder), so existing callers see no change during the window.
import { LEGACY_PROFILE_ALIASES, LEGACY_PROFILE_ROLES } from "./profiles.mjs";
import {
  DEFAULT_STAKES_LADDER,
  DEFAULT_TIER_LADDER,
  TIERS,
  normalizeStakes,
  resolveStakesRoute,
  routeProviderFamily,
  stakesTier,
} from "./stakes-ladder.mjs";

export { routeProviderFamily };

/**
 * The 8 roles (from the 12 profiles in use 2026-11-17). `providers` is the preference order walked on cap/quota, with
 * the same three hops as today's failover (server/provider-failover.mjs COUNTERPART_PROFILES + ROLE_FAILOVER_CHAINS).
 * `modes[provider]` = {modeId, effort}: copied from the profile today's failover lands on for that role + provider;
 * effort is the fallback used only when the tier rung has none.
 */
export const ROLE_TABLE = deepFreeze({
  lead: {
    name: "Lead",
    tier: "top",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Lead - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP
    },
  },
  brainstorm: {
    name: "Brainstorm",
    tier: "top",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Brainstorm - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Brainstorm - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP
    },
  },
  implement: {
    name: "Implement",
    tier: "mid",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Implement - Sonnet
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini / Implement - Gemini (trial)
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
    },
  },
  "work-order": {
    name: "Work Order",
    tier: "mid",
    providers: ["opencode", "claude", "antigravity-cli"],
    modes: {
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
      claude: { modeId: "auto", effort: "medium" }, // Implement - Sonnet
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini
    },
  },
  review: {
    // EXP4 (d9692a36): Gemini stays the default reviewer.
    name: "Review",
    tier: "mid",
    providers: ["antigravity-cli", "claude", "opencode"],
    modes: {
      "antigravity-cli": { modeId: "default", effort: "medium" }, // Review - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Review - Sonnet
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP / Senior Reasoning - DSP
    },
  },
  "pre-check": {
    name: "Pre-check",
    tier: "cheap",
    providers: ["antigravity-cli", "claude", "opencode"],
    modes: {
      "antigravity-cli": { modeId: "default", effort: "low" }, // Pre-check - Flash
      claude: { modeId: "auto", effort: "low" }, // Check - Haiku
      opencode: { modeId: "plan", effort: "default" }, // Audit - DSF (read-only)
    },
  },
  "art-director": {
    name: "Art Director",
    tier: "mid",
    providers: ["antigravity-cli", "claude", "opencode"],
    modes: {
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Art Director - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Art Painter - Opus
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
    },
  },
  "art-painter": {
    name: "Art Painter",
    tier: "top",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Art Painter - Opus
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Art Director - Gemini
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
    },
  },
});

/**
 * Every old profile name and every profile today's failover can land on from one, with the provider/model/effort/mode
 * each spawns with at normal stakes (DEFAULT_PACK_PROFILES + the user-file-only "Implement - Gemini (trial)"). Legacy pins.
 */
export const LEGACY_HOP_PROFILES = deepFreeze({
  "Lead - Claude": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Lead - Gemini": { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "accept-edits" },
  "Brainstorm - Claude": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Brainstorm - Gemini": { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "accept-edits" },
  "Implement - Sonnet": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" },
  "Implement - Gemini (trial)": { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "accept-edits" },
  "Work Order - DSP": { provider: "opencode", model: "deepseek/deepseek-v4-pro", effort: "high", modeId: "build" },
  "Review - Gemini": { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "default" },
  "Review - Sonnet": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" },
  "Pre-check - Flash": { provider: "antigravity-cli", model: "gemini-3.8-flash", effort: "low", modeId: "default" },
  "Art Director - Gemini": { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "accept-edits" },
  "Art Painter - Opus": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Check - Haiku": { provider: "claude", model: "claude-haiku-5-5", effort: "low", modeId: "auto" },
  "Audit - DSF": { provider: "opencode", model: "deepseek/deepseek-flash", effort: "default", modeId: "plan" },
  "Senior Reasoning - DSP": { provider: "opencode", model: "deepseek/deepseek-v4-pro", effort: "high", modeId: "build" },
  // P5b: the rest of the shipped pack (chain-only names in ROLE_FAILOVER_CHAINS + their hops).
  "Spec - Opus": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Planner - Sonnet": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" },
  "Implement - Opus": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Mechanical - DSF": { provider: "opencode", model: "deepseek/deepseek-flash", effort: "default", modeId: "build" },
  "Scout - Flash": { provider: "antigravity-cli", model: "gemini-3.8-flash", effort: "low", modeId: "plan" },
  "UX Reviewer - Opus": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
});

/**
 * Old profile name -> `via`: the profile today's failover lands on per provider, in walk order (own profile, then the
 * first uncapped hop), replayed against today's 12-profile user file. Each hop pins provider/model/effort/mode and the
 * old per-stakes ladder applies on top, so an old name routes exactly as today under any caps and stakes.
 */
const LEGACY_VIA = {
  "Lead - Claude": ["Lead - Claude", "Lead - Gemini", "Senior Reasoning - DSP"],
  "Lead - Gemini": ["Lead - Gemini", "Lead - Claude", "Senior Reasoning - DSP"],
  "Brainstorm - Claude": ["Brainstorm - Claude", "Brainstorm - Gemini", "Senior Reasoning - DSP"],
  "Brainstorm - Gemini": ["Brainstorm - Gemini", "Brainstorm - Claude", "Senior Reasoning - DSP"],
  "Implement - Sonnet": ["Implement - Sonnet", "Lead - Gemini", "Work Order - DSP"],
  "Implement - Gemini (trial)": ["Implement - Gemini (trial)", "Implement - Sonnet", "Work Order - DSP"],
  "Work Order - DSP": ["Work Order - DSP", "Implement - Sonnet", "Lead - Gemini"],
  "Review - Gemini": ["Review - Gemini", "Review - Sonnet", "Work Order - DSP"],
  "Review - Sonnet": ["Review - Sonnet", "Review - Gemini", "Senior Reasoning - DSP"],
  "Pre-check - Flash": ["Pre-check - Flash", "Check - Haiku", "Audit - DSF"],
  "Art Director - Gemini": ["Art Director - Gemini", "Art Painter - Opus", "Work Order - DSP"],
  "Art Painter - Opus": ["Art Painter - Opus", "Art Director - Gemini", "Work Order - DSP"],
  // P5b: the rest of the shipped pack (chain-only names in ROLE_FAILOVER_CHAINS).
  "Spec - Opus": ["Spec - Opus", "Lead - Gemini", "Senior Reasoning - DSP"],
  "Planner - Sonnet": ["Planner - Sonnet", "Lead - Gemini", "Senior Reasoning - DSP"],
  "Implement - Opus": ["Implement - Opus", "Lead - Gemini", "Work Order - DSP"],
  "Senior Reasoning - DSP": ["Senior Reasoning - DSP", "Lead - Gemini", "Implement - Sonnet"],
  "Mechanical - DSF": ["Mechanical - DSF", "Pre-check - Flash", "Check - Haiku"],
  "UX Reviewer - Opus": ["UX Reviewer - Opus", "Work Order - DSP", "Review - Gemini"],
  "Check - Haiku": ["Check - Haiku", "Pre-check - Flash", "Audit - DSF"],
  "Audit - DSF": ["Audit - DSF", "Scout - Flash", "Implement - Sonnet"],
  "Scout - Flash": ["Scout - Flash", "Implement - Sonnet", "Work Order - DSP"],
};

/**
 * Legacy profile name -> {role, via}. The role is the legacy alias table's role column (profiles.mjs
 * LEGACY_PROFILE_ROLES); aliases reach an entry through LEGACY_PROFILE_ALIASES. Covers every old name.
 * Workaround: removed in P5f.
 */
export const LEGACY_ROUTES = deepFreeze(
  Object.fromEntries(Object.entries(LEGACY_VIA).map(([name, via]) => [name, { role: LEGACY_PROFILE_ROLES[name], via }])),
);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

function roleKey(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * Role or legacy profile name -> {key, role, legacy}. Order: exact legacy name, exact legacy alias (today's
 * LEGACY_PROFILE_ALIASES, e.g. bare "Lead" -> "Lead - Claude"), role key/name case-insensitively ("work order",
 * "review"), then legacy name case-insensitively. So until P5f the capitalised "Lead"/"Brainstorm" stay the legacy
 * aliases; lowercase or other spellings reach the role. null when nothing matches.
 */
export function lookupRole(name, { roles = ROLE_TABLE, legacy = LEGACY_ROUTES, aliases = LEGACY_PROFILE_ALIASES } = {}) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const legacyHit = (legacyName, alias) => {
    const entry = legacy[legacyName];
    if (!entry || !roles[entry.role]) return null;
    return { key: entry.role, role: roles[entry.role], legacy: { name: legacyName, alias: alias ?? null, ...entry } };
  };
  if (legacy[raw]) return legacyHit(raw);
  if (aliases?.[raw] && legacy[aliases[raw]]) return legacyHit(aliases[raw], raw);
  const k = roleKey(raw);
  if (roles[k]) return { key: k, role: roles[k], legacy: null };
  const byName = Object.entries(roles).find(([, r]) => roleKey(r.name) === k);
  if (byName) return { key: byName[0], role: byName[1], legacy: null };
  const ci = Object.keys(legacy).find((n) => n.toLowerCase() === raw.toLowerCase());
  return ci ? legacyHit(ci) : null;
}

function cappedSet(caps) {
  const out = new Set();
  if (!caps) return out;
  const list = caps instanceof Set || Array.isArray(caps) ? [...caps] : Object.keys(caps).filter((k) => caps[k]);
  for (const c of list) {
    const fam = routeProviderFamily(c);
    if (fam) out.add(fam);
  }
  return out;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const REASON_ORDER = ["explicit-capped", "explicit", "legacy-name", "all-capped", "failover", "stakes"];

/**
 * @param {object}  input
 * @param {string}  input.role      role name ("Lead", "review") or a legacy profile name/alias ("Implement - Sonnet")
 * @param {string} [input.stakes]   tierA-security | tierA-invariant | normal | mechanical; missing/unknown = normal
 * @param {object} [input.explicit] caller-passed {provider, model, effort | thinkingOptionId, modeId}; each given field wins
 * @param {Iterable<string>|Record<string, boolean>} [input.caps] capped/over-quota providers (any alias)
 * @param {object} [input.ladder]       tier ladder (role names); default DEFAULT_TIER_LADDER. Pass loadTierLadder().
 * @param {object} [input.stakesLadder] old per-stakes ladder (legacy names); default DEFAULT_STAKES_LADDER. Pass loadStakesLadder().
 * @param {object} [opts]           {roles, legacy, hops, aliases} table overrides (tests, P5b)
 * @returns {null | {provider, model, effort, modeId, tier, reason, reasons, capped, stakes, role, legacy, alias}}
 *   null = unknown role and no explicit provider (caller keeps its request). `reason` is the primary one, in precedence
 *   explicit-capped > explicit > legacy-name > all-capped > failover > stakes > default; `reasons` lists all that
 *   applied. `capped` = the returned provider is capped: "all-capped" (every hop capped, so the first is kept, as today)
 *   or "explicit-capped" (an explicit provider, or a model naming its own family, on a capped provider: the resolver
 *   only reports it; P5c lets the cap win for profile spawns, as agent-duties.ts does today).
 */
export function resolveRoute({ role, stakes, explicit, caps, ladder, stakesLadder } = {}, opts = {}) {
  const ex = explicit && typeof explicit === "object" ? explicit : {};
  const exProvider = nonEmpty(ex.provider);
  const exModel = nonEmpty(ex.model);
  const exEffort = nonEmpty(ex.effort) ?? nonEmpty(ex.thinkingOptionId);
  const exMode = nonEmpty(ex.modeId);
  const s = normalizeStakes(stakes);
  const found = lookupRole(role, opts);
  if (!found && !exProvider) return null;
  const roleDef = found?.role ?? null;
  const legacy = found?.legacy ?? null;
  const hopProfiles = opts.hops ?? LEGACY_HOP_PROFILES;
  const rungs = ladder && typeof ladder === "object" ? ladder : DEFAULT_TIER_LADDER;
  const reasons = [];

  const forced = stakesTier(s);
  const tierRaw = forced ?? roleDef?.tier ?? "mid";
  const tier = TIERS.includes(tierRaw) ? tierRaw : "mid";
  if (forced) reasons.push("stakes");

  // Walk order: a legacy name's hop profiles (first hop per provider), else the role's provider list.
  const hops = legacy ? legacy.via.map((n) => hopProfiles[n]).filter((h) => h?.provider) : [];
  const order = [];
  for (const p of legacy ? hops.map((h) => routeProviderFamily(h.provider)) : (roleDef?.providers ?? [])) {
    if (p && !order.includes(p)) order.push(p);
  }

  // Provider: explicit > (model's own family, when only a model is given) > walk skipping capped (all capped = first).
  const capped = cappedSet(caps);
  const modelFam = !exProvider && exModel ? routeProviderFamily(exModel) : "";
  let provider;
  if (exProvider || (modelFam && (rungs[modelFam] || order.includes(modelFam)))) {
    provider = exProvider ? routeProviderFamily(exProvider) || exProvider : modelFam;
    if (capped.has(provider)) reasons.push("explicit-capped");
  } else {
    provider = order.find((p) => !capped.has(p));
    if (!provider) {
      provider = order[0];
      if (order.length) reasons.push("all-capped");
    } else if (provider !== order[0]) {
      reasons.push("failover");
    }
  }
  if (legacy) reasons.push("legacy-name");
  if (exProvider || exModel || exEffort || exMode) reasons.push("explicit");

  let model;
  let effort;
  let modeId;
  const hop = legacy ? hops.find((h) => routeProviderFamily(h.provider) === provider) : null;
  if (hop) {
    // Legacy: today's routing replayed (hop profile, old per-stakes ladder on top, profile mode kept).
    const sr = resolveStakesRoute(provider, { model: hop.model, thinkingOptionId: hop.effort }, s, false, {
      ladder: stakesLadder && typeof stakesLadder === "object" ? stakesLadder : DEFAULT_STAKES_LADDER,
    });
    model = (sr.apply && sr.model) || hop.model;
    effort = (sr.apply && sr.effort) || hop.effort;
    modeId = hop.modeId;
  } else {
    const rung = rungs[provider]?.[tier] ?? {};
    const roleMode = roleDef?.modes?.[provider] ?? {};
    model = rung.model;
    effort = rung.effort ?? roleMode.effort;
    modeId = roleMode.modeId;
  }
  model = exModel ?? model ?? undefined;
  effort = exEffort ?? effort ?? undefined;
  modeId = exMode ?? modeId ?? undefined;

  const listed = REASON_ORDER.filter((r) => reasons.includes(r));
  return {
    provider,
    model,
    effort,
    modeId,
    tier,
    reason: listed[0] ?? "default",
    reasons: listed.length ? listed : ["default"],
    capped: Boolean(provider) && capped.has(provider),
    stakes: s,
    role: found?.key ?? null,
    legacy: legacy?.name ?? null,
    alias: legacy?.alias ?? null,
  };
}
