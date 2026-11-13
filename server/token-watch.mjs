// Server-side context watcher for runner agents (PLAN_PLUGIN_DUTIES_PORT T1). The same duty the Paseo plugin ran in
// server/hooks/agent-duties.ts (lead 150k nudge / 300k successor, Buddy warn / hard-limit retire), now driven by the runner's
// usage-bearing "agent" upserts. Idempotent through labels, so a server restart or an event replay never repeats a send.
import { effectiveAgentRole } from "./identity.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SOFT_FLAG_NUDGE,
  createLeadHandoffCoordinator,
  isAgentNotFoundError,
  leadUsedTokens,
  loadTeamsConfig,
  resolveTeamAndLane,
} from "./lead-handoff.mjs";
import { appendVsLogEntry, performBrainstormRestart } from "./brainstorm.mjs";
import { BUDDY_COMPACT_FOCUS, COMPACTED_AT_LABEL, createCompactor, isClaudeAgent, isIdleForCompact } from "./compact-step.mjs";
import { createWorkerContextGuard, lastAssistantMessage } from "./worker-context-guard.mjs";

const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));

export const BRAINSTORM_WARN_DEFAULT = 80_000;
export const BRAINSTORM_RESTART_DEFAULT = 150_000;
export const BRIEF_WAIT_MS = 300_000; // longest a Buddy's compaction/restart waits for its brief-update turn to end
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
 * Watches runner usage and acts by role (leads: coordinator stages; Buddies: warn then restart; workers and digest workers: the
 * worker context guard, soft wrap-up + lead ping, then a hard "respawn fresh now" lead ping; idea-162).
 * deps (all optional, for tests): restartExtra (merged into the default restart body: agentClient, profilesPath, ...), runner, rootDir, coordinator, restartBuddy, getBuddyThresholds, workerGuard, baseHome, profilesPath.
 * Returns { stop, evaluate }.
 */
