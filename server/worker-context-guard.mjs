// idea-162 (unit-worker-context-guard): the worker rung of the context ladder. Leads run lead-handoff.mjs evaluateLead and Buddies
// token-watch.mjs evaluateBuddy; a worker (incl. digest workers and reviewers) had nothing, so one could run to 219k with no handoff.
// Same meter (leadUsedTokens), same constant family (LEAD_FLAG_DEFAULT / LEAD_AUTO_HANDOFF_DEFAULT), driven by the same token-watch
// event loop. Soft: the worker is told to wrap up with a handoff note and its lead is pinged once. Hard, still running: the lead is
// pinged once more with the worker's last message. VS never cancels or respawns the worker; the lead decides (no duplicate work).
// Fired marks live in <VIBESQUAD_HOME>/worker-context-guard.json (temp+rename) so a server restart or event replay never repeats one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendVsLogEntry } from "./brainstorm.mjs";
import { parentOf } from "./detach-children.mjs";
import { effectiveAgentRole, isRetiredAgent, loadTeamsRegistry, resolveAgentIdentity, resolveLeadWinner, whoCandidate } from "./identity.mjs";
import { LEAD_AUTO_HANDOFF_DEFAULT, LEAD_FLAG_DEFAULT, leadUsedTokens, loadTeamsConfig, resolveTeamAndLane } from "./lead-handoff.mjs";
import { defangPromptFences } from "./write-guards.mjs";

const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));

export const WORKER_SOFT_DEFAULT = LEAD_FLAG_DEFAULT;
export const WORKER_HARD_DEFAULT = LEAD_AUTO_HANDOFF_DEFAULT;
export const WORKER_GUARD_FILE = "worker-context-guard.json";
const MAX_MARKS = 2000;
const LAST_MESSAGE_MAX = 2000;

export const WORKER_WRAP_NUDGE =
  "Context check: you are past the worker soft limit. Wrap up now: start no new work, commit your WIP on your branch, then end your turn. " +
  "Your final message is the handoff note for a fresh worker: Done / Left / Branch + commit hash / Next step.";

/** The worker roles this guard owns. Leads, Buddies and retired agents keep their own paths (token-watch evaluate dispatches by role). */
export function isGuardedWorker(agent) {
  const role = effectiveAgentRole(agent);
  return role === "worker" || role === "digest";
}

/** Team overrides top level overrides the lead-ladder defaults (teams.json workerSoftTokens / workerHardTokens). */
export function loadWorkerThresholds(agent, rootDir = REPO_ROOT) {
  const cfg = loadTeamsConfig(rootDir);
  const team = resolveTeamAndLane(agent, rootDir).teamDef;
  return {
    softTokens: Number(team?.workerSoftTokens) || Number(cfg.workerSoftTokens) || WORKER_SOFT_DEFAULT,
    hardTokens: Number(team?.workerHardTokens) || Number(cfg.workerHardTokens) || WORKER_HARD_DEFAULT,
  };
}

export function workerGuardMarksPath(baseHome) {
  return join(resolve(baseHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad")), WORKER_GUARD_FILE);
}

function readMarks(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeMarks(file, marks) {
  const keys = Object.keys(marks);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MARKS))) delete marks[k]; // oldest first (insertion order)
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marks), "utf8");
  renameSync(tmp, file);
}

const kTokens = (n) => `${Math.round(n / 1000)}k`;
const nameOf = (a) => String(a?.title || a?.name || a?.id || "worker").trim();

/** The newest non-empty assistant message in a runner timeline (same scan as agent-duties.ts lastAssistantText). */
export async function lastAssistantMessage(runner, id) {
  try {
    const { entries = [] } = (await runner.fetchAgentTimeline(id, { limit: 40 })) ?? {};
    for (let i = entries.length - 1; i >= 0; i--) {
      const it = entries[i]?.item;
      if (it?.type === "assistant_message" && typeof it.text === "string" && it.text.trim()) return it.text.trim();
    }
  } catch {}
  return "";
}

/**
 * deps: rootDir, baseHome, sendMessage(id, text), listAgents() (live snapshots), getAgent(id), lastMessage(id), log({teamId, laneId, agent, text}), getThresholds(agent).
 * Returns { evaluateWorker, findLead, marks }.
 */
