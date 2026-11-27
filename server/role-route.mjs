// Role-only routing (docs/PLAN_PROFILES_ROLE_ONLY.md P5a, idea-77): a profile names a ROLE; the model + effort come from
// one ladder: role default tier x stakes -> tier -> provider rung (server/stakes-ladder.mjs DEFAULT_TIER_LADDER).
// Pure: no file reads, no globals written. The caller passes the ladders (loadTierLadder()/loadStakesLadder() for the
// user override) and the capped providers. Wired into the spawn hook by P5c (server/spawn-route.mjs). Stored roles (profiles.json schema
// v2, P5b) come in as opts.roles from server/profiles-v2.mjs loadRoles(); ROLE_TABLE is the default.
// Legacy profile names (Workaround, removed in P5f) do NOT use the tier ladder: they replay today's routing exactly
// (failover hop profiles + the old per-stakes ladder), so existing callers see no change during the window.
import { LEGACY_PROFILE_ALIASES, LEGACY_PROFILE_ROLES } from "./profiles.mjs";
import { AGY_CLAUDE_FAMILY, GEMINI_TOP_MODEL } from "./model-ids.mjs";
import { ROLE_PROVIDER_CHAINS, TIER_PROVIDER_CHAINS, isInterruptibleWork } from "./provider-failover.mjs";
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
 * The 10 roles (8 from the 12 profiles in use 2026-11-17, + planner in R1, + ux-review in R1 fu). `providers` is the preference order walked on cap/quota, read
 * from the role-keyed chain table (server/provider-failover.mjs ROLE_PROVIDER_CHAINS, R1): the same three hops the old
 * names' COUNTERPART_PROFILES + ROLE_FAILOVER_CHAINS land on.
 * `modes[provider]` = {modeId, effort}: copied from the profile today's failover lands on for that role + provider;
 * effort is the fallback used only when the tier rung has none.
 * `hidden: true` = resolves and routes as usual but is left out of role listings (`vs profiles`, Settings pickers):
 * work-order is the old DSP-first lane kept for old names and explicit requests (R1); new spawns pick implement.
 */
