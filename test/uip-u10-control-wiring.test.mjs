// Unit U10 — Interactive control wiring audit (end-to-end UI → HTTP → server → plugin behavioral tests).
// Unlike the regex-only audits, these tests execute the real handlers: performBrainstormRestart (server),
// checkRemoteBody (remote-proxy-rules), and triggerBrainstormRestart (extracted from AgentDrawer.tsx).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { seedDefaultPack } from "../server/profiles.mjs";
import { checkRemoteBody } from "../server/hooks/remote-proxy-rules.ts";

const drawerSrc = readFileSync(new URL("../src/DrawerHeader.tsx", import.meta.url), "utf8");
const agentSrc = readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8");

const strip = async (t) => {
  const { stripTypeScriptTypes } = await import("node:module");
  if (typeof stripTypeScriptTypes !== "function") {
    t.skip("node:module.stripTypeScriptTypes is unavailable on this Node");
    return null;
  }
  return stripTypeScriptTypes;
};

/** Wraps the real checkRemoteBody so a body object reads as `{ allowed }`, matching the audit's shorthand. */
function checkRemoteBodyPolicy(method, path, obj) {
  const res = checkRemoteBody(method, path, JSON.stringify(obj));
  return { allowed: res.ok === true, ...res };
}

function makeEnv(laneId = "art-direction", lastProfile = undefined) {
  const dir = mkdtempSync(join(tmpdir(), "vs-uip-u10-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(join(dir, "docs", "brainstorm", `${laneId}.md`), "# Brief\n\n## Open\n- do the thing\n", "utf8");
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["vibesquad"],
          lanes: [{ id: laneId, name: "Art Direction", ...(lastProfile ? { lastProfile } : {}) }],
        },
      ],
    }),
    "utf8",
  );
  seedDefaultPack(profilesPath);
  return { dir, vsHome, profilesPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDaemonClient(created) {
  return {
    async fetchAgents() {
      return { entries: [] };
    },
    async createAgent(req) {
      created.push(req);
      return { id: "bs-new", title: req.config?.title, labels: { ...(req.labels ?? {}) } };
    },
    async archiveAgent() {},
    async detachAgent() {},
    async updateAgent() {},
    async cancelAgent() {},
  };
}

async function runRestart(env, body, oldAgent) {
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    const created = [];
    const daemonClient = makeDaemonClient(created);
    const res = await performBrainstormRestart(
      { ...body, oldAgent, daemonClient, profilesPath: env.profilesPath, backstopDelayMs: 0 },
      env.dir,
    );
    return { res, created };
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
  }
}

// ─── 1. SpinUpCard → performBrainstormRestart (quick-start) honours profileName over conflicting labels/lastProfile ───

test("quick-start spawns gemini-4-argon for 'Brainstorm - Gemini' even with a conflicting old profile and lane.lastProfile", async () => {
  const env = makeEnv("art-direction", "Brainstorm - Claude");
  const { created } = await runRestart(
    env,
    {
      agentId: "start-brainstorm",
      reason: "start-brainstorm",
      mode: "quick-start",
      teamId: "vibesquad",
      laneId: "art-direction",
      laneName: "Art Direction",
      profileName: "Brainstorm - Gemini",
    },
    {
      id: "bs-old",
      title: "OLD BUDDY",
      provider: "claude",
      status: "idle",
      labels: { team: "vibesquad", lane: "art-direction", role: "brainstorm", profile: "Brainstorm - Claude" },
    },
  );
  try {
    assert.equal(created.length, 1);
    assert.equal(created[0].config.provider, "antigravity-cli");
    assert.equal(created[0].config.model, "gemini-4-argon");
    assert.equal(created[0].labels.profile, "Brainstorm - Gemini");
    // No caller model/mode/thinking override → the profile stays authoritative (no profile-override flag).
    assert.equal(created[0].labels["profile-override"], undefined);
    assert.equal(created[0].env.VS_PROFILE_OVERRIDE, undefined);
  } finally {
    env.cleanup();
  }
});

