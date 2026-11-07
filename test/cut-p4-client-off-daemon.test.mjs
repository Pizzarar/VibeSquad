// PLAN_PASEO_CUT P4: the client moves off daemonClient. Pickers read runner providers, the usage chip reads runner
// usage, and the Ops / Skills / Schedules / Worktrees / Workspaces panels are gone and unreachable.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { runnerUsageToQuota } from "../src/antigravity.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("providers/models/modes read /__vibesquad/providers only (no daemonClient)", () => {
  const s = src("paseoProviders.ts");
  assert.doesNotMatch(s, /daemonClient|from "\.\/paseo"/);
  assert.match(s, /const BASE = "\/__vibesquad\/providers"/);
  assert.match(s, /export const listAvailableProviders = \(\) => catalogGet/);
  assert.match(s, /export const listProviderModels = \(provider: string\) => catalogGet/);
  assert.match(s, /export const listProviderModes = \(provider: string\) => catalogGet/);
});

test("header usage chip reads runner usage, not providers.listUsage", () => {
  const s = src("paseo.ts");
  assert.match(s, /runnerUsageToQuota\(await loadRunnerUsage\(\)\)/);
  assert.doesNotMatch(s, /listProviderUsage/);
});

test("runnerUsageToQuota maps byProvider spend to chip rows", () => {
  assert.deepEqual(runnerUsageToQuota(null), []);
  assert.deepEqual(runnerUsageToQuota({ byProvider: [] }), []);
  assert.deepEqual(
    runnerUsageToQuota({ byProvider: [{ provider: "claude", turns: 3, costUsd: 1.234 }, { provider: "codex", turns: 1, costUsd: 0 }, { turns: 2 }] }),
    [
      { provider: "claude", remainingLabel: "$1.23 · 3 turns" },
      { provider: "codex", remainingLabel: "$0.00 · 1 turn" },
    ],
  );
});