export const ROLE_TABLE = deepFreeze({
  lead: {
    name: "Lead",
    tier: "top",
    providers: roleChain("lead"),
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Lead - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP
    },
  },
  brainstorm: {
    name: "Brainstorm",
    tier: "top",
    providers: roleChain("brainstorm"),
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Brainstorm - Claude
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Brainstorm - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP
    },
  },
  planner: {
    // R1: planning/spec work (old Planner - Sonnet, Spec - Opus) gets its own role instead of riding implement.
    name: "Planner",
    tier: "mid",
    providers: roleChain("planner"),
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Planner - Sonnet
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini
      opencode: { modeId: "build", effort: "high" }, // Senior Reasoning - DSP
    },
  },
  implement: {
    name: "Implement",
    tier: "mid",
    providers: roleChain("implement"),
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // Implement - Sonnet
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Lead - Gemini / Implement - Gemini (trial)
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
    },
  },
  "work-order": {
    name: "Work Order",
    tier: "mid",
    hidden: true,
    providers: roleChain("work-order"),
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
    providers: roleChain("review"),
    modes: {
      "antigravity-cli": { modeId: "default", effort: "medium" }, // Review - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Review - Sonnet
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP / Senior Reasoning - DSP
    },
  },
  "ux-review": {
    // R1 fu (UX_REVIEW_PER_R1A owner decision 2): the old "UX Reviewer - Opus" profile as its own visible role. Judges the
    // whole window after UI merges, so top tier; not interruptible (soft line applies, same as Review).
    name: "UX Review",
    tier: "top",
    providers: roleChain("ux-review"),
    modes: {
      claude: { modeId: "auto", effort: "medium" }, // UX Reviewer - Opus
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // writes docs/UX_REVIEW_*.md + screenshots
    },
  },
  "pre-check": {
    name: "Pre-check",
    tier: "cheap",
    providers: roleChain("pre-check"),
    modes: {
      "antigravity-cli": { modeId: "default", effort: "low" }, // Pre-check - Flash
      claude: { modeId: "auto", effort: "low" }, // Check - Haiku
      opencode: { modeId: "plan", effort: "default" }, // Audit - DSF (read-only)
    },
  },
  "art-director": {
    name: "Art Director",
    tier: "mid",
    providers: roleChain("art-director"),
    modes: {
      "antigravity-cli": { modeId: "accept-edits", effort: "medium" }, // Art Director - Gemini
      claude: { modeId: "auto", effort: "medium" }, // Art Painter - Opus
      opencode: { modeId: "build", effort: "high" }, // Work Order - DSP
    },
  },
  "art-painter": {
    name: "Art Painter",
    tier: "top",
    providers: roleChain("art-painter"),
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
  "Lead - Gemini": { provider: "antigravity-cli", model: GEMINI_TOP_MODEL, effort: "medium", modeId: "accept-edits" },
  "Brainstorm - Claude": { provider: "claude", model: "claude-opus-5-5", effort: "medium", modeId: "auto" },
  "Brainstorm - Gemini": { provider: "antigravity-cli", model: GEMINI_TOP_MODEL, effort: "medium", modeId: "accept-edits" },
  "Implement - Sonnet": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" },
  "Implement - Gemini (trial)": { provider: "antigravity-cli", model: GEMINI_TOP_MODEL, effort: "medium", modeId: "accept-edits" },
  "Work Order - DSP": { provider: "opencode", model: "deepseek/deepseek-v4-pro", effort: "high", modeId: "build" },
  "Review - Gemini": { provider: "antigravity-cli", model: GEMINI_TOP_MODEL, effort: "medium", modeId: "default" },
  "Review - Sonnet": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" },
  "Pre-check - Flash": { provider: "antigravity-cli", model: "gemini-3.8-flash", effort: "low", modeId: "default" },
  "Art Director - Gemini": { provider: "antigravity-cli", model: GEMINI_TOP_MODEL, effort: "medium", modeId: "accept-edits" },
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

/** A copy of the role's failover chain (ROLE_PROVIDER_CHAINS), so ROLE_TABLE never aliases the shared table. */
function roleChain(key) {
  const chain = ROLE_PROVIDER_CHAINS[key];
  if (!chain?.length) throw new Error(`role-route: no failover chain for role "${key}"`);
  return [...chain];
}

/** Role keys a listing shows: hidden roles (ROLE_TABLE `hidden`, or a stored role marked hidden) are left out. */
export function isHiddenRole(key, roles = ROLE_TABLE) {
  return Boolean(roles?.[key]?.hidden ?? ROLE_TABLE[key]?.hidden);
}

export function listedRoleKeys(roles = ROLE_TABLE) {
  return Object.keys(roles ?? {}).filter((k) => !isHiddenRole(k, roles));
}

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

function softCapMap(softCaps) {
  const out = new Map();
  if (!softCaps) return out;
  if (softCaps instanceof Set || Array.isArray(softCaps)) {
    for (const c of softCaps) {
      const fam = routeProviderFamily(c);
      if (fam && !out.has(fam)) out.set(fam, "");
    }
    return out;
  }
  if (softCaps instanceof Map) {
    for (const [k, v] of softCaps.entries()) {
      if (!v) continue;
      const fam = routeProviderFamily(k);
      if (fam && !out.has(fam)) out.set(fam, typeof v === "string" ? v : "");
    }
    return out;
  }
  if (typeof softCaps === "object") {
    for (const [k, v] of Object.entries(softCaps)) {
      if (!v) continue;
      const fam = routeProviderFamily(k);
      if (fam && !out.has(fam)) out.set(fam, typeof v === "string" ? v : "");
    }
  }
  return out;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** R10: roles that never walk agy-claude (they keep direct claude first). */
export const AGY_CLAUDE_EXCLUDED_ROLES = Object.freeze(new Set(["lead", "brainstorm"]));

const REASON_ORDER = ["explicit-capped", "explicit", "legacy-name", "all-capped", "failover", "stakes"];

/**
 * @param {object}  input
 * @param {string}  input.role      role name ("Lead", "review") or a legacy profile name/alias ("Implement - Sonnet")
 * @param {string} [input.stakes]   tierA-security | tierA-invariant | normal | mechanical; missing/unknown = normal
 * @param {object} [input.explicit] caller-passed {provider, model, effort | thinkingOptionId, modeId}; each given field wins
 * @param {Iterable<string>|Record<string, boolean>} [input.caps] capped/over-quota providers (any alias)
 * @param {string} [input.kind]     labels.kind (docs | audit | spike | pre-check = interruptible: the soft line never applies)
 * @param {Iterable<string>|Record<string, string|boolean>} [input.softCaps] families past their soft line (under hard), name -> reason
 * @param {Iterable<string>} [input.unknown] families with no fresh quota row; ranked after known-under-soft while the soft line is in play
 * @param {object} [input.ladder]       tier ladder (role names); default DEFAULT_TIER_LADDER. Pass loadTierLadder().
 * @param {object} [input.stakesLadder] old per-stakes ladder (legacy names); default DEFAULT_STAKES_LADDER. Pass loadStakesLadder().
 * @param {boolean} [input.directClaude] R10: never walk agy-claude (a caller's explicit Claude model/effort pins direct claude)
 * @param {object} [opts]           {roles, legacy, hops, aliases} table overrides (tests, P5b)
 * @returns {null | {provider, model, effort, modeId, tier, reason, reasons, capped, stakes, role, legacy, alias, hop}}
 *   hop = the legacy profile name the walk landed on (legacy names only, else null).
 *   null = unknown role and no explicit provider (caller keeps its request). `reason` is the primary one, in precedence
 *   explicit-capped > explicit > legacy-name > all-capped > failover > stakes > default; `reasons` lists all that
 *   applied. `capped` = the returned provider is capped: "all-capped" (every hop capped, so the first is kept, as today)
 *   or "explicit-capped" (an explicit provider, or a model naming its own family, on a capped provider: the resolver
 *   only reports it; P5c lets the cap win for profile spawns, as agent-duties.ts does today).
 */
export function resolveRoute({ role, stakes, kind, explicit, caps, softCaps, unknown, ladder, stakesLadder, directClaude = false } = {}, opts = {}) {
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
  const hops = legacy ? legacy.via.map((n) => hopProfiles[n] && { ...hopProfiles[n], name: n }).filter((h) => h?.provider) : [];
  const order = [];
  for (const p of legacy ? hops.map((h) => routeProviderFamily(h.provider)) : (roleDef?.providers ?? [])) {
    if (p && !order.includes(p)) order.push(p);
  }
  // A2 (idea-986): stakes that force a tier with its own walk order (mechanical -> cheap: Flash, Haiku, DeepSeek last)
  // re-order the role's families; families the tier chain does not name keep their place after it. Role names only.
  const tierChain = !legacy && forced ? TIER_PROVIDER_CHAINS[forced] : null;
  if (tierChain) {
    const rank = (p) => (tierChain.includes(p) ? tierChain.indexOf(p) : tierChain.length);
    order.sort((a, b) => rank(a) - rank(b));
  }
  // R10 (@per): worker roles try Claude on agy (its own pool) just before direct claude, on the tiers it has a rung for
  // (top/mid; no Haiku on agy, so cheap stays direct). Leads and Buddies stay direct claude. Role names only: legacy
  // names replay today's routing. The pool (>= AGY_CLAUDE_FAILOVER_THRESHOLD) or `vs cap add agy-claude` caps it.
  const ci = order.indexOf("claude");
  if (!legacy && !directClaude && !AGY_CLAUDE_EXCLUDED_ROLES.has(found?.key) && ci >= 0 && !order.includes(AGY_CLAUDE_FAMILY) && rungs[AGY_CLAUDE_FAMILY]?.[tier]?.model) {
    order.splice(ci, 0, AGY_CLAUDE_FAMILY);
  }

  // Provider: explicit > (model's own family, when only a model is given) > walk skipping hard+soft capped
  // (soft line only applies to non-interruptible work; if every family is past soft, fall back to first under hard).
  const capped = cappedSet(caps);
  const interruptible = isInterruptibleWork({ stakes: s, kind, role: found?.key ?? role });
  const softMap = interruptible ? new Map() : softCapMap(softCaps);
  const unknownSet = interruptible ? new Set() : new Set(softCapMap(unknown).keys());
  const modelFam = !exProvider && exModel ? routeProviderFamily(exModel) : "";
  let provider;
  /** R10: the walk chose `provider` (an uncapped family), so the capped ones before it were really walked past. */
  let walked = false;
  let softFailover = false;
  let softReason = null;
  if (exProvider || (modelFam && (rungs[modelFam] || order.includes(modelFam)))) {
    provider = exProvider ? routeProviderFamily(exProvider) || exProvider : modelFam;
    if (capped.has(provider)) reasons.push("explicit-capped");
  } else {
    // C fu1 L4: while the soft line is in play (a family on the walk is past soft, under hard), a family with a known
    // reading under soft ranks before one with no fresh quota row (`unknown`: limits-read drops stale rows). No family
    // past soft = walk order, exactly as before C.
    const free = order.filter((p) => !capped.has(p) && !softMap.has(p));
    const softInPlay = order.some((p) => !capped.has(p) && softMap.has(p));
    const underSoft = softInPlay ? (free.find((p) => !unknownSet.has(p)) ?? free[0]) : free[0];
    if (underSoft) {
      provider = underSoft;
      walked = true;
      if (provider !== order[0]) {
        reasons.push("failover");
        const head = order.slice(0, order.indexOf(provider));
        const softHit = head.find((p) => !capped.has(p) && softMap.has(p));
        const unknownHit = head.filter((p) => !capped.has(p) && !softMap.has(p) && unknownSet.has(p));
        if (softHit || (softInPlay && unknownHit.length)) {
          softFailover = true;
          const rawMsg = softHit ? softMap.get(softHit) : "";
          const baseMsg = softHit
            ? (rawMsg ? (rawMsg.startsWith(`${softHit} `) ? rawMsg : `${softHit} ${rawMsg}`) : `${softHit} soft quota: interruptible only`)
            : `no quota row for ${unknownHit.join("+")}: ranked after known under soft`;
          softReason = `${baseMsg} -> ${provider}`;
        }
      }
    } else {
      // Every family is past soft (or hard): keep today's behavior — use the first one under the hard line.
      provider = order.find((p) => !capped.has(p));
      if (!provider) {
        // R10 fu2: agy-claude trips at 85% (and is first in the walk), so when every family is capped it is the likeliest to be
        // dead; direct claude (95% / its own cap) is the likelier survivor, so keep that instead of agy-claude.
        provider = order[0] === AGY_CLAUDE_FAMILY && order.includes("claude") ? "claude" : order[0];
        if (order.length) reasons.push("all-capped");
      } else {
        walked = true;
        if (provider !== order[0]) reasons.push("failover");
      }
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
    // agy-claude runs on the antigravity-cli runner: same mode set as Gemini unless a stored role names its own.
    const roleMode = roleDef?.modes?.[provider] ?? (provider === AGY_CLAUDE_FAMILY ? roleDef?.modes?.["antigravity-cli"] : undefined) ?? {};
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
    softFailover,
    softReason,
    interruptible,
    stakes: s,
    role: found?.key ?? null,
    legacy: legacy?.name ?? null,
    alias: legacy?.alias ?? null,
    hop: hop?.name ?? null,
    // R10: the walk order and the capped/soft-capped families walked past before `provider` (label family=/why=failover). An
    // explicit provider/model or an all-capped route walked nothing: [].
    walk: [...order],
    skipped: walked ? order.slice(0, order.indexOf(provider)).filter((p) => capped.has(p) || (softFailover && (softMap.has(p) || unknownSet.has(p)))) : [],
  };
}