export function startTokenWatcher({
  runner = sharedRunnerBackend(),
  rootDir = REPO_ROOT,
  coordinator,
  restartExtra = {},
  restartBuddy = (body) => performBrainstormRestart({ ...restartExtra, ...body }, rootDir),
  getBuddyThresholds = (agent) => loadBrainstormThresholds(agent, rootDir),
  compactor,
  briefWaitMs = BRIEF_WAIT_MS,
  workerGuard,
  baseHome,
  profilesPath,
} = {}) {
  const live = new Map(); // id -> latest agent snapshot (for the coordinator's lane/worker lookups)
  const busy = new Set();
  const warned = new Set();
  const restarted = new Set();
  const briefPending = new Map(); // id -> ms the warn nudge (brief update) was sent; cleared by that agent's turn_ended

  // K2: compact-before-handoff (Claude only), logged to the agent's own lane. Shared by the Buddy path and the lead ladder.
  const compact =
    compactor ??
    createCompactor({
      runner,
      log: ({ agent, text, teamId, laneId }) => appendVsLogEntry({ teamId, laneId, agent, type: "metric", text }),
    });

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
      compactStep: (agent, opts) => compact.run(agent, opts),
      listAgents: async () => [...live.values()],
      getAgent: async (id) => live.get(id) ?? (await runner.fetchAgent(id).catch((err) => { if (isAgentNotFoundError(err)) return null; throw err; }))?.agent ?? null,
      deleteHeartbeat: (id) => runner.deleteHeartbeat(id),
    });

  const workers =
    workerGuard ??
    createWorkerContextGuard({
      rootDir,
      baseHome,
      sendMessage: (id, text, opts) => runner.sendAgentPrompt(id, text, opts),
      listAgents: async () => [...live.values()],
      getAgent: async (id) => live.get(id) ?? (await runner.fetchAgent(id).catch(() => null))?.agent ?? null,
      lastMessage: (id) => lastAssistantMessage(runner, id),
      // The runner's status now (tail of log), not the event's: a replayed usage event can read running for a turn long over.
      currentStatus: async (id) => (await runner.fetchAgent(id))?.agent?.status ?? "",
    });

  // The brief-update turn must END before /compact: an "idle" upsert can still arrive between sending the nudge and its turn starting.
  async function sendBriefNudge(agent, labels) {
    warned.add(agent.id);
    briefPending.set(agent.id, Date.now());
    await runner.updateAgent(agent.id, { labels: { ...labels, [WARN_LABEL]: "1" } });
    await runner.sendAgentPrompt(agent.id, BRAINSTORM_WARN_NUDGE);
  }

  async function evaluateBuddy(agent) {
    const labels = agent.labels ?? {};
    if (labels["vs.restarted-into"] || restarted.has(agent.id)) return;
    const used = leadUsedTokens(agent);
    const { warnTokens, restartTokens } = getBuddyThresholds(agent);
    if (used >= restartTokens) {
      if (isClaudeAgent(agent) && !labels[COMPACTED_AT_LABEL] && !compact.tried.has(agent.id)) {
        // The Buddy updates its brief first (the warn nudge); a Buddy that jumped past the warn gets it now and is compacted once idle.
        if (labels[WARN_LABEL] !== "1" && !warned.has(agent.id)) {
          await sendBriefNudge(agent, labels);
          return;
        }
        const sentAt = briefPending.get(agent.id);
        if (sentAt !== undefined && Date.now() - sentAt < briefWaitMs) return; // brief turn still open: its turn_ended re-evaluates
        briefPending.delete(agent.id);
        if (!isIdleForCompact(agent)) return; // never compact mid-turn: the idle snapshot re-evaluates
        const { teamId, laneId } = resolveTeamAndLane(agent, rootDir);
        const res = await compact.run(agent, { focus: BUDDY_COMPACT_FOCUS, cap: restartTokens, kind: "buddy", teamId, laneId });
        if (res.outcome === "ok") return; // same id, smaller context: no restart
      }
      restarted.add(agent.id);
      await restartBuddy({ agentId: agent.id, reason: "auto-token-limit", usedTokens: used, oldAgent: agent });
      return;
    }
    if (used >= warnTokens && labels[WARN_LABEL] !== "1" && !warned.has(agent.id)) {
      await sendBriefNudge(agent, labels);
    }
  }

  // source "roster": a startup / reconnect seed. Leads and Buddies evaluate it as before; workers only observe it (old usage, idea-162 P0).
  async function evaluate(agent, { source = "agent" } = {}) {
    if (!agent?.id || agent.archivedAt || agent.status === "closed") return { role: "skip" };
    const role = effectiveAgentRole(agent);
    if (role === "lead") return { role, result: await coord.evaluateLead(agent) };
    if (role === "brainstorm") return { role, result: await evaluateBuddy(agent) };
    if (role === "worker" || role === "digest") {
      return { role, result: source === "roster" ? workers.observeWorker(agent) : await workers.evaluateWorker(agent) };
    }
    return { role };
  }

  const stop = runner.subscribeEvents((ev) => {
    const agents = ev.kind === "roster" ? ev.agents ?? [] : ev.kind === "agent" && ev.agent ? [ev.agent] : [];
    if (ev.kind === "remove") live.delete(ev.agentId);
    if (ev.kind === "turn_ended" && ev.agentId) {
      briefPending.delete(ev.agentId);
      workers.endEpisode(ev.agentId); // not gated by `busy`: a dropped idle upsert must not carry the soft rung into the next turn
    }
    const source = ev.kind === "roster" ? "roster" : "agent";
    for (const agent of agents) {
      if (!agent?.id) continue;
      live.set(agent.id, agent);
      if (busy.has(agent.id)) {
        if (source === "roster") workers.observeWorker(agent); // still baseline a worker whose upsert is mid-evaluation (sync, never sends)
        continue; // one evaluation per agent at a time; the next usage event re-checks
      }
      busy.add(agent.id);
      evaluate(agent, { source })
        .catch((e) => console.warn(`[vibesquad] token watch ${agent.id}: ${e?.message ?? e}`))
        .finally(() => busy.delete(agent.id));
    }
  });
  return { stop, evaluate, coordinator: coord, workerGuard: workers };
}

export { SOFT_FLAG_NUDGE };