export function createWorkerContextGuard(deps = {}) {
  const rootDir = deps.rootDir ?? REPO_ROOT;
  const file = workerGuardMarksPath(deps.baseHome);
  const sendMessage = deps.sendMessage;
  const listAgents = deps.listAgents ?? (async () => []);
  const getAgent = deps.getAgent ?? (async () => null);
  const lastMessage = deps.lastMessage ?? (async () => "");
  const getThresholds = deps.getThresholds ?? ((a) => loadWorkerThresholds(a, rootDir));
  const log = deps.log ?? (({ teamId, laneId, agent, text }) => appendVsLogEntry({ teamId, laneId, agent, type: "metric", text }));
  const marks = readMarks(file); // id -> { soft?: iso, hard?: iso }; loaded once, the file is the restart-safe copy

  function setMark(id, stage, value) {
    const cur = { ...(marks[id] ?? {}) };
    if (value) cur[stage] = value;
    else delete cur[stage];
    delete marks[id]; // re-insert last so trimming drops the oldest worker
    if (Object.keys(cur).length) marks[id] = cur;
    writeMarks(file, marks);
  }

  /** The worker's lead: its parent when that is a live lead (handoffs re-parent workers), else the lane's `vs who lead` winner. */
  async function findLead(worker) {
    const pid = parentOf(worker);
    if (pid) {
      const p = await getAgent(pid).catch(() => null);
      if (p && effectiveAgentRole(p) === "lead" && !isRetiredAgent(p)) return p;
    }
    const teams = loadTeamsRegistry(rootDir);
    const me = resolveAgentIdentity(worker, { teams });
    if (me.isOrphan || !me.teamId || !me.laneId) return null;
    const agents = (await listAgents().catch(() => [])).map((a) => a?.agent ?? a);
    const leads = agents.filter((a) => a && a.id !== worker.id && whoCandidate(a, { teams, wantTeamId: me.teamId, wantLane: me.laneId })?.role === "lead");
    return resolveLeadWinner(leads).winner ?? null;
  }

  async function notifyLead(leadAgent, text) {
    if (!leadAgent) return false;
    try {
      await sendMessage(leadAgent.id, text);
      return true;
    } catch (e) {
      console.warn(`[vibesquad] worker context guard: lead ${leadAgent.id} ping failed: ${e?.message ?? e}`);
      return false;
    }
  }

  function metric(worker, text) {
    try {
      const { teamId, laneId } = resolveTeamAndLane(worker, rootDir);
      log({ teamId, laneId, agent: worker.id, text });
    } catch {}
  }

  async function evaluateWorker(worker, options = {}) {
    if (!worker?.id || worker.archivedAt || worker.archived || worker.status === "closed" || !isGuardedWorker(worker)) return { stage: "skip" };
    const used = leadUsedTokens(worker, options.usedTokens);
    if (!(Number.isFinite(used) && used > 0)) return { stage: "none", usedTokens: 0 }; // unknown/absent count never triggers
    const { softTokens, hardTokens } = options.thresholds ?? getThresholds(worker);
    const fired = [];
    let lead;

    // Soft: also covers a worker that jumped straight past hard (it still needs the wrap-up instruction).
    if (used >= softTokens && !marks[worker.id]?.soft) {
      const at = new Date().toISOString();
      setMark(worker.id, "soft", at);
      try {
        await sendMessage(worker.id, WORKER_WRAP_NUDGE);
      } catch (e) {
        setMark(worker.id, "soft", null); // not delivered: the next usage event retries
        throw e;
      }
      lead = await findLead(worker);
      const pinged = await notifyLead(lead, `${nameOf(worker)} (${worker.id}) at ${kTokens(used)}: wrapping; spawn a fresh worker from its final note.`);
      metric(worker, `worker-context soft ${worker.id} ${kTokens(used)} (soft ${kTokens(softTokens)}) lead=${lead?.id ?? "none"}${lead && !pinged ? " (ping failed)" : ""}`);
      fired.push("soft");
    }

    // Hard while still running: one "respawn fresh now" to the lead. No cancel, no respawn: the lead decides.
    if (used >= hardTokens && worker.status === "running" && !marks[worker.id]?.hard) {
      lead = lead === undefined ? await findLead(worker) : lead;
      setMark(worker.id, "hard", new Date().toISOString());
      if (lead) {
        const last = defangPromptFences(String((await lastMessage(worker.id).catch(() => "")) || "").slice(-LAST_MESSAGE_MAX)).trim();
        const text =
          `${nameOf(worker)} (${worker.id}) at ${kTokens(used)} and still running: respawn fresh now. VS will not cancel it; you decide.` +
          `\n\nIts last message:\n${last || "(none yet)"}`;
        try {
          await sendMessage(lead.id, text);
        } catch (e) {
          setMark(worker.id, "hard", null);
          throw e;
        }
      }
      metric(worker, `worker-context hard ${worker.id} ${kTokens(used)} (hard ${kTokens(hardTokens)}) running lead=${lead?.id ?? "none"}`);
      fired.push("hard");
    }

    const stage = fired.at(-1) ?? (marks[worker.id]?.hard ? "hard" : marks[worker.id]?.soft ? "soft" : "none");
    return { stage, triggered: fired.length > 0, fired, usedTokens: used, leadId: lead?.id ?? null };
  }

  return { evaluateWorker, findLead, marks };
}