test("quick-start spawns claude-opus-5-5 for 'Brainstorm - Claude' even with a conflicting old profile and lane.lastProfile", async () => {
  const env = makeEnv("art-direction", "Brainstorm - Gemini");
  const { created } = await runRestart(
    env,
    {
      agentId: "start-brainstorm",
      reason: "start-brainstorm",
      mode: "quick-start",
      teamId: "vibesquad",
      laneId: "art-direction",
      laneName: "Art Direction",
      profileName: "Brainstorm - Claude",
    },
    {
      id: "bs-old",
      title: "OLD BUDDY",
      provider: "antigravity-cli",
      status: "idle",
      labels: { team: "vibesquad", lane: "art-direction", role: "brainstorm", profile: "Brainstorm - Gemini" },
    },
  );
  try {
    assert.equal(created.length, 1);
    assert.equal(created[0].config.provider, "claude");
    assert.equal(created[0].config.model, "claude-opus-5-5");
    assert.equal(created[0].labels.profile, "Brainstorm - Claude");
  } finally {
    env.cleanup();
  }
});

// ─── 2. Staged model / modeId / thinkingOptionId override, end-to-end ───

test("checkRemoteBodyPolicy accepts the staged model/modeId/thinkingOptionId on brainstorm-restart", () => {
  const check = checkRemoteBodyPolicy("POST", "/__vibesquad/brainstorm-restart", {
    agentId: "a1",
    teamId: "vibesquad",
    laneId: "ui-polish",
    reason: "provider-switch",
    profileName: "Brainstorm - Gemini",
    model: "gemini-3.8-flash",
    modeId: "default",
    thinkingOptionId: "high",
  });
  assert.equal(check.allowed, true, JSON.stringify(check));
  assert.deepEqual(check.value, {
    agentId: "a1",
    teamId: "vibesquad",
    laneId: "ui-polish",
    reason: "provider-switch",
    profileName: "Brainstorm - Gemini",
    model: "gemini-3.8-flash",
    modeId: "default",
    thinkingOptionId: "high",
  });
});

test("performBrainstormRestart spawns the staged model/modeId/thinkingOptionId instead of the profile default", async () => {
  const env = makeEnv("art-direction");
  const { created } = await runRestart(
    env,
    {
      agentId: "bs-old",
      reason: "provider-switch",
      teamId: "vibesquad",
      laneId: "art-direction",
      laneName: "Art Direction",
      profileName: "Brainstorm - Gemini",
      model: "gemini-3.8-flash",
      modeId: "default",
      thinkingOptionId: "high",
    },
    {
      id: "bs-old",
      title: "OLD BUDDY",
      provider: "claude",
      status: "idle",
      labels: { team: "vibesquad", lane: "art-direction", role: "brainstorm", profile: "Brainstorm - Claude" },
    },
  );
  try {
    assert.equal(created.length, 1);
    assert.equal(created[0].config.provider, "antigravity-cli");
    // The profile's default is gemini-4-argon / accept-edits / medium; the staged values must win.
    assert.equal(created[0].config.model, "gemini-3.8-flash");
    assert.equal(created[0].config.modeId, "default");
    assert.equal(created[0].config.thinkingOptionId, "high");
    // The plugin's profile enforcement must preserve the caller's staged values (not rewrite them back).
    assert.equal(created[0].labels["profile-override"], "1");
    assert.equal(created[0].env.VS_PROFILE_OVERRIDE, "1");
  } finally {
    env.cleanup();
  }
});