test("DrawerHeader: fork / switch / resume / reload go through the runner, mode+model+thinking fail loudly", () => {
  const s = src("DrawerHeader.tsx");
  assert.doesNotMatch(s, /daemonClient/);
  assert.match(s, /runnerSpawn\(/);
  assert.match(s, /runnerUnarchive\(agent\.id\)/);
  assert.match(s, /runnerReloadTimeline\(agent\.id\)/);
  // N4: mode/model/thinking go through the runner /config route; a runner 400 (unoffered value) is shown, never swallowed.
  assert.doesNotMatch(s, /LIVE_CHANGE_UNSUPPORTED/);
  assert.match(s, /runnerSetConfig\(agent\.id, \{ modeId \}\)/);
  assert.match(s, /runnerSetConfig\(agent\.id, \{ model: modelId \}\)/);
  assert.match(s, /runnerSetConfig\(agent\.id, \{ thinkingOptionId: optionId \}\)/);
  assert.match(s, /setModeHelper\(agent, [^)]*\)\.then\(\(r\) => setReloadError\(configNote\(r\)\)\)\.catch\(\(e2?\) => setReloadError\(/);
  assert.match(s, /setThinkingHelper\(agent, [^)]*\)\.then\(\(r\) => setReloadError\(configNote\(r\)\)\)\.catch\(/);
  assert.match(s, /setModelHelper\(agent, next\)\.then\(\(r\) => setReloadError\(configNote\(r\)\)\)\.catch\(/);
  assert.doesNotMatch(s, /drawer-schedules-btn|drawer-import-btn|SchedulesPanel|ImportSessionModal/);
});

test("hidden panels are deleted, with nothing left importing them", () => {
  for (const f of ["PaseoOpsPanel.tsx", "SkillsPanel.tsx", "McpPanel.tsx", "SchedulesPanel.tsx", "WorktreesPanel.tsx", "WorkspacesView.tsx", "WorkspaceTools.tsx", "paseoOps.ts", "paseoSkills.ts", "paseoSchedules.ts", "paseoWorktrees.ts", "paseoMcp.ts", "paseoPluginUpdates.ts", "paseoTimeline.ts", "paseoSubagents.ts"]) {
    assert.equal(existsSync(new URL(`../src/${f}`, import.meta.url)), false, `${f} should be gone`);
  }
  const app = src("App.tsx");
  assert.doesNotMatch(app, /WorkspacesView|WORKSPACES \(/);
  const palette = src("CommandPalette.tsx");
  assert.doesNotMatch(palette, /act\("workspaces"|actions\.workspaces|SchedulesPanel|PaseoOpsPanel|SkillsPanel/);
  assert.doesNotMatch(src("keymap.ts"), /id: "workspaces"/);
});

test("terminals, scripts, @terminal and @chat context use VS routes", () => {
  assert.doesNotMatch(src("TerminalPanel.tsx"), /daemonClient/);
  assert.doesNotMatch(src("ScriptsPanel.tsx"), /daemonClient/);
  const ctx = src("contextFetch.ts");
  assert.match(ctx, /vsListTerminals\(cwd\)/);
  assert.match(ctx, /vsTerminalOutput\(t\.id\)/);
  assert.match(ctx, /runnerFetchTimeline\(agentId, \{ limit: 60 \}\)/);
  assert.match(src("CommandPalette.tsx"), /runnerFetchTimeline\(agentId, \{ limit: 60 \}\)/);
});

test("sends, cancels, archives and label updates are runner-only in paseo.ts", () => {
  const s = src("paseo.ts");
  assert.doesNotMatch(s, /daemonClient\.(cancelAgent|sendAgentMessage|updateAgent|clearAgentAttention|markWorkspaceUnread)/);
  assert.match(s, /return runnerCancel\(agentId\)/);
  assert.match(s, /await runnerSend\(agentId, text/);
  assert.match(s, /send: \(\) => runnerUpdate\(agentId, \{ labels \}\)/);
});

// ---- Review R1 fixes ----

test("header usage chip reads runner usage and usage refetches on runner connect, not only on the Paseo socket", () => {
  const chip = src("RunnerSettingsSection.tsx");
  assert.doesNotMatch(chip, /paseo\/usage|PaseoUsageHeaderChip/);
  assert.match(chip, /RunnerUsageHeaderChip/);
  assert.match(chip, /loadRunnerUsage\(\)/);
  assert.match(src("App.tsx"), /<RunnerUsageHeaderChip/);
  const p = src("paseo.ts");
  assert.match(p, /if \(up\) \{\s*void refetchProviderUsage\(\)/);
  assert.match(p, /setInterval\(\(\) => void refetchProviderUsage\(\), 60_000\)/);
});

test("resume uses the resume route (unarchive only restores the record)", () => {
  const d = src("DrawerHeader.tsx");
  assert.match(d, /await runnerResume\(agent\.id\)/);
  assert.match(d, /if \(agent\.archivedAt\) await runnerUnarchive\(agent\.id\)/);
  assert.match(d, /can't be resumed/);
});

test("pin previews, predecessor stitch and archived list work without the Paseo socket", () => {
  assert.match(src("PinGrid.tsx"), /runnerHandle\(agentId\)/);
  assert.match(src("Timeline.tsx"), /agentRef\(predecessorId\)/);
  assert.doesNotMatch(src("Timeline.tsx"), /^\s*client\.agents$/m); // the stitch no longer calls the socket directly
  const p = src("paseo.ts");
  assert.match(p, /runnerListArchived\(\)/);
});

test("spawned agents are upserted before their tab opens; InlineEdit watch stops itself; dead helpers gone", () => {
  assert.match(src("DrawerHeader.tsx"), /if \(forked\) upsertLocalAgent\(forked\);\n\s*if \(id\) openAgentInTab\(id\)/);
  assert.match(src("DrawerHeader.tsx"), /if \(spawned\) upsertLocalAgent\(spawned\);\n\s*if \(newId\) openAgentInTab\(newId\)/);
  assert.match(src("AgentDrawer.tsx"), /if \(spawned\) upsertLocalAgent\(spawned\);\n\s*if \(newId\) openAgentInTab/);
  const ie = src("InlineEdit.tsx");
  assert.match(ie, /cur\.id !== id \|\| cur\.phase === "error"\) return;/); // a dismissed / failed session ignores the watch
  assert.match(ie, /offs\.forEach\(\(f\) => f\(\)\); \/\/ nothing is coming/);
  assert.doesNotMatch(src("TerminalPanel.tsx"), /usesVsShells|vsRef/);
  assert.doesNotMatch(src("sessionLifecycle.ts"), /buildRewindRequest|REWIND_MODES|rewindMessageId/);
});

test("runner API: GET /agents?archived=1 lists only archived; POST resume reopens via refreshAgent", async () => {
  const { handleRunnerApi } = await import("../server/runner-api.mjs");
  const seen = [];
  const backend = {
    listAgents: async (o) => (seen.push(["list", o]), [{ id: "rn-a", archivedAt: "t" }, { id: "rn-b", archivedAt: null }]),
    refreshAgent: async (id) => (seen.push(["refresh", id]), { id, status: "idle" }),
  };
  const call = async (url, method) => {
    const out = {};
    await handleRunnerApi({ url, method }, {}, { readBody: async () => ({}), sendJson: (_r, status, body) => Object.assign(out, { status, body }), backend, lanes: () => new Set(["x"]), status: async () => ({}) });
    return out;
  };
  const arch = await call("/__vibesquad/runner/agents?archived=1", "GET");
  assert.deepEqual(arch.body.agents.map((a) => a.id), ["rn-a"]);
  assert.deepEqual(seen[0], ["list", { filter: { includeArchived: true } }]);
  const res = await call("/__vibesquad/runner/agents/rn-a/resume", "POST");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agent: { id: "rn-a", status: "idle" } });
  assert.deepEqual(seen[1], ["refresh", "rn-a"]);
});
