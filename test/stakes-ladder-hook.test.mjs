import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { callTool } from "../server/mcp/tools.mjs";
import { toPaseoSpawnConfig } from "../server/profiles.mjs";

const PROFILES = [
  { name: "Implement - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Lead - Gemini",
    role: "worker",
    provider: "antigravity-cli",
    model: "gemini-3.8-flash",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
  },
];

const CWD = "/projects/VibeSquad/.worktrees/stakes-test";

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-stakes-hook-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
      "utf8",
    );
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
const routeMetrics = (vsHome) => {
  try {
    return readFileSync(join(vsHome, "teams", "vibesquad", "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => String(e.text).startsWith("route:"))
      .map((e) => e.text);
  } catch {
    return [];
  }
};

test(
  "hook: claude + tierA-security -> fable-5-1/high, route metric reason=ladder",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS({ stakes: "tierA-security" }) });
      assert.equal(out.config.model, "claude-fable-5-1");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.deepEqual(routeMetrics(vsHome), ["route: stakes=tierA-security model=claude-fable-5-1 effort=high reason=ladder"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: env VS_STAKES is the fallback when no stakes label",
  withEnv(async () => {
    const h = harness();
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS(), env: { VS_STAKES: "mechanical" } });
      assert.equal(out.config.model, "claude-sonnet-5-5");
      assert.equal(out.config.thinkingOptionId, "low");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: capped claude + tierA-invariant -> failover provider's rung",
  withEnv(async ({ vsHome }) => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS({ stakes: "tierA-invariant" }) });
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.config.model, "gemini-4-argon");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.match(routeMetrics(vsHome)[0], /stakes=tierA-invariant model=gemini-4-argon effort=high reason=ladder/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: capped claude with no stakes logs reason=failover and keeps the failover profile",
  withEnv(async ({ vsHome }) => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn({ provider: "claude" }, { labels: LABELS() });
      assert.equal(out.config.model, "gemini-3.8-flash");
      assert.match(routeMetrics(vsHome)[0], /reason=failover/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: an explicit model is kept (profile-override), reason=explicit",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-haiku-5-5", thinkingOptionId: "low" },
        { labels: LABELS({ stakes: "tierA-security", "profile-override": "1" }) },
      );
      assert.equal(out.config.model, "claude-haiku-5-5");
      assert.equal(out.config.thinkingOptionId, "low");
      assert.match(routeMetrics(vsHome)[0], /reason=explicit/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: missing or unknown stakes leaves the profile unchanged, reason=default",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      for (const labels of [LABELS(), LABELS({ stakes: "bogus" })]) {
        const out = await h.spawn({ provider: "claude" }, { labels });
        assert.equal(out.config.model, "claude-sonnet-5-5");
        assert.equal(out.config.thinkingOptionId, "medium");
      }
      const m = routeMetrics(vsHome);
      assert.equal(m.length, 2);
      assert.ok(m.every((t) => t === "route: stakes=normal model=claude-sonnet-5-5 effort=medium reason=default"));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: profile label + explicit model + stakes (no profile-override) keeps the explicit model over profile and ladder",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-haiku-5-5", thinkingOptionId: "low" },
        { labels: LABELS({ stakes: "tierA-security" }) },
      );
      assert.equal(out.config.model, "claude-haiku-5-5");
      assert.equal(out.config.thinkingOptionId, "low");
      assert.match(routeMetrics(vsHome)[0], /stakes=tierA-security model=claude-haiku-5-5 effort=low reason=explicit/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "agent.created after a laddered spawn: enforceProfileAfterSpawn keeps the ladder's model/effort",
  withEnv(async () => {
    const applied = [];
    const h = harness({ applyAgentSettings: async (id, patch) => applied.push({ id, patch }) });
    try {
      // Label-less before-hook spawn (stakes via env only, no profile), as with MCP create_agent: the profile arrives by label after creation.
      const out = await h.spawn(
        { provider: "claude", title: "Worker" },
        { labels: { team: "vibesquad", lane: "vibesquad", role: "worker" }, env: { VS_STAKES: "tierA-security" } },
      );
      assert.equal(out.config.model, "claude-fable-5-1");
      const labels = LABELS({ stakes: "tierA-security" });
      const agent = {
        id: "w-1",
        title: "Worker",
        cwd: CWD,
        status: "idle",
        provider: "claude",
        model: "claude-fable-5-1",
        modeId: "auto",
        thinkingOptionId: "high",
        labels,
      };
      await h.onCreated({ agent }, { paseo: { getAgent: async () => agent } });
      assert.deepEqual(applied, [], "ladder model/effort must not be reverted to the profile's");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "hook: capped claude + explicit claude model + tierA -> failover provider's rung, reason=ladder",
  withEnv(async ({ vsHome }) => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-haiku-5-5", thinkingOptionId: "low" },
        { labels: LABELS({ stakes: "tierA-invariant" }) },
      );
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.config.model, "gemini-4-argon");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.match(routeMetrics(vsHome)[0], /model=gemini-4-argon effort=high reason=ladder/);
    } finally {
      h.stop?.();
    }
  }),
);

