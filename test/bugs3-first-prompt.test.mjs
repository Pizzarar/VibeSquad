import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../plugin/index.server.ts";

const CWD = "/projects/VibeSquad/.worktrees/unit-bugs3-block12";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-first-prompt-test-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({
        teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }],
      }),
      "utf8",
    );
    const profilesFile = join(vsHome, "profiles.json");
    writeFileSync(profilesFile, JSON.stringify({ profiles: [] }), "utf8");
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesFile;
    try {
      await fn({ vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function readMetrics(vsHome) {
  const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "metric")
    .map((e) => e.text);
}

function makeFakeDaemon(agents, { firstPromptRedeliverMs = 40, timelineEntries = [] } = {}) {
  const before = new Map();
  const on = new Map();
  const sent = [];
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
    firstPromptRedeliverMs,
    setLabels: async (agentId, labels) => {
      const a = agents.get(agentId);
      if (a) a.labels = { ...(a.labels ?? {}), ...labels };
    },
    archiveAgent: async () => {},
  })(server);

  const paseo = {
    agents: {
      ref(id) {
        return {
          async refresh() {
            const a = agents.get(id);
            return a ? { agent: a } : null;
          },
          async send(text) {
            sent.push({ id, text });
            const a = agents.get(id);
            if (a) {
              a.status = "running";
              a.lastUserMessageAt = new Date().toISOString();
            }
          },
          async detach() {},
          timeline: {
            async refetch() {
              return { entries: timelineEntries };
            },
          },
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent })) };
      },
    },
  };

  return {
    stop,
    sent,
    paseo,
    beforeCreate(req) {
      return before.get("agent.create")({ request: req }) ?? req;
    },
    onCreated(agent) {
      return on.get("agent.created")({ agent }, { paseo });
    },
    onTurnStarted(agent) {
      return on.get("agent.turn_started")({ agent }, { paseo });
    },
    onTurnEnded(agent, outcome = { kind: "completed" }) {
      return on.get("agent.turn_ended")({ agent, turnId: "t1", outcome }, { paseo });
    },
  };
}

test(
  "Block 2a: idle 0-token agent after window receives remembered initial prompt once and logs first-prompt-redelivered",
  withEnv(async ({ vsHome }) => {
    const agent = {
      id: "e144a692",
      title: "Bug4 · worker task",
      cwd: CWD,
      provider: "claude",
      status: "idle",
      lastUsage: { contextWindowUsedTokens: 0, inputTokens: 0 },
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    };
    const agents = new Map([[agent.id, agent]]);
    const d = makeFakeDaemon(agents, { firstPromptRedeliverMs: 40 });
    try {
      d.beforeCreate({
        config: { cwd: CWD, provider: "claude", title: agent.title },
        prompt: "Fix the bug and report PASS.",
      });
      await d.onCreated({ id: agent.id, title: agent.title, cwd: CWD, provider: "claude" });
      // Duplicate created event must never cause a double send
      await d.onCreated({ id: agent.id, title: agent.title, cwd: CWD, provider: "claude" });
      await wait(110);

      assert.deepEqual(d.sent, [{ id: "e144a692", text: "Fix the bug and report PASS." }]);
      const m = readMetrics(vsHome).filter((t) => t.startsWith("first-prompt-redelivered"));
      assert.deepEqual(m, ["first-prompt-redelivered: agent=e144a692"]);
    } finally {
      d.stop?.();
    }
  }),
);

test(
  "Block 2a: agent that already started a turn or used tokens is never sent a duplicate prompt",
  withEnv(async ({ vsHome }) => {
    const aStarted = {
      id: "dc04af78",
      title: "Bug4 · started worker",
      cwd: CWD,
      provider: "claude",
      status: "idle",
      lastUsage: { contextWindowUsedTokens: 0, inputTokens: 0 },
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    };
    const aTokens = {
      id: "dc04af79",
      title: "Bug4 · token worker",
      cwd: CWD,
      provider: "claude",
      status: "idle",
      lastUsage: { contextWindowUsedTokens: 1200, inputTokens: 400 },
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    };
    const agents = new Map([
      [aStarted.id, aStarted],
      [aTokens.id, aTokens],
    ]);
    const d = makeFakeDaemon(agents, { firstPromptRedeliverMs: 40 });
    try {
      d.beforeCreate({
        config: { cwd: CWD, provider: "claude", title: aStarted.title },
        prompt: "Task 1",
      });
      await d.onCreated({ id: aStarted.id, title: aStarted.title, cwd: CWD, provider: "claude" });
      await d.onTurnStarted({ id: aStarted.id });

      d.beforeCreate({
        config: { cwd: CWD, provider: "claude", title: aTokens.title },
        prompt: "Task 2",
      });
      await d.onCreated({ id: aTokens.id, title: aTokens.title, cwd: CWD, provider: "claude" });

      await wait(110);
      assert.deepEqual(d.sent, []);
      assert.deepEqual(
        readMetrics(vsHome).filter((t) => t.startsWith("first-prompt-redelivered")),
        [],
      );
    } finally {
      d.stop?.();
    }
  }),
);
