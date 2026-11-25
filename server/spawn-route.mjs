// Spawn routing glue (docs/PLAN_PROFILES_ROLE_ONLY.md P5c, idea-77): how the spawn hook (server/hooks/agent-duties.ts),
// server/brainstorm.mjs and server/lead-handoff.mjs use the role/tier resolver (server/role-route.mjs resolveRoute).
//
// - Role names ("review", "Implement", "work order"): resolveRoute picks provider (role provider list, capped/over-quota
//   providers skipped), model + effort (tier ladder) and mode. The spawn runs as a profile built from that route.
// - Old profile names + aliases (Workaround until P5f): today's failover walk (provider-failover.mjs
//   resolveProfileWithFailover over the live stored profiles) and the old stakes ladder stay the authority, so they route
//   exactly as before even when the owner edited a profile. resolveRoute runs alongside for the tier/role stamp, the
//   `reason=…legacy-name` metric and a shadow check (legacyShadowMismatch).
// - Roles (P5d): once profiles.json is migrated (schemaVersion 2 with a `roles` block, written by the Settings role
//   editor) the stored roles are the truth (profiles-v2.mjs loadRoles). Before that (v1) they are built LIVE from the
//   caller's v1 profiles list (buildRolesFromProfiles), exactly as P5c did. After migration the legacy profile editor is
//   read-only and the server refuses legacy writes that would change a role (roles-api.mjs legacyProfilesConflict).
import { buildRolesFromProfiles, loadRoles } from "./profiles-v2.mjs";
import { legacyProfileRole } from "./profiles.mjs";
import { QUOTA_FAILOVER_THRESHOLD, isProviderOverQuota, spawnFamily } from "./provider-failover.mjs";
import { AGY_CLAUDE_FAMILY } from "./model-ids.mjs";
import { ROLE_TABLE, lookupRole, resolveRoute, routeProviderFamily } from "./role-route.mjs";
import { TIERS, loadStakesLadder, loadTierLadder, normalizeStakes, stakesTier } from "./stakes-ladder.mjs";
import { armCapped } from "./exp6-arm.mjs";

import { isForeignModel } from "./route-override.mjs";
export { ROUTE_OVERRIDE_ENV, ROUTE_OVERRIDE_LABEL, isForeignModel, parseRouteOverride, routeOverrideLabel } from "./route-override.mjs";

/** Labels every routed spawn is stamped with (plus `profile` = the role or old profile name, and `wf`). */
export const ROUTE_STAMP_LABELS = Object.freeze(["provider", "model", "tier", "stakes"]);

const ROUTE_FAMILIES = ["claude", "antigravity-cli", "opencode", AGY_CLAUDE_FAMILY];

/**
 * R10: the runner provider for a routing family. agy-claude is a quota family, not a runner: it runs on antigravity-cli
 * (the model id picks Claude). Every other family is its own runner provider.
 */
export function runnerProviderOf(family) {
  return family === AGY_CLAUDE_FAMILY ? "antigravity-cli" : family;
}

/**
 * Roles a spawn routes by. Migrated profiles.json (v2 roles block, P5d role editor) = the stored roles (loadRoles).
 * v1 / missing / unreadable = built live from `profiles` (empty list = the shipped pack), byte-identical to P5c.
 * @param {any[]} [profiles] the caller's v1 profiles list
 * @param {string} [profilesPath] profiles.json to check for stored roles (default getProfilesPath())
 */
export function liveRoles(profiles, profilesPath) {
  const stored = loadRoles(profilesPath);
  if (stored.source === "v2") return stored.roles;
  return buildRolesFromProfiles(Array.isArray(profiles) ? profiles : []).roles;
}

/** A spawn hint that names a ROLE (not an old profile name or alias): {key, role}. null otherwise. */
export function roleNameHit(hint, roles = ROLE_TABLE) {
  const found = lookupRole(hint, { roles });
  return found && !found.legacy ? { key: found.key, role: found.role } : null;
}

/**
 * The `profile` label a role-name spawn carries: the role's name ("Implement", "Work Order"), unless that name is itself
 * an old alias (bare "Lead" / "Brainstorm" = "Lead - Claude" / "Brainstorm - Claude" until P5f): then the role key
 * ("lead"), so enforceProfileAfterSpawn, respawns and digests read the label back as the same role, never the old name.
 */
