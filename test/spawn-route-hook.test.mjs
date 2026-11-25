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
import { saveRoles } from "../server/roles-api.mjs";
import {
  ROUTE_OVERRIDE_LABEL,
  cappedFamilies,
  legacyRouteMeta,
  legacyShadowMismatch,
  roleNameHit,
  roleProfileLabel,
  roleSpawnConfig,
  roleSpawnProfile,
  roleMcpExtras,
  routeMetricText,
} from "../server/spawn-route.mjs";
import { DEFAULT_TIER_LADDER, STAKES_VALUES } from "../server/stakes-ladder.mjs";
import { ROUTE_OVERRIDE_ENV, isForeignModel } from "../server/route-override.mjs";
import { A, C, CAP_SETS, GOLDEN, O, USER_PROFILES, today } from "./helpers/route-golden.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
// P5d: live spawns read stored v2 roles from profiles.json, so tests outside withEnv must never see the host's
// ~/.vibesquad. Point the home and profiles path at a temp dir that does not exist (= v1 defaults, nothing capped).
const ISOLATED_HOME = join(tmpdir(), `vs-spawn-route-missing-${process.pid}-${Date.now()}`);
process.env.VIBESQUAD_HOME = ISOLATED_HOME;
process.env.VIBESQUAD_PROFILES_PATH = join(ISOLATED_HOME, "profiles.json");
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(ISOLATED_HOME, "capped-providers.json");
delete process.env.VIBESQUAD_TEAMS_FILE;

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
      assert.match(impl.labels[ROUTE_LABEL], /reason=default tier=mid role=implement why=rung$/);
      assert.doesNotMatch(impl.labels[ROUTE_LABEL], /legacy-name/);

      const top = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement", { stakes: "tierA-invariant" }) });
      assert.deepEqual(landed(top), { provider: C, model: "claude-opus-5-5", effort: "high", modeId: "auto" });
      assert.deepEqual([top.labels.tier, top.labels.stakes], ["top", "tierA-invariant"]);
      assert.match(top.labels[ROUTE_LABEL], /reason=ladder tier=top role=implement/);

      // config.provider alone is a filled-in default (every spawn carries one), not the caller's choice: the role routes.
      // A caller-given provider comes with spawn_worker's ROUTE_OVERRIDE_LABEL (H1): see the "H1 override" tests below.
      const rev = await h.spawn({ provider: "claude" }, { labels: LABELS("Review") });
      assert.equal(rev.config.provider, A);
      assert.equal(rev.config.model, "gemini-4-neon");
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

// H1 (R1 fix, idea-974; live case 13:01Z: Review provider=claude model=claude-sonnet-5-5 tierA-invariant ran gemini-4-neon
// reason=ladder). A role-name spawn's caller provider/model (spawn_worker's ROUTE_OVERRIDE_LABEL) win; stakes pick the
// rung of THAT provider's ladder unless a model is given; a cap still hops; the metric says reason=override.
const OV = (provider, model) => ({ [ROUTE_OVERRIDE_LABEL]: [provider && `provider=${provider}`, model && `model=${model}`].filter(Boolean).join(" ") });

