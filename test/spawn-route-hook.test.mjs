// P5c (docs/PLAN_PROFILES_ROLE_ONLY.md, idea-77): the spawn hook routes role names through resolveRoute and keeps
// today's walk for old names/aliases (resolveRoute only as a shadow). Golden end-to-end: every old name and alias, under
// every cap set and every stakes value, routes through the hook exactly as the `today()` oracle does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { resolveLeadProfile } from "../server/lead-handoff.mjs";
import { LEGACY_PROFILE_ALIASES, legacyProfileRole } from "../server/profiles.mjs";
import { ROLE_TABLE } from "../server/role-route.mjs";
import {
  cappedFamilies,
  legacyRouteMeta,
  legacyShadowMismatch,
  roleNameHit,
  roleProfileLabel,
  roleSpawnConfig,
  routeMetricText,
} from "../server/spawn-route.mjs";
import { STAKES_VALUES } from "../server/stakes-ladder.mjs";
import { A, C, CAP_SETS, GOLDEN, O, USER_PROFILES, today } from "./helpers/route-golden.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

const CWD = "/projects/VibeSquad/.worktrees/spawn-route-test";
const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];

function withEnv(fn, profiles = USER_PROFILES) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-spawn-route-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
      "utf8",
    );
    const profilesPath = join(vsHome, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles }), "utf8");
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesPath;
    // Never the host's capped-providers.json: a file that does not exist = nothing capped on disk.
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(vsHome, "capped-providers.json");
    try {
      await fn({ dir, vsHome, profilesPath });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(overrides = {}) {
  const before = new Map();
  const on = new Map();
  const calls = { refused: [], settings: [] };
  const server = {
    before: (name, fn) => (before.set(name, fn), () => before.delete(name)),
    on: (name, fn) => (on.set(name, fn), () => on.delete(name)),
  };
  const stop = createPlugin({
    startWatcher: false,
    setLabels: async () => {},
    archiveAgent: async () => {},
    applyAgentSettings: async (agentId, patch) => calls.settings.push({ agentId, patch }),
    refuseAgent: async (agentId) => calls.refused.push(agentId),
    ...overrides,
  })(server);
  const spawn = async (config = {}, extra = {}) => {
    const req = { config: { cwd: CWD, ...config }, ...extra };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, spawn, onCreated: on.get("agent.created"), calls };
}

const LABELS = (profile, extra = {}) => ({ profile, team: "vibesquad", lane: "vibesquad", role: "worker", ...extra });
const capMap = (caps) => Object.fromEntries(caps.map((f) => [f, { capped: true }]));
const landed = (out) => ({
  provider: out.config.provider,
  model: out.config.model,
  effort: out.config.thinkingOptionId,
  modeId: out.config.modeId,
});

test(
  "golden e2e: every old name + alias x every cap set x every stakes value routes through the hook as today()",
  withEnv(async () => {
    const names = [...GOLDEN.map((g) => g.name), ...Object.keys(LEGACY_PROFILE_ALIASES)];
    const stakesList = [...STAKES_VALUES, undefined, "bogus"];
    let n = 0;
    for (const caps of CAP_SETS) {
      const h = harness({ cappedProviders: capMap(caps) });
      try {
        for (const name of names) {
          for (const s of stakesList) {
            const at = `${name} caps=[${caps}] stakes=${s}`;
            const out = await h.spawn({ provider: "claude" }, { labels: LABELS(name, s ? { stakes: s } : {}) });
            assert.deepEqual(landed(out), today(name, caps, s), at);
            const metric = String(out.labels?.[ROUTE_LABEL] ?? "");
            assert.match(metric, /reason=\S*legacy-name/, `${at}: ${metric}`);
            assert.doesNotMatch(metric, /shadow=/, `${at}: ${metric}`);
            // Old names keep an old profile label (failover relabels to the landed counterpart, as today).
            assert.ok(legacyProfileRole(out.labels.profile), `${at}: label ${out.labels.profile}`);
            if (!caps.length) assert.equal(legacyProfileRole(out.labels.profile).name, legacyProfileRole(name).name, at);
            n++;
          }
        }
      } finally {
        h.stop?.();
      }
    }
    assert.equal(n, names.length * CAP_SETS.length * stakesList.length);
  }),
);

test(
  "role rows: Implement normal/tierA-invariant, Review normal; label stamps",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      const impl = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(impl), { provider: C, model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" });
      assert.equal(impl.labels.profile, "Implement");
      assert.deepEqual(
        [impl.labels.provider, impl.labels.model, impl.labels.tier, impl.labels.stakes],
        [C, "claude-sonnet-5-5", "mid", "normal"],
      );
      assert.match(impl.labels[ROUTE_LABEL], /reason=default tier=mid role=implement$/);
      assert.doesNotMatch(impl.labels[ROUTE_LABEL], /legacy-name/);

      const top = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement", { stakes: "tierA-invariant" }) });
      assert.deepEqual(landed(top), { provider: C, model: "claude-opus-5-5", effort: "high", modeId: "auto" });
      assert.deepEqual([top.labels.tier, top.labels.stakes], ["top", "tierA-invariant"]);
      assert.match(top.labels[ROUTE_LABEL], /reason=ladder tier=top role=implement/);

      const rev = await h.spawn({ provider: "claude" }, { labels: LABELS("Review") });
      assert.equal(rev.config.provider, A);
      assert.equal(rev.config.model, "gemini-4-argon");
      assert.deepEqual([rev.labels.profile, rev.labels.provider, rev.labels.tier], ["Review", A, "mid"]);

      // Stakes label is normalized on the stamp (lead ruling: OK).
      const bogus = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement", { stakes: "bogus" }) });
      assert.equal(bogus.labels.stakes, "normal");
      // Old names carry the stamps too.
      const old = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement - Sonnet") });
      assert.deepEqual([old.labels.provider, old.labels.model, old.labels.tier, old.labels.stakes], [C, "claude-sonnet-5-5", "mid", "normal"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "role row: lowercase lead with claude capped -> antigravity top rung, reason=failover, label lead, not refused after spawn",
  withEnv(async () => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS("lead", { role: "lead" }) });
      assert.equal(out.config.provider, A);
      assert.equal(out.config.model, "gemini-4-argon");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.equal(out.labels.profile, "lead");
      assert.equal(out.labels.tier, "top");
      assert.match(out.labels[ROUTE_LABEL], /reason=failover tier=top role=lead/);

      const agent = { id: "lead-1", title: "LEAD", cwd: CWD, provider: out.config.provider, model: out.config.model, labels: { ...out.labels } };
      const paseo = { getAgent: async () => agent, agents: { ref: () => ({ refresh: async () => ({ agent }), archive: async () => {} }), list: async () => ({ entries: [{ agent }] }) } };
      await h.onCreated({ agent }, { paseo });
      assert.deepEqual(h.calls.refused, [], "a role spawn labelled lead must not read back as Lead - Claude and be refused");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "label-only role spawn on a provider that does not match its route is refused (lead ruling: same as named profiles)",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      // Review routes to antigravity-cli; this agent came up on claude with only the label (no hook-routed tier stamp).
      const agent = {
        id: "rev-1",
        title: "review worker",
        cwd: CWD,
        provider: "claude",
        model: "claude-sonnet-5-5",
        labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Review" },
      };
      const paseo = { getAgent: async () => agent, agents: { ref: () => ({ refresh: async () => ({ agent }), archive: async () => {} }), list: async () => ({ entries: [{ agent }] }) } };
      await h.onCreated({ agent }, { paseo });
      assert.deepEqual(h.calls.refused, ["rev-1"]);
    } finally {
      h.stop?.();
    }
  }),
);

