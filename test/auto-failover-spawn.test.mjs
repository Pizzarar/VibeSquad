import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../server/hooks/agent-duties.ts";

const PROFILES = [
  { name: "Lead - Claude", role: "lead", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Lead - Gemini",
    role: "lead",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
  },
  { name: "Brainstorm - Claude", role: "brainstorm", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Brainstorm - Gemini",
    role: "brainstorm",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
  },
];

const CWD = "/projects/VibeSquad/.worktrees/failover-test";

const SPEC = "# Artifact Lane Spec\n\n## Done when\n- the durable spec survives restarts & provider switches\n";
const TASKS = JSON.stringify({ tasks: [{ id: "t1", title: "write the thing", status: "todo" }] });

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-auto-failover-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });

    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({
        teams: [
          {
            id: "vibesquad",
            name: "VibeSquad",
            lanes: [
              { id: "vibesquad", paths: ["VibeSquad"] },
              { id: "artifact-lane", paths: [] },
            ],
            paths: ["VibeSquad"],
          },
        ],
      }),
      "utf8",
    );

    // A non-empty profiles file keeps loadStoredProfiles() from ever reaching ~/.paseo/config.json.
    writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: PROFILES }), "utf8");

    const briefRoot = join(dir, "repo");
    mkdirSync(join(briefRoot, "docs", "lanes", "artifact-lane"), { recursive: true });
    writeFileSync(join(briefRoot, "docs", "lanes", "artifact-lane", "SPEC.md"), SPEC, "utf8");
    writeFileSync(join(briefRoot, "docs", "lanes", "artifact-lane", "TASKS.json"), TASKS, "utf8");

    const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    try {
      await fn({ dir, vsHome, briefRoot });
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
  const stop = createPlugin({
    startWatcher: false,
    setLabels: async () => {},
    archiveAgent: async () => {},
    ...overrides,
  })(server);
  const spawn = async (config = {}, extra = {}) => {
    const req = { config: { cwd: CWD, ...config }, ...extra };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, spawn, onCreated: on.get("agent.created") };
}

test(
  "failover: claude over quota rewrites Lead - Claude -> Lead - Gemini and updates the profile label",
  withEnv(async () => {
    const h = harness({
      usageProviders: [
        { id: "claude", status: "ok", usedPct: 99, remainingPct: 1 },
        { id: "antigravity-cli", status: "ok", usedPct: 20, remainingPct: 80 },
      ],
    });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-opus-5-5" },
        { labels: { profile: "Lead - Claude", team: "vibesquad", lane: "vibesquad", role: "lead" } },
      );
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.config.model, "gemini-4-argon");
      assert.equal(out.labels.profile, "Lead - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "failover: claude over quota rewrites Brainstorm - Claude -> Brainstorm - Gemini",
  withEnv(async () => {
    const h = harness({
      usageProviders: [
        { id: "claude", status: "ok", usedPct: 98, remainingPct: 2 },
        { id: "antigravity-cli", status: "ok", usedPct: 10, remainingPct: 90 },
      ],
    });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-opus-5-5" },
        { labels: { profile: "Brainstorm - Claude", team: "vibesquad", lane: "vibesquad", role: "brainstorm" } },
      );
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.config.model, "gemini-4-argon");
      assert.equal(out.labels.profile, "Brainstorm - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "failover: deps.cappedProviders (map) marks claude exhausted and fails Lead - Claude over",
  withEnv(async () => {
    const h = harness({ cappedProviders: { claude: { capped: true } } });
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-opus-5-5" },
        { labels: { profile: "Lead - Claude", team: "vibesquad", lane: "vibesquad", role: "lead" } },
      );
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.labels.profile, "Lead - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "failover: on-disk ~/.vibesquad/capped-providers.json fails over without deps injection",
  withEnv(async ({ vsHome }) => {
    writeFileSync(join(vsHome, "capped-providers.json"), JSON.stringify({ claude: { capped: true } }), "utf8");
    const h = harness();
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-opus-5-5" },
        { labels: { profile: "Lead - Claude", team: "vibesquad", lane: "vibesquad", role: "lead" } },
      );
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.labels.profile, "Lead - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "no failover when no provider is capped or over quota",
  withEnv(async () => {
    const h = harness();
    try {
      const out = await h.spawn(
        { provider: "claude", model: "claude-opus-5-5" },
        { labels: { profile: "Lead - Claude", team: "vibesquad", lane: "vibesquad", role: "lead" } },
      );
      assert.equal(out.config.provider, "claude");
      assert.equal(out.labels.profile, "Lead - Claude");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "lane artifacts: SPEC.md + TASKS.json are injected for brainstorm, lead, and worker spawns",
  withEnv(async ({ briefRoot }) => {
    const h = harness({ briefRoot });
    try {
      for (const role of ["brainstorm", "lead", "worker"]) {
        const out = await h.spawn(
          { provider: "claude" },
          { labels: { role, team: "vibesquad", lane: "artifact-lane" } },
        );
        const sys = String(out.config.systemPrompt ?? "");
        assert.ok(sys.includes("<!-- vibesquad:lane-artifact:begin lane=artifact-lane -->"), `role=${role} marker`);
        assert.ok(sys.includes("the durable spec survives restarts & provider switches"), `role=${role} spec`);
        assert.ok(sys.includes("write the thing"), `role=${role} tasks`);
        assert.ok(sys.includes("<!-- vibesquad:lane-artifact:end -->"), `role=${role} end marker`);
      }
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "lane artifacts: no injection when the lane has no SPEC.md/TASKS.json",
  withEnv(async ({ briefRoot }) => {
    const h = harness({ briefRoot });
    try {
      const out = await h.spawn(
        { provider: "claude" },
        { labels: { role: "worker", team: "vibesquad", lane: "vibesquad" } },
      );
      const sys = String(out.config.systemPrompt ?? "");
      assert.ok(!sys.includes("<!-- vibesquad:lane-artifact:begin"), "no artifact block for a lane without SPEC/TASKS");
    } finally {
      h.stop?.();
    }
  }),
);