export function roleProfileLabel(key, roles = ROLE_TABLE) {
  const name = String(roles?.[key]?.name ?? "").trim();
  return name && roleNameHit(name, roles)?.key === key ? name : key;
}

/** Lifecycle role (lead | brainstorm | worker) for a role key: drives the hook's lead/Buddy handling. */
export function lifecycleRoleOf(key) {
  return key === "lead" ? "lead" : key === "brainstorm" ? "brainstorm" : "worker";
}

/**
 * Families over quota or capped, judged exactly like today's failover (isProviderOverQuota on the hook's usage list,
 * which already carries capped-providers.json as `exhausted` entries). `extra` adds families to check.
 * @param {any[]} usageList
 * @param {string[]} [extra]
 * @param {{threshold?: number, ignoreDiskCaps?: boolean}} [opts]
 * @returns {string[]}
 */
export function cappedFamilies(usageList, extra = [], opts = {}) {
  const fams = new Set(ROUTE_FAMILIES);
  for (const e of extra) {
    const f = routeProviderFamily(e);
    if (f) fams.add(f);
  }
  const list = Array.isArray(usageList) ? usageList : [];
  return [...fams].filter((f) => isProviderOverQuota(f, list, opts.threshold ?? QUOTA_FAILOVER_THRESHOLD, opts).overQuota);
}

/**
 * The profile a role-name spawn runs as. {profile, route, explicitCapped, override} | null (hint is not a role).
 * `override` (H1, idea-974): the caller's own provider and/or model (spawn_worker's ROUTE_OVERRIDE_LABEL). They win:
 *   - provider given: the role runs on that provider; stakes still pick the tier rung (model + effort) of THAT
 *     provider's ladder, unless a model is given too (then the caller's model; the rung's effort still applies).
 *   - model only: the model's own family is the provider (resolveRoute). A model whose family has no ladder (unknown
 *     id) is ignored here, as before (the hook's caller-model rule decides it).
 *   - the caller's provider is capped/over quota: failover still hops along the role's list (the caller's model is kept
 *     only when it belongs to the hop's family). `override.hopped` + `explicitCapped` report it. Every provider capped =
 *     the caller's provider is kept.
 *   - provider + a model of ANOTHER family (provider=claude model=gemini-4-neon; isForeignModel): the model is dropped,
 *     the provider is kept and its ladder rung applies, as the hook does for a caller model (r2, rn-a5cd265243b5 L1).
 *   Returned `override` = {provider, model, hopped, modelDropped} (null when no override applied): the hook stamps
 *   reason=override (+ `model-dropped=family`).
 * `explicitModel`: the caller's model, only to report `explicit-capped` (its family is capped) on a spawn WITHOUT an
 * override: for those the cap wins and the model is dropped when the family changes (P5a review M3).
 * `prefer` (R1, PLAN_PER_ROLES_LADDER_1125): a provider family the role tries first (the R0 implementer arm pick, read
 * from `vs.arm` via exp6-arm.mjs armProvider). Only a family already in the role's provider list moves to the front; the
 * rest keep their order, so a capped/over-quota preferred family still fails over along the role's list. The model is
 * still that family's tier-ladder rung. Unknown/blank = the role's own order. An override provider beats it.
 * @param {string} hint
 * @param {{stakes?: string, caps?: string[], roles?: Record<string, any>, ladder?: Record<string, any>, explicitModel?: string, prefer?: string, tier?: string, override?: {provider?: string, model?: string} | null}} [opts]
 */