test("spawn-route units: roleNameHit, roleProfileLabel, cappedFamilies", () => {
  assert.equal(roleNameHit("Lead"), null, "bare Lead is the alias for Lead - Claude");
  assert.equal(roleNameHit("Lead - Claude"), null);
  assert.equal(roleNameHit("lead")?.key, "lead");
  assert.equal(roleNameHit("work order")?.key, "work-order");
  assert.equal(roleNameHit("Implement")?.key, "implement");
  assert.equal(roleNameHit("No Such Thing"), null);

  const labels = Object.keys(ROLE_TABLE).map((k) => roleProfileLabel(k));
  assert.deepEqual(labels, ["lead", "brainstorm", "Implement", "Work Order", "Review", "Pre-check", "Art Director", "Art Painter"]);
  for (const [i, k] of Object.keys(ROLE_TABLE).entries()) assert.equal(roleNameHit(labels[i])?.key, k, `label ${labels[i]} reads back as ${k}`);

  assert.deepEqual(cappedFamilies([]), []);
  assert.deepEqual(cappedFamilies([{ id: "claude", status: "exhausted", usedPct: 100 }], [], { ignoreDiskCaps: true }), [C]);
  assert.deepEqual(
    cappedFamilies([{ id: "opencode", status: "exhausted", usedPct: 100 }, { id: "antigravity-cli", usedPct: 99 }], [], { ignoreDiskCaps: true }).sort(),
    [A, O].sort(),
  );
  assert.deepEqual(cappedFamilies([{ id: "claude", usedPct: 10 }], [], { ignoreDiskCaps: true }), []);
});

