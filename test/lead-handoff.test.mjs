import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { isStalePredecessor } from "../server/lead-handoff.mjs";
import { scanLogProgress } from "../server/backend/runner-backend.mjs";
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
  listDaemonAgents,
  loadLeadThresholds,
  performLeadHandoffHttp,
  seedDefaultPack,
  writeBrainstormSummary,
} from "../server/vibesquad-api.mjs";

// Mock-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
// Never read the developer's real teams.json: a runner-pinned lane there would merge live runner agents into mock lists.
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

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

// ---------------------------------------------------------------------------
// isStalePredecessor: stale only when the CURRENT turn never got going (status
// initializing/queued/starting AND no turn-progress since the last prompt). Silence alone
// never makes a running or idle lead stale, and lifetime usage does not make a lead immune.
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const STALE = 30 * 60 * 1000;
const staleLead = (over = {}) => ({
  id: "rn-stale",
  status: "initializing",
  createdAt: "2026-11-06T00:00:00.000Z",
  lastPromptAt: "2026-11-07T00:00:00.000Z", // last prompt/created
  labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
  ...over,
});

test("isStalePredecessor: running lead silent 31 min is not stale", () => {
  assert.equal(isStalePredecessor(staleLead({ status: "running", updatedAt: "2026-11-07T00:00:00.000Z" }), { now: NOW, staleMs: STALE }), false);
});

test("isStalePredecessor: idle lead is not stale (with or without usage — ACP may not report usage)", () => {
  assert.equal(isStalePredecessor(staleLead({ status: "idle", updatedAt: "2026-11-07T00:00:00.000Z" }), { now: NOW, staleMs: STALE }), false);
  assert.equal(isStalePredecessor(staleLead({ status: "idle", lastUsage: undefined, usage: undefined }), { now: NOW, staleMs: STALE }), false);
});

test("isStalePredecessor: queued lead under threshold is not stale", () => {
  const lead = staleLead({ status: "queued", lastPromptAt: "2026-11-07T23:50:00.000Z" }); // queued 10 min before NOW
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), false);
});

test("isStalePredecessor: initializing past threshold is stale, even if a meta/label event just bumped updatedAt", () => {
  const lead = staleLead({
    status: "initializing",
    lastPromptAt: "2026-11-07T00:00:00.000Z", // stuck since the last prompt (24h before NOW)
    updatedAt: "2026-11-07T23:59:00.000Z", // meta write 1 min before NOW must not reset the clock
  });
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), true);
});

test("isStalePredecessor: unknown lastPromptAt fails safe (not stale) instead of guessing from createdAt", () => {
  const lead = {
    ...staleLead({ status: "initializing" }),
    lastPromptAt: undefined, // the runner did not expose a prompt history
    createdAt: "2026-11-06T00:00:00.000Z", // old creation must NOT be used as the clock
  };
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), false);
});

test("isStalePredecessor: a 250k lead with usage, re-prompted and wedged in initializing past threshold, is stale", () => {
  const lead = staleLead({
    status: "initializing",
    lastUsage: { contextWindowUsedTokens: 250_000 }, // it ran turns to reach budget…
    lastPromptAt: "2026-11-07T00:00:00.000Z", // …then was re-prompted 24h ago and wedged
    lastProgressAt: "2026-11-06T23:59:00.000Z", // last output was BEFORE the re-prompt
  });
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), true);
});

test("isStalePredecessor: a lead whose current turn made progress since its last prompt is not stale", () => {
  const lead = staleLead({
    status: "initializing",
    lastPromptAt: "2026-11-07T00:00:00.000Z",
    lastProgressAt: "2026-11-07T00:05:00.000Z", // turn-progress AFTER the prompt
  });
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), false);
});

test("isStalePredecessor: a same-millisecond progress event after the prompt counts as progress (>=)", () => {
  const lead = staleLead({
    status: "initializing",
    lastPromptAt: "2026-11-07T00:00:00.000Z",
    lastProgressAt: "2026-11-07T00:00:00.000Z", // a running event logged in the same millisecond as the input
  });
  assert.equal(isStalePredecessor(lead, { now: NOW, staleMs: STALE }), false);
});

