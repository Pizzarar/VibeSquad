// Spawn routing glue (docs/PLAN_PROFILES_ROLE_ONLY.md P5c, idea-77): how the spawn hook (server/hooks/agent-duties.ts),
// server/brainstorm.mjs and server/lead-handoff.mjs use the role/tier resolver (server/role-route.mjs resolveRoute).
//
// - Role names ("review", "Implement", "work order"): resolveRoute picks provider (role provider list, capped/over-quota
//   providers skipped), model + effort (tier ladder) and mode. The spawn runs as a profile built from that route.
// - Old profile names + aliases (Workaround until P5f): today's failover walk (provider-failover.mjs
//   resolveProfileWithFailover over the live stored profiles) and the old stakes ladder stay the authority, so they route
//   exactly as before even when the owner edited a profile. resolveRoute runs alongside for the tier/role stamp, the
//   `reason=…legacy-name` metric and a shadow check (legacyShadowMismatch).
// - Roles are built LIVE from the v1 profiles list (profiles-v2.mjs buildRolesFromProfiles). Stored v2 `roles` are NOT
//   preferred until P5d's role editor ships (P5b review M: they go stale when a legacy profile is edited).
import { buildRolesFromProfiles } from "./profiles-v2.mjs";
import { legacyProfileRole } from "./profiles.mjs";
import { QUOTA_FAILOVER_THRESHOLD, isProviderOverQuota } from "./provider-failover.mjs";
import { ROLE_TABLE, lookupRole, resolveRoute, routeProviderFamily } from "./role-route.mjs";
import { loadStakesLadder, loadTierLadder, normalizeStakes, stakesTier } from "./stakes-ladder.mjs";

/** Labels every routed spawn is stamped with (plus `profile` = the role or old profile name, and `wf`). */
export const ROUTE_STAMP_LABELS = Object.freeze(["provider", "model", "tier", "stakes"]);

const ROUTE_FAMILIES = ["claude", "antigravity-cli", "opencode"];

/** Roles built live from a v1 profile list (empty list = the shipped pack). Never the stored v2 block (until P5d). */
export function liveRoles(profiles) {
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
 * The profile a role-name spawn runs as. {profile, route, explicitCapped} | null (hint is not a role).
 * `explicitModel`: the caller's model, only to report `explicit-capped` (its family is capped): for profile spawns the
 * cap wins and the model is dropped when the family changes (P5a review M3, today's agent-duties.ts behaviour).
 */
export function roleSpawnProfile(hint, { stakes, caps = [], roles, ladder, explicitModel } = {}) {
  const table = roles ?? ROLE_TABLE;
  const found = roleNameHit(hint, table);
  if (!found) return null;
  const rungs = ladder ?? loadTierLadder();
  const route = resolveRoute({ role: found.key, stakes, caps, ladder: rungs }, { roles: table });
  if (!route?.provider) return null;
  let explicitCapped = false;
  const exModel = String(explicitModel ?? "").trim();
  if (exModel) {
    const probe = resolveRoute({ role: found.key, stakes, caps, ladder: rungs, explicit: { model: exModel } }, { roles: table });
    explicitCapped = Boolean(probe?.reasons?.includes("explicit-capped"));
  }
  const def = found.role;
  const mode = def.modes?.[route.provider] ?? {};
  const profile = {
    name: roleProfileLabel(found.key, table),
    role: lifecycleRoleOf(found.key),
    roleKey: found.key,
    provider: route.provider,
    ...(route.model ? { model: route.model } : {}),
    ...(route.modeId ? { modeId: route.modeId } : {}),
    ...(route.effort ? { thinkingOptionId: route.effort } : {}),
    ...(mode.featureValues ? { featureValues: { ...mode.featureValues } } : {}),
    notes: typeof mode.prompt === "string" ? mode.prompt : String(def.prompt ?? ""),
    ...(Array.isArray(mode.mcpExtras ?? def.mcpExtras) ? { mcpExtras: [...(mode.mcpExtras ?? def.mcpExtras)] } : {}),
    ...(def.icon !== undefined ? { icon: def.icon } : {}),
    ...(def.color !== undefined ? { color: def.color } : {}),
  };
  return { profile, route, explicitCapped };
}

/**
 * resolveRoute for an old profile name/alias (or null when it is not one): the tier/role stamp + `legacy-name`, and
 * whether a caller model on a capped family was dropped. Never decides the old name's routing (today's walk does).
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
 * `explicit-capped=dropped` when a caller model on a capped family was dropped, and `shadow=<diff>` when resolveRoute's
 * replay of an old name disagrees with today's walk (legacyShadowMismatch).
 */
export function routeMetricText({ stakes, model, effort, reason, legacyName = false, tier, role, explicitCapped = false, shadow = "" }) {
  const r = legacyName ? (reason === "default" ? "legacy-name" : `${reason}+legacy-name`) : reason;
  return (
    `stakes=${normalizeStakes(stakes)} model=${model || "-"} effort=${effort || "-"} reason=${r}` +
    ` tier=${tier || "-"} role=${role || "-"}` +
    (explicitCapped ? " explicit-capped=dropped" : "") +
    (shadow ? ` shadow=${shadow}` : "")
  );
}

/**
 * brainstorm.mjs / lead-handoff.mjs: a respawn whose profile label is a ROLE name (no stored profile of that name)
 * spawns from the role route, threading its model + thinkingOptionId (effort) into the create call, so the hook sees
 * the same values it would pick. null = not a role name (callers keep their profile path).
 */
export function roleSpawnConfig(name, { profiles, stakes, usageList = [] } = {}) {
  const roles = liveRoles(profiles);
  if (!roleNameHit(name, roles)) return null;
  const caps = cappedFamilies(usageList, [], { ignoreDiskCaps: true });
  const hit = roleSpawnProfile(name, { stakes, caps, roles });
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
