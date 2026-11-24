// Storybook check registry (SB2). Shared by SB2 (structural) and SB3 (text): to add a module, import it and append it to CHECK_MODULES.
// A module exports `checks = [{id:'#1', title, run(ctx) -> Finding[] | Promise<Finding[]>}]`.
// ctx = {snapshot, registry, adapter, hooks, reader|null}. `reader` is optional (pinned-sha Reader): checks that read source files
// (e.g. #8 .gd comments) need it and degrade gracefully without it.
import { makeRegistry, validateFinding } from "../schema.mjs";
import * as structural from "./structural.mjs";

export const CHECK_MODULES = [structural];

const num = (id) => Number(String(id).slice(1));
const refKey = (f) => (f.entityRef ? `${f.entityRef.kind}:${f.entityRef.id}` : "");
const cs = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: host-independent
function cmp(a, b) {
  return num(a.check) - num(b.check) || cs(refKey(a), refKey(b)) || cs(a.source?.path ?? "", b.source?.path ?? "")
    || (a.source?.line ?? 0) - (b.source?.line ?? 0) || cs(a.msg, b.msg);
}

/** Run every registered check. Never throws for a check's failure: that becomes one warn finding. Deterministic order. */
export async function runChecks(snapshot, adapter, { reader = null, modules = CHECK_MODULES } = {}) {
  const registry = makeRegistry(snapshot.entities);
  const ctx = { snapshot, registry, adapter, hooks: adapter.hooks, reader };
  const out = [];
  for (const mod of modules) {
    for (const c of mod.checks) {
      let found;
      try { found = await c.run(ctx); if (found == null) found = []; if (!Array.isArray(found)) throw new Error("run() did not return an array"); } catch (e) {
        out.push({ check: c.id, severity: "warn", entityRef: null, msg: `check ${c.id} (${c.title}) threw: ${String(e?.message ?? e).slice(0, 200)}`, source: null });
        continue;
      }
      for (const f of found) {
        const v = validateFinding(f);
        if (v.ok) out.push(f);
        else out.push({ check: c.id, severity: "warn", entityRef: null, msg: `check ${c.id} produced an invalid finding: ${v.errors.join("; ")}`, source: null });
      }
    }
  }
  return out.sort(cmp);
}
