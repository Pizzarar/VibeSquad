// Server-side context watcher for runner agents (PLAN_PLUGIN_DUTIES_PORT T1). The same duty the Paseo plugin ran in
// plugin/index.server.ts (lead 150k nudge / 300k successor, Buddy warn / hard-limit retire), now driven by the runner's
// usage-bearing "agent" upserts. Idempotent through labels, so a server restart or an event replay never repeats a send.
import { effectiveAgentRole } from "./identity.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SOFT_FLAG_NUDGE,
  createLeadHandoffCoordinator,
  leadUsedTokens,
  loadTeamsConfig,
  resolveTeamAndLane,
} from "./lead-handoff.mjs";
import { performBrainstormRestart } from "./brainstorm.mjs";

const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));

export const BRAINSTORM_WARN_DEFAULT = 80_000;
export const BRAINSTORM_RESTART_DEFAULT = 150_000;
export const WARN_LABEL = "vs.token-warned";
export const BRAINSTORM_WARN_NUDGE =
  "Context check: you are past the warn threshold. Update your brief now (docs/brainstorm/<lane>.md, short diff: Decided / Open / In flight). At the hard limit VS retires you and the next pin click starts a fresh Brainstorm from the brief.";

export function loadBrainstormThresholds(agent, rootDir = REPO_ROOT) {
  const cfg = loadTeamsConfig(rootDir);
  const team = resolveTeamAndLane(agent, rootDir).teamDef;
  return {
    warnTokens: Number(team?.brainstormWarnTokens) || Number(cfg.brainstormWarnTokens) || BRAINSTORM_WARN_DEFAULT,
    restartTokens: Number(team?.brainstormRestartTokens) || Number(cfg.brainstormRestartTokens) || BRAINSTORM_RESTART_DEFAULT,
  };
}

/**
 * Watches runner usage and acts by role (leads: coordinator stages; Buddies: warn then restart; workers: nothing).
 * deps (all optional, for tests): runner, rootDir, coordinator, restartBuddy, getBuddyThresholds, baseHome, profilesPath.
 * Returns { stop, evaluate }.
 */
export function startTokenWatcher({
  runner = sharedRunnerBackend(),
  rootDir = REPO_ROOT,
  coordinator,
  restartBuddy = (body) => performBrainstormRestart(body, rootDir),
  getBuddyThresholds = (agent) => loadBrainstormThresholds(agent, rootDir),
  baseHome,
  profilesPath,
} = {}) {
  const live = new Map(); // id -> latest agent snapshot (for the coordinator's lane/worker lookups)
  const busy = new Set();
  const warned = new Set();
  const restarted = new Set();

  const coord =
    coordinator ??
    createLeadHandoffCoordinator({
      rootDir,
      baseHome,
      profilesPath,
      sharedSlots: true,
      setLabels: (id, labels, name) => runner.updateAgent(id, { ...(name ? { name } : {}), labels }),
      sendMessage: (id, text) => runner.sendAgentPrompt(id, text),
      createAgent: (p) =>
        runner.createAgent({
          config: p.config,
          initialPrompt: p.initialPrompt || p.prompt,
          labels: p.labels,
          ...(p.env ? { env: p.env } : {}),
        }),
      listAgents: async () => [...live.values()],
      getAgent: async (id) => live.get(id) ?? (await runner.fetchAgent(id).catch(() => null))?.agent ?? null,
      deleteHeartbeat: (id) => runner.deleteHeartbeat(id),
    });

  async function evaluateBuddy(agent) {
    const labels = agent.labels ?? {};
    if (labels["vs.restarted-into"] || restarted.has(agent.id)) return;
    const used = leadUsedTokens(agent);
    const { warnTokens, restartTokens } = getBuddyThresholds(agent);
    if (used >= restartTokens) {
      restarted.add(agent.id);
      await restartBuddy({ agentId: agent.id, reason: "auto-token-limit", usedTokens: used, oldAgent: agent });
      return;
    }
    if (used >= warnTokens && labels[WARN_LABEL] !== "1" && !warned.has(agent.id)) {
      warned.add(agent.id);
      await runner.updateAgent(agent.id, { labels: { ...labels, [WARN_LABEL]: "1" } });
      await runner.sendAgentPrompt(agent.id, BRAINSTORM_WARN_NUDGE);
    }
  }

  async function evaluate(agent) {
    if (!agent?.id || agent.archivedAt || agent.status === "closed") return { role: "skip" };
    const role = effectiveAgentRole(agent);
    if (role === "lead") return { role, result: await coord.evaluateLead(agent) };
    if (role === "brainstorm") return { role, result: await evaluateBuddy(agent) };
    return { role };
  }

  const stop = runner.subscribeEvents((ev) => {
    const agents = ev.kind === "roster" ? ev.agents ?? [] : ev.kind === "agent" && ev.agent ? [ev.agent] : [];
    if (ev.kind === "remove") live.delete(ev.agentId);
    for (const agent of agents) {
      if (!agent?.id) continue;
      live.set(agent.id, agent);
      if (busy.has(agent.id)) continue; // one evaluation per agent at a time; the next usage event re-checks
      busy.add(agent.id);
      evaluate(agent)
        .catch((e) => console.warn(`[vibesquad] token watch ${agent.id}: ${e?.message ?? e}`))
        .finally(() => busy.delete(agent.id));
    }
  });
  return { stop, evaluate, coordinator: coord };
}

export { SOFT_FLAG_NUDGE };
