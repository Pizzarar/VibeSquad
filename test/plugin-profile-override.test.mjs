import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin, LEAD_FALLBACK_PACK, matchStoredProfile, resolveStoredProfile } from "../server/hooks/agent-duties.ts";

const PROFILES = [
  {
    name: "Worker - Opus",
    role: "worker",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "high",
    featureValues: { fast: false, shared: "profile" },
  },
  { name: "Worker - Codex", role: "worker", provider: "codex", model: "gpt-5.5", modeId: "full-access", thinkingOptionId: "medium" },
  { name: "Worker - Gemini", role: "worker", provider: "antigravity-cli", model: "gemini-3.8-pro" },
  { name: "Lead - Claude", role: "lead", provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" },
];

const CWD = "/projects/VibeSquad/.worktrees/profile-test";

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-profile-override-test-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
      "utf8",
    );
    const profilesFile = join(vsHome, "profiles.json");
    writeFileSync(profilesFile, JSON.stringify({ profiles: PROFILES }), "utf8");
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesFile;
    try {
      await fn({ dir, vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function metrics(vsHome) {
  const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "metric" && e.text.startsWith("profile-override"))
    .map((e) => e.text);
}

function harness(agents = new Map()) {
  const before = new Map();
  const on = new Map();
  const calls = { settings: [], refused: [], labels: [], archived: [] };
  const server = {
    before(name, fn) {
      before.set(name, fn);
      return () => before.delete(name);
    },
    on(name, fn) {
      on.set(name, fn);
      return () => on.delete(name);
    },
  };
  const stop = createPlugin({
    startWatcher: false,
    setLabels: async (agentId, labels) => {
      calls.labels.push({ agentId, labels });
    },
    archiveAgent: async (id) => {
      calls.archived.push(id);
    },
    applyAgentSettings: async (agentId, patch) => {
      calls.settings.push({ agentId, patch });
    },
    refuseAgent: async (agentId) => {
      calls.refused.push(agentId);
    },
  })(server);
  const paseo = {
    agents: {
      ref(id) {
        return {
          async refresh() {
            const a = agents.get(id);
            return a ? { agent: a } : null;
          },
          async archive() {},
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent })) };
      },
    },
  };
  const create = async (config, env) => {
    const req = { config: { cwd: CWD, ...config }, ...(env ? { env } : {}) };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, create, onCreated: on.get("agent.created"), calls, paseo };
}

test("matchStoredProfile reports explicit vs fuzzy; resolveStoredProfile keeps its signature", () => {
  assert.deepEqual(matchStoredProfile("worker - codex", "", "", "worker", PROFILES), { profile: PROFILES[1], explicit: true });
  assert.equal(matchStoredProfile("", "", "Worker - Opus · thing", "worker", PROFILES).explicit, false);
  assert.equal(matchStoredProfile("", "claude", "", "lead", PROFILES).explicit, false);
  assert.equal(matchStoredProfile("No Such Profile", "", "", "worker", PROFILES), null);
  assert.equal(resolveStoredProfile("Worker - Codex", "", "", "worker", PROFILES), PROFILES[1]);
});

