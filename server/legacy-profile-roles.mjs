// Leaf module (imports only the leaf profile-aliases.mjs): the old profile name -> schema-v2 role map and its lookup.
// Moved out of profiles.mjs (which re-exports both) so pure readers, src/roleSpawn.ts via interruptible-work.mjs, can
// use it without node imports (@per PLAN_PER_QUOTA_FIT_1126 C fu1 L1).
import { LEGACY_PROFILE_ALIASES } from "./profile-aliases.mjs";

/**
 * Role-only profiles (docs/PLAN_PROFILES_ROLE_ONLY.md P5b, idea-77): every old profile name -> its schema-v2 role key
 * (server/role-route.mjs ROLE_TABLE). Covers the shipped pack, the user-file-only "Implement - Gemini (trial)" and the
 * chain-only names in ROLE_FAILOVER_CHAINS. The aliases above reach a role through their target name here, so this is
 * the role column of the legacy alias table, not a second alias map. role-route.mjs LEGACY_ROUTES takes its roles from
 * it; resolveRoute tags every hit `reason=legacy-name`. Workaround: removed with the aliases in P5f.
 */
export const LEGACY_PROFILE_ROLES = Object.freeze({
  "Lead - Claude": "lead",
  "Lead - Gemini": "lead",
  "Brainstorm - Claude": "brainstorm",
  "Brainstorm - Gemini": "brainstorm",
  "Implement - Sonnet": "implement",
  "Implement - Opus": "implement",
  "Implement - Gemini (trial)": "implement",
  "Spec - Opus": "planner",
  "Planner - Sonnet": "planner",
  "Senior Reasoning - DSP": "implement",
  "Work Order - DSP": "work-order",
  "Mechanical - DSF": "work-order",
  "Review - Gemini": "review",
  "Review - Sonnet": "review",
  "UX Reviewer - Opus": "review",
  "Pre-check - Flash": "pre-check",
  "Check - Haiku": "pre-check",
  "Audit - DSF": "pre-check",
  "Scout - Flash": "pre-check",
  "Art Director - Gemini": "art-director",
  "Art Painter - Opus": "art-painter",
});

/**
 * Old profile name or alias -> {name, alias, role}: `name` = the canonical old profile name, `alias` = the alias used
 * (null for a direct name). Order: exact name, exact alias (case-sensitive), then the name case-insensitively.
 * role-route.mjs lookupRole tries role keys/names between the alias and the case-insensitive step; no role name equals
 * an old name, so the two agree. Lowercase "lead" is neither an old name nor an alias here (it is the new role); bare
 * "Lead" is the alias for "Lead - Claude". null = not an old name.
 */
export function legacyProfileRole(nameInput) {
  const raw = String(nameInput ?? "").trim();
  if (!raw) return null;
  const hit = (name, alias = null) => ({ name, alias, role: LEGACY_PROFILE_ROLES[name] });
  if (Object.hasOwn(LEGACY_PROFILE_ROLES, raw)) return hit(raw);
  if (Object.hasOwn(LEGACY_PROFILE_ALIASES, raw) && Object.hasOwn(LEGACY_PROFILE_ROLES, LEGACY_PROFILE_ALIASES[raw])) {
    return hit(LEGACY_PROFILE_ALIASES[raw], raw);
  }
  const lower = raw.toLowerCase();
  const name = Object.keys(LEGACY_PROFILE_ROLES).find((n) => n.toLowerCase() === lower);
  return name ? hit(name) : null;
}
