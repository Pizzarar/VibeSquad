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
  assert.match(s, /LIVE_CHANGE_UNSUPPORTED/);
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