export function roleSpawnProfile(hint, { stakes, caps = [], roles, ladder, explicitModel, prefer, tier, override } = {}) {
  let table = roles ?? ROLE_TABLE;
  const found0 = roleNameHit(hint, table);
  if (!found0) return null;
  const fam = routeProviderFamily(prefer);
  const order = found0.role.providers ?? [];
  const capList = caps instanceof Set || Array.isArray(caps) ? [...caps] : Object.keys(caps ?? {}).filter((k) => caps[k]);
  const preferCapped = Boolean(fam && capList.some((c) => routeProviderFamily(c) === fam));
  const tierNorm = TIERS.includes(String(tier ?? "").trim().toLowerCase()) ? String(tier).trim().toLowerCase() : "";
  const preferHit = Boolean(fam && order.includes(fam) && order[0] !== fam);
  // R8: an arm tier (e.g. flash -> cheap) applies when the preferred family is not capped (failover keeps the role's tier).
  const tierHit = Boolean(tierNorm && !preferCapped && found0.role.tier !== tierNorm);
  if (preferHit || tierHit) {
    table = {
      ...table,
      [found0.key]: {
        ...found0.role,
        ...(preferHit ? { providers: [fam, ...order.filter((p) => p !== fam)] } : {}),
        ...(tierHit ? { tier: tierNorm } : {}),
      },
    };
  }
  const found = roleNameHit(hint, table);
  const rungs = ladder ?? loadTierLadder();
  const base = { role: found.key, stakes, caps, ladder: rungs };
  const ovModelRaw = String(override?.model ?? "").trim();
  // R10: an override of antigravity-cli + a Claude id is the agy-claude family (own cap/pool), so the cap check and
  // failover hop judge agy-claude, never Gemini.
  const ovProviderRaw = String(override?.provider ?? "").trim();
  const ovProvider = ovProviderRaw && spawnFamily(ovProviderRaw, ovModelRaw) === AGY_CLAUDE_FAMILY ? AGY_CLAUDE_FAMILY : ovProviderRaw;
  const modelDropped = Boolean(ovProvider && isForeignModel(ovProvider, ovModelRaw));
  const ovModel = modelDropped ? "" : ovModelRaw;
  const ovModelFam = routeProviderFamily(ovModel);
  /** @type {{provider?: string, model?: string} | null} */
  let explicit = null;
  if (ovProvider) explicit = { provider: ovProvider, ...(ovModel ? { model: ovModel } : {}) };
  else if (ovModel && ovModelFam && rungs[ovModelFam]) explicit = { model: ovModel };
  let route = resolveRoute(explicit ? { ...base, explicit } : base, { roles: table });
  if (!route?.provider) return null;
  let explicitCapped = false;
  let applied = null;
  if (explicit) {
    applied = { provider: ovProvider, model: ovModel, hopped: false, modelDropped };
    if (route.reasons.includes("explicit-capped")) {
      // The caller's provider is capped: hop along the role's own list, as failover does for any spawn.
      const walk = resolveRoute(base, { roles: table });
      if (walk?.provider && !walk.capped && walk.provider !== route.provider) {
        route = ovModel && ovModelFam === walk.provider ? resolveRoute({ ...base, explicit: { model: ovModel } }, { roles: table }) : walk;
        applied.hopped = true;
        explicitCapped = true;
      }
    }
  } else {
    const exModel = String(explicitModel ?? "").trim();
    if (exModel) {
      const probe = resolveRoute({ ...base, explicit: { model: exModel } }, { roles: table });
      explicitCapped = Boolean(probe?.reasons?.includes("explicit-capped"));
    }
  }
  const def = found.role;
  // agy-claude runs on the antigravity-cli runner with that provider's mode set (unless a stored role names its own).
  const mode = def.modes?.[route.provider] ?? (route.provider === AGY_CLAUDE_FAMILY ? def.modes?.["antigravity-cli"] : undefined) ?? {};
  const profile = {
    name: roleProfileLabel(found.key, table),
    role: lifecycleRoleOf(found.key),
    roleKey: found.key,
    provider: runnerProviderOf(route.provider),
    ...(route.model ? { model: route.model } : {}),
    ...(route.modeId ? { modeId: route.modeId } : {}),
    ...(route.effort ? { thinkingOptionId: route.effort } : {}),
    ...(mode.featureValues ? { featureValues: { ...mode.featureValues } } : {}),
    notes: typeof mode.prompt === "string" ? mode.prompt : String(def.prompt ?? ""),
    ...(Array.isArray(mode.mcpExtras ?? def.mcpExtras) ? { mcpExtras: [...(mode.mcpExtras ?? def.mcpExtras)] } : {}),
    ...(def.icon !== undefined ? { icon: def.icon } : {}),
    ...(def.color !== undefined ? { color: def.color } : {}),
  };
  return { profile, route, explicitCapped, override: applied };
}