test("triggerBrainstormRestart forwards model/modeId/thinkingOptionId in the HTTP body", async (t) => {
  const stripTypeScriptTypes = await strip(t);
  if (!stripTypeScriptTypes) return;
  const header = "export async function triggerBrainstormRestart";
  const start = agentSrc.indexOf(header);
  assert.ok(start >= 0, "could not locate triggerBrainstormRestart in AgentDrawer.tsx");
  const endMarker = agentSrc.indexOf("type DrawerProps", start);
  assert.ok(endMarker > start, "could not find the end of triggerBrainstormRestart");
  const fn = agentSrc.slice(start, endMarker).replace(/\s+$/, "");
  const stubs = [
    "const paneOfAgent = (id) => 'pane-' + id;",
    "const isRemote = () => false;",
    "const removeLocalAgent = () => {};",
    "const titleFor = () => 'BUDDY';",
    "const upsertLocalAgent = () => {};",
    "const openAgentInTab = () => {};",
    "const sendMessage = () => {};",
    "const DEMO = false;",
    "const fetch = (...args) => globalThis.__testFetch(...args);",
  ].join("\n");
  const js = stripTypeScriptTypes(stubs + "\n" + fn, { mode: "strip" });
  const mod = await import("data:text/javascript," + encodeURIComponent(js));

  let captured = null;
  globalThis.__testFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, newAgentId: "bs-new" }) };
  };
  try {
    const r = await mod.triggerBrainstormRestart({
      agent: { id: "bs-old", labels: { team: "vibesquad", lane: "art-direction" } },
      teamId: "vibesquad",
      laneId: "art-direction",
      reason: "provider-switch",
      usedTokens: 1000,
      profileName: "Brainstorm - Gemini",
      model: "gemini-3.8-flash",
      modeId: "default",
      thinkingOptionId: "high",
    });
    assert.equal(captured.url, "/__vibesquad/brainstorm-restart");
    assert.equal(captured.body.profileName, "Brainstorm - Gemini");
    assert.equal(captured.body.model, "gemini-3.8-flash");
    assert.equal(captured.body.modeId, "default");
    assert.equal(captured.body.thinkingOptionId, "high");
    assert.equal(r.newAgentId, "bs-new");
  } finally {
    delete globalThis.__testFetch;
  }
});

test("DrawerHeader modeSelect/thinkingSelect update stagedSwitch in place without touching the old daemon session", () => {
  // Mode dropdown: while staged, its value and onChange reflect stagedSwitch.modeId (not agent.currentModeId),
  // and the staged branch calls stageSwitch(...) + return before any setModeHelper.
  assert.match(drawerSrc, /const stagedModeId = staged \? staged\.modeId \?\? agent\.currentModeId \?\? "" : agent\.currentModeId \?\? "";/);
  assert.match(drawerSrc, /if \(staged\) \{\s*stageSwitch\(\{ \.\.\.staged, modeId: e\.target\.value \}\);\s*return;\s*\}/);
  // Thinking dropdown: staged value falls back to agent.thinkingOptionId, and the staged branch never calls setThinkingHelper.
  assert.match(drawerSrc, /const stagedThinking = staged \? staged\.thinkingOptionId \?\? agent\.thinkingOptionId \?\? "" : agent\.thinkingOptionId \?\? "";/);
  assert.match(drawerSrc, /if \(staged\) \{\s*stageSwitch\(\{ \.\.\.staged, thinkingOptionId: e\.target\.value \|\| null \}\);\s*return;\s*\}/);
  // The non-staged fallback still exists for a live agent (helpers are reached only after the staged early-return).
  assert.match(drawerSrc, /setModeHelper\(agent, e\.target\.value\)/);
  assert.match(drawerSrc, /setThinkingHelper\(agent, e\.target\.value \|\| null\)/);
  // Shift+Tab mode-cycle also routes through stageSwitch (never setModeHelper) while a switch is staged.
  assert.match(drawerSrc, /stageSwitch\(\{ \.\.\.staged, modeId: next \}\);/);
});

test("AgentDrawer forwards stagedSwitch.model/modeId/thinkingOptionId through doRestart → triggerBrainstormRestart", () => {
  // doRestart -> triggerBrainstormRestart: the restart path forwards the staged model/modeId/thinkingOptionId.
  assert.match(agentSrc, /await doRestart\("provider-switch", recentTurnsAndMessage, switchTarget\.profile, switchTarget\.model, switchTarget\.modeId, switchTarget\.thinkingOptionId\)/);
  // doRestart → triggerBrainstormRestart passes the three through (not just the profile).
  assert.match(agentSrc, /profileName,\s*model,\s*modeId,\s*thinkingOptionId,\s*\}\);/s);
  // Worker/standalone createAgent includes thinkingOptionId alongside provider/model/modeId.
  assert.match(agentSrc, /\.\.\.\(switchTarget\.thinkingOptionId \? \{ thinkingOptionId: switchTarget\.thinkingOptionId \} : \{\}\)\s*,/);
  // Worker/standalone spawn flags profile-override so the plugin keeps the staged values.
  assert.match(agentSrc, /"profile-override": "1"/);
  assert.match(agentSrc, /env: \{ VS_PROFILE_OVERRIDE: "1" \}/);
});