test("huge prompt line: scan finds the prompt — queued 5s not stale, past threshold stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-stale-log-"));
  try {
    const now = Date.now();
    const iso = (ts) => (ts == null ? null : new Date(ts).toISOString()); // toAgent() exposes ISO strings
    const huge = "x".repeat(100 * 1024); // a 100KB prompt line hides its `type` beyond a 64KB tail
    const writeLog = (file, promptTs) =>
      writeFileSync(file, [
        JSON.stringify({ seq: 1, ts: promptTs - 1000, type: "created" }),
        JSON.stringify({ seq: 2, ts: promptTs, type: "input", text: huge }),
        JSON.stringify({ seq: 3, ts: promptTs + 100, type: "status", status: "queued" }),
      ].join("\n") + "\n");

    // Queued 5 s ago -> not stale.
    const recent = join(dir, "rn-recent.jsonl");
    writeLog(recent, now - 5000);
    const r = scanLogProgress(recent);
    assert.equal(r.lastPromptAt, now - 5000, "the huge prompt is found by growing the window");
    assert.equal(isStalePredecessor({ status: "queued", lastPromptAt: iso(r.lastPromptAt), lastProgressAt: iso(r.lastProgressAt) }, { now, staleMs: STALE }), false);

    // Same case, past the threshold -> stale.
    const old = join(dir, "rn-old.jsonl");
    writeLog(old, now - 40 * 60 * 1000);
    const o = scanLogProgress(old);
    assert.equal(o.lastPromptAt, now - 40 * 60 * 1000);
    assert.equal(isStalePredecessor({ status: "queued", lastPromptAt: iso(o.lastPromptAt), lastProgressAt: iso(o.lastProgressAt) }, { now, staleMs: STALE }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    // The unconfirmed auto-250 successor is adopted (and the old lead retired now), never joined by a second one.
    assert.equal(createdAgents.length, 1);
    assert.equal(r300a.successorId, r250IdleA.successorId);

    // Repeated evaluation at 300k / 350k -> does NOT fire again
    const r300b = await coordinator.evaluateLead(lead, { usedTokens: 300_000 });
    const r350 = await coordinator.evaluateLead(lead, { usedTokens: 350_000 });
    assert.equal(r300b.triggered, false);
    assert.equal(r350.triggered, false);
    assert.equal(createdAgents.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("a 250k lead with usage, re-prompted and wedged in initializing, auto-hands off immediately (no steer+wait)", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const agents = new Map();
    const messages = [];
    const createdAgents = [];

    const lead = {
      id: "lead-ord1",
      title: "★ VIBESQUAD ord1",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "initializing", // re-prompted, then wedged before this turn started
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      lastPromptAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // the re-prompt, 2h ago
      lastProgressAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60 * 1000).toISOString(), // last output BEFORE the re-prompt
      lastUsage: { contextWindowUsedTokens: 250_000 }, // it ran turns to reach budget
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1", profile: "Lead - Claude" },
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
          cwd: payload.cwd,
          status: "idle",
          labels: { ...payload.labels },
          prompt: payload.prompt,
        };
        createdAgents.push(created);
        agents.set(created.id, created);
        return created;
      },
      deleteHeartbeat: async () => {},
      appendLog: () => {},
    });

    const r = await coordinator.evaluateLead(lead);
    assert.equal(r.stage, "auto-250");
    assert.equal(r.triggered, true);
    assert.equal(createdAgents.length, 1, "successor spawned immediately (no steer+wait for a stale lead)");
    assert.equal(messages.length, 0, "no WRITE_HANDOFF_PROMPT steer for a stale lead");
    assert.equal(lead.labels.role, "former-lead", "stale predecessor retired immediately (no takeover-confirmation wait)");
    assert.equal(r.retiredImmediately, true);
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
        "vs.parent": oldLead.id,
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
        "vs.parent": oldLead.id,
      },
    };
    agents.set(oldLead.id, oldLead);
    agents.set(openWorker.id, openWorker);
    agents.set("w-idle-1", { ...openWorker, id: "w-idle-1", status: "idle", labels: { ...openWorker.labels, job: "done-job" } });
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
    assert.equal(openWorker.labels["vs.parent"], succ.id);
    assert.equal(closedWorker.labels["vs.parent"], oldLead.id);
    const workerNotice = messages.find((m) => m.id === openWorker.id);
    assert.ok(workerNotice, "Expected open worker to be notified of new lead");
    assert.match(workerNotice.text, /Report to ★ Sit19 \(succ-ord19\)/i);
    // idea-201: an idle worker is re-pointed by label only (no message => no replayed report / re-digest).
    assert.equal(messages.filter((m) => m.id === "w-idle-1").length, 0);
    assert.equal(agents.get("w-idle-1").labels["vs.parent"], succ.id);
    assert.match(logEntries[0].text, /1 idle workers re-pointed; last reports already delivered/);

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

    // 1. The token watcher (server/token-watch.mjs; the plugin no longer evaluates lead tokens) spawns lead-2 at 255k, oldLead still live
    const spawner = createLeadHandoffCoordinator({
      rootDir: env.dir,
      baseHome: env.vsHome,
      setLabels: async (id, labels) => { const a = store.get(id); if (a) a.labels = { ...(a.labels ?? {}), ...labels }; },
      listAgents: async () => [...store.values()],
      getAgent: async (id) => store.get(id) ?? null,
      createAgent: async (payload) => (await paseo.agents.create({ config: payload.config, cwd: payload.cwd, title: payload.title, labels: payload.labels })).agent,
    });
    await spawner.evaluateLead(oldLead);
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