/**
 * Opt-in MCP extras (e.g. playwright) for a ROLE-name spawn on `provider`: the role's per-provider tools, else its own.
 * null = not a role name (callers keep profiles.mjs profileMcpExtras, which only knows profile names).
 * @param {string} name
 * @param {any[]} [profiles] stored v1 profiles (roles are built live from them until profiles.json is migrated)
 * @param {string} [provider]
 * @param {string} [profilesPath]
 * @returns {string[] | null}
 */
export function roleMcpExtras(name, profiles, provider, profilesPath) {
  const found = roleNameHit(name, liveRoles(profiles, profilesPath));
  if (!found) return null;
  const fam = routeProviderFamily(provider);
  const modeExtras = fam ? found.role.modes?.[fam]?.mcpExtras : undefined;
  const ex = Array.isArray(modeExtras) ? modeExtras : found.role.mcpExtras;
  return Array.isArray(ex) ? [...ex] : [];
}

/**
 * resolveRoute for an old profile name/alias (or null when it is not one): the tier/role stamp + `legacy-name`, and
 * whether a caller model on a capped family was dropped. Never decides the old name's routing (today's walk does).
 * @param {string} name
 * @param {{stakes?: string, caps?: string[], explicitModel?: string, stakesLadder?: Record<string, any>}} [opts]
 */
export function legacyRouteMeta(name, { stakes, caps = [], explicitModel, stakesLadder } = {}) {
  if (!legacyProfileRole(name)) return null;
  // The hook applies the user's stakes-ladder.json override on top of the landed profile: the replay must too.
  const sl = stakesLadder ?? loadStakesLadder();
  const route = resolveRoute({ role: name, stakes, caps, stakesLadder: sl });
  if (!route) return null;
  const exModel = String(explicitModel ?? "").trim();
  const probe = exModel ? resolveRoute({ role: name, stakes, caps, stakesLadder: sl, explicit: { model: exModel } }) : null;
  return { route, explicitCapped: Boolean(probe?.reasons?.includes("explicit-capped")) };
}

/**
 * Old names that pin a DeepSeek model (A2 idea-986, PLAN_PER_ROLES_LADDER_1125 Amend 11-25 Per3) -> the role spawn they
 * become while opencode is capped. Their role column in profiles.mjs LEGACY_PROFILE_ROLES (and src/profiles.ts
 * LEGACY_HEAD_ROLE) stays `work-order`: this reroute is conditional, the static role map is not. Aliases ("Coder") reach
 * an entry through their canonical name. Workaround: removed with the old names in P5f (R5).
 */
export const LEGACY_DEEPSEEK_PIN_ROUTES = Object.freeze({
  "Work Order - DSP": Object.freeze({ role: "implement", stakes: "mechanical" }),
  "Mechanical - DSF": Object.freeze({ role: "implement", stakes: "mechanical" }),
});

/**
 * The role spawn an old DeepSeek-pinned name runs as instead of its pinned model, or null (route as before).
 * Fires only when the name (or its alias) is in LEGACY_DEEPSEEK_PIN_ROUTES, the profile it matched still pins opencode
 * (an owner-edited profile on another provider walks as before), and opencode is capped in the live `vs cap` map, read
 * like exp6-arm readArmCaps/armCapped (`dsp` families: opencode, deepseek). Quota percentages alone do not count.
 * `stakes`: the entry's stakes (mechanical) unless the caller asked for tierA-*, which is kept (a Tier A spawn never
 * drops to the cheap rung because its old name was a DeepSeek one).
 * @param {string} name   the spawn's profile name or alias
 * @param {{capped?: Record<string, any> | string[], profile?: {provider?: string, model?: string} | null, stakes?: string}} [opts]
 * @returns {{name: string, alias: string | null, role: string, stakes: string} | null}
 */
export function legacyDeepSeekReroute(name, { capped, profile, stakes } = {}) {
  const hit = legacyProfileRole(name);
  const entry = hit ? LEGACY_DEEPSEEK_PIN_ROUTES[hit.name] : null;
  if (!entry) return null;
  if (profile && routeProviderFamily(profile.provider || profile.model) !== "opencode") return null;
  if (!armCapped("dsp", capped ?? {})) return null;
  const s = normalizeStakes(stakes);
  return { name: hit.name, alias: hit.alias, role: entry.role, stakes: s.startsWith("tierA-") ? s : entry.stakes };
}

