// Interruptible work (@per PLAN_PER_QUOTA_FIT_1126 C): the spawns that may still route to a family past its soft quota
// line (under its hard line). The one source for the server (provider-failover.mjs re-exports it) and the New Agent
// badge (src/roleSpawn.ts): pure, no node imports. C fu1 L1: it used to be copied into src/roleSpawn.ts, and both copies
// missed the legacy "Check - Haiku" (normKey gave `check---haiku`).

import { LEGACY_PROFILE_ROLES, legacyProfileRole } from "./legacy-profile-roles.mjs";

/** Kinds (labels.kind) and role keys that are interruptible. */
export const INTERRUPTIBLE_KINDS = Object.freeze(new Set(["docs", "audit", "spike", "pre-check"]));

/** Role-name prefixes that mark interruptible work (old model-named profiles: `Audit - DSF`, `Mechanical - DSF`). */
const INTERRUPTIBLE_PREFIXES = Object.freeze(["pre-check-", "audit-", "mechanical-", "docs-", "spike-"]);

/** `Check - Haiku` -> `check-haiku`: lower case, every run of spaces / underscores / dashes collapsed to one `-`. */
export function normWorkKey(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

/** Old profile names by their normalized key (`check-haiku` -> pre-check), so any spacing/underscore spelling matches. */
const LEGACY_ROLE_BY_KEY = new Map(Object.entries(LEGACY_PROFILE_ROLES).map(([name, role]) => [normWorkKey(name), role]));

/**
 * True when the spawn may run on a family past its soft line: stakes=mechanical, a kind in INTERRUPTIBLE_KINDS, a role
 * key in it, an old profile name whose role is one (via legacy-profile-roles.mjs: Check - Haiku, Scout - Flash and
 * Audit - DSF are Pre-check), or a role name with an interruptible prefix.
 * @param {{ stakes?: string, kind?: string, role?: string }} [w]
 */
export function isInterruptibleWork({ stakes, kind, role } = {}) {
  if (String(stakes ?? "").trim().toLowerCase() === "mechanical") return true;
  const k = normWorkKey(kind);
  if (k && INTERRUPTIBLE_KINDS.has(k)) return true;
  const r = normWorkKey(role);
  if (!r) return false;
  if (INTERRUPTIBLE_KINDS.has(r)) return true;
  const legacyRole = legacyProfileRole(role)?.role ?? LEGACY_ROLE_BY_KEY.get(r);
  if (legacyRole && INTERRUPTIBLE_KINDS.has(legacyRole)) return true;
  return INTERRUPTIBLE_PREFIXES.some((p) => r.startsWith(p));
}
