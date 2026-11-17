// Role-only routing (docs/PLAN_PROFILES_ROLE_ONLY.md P5a, idea-77): a profile names a ROLE; the model + effort come from
// one ladder: role default tier x stakes -> tier -> provider rung (server/stakes-ladder.mjs DEFAULT_TIER_LADDER).
// Pure: no file reads, no globals written. The caller passes the ladder (loadTierLadder() for the user override) and the
// capped providers. Not wired into the spawn hook yet (P5c); no profile schema change (P5b).
import { normalizeProviderFamily } from "./provider-failover.mjs";
import { DEFAULT_TIER_LADDER, TIERS, normalizeStakes, stakesTier } from "./stakes-ladder.mjs";

/**
 * The 8 roles (from the 12 profiles in use 2026-11-17). `providers` is the preference order walked on cap/quota.
 * `modes[provider]` = {modeId, effort}: modeId copied from today's profile for that role+provider; effort is the
 * fallback used only when the tier rung has none (copied the same way). Combos with no profile today copy the
 * profile the old failover chain landed on (server/provider-failover.mjs ROLE_FAILOVER_CHAINS).
 */
export const ROLE_TABLE = deepFreeze({
  lead: {
    name: "Lead",
    tier: "top",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Lead - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP (chain)
    },
  },
  brainstorm: {
    name: "Brainstorm",
    tier: "top",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Brainstorm - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Brainstorm - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP (chain)
    },
  },
  implement: {
    name: "Implement",
    tier: "mid",
    providers: ["claude", "antigravity-cli", "opencode"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Implement - Sonnet
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Implement - Gemini (trial)
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP (chain)
    },
  },
  "work-order": {
    name: "Work Order",
    tier: "mid",
    providers: ["opencode", "claude"],
    modes: {
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
      claude: { modeId: "auto", effort: "medium" }, // Implement - Sonnet (chain)
    },
  },
  review: {
    // EXP4 (d9692a36): Gemini stays the default reviewer.
    name: "Review",
    tier: "mid",
    providers: ["antigravity-cli", "claude"],
    modes: {
      "antigravity-cli": { modeId: "default", effort: "medium" }, // Review - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Review - Sonnet
    },
  },
  "pre-check": {
    name: "Pre-check",
    tier: "cheap",
    providers: ["antigravity-cli", "claude"],
    modes: {
      "antigravity-cli": { modeId: "default", effort: "low" }, // Pre-check - Flash
      claude: { modeId: "auto", effort: "low" }, // Check - Haiku (chain)
    },
  },
  "art-director": {
    name: "Art Director",
    tier: "mid",
    providers: ["antigravity-cli", "claude"],
    modes: {
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Art Director - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Art Painter - Opus
    },
  },
  "art-painter": {
    name: "Art Painter",
    tier: "top",
    providers: ["claude", "antigravity-cli"],
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Art Painter - Opus
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Art Director - Gemini
    },
  },
});

/**
 * Legacy profile name -> role + provider pin (+ optional tier override, + `pin` = the exact model/effort/modeId that
 * name ran at normal stakes, used only on the pinned provider when stakes do not force a tier). Covers the 12 profiles
 * in use; P5b extends it (the rest of DEFAULT_PACK_PROFILES, LEGACY_PROFILE_ALIASES, the chain-only names). Workaround:
 * removed in P5f. Pins exist only where the role's tier rung differs from what the name ran before: the top rungs are
 * effort high, these four ran effort medium.
 */
export const LEGACY_ROUTES = deepFreeze({
  "Lead - Claude": { role: "lead", provider: "claude", pin: { effort: "medium" } },
  "Lead - Gemini": { role: "lead", provider: "antigravity-cli", pin: { effort: "medium" } },
  "Brainstorm - Claude": { role: "brainstorm", provider: "claude", pin: { effort: "medium" } },
  "Brainstorm - Gemini": { role: "brainstorm", provider: "antigravity-cli", pin: { effort: "medium" } },
  "Implement - Sonnet": { role: "implement", provider: "claude" },
  "Implement - Gemini (trial)": { role: "implement", provider: "antigravity-cli" },
  "Work Order - DSP": { role: "work-order", provider: "opencode" },
  "Review - Gemini": { role: "review", provider: "antigravity-cli" },
  "Review - Sonnet": { role: "review", provider: "claude" },
  "Pre-check - Flash": { role: "pre-check", provider: "antigravity-cli" },
  "Art Director - Gemini": { role: "art-director", provider: "antigravity-cli" },
  "Art Painter - Opus": { role: "art-painter", provider: "claude", pin: { effort: "medium" } },
});

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