test(
  "explicit profile (env VS_PROFILE) overrides provider, model, mode and thinking",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await h.create(
        { provider: "claude", model: "claude-sonnet-5-5", modeId: "default", thinkingOptionId: "low", title: "some worker" },
        { VS_PROFILE: "Worker - Codex" },
      );
      assert.equal(out.config.provider, "codex");
      assert.equal(out.config.model, "gpt-5.5");
      assert.equal(out.config.modeId, "full-access");
      assert.equal(out.config.thinkingOptionId, "medium");
      const m = metrics(vsHome);
      for (const field of ["provider", "model", "mode", "thinking"]) {
        assert.ok(m.some((t) => t.includes(`field=${field}`) && t.includes("profile=Worker - Codex")), `metric for ${field}`);
      }
      assert.ok(m.some((t) => t === "profile-override: agent=some worker profile=Worker - Codex field=provider caller=claude profile=codex"));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "provider/model in one string is split before comparing",
  withEnv(async () => {
    const h = harness();
    try {
      const out = await h.create({ provider: "claude/claude-opus-5-5", title: "x" }, { VS_PROFILE: "Worker - Opus" });
      assert.equal(out.config.provider, "claude");
      assert.equal(out.config.model, "claude-opus-5-5");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "title-only and role-default matches never override caller values",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const byTitle = await h.create({
        provider: "claude",
        model: "claude-sonnet-5-5",
        modeId: "default",
        thinkingOptionId: "low",
        title: "Worker - Opus · refactor",
      });
      assert.equal(byTitle.config.model, "claude-sonnet-5-5");
      assert.equal(byTitle.config.modeId, "default");
      assert.equal(byTitle.config.thinkingOptionId, "low");

      const byRole = await h.create(
        { provider: "claude", model: "claude-haiku-5-5", modeId: "plan", title: "anything" },
        { VS_ROLE: "lead" },
      );
      assert.equal(byRole.config.model, "claude-haiku-5-5");
      assert.equal(byRole.config.modeId, "plan");
      assert.equal(byRole.config.thinkingOptionId, "high", "role default still fills a blank");
      assert.deepEqual(metrics(vsHome), []);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "featureValues merge: profile keys win, caller-only keys stay",
  withEnv(async () => {
    const h = harness();
    try {
      const out = await h.create(
        { provider: "claude", model: "claude-opus-5-5", featureValues: { fast: true, shared: "caller", mine: 1 }, title: "x" },
        { VS_PROFILE: "Worker - Opus" },
      );
      assert.deepEqual(out.config.featureValues, { fast: false, shared: "profile", mine: 1 });
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "antigravity defaults key off the final provider",
  withEnv(async () => {
    const h = harness();
    try {
      const toAgy = await h.create({ provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", title: "x" }, { VS_PROFILE: "Worker - Gemini" });
      assert.equal(toAgy.config.provider, "antigravity-cli");
      assert.equal(toAgy.config.featureValues?.approvalPolicy, "skip");
      assert.equal(toAgy.config.modeId, undefined, "caller's claude mode is dropped on a provider swap; no forced accept-edits (row 4 gone)");

      const fromAgy = await h.create({ provider: "antigravity-cli", model: "gemini-3.8-pro", title: "x" }, { VS_PROFILE: "Worker - Codex" });
      assert.equal(fromAgy.config.provider, "codex");
      assert.equal(fromAgy.config.featureValues?.approvalPolicy, undefined);
      assert.equal(fromAgy.config.modeId, "full-access");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "profile-override keeps the caller's values and logs kept=caller",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const out = await h.create(
        { provider: "claude", model: "claude-sonnet-5-5", modeId: "default", title: "one-off" },
        { VS_PROFILE: "Worker - Opus", VS_PROFILE_OVERRIDE: "1" },
      );
      assert.equal(out.config.model, "claude-sonnet-5-5");
      assert.equal(out.config.modeId, "default");
      const m = metrics(vsHome);
      assert.ok(m.some((t) => t.includes("field=model") && t.endsWith("kept=caller")));
      assert.ok(m.some((t) => t.includes("field=mode") && t.endsWith("kept=caller")));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "label-only spawn: agent.created switches model/mode/thinking to the profile",
  withEnv(async ({ vsHome }) => {
    const agents = new Map([
      [
        "a1",
        {
          id: "a1",
          title: "label worker",
          cwd: CWD,
          provider: "claude",
          model: "claude-sonnet-5-5",
          currentModeId: "default",
          thinkingOptionId: "high",
          labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Worker - Opus" },
        },
      ],
    ]);
    const h = harness(agents);
    try {
      await h.onCreated({ agent: { id: "a1", title: "label worker", cwd: CWD, provider: "claude" } }, { paseo: h.paseo });
      assert.deepEqual(h.calls.settings, [{ agentId: "a1", patch: { model: "claude-opus-5-5", modeId: "bypassPermissions" } }]);
      assert.deepEqual(h.calls.refused, []);
      const m = metrics(vsHome);
      assert.ok(m.some((t) => t.includes("agent=label worker") && t.includes("field=model")));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "label-only spawn on the wrong provider is refused and does nothing else",
  withEnv(async ({ vsHome }) => {
    const agents = new Map([
      [
        "a2",
        {
          id: "a2",
          title: "LEAD · wrong",
          cwd: CWD,
          provider: "claude",
          model: "claude-opus-5-5",
          currentModeId: "bypassPermissions",
          labels: { team: "vibesquad", lane: "vibesquad", role: "lead", profile: "Worker - Codex" },
        },
      ],
    ]);
    const h = harness(agents);
    try {
      await h.onCreated({ agent: { id: "a2", title: "LEAD · wrong", cwd: CWD, provider: "claude" } }, { paseo: h.paseo });
      assert.deepEqual(h.calls.refused, ["a2"]);
      assert.deepEqual(h.calls.settings, []);
      assert.deepEqual(h.calls.labels, [], "a refused agent must not relabel or retire anyone");
      assert.ok(metrics(vsHome).some((t) => t.includes("field=provider caller=claude profile=codex action=refused")));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "label-only spawn with profile-override label is left alone",
  withEnv(async ({ vsHome }) => {
    const agents = new Map([
      [
        "a3",
        {
          id: "a3",
          title: "one-off",
          cwd: CWD,
          provider: "claude",
          model: "claude-sonnet-5-5",
          currentModeId: "default",
          labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Worker - Codex", "profile-override": "1" },
        },
      ],
    ]);
    const h = harness(agents);
    try {
      await h.onCreated({ agent: { id: "a3", title: "one-off", cwd: CWD, provider: "claude" } }, { paseo: h.paseo });
      assert.deepEqual(h.calls.refused, []);
      assert.deepEqual(h.calls.settings, []);
      assert.ok(metrics(vsHome).some((t) => t.includes("field=provider") && t.endsWith("kept=caller")));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "an agent already matching its profile is not touched",
  withEnv(async ({ vsHome }) => {
    const agents = new Map([
      [
        "a4",
        {
          id: "a4",
          title: "fine",
          cwd: CWD,
          provider: "codex",
          model: "gpt-5.5",
          currentModeId: "full-access",
          thinkingOptionId: "medium",
          labels: { team: "vibesquad", lane: "vibesquad", role: "worker", profile: "Worker - Codex" },
        },
      ],
    ]);
    const h = harness(agents);
    try {
      await h.onCreated({ agent: { id: "a4", title: "fine", cwd: CWD, provider: "codex" } }, { paseo: h.paseo });
      assert.deepEqual(h.calls.settings, []);
      assert.deepEqual(h.calls.refused, []);
      assert.deepEqual(metrics(vsHome), []);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Block 1: antigravity reviewer spawn with missing features still gets approvalPolicy=skip, and lead docs omit features",
  withEnv(async () => {
    const h = harness();
    try {
      const reviewer = await h.create({
        provider: "antigravity-cli",
        model: "gemini-3.8-pro",
        title: "Bug4 · review batch 3",
      });
      assert.equal(reviewer.config.provider, "antigravity-cli");
      assert.equal(reviewer.config.featureValues?.approvalPolicy, "skip");
      assert.equal(reviewer.config.modeId, undefined);

      assert.ok(LEAD_FALLBACK_PACK.includes("no `features`"));
      assert.ok(!LEAD_FALLBACK_PACK.includes("approvalPolicy"));
      const rolePacksDoc = readFileSync(new URL("../docs/ROLE_PACKS.md", import.meta.url), "utf8");
      assert.ok(rolePacksDoc.includes("omit `features`"));
      assert.ok(!rolePacksDoc.includes("approvalPolicy"));
    } finally {
      h.stop?.();
    }
  }),
);
