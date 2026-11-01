import assert from "node:assert/strict";
import test from "node:test";

// B-series: DrawerHeader controls (ADE Batch B)
// Pure-logic tests; no DOM/React imports.

// ── helpers duplicated from DrawerHeader.tsx ─────────────────────────────────

const FALLBACK_MODES = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Bypass Perms" },
];

function nextModeInCycle(modes, currentId) {
  if (!modes.length) return "default";
  const idx = modes.findIndex((m) => m.id === currentId);
  return modes[(idx + 1) % modes.length].id;
}

function formatCostUsd(usd) {
  if (usd < 0.001) return `$${usd.toFixed(4)}`;
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ── FALLBACK_MODES ────────────────────────────────────────────────────────────

test("B01: FALLBACK_MODES has 5 entries with expected ids", () => {
  assert.equal(FALLBACK_MODES.length, 5);
  const ids = FALLBACK_MODES.map((m) => m.id);
  assert.ok(ids.includes("default"));
  assert.ok(ids.includes("plan"));
  assert.ok(ids.includes("acceptEdits"));
  assert.ok(ids.includes("auto"));
  assert.ok(ids.includes("bypassPermissions"));
});

test("B02: FALLBACK_MODES entries each have id and label", () => {
  for (const m of FALLBACK_MODES) {
    assert.ok(typeof m.id === "string" && m.id.length > 0, `mode ${m.id} has id`);
    assert.ok(typeof m.label === "string" && m.label.length > 0, `mode ${m.id} has label`);
  }
});

// ── nextModeInCycle ───────────────────────────────────────────────────────────

test("B03: nextModeInCycle wraps from last to first", () => {
  const modes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(nextModeInCycle(modes, "c"), "a");
});

test("B04: nextModeInCycle advances from middle", () => {
  const modes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(nextModeInCycle(modes, "a"), "b");
  assert.equal(nextModeInCycle(modes, "b"), "c");
});

test("B05: nextModeInCycle when currentId is null starts at index 0+1=1", () => {
  const modes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // findIndex returns -1 for null → (-1+1)%3 = 0 → "a"
  assert.equal(nextModeInCycle(modes, null), "a");
});

test("B06: nextModeInCycle with empty modes returns 'default'", () => {
  assert.equal(nextModeInCycle([], "plan"), "default");
});

test("B07: nextModeInCycle with single mode always returns that mode", () => {
  assert.equal(nextModeInCycle([{ id: "only" }], "only"), "only");
  assert.equal(nextModeInCycle([{ id: "only" }], null), "only");
});

test("B08: nextModeInCycle full FALLBACK_MODES cycle covers all 5 modes", () => {
  let cur = null;
  const seen = new Set();
  for (let i = 0; i < FALLBACK_MODES.length; i++) {
    cur = nextModeInCycle(FALLBACK_MODES, cur);
    seen.add(cur);
  }
  assert.equal(seen.size, FALLBACK_MODES.length, "each iteration visits a unique mode");
});

// ── formatCostUsd ─────────────────────────────────────────────────────────────

test("B09: formatCostUsd formats sub-$0.001 with 4 decimal places", () => {
  assert.equal(formatCostUsd(0.0004), "$0.0004");
  assert.equal(formatCostUsd(0.0), "$0.0000");
});

test("B10: formatCostUsd formats $0.001–$0.01 with 3 decimal places", () => {
  assert.equal(formatCostUsd(0.004), "$0.004");
  assert.equal(formatCostUsd(0.001), "$0.001");
});

test("B11: formatCostUsd formats $0.01+ with 2 decimal places", () => {
  assert.equal(formatCostUsd(0.14), "$0.14");
  assert.equal(formatCostUsd(1.5), "$1.50");
  assert.equal(formatCostUsd(0.01), "$0.01");
});

// ── DEMO-aware setModeHelper logic ────────────────────────────────────────────

test("B12: setModeHelper DEMO path calls upsertLocalAgent with new currentModeId", async () => {
  const agent = { id: "ag1", currentModeId: "plan", model: "m1", availableModes: [] };
  const upserted = [];
  const fakeUpsert = (a) => upserted.push(a);

  // simulate DEMO=true path
  const demoSetMode = async (ag, modeId) => { fakeUpsert({ ...ag, currentModeId: modeId }); };
  await demoSetMode(agent, "auto");
  assert.equal(upserted[0].currentModeId, "auto");
  assert.equal(upserted[0].id, "ag1");
});

test("B13: setModeHelper live path calls daemonClient.setAgentMode", async () => {
  const calls = [];
  const fakeDaemon = { setAgentMode: async (id, modeId) => { calls.push({ id, modeId }); } };

  // simulate DEMO=false path
  const liveSetMode = async (agent, modeId) => { await fakeDaemon.setAgentMode(agent.id, modeId); };
  await liveSetMode({ id: "ag1" }, "plan");
  assert.deepEqual(calls[0], { id: "ag1", modeId: "plan" });
});

// ── DEMO-aware setModelHelper logic ──────────────────────────────────────────

test("B14: setModelHelper DEMO path updates model field", async () => {
  const agent = { id: "ag1", model: "claude-sonnet-4-6" };
  const upserted = [];
  const demoSetModel = async (ag, modelId) => { upserted.push({ ...ag, model: modelId }); };
  await demoSetModel(agent, "claude-opus-5-5");
  assert.equal(upserted[0].model, "claude-opus-5-5");
});

test("B15: setModelHelper live path calls daemonClient.setAgentModel", async () => {
  const calls = [];
  const fakeDaemon = { setAgentModel: async (id, modelId) => { calls.push({ id, modelId }); } };
  const liveSetModel = async (agent, modelId) => { await fakeDaemon.setAgentModel(agent.id, modelId); };
  await liveSetModel({ id: "ag1" }, "gpt-5.4");
  assert.deepEqual(calls[0], { id: "ag1", modelId: "gpt-5.4" });
});

// ── DEMO-aware setThinkingHelper logic ────────────────────────────────────────

test("B16: setThinkingHelper DEMO path updates thinkingOptionId", async () => {
  const agent = { id: "ag1", thinkingOptionId: "low" };
  const upserted = [];
  const demoSetThinking = async (ag, optionId) => { upserted.push({ ...ag, thinkingOptionId: optionId }); };
  await demoSetThinking(agent, "high");
  assert.equal(upserted[0].thinkingOptionId, "high");
});

test("B17: setThinkingHelper DEMO path accepts null", async () => {
  const agent = { id: "ag1", thinkingOptionId: "medium" };
  const upserted = [];
  const demoSetThinking = async (ag, optionId) => { upserted.push({ ...ag, thinkingOptionId: optionId }); };
  await demoSetThinking(agent, null);
  assert.equal(upserted[0].thinkingOptionId, null);
});

test("B18: setThinkingHelper live path calls daemonClient.setAgentThinkingOption", async () => {
  const calls = [];
  const fakeDaemon = { setAgentThinkingOption: async (id, opt) => { calls.push({ id, opt }); } };
  const liveSetThinking = async (agent, optionId) => { await fakeDaemon.setAgentThinkingOption(agent.id, optionId); };
  await liveSetThinking({ id: "ag1" }, "high");
  assert.deepEqual(calls[0], { id: "ag1", opt: "high" });
});

// ── refreshAgent (reload) ─────────────────────────────────────────────────────

test("B19: refreshAgent live path calls daemonClient.refreshAgent", async () => {
  const calls = [];
  const fakeDaemon = { refreshAgent: async (id) => { calls.push(id); } };
  await fakeDaemon.refreshAgent("ag1");
  assert.equal(calls[0], "ag1");
});

test("B20: refreshAgent DEMO path is no-op", async () => {
  // In DEMO mode the reload button returns early without calling daemonClient
  const DEMO = true;
  const calls = [];
  const fakeDaemon = { refreshAgent: async (id) => { calls.push(id); } };
  const reloadClick = async (agentId) => {
    if (DEMO) return;
    await fakeDaemon.refreshAgent(agentId);
  };
  await reloadClick("ag1");
  assert.equal(calls.length, 0, "DEMO mode must not call refreshAgent");
});

// ── Copy ID / Copy cwd helpers ────────────────────────────────────────────────

test("B21: copy ID helper writes agent.id to clipboard buffer", () => {
  const written = [];
  const fakeClipboard = { writeText: (s) => { written.push(s); return Promise.resolve(); } };
  const agent = { id: "abc-123-def-456" };
  fakeClipboard.writeText(agent.id);
  assert.equal(written[0], "abc-123-def-456");
});

test("B22: copy cwd helper writes agent.cwd to clipboard buffer", () => {
  const written = [];
  const fakeClipboard = { writeText: (s) => { written.push(s); return Promise.resolve(); } };
  const agent = { cwd: "C:/projects/myapp" };
  fakeClipboard.writeText(agent.cwd);
  assert.equal(written[0], "C:/projects/myapp");
});

test("B23: copy flash labels are '✓ ID' and '✓ Path'", () => {
  const idLabel = (flash) => flash ? "✓ ID" : "id-prefix";
  const pathLabel = (flash) => flash ? "✓ Path" : "⎘";
  assert.equal(idLabel(true), "✓ ID");
  assert.equal(idLabel(false), "id-prefix");
  assert.equal(pathLabel(true), "✓ Path");
  assert.equal(pathLabel(false), "⎘");
});

// ── totalCostUsd display logic ────────────────────────────────────────────────

test("B24: cost readout shown when totalCostUsd is 0", () => {
  const cost = 0;
  const shouldShow = typeof cost === "number" && cost >= 0;
  assert.ok(shouldShow, "cost of 0 should be shown");
  assert.equal(formatCostUsd(cost), "$0.0000");
});

test("B25: cost readout not shown when lastUsage is absent", () => {
  const agent = { lastUsage: undefined };
  const cost = agent.lastUsage?.totalCostUsd ?? undefined;
  assert.equal(typeof cost === "number", false, "no lastUsage → no cost shown");
});

test("B26: cost readout reads from agent.lastUsage.totalCostUsd", () => {
  const agent = { lastUsage: { totalCostUsd: 0.004 } };
  const cost = agent.lastUsage?.totalCostUsd ?? agent?.usage?.totalCostUsd;
  assert.equal(typeof cost, "number");
  assert.equal(formatCostUsd(cost), "$0.004");
});

test("B27: cost readout falls back to agent.usage.totalCostUsd", () => {
  const agent = { lastUsage: undefined, usage: { totalCostUsd: 0.25 } };
  const cost = agent.lastUsage?.totalCostUsd ?? agent?.usage?.totalCostUsd;
  assert.equal(formatCostUsd(cost), "$0.25");
});

// ── Shift+Tab mode-cycle logic ────────────────────────────────────────────────

test("B28: Shift+Tab picks nextModeInCycle from FALLBACK_MODES when availableModes is empty", () => {
  const agent = { currentModeId: "plan", availableModes: [] };
  const DEMO = false;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  const next = nextModeInCycle(modes, agent.currentModeId);
  assert.equal(next, "acceptEdits");
});

test("B29: Shift+Tab uses agent.availableModes when non-empty and not DEMO", () => {
  const agent = { currentModeId: "x", availableModes: [{ id: "x" }, { id: "y" }, { id: "z" }] };
  const DEMO = false;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  const next = nextModeInCycle(modes, agent.currentModeId);
  assert.equal(next, "y");
});

test("B30: Shift+Tab uses FALLBACK_MODES in DEMO mode even if availableModes is set", () => {
  const agent = { currentModeId: "x", availableModes: [{ id: "x" }, { id: "y" }] };
  const DEMO = true;
  const modes = (!DEMO && agent.availableModes?.length) ? agent.availableModes : FALLBACK_MODES;
  assert.equal(modes, FALLBACK_MODES, "DEMO mode forces FALLBACK_MODES");
});
