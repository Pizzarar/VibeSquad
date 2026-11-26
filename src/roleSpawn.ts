// R1 fix UI r2 (PLAN_PER_ROLES_LADDER_1125): what a role row in New Agent / Add Buddy sends. Pure (no React, no store) so
// test/r1-fix-ui-r2-spawn.test.mjs can run the request through the spawn hook in-process.
//   - the ROLE key is the profile (never an old model-named profile): the hook routes it by stakes x tier ladder;
//   - no model unless the spawner picked an override; stakes go in labels.stakes (as spawn_worker does);
//   - an override sends provider (+ model) AND the `vs.route-override` label (same shape spawn_worker stamps).

import { LEGACY_SPAWN_REASONS, SPAWN_REASON, routeSoftReason, routeWhy } from "../server/spawn-reason.mjs";
import { INTERRUPTIBLE_KINDS, isInterruptibleWork } from "../server/interruptible-work.mjs";

/** Same shape as routeOverrideLabel in server/route-override.mjs (no .d.ts for it; test/r1-fix-ui-r2-spawn.test.mjs pins parity). */
const routeOverrideLabel = ({ provider, model }: { provider?: string; model?: string }) =>
  [provider && !/\s/.test(provider) ? `provider=${provider}` : "", model && !/\s/.test(model) ? `model=${model}` : ""].filter(Boolean).join(" ");

/** R2: the reason a drawer role chip shows: the hook's vs.route why=; "override" once the live model no longer matches
 *  vs.model (a switch since spawn); "" while a switch is staged (the chip already shows the staged model). */
export function drawerSpawnWhy(labels: Record<string, string>, liveModel: string | null | undefined, staged: boolean): string {
  if (staged) return "";
  const spawned = labels["vs.model"];
  if (spawned && liveModel && liveModel !== spawned) return "override";
  return routeWhy(labels["vs.route"]);
}

/** C fu1 L3: the soft-line text the hook put on `vs.route` (` soft="..."`), "" when the route skipped no soft family. */
export function drawerSoftReason(labels: Record<string, string>): string {
  return routeSoftReason(labels["vs.route"]);
}

/** One word per reason in the UI: the server's SPAWN_REASONS words (server/spawn-reason.mjs); an old label value still on a
 *  live agent reads as today's word (LEGACY_SPAWN_REASONS). */
export const spawnReasonLabel = (reason: string) => (Object.hasOwn(LEGACY_SPAWN_REASONS, reason) ? LEGACY_SPAWN_REASONS[reason] : reason);

/** Plain-words gloss per reason (tooltip). test/r2-ui-badge.test.mjs pins that every SPAWN_REASONS member has one. */
export const SPAWN_REASON_GLOSS: Record<string, string> = {
  [SPAWN_REASON.LADDER]: "Ladder: picked by this role and its stakes.",
  [SPAWN_REASON.ARM]: "Arm: an alternating Sonnet/Gemini trial picked this model.",
  [SPAWN_REASON.OVERRIDE]: "Override: you or the caller picked the provider or model.",
  [SPAWN_REASON.FAILOVER]: "Failover: the preferred provider was capped, so a fallback ran instead.",
  [SPAWN_REASON.SOFT]: "Soft line: the preferred pool is past its soft quota line, so only interruptible work runs there and this ran on the next pool with room.",
  [SPAWN_REASON.LEGACY_NAME]: "Legacy name: an old profile name ran its stored profile.",
  [SPAWN_REASON.ALL_CAPPED]: "All capped: every provider was capped, so it started on the first and waits or fails over.",
};

/** Chip tooltip: plain words only (never the raw route text). */
export function spawnChipTitle(opts: { role?: string; model?: string; reason: string; staged?: boolean; provider?: string; softReason?: string }): string {
  const head = [opts.role, opts.model].filter(Boolean).join(" · ");
  if (opts.staged) return `${head} (staged switch: applies on your next message)`;
  const reason = spawnReasonLabel(opts.reason);
  const gloss = reason ? (SPAWN_REASON_GLOSS[reason] ?? "") : "";
  const on = (reason === SPAWN_REASON.FAILOVER || reason === SPAWN_REASON.SOFT) && opts.provider ? ` Runs on ${opts.provider}.` : "";
  // C fu1 L3: the soft line's own words (e.g. "pool 78% >= soft 70: interruptible only -> antigravity-cli").
  const soft = reason === SPAWN_REASON.SOFT && opts.softReason ? ` (${opts.softReason})` : "";
  return [head, gloss + on + soft].filter(Boolean).join(". ").replace(/\.\./g, ".").trim();
}

