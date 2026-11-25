// R1 (docs/PLAN_PER_ROLES_LADDER_1125.md): `vs profiles` lists roles + the tier ladder; old model-named profiles are
// hidden aliases behind one count line (--aliases lists them). --role/--name/--json keep today's profile shape.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, "cli", "vs.mjs");

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "vs-profiles-r1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilesPath = join(dir, "profiles.json");
  const legacy = ["Lead - Claude", "Lead - Gemini", "Implement - Sonnet", "Planner - Sonnet"].map((n) => DEFAULT_PACK_PROFILES.find((p) => p.name === n));
  const custom = { id: "c1", name: "My Custom", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", notes: "mine" };
  writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles: [...legacy, custom] }), "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_|VIBESQUAD_)/.test(k)));
  const run = (args) =>
    spawnSync(process.execPath, [CLI, "profiles", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...env, VIBESQUAD_HOME: dir, PASEO_HOME: join(dir, "paseo"), VIBESQUAD_PROFILES_PATH: profilesPath, VIBESQUAD_PORT: "1" },
    });
  return { run };
}

test("vs profiles (no flags): roles + ladder, custom profiles, old names hidden behind one count line", (t) => {
  const { run } = setup(t);
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Roles \(spawn with profile=<label>; stakes picks the model/m);
  assert.match(r.stdout, /^Planner · label=Planner · tier=mid · providers=claude>antigravity-cli>opencode$/m);
  assert.match(r.stdout, /^Implement · label=Implement · tier=mid/m);
  assert.doesNotMatch(r.stdout, /Work Order/, "hidden role is not listed");
  assert.match(r.stdout, /^Tier ladder/m);
  assert.match(r.stdout, /^Other profiles \(spawn by exact name;.*\):\n(?:.*\[built-in\]\n)*My Custom · c1 · claude\/claude-sonnet-5-5 · mode=auto\n/m);
  assert.match(r.stdout, /^\d+ legacy aliases hidden \(--aliases\)$/m);
  for (const n of ["Lead - Claude", "Implement - Sonnet", "Planner - Sonnet"]) assert.equal(r.stdout.includes(n), false, n);
});

test("vs profiles --aliases lists the old names with their role; --roles text hides work-order, --json keeps it flagged", (t) => {
  const { run } = setup(t);
  const a = run(["--aliases"]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^Aliases \(old profile names, routed as today until R5\):$/m);
  assert.match(a.stdout, /^Planner - Sonnet · .* · alias of planner$/m);
  assert.match(a.stdout, /^Lead - Gemini · .* · alias of lead$/m);
  assert.match(a.stdout, /^My Custom · c1 · /m);
  assert.doesNotMatch(a.stdout, /legacy aliases hidden/);

  const roles = run(["--roles"]);
  assert.equal(roles.status, 0);
  assert.doesNotMatch(roles.stdout, /Work Order/);
  const j = JSON.parse(run(["--roles", "--json"]).stdout);
  assert.deepEqual(j.roles.find((x) => x.key === "work-order")?.hidden, true);
  assert.equal(j.roles.find((x) => x.key === "planner")?.hidden, undefined);
});

test("vs profiles --role / --name / --json keep today's profile rows (lead handoff relies on --role lead)", (t) => {
  const { run } = setup(t);
  const lead = run(["--role", "lead"]);
  assert.equal(lead.status, 0);
  assert.deepEqual(
    lead.stdout.trim().split("\n").map((l) => l.split(" · ")[0]),
    ["Lead - Claude", "Lead - Gemini"],
  );
  const named = run(["--name", "planner"]);
  assert.match(named.stdout, /^Planner - Sonnet · /m);
  const js = JSON.parse(run(["--json"]).stdout);
  const stored = ["Lead - Claude", "Lead - Gemini", "Implement - Sonnet", "Planner - Sonnet", "My Custom"];
  assert.deepEqual(js.map((p) => p.name).slice(0, 5), stored, "stored profiles first, then the server built-ins (idea-732)");
  assert.ok(js.length > stored.length);
  assert.equal(js.find((p) => p.name === "Planner - Sonnet").aliasOf, "planner");
});

test("vs profiles lists server built-ins missing from a stored profiles.json, marked [built-in] (idea-732)", (t) => {
  const { run } = setup(t);
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^UX Reviewer - Opus · .* \[built-in\]$/m);
  assert.doesNotMatch(r.stdout, /^My Custom .*\[built-in\]/m, "custom profiles are not marked");
  assert.match(r.stdout, /^Implement · label=Implement/m, "role names still listed as routing labels");
  const j = JSON.parse(run(["--name", "UX Reviewer", "--json"]).stdout);
  assert.ok(j.some((p) => p.name === "UX Reviewer - Opus"));
});
