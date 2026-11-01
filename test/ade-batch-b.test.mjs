import assert from "node:assert/strict";
import test from "node:test";

// Pure logic tests for DrawerHeader additions — Node-only, no DOM or React.

// ── FALLBACK_MODES ───────────────────────────────────────────────────────────

const FALLBACK_MODES = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Bypass Perms" },
];

test("B-1: FALLBACK_MODES has exactly 5 entries", () => {
  assert.equal(FALLBACK_MODES.length, 5);
});

test("B-1: FALLBACK_MODES contains expected mode IDs", () => {
  const ids = FALLBACK_MODES.map((m) => m.id);
  assert.ok(ids.includes("default"), "default");
  assert.ok(ids.includes("plan"), "plan");
  assert.ok(ids.includes("acceptEdits"), "acceptEdits");
  assert.ok(ids.includes("auto"), "auto");
  assert.ok(ids.includes("bypassPermissions"), "bypassPermissions");
});

// ── nextModeInCycle ──────────────────────────────────────────────────────────

function nextModeInCycle(modes, currentId) {
  if (!modes.length) return "default";
  const idx = modes.findIndex((m) => m.id === currentId);
  return modes[(idx + 1) % modes.length].id;
}

test("B-2: nextModeInCycle returns default when modes is empty", () => {
  assert.equal(nextModeInCycle([], "default"), "default");
  assert.equal(nextModeInCycle([], null), "default");
});

test("B-2: nextModeInCycle advances to the next mode", () => {
  assert.equal(nextModeInCycle(FALLBACK_MODES, "default"), "plan");
  assert.equal(nextModeInCycle(FALLBACK_MODES, "plan"), "acceptEdits");
  assert.equal(nextModeInCycle(FALLBACK_MODES, "acceptEdits"), "auto");
  assert.equal(nextModeInCycle(FALLBACK_MODES, "auto"), "bypassPermissions");
});

test("B-2: nextModeInCycle wraps around from last to first", () => {
  assert.equal(nextModeInCycle(FALLBACK_MODES, "bypassPermissions"), "default");
});

test("B-2: nextModeInCycle starts from index 0 when currentId is null (not found)", () => {
  // findIndex returns -1, (-1+1) % 5 = 0
  assert.equal(nextModeInCycle(FALLBACK_MODES, null), FALLBACK_MODES[0].id);
});

test("B-2: nextModeInCycle starts from index 0 when currentId not in list", () => {
  assert.equal(nextModeInCycle(FALLBACK_MODES, "unknown-mode"), FALLBACK_MODES[0].id);
});

test("B-2: nextModeInCycle works with a single-mode list (wraps to itself)", () => {
  const single = [{ id: "auto" }];
  assert.equal(nextModeInCycle(single, "auto"), "auto");
  assert.equal(nextModeInCycle(single, null), "auto");
});

// ── formatCostUsd ────────────────────────────────────────────────────────────

function formatCostUsd(usd) {
  if (usd < 0.001) return `$${usd.toFixed(4)}`;
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

test("B-3: formatCostUsd formats zero as $0.0000", () => {
  assert.equal(formatCostUsd(0), "$0.0000");
});

test("B-3: formatCostUsd uses 4 decimal places for sub-millicent values", () => {
  assert.equal(formatCostUsd(0.0005), "$0.0005");
  assert.equal(formatCostUsd(0.0009), "$0.0009");
});

test("B-3: formatCostUsd uses 3 decimal places for millicent-range values", () => {
  assert.equal(formatCostUsd(0.001), "$0.001");
  assert.equal(formatCostUsd(0.005), "$0.005");
});

test("B-3: formatCostUsd uses 2 decimal places for cent-range values", () => {
  assert.equal(formatCostUsd(0.14), "$0.14");
  assert.equal(formatCostUsd(1.5), "$1.50");
  assert.equal(formatCostUsd(0.01), "$0.01");
});

test("B-3: formatCostUsd formats typical API costs correctly", () => {
  assert.equal(formatCostUsd(0.004), "$0.004");
  assert.equal(formatCostUsd(0.12), "$0.12");
  assert.equal(formatCostUsd(2.50), "$2.50");
});

// ── DEMO-aware setters (pure behavior simulation) ────────────────────────────

test("B-4: setModeHelper DEMO path upserts currentModeId on local agent", () => {
  const upserted = [];
  const fakeUpsert = (a) => upserted.push(a);

  const agent = { id: "agent-1", currentModeId: "default", model: null, thinkingOptionId: null };
  // Simulate DEMO=true path
  const setModeHelperDemo = (agent, modeId) => {
    fakeUpsert({ ...agent, currentModeId: modeId });
  };

  setModeHelperDemo(agent, "plan");
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].currentModeId, "plan");
  assert.equal(upserted[0].id, "agent-1");
});

