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
 * deps: rootDir, baseHome, sendMessage(id, text, opts?) (opts.steerOnly: resolves { delivered: false } when dropped), listAgents() (live snapshots), getAgent(id), lastMessage(id),
 * currentStatus(id) (the runner's status NOW, not the event's), log({teamId, laneId, agent, text}), getThresholds(agent).
 * Returns { observeWorker, evaluateWorker, endEpisode, findLead, marks }.
 *
 * Fresh usage only (idea-162 P0 fix round). A roster pass (startup / reconnect seed) and a catch-up replay carry OLD usage: the first
 * shipped guard nudged every idle worker in the roster at restart, and the input itself resumed them (parked -> queued -> starting).
 * Now: a roster pass only observes (baseline count, `seen` mark for an idle worker already over the line, no input, no ping); an
 * agent upsert is evaluated only while it reads running, its count moved since the last reading (or the `seen` baseline), and the
 * runner still reports the worker running right before any send. Hard needs the soft rung to have fired in this same running episode.
 */
export function createWorkerContextGuard(deps = {}) {
  const rootDir = deps.rootDir ?? REPO_ROOT;
  const file = workerGuardMarksPath(deps.baseHome);
  const sendMessage = deps.sendMessage;
  const listAgents = deps.listAgents ?? (async () => []);
  const getAgent = deps.getAgent ?? (async () => null);
  const lastMessage = deps.lastMessage ?? (async () => "");
  const currentStatus = deps.currentStatus ?? (async () => "");
  const getThresholds = deps.getThresholds ?? ((a) => loadWorkerThresholds(a, rootDir));
  const log = deps.log ?? (({ teamId, laneId, agent, text }) => appendVsLogEntry({ teamId, laneId, agent, type: "metric", text }));
  const marks = readMarks(file); // id -> { soft?: iso, hard?: iso, seen?: { at, tokens } }; loaded once, the file is the restart-safe copy
  const lastSeen = new Map(); // id -> last token count read (roster or upsert): an unchanged count is stale data, never a trigger
  const episodes = new Map(); // id -> { softFired } for the running episode in progress (cleared when the worker stops running)

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

  const isOut = (w) => !w?.id || w.archivedAt || w.archived || w.status === "closed" || !isGuardedWorker(w);
  const readUsed = (w, override) => {
    const used = leadUsedTokens(w, override);
    return Number.isFinite(used) && used > 0 ? used : 0; // unknown/absent count: 0, never a trigger
  };
  const runningNow = async (id) => String((await currentStatus(id).catch(() => "")) ?? "") === "running";

  /** A roster (startup / reconnect) or replayed snapshot: record the baseline, never send. An idle worker already over the soft line is marked seen. */
  function observeWorker(worker, options = {}) {
    if (isOut(worker)) return { stage: "skip" };
    const used = readUsed(worker, options.usedTokens);
    if (!used) return { stage: "none", usedTokens: 0 };
    lastSeen.set(worker.id, used);
    if (worker.status !== "running") episodes.delete(worker.id);
    const { softTokens } = options.thresholds ?? getThresholds(worker);
    if (worker.status !== "running" && used >= softTokens && !marks[worker.id]?.soft && marks[worker.id]?.seen?.tokens !== used) {
      setMark(worker.id, "seen", { at: new Date().toISOString(), tokens: used });
      return { stage: "seen", usedTokens: used };
    }
    return { stage: "observed", usedTokens: used };
  }

  /** The worker's running episode ended (turn_ended / not running): the hard rung needs a fresh soft in the next one. */
  function endEpisode(id) {
    episodes.delete(id);
  }

  async function evaluateWorker(worker, options = {}) {
    if (isOut(worker)) {
      if (worker?.id) episodes.delete(worker.id);
      return { stage: "skip" };
    }
    const used = readUsed(worker, options.usedTokens);
    if (!used) return { stage: "none", usedTokens: 0 };
    const prev = lastSeen.has(worker.id) ? lastSeen.get(worker.id) : marks[worker.id]?.seen?.tokens;
    lastSeen.set(worker.id, used);
    if (worker.status !== "running") {
      episodes.delete(worker.id); // idle / queued / starting / error: never an input (it would START a turn), never a lead ping
      return { stage: "not-running", usedTokens: used };
    }
    if (!episodes.has(worker.id)) episodes.set(worker.id, { softFired: false });
    const episode = episodes.get(worker.id);
    if (prev !== undefined && prev === used) return { stage: "stale", usedTokens: used }; // same count re-sent (label/meta upsert, replay)
    const { softTokens, hardTokens } = options.thresholds ?? getThresholds(worker);
    const fired = [];
    let lead;

    // Soft: also covers a worker that jumped straight past hard (it still needs the wrap-up instruction).
    if (used >= softTokens && !marks[worker.id]?.soft) {
      if (!(await runningNow(worker.id))) return { stage: "not-running", usedTokens: used }; // the event's turn is over (replay / race): no input
      setMark(worker.id, "soft", new Date().toISOString());
      let sent;
      try {
        // steerOnly (idea-169): the runner joins the worker's open turn or drops the nudge; it can never start or resume one.
        sent = await sendMessage(worker.id, WORKER_WRAP_NUDGE, { steerOnly: true });
      } catch (e) {
        setMark(worker.id, "soft", null); // not delivered: the next fresh usage event retries
        throw e;
      }
      if (sent?.delivered === false) {
        setMark(worker.id, "soft", null); // the turn ended before the nudge landed: no input, no lead ping; the next fresh usage retries
        episodes.delete(worker.id);
        return { stage: "not-running", usedTokens: used, dropped: sent.reason ?? "dropped" };
      }
      episode.softFired = true;
      lead = await findLead(worker);
      const pinged = await notifyLead(lead, `${nameOf(worker)} (${worker.id}) at ${kTokens(used)}: wrapping; spawn a fresh worker from its final note.`);
      metric(worker, `worker-context soft ${worker.id} ${kTokens(used)} (soft ${kTokens(softTokens)}) lead=${lead?.id ?? "none"}${lead && !pinged ? " (ping failed)" : ""}`);
      fired.push("soft");
    }

    // Hard: still running, in the same episode the soft rung fired in. One "respawn fresh now" to the lead; no cancel, no respawn.
    if (used >= hardTokens && episode.softFired && !marks[worker.id]?.hard && (fired.length || (await runningNow(worker.id)))) {
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

  return { observeWorker, evaluateWorker, endEpisode, findLead, marks };
}
