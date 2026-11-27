// R1 fix round (UI half, docs/PLAN_PER_ROLES_LADDER_1125.md R1): pickers list roles, not model-named profiles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LEGACY_PROFILE_ROLES } from "../server/profiles.mjs";

const src = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");

test("LEGACY_HEAD_ROLE agrees with the server LEGACY_PROFILE_ROLES for the heads it covers", () => {
  const ts = src("profiles.ts");
  const block = ts.slice(ts.indexOf("const LEGACY_HEAD_ROLE"), ts.indexOf("};", ts.indexOf("const LEGACY_HEAD_ROLE")));
  const head = Object.fromEntries([...block.matchAll(/^\s*"?([a-z ]+)"?:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const key = (n) => n.toLowerCase().replace(/\s+/g, "-");
  for (const [name, role] of Object.entries(LEGACY_PROFILE_ROLES)) {
    const h = name.split(/\s+-\s+/)[0].toLowerCase();
    // Spec / Planner / Senior Reasoning: the UI has a Planner role the server map predates; only check the rest.
    if (!(h in head) || h === "spec" || h === "senior reasoning") continue;
    assert.equal(key(head[h]), role, `${h}`);
  }
  assert.equal(head.mechanical, "Work Order");
  assert.equal(head.audit, "Pre-check");
  assert.equal(head["ux reviewer"], "UX Review", "R1 fu: the old UX profile maps onto its own role");
});

test("pickers use role rows and no model-named profile text", () => {
  for (const f of ["TeamActions.tsx", "SettingsHome.tsx"]) {
    const s = src(f);
    assert.ok(s.includes("rolePickRows("), `${f} uses rolePickRows`);
    assert.ok(!s.includes("profileOptionLabel"), `${f} no profileOptionLabel`);
  }
  const ta = src("TeamActions.tsx");
  assert.ok(ta.includes("From ladder (stakes)") && ta.includes('data-testid="model-override"'));
  assert.ok(ta.includes("Reset to {roleName} template"));
  assert.ok(!ta.includes("Reset to {profileName} template"));
  assert.ok(!/BRAINSTORM PROFILE[\s\S]{0,300}\{p\.name\}/.test(ta));
});
