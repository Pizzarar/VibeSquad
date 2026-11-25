// P5d (docs/PLAN_PROFILES_ROLE_ONLY.md, idea-77): the Settings role editor + tier ladder editor read and write here.
//   GET  /__vibesquad/roles   -> {ok, source, schemaVersion, roles, ladder, ladderDefaults, tiers, efforts, providers, path}
//   PUT  /__vibesquad/roles   -> body {roles: {<key>: roleDef}}   (replaces just those roles; the rest stay)
//                                body {ladder: {<provider>: {<tier>: {model?, effort?}}}}  (a blank rung = back to default)
// Saving roles first runs the P5b migration (backs up to profiles.json.bak-p5) so the v2 `roles` block is the stored
// truth from then on: live spawns read it (server/spawn-route.mjs liveRoles). The v1 `profiles` list stays in the file for
// old names until P5f, but once migrated a legacy write that would change a role is refused (legacyProfilesConflict, 409)
// so the two never diverge; the Settings legacy editor is read-only then.
// Errors: bad input = 400 with a path-free message; a corrupt file = 500 with a fix-it message (never overwritten); any
// other fault (fs, lock) = the caller's serverError (500, logged, generic). Writes run under a file lock (handler).
import { existsSync, readFileSync } from "node:fs";
import { withFileLock } from "./file-lock.mjs";
import { readCappedProviders } from "./provider-failover.mjs";
import { getProfilesPath, loadProfiles, normalizeProfile, profilesFileBody } from "./profiles.mjs";
import { buildRolesFromProfiles, loadRoles, migrateProfilesFile, normalizeRole, normalizeRoles, roleKeyOf } from "./profiles-v2.mjs";
import { ROLE_TABLE, isHiddenRole } from "./role-route.mjs";
import { DEFAULT_TIER_LADDER, TIERS, cleanRung, loadTierLadder, routeProviderFamily, stakesLadderPath } from "./stakes-ladder.mjs";
import { writeSettingsAtomic } from "./user-settings.mjs";

/** Provider families a role or ladder row may name. Anything else is refused (400). */
export const ROLE_PROVIDERS = Object.freeze(["claude", "antigravity-cli", "opencode"]);
/** Thinking / effort values a role mode or ladder rung may carry (blank = none). */
export const EFFORT_VALUES = Object.freeze(["default", "minimal", "low", "medium", "high", "xhigh", "max"]);

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.hasOwn(o, k);
const ROLE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasownproperty", "tostring", "valueof"]);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const bad = (message) => httpError(400, message);

function readJson(path) {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Known family for a provider id ("gemini" -> antigravity-cli), "" when it is not one we route to. */
function knownFamily(raw) {
  const fam = routeProviderFamily(raw);
  return ROLE_PROVIDERS.includes(fam) ? fam : "";
}

function checkEffort(value, where) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw bad(`${where}: effort must be text`);
  const v = value.trim();
  if (v && !EFFORT_VALUES.includes(v)) throw bad(`${where}: unknown effort "${v}" (${EFFORT_VALUES.join(", ")}, or blank)`);
}

/** R2: provider families a spawn would skip right now (capped); [] when the cap files are unreadable. */
function cappedFamilies() {
  try {
    return Object.keys(readCappedProviders({ useDiskCaps: true }) ?? {});
  } catch {
    return [];
  }
}

export function getRolesState({ profilesPath, ladderPath } = {}) {
  const loaded = loadRoles(profilesPath);
  return {
    ok: true,
    source: loaded.source,
    schemaVersion: loaded.schemaVersion,
    roles: loaded.roles,
    hiddenRoles: Object.keys(loaded.roles).filter((k) => isHiddenRole(k, loaded.roles)),
    ladder: loadTierLadder(ladderPath),
    ladderDefaults: JSON.parse(JSON.stringify(DEFAULT_TIER_LADDER)),
    tiers: [...TIERS],
    efforts: [...EFFORT_VALUES],
    providers: [...ROLE_PROVIDERS],
    capped: cappedFamilies(),
    path: getProfilesPath(profilesPath),
  };
}

/**
 * Validate one role from a PUT before normalizing, so a bad field is a 400 and never silently falls back to the shipped
 * value. `fallback` = the shipped/stored role (null for a new one, which must name its name, tier and providers).
 */
