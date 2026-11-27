// profiles.json schema v2 (docs/PLAN_PROFILES_ROLE_ONLY.md P5b, idea-77): a profile describes a ROLE, the model comes
// from the tier ladder (server/role-route.mjs resolveRoute). v2 = the v1 file + `schemaVersion: 2` + a `roles` block:
//
//   roles[<role key>] = {
//     name, tier ("top"|"mid"|"cheap"), providers: [family, ...]   // preference order walked on cap/quota
//     prompt, mcpExtras?, icon?, color?, brief?                     // from the role's own profile on its first provider
//     modes: { [family]: { modeId, effort?, featureValues?, prompt?, mcpExtras?, from? } }
//   }
//
// `modes[p].prompt` / `.mcpExtras` are only set when that provider's own same-role profile differs from the role's
// (e.g. "Lead - Gemini" notes vs "Lead - Claude"); `from` names the v1 profile a mode was copied from. The v1
// `profiles` list stays in the file untouched: old names keep resolving through it until P5f, and v1 readers
// (loadProfiles, providers-catalog, agent-duties) only read `profiles`.
//
// This module is pure except migrateProfilesFile() / loadRoles(), which take an explicit path (tests use temp dirs).
// Spawn routing (server/spawn-route.mjs liveRoles) reads the stored `roles` once the file is v2 (P5d: the Settings role
// editor's first save migrates it) and builds them live from the v1 profiles before that.
//
// `modes[p].effort: null` = explicitly cleared (provider default); an omitted effort takes the ROLE_TABLE fallback.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_PACK_PROFILES,
  LEGACY_PROFILE_ALIASES,
  PROFILES_SCHEMA_VERSION,
  getProfilesPath,
  hashNote,
  isKnownDefaultNote,
  legacyProfileRole,
  profilesFileBody,
} from "./profiles.mjs";
import { ROLE_TABLE, routeProviderFamily } from "./role-route.mjs";
import { TIERS } from "./stakes-ladder.mjs";
import { writeSettingsAtomic } from "./user-settings.mjs";

export const PROFILES_BACKUP_SUFFIX = ".bak-p5";

/**
 * role -> provider -> v1 profile names to copy that provider's mode from, first found wins (user file, then the shipped
 * pack). The same profiles ROLE_TABLE's modes were taken from, i.e. where today's failover lands for that role.
 */
export const ROLE_MODE_SOURCES = deepFreeze({
  lead: { claude: ["Lead - Claude"], "antigravity-cli": ["Lead - Gemini"], opencode: ["Senior Reasoning - DSP"] },
  brainstorm: {
    claude: ["Brainstorm - Claude"],
    "antigravity-cli": ["Brainstorm - Gemini"],
    opencode: ["Senior Reasoning - DSP"],
  },
  planner: { claude: ["Planner - Sonnet"], "antigravity-cli": ["Lead - Gemini"], opencode: ["Senior Reasoning - DSP"] },
  implement: {
    claude: ["Implement - Sonnet"],
    "antigravity-cli": ["Implement - Gemini (trial)", "Lead - Gemini"],
    opencode: ["Work Order - DSP"],
  },
  "work-order": { opencode: ["Work Order - DSP"], claude: ["Implement - Sonnet"], "antigravity-cli": ["Lead - Gemini"] },
  review: { "antigravity-cli": ["Review - Gemini"], claude: ["Review - Sonnet"], opencode: ["Work Order - DSP"] },
  // R1 fu: no Gemini UX profile ships, so the Gemini mode comes from ROLE_TABLE and the prompt is the role's (the UX brief).
  "ux-review": { claude: ["UX Reviewer - Opus"], "antigravity-cli": [] },
  "pre-check": { "antigravity-cli": ["Pre-check - Flash"], claude: ["Check - Haiku"], opencode: ["Audit - DSF"] },
  "art-director": {
    "antigravity-cli": ["Art Director - Gemini"],
    claude: ["Art Painter - Opus"],
    opencode: ["Work Order - DSP"],
  },
  "art-painter": {
    claude: ["Art Painter - Opus"],
    "antigravity-cli": ["Art Director - Gemini"],
    opencode: ["Work Order - DSP"],
  },
});

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function cleanExtras(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  return out;
}