test("spawn-route units: legacyShadowMismatch (incl. skip flags), routeMetricText", () => {
  const meta = legacyRouteMeta("Implement - Sonnet", { stakes: "normal", caps: [], stakesLadder: {} });
  assert.equal(meta.route.provider, C);
  assert.equal(legacyShadowMismatch(meta, { provider: C, model: "claude-sonnet-5-5", effort: "medium" }), "");
  assert.equal(legacyShadowMismatch(meta, { provider: "claude/claude-sonnet-5-5", model: "claude-sonnet-5-5", effort: "medium" }), "");
  assert.equal(
    legacyShadowMismatch(meta, { provider: O, model: "x", effort: "low" }),
    "provider:opencode!=claude,model:x!=claude-sonnet-5-5,effort:low!=medium",
  );
  assert.equal(legacyShadowMismatch(meta, { provider: C, model: "x", effort: "low" }, { skipModel: true, skipEffort: true }), "");
  assert.equal(legacyShadowMismatch(meta, { provider: C, model: "x", effort: "low" }, { skipModel: true }), "effort:low!=medium");
  assert.equal(legacyShadowMismatch(meta, O), "provider:opencode!=claude", "string form compares the provider only");
  assert.equal(legacyShadowMismatch(null, { provider: O }), "");
  assert.equal(legacyRouteMeta("Implement"), null, "a role name is not an old name");

  assert.equal(
    routeMetricText({ stakes: undefined, model: "m", effort: "e", reason: "default", legacyName: true, tier: "mid", role: "implement" }),
    "stakes=normal model=m effort=e reason=legacy-name tier=mid role=implement",
  );
  assert.equal(
    routeMetricText({ stakes: "tierA-security", model: "", effort: "", reason: "ladder", legacyName: true, explicitCapped: true, shadow: "provider:a!=b" }),
    "stakes=tierA-security model=- effort=- reason=ladder+legacy-name tier=- role=- explicit-capped=dropped shadow=provider:a!=b",
  );
  assert.equal(routeMetricText({ stakes: "normal", model: "m", effort: "", reason: "failover", tier: "top", role: "lead" }), "stakes=normal model=m effort=- reason=failover tier=top role=lead");
});