/** Provider family for routing: provider-failover's families plus deepseek model ids -> opencode. "" when blank. */
export function routeProviderFamily(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s === "deepseek" || s.startsWith("deepseek/") || s.startsWith("deepseek-")) return "opencode";
  return normalizeProviderFamily(s);
}

/**
 * Role or legacy profile name -> {key, role, legacy}. Role names match case-insensitively ("Work Order", "work-order").
 * Legacy names match exactly first, then case-insensitively. null when neither.
 */
export function lookupRole(name, { roles = ROLE_TABLE, legacy = LEGACY_ROUTES } = {}) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const k = roleKey(raw);
  if (roles[k]) return { key: k, role: roles[k], legacy: null };
  const byName = Object.entries(roles).find(([, r]) => roleKey(r.name) === k);
  if (byName) return { key: byName[0], role: byName[1], legacy: null };
  const legacyName = legacy[raw] ? raw : Object.keys(legacy).find((n) => n.toLowerCase() === raw.toLowerCase());
  const entry = legacyName ? legacy[legacyName] : null;
  if (!entry || !roles[entry.role]) return null;
  return { key: entry.role, role: roles[entry.role], legacy: { name: legacyName, ...entry } };
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

/**
 * @param {object}  input
 * @param {string}  input.role      role name ("Lead", "review") or a legacy profile name ("Implement - Sonnet")
 * @param {string} [input.stakes]   tierA-security | tierA-invariant | normal | mechanical; missing/unknown = normal
 * @param {object} [input.explicit] caller-passed {provider, model, effort | thinkingOptionId, modeId}; each given field wins
 * @param {Iterable<string>|Record<string, boolean>} [input.caps] capped/over-quota providers (any alias)
 * @param {object} [input.ladder]   tier ladder; default DEFAULT_TIER_LADDER. Pass loadTierLadder() to honour the user file.
 * @param {object} [opts]           {roles, legacy} table overrides (tests, P5b)
 * @returns {null | {provider, model, effort, modeId, tier, reason, reasons, stakes, role, legacy}}
 *   null = unknown role and no explicit provider (caller keeps its request). `reason` is the primary one, in precedence
 *   explicit > legacy-name > all-capped > failover > stakes > default; `reasons` lists every one that applied.
 *   "all-capped" = every provider of the role is capped, so the first preference is used anyway (a later cap check
 *   decides). An explicit provider or a model naming its own family skips the cap walk (explicit beats everything).
 *   A legacy pin applies only on its own provider and only when stakes do not force a tier.
 */
export function resolveRoute({ role, stakes, explicit, caps, ladder } = {}, opts = {}) {
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
  const rungs = ladder && typeof ladder === "object" ? ladder : DEFAULT_TIER_LADDER;
  const reasons = [];

  const forced = stakesTier(s);
  const tierRaw = forced ?? legacy?.tier ?? roleDef?.tier ?? "mid";
  const tier = TIERS.includes(tierRaw) ? tierRaw : "mid";
  if (forced) reasons.push("stakes");

  // Provider: explicit > (model's own family, when only a model is given) > preference walk skipping capped.
  let provider;
  const capped = cappedSet(caps);
  if (exProvider) {
    provider = routeProviderFamily(exProvider) || exProvider;
  } else {
    const prefs = [...(roleDef?.providers ?? [])];
    const first = legacy?.provider ?? prefs[0];
    const order = [first, ...prefs.filter((p) => p !== first)];
    const modelFam = exModel ? routeProviderFamily(exModel) : "";
    if (modelFam && rungs[modelFam]) {
      provider = modelFam;
    } else {
      provider = order.find((p) => !capped.has(p));
      if (!provider) {
        provider = first;
        reasons.push("all-capped");
      } else if (provider !== first) {
        reasons.push("failover");
      }
    }
  }

  const rung = rungs[provider]?.[tier] ?? {};
  const roleMode = roleDef?.modes?.[provider] ?? {};
  const pin = legacy?.pin && legacy.provider === provider && !forced ? legacy.pin : null;
  if (legacy) reasons.push("legacy-name");

  const model = exModel ?? pin?.model ?? rung.model ?? undefined;
  const effort = exEffort ?? pin?.effort ?? rung.effort ?? roleMode.effort ?? undefined;
  const modeId = exMode ?? pin?.modeId ?? roleMode.modeId ?? undefined;
  if (exProvider || exModel || exEffort || exMode) reasons.unshift("explicit");

  const order = ["explicit", "legacy-name", "all-capped", "failover", "stakes"];
  const reason = order.find((r) => reasons.includes(r)) ?? "default";
  return {
    provider,
    model,
    effort,
    modeId,
    tier,
    reason,
    reasons: reasons.length ? order.filter((r) => reasons.includes(r)) : ["default"],
    stakes: s,
    role: found?.key ?? null,
    legacy: legacy?.name ?? null,
  };
}
