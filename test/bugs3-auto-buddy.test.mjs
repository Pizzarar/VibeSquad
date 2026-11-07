import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-bugs3-auto-buddy-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    mkdirSync(vsHome, { recursive: true });
    writeFileSync(
      join(dir, "docs", "brainstorm", "bug-chaser.md"),
      "# Brainstorm Summary · BUG CHASER (`bug-chaser`)\n\n## Who's here\n- Brainstorm: Bug Buddy\n\n## Done when\n- All batch 3 bugs fixed\n\n## Decided\n- Always a Buddy waiting\n\n## Open\n- none\n\n## In flight\n- Block 0\n",
      "utf8",
    );
    const prevHome = process.env.VIBESQUAD_HOME;
    process.env.VIBESQUAD_HOME = vsHome;
    resetBrainstormRestartState();
    try {
      await fn({ dir, vsHome });
    } finally {
      resetBrainstormRestartState();
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "Block 0: auto retire spawns successor in same slot with same profile, small first-turn prompt, retired old Buddy, and successor=<id> metric",
  withEnv(async ({ dir, vsHome }) => {
    const agents = new Map([
      [
        "bs-old",
        {
          id: "bs-old",
          title: "Bug Buddy",
          provider: "claude",
          model: "claude-opus-5-5",
          cwd: dir,
          status: "idle",
          labels: {
            team: "vibesquad",
            lane: "bug-chaser",
            role: "brainstorm",
            profile: "Brainstorm - Claude",
          },
        },
      ],
    ]);
    const createdPayloads = [];
    const daemon = {
      async fetchAgents() {
        return {
          entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })),
        };
      },
      async fetchAgent(id) {
        return { agent: agents.get(id) ?? null };
      },
      async createAgent(payload) {
        createdPayloads.push(payload);
        const created = {
          id: "bs-new-1",
          ...payload.config,
          labels: { ...payload.labels },
          status: "idle",
        };
        agents.set(created.id, created);
        return created;
      },
      async cancelAgent() {},
      async detachAgent() {},
      async updateAgent(id, { name, labels }) {
        const a = agents.get(id);
        if (a) {
          if (name) a.title = name;
          if (labels) a.labels = { ...a.labels, ...labels };
        }
      },
      async archiveAgent(id) {
        const a = agents.get(id);
        if (a) a.archivedAt = new Date().toISOString();
      },
    };

    const res = await performBrainstormRestart(
      {
        agentId: "bs-old",
        teamId: "vibesquad",
        laneId: "bug-chaser",
        reason: "auto-150k",
        usedTokens: 162000,
        oldAgent: agents.get("bs-old"),
        agentClient: daemon,
        backstopDelayMs: 60000,
      },
      dir,
    );

    assert.equal(res.ok, true);
    assert.equal(res.retired, true);
    assert.equal(res.newAgentId, "bs-new-1");
    assert.equal(createdPayloads.length, 1);
    assert.equal(createdPayloads[0].labels.profile, "Brainstorm - Claude");
    assert.ok(
      createdPayloads[0].initialPrompt.includes("--- BEGIN docs/brainstorm/bug-chaser.md ---"),
      "brief inlined in initialPrompt",
    );
    assert.ok(
      createdPayloads[0].initialPrompt.includes("Keep this first turn small: read the brief above, then wait for the user."),
      "auto-retire successor keeps first turn small",
    );

    const liveBrainstorms = [...agents.values()].filter(
      (a) => !a.archivedAt && a.labels?.role === "brainstorm",
    );
    assert.equal(liveBrainstorms.length, 1);
    assert.equal(liveBrainstorms[0].id, "bs-new-1");

    const old = agents.get("bs-old");
    assert.equal(old.labels.role, "former-brainstorm");
    assert.ok(old.title.startsWith("(old)"));
    assert.ok(old.archivedAt);

    const logFile = join(vsHome, "teams", "vibesquad", "log.jsonl");
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    const retiredMetric = entries.find((e) => e.type === "metric" && e.text.startsWith("brainstorm-retired"));
    assert.ok(retiredMetric, "brainstorm-retired metric logged");
    assert.equal(retiredMetric.text, "brainstorm-retired (auto-150k): 162000 tok, successor=bs-new-1");
  }),
);

test(
  "Block 0: topic Buddy auto retire spawns a topic successor with matching topic label",
  withEnv(async ({ dir }) => {
    const agents = new Map([
      [
        "bs-topic-old",
        {
          id: "bs-topic-old",
          title: "Bug Buddy · icons",
          provider: "antigravity-cli",
          model: "gemini-4-argon",
          cwd: dir,
          status: "idle",
          labels: {
            team: "vibesquad",
            lane: "bug-chaser",
            topic: "icons",
            role: "brainstorm",
            profile: "Brainstorm - Gemini",
          },
        },
      ],
    ]);
    const daemon = {
      async fetchAgents() {
        return {
          entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })),
        };
      },
      async createAgent(payload) {
        const created = {
          id: "bs-topic-new",
          ...payload.config,
          labels: { ...payload.labels },
          status: "idle",
        };
        agents.set(created.id, created);
        return created;
      },
      async cancelAgent() {},
      async detachAgent() {},
      async updateAgent(id, { name, labels }) {
        const a = agents.get(id);
        if (a) {
          if (name) a.title = name;
          if (labels) a.labels = { ...a.labels, ...labels };
        }
      },
      async archiveAgent(id) {
        const a = agents.get(id);
        if (a) a.archivedAt = new Date().toISOString();
      },
    };

    const res = await performBrainstormRestart(
      {
        agentId: "bs-topic-old",
        teamId: "vibesquad",
        laneId: "bug-chaser",
        reason: "auto-hard-limit",
        usedTokens: 155000,
        oldAgent: agents.get("bs-topic-old"),
        agentClient: daemon,
        backstopDelayMs: 60000,
      },
      dir,
    );

    assert.equal(res.newAgentId, "bs-topic-new");
    const created = agents.get("bs-topic-new");
    assert.equal(created.labels.topic, "icons");
    assert.equal(created.labels.profile, "Brainstorm - Gemini");
    assert.ok(created.title.includes("icons"), created.title);
  }),
);
