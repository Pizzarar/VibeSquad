// PLAN_PER_POST03 P1 (idea-223): every spawn carries a `wf` workflow-arm label at dispatch; the caller's label wins.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";
import { deriveWfArm, normalizeWfLabel, resolveWfLabel } from "../server/wf-label.mjs";

// ---- pure derivation --------------------------------------------------------

test("deriveWfArm: every default pack profile maps to its arm", () => {
  const want = {
    "Lead - Claude": "opus",
    "Lead - Gemini": "gemini",
    "Brainstorm - Claude": "opus",
    "Brainstorm - Gemini": "gemini",
    "Spec - Opus": "opus",
    "Planner - Sonnet": "sonnet",
    "Implement - Sonnet": "sonnet",
    "Implement - Opus": "opus",
    "Work Order - DSP": "dsp",
    "Mechanical - DSF": "dsf",
    "Audit - DSF": "dsf",
    "Review - Sonnet": "sonnet",
    "Review - Gemini": "gemini",
    "Check - Haiku": "haiku",
    "Pre-check - Flash": "flash",
    "Scout - Flash": "flash",
    "Art Director - Gemini": "gemini",
    "Art Painter - Opus": "opus",
    "Senior Reasoning - DSP": "dsp",
    "UX Reviewer - Opus": "opus",
  };
  for (const p of DEFAULT_PACK_PROFILES) {
    if (!(p.name in want)) continue;
    assert.equal(deriveWfArm({ provider: p.provider, model: p.model, profile: p }), want[p.name], p.name);
  }
  // Every profile in the pack is covered, so a new one fails here until it gets an arm.
  assert.deepEqual(DEFAULT_PACK_PROFILES.map((p) => p.name).filter((n) => !(n in want)), []);
});

test("deriveWfArm: the resolved model beats the profile name (ladder upgrade, failover)", () => {
  const sonnet = { name: "Implement - Sonnet", provider: "claude", model: "claude-sonnet-5-5" };
  assert.equal(deriveWfArm({ provider: "claude", model: "claude-opus-5-5", profile: sonnet }), "opus");
  assert.equal(deriveWfArm({ provider: "antigravity-cli", model: "gemini-4-argon", profile: sonnet }), "gemini");
  assert.equal(deriveWfArm({ provider: "claude", model: "claude-fable-5-2" }), "fable");
  // No model: the profile's model, then its name.
  assert.equal(deriveWfArm({ provider: "claude", profile: sonnet }), "sonnet");
  assert.equal(deriveWfArm({ provider: "claude", profile: { name: "Implement - Opus" } }), "opus");
  assert.equal(deriveWfArm({ provider: "opencode", model: "deepseek/deepseek-v4-pro" }), "dsp");
  assert.equal(deriveWfArm({ model: "deepseek/deepseek-flash" }), "dsf");
  assert.equal(deriveWfArm({ provider: "agy", model: "gemini-3.8-flash" }), "flash");
  assert.equal(deriveWfArm({ provider: "claude" }), "claude");
  assert.equal(deriveWfArm({ provider: "codex", model: "gpt-x" }), "codex");
  assert.equal(deriveWfArm({}), "unknown");
});

test("resolveWfLabel: caller label > VS_WF env > derived; caller values are normalised", () => {
  const base = { provider: "claude", model: "claude-sonnet-5-5" };
  assert.equal(resolveWfLabel(base), "sonnet");
  assert.equal(resolveWfLabel({ ...base, env: { VS_WF: "dsp" } }), "dsp");
  assert.equal(resolveWfLabel({ ...base, labels: { wf: "Gemini-Full" }, env: { VS_WF: "dsp" } }), "gemini-full");
  assert.equal(resolveWfLabel({ ...base, labels: { wf: "  " } }), "sonnet");
  // R0: a Neon arm pick is wf=neon only when it runs on Gemini (non-flash); reviewers keep gemini; failover derives as usual.
  const neon = { provider: "antigravity-cli", model: "gemini-4-neon" };
  assert.equal(resolveWfLabel({ ...neon, labels: { "vs.arm": "neon" } }), "neon");
  assert.equal(resolveWfLabel(neon), "gemini");
  assert.equal(resolveWfLabel({ provider: "antigravity-cli", model: "gemini-3.8-flash", labels: { "vs.arm": "neon" } }), "flash");
  assert.equal(resolveWfLabel({ ...base, labels: { "vs.arm": "neon" } }), "sonnet");
  assert.equal(resolveWfLabel({ ...base, labels: { "vs.arm": "sonnet" } }), "sonnet");
  assert.equal(resolveWfLabel({ ...neon, labels: { "vs.arm": "neon", wf: "custom" } }), "custom");
  assert.equal(normalizeWfLabel("[wf:sonnet+gemini-review]"), "sonnet+gemini-review");
  assert.equal(normalizeWfLabel("a b/c"), "a-b-c");
  assert.equal(normalizeWfLabel("x".repeat(80)).length, 40);
});

