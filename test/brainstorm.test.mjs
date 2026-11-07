import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { seedDefaultPack } from "../server/profiles.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

function makeTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-brainstorm-test-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(join(dir, "docs", "brainstorm", "bug-chaser.md"), "# Brief\n\n## Open\n- Fix ghost agent\n", "utf8");
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["vibesquad"],
          lanes: [{ id: "bug-chaser", name: "Bug Chaser", lastProfile: "Brainstorm - Claude" }],
        },
      ],
    }),
    "utf8",
  );
  seedDefaultPack(profilesPath);
  return {
    dir,
    vsHome,
    profilesPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("performBrainstormRestart archives ghost initializing/error brainstorm agent when client.createAgent throws", async () => {
  const env = makeTestEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    const agents = new Map([
      [
        "lead-1",
        {
          id: "lead-1",
          title: "★ LEAD · BUG CHASER",
          status: "running",
          labels: { team: "vibesquad", lane: "bug-chaser", role: "lead" },
        },
      ],
      [
        "other-lane-bs",
        {
          id: "other-lane-bs",
          title: "Other Buddy",
          status: "initializing",
          labels: { team: "vibesquad", lane: "other-lane", role: "brainstorm" },
        },
      ],
    ]);
    const archived = [];
    const agentClient = {
      async fetchAgents() {
        return {
          entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })),
        };
      },
      async createAgent(req) {
        // Simulate Paseo persisting the agent record in "initializing" before timing out on provider refresh.
        agents.set("ghost-bs-1", {
          id: "ghost-bs-1",
          title: req.config?.title,
          status: "initializing",
          createdAt: new Date().toISOString(),
          labels: { ...(req.labels ?? {}) },
        });
        throw new Error("Timed out refreshing Claude after 120000ms; pending: version");
      },
      async archiveAgent(id) {
        archived.push(id);
        const a = agents.get(id);
        if (a) a.archivedAt = new Date().toISOString();
      },
      async updateAgent() {},
      async cancelAgent() {},
    };

    await assert.rejects(
      () =>
        performBrainstormRestart(
          {
            reason: "start-brainstorm",
            mode: "quick-start",
            teamId: "vibesquad",
            laneId: "bug-chaser",
            laneName: "Bug Chaser",
            agentClient,
            profilesPath: env.profilesPath,
          },
          env.dir,
        ),
      /Timed out refreshing Claude after 120000ms; pending: version/,
    );

    assert.deepEqual(archived, ["ghost-bs-1"], "only the ghost brainstorm agent in bug-chaser is archived");
    assert.ok(agents.get("ghost-bs-1").archivedAt, "ghost agent is marked archived");
    assert.equal(agents.get("lead-1").archivedAt, undefined, "lead in same lane is untouched");
    assert.equal(agents.get("other-lane-bs").archivedAt, undefined, "initializing brainstorm in another lane is untouched");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("performBrainstormRestart accepts profileName for known brainstorm profiles and falls back for unknown/non-brainstorm names", async () => {
  const env = makeTestEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    const created = [];
    const agentClient = {
      async fetchAgents() {
        return [];
      },
      async createAgent(req) {
        created.push(req);
        return { id: `bs-${created.length}`, labels: req.labels };
      },
      async archiveAgent() {},
      async updateAgent() {},
      async cancelAgent() {},
    };

    // 1. Valid brainstorm profileName ("Brainstorm - Gemini") overrides lane's lastProfile ("Brainstorm - Claude").
    const resGemini = await performBrainstormRestart(
      {
        reason: "start-brainstorm",
        mode: "quick-start",
        teamId: "vibesquad",
        laneId: "bug-chaser",
        laneName: "Bug Chaser",
        profileName: "Brainstorm - Gemini",
        agentClient,
        profilesPath: env.profilesPath,
        backstopDelayMs: 60000,
      },
      env.dir,
    );
    assert.equal(resGemini.profile, "Brainstorm - Gemini");
    assert.equal(created[0].labels.profile, "Brainstorm - Gemini");
    assert.equal(created[0].config.provider, "antigravity-cli");

    // 2. Non-brainstorm or unknown profileName ("Lead - Claude") is ignored and falls back to lane's lastProfile ("Brainstorm - Claude").
    const resFallback = await performBrainstormRestart(
      {
        reason: "start-brainstorm",
        mode: "quick-start",
        teamId: "vibesquad",
        laneId: "bug-chaser",
        laneName: "Bug Chaser",
        profileName: "Lead - Claude",
        forceNew: true,
        agentClient,
        profilesPath: env.profilesPath,
        backstopDelayMs: 60000,
      },
      env.dir,
    );
    assert.equal(resFallback.profile, "Brainstorm - Claude");
    assert.equal(created[1].labels.profile, "Brainstorm - Claude");
    assert.equal(created[1].config.provider, "claude");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});