/** Provider id -> the name the role editor shows. */
export const PROVIDER_NAME: Record<string, string> = { claude: "Claude", "agy-claude": "Claude (AGY)", "antigravity-cli": "Gemini", opencode: "OpenCode" };
export const providerName = (id: string) => PROVIDER_NAME[id] ?? id;

const AGY_CLAUDE_FAMILY = "agy-claude";
const AGY_CLAUDE_EXCLUDED_ROLES = new Set(["lead", "brainstorm"]);

/** C fu1 L1: the server's own isInterruptibleWork (server/interruptible-work.mjs, pure), no longer a hand copy: one
 *  definition, so legacy names (Check - Haiku, Scout - Flash, Audit - DSF) count the same on the badge and the route. */
export { INTERRUPTIBLE_KINDS };
export const isInterruptibleRole = isInterruptibleWork;

export const STAKES_CHOICES = ["normal", "tierA-security", "tierA-invariant", "mechanical"] as const;
export type Stakes = (typeof STAKES_CHOICES)[number];

type RoleLike = { key?: string; name: string; tier: string; providers: string[] };
type LadderLike = Record<string, Partial<Record<string, { model?: string; effort?: string }>>>;
export type Override = { provider: string; model?: string };

/** Tier a role runs at for these stakes (server/stakes-ladder.mjs: tierA-* -> top, mechanical -> cheap, else the role's own). */
// Parity with server stakesTier pinned by test/walk-mapping-parity.test.mjs.
export function tierFor(role: RoleLike, stakes: string): string {
  if (stakes === "tierA-security" || stakes === "tierA-invariant") return "top";
  if (stakes === "mechanical") return "cheap";
  return role.tier;
}

/** Mirror of server/provider-failover.mjs TIER_PROVIDER_CHAINS (A2 idea-986; test/r1-fix-ui-r2-spawn.test.mjs pins parity):
 *  stakes that force a tier with its own walk order re-order the role's providers (mechanical -> cheap: Gemini Flash,
 *  Claude Haiku, opencode last). Families the chain does not name keep their place after it. */
export const TIER_PROVIDER_ORDER: Readonly<Record<string, readonly string[]>> = { cheap: ["antigravity-cli", "claude", "opencode"] };

/** The role's providers in the order the hook walks them for these stakes (server/role-route.mjs resolveRoute). */
export function walkOrder(role: RoleLike, stakes: string): string[] {
  const forced = stakes === "mechanical" ? "cheap" : stakes === "tierA-security" || stakes === "tierA-invariant" ? "top" : null;
  const chain = forced ? TIER_PROVIDER_ORDER[forced] : undefined;
  if (!chain) return [...role.providers];
  const rank = (p: string) => (chain.includes(p) ? chain.indexOf(p) : chain.length);
  return [...role.providers].sort((a, b) => rank(a) - rank(b));
}

/** Effective walk order (R10): worker roles try agy-claude just before direct claude when the ladder has a rung for this tier. */
export function effectiveWalkOrder(role: RoleLike, ladder: LadderLike | undefined, stakes: string, roleKey?: string): string[] {
  const order = walkOrder(role, stakes);
  const tier = tierFor(role, stakes);
  const ci = order.indexOf("claude");
  const key = (roleKey ?? role.key ?? "").trim().toLowerCase();
  if (
    !AGY_CLAUDE_EXCLUDED_ROLES.has(key) &&
    ci >= 0 &&
    !order.includes(AGY_CLAUDE_FAMILY) &&
    ladder?.[AGY_CLAUDE_FAMILY]?.[tier]?.model
  ) {
    order.splice(ci, 0, AGY_CLAUDE_FAMILY);
  }
  return order;
}

/** The provider + model the ladder would pick (the first provider of the stakes' walk order x tier for these stakes). */
export function ladderPick(role: RoleLike, ladder: LadderLike | undefined, stakes: string, roleKey?: string): { provider: string; model: string } {
  const provider = effectiveWalkOrder(role, ladder, stakes, roleKey)[0] ?? "claude";
  return { provider, model: ladder?.[provider]?.[tierFor(role, stakes)]?.model ?? "" };
}