// ---- before(agent.create) / agent.created -----------------------------------

const PROFILES = [
  { name: "Implement - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Lead - Gemini", role: "worker", provider: "antigravity-cli", model: "gemini-3.8-flash", modeId: "accept-edits", thinkingOptionId: "medium", featureValues: { approvalPolicy: "skip" } },
  { name: "Work Order - DSP", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-pro", modeId: "build", thinkingOptionId: "medium" },
];
const CWD = "/projects/VibeSquad/.worktrees/wf-test";

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-wf-hook-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }), "utf8");
    writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: PROFILES }), "utf8");
    const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    try {
      await fn({ dir, vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(overrides = {}) {
  const before = new Map();
  const on = new Map();
  const server = {
    before: (name, fn) => (before.set(name, fn), () => before.delete(name)),
    on: (name, fn) => (on.set(name, fn), () => on.delete(name)),
  };
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, ...overrides })(server);
  const spawn = async (config = {}, extra = {}) => {
    const req = { config: { cwd: CWD, ...config }, ...extra };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, spawn, onCreated: on.get("agent.created") };
}

const LABELS = (extra = {}) => ({ profile: "Implement - Sonnet", team: "vibesquad", lane: "vibesquad", role: "worker", ...extra });

test(
  "hook: default wf from the resolved profile/provider, stakes routing unchanged",
  withEnv(async () => {
    const h = harness();
    try {
      let out = await h.spawn({ provider: "claude" }, { labels: LABELS() });
      assert.equal(out.config.model, "claude-sonnet-5-5");
      assert.equal(out.labels.wf, "sonnet");
      // tierA routes Sonnet up to Opus (ladder unchanged): the stamp follows the model the agent will actually run.
      out = await h.spawn({ provider: "claude" }, { labels: LABELS({ stakes: "tierA-security" }) });
      assert.equal(out.config.model, "claude-opus-5-5");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.equal(out.labels.wf, "opus");
      out = await h.spawn({ provider: "opencode" }, { labels: LABELS({ profile: "Work Order - DSP" }) });
      assert.equal(out.labels.wf, "dsp");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: a failover spawn is stamped with the provider it ends up on",
  withEnv(async () => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS() });
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.labels.wf, "flash");
      // R0/R2: vs.model follows the model actually run (re-synced after failover) and is stamped on every routed spawn.
      const armed = await h.spawn({ provider: "claude", model: "claude-sonnet-5-5" }, { labels: LABELS({ "vs.arm": "sonnet", "vs.model": "claude-sonnet-5-5" }) });
      assert.equal(armed.labels["vs.model"], armed.config.model);
      assert.equal(armed.labels.model, armed.config.model);
      assert.notEqual(armed.labels["vs.model"], "claude-sonnet-5-5");
      assert.equal(out.labels["vs.model"], out.config.model);
      assert.ok(out.labels["vs.model"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: caller override wins (label, then VS_WF env) and does not change routing",
  withEnv(async () => {
    const h = harness();
    try {
      let out = await h.spawn({ provider: "claude" }, { labels: LABELS({ wf: "sonnet+gemini-review", stakes: "tierA-invariant" }), env: { VS_WF: "dsp" } });
      assert.equal(out.labels.wf, "sonnet+gemini-review");
      assert.equal(out.config.model, "claude-opus-5-5");
      out = await h.spawn({ provider: "claude" }, { labels: LABELS(), env: { VS_WF: "Gemini" } });
      assert.equal(out.labels.wf, "gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "agent.created: a spawn with no wf label (labels never reached before) is stamped; an existing wf is left alone",
  withEnv(async () => {
    const writes = [];
    const h = harness({ setLabels: async (id, labels) => writes.push({ id, labels }) });
    try {
      const mk = (id, labels) => ({ id, title: "Worker", cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium", labels });
      const a = mk("w-1", { team: "vibesquad", lane: "vibesquad", role: "worker" });
      await h.onCreated({ agent: a }, { paseo: { getAgent: async () => a } });
      assert.equal(writes.find((w) => w.id === "w-1")?.labels.wf, "opus");
      const b = mk("w-2", { team: "vibesquad", lane: "vibesquad", role: "worker", wf: "custom" });
      await h.onCreated({ agent: b }, { paseo: { getAgent: async () => b } });
      assert.ok(writes.filter((w) => w.id === "w-2").every((w) => w.labels.wf === undefined || w.labels.wf === "custom"));
    } finally {
      h.stop?.();
    }
  }),
);