export function roleKeyOf(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Stored tools of a source profile; a profile saved before mcpExtras existed falls back to the shipped one. */
function sourceExtras(src) {
  if (Array.isArray(src.p.mcpExtras)) return cleanExtras(src.p.mcpExtras);
  return cleanExtras(DEFAULT_PACK_PROFILES.find((d) => d.name === src.from)?.mcpExtras ?? []);
}

/** A v1 profile by old name: exact, a stored profile still under an old alias, then case-insensitive. */
function findV1(list, name) {
  const lower = name.toLowerCase();
  return (
    list.find((p) => p?.name === name) ??
    list.find((p) => LEGACY_PROFILE_ALIASES[p?.name] === name) ??
    list.find((p) => String(p?.name ?? "").toLowerCase() === lower) ??
    null
  );
}

/**
 * v1 profile list -> v2 roles (one per ROLE_TABLE key). Stored values win; the shipped pack fills a missing source
 * profile; ROLE_TABLE fills the rest. Pure. Returns {roles, sources: {role: {provider: "user"|"pack"|"table"}}}.
 */
export function buildRolesFromProfiles(profilesInput) {
  const user = Array.isArray(profilesInput) ? profilesInput.filter(isObj) : [];
  const pick = (names) => {
    for (const n of names) {
      const u = findV1(user, n);
      if (u) return { p: u, from: n, where: "user" };
    }
    for (const n of names) {
      const d = DEFAULT_PACK_PROFILES.find((x) => x.name === n);
      if (d) return { p: d, from: n, where: "pack" };
    }
    return null;
  };
  const roles = {};
  const sources = {};
  for (const [key, def] of Object.entries(ROLE_TABLE)) {
    sources[key] = {};
    const modes = {};
    let primary = null;
    const own = {}; // provider -> same-role source (its prompt/tools may differ per provider)
    for (const fam of def.providers) {
      const src = pick(ROLE_MODE_SOURCES[key]?.[fam] ?? []);
      const fallback = def.modes[fam] ?? {};
      if (!src || routeProviderFamily(src.p.provider) !== fam) {
        modes[fam] = { modeId: fallback.modeId, ...(fallback.effort ? { effort: fallback.effort } : {}) };
        sources[key][fam] = "table";
        continue;
      }
      const m = { modeId: str(src.p.modeId) ?? fallback.modeId };
      const effort = str(src.p.thinkingOptionId) ?? fallback.effort;
      if (effort) m.effort = effort;
      if (isObj(src.p.featureValues)) m.featureValues = clone(src.p.featureValues);
      m.from = src.from;
      modes[fam] = m;
      sources[key][fam] = src.where;
      if (legacyProfileRole(src.from)?.role === key) {
        own[fam] = src;
        primary ??= src;
      }
    }
    const prompt = primary ? String(primary.p.notes ?? "") : "";
    const extras = primary ? sourceExtras(primary) : [];
    for (const [fam, src] of Object.entries(own)) {
      if (src === primary) continue;
      const notes = String(src.p.notes ?? "");
      if (notes !== prompt) modes[fam].prompt = notes;
      const ex = sourceExtras(src);
      if (JSON.stringify(ex) !== JSON.stringify(extras)) modes[fam].mcpExtras = [...ex];
    }
    roles[key] = normalizeRole(
      {
        name: def.name,
        tier: def.tier,
        providers: [...def.providers],
        prompt,
        ...(extras.length ? { mcpExtras: [...extras] } : {}),
        ...(primary?.p.icon !== undefined ? { icon: primary.p.icon } : {}),
        ...(primary?.p.color !== undefined ? { color: primary.p.color } : {}),
        ...(primary?.p.brief !== undefined ? { brief: primary.p.brief } : {}),
        modes,
      },
      def,
    );
  }
  return { roles, sources };
}

/**
 * One stored role -> its clean v2 shape, field by field over `fallback` (the ROLE_TABLE entry, or null for a
 * user-added role). null = unusable (no tier/providers and no fallback). Key order is fixed so writes are stable.
 */
export function normalizeRole(raw, fallback = null) {
  const r = isObj(raw) ? raw : {};
  const fb = fallback ?? {};
  const name = str(r.name) ?? fb.name;
  const tier = TIERS.includes(r.tier) ? r.tier : fb.tier;
  let providers = Array.isArray(r.providers)
    ? [...new Set(r.providers.map((p) => routeProviderFamily(p)).filter(Boolean))]
    : [];
  if (!providers.length) providers = fb.providers ? [...fb.providers] : [];
  if (!name || !tier || !providers.length) return null;
  const out = { name, tier, providers, prompt: typeof r.prompt === "string" ? r.prompt : "" };
  const extras = cleanExtras(r.mcpExtras);
  if (extras?.length) out.mcpExtras = extras;
  for (const k of ["icon", "color", "brief"]) if (typeof r[k] === "string") out[k] = r[k];
  const rawModes = isObj(r.modes) ? r.modes : {};
  const modes = {};
  for (const [k, v] of Object.entries(rawModes)) {
    const fam = routeProviderFamily(k);
    if (!fam || !isObj(v)) continue;
    modes[fam] = normalizeMode(v, fb.modes?.[fam]);
  }
  for (const fam of providers) {
    if (!modes[fam]?.modeId) modes[fam] = normalizeMode(modes[fam] ?? {}, fb.modes?.[fam]);
  }
  out.modes = Object.fromEntries(Object.entries(modes).filter(([, m]) => m.modeId));
  return out;
}

function normalizeMode(v, fb) {
  const m = {};
  const modeId = str(v.modeId) ?? fb?.modeId;
  if (modeId) m.modeId = modeId;
  // Omitted = the fallback's effort; present but blank/null = explicitly cleared (kept as null so it survives a reload).
  const effort = Object.hasOwn(v, "effort") ? (str(v.effort) ?? null) : fb?.effort;
  if (effort) m.effort = effort;
  else if (effort === null) m.effort = null;
  if (isObj(v.featureValues)) m.featureValues = clone(v.featureValues);
  if (typeof v.prompt === "string") m.prompt = v.prompt;
  const extras = cleanExtras(v.mcpExtras);
  if (extras) m.mcpExtras = extras;
  if (str(v.from)) m.from = str(v.from);
  return m;
}

let shippedPrompts = null;
let currentNoteHashes = null;
/**
 * The prompts the current shipped pack gives each ROLE_TABLE role: {[role]: {prompt?, modes: {[family]: text}}}.
 * `prompt` only when the role has a primary same-role pack profile; `modes[fam]` only for a provider fed by a same-role
 * pack profile (its own note, or the role prompt when they match). Cross-role hops (e.g. lead -> Senior Reasoning) have
 * no per-provider default, so their prompts are never upgraded.
 */
function shippedRolePrompts() {
  if (shippedPrompts) return shippedPrompts;
  const out = {};
  for (const [key, r] of Object.entries(buildRolesFromProfiles([]).roles)) {
    const modes = {};
    for (const [fam, m] of Object.entries(r.modes)) {
      if (m.from && legacyProfileRole(m.from)?.role === key) modes[fam] = typeof m.prompt === "string" ? m.prompt : r.prompt;
    }
    out[key] = { ...(r.prompt ? { prompt: r.prompt } : {}), modes };
  }
  return (shippedPrompts = deepFreeze(out));
}

/** hashNote of every note the current pack ships (any profile, any role). */
function currentShippedNoteHashes() {
  return (currentNoteHashes ??= new Set(DEFAULT_PACK_PROFILES.map((p) => hashNote(p.notes))));
}

/**
 * v2 prompt upgrade (@per R1 follow-up): a shipped role's stored prompt (role-level or per-provider) that is still
 * exactly a previously shipped default note (hash in server/profile-note-history.json, the same history the v1
 * upgradeStaleDefaultNotes uses) becomes the current shipped default. A user-edited prompt never hashes to a shipped
 * note, so it is kept byte-for-byte; a value already current is left alone (idempotent). The history is one flat list
 * with no role attached, so text equal to ANY current shipped note (e.g. Lead's prompt pasted into Planner, or one
 * prompt for both providers) is a deliberate choice and kept; only retired text is upgraded. Mutates `role`.
 */
export function upgradeStaleRolePrompts(key, role) {
  const ship = Object.hasOwn(ROLE_TABLE, key) ? shippedRolePrompts()[key] : null;
  if (!ship || !role) return role;
  const stale = (text, current) =>
    typeof current === "string" &&
    current &&
    typeof text === "string" &&
    text !== current &&
    isKnownDefaultNote(text) &&
    !currentShippedNoteHashes().has(hashNote(text));
  if (stale(role.prompt, ship.prompt)) role.prompt = ship.prompt;
  // A mode with no own prompt is not upgraded (it inherits role.prompt) even if a newer pack gives that provider its own note.
  for (const [fam, m] of Object.entries(role.modes ?? {})) {
    if (stale(m.prompt, ship.modes[fam])) m.prompt = ship.modes[fam];
  }
  return role;
}

/**
 * Stored roles block -> clean roles: every ROLE_TABLE role present (defaults for a missing one), stored fields win,
 * user-added roles kept when valid. Pure. `profiles` (the same file's v1 list): a shipped role the stored block lacks
 * (one added after the file was migrated, e.g. planner in R1) is built from them like the migration would, so it gets
 * its old profile's prompt/tools instead of an empty prompt. Prompts still equal to an older shipped default are
 * upgraded (upgradeStaleRolePrompts); load-time only, the next role save writes the upgraded text.
 */
export function normalizeRoles(rawRoles, { profiles } = {}) {
  const src = isObj(rawRoles) ? rawRoles : {};
  const byKey = {};
  for (const [k, v] of Object.entries(src)) {
    const key = roleKeyOf(k);
    if (key && !byKey[key]) byKey[key] = v;
  }
  const out = {};
  let built = null;
  for (const [key, def] of Object.entries(ROLE_TABLE)) {
    let fill = byKey[key];
    if (fill === undefined && Array.isArray(profiles)) fill = (built ??= buildRolesFromProfiles(profiles).roles)[key];
    out[key] = upgradeStaleRolePrompts(key, normalizeRole(fill, def) ?? normalizeRole({}, def));
  }
  for (const [key, v] of Object.entries(byKey)) {
    if (out[key]) continue;
    const r = normalizeRole(v, null);
    if (r) out[key] = r;
  }
  return out;
}

/** Schema version of a parsed profiles.json body: an array root or no `schemaVersion` = 1. */
export function profilesSchemaVersion(data) {
  if (Array.isArray(data) || !isObj(data)) return 1;
  const v = Number(data.schemaVersion);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * Parsed v1 body -> v2 body. Pure; never touches the profiles list (same array values, same order). A v2 body is
 * returned as-is (changed=false): idempotent. A newer schema than this code knows is refused.
 * @returns {{ok: boolean, changed: boolean, data?: object, error?: string, fromVersion: number,
 *            unmapped: string[], sources?: object}}
 *   unmapped = stored profiles that are not an old name (custom profiles): they stay in `profiles`, no role is made.
 */
/** A `roles` block with at least one role (an empty object is no roles). */
function hasRoles(roles) {
  return isObj(roles) && Object.keys(roles).length > 0;
}

export function migrateProfilesData(data) {
  const fromVersion = profilesSchemaVersion(data);
  if (fromVersion > PROFILES_SCHEMA_VERSION) {
    return { ok: false, changed: false, fromVersion, unmapped: [], error: `schemaVersion ${fromVersion} is newer than ${PROFILES_SCHEMA_VERSION}` };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : null;
  if (!list) {
    return { ok: false, changed: false, fromVersion, unmapped: [], error: "no profiles list" };
  }
  const unmapped = list.filter((p) => isObj(p) && !legacyProfileRole(p.name)).map((p) => String(p.name ?? ""));
  // A v2 body without a usable `roles` object (hand-edited, a save that dropped it, or an empty `{}`) is rebuilt, not
  // trusted as-is. A build is never empty (every role falls back to the shipped pack), so this stays idempotent.
  if (fromVersion === PROFILES_SCHEMA_VERSION && hasRoles(data?.roles)) {
    return { ok: true, changed: false, fromVersion, unmapped, data };
  }
  const { roles, sources } = buildRolesFromProfiles(list);
  const block = Array.isArray(data) ? {} : { ...data };
  const out = profilesFileBody({ ...block, schemaVersion: PROFILES_SCHEMA_VERSION, roles }, list);
  // Top-level keys profilesFileBody does not know (none today) are kept; a later profiles save drops them, as in v1.
  for (const [k, v] of Object.entries(block)) if (!(k in out)) out[k] = v;
  return { ok: true, changed: true, fromVersion, unmapped, sources, data: out };
}

/**
 * Migrate a profiles.json file in place. Reads the raw bytes itself (no BOM scrub side effect), backs the original up
 * to `<file>.bak-p5` (an existing different backup is kept and the new one goes to `.bak-p5.1`, `.2`, ...), writes
 * with node (utf8, no BOM, atomic rename) and reads it back. Already v2 = no write, no backup.
 * @param {string} [filePath] default getProfilesPath() (VIBESQUAD_PROFILES_PATH / VIBESQUAD_HOME / ~/.vibesquad)
 * @param {{dryRun?: boolean}} [opts]
 */
export function migrateProfilesFile(filePath, { dryRun = false } = {}) {
  const path = getProfilesPath(filePath);
  if (!existsSync(path)) return { ok: true, changed: false, path, reason: "missing" };
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    return { ok: false, changed: false, path, error: `${err?.code || "read error"}: could not read ${path}` };
  }
  const text = raw.toString("utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  let parsed;
  try {
    parsed = JSON.parse(hadBom ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, changed: false, path, error: `invalid JSON: ${err.message}` };
  }
  const res = migrateProfilesData(parsed);
  if (!res.ok) return { ...res, path, data: undefined };
  if (!res.changed) return { ok: true, changed: false, path, reason: "already-v2", hadBom, unmapped: res.unmapped };
  const roleCount = Object.keys(res.data.roles).length;
  const summary = { ok: true, changed: true, path, hadBom, fromVersion: res.fromVersion, roleCount, unmapped: res.unmapped, sources: res.sources };
  if (dryRun) return { ...summary, dryRun: true, backupPath: null };
  const backupPath = pickBackupPath(path, raw);
  if (backupPath && !existsSync(backupPath)) copyFileSync(path, backupPath);
  let back;
  let check;
  try {
    writeSettingsAtomic(path, res.data);
    back = readFileSync(path, "utf8");
    check = JSON.parse(back);
  } catch (err) {
    return { ...summary, ok: false, backupPath, error: `${err?.code || "write error"}: ${err?.message ?? err}; restore from the backup` };
  }
  if (back.charCodeAt(0) === 0xfeff || profilesSchemaVersion(check) !== PROFILES_SCHEMA_VERSION || !hasRoles(check.roles) || check.profiles?.length !== res.data.profiles.length) {
    return { ...summary, ok: false, backupPath, error: "read-back check failed; restore from the backup" };
  }
  return { ...summary, backupPath, bytes: Buffer.byteLength(back) };
}

function pickBackupPath(path, originalBytes) {
  const base = `${path}${PROFILES_BACKUP_SUFFIX}`;
  for (let i = 0; i < 1000; i++) {
    const cand = i === 0 ? base : `${base}.${i}`;
    if (!existsSync(cand)) return cand;
    if (readFileSync(cand).equals(originalBytes)) return cand; // same original already backed up
  }
  throw new Error(`too many ${PROFILES_BACKUP_SUFFIX} backups next to ${path}`);
}

/**
 * Roles for resolveRoute(…, {roles}) from a profiles.json path: v2 = the stored roles normalized over ROLE_TABLE;
 * v1 = built in memory from its profiles (what the migration would store) with the same load-time prompt upgrade as v2
 * (the migration itself stores the v1 notes as-is); missing/unreadable = ROLE_TABLE.
 * Read-only: never writes, never scrubs a BOM. Returns {schemaVersion, roles, source: "v2"|"v1"|"default"}.
 */
export function loadRoles(filePath) {
  const path = getProfilesPath(filePath);
  let parsed = null;
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
  } catch {
    parsed = null;
  }
  const version = parsed ? profilesSchemaVersion(parsed) : 0;
  if (version >= PROFILES_SCHEMA_VERSION && hasRoles(parsed.roles)) {
    return { schemaVersion: version, roles: normalizeRoles(parsed.roles, { profiles: parsed.profiles }), source: "v2" };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.profiles) ? parsed.profiles : null;
  if (list?.length) {
    const roles = buildRolesFromProfiles(list).roles;
    for (const [key, role] of Object.entries(roles)) upgradeStaleRolePrompts(key, role);
    return { schemaVersion: 1, roles, source: "v1" };
  }
  return { schemaVersion: version || 0, roles: normalizeRoles({}), source: "default" };
}