// docs/PLAN_BUGS_BATCH1.md block 3: the HTTP handoff used `client.listAgents`, which DaemonClient does not
// have, so it always saw [] and never re-pointed workers. A fake with only the real methods must work.
function fakeDaemonClient(agents, pageSize = 2) {
  const calls = { fetchAgents: [], updateAgent: [], sendAgentPrompt: [], createAgent: [] };
  return {
    calls,
    async fetchAgents(opts = {}) {
      calls.fetchAgents.push(opts);
      const live = [...agents.values()].filter((a) => !(opts.filter?.includeArchived === false && a.archivedAt));
      const start = opts.page?.cursor ? Number(opts.page.cursor) : 0;
      const slice = live.slice(start, start + pageSize);
      const next = start + pageSize < live.length ? String(start + pageSize) : null;
      return { entries: slice.map((agent) => ({ agent })), pageInfo: { nextCursor: next, prevCursor: null, hasMore: Boolean(next) } };
    },
    async fetchAgent(id) {
      return { agent: agents.get(id) ?? null };
    },
    async updateAgent(id, { name, labels }) {
      calls.updateAgent.push({ id, name, labels });
      const a = agents.get(id);
      if (a) {
        a.labels = { ...(a.labels ?? {}), ...labels };
        if (name) a.title = name;
      }
    },
    async sendAgentPrompt(id, text) {
      calls.sendAgentPrompt.push({ id, text });
    },
    async createAgent(payload) {
      calls.createAgent.push(payload);
      const created = { id: "succ-http", title: payload.config?.title, cwd: payload.config?.cwd, status: "running", labels: { ...payload.labels } };
      agents.set(created.id, created);
      return created;
    },
    async deleteHeartbeat() {},
  };
}

test("listDaemonAgents pages through DaemonClient.fetchAgents and skips archived agents", async () => {
  const agents = new Map(
    ["a", "b", "c", "d", "e"].map((id) => [id, { id, labels: {}, ...(id === "c" ? { archivedAt: "2026-11-01T00:00:00Z" } : {}) }]),
  );
  const client = fakeDaemonClient(agents, 2);
  const got = await listDaemonAgents(client);
  assert.deepEqual(got.map((a) => a.id), ["a", "b", "d", "e"]);
  assert.equal(client.calls.fetchAgents.length, 2);
  assert.equal(client.calls.fetchAgents[1].page.cursor, "2");
  // No fetchAgents (or a daemon error) still means "no workers", never a throw.
  assert.deepEqual(await listDaemonAgents({ listAgents: async () => [{ id: "x" }] }), []);
  assert.deepEqual(await listDaemonAgents({ fetchAgents: async () => { throw new Error("down"); } }), []);
});

