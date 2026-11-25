// R1 fix UI r2: the request a New Agent / Add Buddy role row sends (src/roleSpawn.ts) resolves through the spawn hook
// (in-process, like spawn-route-hook.test.mjs) to the expected provider/model, with no legacy-name route.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { ROLE_TABLE } from "../server/role-route.mjs";
import { routeOverrideLabel } from "../server/route-override.mjs";
import { DEFAULT_TIER_LADDER } from "../server/stakes-ladder.mjs";
import { STAKES_CHOICES, buildRoleSpawn, ladderPick, overrideGroups, overrideValue, parseOverrideValue } from "../src/roleSpawn.ts";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

const ISOLATED = join(tmpdir(), `vs-r1fixui2-missing-${process.pid}`);
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
const KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
process.env.VIBESQUAD_HOME = ISOLATED;
process.env.VIBESQUAD_PROFILES_PATH = join(ISOLATED, "profiles.json");
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(ISOLATED, "capped.json");
const CWD = "/projects/VibeSquad/.worktrees/r1fixui2";

const withEnv = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-r1fixui2-"));
  const home = join(dir, ".vibesquad");
  mkdirSync(home, { recursive: true });
  const teams = join(home, "teams.json");
  writeFileSync(teams, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: USER_PROFILES }));
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { VIBESQUAD_HOME: home, VIBESQUAD_TEAMS_FILE: teams, VIBESQUAD_PROFILES_PATH: join(home, "profiles.json"), VIBESQUAD_CAPPED_PROVIDERS_PATH: join(home, "capped.json") });
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
};

function harness() {
  const before = new Map();
  const server = { before: (n, f) => (before.set(n, f), () => before.delete(n)), on: () => () => {} };
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {} })(server);
  // What spawnTeamAgent sends to the runner: config {provider, model?, cwd, title} + labels (src/TeamActions.tsx).
  const spawn = async (req, base = {}) => {
    const labels = { team: "vibesquad", lane: "vibesquad", role: "worker", profile: req.profile, ...base, ...req.labels };
    const config = { cwd: CWD, provider: req.provider, ...(req.model ? { model: req.model } : {}) };
    return (await before.get("agent.create")({ request: { config, labels } })) ?? { config, labels };
  };
  return { stop, spawn };
}

const ROLES = Object.fromEntries(Object.entries(ROLE_TABLE).map(([k, r]) => [k, { name: r.name, tier: r.tier, providers: r.providers ?? [] }]));
const SEAT = (key) => (key === "lead" || key === "brainstorm" ? { role: key } : {}); // the modal's SEAT value follows the role row
const roleOf = (key) => ROLES[key];
const send = (roleKey, o = {}) => buildRoleSpawn({ roleKey, role: roleOf(roleKey), ladder: DEFAULT_TIER_LADDER, ...o });
const metric = (out) => String(out.labels?.[ROUTE_LABEL] ?? "");

test("role rows send the role key, no model, stakes label; no override label", () => {
  const r = send("implement");
  assert.equal(r.profile, "implement");
  assert.equal(r.model, undefined);
  assert.deepEqual(r.labels, { stakes: "normal" });
  const t = send("review", { stakes: "tierA-security" });
  assert.deepEqual(t.labels, { stakes: "tierA-security" });
});

test("role: every role row routes by ladder through the hook (no legacy-name, profile label = the role)", withEnv(async () => {
  const h = harness();
  try {
    for (const key of Object.keys(ROLES)) {
      for (const stakes of STAKES_CHOICES) {
        const out = await h.spawn(send(key, { stakes }), SEAT(key));
        const at = `${key} ${stakes}: ${metric(out)}`;
        assert.doesNotMatch(metric(out), /legacy-name/, at);
        assert.equal(out.labels.profile, key === "lead" || key === "brainstorm" ? key : ROLES[key].name, at); // server labels lead/brainstorm lowercase
        // the model the badge predicts (first provider x tier for stakes) is the model that lands
        const want = ladderPick(ROLES[key], DEFAULT_TIER_LADDER, stakes);
        assert.equal(out.config.provider, want.provider, at);
        assert.equal(out.config.model, want.model, at);
      }
    }
  } finally {
    h.stop?.();
  }
}));