function validateRole(label, raw, fallback) {
  if (!isObj(raw)) throw bad(`Role "${label}" must be an object`);
  if (own(raw, "name") ? typeof raw.name !== "string" || !raw.name.trim() : !fallback) throw bad(`Role "${label}" needs a name`);
  if (own(raw, "tier") ? !TIERS.includes(raw.tier) : !fallback) {
    throw bad(`Role "${label}": unknown tier "${raw.tier ?? ""}" (${TIERS.join(", ")})`);
  }
  if (own(raw, "providers") || !fallback) {
    if (!Array.isArray(raw.providers) || !raw.providers.length) throw bad(`Role "${label}" needs at least one provider`);
    for (const p of raw.providers) {
      if (!knownFamily(p)) throw bad(`Role "${label}": unknown provider "${p}" (${ROLE_PROVIDERS.join(", ")})`);
    }
  }
  if (own(raw, "modes")) {
    if (!isObj(raw.modes)) throw bad(`Role "${label}": modes must be an object`);
    for (const [prov, mode] of Object.entries(raw.modes)) {
      if (!knownFamily(prov)) throw bad(`Role "${label}": unknown provider "${prov}" in modes`);
      if (!isObj(mode)) throw bad(`Role "${label}": mode for ${prov} must be an object`);
      checkEffort(mode.effort, `Role "${label}" ${prov}`);
    }
  }
}

/** Replace the named roles in profiles.json (migrating v1 -> v2 first). Returns the clean roles block. Unlocked: callers lock. */
export function saveRoles(patch, profilesPath) {
  if (!isObj(patch) || !Object.keys(patch).length) throw bad("Expected { roles: { <role>: {...} } }");
  const path = getProfilesPath(profilesPath);
  // Validate every role before the migration writes anything (a refused save leaves the file as it was).
  const current = loadRoles(path).roles;
  for (const [rawKey, raw] of Object.entries(patch)) {
    const key = roleKeyOf(rawKey);
    if (!ROLE_KEY_RE.test(key) || RESERVED_KEYS.has(key)) throw bad(`Role key "${rawKey}" is not allowed (a-z, 0-9 and -)`);
    validateRole(rawKey, raw, Object.hasOwn(current, key) ? current[key] : Object.hasOwn(ROLE_TABLE, key) ? ROLE_TABLE[key] : null);
  }
  if (!existsSync(path)) loadProfiles(path, { autoSeed: true });
  const mig = migrateProfilesFile(path);
  if (!mig.ok) {
    console.warn(`[vibesquad] profiles.json migration failed: ${mig.error}`);
    throw httpError(500, /invalid JSON|newer than/.test(String(mig.error)) ? `refusing to save: profiles.json ${mig.error}. Fix or restore it first.` : "profiles.json migration failed; see the server log");
  }
  const parsed = readJson(path);
  const next = normalizeRoles(parsed.roles, { profiles: parsed.profiles });
  for (const [rawKey, raw] of Object.entries(patch)) {
    const key = roleKeyOf(rawKey);
    if (!ROLE_KEY_RE.test(key) || RESERVED_KEYS.has(key)) throw bad(`Role key "${rawKey}" is not allowed (a-z, 0-9 and -)`);
    const stored = Object.hasOwn(next, key) ? next[key] : null;
    const shipped = Object.hasOwn(ROLE_TABLE, key) ? ROLE_TABLE[key] : null;
    validateRole(rawKey, raw, stored ?? shipped);
    // A PUT is a merge over the stored role: omitted fields (prompt, mcpExtras, modes...) keep their stored value, so a
    // partial API call never wipes a custom prompt. Send mcpExtras: [] / prompt: "" to clear them.
    const role = normalizeRole(stored ? { ...stored, ...raw } : raw, shipped ?? stored);
    if (!role) throw bad(`Role "${rawKey}" needs a name, a tier and at least one provider`);
    next[key] = role;
  }
  writeSettingsAtomic(path, profilesFileBody({ ...parsed, schemaVersion: 2, roles: next }, parsed.profiles));
  return next;
}

/** Existing stakes-ladder.json body, or {} when missing. A corrupt/non-object file is refused, never overwritten. */
function readLadderForSave(ladderPath) {
  if (!existsSync(ladderPath)) return {};
  let raw;
  try {
    raw = readJson(ladderPath);
  } catch (e) {
    if (e instanceof SyntaxError) throw httpError(500, "refusing to save: stakes-ladder.json is not valid JSON. Fix or remove it first.");
    throw e; // fs fault: the handler logs it and answers generically
  }
  if (!isObj(raw)) throw httpError(500, "refusing to save: stakes-ladder.json is not a JSON object. Fix or remove it first.");
  return raw;
}

