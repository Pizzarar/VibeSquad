// H1 (PLAN_PER_ROLES_LADDER_1125 R1 fix, idea-974): the label that carries a caller's own provider/model on a role-name
// spawn from spawn_worker (server/mcp/tools.mjs) to the spawn hook (server/hooks/agent-duties.ts). Kept light: tools.mjs
// loads it eagerly and must stay instant on `initialize` / `tools/list`. Routing itself: spawn-route.mjs roleSpawnProfile.
// The only import is the provider-family helper (stakes-ladder.mjs, itself light: no profiles load).
import { routeProviderFamily } from "./stakes-ladder.mjs";
import { AGY_CLAUDE_FAMILY, isAgyClaudeModel } from "./model-ids.mjs";

/**
 * Label spawn_worker stamps on a role-name spawn whose caller passed its own provider and/or model (H1, idea-974):
 * `provider=<p> model=<m>` (either part optional). The spawn hook routes the role with those values as `explicit`
 * instead of throwing them away. spawn_worker strips a caller-supplied one and writes its own; the app's New Agent
 * create path sets it (with the env twin below) for a role spawn with a picked provider/model. Dropped on an upstream
 * respawn (agent-duties.ts RESPAWN_DROPPED_LABELS): that one moves to the alternate provider on purpose.
 */
export const ROUTE_OVERRIDE_LABEL = "vs.route-override";

/**
 * Env twin of ROUTE_OVERRIDE_LABEL (same value). Paseo hands before("agent.create") only {config, env}, never the
 * spawn's labels (src/spawn-env.ts), so every spawn path that sets the label sets this too, as VS_PROFILE / VS_STAKES
 * carry profile + stakes. The hook reads the label first, then this.
 */
export const ROUTE_OVERRIDE_ENV = "VS_ROUTE_OVERRIDE";

const LADDER_FAMILIES = new Set(["claude", "antigravity-cli", "opencode", AGY_CLAUDE_FAMILY]);

/**
 * R1 fix r2 (rn-a5cd265243b5 L1): is `model` another provider family's model, so `provider` can't run it? True when the
 * model names a ladder family (claude-*, gemini-*, deepseek*) that is not the provider's: provider=claude +
 * model=gemini-4-neon, provider=opencode + model=claude-opus-5-5. opencode's own `vendor/model` ids
 * (anthropic/claude-…) stay its own. Unknown ids (no family) are never foreign. Mirrors the hook's caller-model rule.
 */
export function isForeignModel(provider, model) {
  const m = String(model ?? "").trim();
  const prov = routeProviderFamily(provider);
  // R10: agy runs Claude (agy-claude family): a claude-opus/sonnet id on antigravity-cli or agy-claude is its own.
  if ((prov === "antigravity-cli" || prov === AGY_CLAUDE_FAMILY) && isAgyClaudeModel(m)) return false;
  const fam = routeProviderFamily(m);
  if (!m || !prov || !LADDER_FAMILIES.has(fam) || fam === prov) return false;
  return !(prov === "opencode" && m.includes("/"));
}

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