test(
  "H1 override: the 13:01Z case (Review provider=claude model=claude-sonnet-5-5 tierA-invariant) lands on Claude Sonnet",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-sonnet-5-5" },
        { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV("claude", "claude-sonnet-5-5") }) },
      );
      assert.deepEqual(landed(out), { provider: C, model: "claude-sonnet-5-5", effort: "high", modeId: "auto" });
      assert.equal(out.labels.profile, "Review");
      assert.deepEqual([out.labels.provider, out.labels.model, out.labels.tier], [C, "claude-sonnet-5-5", "top"]);
      assert.match(out.labels[ROUTE_LABEL], /^stakes=tierA-invariant model=claude-sonnet-5-5 effort=high reason=override tier=top role=review why=override$/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "H1 override: provider-only under every stakes value picks that provider's rung; provider+model keeps the model",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    // Review's default tier is mid; stakes force top (tierA-*) / cheap (mechanical) on the CALLER's provider's ladder.
    const rung = { normal: ["claude-sonnet-5-5", "medium"], mechanical: ["claude-sonnet-5-5", "low"], "tierA-invariant": ["claude-opus-5-5", "high"], "tierA-security": ["claude-opus-5-5", "high"] };
    try {
      for (const s of STAKES_VALUES) {
        const [model, effort] = rung[s];
        // spawn_worker pre-fills the role's rung for the caller's provider and marks it derived.
        const only = await h.spawn(
          { provider: "claude", model, thinkingOptionId: effort },
          { labels: LABELS("Review", { stakes: s, "vs.profile-derived": "model,thinking", ...OV("claude") }) },
        );
        assert.deepEqual(landed(only), { provider: C, model, effort, modeId: "auto" }, `provider-only ${s}`);
        assert.match(only.labels[ROUTE_LABEL], new RegExp(`^stakes=${s} model=${model} effort=${effort} reason=override `), `provider-only ${s}`);
        // A config without the pre-fill (direct create) lands the same: the hook routes the rung itself.
        const bare = await h.spawn({ provider: "claude" }, { labels: LABELS("Review", { stakes: s, ...OV("claude") }) });
        assert.deepEqual(landed(bare), { provider: C, model, effort, modeId: "auto" }, `provider-only bare ${s}`);

        const both = await h.spawn(
          { provider: "claude", model: "claude-sonnet-5-5" },
          { labels: LABELS("Review", { stakes: s, "vs.profile-derived": "thinking", ...OV("claude", "claude-sonnet-5-5") }) },
        );
        assert.deepEqual(landed(both), { provider: C, model: "claude-sonnet-5-5", effort, modeId: "auto" }, `provider+model ${s}`);
        assert.match(both.labels[ROUTE_LABEL], /reason=override tier=\S+ role=review why=override$/, `provider+model ${s}`);

        // Model only: the model's family is the provider.
        const m = await h.spawn({ provider: A, model: "claude-sonnet-5-5" }, { labels: LABELS("Review", { stakes: s, ...OV("", "claude-sonnet-5-5") }) });
        assert.deepEqual(landed(m), { provider: C, model: "claude-sonnet-5-5", effort, modeId: "auto" }, `model-only ${s}`);
        assert.match(m.labels[ROUTE_LABEL], /reason=override /, `model-only ${s}`);
      }
      // Implement (Claude first) overridden onto Gemini: Gemini's ladder, Gemini's mode.
      const g = await h.spawn({ provider: A }, { labels: LABELS("Implement", { stakes: "tierA-invariant", ...OV(A) }) });
      assert.deepEqual([g.config.provider, g.config.model, g.config.thinkingOptionId], [A, "gemini-4-neon", "high"]);
      assert.equal(g.labels.profile, "Implement");
      // A caller thinking value still beats the rung's effort; the reason stays override.
      const t = await h.spawn({ provider: "claude", thinkingOptionId: "low" }, { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV("claude") }) });
      assert.deepEqual([t.config.provider, t.config.model, t.config.thinkingOptionId], [C, "claude-opus-5-5", "low"]);
      assert.match(t.labels[ROUTE_LABEL], /reason=override /);
    } finally {
      h.stop?.();
    }
  }),
);

// r2 (rn-a5cd265243b5 L1): provider + a model of another family must not launch e.g. claude/gemini-4-neon. The foreign
// model is dropped, the provider kept with its own rung, and the metric says model-dropped=family.
test("r2 isForeignModel: another ladder family's model is foreign; opencode vendor ids and unknown ids are not", () => {
  const rows = [
    ["claude", "gemini-4-neon", true],
    ["claude", "deepseek/deepseek-flash", true],
    ["opencode", "claude-opus-5-5", true],
    ["antigravity-cli", "claude-sonnet-5-5", true],
    ["opencode", "gemini-4-neon", true],
    ["claude", "claude-sonnet-5-5", false],
    ["antigravity-cli", "gemini-3.8-flash", false],
    ["opencode", "deepseek/deepseek-flash", false],
    ["opencode", "anthropic/claude-opus-5-5", false],
    ["claude", "some-unknown-model", false],
    ["claude", "", false],
    ["", "gemini-4-neon", false],
  ];
  for (const [p, m, want] of rows) assert.equal(isForeignModel(p, m), want, `${p} + ${m}`);
});