test("HTTP handoff with a real-shaped daemon client re-points the open workers to the successor", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const oldLead = {
      id: "lead-http-1",
      title: "★ SITE POLISH ord3",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      createdAt: "2026-11-01T00:00:00.000Z",
      labels: { team: "site", lane: "site-polish", role: "lead", ord: "3", profile: "Lead - Claude" },
    };
    const worker = (id, over = {}) => ({
      id,
      title: `SITE POLISH · ${id}`,
      provider: "claude",
      model: "claude-sonnet-5-5",
      cwd: env.dir,
      status: "running",
      labels: { team: "site", lane: "site-polish", role: "worker", job: id, "vs.parent": oldLead.id },
      ...over,
    });
    const agents = new Map([oldLead, worker("w1"), worker("w2"), worker("w3", { status: "closed" })].map((a) => [a.id, a]));
    const client = fakeDaemonClient(agents, 2);
    const res = await performLeadHandoffHttp({ trigger: "self", agentClient: client, oldLead, baseHome: env.vsHome, profilesPath: env.profilesPath }, env.dir);
    assert.ok(client.calls.fetchAgents.length >= 1, "the real list call is used");
    const succId = res?.successor?.id ?? res?.successorId ?? "succ-http";
    for (const id of ["w1", "w2"]) {
      assert.equal(agents.get(id).labels["vs.parent"], succId, `${id} re-pointed`);
      assert.ok(client.calls.sendAgentPrompt.some((m) => m.id === id), `${id} told about the new lead`);
    }
    assert.equal(agents.get("w3").labels["vs.parent"], oldLead.id, "closed worker untouched");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("HTTP self-handoff without oldLead resolves Hub8 from daemon, titles successor ★ Hub9, and dedupes retries per (team, lane, ord)", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const hub8 = {
      id: "hub-8-id",
      title: "★ Hub8 · sec followups",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      createdAt: "2026-11-02T18:00:00.000Z",
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "8", job: "sec followups", profile: "Lead - Claude" },
    };
    const agents = new Map([[hub8.id, hub8]]);
    const client = fakeDaemonClient(agents, 10);

    // Simulate HTTP body after sanitizeBody strips oldLead: only { trigger: "self", lane: "vibesquad" } or { agentId }
    const [r1, r2] = await Promise.all([
      performLeadHandoffHttp({ trigger: "self", lane: "vibesquad", agentClient: client, baseHome: env.vsHome, profilesPath: env.profilesPath }, env.dir),
      performLeadHandoffHttp({ trigger: "self", agentId: hub8.id, agentClient: client, baseHome: env.vsHome, profilesPath: env.profilesPath }, env.dir),
    ]);
    const r3 = await performLeadHandoffHttp(
      { trigger: "self", agentId: hub8.id, agentClient: client, baseHome: env.vsHome, profilesPath: env.profilesPath },
      env.dir,
    );

    assert.equal(client.calls.createAgent.length, 1, "must spawn only one successor across concurrent and sequential retries");
    assert.equal(r1.oldLeadId, "hub-8-id");
    assert.equal(r1.ord, 8);
    assert.equal(r1.nextOrd, 9);
    assert.equal(r1.title, "★ Hub9");
    assert.equal(r1.oldTitle, "(old) Hub8 · sec followups");
    assert.equal(Boolean(r1.deduped) !== Boolean(r2.deduped), true, "exactly one concurrent request spawns and the other dedupes");
    assert.equal(r2.successorId, r1.successorId);
    assert.equal(r3.deduped, true);
    assert.equal(r3.successorId, r1.successorId);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("HTTP self-handoff with slow createAgent returns 202 + handoffId quickly without blocking HTTP response and dedupes retries", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const hub8 = {
      id: "hub-slow-8",
      title: "★ Hub8 · parity",
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: env.dir,
      status: "idle",
      createdAt: "2026-11-02T18:00:00.000Z",
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "8", job: "parity", profile: "Lead - Claude" },
    };
    const agents = new Map([[hub8.id, hub8]]);
    const baseClient = fakeDaemonClient(agents, 10);
    const slowClient = {
      ...baseClient,
      async createAgent(payload) {
        await new Promise((r) => setTimeout(r, 120));
        return baseClient.createAgent(payload);
      },
    };

    const rFast = await performLeadHandoffHttp(
      { trigger: "self", agentId: hub8.id, httpWaitMs: 20, agentClient: slowClient, baseHome: env.vsHome, profilesPath: env.profilesPath },
      env.dir,
    );
    assert.equal(rFast.accepted, true);
    assert.equal(rFast.status, 202);
    assert.equal(rFast.handoffId, "vibesquad:vibesquad:ord8->ord9");
    assert.equal(rFast.title, "★ Hub9");

    // Retry after completion resolves the same successor without spawning a second one
    const rRetry = await performLeadHandoffHttp(
      { trigger: "self", agentId: hub8.id, agentClient: slowClient, baseHome: env.vsHome, profilesPath: env.profilesPath },
      env.dir,
    );
    assert.equal(rRetry.deduped, true);
    assert.equal(rRetry.successorId, "succ-http");
    assert.equal(baseClient.calls.createAgent.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});
