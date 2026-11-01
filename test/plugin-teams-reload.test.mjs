import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../plugin/index.server.ts";

function writeTeams(file, vibesquadLanes) {
  writeFileSync(
    file,
    JSON.stringify(
      {
        teams: [
          {
            id: "vibesquad",
            name: "VibeSquad",
            lanes: vibesquadLanes,
            paths: ["VibeSquad"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-teams-reload-test-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeTeams(teamsFile, [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] }]);
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    try {
      await fn({ dir, teamsFile });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(agents) {
  const onHandlers = new Map();
  const labelUpdates = [];
  const server = {
    before() {
      return () => {};
    },
    on(event, fn) {
      onHandlers.set(event, fn);
      return () => onHandlers.delete(event);
    },
  };
  const stop = createPlugin({
    startWatcher: false,
    setLabels: async (agentId, labels) => {
      labelUpdates.push({ agentId, labels });
      const a = agents.get(agentId);
      if (a) a.labels = { ...labels };
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
          async archive() {},
          async update() {},
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent })) };
      },
    },
  };
  return { stop, onCreated: onHandlers.get("agent.created"), labelUpdates, paseo };
}

const CWD = "/projects/VibeSquad/.worktrees/pins-walk";

test(
  "a lane registered after the plugin loads keeps its label on spawn",
  withEnv(async ({ teamsFile }) => {
    const agents = new Map([
      ["w1", { id: "w1", title: "PINNED · walk", cwd: CWD, labels: { team: "vibesquad", lane: "pinned", role: "worker" } }],
    ]);
    const h = harness(agents);
    try {
      writeTeams(teamsFile, [
        { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] },
        { id: "pinned", name: "Pinned Teams", paths: ["VibeSquad"] },
      ]);
      await h.onCreated({ agent: agents.get("w1") }, { paseo: h.paseo });
      assert.equal(agents.get("w1").labels.lane, "pinned");
      assert.ok(!h.labelUpdates.some((u) => u.labels.lane === "vibesquad"), "lane must not be rewritten to vibesquad");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "a lead with an unregistered lane label never retires the cwd lane's lead",
  withEnv(async () => {
    const agents = new Map([
      [
        "oldlead",
        { id: "oldlead", title: "★ VIBESQUAD ord1", cwd: "/projects/VibeSquad", status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" } },
      ],
      [
        "newlead",
        { id: "newlead", title: "★ LEAD · GHOST ord2", cwd: "/projects/VibeSquad", status: "idle", labels: { team: "vibesquad", lane: "ghost-lane", role: "lead", ord: "2" } },
      ],
    ]);
    const h = harness(agents);
    try {
      await h.onCreated({ agent: agents.get("newlead") }, { paseo: h.paseo });
      assert.equal(agents.get("oldlead").labels.role, "lead", "existing vibesquad lead must stay a lead");
      assert.ok(!h.labelUpdates.some((u) => u.agentId === "oldlead"), "no label writes on the other lane's lead");
    } finally {
      h.stop?.();
    }
  }),
);