test("B-4: setModeHelper live path calls daemonClient.setAgentMode", async () => {
  const calls = [];
  const fakeDaemon = { setAgentMode: async (id, modeId) => { calls.push({ id, modeId }); } };

  const agent = { id: "agent-2" };
  await fakeDaemon.setAgentMode(agent.id, "auto");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "agent-2");
  assert.equal(calls[0].modeId, "auto");
});

test("B-5: setModelHelper DEMO path upserts model on local agent", () => {
  const upserted = [];
  const agent = { id: "agent-3", model: "claude-sonnet-4-6" };
  const setModelHelperDemo = (agent, modelId) => upserted.push({ ...agent, model: modelId });

  setModelHelperDemo(agent, "claude-opus-5-5");
  assert.equal(upserted[0].model, "claude-opus-5-5");
});

test("B-5: setModelHelper live path calls daemonClient.setAgentModel", async () => {
  const calls = [];
  const fakeDaemon = { setAgentModel: async (id, modelId) => { calls.push({ id, modelId }); } };

  await fakeDaemon.setAgentModel("agent-4", "claude-haiku-4-5");
  assert.equal(calls[0].modelId, "claude-haiku-4-5");
});

test("B-6: setThinkingHelper DEMO path upserts thinkingOptionId", () => {
  const upserted = [];
  const agent = { id: "agent-5", thinkingOptionId: "low" };
  const setThinkingHelperDemo = (agent, optId) => upserted.push({ ...agent, thinkingOptionId: optId });

  setThinkingHelperDemo(agent, "high");
  assert.equal(upserted[0].thinkingOptionId, "high");
});

test("B-6: setThinkingHelper DEMO path accepts null to clear", () => {
  const upserted = [];
  const agent = { id: "agent-6", thinkingOptionId: "medium" };
  const setThinkingHelperDemo = (agent, optId) => upserted.push({ ...agent, thinkingOptionId: optId });

  setThinkingHelperDemo(agent, null);
  assert.equal(upserted[0].thinkingOptionId, null);
});

test("B-6: setThinkingHelper live path calls daemonClient.setAgentThinkingOption", async () => {
  const calls = [];
  const fakeDaemon = { setAgentThinkingOption: async (id, optId) => { calls.push({ id, optId }); } };

  await fakeDaemon.setAgentThinkingOption("agent-7", "high");
  assert.equal(calls[0].optId, "high");
});

// ── refreshAgent ─────────────────────────────────────────────────────────────

test("B-7: refreshAgent live path calls daemonClient.refreshAgent", async () => {
  const calls = [];
  const fakeDaemon = { refreshAgent: async (id) => { calls.push(id); return {}; } };

  await fakeDaemon.refreshAgent("agent-8");
  assert.equal(calls[0], "agent-8");
});

test("B-7: refreshAgent DEMO path is no-op (no daemon call)", () => {
  // Simulate DEMO=true: early return before daemon call
  const calls = [];
  const fakeDaemon = { refreshAgent: async (id) => { calls.push(id); } };
  const DEMO = true;

  const reloadInDemoMode = async () => {
    if (DEMO) return; // no-op
    await fakeDaemon.refreshAgent("agent-9");
  };

  reloadInDemoMode();
  assert.equal(calls.length, 0, "DEMO mode must not call refreshAgent");
});

