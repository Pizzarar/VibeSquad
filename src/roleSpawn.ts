// R1 fix UI r2 (PLAN_PER_ROLES_LADDER_1125): what a role row in New Agent / Add Buddy sends. Pure (no React, no store) so
// test/r1-fix-ui-r2-spawn.test.mjs can run the request through the spawn hook in-process.
//   - the ROLE key is the profile (never an old model-named profile): the hook routes it by stakes x tier ladder;
//   - no model unless the spawner picked an override; stakes go in labels.stakes (as spawn_worker does);
//   - an override sends provider (+ model) AND the `vs.route-override` label (same shape spawn_worker stamps).

/** Same shape as routeOverrideLabel in server/route-override.mjs (no .d.ts for it; test/r1-fix-ui-r2-spawn.test.mjs pins parity). */
const routeOverrideLabel = ({ provider, model }: { provider?: string; model?: string }) =>
  [provider && !/\s/.test(provider) ? `provider=${provider}` : "", model && !/\s/.test(model) ? `model=${model}` : ""].filter(Boolean).join(" ");

export const STAKES_CHOICES = ["normal", "tierA-security", "tierA-invariant", "mechanical"] as const;
export type Stakes = (typeof STAKES_CHOICES)[number];

type RoleLike = { name: string; tier: string; providers: string[] };
type LadderLike = Record<string, Partial<Record<string, { model?: string; effort?: string }>>>;
export type Override = { provider: string; model?: string };

/** Tier a role runs at for these stakes (server/stakes-ladder.mjs: tierA-* -> top, mechanical -> cheap, else the role's own). */
export function tierFor(role: RoleLike, stakes: string): string {
  if (stakes === "tierA-security" || stakes === "tierA-invariant") return "top";
  if (stakes === "mechanical") return "cheap";
  return role.tier;
}

/** The provider + model the ladder would pick (the role's first provider x tier for these stakes). */
export function ladderPick(role: RoleLike, ladder: LadderLike | undefined, stakes: string): { provider: string; model: string } {
  const provider = role.providers[0] ?? "claude";
  return { provider, model: ladder?.[provider]?.[tierFor(role, stakes)]?.model ?? "" };
}

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

/** Select value <-> override: "" = from ladder, "<provider>" = that provider's rung, "<provider>|<model>". */
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
  const picked = ladderPick(opts.role, opts.ladder, stakes);
  return { provider: ov?.provider || picked.provider, ...(ov?.model ? { model: ov.model } : {}), profile: opts.roleKey, labels };
}