/**
 * Shadow check for an old name: what today's walk landed on vs what resolveRoute's replay picks (provider family, and
 * model/effort unless the caller's own value was kept). Differs only when the owner's stored profiles diverge from the
 * P5a golden file (edited model, custom order/providers). "" = agree, else e.g. "provider:opencode!=claude,model:a!=b".
 */
export function legacyShadowMismatch(meta, landed, { skipModel = false, skipEffort = false } = {}) {
  const r = meta?.route;
  if (!r) return "";
  const got = typeof landed === "string" ? { provider: landed } : (landed ?? {});
  const out = [];
  const want = routeProviderFamily(r.provider);
  const have = routeProviderFamily(got.provider);
  if (want && have && want !== have) out.push(`provider:${have}!=${want}`);
  if (typeof landed !== "string") {
    if (!skipModel && r.model && got.model && r.model !== got.model) out.push(`model:${got.model}!=${r.model}`);
    if (!skipEffort && r.effort && got.effort && r.effort !== got.effort) out.push(`effort:${got.effort}!=${r.effort}`);
  }
  return out.join(",");
}

/** Tier stamp for any spawn: stakes force top/cheap, else the role (or old name's role) default; "" when unknown. */
export function routeTierOf(name, stakes) {
  const forced = stakesTier(stakes);
  if (forced) return forced;
  return lookupRole(name)?.role?.tier ?? "";
}

/** Role key stamp for any spawn name ("" for custom profiles). */
export function routeRoleKeyOf(name) {
  return lookupRole(name)?.key ?? "";
}

/**
 * The `route:` metric body. Starts with today's fields (stakes/model/effort/reason, same order and values), then
 * `+legacy-name` on the reason when the caller named an old profile/alias (P5f watches it fall to 0), then tier + role,
 * `explicit-capped=dropped` when a caller model on a capped family was dropped, `model-dropped=family` when an override
 * model of another family than the override provider was dropped (r2), and `shadow=<diff>` when resolveRoute's
 * replay of an old name disagrees with today's walk (legacyShadowMismatch). `family=` (R10): the quota family when the
 * route ran on agy-claude, or `claude` when agy-claude was walked past as capped (then reason/why is failover).
 */
export function routeMetricText({ stakes, model, effort, reason, legacyName = false, tier, role, explicitCapped = false, modelDropped = false, shadow = "", family = "" }) {
  const r = legacyName ? (reason === "default" ? "legacy-name" : `${reason}+legacy-name`) : reason;
  return (
    `stakes=${normalizeStakes(stakes)} model=${model || "-"} effort=${effort || "-"} reason=${r}` +
    ` tier=${tier || "-"} role=${role || "-"}` +
    (explicitCapped ? " explicit-capped=dropped" : "") +
    (modelDropped ? " model-dropped=family" : "") +
    (shadow ? ` shadow=${shadow}` : "") +
    (family ? ` family=${family}` : "")
  );
}

/**
 * brainstorm.mjs / lead-handoff.mjs: a respawn whose profile label is a ROLE name (no stored profile of that name)
 * spawns from the role route, threading its model + thinkingOptionId (effort) into the create call, so the hook sees
 * the same values it would pick. null = not a role name (callers keep their profile path). `override` = the caller's own
 * provider/model (spawn_worker, H1): routed as in roleSpawnProfile, so the spawn config already names that provider's rung.
 */
export function roleSpawnConfig(name, { profiles, profilesPath, stakes, usageList = [], prefer, tier, override } = {}) {
  const roles = liveRoles(profiles, profilesPath);
  if (!roleNameHit(name, roles)) return null;
  const caps = cappedFamilies(usageList, [], { ignoreDiskCaps: true });
  const hit = roleSpawnProfile(name, { stakes, caps, roles, prefer, tier, override });
  if (!hit) return null;
  const p = hit.profile;
  return {
    profileName: p.name,
    profile: p,
    route: hit.route,
    spawnCfg: {
      provider: p.provider,
      model: p.model,
      modeId: p.modeId,
      thinkingOptionId: p.thinkingOptionId,
      ...(p.featureValues ? { featureValues: { ...p.featureValues } } : {}),
      notes: p.notes ?? "",
      systemPrompt: "",
    },
  };
}