test(
  "r2 override: provider + a foreign-family model drops the model, keeps the provider's rung, logs model-dropped=family",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    const top = (fam) => DEFAULT_TIER_LADDER[fam].top;
    try {
      for (const [prov, model, fam, mode] of [
        ["claude", "gemini-4-neon", C, "auto"],
        ["claude", "deepseek/deepseek-flash", C, "auto"],
        ["opencode", "claude-opus-5-5", O, "build"],
        [A, "claude-sonnet-5-5", A, "default"],
      ]) {
        const at = `${prov} + ${model}`;
        // The caller's model rides in the config too (not profile-derived): it must not come back as an explicit model.
        const out = await h.spawn({ provider: prov, model }, { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV(prov, model) }) });
        assert.deepEqual(landed(out), { provider: fam, model: top(fam).model, effort: top(fam).effort, modeId: mode }, at);
        assert.match(out.labels[ROUTE_LABEL], /reason=override tier=top role=review model-dropped=family why=override$/, at);
      }
      // Same family, and opencode's own vendor/model ids, are kept (no model-dropped).
      const same = await h.spawn({ provider: "claude", model: "claude-sonnet-5-5" }, { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV("claude", "claude-sonnet-5-5") }) });
      assert.equal(same.config.model, "claude-sonnet-5-5");
      assert.doesNotMatch(same.labels[ROUTE_LABEL], /model-dropped/);
      const vendor = await h.spawn({ provider: "opencode", model: "anthropic/claude-opus-5-5" }, { labels: LABELS("Review", OV("opencode", "anthropic/claude-opus-5-5")) });
      assert.deepEqual([vendor.config.provider, vendor.config.model], [O, "anthropic/claude-opus-5-5"]);
      assert.doesNotMatch(vendor.labels[ROUTE_LABEL], /model-dropped/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "r2 app create path: Paseo hands the hook only {config, env}: the VS_ROUTE_OVERRIDE env twin carries the override",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      // The New Agent modal's shape on Paseo: no request labels reach before(agent.create); profile/stakes/override in env.
      const env = { VS_ROLE: "worker", VS_PROFILE: "Review", VS_STAKES: "tierA-invariant", [ROUTE_OVERRIDE_ENV]: "provider=claude model=claude-sonnet-5-5" };
      const out = await h.spawn({ provider: "claude", model: "claude-sonnet-5-5", title: "app review" }, { env });
      assert.deepEqual(landed(out), { provider: C, model: "claude-sonnet-5-5", effort: "high", modeId: "auto" });
      // Provider-only from the app: the claude rung for the stakes.
      const only = await h.spawn({ provider: "claude", title: "app review 2" }, { env: { ...env, [ROUTE_OVERRIDE_ENV]: "provider=claude" } });
      assert.deepEqual(landed(only), { provider: C, model: "claude-opus-5-5", effort: "high", modeId: "auto" });
      // Without the env twin the same request is a filled-in default: the Review role routes to Gemini.
      const { [ROUTE_OVERRIDE_ENV]: _drop, ...plainEnv } = env;
      const plain = await h.spawn({ provider: "claude", title: "app review 3" }, { env: plainEnv });
      assert.equal(plain.config.provider, A);
      // The runner path (labels do reach the hook): the label alone works, and wins over a stale env twin.
      const viaLabel = await h.spawn(
        { provider: "claude", title: "app review 4" },
        { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV("claude") }), env: { [ROUTE_OVERRIDE_ENV]: `provider=${A}` } },
      );
      assert.deepEqual([viaLabel.config.provider, viaLabel.config.model], [C, "claude-opus-5-5"]);
      assert.match(viaLabel.labels[ROUTE_LABEL], /reason=override /);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "H1 override: a capped caller provider still hops along the role's list, logged as override+failover",
  withEnv(async () => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-sonnet-5-5" },
        { labels: LABELS("Review", { stakes: "tierA-invariant", ...OV("claude", "claude-sonnet-5-5") }) },
      );
      assert.deepEqual([out.config.provider, out.config.model, out.config.thinkingOptionId], [A, "gemini-4-neon", "high"]);
      assert.match(out.labels[ROUTE_LABEL], /reason=override\+failover tier=top role=review explicit-capped=dropped why=failover$/);
    } finally {
      h.stop?.();
    }
    // Every provider capped: the caller's provider is kept (nothing to hop to), still reason=override.
    const all = harness({ cappedProviders: capMap([C, A, O]) });
    try {
      const out = await all.spawn({ provider: "claude" }, { labels: LABELS("Review", OV("claude")) });
      assert.equal(out.config.provider, C);
      assert.match(out.labels[ROUTE_LABEL], /reason=override tier=mid role=review why=override$/);
    } finally {
      all.stop?.();
    }
  }),
);

