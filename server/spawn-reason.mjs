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
  SOFT: "soft",
  LEGACY_NAME: "legacy-name",
  ALL_CAPPED: "all-capped",
});

/** The reasons a spawn can show. ladder = the role x stakes tier ladder; override = the caller named a provider and/or model
 *  (or a non-routed raw spawn); arm = an R0 implementer alternation pick; failover = a capped/over-quota provider was
 *  skipped; soft = a family past its soft quota line (@per PLAN_PER_QUOTA_FIT_1126 C) was skipped because this work is
 *  not interruptible; legacy-name = an old profile name (or alias) ran its stored profile (P5f removes these); all-capped = every
 *  provider on the route was capped, so the first one runs anyway. */
export const SPAWN_REASONS = Object.freeze([
  SPAWN_REASON.LADDER,
  SPAWN_REASON.OVERRIDE,
  SPAWN_REASON.ARM,
  SPAWN_REASON.FAILOVER,
  SPAWN_REASON.SOFT,
  SPAWN_REASON.LEGACY_NAME,
  SPAWN_REASON.ALL_CAPPED,
]);

/** Old `why=` values still on live agents' labels, read as today's word (R2 r1: `rung` became `ladder`). */
export const LEGACY_SPAWN_REASONS = Object.freeze({ rung: SPAWN_REASON.LADDER });

/** The token the hook appends to `vs.route`: ` why=<reason>`. */
export const ROUTE_WHY_KEY = "why";

/**
 * The reason a spawn shows, from the hook's route facts. Precedence: soft (a family was skipped for its soft quota line,
 * C fu1 L3) > failover (the model differs from what was asked) > override (the caller's pick) > all-capped > arm > legacy-name > ladder.
 * @param {{ hookReason?: string, soft?: boolean, failover?: boolean, override?: boolean, allCapped?: boolean, arm?: boolean, legacyName?: boolean, routed?: boolean }} f
 *   hookReason: the hook's `reason=` (default | ladder | explicit | explicit+ladder | override | override+failover | failover | all-capped);
 *   routed: false when no stored profile or role matched (the caller's own provider/model ran = override).
 */
export function shownSpawnReason({ hookReason = "", soft = false, failover = false, override = false, allCapped = false, arm = false, legacyName = false, routed = true } = {}) {
  const r = String(hookReason ?? "");
  if (soft) return SPAWN_REASON.SOFT;
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

/** The soft-line text in a `vs.route` label (routeMetricText ` soft="pool 78% >= soft 70: interruptible only -> claude"`), or "". */
export function routeSoftReason(routeText) {
  const m = /(?:^|\s)soft="([^"]*)"/.exec(String(routeText ?? ""));
  return m ? m[1] : "";
}

/** Provider id -> the one name the UI uses for it (also src/roleSpawn.ts PROVIDER_NAME). */
export const PROVIDER_DISPLAY_NAME = { claude: "Claude", "agy-claude": "Claude (AGY)", "antigravity-cli": "Gemini", opencode: "OpenCode" };
const displayName = (id) => PROVIDER_DISPLAY_NAME[id] ?? id;
/** The pool a soft skip came from when the text does not name it: the family the route landed on tells which one it left. */
const SKIPPED_FOR_TARGET = { "antigravity-cli": "claude", claude: "agy-claude", "agy-claude": "claude" };

/**
 * C fu2 UX m1: ONE formatter for the soft reason in UI text (drawer tooltip, New Agent badge tooltip, spawn_worker result).
 * "pool 78% >= soft 70: interruptible only -> antigravity-cli" -> "Claude pool at 78%, soft line 70%". The raw `>=` / `->`
 * tail stays in the server strings (machine detail); `family` names the skipped pool when the caller knows it.
 * @param {string} raw @param {{ family?: string }} [opts]
 */
export function formatSoftReason(raw, { family = "" } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const tail = /\s*->\s*(\S+)\s*$/.exec(s);
  const body = tail ? s.slice(0, tail.index) : s;
  const fam = family || (tail ? SKIPPED_FOR_TARGET[tail[1]] ?? "" : "");
  const m = /pool (\d+(?:\.\d+)?)% >= soft (\d+(?:\.\d+)?)/.exec(body);
  if (m) return `${fam ? `${displayName(fam)} pool` : "Pool"} at ${m[1]}%, soft line ${m[2]}%`;
  const noRow = /^no quota row for ([^:]+)/.exec(body);
  if (noRow) return `No quota row for ${noRow[1].split("+").map(displayName).join(" + ")}`;
  return fam ? `${displayName(fam)} pool past its soft line` : "Pool past its soft line";
}

/** `Implement · claude-sonnet-5-5 · arm` (parts that are empty drop out). */
export function spawnShownLine({ role, model, reason }) {
  return [role, model, reason].map((s) => String(s ?? "").trim()).filter(Boolean).join(" · ");
}
