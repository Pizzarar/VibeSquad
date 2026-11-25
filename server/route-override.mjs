// H1 (PLAN_PER_ROLES_LADDER_1125 R1 fix, idea-974): the label that carries a caller's own provider/model on a role-name
// spawn from spawn_worker (server/mcp/tools.mjs) to the spawn hook (server/hooks/agent-duties.ts). No imports: tools.mjs
// loads it eagerly and must stay instant on `initialize` / `tools/list`. Routing itself: spawn-route.mjs roleSpawnProfile.

/**
 * Label spawn_worker stamps on a role-name spawn whose caller passed its own provider and/or model (H1, idea-974):
 * `provider=<p> model=<m>` (either part optional). The spawn hook routes the role with those values as `explicit`
 * instead of throwing them away. Written only by spawn_worker (a caller-supplied one is stripped there); kept on an
 * upstream respawn, so the replacement keeps the caller's choice.
 */
export const ROUTE_OVERRIDE_LABEL = "vs.route-override";

/** `{provider, model}` -> the ROUTE_OVERRIDE_LABEL value ("" when neither is given). Values never hold spaces. */
export function routeOverrideLabel({ provider, model } = {}) {
  const p = String(provider ?? "").trim();
  const m = String(model ?? "").trim();
  return [p && !/\s/.test(p) ? `provider=${p}` : "", m && !/\s/.test(m) ? `model=${m}` : ""].filter(Boolean).join(" ");
}

/** ROUTE_OVERRIDE_LABEL value -> `{provider, model}` (blank parts ""), or null when it names neither. */
export function parseRouteOverride(raw) {
  const out = { provider: "", model: "" };
  for (const part of String(raw ?? "").trim().split(/\s+/)) {
    const m = /^(provider|model)=(\S+)$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out.provider || out.model ? out : null;
}