test(
  "H1 override: old names + aliases ignore the override label (today's walk, unchanged); no label = no change",
  withEnv(async () => {
    const names = [...GOLDEN.map((g) => g.name), ...Object.keys(LEGACY_PROFILE_ALIASES)];
    for (const caps of [[], [C]]) {
      const h = harness({ cappedProviders: capMap(caps) });
      try {
        for (const name of names) {
          for (const s of STAKES_VALUES) {
            const out = await h.spawn({ provider: "claude" }, { labels: LABELS(name, { stakes: s, ...OV(A, "gemini-4-neon") }) });
            assert.deepEqual(landed(out), today(name, caps, s), `${name} caps=[${caps}] stakes=${s}`);
            assert.doesNotMatch(String(out.labels[ROUTE_LABEL]), /reason=override/, name);
          }
        }
      } finally {
        h.stop?.();
      }
    }
  }),
);

test(
  "H1 override: an override-labelled role spawn is not refused after spawn (agent.created re-route honours it)",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      // Label-only arrival (no tier stamp, not before()-configured): the role re-route must use the override too.
      const agent = {
        id: "rev-ov",
        title: "REV",
        cwd: CWD,
        provider: "claude",
        model: "claude-opus-5-5",
        thinkingOptionId: "high",
        modeId: "auto",
        labels: { ...LABELS("Review", { stakes: "tierA-invariant", ...OV("claude") }) },
      };
      const paseo = { getAgent: async () => agent, agents: { ref: () => ({ refresh: async () => ({ agent }), archive: async () => {} }), list: async () => ({ entries: [{ agent }] }) } };
      await h.onCreated({ agent }, { paseo });
      assert.deepEqual(h.calls.refused, []);
      // Same spawn without the override is refused (Review routes to Gemini), as before.
      const plain = { ...agent, id: "rev-plain", title: "REV2", labels: LABELS("Review", { stakes: "tierA-invariant" }) };
      const paseo2 = { getAgent: async () => plain, agents: { ref: () => ({ refresh: async () => ({ agent: plain }), archive: async () => {} }), list: async () => ({ entries: [{ agent: plain }] }) } };
      await h.onCreated({ agent: plain }, { paseo: paseo2 });
      assert.deepEqual(h.calls.refused, ["rev-plain"]);
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
      assert.equal(out.config.model, "gemini-4-neon");
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
  assert.deepEqual(labels, ["lead", "brainstorm", "Planner", "Implement", "Work Order", "Review", "Pre-check", "Art Director", "Art Painter"]);
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
  assert.deepEqual([capped.spawnCfg.provider, capped.spawnCfg.model, capped.spawnCfg.thinkingOptionId], [A, "gemini-4-neon", "high"]);
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
    assert.deepEqual([capped.spawnCfg.provider, capped.spawnCfg.model, capped.spawnCfg.thinkingOptionId], [A, "gemini-4-neon", "high"]);

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
    assert.equal(created[0].config.model, "gemini-4-neon");
    assert.equal(created[0].config.thinkingOptionId, "high");
  }),
);

// ---- P5c fix-round pins (idea-77): Gemini L2 (env relabel, all-capped), Sonnet L1 (routed tier stamp), Sonnet L2 (skip) ----

const paseoFor = (agent) => ({
  getAgent: async () => agent,
  agents: { ref: () => ({ refresh: async () => ({ agent }), archive: async () => {} }), list: async () => ({ entries: [{ agent }] }) },
});