// End to end: the spawn_worker handler builds the create request, the real before.agent.create hook routes it.
async function viaSpawnWorker(h, args) {
  let out;
  const ctx = {
    identity: { agentId: "rn-lead", team: "vibesquad", lane: "vibesquad", role: "lead" },
    cwd: CWD,
    loadProfiles: async () => PROFILES,
    resolveProfile: async (name) => {
      const profile = PROFILES.find((p) => p.name === name);
      return profile ? { profile, spawn: toPaseoSpawnConfig(profile, {}, PROFILES) } : null;
    },
    writeLog: async () => {},
    withBackend: async (_o, fn) =>
      fn({ createAgent: async (req) => ((out = await h.spawn(req.config, { labels: req.labels, env: req.env })), { id: "rn-new" }) }),
  };
  await callTool(ctx, "spawn_worker", { title: "W", prompt: "x", profile: "Implement - Sonnet", ...args });
  return out;
}

test(
  "e2e spawn_worker: profile + stakes tierA-security, no explicit -> fable-5-1/high, reason=ladder",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await viaSpawnWorker(h, { stakes: "tierA-security" });
      assert.equal(out.config.model, "claude-fable-5-1");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.deepEqual(routeMetrics(vsHome), ["route: stakes=tierA-security model=claude-fable-5-1 effort=high reason=ladder"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "e2e spawn_worker: explicit model + thinkingOptionId=high are kept, reason=explicit",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await viaSpawnWorker(h, { stakes: "tierA-invariant", provider: "claude", model: "claude-haiku-5-5", thinkingOptionId: "high" });
      assert.equal(out.config.model, "claude-haiku-5-5");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.deepEqual(routeMetrics(vsHome), ["route: stakes=tierA-invariant model=claude-haiku-5-5 effort=high reason=explicit"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "e2e spawn_worker: no stakes -> profile's model/effort, reason=default",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await viaSpawnWorker(h, {});
      assert.equal(out.config.model, "claude-sonnet-5-5");
      assert.equal(out.config.thinkingOptionId, "medium");
      assert.deepEqual(routeMetrics(vsHome), ["route: stakes=normal model=claude-sonnet-5-5 effort=medium reason=default"]);
    } finally {
      h.stop?.();
    }
  }),
);

test("create_agent with no profile: provider + model + thinkingOptionId=high (and the `thinking` alias) reach the create config", async () => {
  const seen = [];
  const ctx = {
    identity: { agentId: "rn-lead", team: "vibesquad", lane: "vibesquad", role: "lead" },
    cwd: CWD,
    loadProfiles: async () => [],
    resolveProfile: async () => null,
    writeLog: async () => {},
    withBackend: async (_o, fn) => fn({ createAgent: async (req) => (seen.push(req), { id: "rn-new" }) }),
  };
  await callTool(ctx, "create_agent", { title: "W", prompt: "x", provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high" });
  await callTool(ctx, "create_agent", { title: "W2", prompt: "x", provider: "claude", model: "claude-opus-5-5", thinking: "low" });
  assert.equal(seen[0].config.thinkingOptionId, "high");
  assert.equal(seen[1].config.thinkingOptionId, "low");
  assert.equal(seen[0].labels["vs.profile-derived"], undefined);
});