/** R2: where a role row will actually land, the way the hook does (server/spawn-route.mjs roleSpawnProfile): an override
 *  provider that is capped hops along the role's walk order (walkOrder, A2) to the first uncapped provider, and so does a
 *  plain ladder pick. Only CAPPED providers are skipped (agent-duties.ts: the hook never skips a not-installed one).
 *  All providers capped = it stays on the override provider (or the first of the walk order, falling back from agy-claude
 *  to direct claude when claude is in the walk, mirroring server/role-route.mjs) and `allCapped` is set: the hook starts
 *  it there and waits/fails over, Spawn is never blocked. `via` is the badge text. */
function normalizeSoftCapped(softCapped?: readonly string[] | Record<string, string | boolean>): Map<string, string> {
  const out = new Map<string, string>();
  if (!softCapped) return out;
  if (Array.isArray(softCapped)) {
    for (const p of softCapped) if (p) out.set(p, "");
    return out;
  }
  for (const [k, v] of Object.entries(softCapped)) {
    if (!v) continue;
    out.set(k, typeof v === "string" ? v : "");
  }
  return out;
}

export function landingPick(
  role: RoleLike,
  ladder: LadderLike | undefined,
  stakes: string,
  opts: { capped?: readonly string[]; softCapped?: readonly string[] | Record<string, string | boolean>; unknown?: readonly string[]; kind?: string; override?: Override | null; roleKey?: string } = {},
): { provider: string; model: string; via: string; allCapped: boolean } {
  const ov = opts.override ?? null;
  const capped = opts.capped ?? [];
  const tier = tierFor(role, stakes);
  const modelOf = (provider: string) => ladder?.[provider]?.[tier]?.model ?? "";
  if (ov && !capped.includes(ov.provider)) {
    return { provider: ov.provider, model: ov.model ?? modelOf(ov.provider), via: ov.model ? "override" : "override (provider, ladder model)", allCapped: false };
  }
  const providers = effectiveWalkOrder(role, ladder, stakes, opts.roleKey);
  const interruptible = isInterruptibleRole({ stakes, kind: opts.kind, role: opts.roleKey ?? role.key ?? role.name });
  const softMap = interruptible ? new Map<string, string>() : normalizeSoftCapped(opts.softCapped);

  // Pass 1: prefer a family under both hard and soft lines (soft line skipped for interruptible work). C fu1 L4, as
  // server/role-route.mjs resolveRoute: while a family on the walk is past soft, known-under-soft ranks before no-row.
  const unknownSet = interruptible ? new Set<string>() : new Set(opts.unknown ?? []);
  const walk = providers.filter((p) => !(ov && p === ov.provider));
  const free = walk.filter((p) => !capped.includes(p) && !softMap.has(p));
  const softInPlay = walk.some((p) => !capped.includes(p) && softMap.has(p));
  const pick = softInPlay ? (free.find((p) => !unknownSet.has(p)) ?? free[0]) : free[0];
  if (pick) {
    const skipped = ov ? [`${providerName(ov.provider)} capped`] : [];
    let soft = false;
    for (const provider of walk) {
      if (provider === pick) break;
      if (capped.includes(provider)) skipped.push(`${providerName(provider)} capped`);
      else if (softMap.has(provider)) {
        soft = true;
        const msg = softMap.get(provider);
        skipped.push(msg ? `${providerName(provider)} ${msg}` : `${providerName(provider)} past soft line`);
      } else if (unknownSet.has(provider)) {
        soft = true;
        skipped.push(`${providerName(provider)} no quota row`);
      }
    }
    // The hook keeps the caller's model only when it belongs to the hop target's family; this badge has no family table, so it shows the ladder model.
    const via = skipped.length ? `${soft ? "soft" : "failover"} (${skipped.join(", ")} → ${providerName(pick)})` : "ladder";
    return { provider: pick, model: modelOf(pick), via, allCapped: false };
  }

  // Pass 2: every family is past soft (or hard). Fall back to the first family under the hard line.
  if (softMap.size > 0) {
    const hardSkipped = ov ? [`${providerName(ov.provider)} capped`] : [];
    for (const provider of providers) {
      if (ov && provider === ov.provider) continue;
      if (capped.includes(provider)) {
        hardSkipped.push(`${providerName(provider)} capped`);
        continue;
      }
      return { provider, model: modelOf(provider), via: hardSkipped.length ? `failover (${hardSkipped.join(", ")} → ${providerName(provider)})` : "ladder", allCapped: false };
    }
  }

  // R10 fu2/fu3: mirror server/role-route.mjs all-capped fallback — when every family is capped and agy-claude is first,
  // fall back to direct claude when it is in the walk instead of agy-claude.
  const allCappedFallback = providers[0] === AGY_CLAUDE_FAMILY && providers.includes("claude") ? "claude" : (providers[0] ?? "claude");
  const stay = ov?.provider ?? allCappedFallback;
  const skipped = [...(ov ? [`${providerName(ov.provider)} capped`] : []), ...walk.filter((p) => capped.includes(p)).map((p) => `${providerName(p)} capped`)];
  return { provider: stay, model: ov?.model ?? modelOf(stay), via: `all capped (${skipped.join(", ")})`, allCapped: true };
}