test(
  "env-only role spawn: VS_PROFILE relabels to the role label; agent.created stamps the tier before() routed, not the stakes label's (Gemini L2, Sonnet L1)",
  withEnv(async () => {
    const stamped = [];
    const h = harness({ cappedProviders: {}, setLabels: async (id, labels) => stamped.push({ id, labels }) });
    try {
      // UI spawnEnvFor / MCP create_agent: the profile comes by env only, no labels, no stakes -> routed at normal.
      const out = await h.spawn({ provider: "claude", title: "impl env" }, { env: { VS_PROFILE: "implement" } });
      assert.deepEqual(landed(out), { provider: C, model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" });
      assert.equal(out.env.VS_PROFILE, "Implement", "env carrier names the role label, as labels do");

      // The stakes label lands later (tierA-invariant would be tier=top); the agent really runs the mid rung.
      const agent = {
        id: "impl-env-1",
        title: "impl env",
        cwd: CWD,
        provider: out.config.provider,
        model: out.config.model,
        labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Implement", stakes: "tierA-invariant" },
      };
      await h.onCreated({ agent }, { paseo: paseoFor(agent) });
      assert.deepEqual(h.calls.refused, []);
      const last = stamped.filter((s) => s.id === "impl-env-1").at(-1);
      assert.ok(last, "agent.created stamped labels");
      assert.equal(last.labels.tier, "mid", "tier = the rung before() routed (normal), not top from the stakes label");
      assert.equal(last.labels.model, "claude-sonnet-5-5");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "label-only role spawn with no before() routing still takes its tier from the labels (Sonnet L1 fallback)",
  withEnv(async () => {
    const stamped = [];
    const h = harness({ cappedProviders: {}, setLabels: async (id, labels) => stamped.push({ id, labels }) });
    try {
      const agent = {
        id: "impl-lbl-1",
        title: "impl label only",
        cwd: CWD,
        provider: "claude",
        model: "claude-opus-5-5",
        labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Implement", stakes: "tierA-invariant" },
      };
      await h.onCreated({ agent }, { paseo: paseoFor(agent) });
      const last = stamped.filter((s) => s.id === "impl-lbl-1").at(-1);
      assert.ok(last, "agent.created stamped labels");
      assert.equal(last.labels.tier, "top");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "before()-configured env-only role spawn is not refused when a quota report flips before agent.created (Sonnet L2)",
  withEnv(async () => {
    let usage = [];
    const h = harness({ cappedProviders: {}, usageProviders: () => usage });
    try {
      const out = await h.spawn({ provider: "claude", title: "review env" }, { env: { VS_PROFILE: "Review" } });
      assert.equal(out.config.provider, A);
      // antigravity goes over quota between before() and agent.created: the role route would now say claude.
      usage = [{ id: "antigravity-cli", status: "exhausted", usedPct: 100 }];
      const agent = {
        id: "rev-env-1",
        title: "review env",
        cwd: CWD,
        provider: out.config.provider,
        model: out.config.model,
        labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Review" },
      };
      await h.onCreated({ agent }, { paseo: paseoFor(agent) });
      assert.deepEqual(h.calls.refused, [], "a spawn before() routed correctly is not re-routed after the fact");

      // Control: the same label-only agent that before() never saw is held to the (now flipped) route and refused.
      const other = { ...agent, id: "rev-env-2", title: "review label only" };
      await h.onCreated({ agent: other }, { paseo: paseoFor(other) });
      assert.deepEqual(h.calls.refused, ["rev-env-2"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "role spawn with every provider capped: route metric says reason=all-capped (Gemini L2)",
  withEnv(async () => {
    const h = harness({ cappedProviders: capMap([C, A, O]) });
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement") });
      assert.equal(out.labels.profile, "Implement");
      assert.match(String(out.labels[ROUTE_LABEL]), /reason=all-capped tier=\S+ role=implement/);
    } finally {
      h.stop?.();
    }
  }),
);

test("spawn-route units: roleMcpExtras (Gemini M2: role-name spawns take the role's tools for the landed provider)", () => {
  // Role names: the role's per-provider extras, else its own.
  for (const name of ["Implement", "Review", "Art Director", "Art Painter"]) assert.deepEqual(roleMcpExtras(name, USER_PROFILES, C), ["playwright"], name);
  assert.deepEqual(roleMcpExtras("Review", USER_PROFILES, A), ["playwright"]);
  // Implement on antigravity runs as the user file's "Implement - Gemini (trial)" mode, which has no extras.
  assert.deepEqual(roleMcpExtras("Implement", USER_PROFILES, A), []);
  assert.deepEqual(roleMcpExtras("Implement", undefined, A), ["playwright"], "no stored profiles: the shipped pack's modes");
  assert.deepEqual(roleMcpExtras("lead", USER_PROFILES, C), []);
  assert.deepEqual(roleMcpExtras("Pre-check", USER_PROFILES, A), []);
  // Not a role name: null (callers keep profileMcpExtras for old names).
  for (const name of ["Lead - Claude", "Implement - Sonnet", "Lead", "No Such Thing", ""]) assert.equal(roleMcpExtras(name, USER_PROFILES, C), null, name);
  // A copy: callers may mutate it.
  const a = roleMcpExtras("Review", USER_PROFILES, C);
  a.push("x");
  assert.deepEqual(roleMcpExtras("Review", USER_PROFILES, C), ["playwright"]);
});

test(
  "lead-handoff resolveLeadProfile: only the lead role respawns by role; usageProviders over quota are skipped (Gemini L1)",
  withEnv(async ({ profilesPath, vsHome }) => {
    const noDisk = { cappedProvidersPath: join(vsHome, "none.json"), cappedProviders: [] };
    // A worker role label on a lead falls back like any unknown profile name (not the Implement route).
    const impl = resolveLeadProfile({ provider: "claude", labels: { profile: "Implement" } }, profilesPath, noDisk);
    assert.notEqual(impl.profileName, "Implement");
    assert.equal(impl.profile.role, "lead");
    const bs = resolveLeadProfile({ provider: "claude", labels: { profile: "brainstorm" } }, profilesPath, noDisk);
    // "brainstorm" on a lead is not the lead role: no role route; findProfile's alias lookup decides, as for old names.
    assert.notEqual(bs.profileName, "brainstorm");
    assert.ok(legacyProfileRole(bs.profileName), `stored/old profile, got ${bs.profileName}`);
    // Quota reports (>=95%) skip the provider like a cap does.
    const over = resolveLeadProfile({ provider: "claude", labels: { profile: "lead" } }, profilesPath, {
      ...noDisk,
      usageProviders: [{ id: "claude", usedPct: 99 }],
    });
    assert.equal(over.profileName, "lead");
    assert.deepEqual([over.spawnCfg.provider, over.spawnCfg.model, over.spawnCfg.thinkingOptionId], [A, "gemini-4-neon", "high"]);
  }),
);

test(
  "brainstorm restart: a worker role label (lastProfile Implement) falls back, not the Implement route (Gemini L1)",
  withEnv(async ({ dir, vsHome, profilesPath }) => {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(dir, "docs", "brainstorm", "bug-chaser.md"), "# Brief\n\n## Open\n- x\n", "utf8");
    writeFileSync(
      process.env.VIBESQUAD_TEAMS_FILE,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "bug-chaser", name: "Bug Chaser", lastProfile: "Implement" }] }] }),
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
        cappedProviders: [],
        cappedProvidersPath: join(vsHome, "none.json"),
        backstopDelayMs: 60000,
      },
      dir,
    );
    assert.equal(created.length, 1);
    assert.notEqual(created[0].labels.profile, "Implement");
    assert.notEqual(created[0].config.model, "claude-sonnet-5-5", "not the Implement mid rung");
    assert.equal(created[0].labels.role, "brainstorm");
  }),
);

// ---- P5c Sonnet r2 lows (idea-77): leftover before() keys (L1), Gemini M1 hook pins (L2) ----

test(
  "agent.created consumes before()'s title::cwd keys: a second label-only role spawn with the same title::cwd is still enforced (Sonnet r2 L1)",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      // Refusal path: before() routed an env-only Review spawn (beforeConfiguredSpawns title::cwd key set).
      const out = await h.spawn({ provider: "claude", title: "dup review" }, { env: { VS_PROFILE: "Review" } });
      assert.equal(out.config.provider, A);
      const first = { id: "dup-rev-1", title: "dup review", cwd: CWD, provider: out.config.provider, model: out.config.model, labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Review" } };
      await h.onCreated({ agent: first }, { paseo: paseoFor(first) });
      assert.deepEqual(h.calls.refused, []);
      // Same title::cwd, label-only, wrong provider, never seen by before(): must be held to the route and refused.
      const second = { ...first, id: "dup-rev-2", provider: "claude", model: "claude-sonnet-5-5" };
      await h.onCreated({ agent: second }, { paseo: paseoFor(second) });
      assert.deepEqual(h.calls.refused, ["dup-rev-2"]);

      // Settings path: an explicit caller model at normal sets both the configured and the ladder title::cwd keys.
      const out2 = await h.spawn({ provider: "claude", title: "dup impl", model: "claude-opus-5-5" }, { env: { VS_PROFILE: "Implement" } });
      assert.equal(out2.config.model, "claude-opus-5-5", "explicit caller model kept");
      const a1 = { id: "dup-impl-1", title: "dup impl", cwd: CWD, provider: C, model: "claude-opus-5-5", thinkingOptionId: "medium", modeId: "auto", status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Implement" } };
      await h.onCreated({ agent: a1 }, { paseo: paseoFor(a1) });
      assert.deepEqual(h.calls.settings.filter((c) => c.agentId === "dup-impl-1"), [], "before()-configured explicit model is kept");
      // Same title::cwd, label-only, off-route model: neither the configured nor the ladder key may exempt it.
      const a2 = { ...a1, id: "dup-impl-2" };
      await h.onCreated({ agent: a2 }, { paseo: paseoFor(a2) });
      const fix = h.calls.settings.filter((c) => c.agentId === "dup-impl-2");
      assert.equal(fix.length, 1, "second spawn is enforced");
      assert.equal(fix[0].patch.model, "claude-sonnet-5-5");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "role route at normal stakes: a caller model/effort that differs from the route's pick is kept (reason=explicit / explicit+ladder) (Gemini M1)",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      // Implement at normal routes to claude-sonnet-5-5 / medium.
      const both = await h.spawn({ provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high" }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(both), { provider: C, model: "claude-opus-5-5", effort: "high", modeId: "auto" });
      assert.match(String(both.labels[ROUTE_LABEL]), /stakes=normal .*reason=explicit tier=mid role=implement/);

      const modelOnly = await h.spawn({ provider: "claude", model: "claude-opus-5-5" }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(modelOnly), { provider: C, model: "claude-opus-5-5", effort: "medium", modeId: "auto" });
      assert.match(String(modelOnly.labels[ROUTE_LABEL]), /reason=explicit\+ladder tier=mid role=implement/);

      const effortOnly = await h.spawn({ provider: "claude", thinkingOptionId: "low" }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(effortOnly), { provider: C, model: "claude-sonnet-5-5", effort: "low", modeId: "auto" });
      assert.match(String(effortOnly.labels[ROUTE_LABEL]), /reason=explicit\+ladder tier=mid role=implement/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "role route at normal stakes: a caller model/effort equal to the route's pick is not explicit (reason=default, not laddered) (Gemini M1)",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      const same = await h.spawn(
        { provider: "claude", title: "same pick", model: "claude-sonnet-5-5", thinkingOptionId: "medium" },
        { labels: LABELS("Implement") },
      );
      assert.deepEqual(landed(same), { provider: C, model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" });
      assert.match(String(same.labels[ROUTE_LABEL]), /reason=default tier=mid role=implement why=rung$/);
      assert.doesNotMatch(String(same.labels[ROUTE_LABEL]), /explicit/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "P5d C1: a saved v2 role changes where an Implement spawn lands (tier + provider order); the old name keeps today()",
  withEnv(async ({ profilesPath }) => {
    const h = harness({ cappedProviders: {} });
    try {
      const before = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(before), { provider: C, model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" });
      // Owner saves Implement as a top-tier role that prefers Gemini first, with a cleared Gemini effort.
      const impl = structuredClone(ROLE_TABLE.implement);
      saveRoles(
        {
          implement: {
            ...impl,
            tier: "top",
            providers: [A, C, O],
            modes: { ...impl.modes, [A]: { modeId: "accept-edits", effort: null } },
          },
        },
        profilesPath,
      );
      const after = await h.spawn({ provider: "claude" }, { labels: LABELS("Implement") });
      assert.equal(after.config.provider, A, JSON.stringify(landed(after)));
      assert.equal(after.config.modeId, "accept-edits");
      assert.equal(after.labels.tier, "top");
      assert.match(String(after.labels[ROUTE_LABEL]), /tier=top role=implement/);
      // A cap on the first provider walks the saved order, not the shipped one.
      const capped = harness({ cappedProviders: capMap([A]) });
      try {
        const walked = await capped.spawn({ provider: "claude" }, { labels: LABELS("Implement") });
        assert.equal(walked.config.provider, C);
        assert.equal(walked.config.model, "claude-opus-5-5");
      } finally {
        capped.stop?.();
      }
    } finally {
      h.stop?.();
    }
  }),
);

test("R1 spawn-route units: roleSpawnProfile/roleSpawnConfig prefer = the arm's provider first, model from the ladder rung", () => {
  const neon = roleSpawnConfig("Implement", { profiles: USER_PROFILES, prefer: "antigravity-cli" });
  assert.deepEqual([neon.profileName, neon.spawnCfg.provider, neon.spawnCfg.model, neon.spawnCfg.modeId, neon.route.reason], ["Implement", A, "gemini-4-neon", "accept-edits", "default"]);
  const sonnet = roleSpawnConfig("Implement", { profiles: USER_PROFILES, prefer: "claude" });
  assert.deepEqual([sonnet.spawnCfg.provider, sonnet.spawnCfg.model], [C, "claude-sonnet-5-5"]);
  for (const prefer of [undefined, "", "codex", "bogus"]) {
    const r = roleSpawnConfig("Implement", { profiles: USER_PROFILES, prefer });
    assert.deepEqual([r.spawnCfg.provider, r.spawnCfg.model], [C, "claude-sonnet-5-5"], String(prefer));
  }
  // A capped preferred family fails over along the role's own list (claude first), reason says so.
  const capped = roleSpawnProfile("Implement", { prefer: A, caps: [A] });
  assert.deepEqual([capped.profile.provider, capped.route.reason], [C, "failover"]);
  // Stakes still pick the tier on the preferred family; the shared ROLE_TABLE is never mutated.
  assert.equal(roleSpawnProfile("Implement", { prefer: A, stakes: "tierA-invariant" }).profile.thinkingOptionId, "high");
  assert.deepEqual(ROLE_TABLE.implement.providers, [C, A, O]);
  assert.equal(roleSpawnProfile("Implement - Sonnet", { prefer: A }), null, "old names never take a prefer");
});

test(
  "R1 hook: a role-name Implement spawn carrying vs.arm=neon runs on Gemini (ladder model), vs.arm=sonnet / none on Claude",
  withEnv(async () => {
    const h = harness({ cappedProviders: {} });
    try {
      const run = (extra) => h.spawn({ provider: "claude", model: "claude-sonnet-5-5" }, { labels: LABELS("Implement", { stakes: "normal", "vs.profile-derived": "model,thinking", ...extra }) });
      const n = await run({ "vs.arm": "neon", "vs.model": "gemini-4-neon" });
      assert.deepEqual([n.config.provider, n.config.model, n.labels.profile], [A, "gemini-4-neon", "Implement"]);
      for (const extra of [{ "vs.arm": "sonnet" }, {}]) {
        const s = await run(extra);
        assert.deepEqual([s.config.provider, s.config.model, s.labels.profile], [C, "claude-sonnet-5-5", "Implement"], JSON.stringify(extra));
      }
      // tierA stakes on the neon arm: top rung of the preferred family (arms only exist at normal, but the hook is pure routing).
      const t = await run({ "vs.arm": "neon", stakes: "tierA-invariant" });
      assert.equal(t.config.provider, A);
      // R8: vs.arm=flash routes a role-name Implement spawn onto the antigravity-cli cheap rung (gemini-3.8-flash).
      const f = await run({ "vs.arm": "flash", "vs.model": "gemini-3.8-flash" });
      assert.deepEqual([f.config.provider, f.config.model, f.labels.profile], [A, "gemini-3.8-flash", "Implement"]);
    } finally {
      h.stop?.();
    }
    const hc = harness({ cappedProviders: capMap([A]) });
    try {
      const c = await hc.spawn({ provider: "claude" }, { labels: LABELS("Implement", { stakes: "normal", "vs.arm": "neon" }) });
      assert.equal(c.config.provider, C, "a capped arm provider fails over along the role list");
      const cf = await hc.spawn({ provider: "claude" }, { labels: LABELS("Implement", { stakes: "normal", "vs.arm": "flash" }) });
      assert.deepEqual([cf.config.provider, cf.config.model], [C, "claude-sonnet-5-5"], "a capped flash arm fails over to Claude mid rung");
    } finally {
      hc.stop?.();
    }
  }),
);
