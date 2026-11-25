// R2 spawn transparency (PLAN_PER_ROLES_LADDER_1125): every spawn shows `Role · model · reason`, read from the labels the
// spawn hook (server/hooks/agent-duties.ts) stamps from the FINAL route: `vs.model` = the model that actually runs,
// `vs.route` = the route text, ending in ` why=<reason>`. Pure, no node imports: the drawer header (src/DrawerHeader.tsx),
// spawn_worker (server/mcp/tools.mjs) and the hook all share it.

/** The reasons a spawn can show. rung = the role x stakes tier ladder; override = the caller named a provider and/or model
 *  (or a non-routed raw spawn); arm = an R0 implementer alternation pick; failover = a capped/over-quota provider was
 *  skipped; legacy-name = an old profile name (or alias) ran its stored profile (P5f removes these). */
export const SPAWN_REASONS = Object.freeze(["rung", "override", "arm", "failover", "legacy-name"]);

/** The token the hook appends to `vs.route`: ` why=<reason>`. */
export const ROUTE_WHY_KEY = "why";

/**
 * The reason a spawn shows, from the hook's route facts. Precedence: failover (the model differs from what was asked)
 * > override (the caller's pick) > arm > legacy-name > rung.
 * @param {{ hookReason?: string, failover?: boolean, override?: boolean, arm?: boolean, legacyName?: boolean, routed?: boolean }} f
 *   hookReason: the hook's `reason=` (default | ladder | explicit | explicit+ladder | override | override+failover | failover | all-capped);
 *   routed: false when no stored profile or role matched (the caller's own provider/model ran = override).
 */
export function shownSpawnReason({ hookReason = "", failover = false, override = false, arm = false, legacyName = false, routed = true } = {}) {
  const r = String(hookReason ?? "");
  if (failover || /\bfailover\b/.test(r)) return "failover";
  if (override || /^(override|explicit)/.test(r) || !routed) return "override";
  if (arm) return "arm";
  if (legacyName || /legacy-name/.test(r)) return "legacy-name";
  return "rung";
}

/** The `why=` reason in a `vs.route` label, or "" (spawned before R2, or not routed by the hook). */
export function routeWhy(routeText) {
  const m = /(?:^|\s)why=([a-z-]+)(?:\s|$)/.exec(String(routeText ?? ""));
  return m && SPAWN_REASONS.includes(m[1]) ? m[1] : "";
}

/** `Implement · claude-sonnet-5-5 · arm` (parts that are empty drop out). */
export function spawnShownLine({ role, model, reason }) {
  return [role, model, reason].map((s) => String(s ?? "").trim()).filter(Boolean).join(" · ");
}