test("role+stakes: Implement tierA-invariant lands on Opus, mechanical on the cheap rung", withEnv(async () => {
  const h = harness();
  try {
    const top = await h.spawn(send("implement", { stakes: "tierA-invariant" }));
    assert.deepEqual([top.config.provider, top.config.model], ["claude", "claude-opus-5-5"]);
    assert.match(metric(top), /reason=ladder tier=top role=implement/);
    const cheap = await h.spawn(send("implement", { stakes: "mechanical" }));
    assert.equal(cheap.config.model, DEFAULT_TIER_LADDER.claude.cheap.model);
  } finally {
    h.stop?.();
  }
}));

test("role+override: model and provider overrides land as picked (not reverted), reason=override, label shape = spawn_worker's", withEnv(async () => {
  const h = harness();
  try {
    // The audit case: badge said Opus, agent used to run Sonnet.
    const opus = send("implement", { override: { provider: "claude", model: "claude-opus-5-5" } });
    assert.equal(opus.labels["vs.route-override"], routeOverrideLabel({ provider: "claude", model: "claude-opus-5-5" }));
    const o = await h.spawn(opus);
    assert.deepEqual([o.config.provider, o.config.model], ["claude", "claude-opus-5-5"]);
    assert.match(metric(o), /reason=override/);
    assert.doesNotMatch(metric(o), /legacy-name/);
    // Every provider in every role's list, every ladder model, plus the provider-only rung.
    for (const [key, role] of Object.entries(ROLES)) {
      for (const g of overrideGroups(role, DEFAULT_TIER_LADDER)) {
        for (const m of g.models) {
          const out = await h.spawn(send(key, { override: { provider: g.provider, model: m } }));
          assert.deepEqual([out.config.provider, out.config.model], [g.provider, m], `${key} ${g.provider}|${m}`);
        }
        const rung = await h.spawn(send(key, { stakes: "tierA-invariant", override: { provider: g.provider } }));
        assert.equal(rung.config.provider, g.provider, `${key} ${g.provider} rung`);
        assert.equal(rung.config.model, DEFAULT_TIER_LADDER[g.provider].top.model, `${key} ${g.provider} rung model`);
      }
    }
    // Non-Claude workers, Buddies and Leads are startable again.
    for (const key of ["review", "brainstorm", "lead"]) {
      const out = await h.spawn(send(key, { override: { provider: "antigravity-cli" } }), SEAT(key));
      assert.equal(out.config.provider, "antigravity-cli", key);
    }
  } finally {
    h.stop?.();
  }
}));

test("legacy saved pick keeps the pinned-profile path (legacy-name), unchanged", withEnv(async () => {
  const h = harness();
  try {
    // src/TeamActions.tsx: a legacy row sends profile=<old name> and its pinned model, no stakes/override labels.
    const out = await h.spawn({ profile: "Implement - Sonnet", provider: "claude", model: "claude-sonnet-5-5", labels: {} });
    assert.match(metric(out), /legacy-name/);
    assert.equal(out.config.model, "claude-sonnet-5-5");
  } finally {
    h.stop?.();
  }
}));

test("override value round-trip and badge pick helper", () => {
  for (const v of ["", "claude", "claude|claude-opus-5-5"]) assert.equal(overrideValue(parseOverrideValue(v)), v);
  assert.deepEqual(ladderPick(ROLES.review, DEFAULT_TIER_LADDER, "tierA-invariant").provider, ROLES.review.providers[0]);
});

test("src wiring: ROLE/SEAT labels, role key as profile, saved-default-missing note", () => {
  const ta = readFileSync(resolve(import.meta.dirname, "..", "src", "TeamActions.tsx"), "utf8");
  assert.ok(ta.includes('<Field label="ROLE">') && ta.includes('<Field label="SEAT">'));
  assert.ok(!ta.includes('<Field label="PROFILE">') && !ta.includes("BRAINSTORM PROFILE"));
  assert.ok(ta.includes('data-testid="saved-default-missing"') && ta.includes('data-testid="stakes-select"'));
  assert.ok(ta.includes("roleSpawn ? roleSpawn.profile : profile.name"));
});
