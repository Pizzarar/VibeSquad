// P5d (docs/PLAN_PROFILES_ROLE_ONLY.md, idea-77): the Settings role editor + tier ladder editor read and write here.
//   GET  /__vibesquad/roles   -> {ok, source, schemaVersion, roles, ladder, ladderDefaults, tiers, path}
//   PUT  /__vibesquad/roles   -> body {roles: {<key>: roleDef}}   (replaces just those roles; the rest stay)
//                                body {ladder: {<provider>: {<tier>: {model?, effort?}}}}  (a blank rung = back to default)
// Saving roles first runs the P5b migration (backs up to profiles.json.bak-p5) so the v2 `roles` block is the stored
// truth from then on; the v1 `profiles` list is never touched (legacy profile editing keeps working until P5f).
import { existsSync, readFileSync } from "node:fs";
import { getProfilesPath, loadProfiles, profilesFileBody } from "./profiles.mjs";
import { loadRoles, migrateProfilesFile, normalizeRole, normalizeRoles, roleKeyOf } from "./profiles-v2.mjs";
import { ROLE_TABLE } from "./role-route.mjs";
import { DEFAULT_TIER_LADDER, TIERS, cleanRung, loadTierLadder, routeProviderFamily, stakesLadderPath } from "./stakes-ladder.mjs";
import { writeSettingsAtomic } from "./user-settings.mjs";

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function readJson(path) {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function getRolesState({ profilesPath, ladderPath } = {}) {
  const loaded = loadRoles(profilesPath);
  return {
    ok: true,
    source: loaded.source,
    schemaVersion: loaded.schemaVersion,
    roles: loaded.roles,
    ladder: loadTierLadder(ladderPath),
    ladderDefaults: JSON.parse(JSON.stringify(DEFAULT_TIER_LADDER)),
    tiers: [...TIERS],
    path: getProfilesPath(profilesPath),
  };
}

/** Replace the named roles in profiles.json (migrating v1 -> v2 first). Returns the clean roles block. */
export function saveRoles(patch, profilesPath) {
  if (!isObj(patch) || !Object.keys(patch).length) throw new Error("Expected { roles: { <role>: {...} } }");
  const path = getProfilesPath(profilesPath);
  if (!existsSync(path)) loadProfiles(path, { autoSeed: true });
  const mig = migrateProfilesFile(path);
  if (!mig.ok) throw new Error(mig.error || "profiles migration failed");
  const parsed = readJson(path);
  const next = normalizeRoles(parsed.roles);
  for (const [rawKey, raw] of Object.entries(patch)) {
    const key = roleKeyOf(rawKey);
    if (!key) throw new Error("Role key is empty");
    const role = normalizeRole(raw, ROLE_TABLE[key] ?? next[key] ?? null);
    if (!role) throw new Error(`Role "${rawKey}" needs a name, a tier and at least one provider`);
    next[key] = role;
  }
  writeSettingsAtomic(path, profilesFileBody({ ...parsed, schemaVersion: 2, roles: next }, parsed.profiles));
  return next;
}

/** Merge ladder rungs into stakes-ladder.json. A blank rung deletes that tier override. Returns the effective ladder. */
export function saveLadder(patch, ladderPath = stakesLadderPath()) {
  if (!isObj(patch)) throw new Error("Expected { ladder: { <provider>: { <tier>: {model, effort} } } }");
  let raw = {};
  if (existsSync(ladderPath)) {
    try {
      raw = readJson(ladderPath);
    } catch {
      raw = {};
    }
  }
  const hadWrapper = isObj(raw) && isObj(raw.ladder);
  const src = hadWrapper ? raw.ladder : isObj(raw) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = isObj(v) ? { ...v } : v;
  for (const [prov, rungs] of Object.entries(patch)) {
    const fam = routeProviderFamily(prov);
    if (!fam || !isObj(rungs)) throw new Error(`Unknown provider "${prov}"`);
    const target = (out[fam] = isObj(out[fam]) ? out[fam] : {});
    for (const [tier, rung] of Object.entries(rungs)) {
      if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
      if (isObj(rung) && /fable/i.test(String(rung.model ?? ""))) throw new Error("Fable is explicit-only, not a ladder rung");
      const clean = cleanRung(rung);
      if (clean && Object.keys(clean).length) target[tier] = clean;
      else delete target[tier];
    }
    if (!Object.keys(target).length) delete out[fam];
  }
  writeSettingsAtomic(ladderPath, { ...(hadWrapper ? raw : {}), ladder: out });
  return loadTierLadder(ladderPath);
}

export async function handleRolesApi(req, res, { sendJson, readBody, profilesPath, ladderPath } = {}) {
  try {
    if (req.method === "GET") return sendJson(res, 200, getRolesState({ profilesPath, ladderPath }));
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req);
      if (!isObj(body) || (!isObj(body.roles) && !isObj(body.ladder))) {
        return sendJson(res, 400, { ok: false, error: "Expected { roles } and/or { ladder }" });
      }
      if (isObj(body.roles)) saveRoles(body.roles, profilesPath);
      if (isObj(body.ladder)) saveLadder(body.ladder, ladderPath);
      return sendJson(res, 200, getRolesState({ profilesPath, ladderPath }));
    }
    res.statusCode = 405;
    return res.end();
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}
