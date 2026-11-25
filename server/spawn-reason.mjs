// R2 spawn transparency (PLAN_PER_ROLES_LADDER_1125): every spawn shows `Role · model · reason`, read from the labels the
// spawn hook (server/hooks/agent-duties.ts) stamps from the FINAL route: `vs.model` = the model that actually runs,
// `vs.route` = the route text, ending in ` why=<reason>`. Pure, no node imports: the drawer header (src/DrawerHeader.tsx),
// spawn_worker (server/mcp/tools.mjs) and the hook all share it.

/** The reason values, by name, so the UI (badge, chip) and the server use the same words. */
export const SPAWN_REASON = Object.freeze({
  LADDER: "ladder",
  OVERRIDE: "override",
  ARM: "arm",
  FAILOVER: "failover",
  LEGACY_NAME: "legacy-name",
  ALL_CAPPED: "all-capped",
});

/** The reasons a spawn can show. ladder = the role x stakes tier ladder; override = the caller named a provider and/or model
 *  (or a non-routed raw spawn); arm = an R0 implementer alternation pick; failover = a capped/over-quota provider was
 *  skipped; legacy-name = an old profile name (or alias) ran its stored profile (P5f removes these); all-capped = every
 *  provider on the route was capped, so the first one runs anyway. */
export const SPAWN_REASONS = Object.freeze([
  SPAWN_REASON.LADDER,
  SPAWN_REASON.OVERRIDE,
  SPAWN_REASON.ARM,
  SPAWN_REASON.FAILOVER,
  SPAWN_REASON.LEGACY_NAME,
  SPAWN_REASON.ALL_CAPPED,
]);

/** Old `why=` values still on live agents' labels, read as today's word (R2 r1: `rung` became `ladder`). */
export const LEGACY_SPAWN_REASONS = Object.freeze({ rung: SPAWN_REASON.LADDER });

/** The token the hook appends to `vs.route`: ` why=<reason>`. */
export const ROUTE_WHY_KEY = "why";

/**
 * The reason a spawn shows, from the hook's route facts. Precedence: failover (the model differs from what was asked)
 * > override (the caller's pick) > all-capped > arm > legacy-name > ladder.
 * @param {{ hookReason?: string, failover?: boolean, override?: boolean, allCapped?: boolean, arm?: boolean, legacyName?: boolean, routed?: boolean }} f
 *   hookReason: the hook's `reason=` (default | ladder | explicit | explicit+ladder | override | override+failover | failover | all-capped);
 *   routed: false when no stored profile or role matched (the caller's own provider/model ran = override).
 */
export function shownSpawnReason({ hookReason = "", failover = false, override = false, allCapped = false, arm = false, legacyName = false, routed = true } = {}) {
  const r = String(hookReason ?? "");
  if (failover || /\bfailover\b/.test(r)) return SPAWN_REASON.FAILOVER;
  if (override || /^(override|explicit)/.test(r) || !routed) return SPAWN_REASON.OVERRIDE;
  if (allCapped || /(?:^|\+)all-capped\b/.test(r)) return SPAWN_REASON.ALL_CAPPED;
  if (arm) return SPAWN_REASON.ARM;
  if (legacyName || /legacy-name/.test(r)) return SPAWN_REASON.LEGACY_NAME;
  return SPAWN_REASON.LADDER;
}

/** The `why=` reason in a `vs.route` label, or "" (spawned before R2, or not routed by the hook). Old words map to today's. */
export function routeWhy(routeText) {
  const m = /(?:^|\s)why=([a-z-]+)(?:\s|$)/.exec(String(routeText ?? ""));
  if (!m) return "";
  const v = Object.hasOwn(LEGACY_SPAWN_REASONS, m[1]) ? LEGACY_SPAWN_REASONS[m[1]] : m[1];
  return SPAWN_REASONS.includes(v) ? v : "";
}

/** `Implement · claude-sonnet-5-5 · arm` (parts that are empty drop out). */
export function spawnShownLine({ role, model, reason }) {
  return [role, model, reason].map((s) => String(s ?? "").trim()).filter(Boolean).join(" · ");
}