test("spawn-route units: roleSpawnConfig (role names only; caps walk the provider list)", () => {
  assert.equal(roleSpawnConfig("Lead - Claude", { profiles: USER_PROFILES }), null);
  assert.equal(roleSpawnConfig("Lead", { profiles: USER_PROFILES }), null, "bare Lead stays the old alias");
  const lead = roleSpawnConfig("lead", { profiles: USER_PROFILES });
  assert.equal(lead.profileName, "lead");
  assert.deepEqual([lead.spawnCfg.provider, lead.spawnCfg.model, lead.spawnCfg.thinkingOptionId], [C, "claude-opus-5-5", "high"]);
  assert.equal(lead.profile.role, "lead");
  const capped = roleSpawnConfig("lead", { profiles: USER_PROFILES, usageList: [{ id: "claude", status: "exhausted", usedPct: 100 }] });
  assert.deepEqual([capped.spawnCfg.provider, capped.spawnCfg.model, capped.spawnCfg.thinkingOptionId], [A, "gemini-4-argon", "high"]);
  const wo = roleSpawnConfig("Work Order", { profiles: USER_PROFILES, stakes: "mechanical" });
  assert.equal(wo.spawnCfg.provider, O);
  assert.equal(wo.route.tier, "cheap");
  assert.equal(wo.profile.role, "worker");
});

test(
  "lead-handoff resolveLeadProfile: role label respawns from the role route; stored names keep the profile path",
  withEnv(async ({ profilesPath, vsHome }) => {
    const noDisk = { cappedProvidersPath: join(vsHome, "none.json") };
    const fresh = resolveLeadProfile({ provider: "claude", labels: { profile: "lead" } }, profilesPath, { ...noDisk, cappedProviders: [] });
    assert.equal(fresh.profileName, "lead");
    assert.deepEqual([fresh.spawnCfg.provider, fresh.spawnCfg.model, fresh.spawnCfg.thinkingOptionId], [C, "claude-opus-5-5", "high"]);

    const capped = resolveLeadProfile({ provider: "claude", labels: { profile: "lead" } }, profilesPath, { ...noDisk, cappedProviders: ["claude"] });
    assert.equal(capped.profileName, "lead");
    assert.deepEqual([capped.spawnCfg.provider, capped.spawnCfg.model, capped.spawnCfg.thinkingOptionId], [A, "gemini-4-argon", "high"]);

    const old = resolveLeadProfile({ provider: "claude", labels: { profile: "Lead - Claude" } }, profilesPath, { ...noDisk, cappedProviders: ["claude"] });
    assert.equal(old.profileName, "Lead - Claude");
    assert.deepEqual([old.spawnCfg.provider, old.spawnCfg.model], [C, "claude-opus-5-5"], "old names: the hook's walk decides, as today");
  }),
);

test(
  "brainstorm restart: role label respawns from the role route (claude capped -> antigravity top rung)",
  withEnv(async ({ dir, vsHome, profilesPath }) => {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(dir, "docs", "brainstorm", "bug-chaser.md"), "# Brief\n\n## Open\n- x\n", "utf8");
    // The lane's lastProfile is the role label a role-name spawn left behind (teams file = VIBESQUAD_TEAMS_FILE).
    writeFileSync(
      process.env.VIBESQUAD_TEAMS_FILE,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "bug-chaser", name: "Bug Chaser", lastProfile: "brainstorm" }] }] }),
      "utf8",
    );
    resetBrainstormRestartState();
    const created = [];
    const agentClient = {
      fetchAgents: async () => [],
      createAgent: async (req) => (created.push(req), { id: `bs-${created.length}`, labels: req.labels }),
      archiveAgent: async () => {},
      updateAgent: async () => {},
      cancelAgent: async () => {},
    };
    await performBrainstormRestart(
      {
        reason: "start-brainstorm",
        mode: "quick-start",
        teamId: "vibesquad",
        laneId: "bug-chaser",
        laneName: "Bug Chaser",
        agentClient,
        profilesPath,
        cappedProviders: ["claude"],
        cappedProvidersPath: join(vsHome, "none.json"),
        backstopDelayMs: 60000,
      },
      dir,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].labels.profile, "brainstorm");
    assert.equal(created[0].config.provider, A);
    assert.equal(created[0].config.model, "gemini-4-argon");
    assert.equal(created[0].config.thinkingOptionId, "high");
  }),
);