// ─── 3. Right-Rail Active Buddy Card controls vs the remote proxy policy ───

test("right-rail control payloads pass checkRemoteBody (brainstorm-restart, inbox, lane-state→teams, vs-log)", () => {
  // ↻ Restart / Spin Up → POST /__vibesquad/brainstorm-restart
  const restart = checkRemoteBodyPolicy("POST", "/__vibesquad/brainstorm-restart", {
    agentId: "bs-1",
    teamId: "vibesquad",
    laneId: "ui-polish",
    reason: "manual",
    usedTokens: 50000,
  });
  assert.equal(restart.allowed, true, JSON.stringify(restart));

  // Spin Up (quick-start) profile chip shape.
  const quickStart = checkRemoteBodyPolicy("POST", "/__vibesquad/brainstorm-restart", {
    reason: "start-brainstorm",
    mode: "quick-start",
    teamId: "vibesquad",
    laneId: "ui-polish",
    laneName: "UI Polish",
    profileName: "Brainstorm - Gemini",
  });
  assert.equal(quickStart.allowed, true, JSON.stringify(quickStart));

  // 📥 Inbox park → POST /__vibesquad/inbox (remote shape: source stripped by parkIdeasInInbox).
  const inbox = checkRemoteBodyPolicy("POST", "/__vibesquad/inbox", {
    text: "an idea",
    splitDump: true,
    defaultLaneId: "ui-polish",
    teamId: "vibesquad",
    laneId: "ui-polish",
  });
  assert.equal(inbox.allowed, true, JSON.stringify(inbox));

  // vs-log feedback metric → POST /__vibesquad/vs-log (author is the owner remotely: no agent key).
  const vsLog = checkRemoteBodyPolicy("POST", "/__vibesquad/vs-log", {
    teamId: "vibesquad",
    laneId: "ui-polish",
    type: "metric",
    text: "restart-feedback: good",
    refs: ["bs-old", "bs-new"],
  });
  assert.equal(vsLog.allowed, true, JSON.stringify(vsLog));

  // ✓ Mark complete (lane state → done) persists via saveTeams → /api/teams (PUT) + /__vibesquad/teams (POST).
  const teamsPayload = {
    teams: [
      {
        id: "vibesquad",
        name: "VibeSquad",
        color: "#00f0ff",
        paths: ["vibesquad"],
        lanes: [{ id: "ui-polish", name: "UI Polish", code: "uip", state: "done", doneAt: "2026-11-04T12:00:00.000Z" }],
      },
    ],
    revision: "r1",
  };
  const teamsPut = checkRemoteBodyPolicy("PUT", "/api/teams", teamsPayload);
  assert.equal(teamsPut.allowed, true, JSON.stringify(teamsPut));
  const teamsPost = checkRemoteBodyPolicy("POST", "/__vibesquad/teams", teamsPayload);
  assert.equal(teamsPost.allowed, true, JSON.stringify(teamsPost));
});

test("a spawn-config key that is not allowlisted is still refused remotely (model allowed only on brainstorm-restart)", () => {
  // `model` is now allowlisted on brainstorm-restart (staged override) but rejected on other write endpoints.
  const ok = checkRemoteBodyPolicy("POST", "/__vibesquad/brainstorm-restart", { reason: "manual", laneId: "ui-polish", agentId: "bs-1", model: "gemini-3.8-flash" });
  assert.equal(ok.allowed, true, JSON.stringify(ok));
  const inboxModel = checkRemoteBodyPolicy("POST", "/__vibesquad/inbox", { text: "idea", laneId: "ui-polish", model: "gemini-3.8-flash" });
  assert.equal(inboxModel.allowed, false, JSON.stringify(inboxModel));
  assert.match(inboxModel.error, /key not allowed remotely: body\.model/);
  // `provider` and `cwd` remain forbidden everywhere (spawn config / server-derived).
  const provider = checkRemoteBodyPolicy("POST", "/__vibesquad/brainstorm-restart", { reason: "manual", laneId: "ui-polish", agentId: "bs-1", provider: "claude" });
  assert.equal(provider.allowed, false, JSON.stringify(provider));
  assert.match(provider.error, /body key not allowed remotely: provider/);
});
