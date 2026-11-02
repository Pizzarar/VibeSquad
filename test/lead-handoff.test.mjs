import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPlugin } from "../plugin/index.server.ts";
import {
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  SOFT_FLAG_NUDGE,
  SOFT_FLAG_REASON,
  WRITE_HANDOFF_PROMPT,
  appendVsLogEntry,
  createLeadHandoffCoordinator,
  getHandoffPacketPath,
  loadLeadThresholds,
  seedDefaultPack,
  writeBrainstormSummary,
} from "../server/vibesquad-api.mjs";

function makeTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-lead-handoff-test-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "docs", "PLAN_LEAD_HANDOFF.md"), "# Plan Lead Handoff\n", "utf8");
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
            leadFlagTokens: 150000,
            leadAutoHandoffTokens: 250000,
            leadHardCapTokens: 300000,
            lanes: [{ id: "vibesquad", name: "VibeSquad" }],
            paths: ["VibeSquad"],
          },
          {
            id: "site",
            name: "example.dev",
            color: "#5cc9a7",
            leadFlagTokens: 150000,
            leadAutoHandoffTokens: 250000,
            leadHardCapTokens: 300000,
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

test("Done-when #1: simulated lead stepping 150k -> 250k -> 300k triggers flag, auto-handoff, and forced handoff each at most once", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const thresholds = loadLeadThresholds("vibesquad", env.dir);
    assert.deepEqual(thresholds, {
      flagTokens: LEAD_FLAG_DEFAULT,
      autoHandoffTokens: LEAD_AUTO_HANDOFF_DEFAULT,
      hardCapTokens: LEAD_HARD_CAP_DEFAULT,
    });

    const agents = new Map();
    const labelUpdates = [];
    const messages = [];
    const createdAgents = [];
    const deletedHeartbeats = [];
    const logEntries = [];

    const lead = {
      id: "lead-ord1",
      title: "★ VIBESQUAD ord1",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      createdAt: "2026-11-01T00:00:00.000Z",
      labels: {
        team: "vibesquad",
        lane: "vibesquad",
        role: "lead",
        ord: "1",
        profile: "Lead - Claude",
      },
      lastUsage: { contextWindowUsedTokens: 120_000 },
    };
    agents.set(lead.id, lead);

    const coordinator = createLeadHandoffCoordinator({
      rootDir: env.dir,
      baseHome: env.vsHome,
      profilesPath: env.profilesPath,
      listAgents: async () => [...agents.values()],
      getAgent: async (id) => agents.get(id) ?? null,
      setLabels: async (id, labels, name) => {
        const cur = agents.get(id);
        if (cur) {
          cur.labels = { ...(cur.labels ?? {}), ...labels };
          if (name) cur.title = name;
        }
        labelUpdates.push({ id, labels, name });
      },
      sendMessage: async (id, text) => {
        messages.push({ id, text });
      },
      createAgent: async (payload) => {
        const created = {
          id: `spawned-${createdAgents.length + 1}`,
          title: payload.title,
          provider: payload.config.provider,
          model: payload.config.model,
          modeId: payload.config.modeId,
          thinkingOptionId: payload.config.thinkingOptionId,
          cwd: payload.cwd,
          status: "idle",
          labels: { ...payload.labels },
          prompt: payload.prompt,
        };
        createdAgents.push(created);
        agents.set(created.id, created);
        return created;
      },
      deleteHeartbeat: async (id) => {
        deletedHeartbeats.push(id);
      },
      appendLog: (teamId, entry) => {
        logEntries.push({ teamId, ...entry });
      },
    });

    // Below 150k -> nothing fires
    const r120 = await coordinator.evaluateLead(lead, { usedTokens: 120_000 });
    assert.equal(r120.triggered, false);
    assert.equal(r120.stage, "none");

    // Step 1: 150k -> Soft flag + nudge fires ONCE
    const r150a = await coordinator.evaluateLead(lead, { usedTokens: 150_000 });
    assert.equal(r150a.triggered, true);
    assert.equal(r150a.stage, "flag-150");
    assert.equal(lead.labels["handoff-flagged"], "1");
    assert.equal(lead.labels["needs-you"], SOFT_FLAG_REASON);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, lead.id);
    assert.equal(messages[0].text, SOFT_FLAG_NUDGE);

    // Repeated evaluation at 150k / 180k -> does NOT fire again
    const r150b = await coordinator.evaluateLead(lead, { usedTokens: 150_000 });
    const r180 = await coordinator.evaluateLead(lead, { usedTokens: 180_000 });
    assert.equal(r150b.triggered, false);
    assert.equal(r180.triggered, false);
    assert.equal(messages.length, 1);

    // Step 2a: 250k while lead is running -> sends write-handoff prompt ONCE and waits for idle
    lead.status = "running";
    const r250RunningA = await coordinator.evaluateLead(lead, { usedTokens: 250_000 });
    assert.equal(r250RunningA.triggered, true);
    assert.equal(r250RunningA.stage, "prompt-250");
    assert.equal(messages.length, 2);
    assert.equal(messages[1].text, WRITE_HANDOFF_PROMPT);
    assert.equal(createdAgents.length, 0);

    const r250RunningB = await coordinator.evaluateLead(lead, { usedTokens: 255_000 });
    assert.equal(r250RunningB.triggered, false);
    assert.equal(messages.length, 2);

    // Step 2b: Lead writes packet and becomes idle at 250k -> auto-handoff fires ONCE
    const packetPath = getHandoffPacketPath("vibesquad", "vibesquad", env.vsHome);
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, "# Manual Handoff Packet from ord1\n- Shipped unit A\n", "utf8");
    lead.status = "idle";

    const r250IdleA = await coordinator.evaluateLead(lead, { usedTokens: 255_000 });
    assert.equal(r250IdleA.triggered, true);
    assert.equal(r250IdleA.stage, "auto-250");
    assert.equal(r250IdleA.trigger, "auto-250");
    assert.equal(createdAgents.length, 1);

    // Repeated evaluation at 250k..299k -> does NOT fire again
    const r250IdleB = await coordinator.evaluateLead(lead, { usedTokens: 260_000 });
    const r290Idle = await coordinator.evaluateLead(lead, { usedTokens: 290_000 });
    assert.equal(r250IdleB.triggered, false);
    assert.equal(r290Idle.triggered, false);
    assert.equal(createdAgents.length, 1);

    // Step 3: 300k -> Forced handoff fires ONCE
    const r300a = await coordinator.evaluateLead(lead, { usedTokens: 300_000 });
    assert.equal(r300a.triggered, true);
    assert.equal(r300a.stage, "hard-300");
    assert.equal(r300a.trigger, "hard-300");
    assert.equal(createdAgents.length, 2);

    // Repeated evaluation at 300k / 350k -> does NOT fire again
    const r300b = await coordinator.evaluateLead(lead, { usedTokens: 300_000 });
    const r350 = await coordinator.evaluateLead(lead, { usedTokens: 350_000 });
    assert.equal(r300b.triggered, false);
    assert.equal(r350.triggered, false);
    assert.equal(createdAgents.length, 2);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("Done-when #2 (250k auto-handoff & 300k forced synthesis): successor has same profile, ordN+1, handoff doc in first prompt, open workers re-pointed, heartbeat deleted, and old lead retired ONLY after takeover confirmation", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    writeBrainstormSummary(
      "site-polish",
      "# Brainstorm Summary · SITE POLISH\n\n## Decided\n- Use 150k/250k/300k lead ladder\n\n## Open\n- None\n\n## In Flight\n- Worker w-open-1\n",
      env.dir,
    );

    appendVsLogEntry({
      teamId: "site",
      laneId: "site-polish",
      agent: "w-open-1",
      type: "done",
      text: "PASS: verified hero contrast on mobile",
      refs: ["src/App.tsx"],
    });
    appendVsLogEntry({
      teamId: "site",
      laneId: "site-polish",
      agent: "3b0c88b7",
      type: "decision",
      text: "Hold footer animation until lighthouse passes",
      refs: ["docs/PLAN_LEAD_HANDOFF.md"],
    });

    const agents = new Map();
    const messages = [];
    const createdAgents = [];
    const deletedHeartbeats = [];
    const logEntries = [];

    const oldLead = {
      id: "3b0c88b7",
      title: "★ SITE POLISH ord18",
      provider: "antigravity-cli",
      model: "gemini-4-argon",
      cwd: env.dir,
      status: "idle",
      createdAt: "2026-10-31T00:00:00.000Z",
      labels: {
        team: "site",
        lane: "site-polish",
        role: "lead",
        ord: "18",
        profile: "Lead - Gemini",
      },
      lastUsage: { contextWindowUsedTokens: 305_000 },
    };
    const openWorker = {
      id: "w-open-1",
      title: "SITE POLISH · audit-contrast",
      provider: "opencode",
      model: "deepseek/deepseek-flash",
      cwd: env.dir,
      status: "running",
      labels: {
        team: "site",
        lane: "site-polish",
        role: "worker",
        job: "audit-contrast",
        "paseo.parent-agent-id": oldLead.id,
      },
    };
    const closedWorker = {
      id: "w-closed-2",
      title: "SITE POLISH · old-job",
      provider: "opencode",
      model: "deepseek/deepseek-flash",
      cwd: env.dir,
      status: "closed",
      labels: {
        team: "site",
        lane: "site-polish",
        role: "worker",
        "paseo.parent-agent-id": oldLead.id,
      },
    };
    agents.set(oldLead.id, oldLead);
    agents.set(openWorker.id, openWorker);
    agents.set(closedWorker.id, closedWorker);

    const coordinator = createLeadHandoffCoordinator({
      rootDir: env.dir,
      baseHome: env.vsHome,
      profilesPath: env.profilesPath,
      listAgents: async () => [...agents.values()],
      getAgent: async (id) => agents.get(id) ?? null,
      setLabels: async (id, labels, name) => {
        const cur = agents.get(id);
        if (cur) {
          cur.labels = { ...(cur.labels ?? {}), ...labels };
          if (name) cur.title = name;
        }
      },
      sendMessage: async (id, text) => {
        messages.push({ id, text });
      },
      createAgent: async (payload) => {
        const created = {
          id: "succ-ord19",
          title: payload.title,
          provider: payload.config.provider,
          model: payload.config.model,
          modeId: payload.config.modeId,
          thinkingOptionId: payload.config.thinkingOptionId,
          featureValues: payload.config.featureValues,
          cwd: payload.cwd,
          status: "running",
          labels: { ...payload.labels },
          prompt: payload.prompt,
        };
        createdAgents.push(created);
        agents.set(created.id, created);
        return created;
      },
      deleteHeartbeat: async (id) => {
        deletedHeartbeats.push(id);
      },
      appendLog: (teamId, entry) => {
        logEntries.push({ teamId, ...entry });
      },
    });

    // Ensure no handoff doc exists beforehand so 300k synthesizes it from vs log + summary + open workers
    const packetPath = getHandoffPacketPath("site", "site-polish", env.vsHome);
    assert.equal(existsSync(packetPath), false);

    const res = await coordinator.evaluateLead(oldLead, { usedTokens: 305_000 });
    assert.equal(res.triggered, true);
    assert.equal(res.stage, "hard-300");
    assert.equal(res.synthesizedPacket, true);
    assert.equal(existsSync(packetPath), true);

    // 1. Successor has same profile ("Lead - Gemini") and next ordN (ord19)
    assert.equal(createdAgents.length, 1);
    const succ = createdAgents[0];
    assert.equal(succ.title, "★ Sit19");
    assert.equal(succ.labels.profile, "Lead - Gemini");
    assert.equal(succ.labels.ord, "19");
    assert.equal(succ.labels.role, "lead");
    assert.equal(succ.provider, "antigravity-cli");
    assert.equal(succ.model, "gemini-4-argon");
    assert.equal(succ.modeId, "accept-edits");

    // 2. First prompt contains the synthesized handoff doc (with vs log + lane summary + open workers) and latest plan
    assert.match(succ.prompt, /verified hero contrast on mobile/);
    assert.match(succ.prompt, /Hold footer animation until lighthouse passes/);
    assert.match(succ.prompt, /Use 150k\/250k\/300k lead ladder/);
    assert.match(succ.prompt, /w-open-1/);
    assert.match(succ.prompt, /docs\/PLAN_LEAD_HANDOFF\.md/);
    assert.match(succ.prompt, /Reply confirming takeover so the previous lead can be retired\./);

    // 3. Open worker re-pointed & notified; closed worker untouched
    assert.equal(openWorker.labels["paseo.parent-agent-id"], succ.id);
    assert.equal(closedWorker.labels["paseo.parent-agent-id"], oldLead.id);
    const workerNotice = messages.find((m) => m.id === openWorker.id);
    assert.ok(workerNotice, "Expected open worker to be notified of new lead");
    assert.match(workerNotice.text, /Report to ★ Sit19 \(succ-ord19\)/i);

    // 4. Old lead's heartbeat deleted and handoff logged with trigger=hard-300
    assert.deepEqual(deletedHeartbeats, [oldLead.id]);
    assert.equal(logEntries.length, 1);
    assert.equal(logEntries[0].type, "handoff");
    assert.match(logEntries[0].text, /trigger=hard-300/);

    // 5. DELAYED RETIREMENT: Old lead is NOT retired before takeover confirmation!
    assert.equal(oldLead.title, "★ SITE POLISH ord18");
    assert.equal(oldLead.labels.role, "lead");
    assert.equal(coordinator.hasPendingTakeover(succ.id), true);

    // 6. Once successor confirms takeover, old lead retires to (old) SITE POLISH ord18 / former-lead
    const confirmed = await coordinator.confirmTakeover(succ.id);
    assert.equal(confirmed.confirmed, true);
    assert.equal(oldLead.title, "(old) Sit18");
    assert.equal(oldLead.labels.role, "former-lead");
    assert.equal(oldLead.labels.ord, "18");
    assert.equal(coordinator.hasPendingTakeover(succ.id), false);

    // Calling confirmTakeover again is a no-op
    const confirmedAgain = await coordinator.confirmTakeover(succ.id);
    assert.equal(confirmedAgain.confirmed, false);
    assert.equal(confirmedAgain.alreadyConfirmed, true);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("Plugin integration: successor turn_ended automatically confirms takeover and retires predecessor lead", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const packetPath = getHandoffPacketPath("vibesquad", "vibesquad", env.vsHome);
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, "# Handoff Packet\n- Ready for ord2\n", "utf8");

    const store = new Map();
    const oldLead = {
      id: "lead-1",
      title: "★ VIBESQUAD ord1",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1", profile: "Lead - Claude" },
      lastUsage: { contextWindowUsedTokens: 255_000 },
    };
    store.set(oldLead.id, oldLead);

    const handlers = new Map();
    const server = {
      before: () => () => {},
      on: (event, fn) => {
        handlers.set(event, fn);
        return () => {};
      },
    };

    const paseo = {
      agents: {
        ref: (id) => ({
          refresh: async () => ({ agent: store.get(id) ?? null }),
          send: async () => {},
          archive: async () => {},
        }),
        list: async () => ({
          entries: [...store.values()].map((agent) => ({ agent })),
        }),
        create: async (payload) => {
          const created = {
            id: "lead-2",
            title: payload.title,
            provider: payload.config.provider,
            model: payload.config.model,
            cwd: payload.cwd,
            status: "idle",
            labels: { ...payload.labels },
          };
          store.set(created.id, created);
          return { id: created.id, agent: created };
        },
      },
    };

    const plugin = createPlugin({
      startWatcher: false,
      setLabels: async (id, labels, name) => {
        const a = store.get(id);
        if (a) {
          a.labels = { ...(a.labels ?? {}), ...labels };
          if (name) a.title = name;
        }
      },
      archiveAgent: async () => {},
    })(server);

    const turnEnded = handlers.get("agent.turn_ended");
    const agentCreated = handlers.get("agent.created");

    // 1. Old lead finishes turn at 255k (idle + packet exists) -> spawns lead-2, oldLead still live
    await turnEnded({ agent: oldLead, turnId: "t1", outcome: { kind: "completed" } }, { paseo });
    const succ = store.get("lead-2");
    assert.ok(succ, "Expected successor lead-2 to be spawned");
    assert.equal(succ.title, "★ Hub2");
    assert.equal(oldLead.labels.role, "lead");

    // 2. Even when agent.created fires for lead-2, oldLead is NOT retired prematurely
    await agentCreated({ agent: succ }, { paseo });
    assert.equal(oldLead.labels.role, "lead");
    assert.equal(oldLead.title, "★ VIBESQUAD ord1");

    // 3. When lead-2 finishes its first turn (confirming takeover), oldLead is retired to (old) VIBESQUAD ord1
    await turnEnded({ agent: succ, turnId: "t2", outcome: { kind: "completed" } }, { paseo });
    assert.equal(oldLead.labels.role, "former-lead");
    assert.equal(oldLead.title, "(old) Hub1");

    plugin();
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});