/** The caps a New Agent / Add Buddy badge walks: GET /__vibesquad/roles `capped`, `softCapped`, `quotaUnknown` (C fu1 L2). */
export type QuotaCaps = { capped?: readonly string[]; softCapped?: Record<string, string | boolean>; quotaUnknown?: readonly string[] };

/** C fu1 L2: where a role row lands, fed from the roles GET's capped + soft-capped + no-row families (server/roles-api.mjs
 *  quotaRouteState, the spawn hook's list), so the badge names the provider the server routes to at the soft line too. */
export function roleLandingPick(roleKey: string, role: RoleLike, ladder: LadderLike | undefined, stakes: string, override: Override | null, quota: QuotaCaps = {}, kind?: string) {
  return landingPick(role, ladder, stakes, { capped: quota.capped ?? [], softCapped: quota.softCapped, unknown: quota.quotaUnknown, kind, override, roleKey });
}

/** What an all-capped landing will do, in plain words (shown under the badges; Spawn stays enabled). */
export const allCappedNote = (provider: string) => `All providers capped: will start on ${providerName(provider)} and wait or fail over.`;

/** Override choices grouped by provider: the role's provider list, each with its ladder models (top > mid > cheap). */
export function overrideGroups(role: RoleLike, ladder: LadderLike | undefined): Array<{ provider: string; models: string[] }> {
  return role.providers.map((provider) => {
    const models: string[] = [];
    for (const t of ["top", "mid", "cheap"]) {
      const m = ladder?.[provider]?.[t]?.model;
      if (m && !models.includes(m)) models.push(m);
    }
    return { provider, models };
  });
}

/** Select value <-> override: "" = from ladder, "<provider>" = that provider's ladder model, "<provider>|<model>". */
export const overrideValue = (o: Override | null) => (o ? (o.model ? `${o.provider}|${o.model}` : o.provider) : "");
export function parseOverrideValue(v: string): Override | null {
  if (!v) return null;
  const [provider, model] = v.split("|");
  return model ? { provider: provider!, model } : { provider: provider! };
}

export type RoleSpawn = { provider: string; model?: string; profile: string; labels: Record<string, string> };

/** Request fields for a role-row spawn. `roleKey` is the role key ("implement", "pre-check", "lead"): lowercase on purpose,
 *  capitalised "Lead"/"Brainstorm" are old-profile aliases in the hook. */
export function buildRoleSpawn(opts: { roleKey: string; role: RoleLike; ladder?: LadderLike; stakes?: string; override?: Override | null }): RoleSpawn {
  const stakes = opts.stakes || "normal";
  const labels: Record<string, string> = { stakes };
  const ov = opts.override ?? null;
  if (ov) {
    const v = routeOverrideLabel({ provider: ov.provider, model: ov.model });
    if (v) labels["vs.route-override"] = v;
  }
  const picked = ladderPick(opts.role, opts.ladder, stakes, opts.roleKey);
  const runnerProvider = picked.provider === AGY_CLAUDE_FAMILY ? "antigravity-cli" : picked.provider;
  return { provider: ov?.provider || runnerProvider, ...(ov?.model ? { model: ov.model } : {}), profile: opts.roleKey, labels };
}