/** Validate a ladder patch (400 on any bad field) and return [family, tier, cleanRung] steps. Reads/writes nothing. */
export function planLadderPatch(patch) {
  if (!isObj(patch) || !Object.keys(patch).length) throw bad("Expected { ladder: { <provider>: { <tier>: {model, effort} } } }");
  const plan = [];
  for (const [prov, rungs] of Object.entries(patch)) {
    const fam = knownFamily(prov);
    if (!fam) throw bad(`Unknown provider "${prov}" (${ROLE_PROVIDERS.join(", ")})`);
    if (!isObj(rungs)) throw bad(`Ladder row "${prov}" must be an object`);
    for (const [tier, rung] of Object.entries(rungs)) {
      if (!TIERS.includes(tier)) throw bad(`Unknown tier "${tier}" (${TIERS.join(", ")})`);
      if (rung !== null && !isObj(rung)) throw bad(`Ladder ${prov} ${tier} must be an object`);
      if (isObj(rung) && rung.model !== undefined && typeof rung.model !== "string") throw bad(`Ladder ${prov} ${tier}: model must be text`);
      if (isObj(rung) && /fable/i.test(String(rung.model ?? ""))) throw bad("Fable models are picked per spawn only, not as a ladder rung");
      checkEffort(isObj(rung) ? rung.effort : undefined, `Ladder ${prov} ${tier}`);
      plan.push([fam, tier, cleanRung(rung)]);
    }
  }
  return plan;
}

/** Merge ladder rungs into stakes-ladder.json. A blank rung deletes that tier override. Returns the effective ladder. */
export function saveLadder(patch, ladderPath = stakesLadderPath()) {
  const plan = planLadderPatch(patch);
  const raw = readLadderForSave(ladderPath);
  const hadWrapper = isObj(raw.ladder);
  const src = hadWrapper ? raw.ladder : raw;
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = isObj(v) ? { ...v } : v;
  for (const [fam, tier, clean] of plan) {
    const target = (out[fam] = isObj(out[fam]) ? out[fam] : {});
    if (clean && Object.keys(clean).length) target[tier] = clean;
    else delete target[tier];
    if (!Object.keys(target).length) delete out[fam];
  }
  writeSettingsAtomic(ladderPath, hadWrapper ? { ...raw, ladder: out } : { ladder: out });
  return loadTierLadder(ladderPath);
}

/**
 * After migration (stored v2 roles) a legacy profiles write must not change what a role is built from: returns the role
 * names it would change ([] = fine, also always [] on a v1 file). Compares buildRolesFromProfiles of the current and the
 * next list, so only role-mapped fields of old-name profiles count (custom profiles and model-only edits pass).
 */
export function legacyProfilesConflict(nextProfiles, profilesPath) {
  if (loadRoles(profilesPath).source !== "v2") return [];
  const norm = (list) => (Array.isArray(list) ? list.map((p) => normalizeProfile(p)).filter(Boolean) : []);
  const before = buildRolesFromProfiles(norm(loadProfiles(profilesPath, { autoSeed: false }).profiles)).roles;
  const after = buildRolesFromProfiles(norm(nextProfiles)).roles;
  return Object.keys(before)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => before[k]?.name ?? k);
}

/** Throws a 409 when legacyProfilesConflict finds a change. Pass as saveProfiles/seedDefaultPack `beforeWrite`. */
export function assertLegacyProfilesWritable(nextProfiles, profilesPath) {
  const changed = legacyProfilesConflict(nextProfiles, profilesPath);
  if (changed.length) {
    throw httpError(
      409,
      `Legacy profiles are read-only now that roles are saved: this change would alter ${changed.join(", ")}. Edit Roles and Tier Ladder instead.`,
    );
  }
}

/**
 * @param {{sendJson: Function, readBody: Function, serverError?: (res: any, e: any) => any, profilesPath?: string, ladderPath?: string}} opts
 */
export async function handleRolesApi(req, res, { sendJson, readBody, serverError, profilesPath, ladderPath } = {}) {
  try {
    if (req.method === "GET") return sendJson(res, 200, getRolesState({ profilesPath, ladderPath }));
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req);
      if (!isObj(body) || (!isObj(body.roles) && !isObj(body.ladder))) {
        return sendJson(res, 400, { ok: false, error: "Expected { roles } and/or { ladder }" });
      }
      // Validate the ladder before writing roles, so a { roles, ladder } PUT with a bad ladder writes nothing.
      if (isObj(body.ladder)) planLadderPatch(body.ladder);
      if (isObj(body.roles)) await withFileLock(getProfilesPath(profilesPath), () => saveRoles(body.roles, profilesPath));
      if (isObj(body.ladder)) {
        const lp = ladderPath ?? stakesLadderPath();
        await withFileLock(lp, () => saveLadder(body.ladder, lp));
      }
      return sendJson(res, 200, getRolesState({ profilesPath, ladderPath }));
    }
    res.statusCode = 405;
    return res.end();
  } catch (e) {
    const st = Number(e?.status);
    if (st >= 400 && st < 600) return sendJson(res, st, { ok: false, error: String(e.message) });
    if (e instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "Body is not valid JSON" });
    if (serverError) return serverError(res, e);
    console.warn(`[vibesquad] roles failed: ${e?.message ?? e}`);
    return sendJson(res, 500, { ok: false, error: "roles save failed; see the server log" });
  }
}