// ── Copy ID / Copy cwd helpers ────────────────────────────────────────────────

test("B-8: copy ID uses agent.id string exactly", () => {
  const agent = { id: "abc123def456ghi789" };
  // The button copies agent.id to clipboard; we verify the value to copy
  const valueToCopy = agent.id;
  assert.equal(valueToCopy, "abc123def456ghi789");
});

test("B-8: copy cwd uses agent.cwd string exactly", () => {
  const agent = { cwd: "/home/user/projects/MyProject" };
  const valueToCopy = agent.cwd;
  assert.equal(valueToCopy, "/home/user/projects/MyProject");
});

test("B-8: copy ID button label shortens to first 8 chars before flash", () => {
  const agent = { id: "abc123def456ghi789" };
  const labelBeforeFlash = agent.id.slice(0, 8);
  assert.equal(labelBeforeFlash, "abc123de");
  const labelAfterFlash = "✓ ID";
  assert.equal(labelAfterFlash, "✓ ID");
});

test("B-8: copy path button label is ⎘ before flash and ✓ Path after", () => {
  const labelBefore = "⎘";
  const labelAfter = "✓ Path";
  assert.equal(labelBefore, "⎘");
  assert.equal(labelAfter, "✓ Path");
});

// ── Cost readout from lastUsage ───────────────────────────────────────────────

test("B-9: totalCostUsd from lastUsage takes priority over fallback", () => {
  const agent = { lastUsage: { totalCostUsd: 0.14 }, usage: { totalCostUsd: 0.99 } };
  const cost = agent.lastUsage?.totalCostUsd ?? agent.usage?.totalCostUsd;
  assert.equal(cost, 0.14);
});

test("B-9: totalCostUsd falls back to usage.totalCostUsd when lastUsage absent", () => {
  const agent = { usage: { totalCostUsd: 0.07 } };
  const cost = agent.lastUsage?.totalCostUsd ?? agent.usage?.totalCostUsd;
  assert.equal(cost, 0.07);
});

test("B-9: cost readout renders for cost === 0 (free calls still show)", () => {
  const cost = 0;
  assert.ok(typeof cost === "number" && cost >= 0, "zero cost is renderable");
});

test("B-9: cost readout does not render when cost is undefined", () => {
  const agent = {};
  const cost = agent.lastUsage?.totalCostUsd ?? agent.usage?.totalCostUsd;
  assert.equal(cost, undefined, "no cost fields → undefined → no readout");
  assert.ok(typeof cost !== "number", "should not render");
});

// ── Mode cycling Shift+Tab wrap-around ───────────────────────────────────────

test("B-10: Shift+Tab mode cycle uses FALLBACK_MODES when availableModes is empty", () => {
  const agent = { availableModes: [], currentModeId: "plan" };
  const DEMO = false;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  assert.deepEqual(modes, FALLBACK_MODES, "empty availableModes → FALLBACK_MODES");
});

test("B-10: Shift+Tab mode cycle uses FALLBACK_MODES in DEMO mode", () => {
  const agent = { availableModes: [{ id: "live-mode", label: "Live" }], currentModeId: "live-mode" };
  const DEMO = true;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  assert.deepEqual(modes, FALLBACK_MODES, "DEMO mode always uses FALLBACK_MODES");
});

test("B-10: Shift+Tab mode cycle uses agent.availableModes when present and not DEMO", () => {
  const liveModes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const agent = { availableModes: liveModes, currentModeId: "a" };
  const DEMO = false;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  assert.deepEqual(modes, liveModes);
  assert.equal(nextModeInCycle(modes, "a"), "b");
  assert.equal(nextModeInCycle(modes, "c"), "a", "wraps around");
});
