import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEAD_FALLBACK_PACK,
  WORKER_PACK,
  createPlugin,
  deriveTeamForSpawn,
  sanitizeLegacyRosterPrompt,
} from "../plugin/index.server.ts";
import {
  findExistingLaneBrainstorm,
  performBrainstormRestart,
  resetBrainstormRestartState,
  seedDefaultPack,
} from "../server/vibesquad-api.mjs";
import {
  brainstormUsedTokens,
  buildTeamViews,
  checkBuddyOverlap,
  findCrossTeamBrainstorm,
  resolve,
  teamForAgent,
} from "../src/teams.ts";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo (as 35e895e did for 11 other suites).
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

function makeTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-roster-guards-test-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "docs", "PLAN_ROSTER_GUARDS.md"), "# Plan Roster Guards\n", "utf8");
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify(
      {
        leadHandoffTokens: 150000,
        leadFlagTokens: 150000,
        leadAutoHandoffTokens: 250000,
        leadHardCapTokens: 300000,
        workerBudgetTokens: 200000,
        brainstormWarnTokens: 80000,
        brainstormRestartTokens: 150000,
        teams: [
          {
            id: "vibesquad",
            name: "VibeSquad",
            color: "#b07cf5",
            lanes: [{ id: "vibesquad", name: "VibeSquad" }],
            paths: ["VibeSquad"],
          },
          {
            id: "site",
            name: "example.dev",
            color: "#5cc9a7",
            lanes: [{ id: "site-polish", name: "Site Polish" }],
            paths: ["example.dev"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  seedDefaultPack(profilesPath);
  return {
    dir,
    vsHome,
    profilesPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createHarness(overrides = {}) {
  const beforeHandlers = new Map();
  const onHandlers = new Map();
  const labelUpdates = [];
  const archivedIds = [];

  const server = {
    before(event, fn) {
      beforeHandlers.set(event, fn);
      return () => beforeHandlers.delete(event);
    },
    on(event, fn) {
      onHandlers.set(event, fn);
      return () => onHandlers.delete(event);
    },
  };

  const plugin = createPlugin({
    startWatcher: false,
    setLabels: async (agentId, labels, name) => {
      labelUpdates.push({ agentId, labels, name });
    },
    archiveAgent: async (agentId) => {
      archivedIds.push(agentId);
    },
    ...overrides,
  });

  const handle = plugin(server);
  return {
    handle,
    beforeHandlers,
    onHandlers,
    labelUpdates,
    archivedIds,
  };
}

test("Done-when #1 (Fix A): Spawning with a wrong team label (team=site-polish, lane=site-polish) derives team=site and logs team-mismatch", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfiles = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = env.vsHome;
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  try {
    const derived = deriveTeamForSpawn(
      { team: "site-polish", lane: "site-polish", role: "brainstorm" },
      "/projects/example.dev",
    );
    assert.equal(derived.team, "site");
    assert.equal(derived.lane, "site-polish");
    assert.equal(derived.callerTeam, "site-polish");
    assert.equal(derived.mismatch, true);

    const { handle, beforeHandlers, onHandlers, labelUpdates } = createHarness();
    try {
      const beforeCreate = beforeHandlers.get("agent.create");
      assert.equal(typeof beforeCreate, "function");

      const req = {
        config: {
          provider: "claude",
          model: "claude-opus-5-5",
          cwd: "/projects/example.dev",
          title: "BRAINSTORM · SITE POLISH",
        },
        labels: {
          team: "site-polish",
          lane: "site-polish",
          role: "brainstorm",
        },
      };
      const modified = await beforeCreate({ request: req });
      assert.ok(modified);
      assert.equal(modified.labels.team, "site");
      assert.equal(req.labels.team, "site");

      // Also verify agent.created overrides a wrong team label if present on the agent snapshot
      const agents = new Map([
        [
          "5459cf66",
          {
            id: "5459cf66",
            title: "BRAINSTORM · SITE POLISH",
            cwd: "/projects/example.dev",
            status: "idle",
            labels: {
              team: "site-polish",
              lane: "site-polish",
              role: "brainstorm",
            },
          },
        ],
      ]);
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

      const onCreated = onHandlers.get("agent.created");
      await onCreated({ agent: agents.get("5459cf66") }, { paseo });

      assert.equal(labelUpdates.length, 1);
      assert.equal(labelUpdates[0].agentId, "5459cf66");
      assert.equal(labelUpdates[0].labels.team, "site");
      assert.equal(labelUpdates[0].labels.lane, "site-polish");

      const siteLogPath = join(env.vsHome, "teams", "site", "log.jsonl");
      assert.equal(existsSync(siteLogPath), true);
      const entries = readFileSync(siteLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const mismatchEntries = entries.filter((e) => e.type === "metric" && e.text.startsWith("team-mismatch:"));
      assert.equal(mismatchEntries.length, 1, "Expected exactly 1 team-mismatch metric (no double-log)");
      assert.match(mismatchEntries[0].text, /caller=site-polish derived=site lane=site-polish/);
    } finally {
      handle();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfiles === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfiles;
    env.cleanup();
  }
});

test("Done-when #2 (Fix B): Second brainstorm in the same lane under a different team is detected across teams and blocked/reused with an open-existing option", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfiles = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = env.vsHome;
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  resetBrainstormRestartState();
  try {
    const bsWrongTeam = {
      id: "5459cf66",
      title: "BRAINSTORM · SITE POLISH",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: "/projects/example.dev",
      status: "idle",
      updatedAt: "2026-11-01T01:00:00Z",
      labels: {
        team: "site-polish",
        lane: "site-polish",
        role: "brainstorm",
      },
    };
    const bsRightTeam = {
      id: "d40dc2b9",
      title: "BRAINSTORM · SITE POLISH",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: "/projects/example.dev",
      status: "idle",
      updatedAt: "2026-11-01T02:00:00Z",
      labels: {
        team: "site",
        lane: "site-polish",
        role: "brainstorm",
      },
    };

    // 2a. teamForAgent and resolve place a known lane (site-polish) into its authoritative team (site) even if team=site-polish
    assert.equal(teamForAgent(bsWrongTeam).team.id, "site");
    assert.equal(teamForAgent(bsWrongTeam).laneId, "site-polish");

    const members = resolve(
      new Map([
        [bsWrongTeam.id, bsWrongTeam],
        [bsRightTeam.id, bsRightTeam],
      ]),
    );
    assert.equal(members.every((m) => m.team.id === "site"), true);

    // 2b. findCrossTeamBrainstorm finds live brainstorm across teams even when Member.team differs
    const customMembers = [
      {
        agent: bsWrongTeam,
        team: { id: "vibesquad", name: "VibeSquad", color: "#b07cf5", lanes: [], paths: [] },
        laneId: "site-polish",
        kind: "brainstorm",
        agentType: "brainstorm",
        attention: null,
      },
    ];
    const foundCross = findCrossTeamBrainstorm(customMembers, "site-polish");
    assert.ok(foundCross);
    assert.equal(foundCross.agent.id, "5459cf66");

    // 2c. buildTeamViews surfaces cross-team duplicateBrainstorms in the lane view
    const crossViews = buildTeamViews([
      ...customMembers,
      {
        agent: bsRightTeam,
        team: { id: "site", name: "example.dev", color: "#5cc9a7", lanes: [{ id: "site-polish", name: "Site Polish" }], paths: [] },
        laneId: "site-polish",
        kind: "brainstorm",
        agentType: "brainstorm",
        attention: null,
      },
    ]);
    const siteView = crossViews.find((v) => v.team.id === "site");
    assert.ok(siteView);
    const spLane = siteView.lanes.find((l) => l.lane.id === "site-polish");
    assert.ok(spLane);
    assert.equal(spLane.brainstorm?.agent.id, "d40dc2b9");
    assert.equal(spLane.duplicateBrainstorms.length, 1);
    assert.equal(spLane.duplicateBrainstorms[0].agent.id, "5459cf66");

    // 2d. checkBuddyOverlap with allMembers returns the cross-team Buddy so + ADD BUDDY offers "Open existing Buddy"
    const emptySiteView = buildTeamViews([]).find((v) => v.team.id === "site");
    assert.ok(emptySiteView);
    const overlap = checkBuddyOverlap("Site Polish", emptySiteView, [], customMembers);
    assert.ok(overlap, "Expected cross-team Buddy overlap");
    assert.equal(overlap.laneId, "site-polish");
    assert.equal(overlap.buddy?.agent.id, "5459cf66");

    // 2e. performBrainstormRestart({ reason: "start-brainstorm" }) reuses existing brainstorm across teams instead of spawning a second one
    assert.equal(findExistingLaneBrainstorm([bsWrongTeam], "site-polish")?.id, "5459cf66");
    let spawnedCount = 0;
    const updatedAgents = [];
    const mockDaemon = {
      async fetchAgents() {
        return [bsWrongTeam];
      },
      async updateAgent(id, patch) {
        updatedAgents.push({ id, patch });
      },
      async createAgent() {
        spawnedCount++;
        return { id: "should-not-spawn" };
      },
    };
    const startRes = await performBrainstormRestart(
      {
        reason: "start-brainstorm",
        teamId: "site",
        laneId: "site-polish",
        laneName: "Site Polish",
        daemonClient: mockDaemon,
        profilesPath: env.profilesPath,
      },
      env.dir,
    );
    assert.equal(startRes.ok, true);
    assert.equal(startRes.reused, true);
    assert.equal(startRes.existingAgentId, "5459cf66");
    assert.equal(startRes.newAgentId, "5459cf66");
    assert.equal(spawnedCount, 0);
    assert.match(startRes.message, /Open existing brainstorm/i);
    assert.equal(updatedAgents.length, 1);
    assert.equal(updatedAgents[0].id, "5459cf66");
    assert.equal(updatedAgents[0].patch.labels.team, "site");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfiles === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfiles;
    env.cleanup();
  }
});

test("Done-when #3 (Fix C): Sending to an (old)/archived lead delivers to the current lead with notice 'ord18 is retired; delivered to ord19' and increments misroute-old", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const sentMessages = [];
    const agents = new Map([
      [
        "lead-ord18",
        {
          id: "lead-ord18",
          title: "(old) SITE POLISH ord18",
          cwd: "/projects/example.dev",
          status: "closed",
          archivedAt: "2026-11-01T03:00:00Z",
          labels: {
            team: "site",
            lane: "site-polish",
            role: "former-lead",
            ord: "18",
          },
        },
      ],
      [
        "lead-ord19",
        {
          id: "lead-ord19",
          title: "★ SITE POLISH ord19",
          cwd: "/projects/example.dev",
          status: "idle",
          updatedAt: "2026-11-01T03:05:00Z",
          labels: {
            team: "site",
            lane: "site-polish",
            role: "lead",
            ord: "19",
          },
        },
      ],
      [
        "bs-sender",
        {
          id: "bs-sender",
          title: "BRAINSTORM · SITE POLISH",
          cwd: "/projects/example.dev",
          status: "idle",
          labels: {
            team: "site",
            lane: "site-polish",
            role: "brainstorm",
          },
        },
      ],
    ]);

    const paseo = {
      agents: {
        ref(id) {
          return {
            async refresh() {
              const a = agents.get(id);
              return a ? { agent: a } : null;
            },
            async send(text) {
              sentMessages.push({ to: id, text });
            },
          };
        },
        async list() {
          return { entries: [...agents.values()].map((agent) => ({ agent })) };
        },
      },
    };

    const { handle } = createHarness();
    handle.setPaseo(paseo);
    try {
      const res = await handle.sendAgentPrompt(
        {
          agentId: "lead-ord18",
          senderAgentId: "bs-sender",
          prompt: "Approved Gate 14 plan ready for execution.",
        },
        { paseo },
      );
      assert.ok(res);
      assert.equal(res.redirected, true);
      assert.equal(res.agentId, "lead-ord19");
      assert.equal(res.notice, "ord18 is retired; delivered to ord19");

      assert.deepEqual(sentMessages, [
        { to: "lead-ord19", text: "Approved Gate 14 plan ready for execution." },
        { to: "bs-sender", text: "ord18 is retired; delivered to ord19" },
      ]);

      const siteLogPath = join(env.vsHome, "teams", "site", "log.jsonl");
      const logLines = readFileSync(siteLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      const misroute = logLines.filter((e) => e.type === "metric" && e.text.startsWith("misroute-old:"));
      assert.equal(misroute.length, 1);
      assert.match(misroute[0].text, /count=1 target=lead-ord18/);

      // If there is no live lead, sending to retired ord18 rejects with the reason
      agents.delete("lead-ord19");
      await assert.rejects(
        () =>
          handle.sendAgentPrompt(
            {
              agentId: "lead-ord18",
              prompt: "Second message with no live lead",
            },
            { paseo },
          ),
        /ord18 is retired and no live lead exists for site\/site-polish/,
      );
    } finally {
      handle();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("Done-when #5 (Fix E): create_agent with labels: { role: 'lead' } gets the lead pack (never WORKER_PACK)", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfiles = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = env.vsHome;
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  try {
    const { handle, beforeHandlers } = createHarness();
    try {
      const beforeCreate = beforeHandlers.get("agent.create");
      const req = {
        config: {
          provider: "claude",
          model: "claude-opus-5-5",
          cwd: env.dir,
          title: "Site Polish Lead", // Deliberately lacks ★ or ordN
        },
        labels: {
          team: "site",
          lane: "site-polish",
          role: "lead",
        },
      };
      const out = await beforeCreate({ request: req });
      assert.ok(out);
      const sysPrompt = out.config.systemPrompt;
      assert.equal(sysPrompt.includes(WORKER_PACK), false, "Lead must never receive WORKER_PACK");
      assert.equal(
        sysPrompt.includes(LEAD_FALLBACK_PACK) || sysPrompt.includes("Role: lead."),
        true,
        "Lead must receive the lead role pack",
      );
    } finally {
      handle();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfiles === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfiles;
    env.cleanup();
  }
});

test("Done-when #6 (Fix F): Repeated performBrainstormRestart calls at 152000 tokens retire and spawn successor only ONCE and log only ONE entry", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfiles = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = env.vsHome;
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  resetBrainstormRestartState();
  try {
    // Verify brainstormUsedTokens does not sum cumulative cachedInputTokens into context window usage
    assert.equal(
      brainstormUsedTokens({
        id: "bs-cached",
        lastUsage: { inputTokens: 12_000, cachedInputTokens: 180_000 },
      }),
      12_000,
    );

    const spawned = [];
    const mockDaemon = {
      async createAgent(payload) {
        const id = `bs-succ-${spawned.length + 1}`;
        const created = { id, ...payload.config, labels: payload.labels };
        spawned.push(created);
        return created;
      },
      async cancelAgent() {},
      async updateAgent() {},
      async archiveAgent() {},
    };

    const oldAgent = {
      id: "1faf5f36-b8ed-444a-b0fa-56484e9fc58a",
      title: "BRAINSTORM · SITE POLISH",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      labels: {
        team: "site",
        lane: "site-polish",
        role: "brainstorm",
        "vs.mock-tokens": "152000",
      },
    };

    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = await performBrainstormRestart(
        {
          agentId: oldAgent.id,
          teamId: "site",
          laneId: "site-polish",
          reason: "auto-150k",
          usedTokens: 152000,
          oldAgent: { ...oldAgent, labels: { ...oldAgent.labels } },
          daemonClient: mockDaemon,
          profilesPath: env.profilesPath,
        },
        env.dir,
      );
      results.push(r);
    }

    assert.equal(results[0].ok, true);
    assert.equal(Boolean(results[0].skipped), false);
    assert.equal(results[0].retired, true);
    assert.equal(results[0].newAgentId, "bs-succ-1");

    for (let i = 1; i < 5; i++) {
      assert.equal(results[i].ok, true);
      assert.equal(results[i].skipped, true);
      assert.equal(results[i].newAgentId, "bs-succ-1");
    }

    assert.equal(spawned.length, 1, "Hard limit retires and spawns exactly one successor");

    const siteLogPath = join(env.vsHome, "teams", "site", "log.jsonl");
    const logEntries = readFileSync(siteLogPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const restartLogs = logEntries.filter((e) => e.text.startsWith("brainstorm-retired"));
    assert.equal(restartLogs.length, 1, "Must log only 1 brainstorm-retired entry across 5 calls");
    assert.ok(restartLogs[0].text.includes("successor=bs-succ-1"), restartLogs[0].text);
  } finally {
    resetBrainstormRestartState();
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfiles === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfiles;
    env.cleanup();
  }
});
