import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appendVsLogEntry,
  createAgentClient,
  createSpawnTimer,
  findLanePlanFile,
  readBrainstormSummary,
} from "./brainstorm.mjs";
import {
  effectiveAgentRole,
  findLaneInRegistry,
  findTeamInRegistry,
  formatDisplayTitle,
  isDigestAgent,
  isHandoffPending,
  isHubLane,
  isRetiredAgent,
  LEAD_HANDOFF_MIN_TOKENS,
  laneCodeFor,
  loadTeamsRegistry,
  ordOf,
  resolveLeadWinner,
} from "./identity.mjs";
import { listDaemonAgents } from "./detach-children.mjs";
import { getBackend, isRunnerId, readRunnerAgentSync } from "./backend/index.mjs";
import { sharedSchedules } from "./schedules.mjs";
// Re-exported: the HTTP handoff used `backend.listAgents`, which DaemonClient lacks, so workers were never re-pointed.
export { listDaemonAgents };
import { LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE, readJsonFileWithBom } from "./user-settings.mjs";
import { findProfile, loadProfiles, toPaseoSpawnConfig } from "./profiles.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";
import { defangPromptFences } from "./write-guards.mjs";

// import.meta.dirname is undefined when bundled into the Paseo plugin; fall back like server/hooks/agent-duties.ts.
const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));

export const LEAD_FLAG_DEFAULT = 150_000;
export const LEAD_AUTO_HANDOFF_DEFAULT = 250_000;
export const LEAD_HARD_CAP_DEFAULT = 300_000;

// A predecessor lead that has sat in "initializing"/"queued" (never got a turn going) beyond this bound is stale:
// the handoff must not block on it — spawn+retire immediately instead of steering/waiting for its reply.
// Env-overridable so the threshold can be tuned without a rebuild.
export const STALE_PREDECESSOR_MS =
  Number(process.env.VS_STALE_PREDECESSOR_MS) || 30 * 60 * 1000; // 30 min stuck starting/queued

export const SOFT_FLAG_REASON = "Lead at 150k+ tokens: wrap up and hand off at a good stopping point";
export const SOFT_FLAG_NUDGE =
  "Wrap up: stop dispatching new blocks, let in-flight workers finish, write your Judgment in the packet, then run handoff_lead.";
export const WRITE_HANDOFF_PROMPT =
  "Write handoff now: run 'vs handoff' and finish your turn so VS can auto-handoff.";
export const TAKEOVER_CONFIRM_INSTRUCTION =
  "Reply confirming takeover so the previous lead can be retired.";

function safeSegment(value) {
  return (
    String(value ?? "")
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || "vibesquad"
  );
}

function getBaseHome(overrideHome) {
  return resolve(overrideHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"));
}

function resolveTeamsFilePath(rootDir = REPO_ROOT) {
  return resolveSharedTeamsFilePath(rootDir);
}

export function loadTeamsConfig(rootDir = REPO_ROOT) {
  const file = resolveTeamsFilePath(rootDir);
  const res = readJsonFileWithBom(file, { label: "teams.json", fallback: { teams: [] }, recordWarning: true });
  return res.data ?? { teams: [] };
}

export function loadLeadThresholds(teamIdOrDef, rootDir = REPO_ROOT) {
  const cfg = loadTeamsConfig(rootDir);
  const topFlag = Number(cfg.leadFlagTokens ?? cfg.leadHandoffTokens) || LEAD_FLAG_DEFAULT;
  const topAuto = Number(cfg.leadAutoHandoffTokens) || LEAD_AUTO_HANDOFF_DEFAULT;
  const topHard = Number(cfg.leadHardCapTokens) || LEAD_HARD_CAP_DEFAULT;

  let teamObj = null;
  if (teamIdOrDef && typeof teamIdOrDef === "object") {
    teamObj = teamIdOrDef;
  } else if (typeof teamIdOrDef === "string" && teamIdOrDef.trim()) {
    const needle = teamIdOrDef.trim().toLowerCase();
    teamObj =
      (cfg.teams ?? []).find(
        (t) =>
          String(t.id ?? "").toLowerCase() === needle ||
          String(t.name ?? "").toLowerCase() === needle,
      ) ?? null;
  }

  return {
    flagTokens: Number(teamObj?.leadFlagTokens) || topFlag,
    autoHandoffTokens: Number(teamObj?.leadAutoHandoffTokens) || topAuto,
    hardCapTokens: Number(teamObj?.leadHardCapTokens) || topHard,
  };
}

/** Lane-code lead titles (docs/NAMING.md): the successor `★ <Code><ord>` and the retired `(old) <Code><ord>[ · objective]`. */
export function leadTitles({ laneId, laneName, nextOrd, oldOrd, oldLead, job, rootDir = REPO_ROOT }) {
  const teams = loadTeamsConfig(rootDir).teams;
  const code = laneCodeFor(laneId, Array.isArray(teams) ? teams : []);
  const base = { laneId, laneName, code };
  const cleanJob = typeof job === "string" ? job.trim() : "";
  return {
    newTitle: formatDisplayTitle({ ...base, role: "lead", ord: nextOrd, ...(cleanJob ? { job: cleanJob } : {}) }),
    oldTitle: formatDisplayTitle({ ...base, role: "former-lead", ord: oldOrd, job: oldLead?.labels?.job }),
  };
}

export function resolveTeamAndLane(lead, rootDir = REPO_ROOT) {
  const labels = lead?.labels ?? {};
  const cfg = loadTeamsConfig(rootDir);
  const teams = Array.isArray(cfg.teams) ? cfg.teams : [];
  const laneHint = String(labels.lane || labels.lead || "").trim();
  const teamHint = String(labels.team || "").trim();

  let matchedTeam = null;
  let matchedLane = null;

  if (teamHint) {
    matchedTeam =
      teams.find(
        (t) =>
          String(t.id).toLowerCase() === teamHint.toLowerCase() ||
          String(t.name ?? "").toLowerCase() === teamHint.toLowerCase(),
      ) ?? null;
  }

  if (laneHint) {
    for (const t of teams) {
      for (const l of t.lanes ?? []) {
        if (
          String(l.id).toLowerCase() === laneHint.toLowerCase() ||
          (l.aliases ?? []).some((a) => String(a).toLowerCase() === laneHint.toLowerCase())
        ) {
          if (!matchedTeam) matchedTeam = t;
          matchedLane = l;
          break;
        }
      }
      if (matchedLane) break;
    }
  }

  if (!matchedTeam && lead?.cwd) {
    const segs = String(lead.cwd).toLowerCase().split(/[\\/]+/);
    for (const t of teams) {
      for (const p of t.paths ?? []) {
        const needle = String(p).toLowerCase();
        if (segs.some((s) => (needle.endsWith("-") ? s.startsWith(needle) : s === needle))) {
          matchedTeam = t;
          break;
        }
      }
      if (matchedTeam) break;
    }
  }

  const teamId = safeSegment(matchedTeam?.id || teamHint || "vibesquad");
  const teamName = matchedTeam?.name || teamHint || "VibeSquad";
  // No lane label: only a one-lane squad names its lane; never guess lanes[0] of a multi-lane squad.
  const onlyLane = matchedTeam?.lanes?.length === 1 ? matchedTeam.lanes[0] : null;
  const laneId = safeSegment(matchedLane?.id || laneHint || onlyLane?.id || teamId || "vibesquad");
  const laneName =
    matchedLane?.name || (laneHint ? laneHint.replace(/-/g, " ") : onlyLane?.name || teamName);

  return { teamId, teamName, laneId, laneName, teamDef: matchedTeam };
}

export function parseLeadOrd(lead) {
  const rawLabel = String(lead?.labels?.ord ?? "").trim();
  if (rawLabel) return ordOf(lead);
  const title = String(lead?.title ?? lead?.name ?? "").trim();
  const m = /(?:\bord|★\s*[A-Za-z]{2,5}|\(old\)\s*[A-Za-z]{2,5})(\d+)\b/i.exec(title);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return ordOf(lead);
}

export function highestLaneLeadOrd(agents, laneId, excludeId = "") {
  const want = String(laneId ?? "").trim().toLowerCase();
  if (!want || !Array.isArray(agents)) return 0;
  let max = 0;
  for (const raw of agents) {
    const a = raw?.agent ?? raw;
    if (!a || (excludeId && a.id === excludeId)) continue;
    const l = a.labels ?? {};
    const aLane = String(l.lane || l.lead || "").trim().toLowerCase();
    if (aLane !== want) continue;
    const role = String(l.role ?? "").trim().toLowerCase();
    if (role !== "lead" && role !== "former-lead" && role !== "old-lead" && role !== "retired") continue;
    const n = parseLeadOrd(a);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export const LEAD_COMPACT_FOCUS = "keep the plan, the blocks (status, branch, commit) and the worker ids";

export function leadUsedTokens(lead, overrideTokens) {
  if (typeof overrideTokens === "number" && Number.isFinite(overrideTokens)) return overrideTokens;
  if (typeof lead?.usedTokens === "number" && Number.isFinite(lead.usedTokens)) return lead.usedTokens;
  const mock = Number(lead?.labels?.["vs.mock-tokens"]);
  if (Number.isFinite(mock) && mock > 0) return mock;
  const ctx = Number(lead?.contextUsage?.usedTokens);
  if (Number.isFinite(ctx) && ctx > 0) return ctx;
  const cw = Number(lead?.lastUsage?.contextWindowUsedTokens);
  if (Number.isFinite(cw) && cw > 0) return cw;
  const inp = Number(lead?.lastUsage?.inputTokens ?? lead?.usage?.inputTokens ?? 0);
  return Number.isFinite(inp) && inp > 0 ? inp : 0;
}

/**
 * O6 floor for the Overlord trigger: a HEALTHY lead under LEAD_HANDOFF_MIN_TOKENS is refused ("steer first (ladder 1-2)").
 * Healthy = not errored, not wedged (isStalePredecessor), no pending permission. Unknown tokens (none of the usage fields
 * reported, leadUsedTokens() === 0) FAIL OPEN: we cannot show the lead is small, so the handoff is allowed.
 * `--force` skips the floor only with a non-empty steer. Returns { refuse, forced, tokens, known, healthy }.
 */
export function overlordFloorVerdict(lead, { force = false, steer = "" } = {}) {
  const tokens = leadUsedTokens(lead);
  const known = tokens > 0;
  const status = String(lead?.status ?? "").toLowerCase();
  const healthy = status !== "error" && !isStalePredecessor(lead) && !(Array.isArray(lead?.pendingPermissions) && lead.pendingPermissions.length) && lead?.requiresAttention !== true;
  const underFloor = known && tokens < LEAD_HANDOFF_MIN_TOKENS && healthy;
  if (!underFloor) return { refuse: false, forced: false, tokens, known, healthy };
  if (force === true && String(steer ?? "").trim()) return { refuse: false, forced: true, tokens, known, healthy };
  const why = force === true ? "--force needs a non-empty --steer" : "the lead is healthy";
  return { refuse: true, forced: false, tokens, known, healthy, message: `lead ${lead.id} is under ${LEAD_HANDOFF_MIN_TOKENS} tokens (${tokens}) and ${why}: steer first (ladder 1-2), then retry (--force with --steer skips the floor and is logged)` };
}

/**
 * True when `lead` is a live predecessor the handoff must not block on: its CURRENT turn never got going — status is
 * "initializing"/"queued"/"starting" and it has had no turn-progress event (assistant output / tool call / status
 * running / usage — i.e. not meta/stderr/raw/limit) since its most recent prompt/created event — for at least `staleMs`.
 *
 * Silence alone never makes a running or idle lead stale. A lead that DID run turns but got wedged in a fresh
 * "initializing" after a re-prompt is still caught: the clock is `lastPromptAt` (the runner's last input/created event),
 * not lifetime `usage` and not `updatedAt`/`lastActivityAt` (which a `setLabels`/meta write bumps without proving the
 * turn ran). When the runner did not expose `lastPromptAt`, fail safe (not stale): never guess from `createdAt`, because
 * a just-re-prompted lead whose prompt we can't see would be wrongly retired within seconds.
 */
export function isStalePredecessor(
  lead,
  { now = Date.now(), staleMs = STALE_PREDECESSOR_MS } = {},
) {
  if (!lead || typeof lead !== "object") return false;
  if (lead.archivedAt || lead.status === "closed" || isRetiredAgent(lead)) return false;
  const status = String(lead.status ?? "").toLowerCase();
  if (status !== "initializing" && status !== "queued" && status !== "starting") return false;

  // Clock = the most recent prompt/created event (last input/created). meta/label writes never move it. An unknown
  // lastPromptAt means we can't see the prompt history: fail safe (not stale) instead of guessing from createdAt.
  const promptTs = Date.parse(lead.lastPromptAt ?? "");
  if (!Number.isFinite(promptTs)) return false;

  // The current turn got going if a turn-progress event landed AT or after the last prompt; a missing lastProgressAt
  // (never produced any output) also means the current turn never got going.
  const progressTs = Date.parse(lead.lastProgressAt ?? "");
  if (Number.isFinite(progressTs) && progressTs >= promptTs) return false;

  return now - promptTs >= staleMs;
}

export function getHandoffPacketPath(teamId, laneId, baseHome) {
  const home = getBaseHome(baseHome);
  return join(home, "teams", safeSegment(teamId), `packet-${safeSegment(laneId)}.md`);
}

export function readLaneLogEntries({ teamId, laneId, sinceIso, baseHome }) {
  const home = getBaseHome(baseHome);
  const safeTeam = safeSegment(teamId);
  const safeLane = safeSegment(laneId);
  const candidates = [
    join(home, "teams", safeTeam, "log.jsonl"),
    join(home, "logs", `${safeTeam}--${safeLane}.jsonl`),
  ];
  const seen = new Set();
  const entries = [];
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        try {
          const parsed = JSON.parse(line);
          const entryLane = safeSegment(parsed.lane || safeLane);
          if (
            entryLane !== safeLane &&
            !["decision", "you", "needs-you", "handoff", LEGACY_USER_TYPE, LEGACY_NEEDS_LABEL].includes(String(parsed.type))
          ) {
            continue;
          }
          if (!Number.isNaN(sinceMs) && parsed.ts) {
            const tsMs = Date.parse(parsed.ts);
            if (!Number.isNaN(tsMs) && tsMs < sinceMs) continue;
          }
          entries.push(parsed);
        } catch {}
      }
    } catch {}
  }
  return entries;
}

export function findOpenWorkersForLead(agents, oldLead, teamId, laneId) {
  if (!Array.isArray(agents) || !oldLead) return [];
  const safeTeam = safeSegment(teamId).toLowerCase();
  const safeLane = safeSegment(laneId).toLowerCase();

  return agents.filter((a) => {
    if (!a || a.id === oldLead.id) return false;
    if (a.archivedAt || a.internal || a.status === "closed") return false;
    const l = a.labels ?? {};
    if (isDigestAgent(a)) return false;
    if (effectiveAgentRole(a) !== "worker") return false;

    const parentId = l["vs.parent"] || a.parentAgentId || ""; // X1c: vs.parent is the one parent key
    if (parentId === oldLead.id) return true;
    if (parentId && parentId !== oldLead.id) return false;

    const aTeam = safeSegment(l.team || "").toLowerCase();
    const aLane = safeSegment(l.lane || l.lead || "").toLowerCase();
    return aTeam === safeTeam && aLane === safeLane;
  });
}

export function synthesizeHandoffPacket({
  lead,
  teamId,
  teamName,
  laneId,
  laneName,
  openWorkers = [],
  rootDir = REPO_ROOT,
  baseHome,
  reason = "auto",
}) {
  const ord = parseLeadOrd(lead);
  const packetPath = getHandoffPacketPath(teamId, laneId, baseHome);
  const logEntries = readLaneLogEntries({
    teamId,
    laneId,
    sinceIso: lead?.createdAt,
    baseHome,
  });
  const summary = readBrainstormSummary(laneId, rootDir);
  const now = new Date().toISOString();

  const lines = [
    `# Handoff — ${teamName || teamId} / ${laneId} / ord${ord} (Auto-generated by VibeSquad — ${reason})`,
    "",
    "## Auto State",
    "",
    `- **Team / Lane / Ord:** ${teamName || teamId} / ${laneId} / ord${ord}`,
    `- **Predecessor Lead:** ${lead?.title || lead?.id} (${lead?.id || "unknown"})`,
    `- **Generated:** ${now} (auto-generated handoff packet: ${reason})`,
    "",
    "## Open Workers in Flight",
    "",
  ];

  if (!openWorkers.length) {
    lines.push("- none");
  } else {
    for (const w of openWorkers) {
      const task = w.labels?.task || w.labels?.job || w.title || w.id;
      lines.push(`- ${task} (${w.id}) — status: ${w.status || "running"}`);
    }
  }

  lines.push("");
  lines.push(`## Recent vs log (${laneId}, since lead created)`);
  lines.push("");
  if (!logEntries.length) {
    lines.push("- (no log entries recorded since lead creation)");
  } else {
    for (const entry of logEntries.slice(-30)) {
      const refs =
        Array.isArray(entry.refs) && entry.refs.length ? ` [refs: ${entry.refs.join(", ")}]` : "";
      lines.push(`- [${entry.ts}] ${entry.type} (${entry.agent}): ${entry.text}${refs}`);
    }
  }

  lines.push("");
  lines.push(`## Lane Brainstorm Summary (${summary.path})`);
  lines.push("");
  lines.push(summary.content.trim());
  lines.push("");

  const content = lines.join("\n");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, content, "utf8");

  const snapshotPath = join(
    dirname(packetPath),
    `handoff-${safeSegment(laneId)}-ord${ord}.md`,
  );
  if (resolve(snapshotPath) !== resolve(packetPath)) {
    writeFileSync(snapshotPath, content, "utf8");
  }

  return {
    path: packetPath,
    snapshotPath,
    content,
    logEntries,
    summaryPath: summary.path,
    summaryContent: summary.content,
    openWorkers,
  };
}

export function buildSuccessorPrompt({
  laneId,
  laneName,
  nextOrd,
  newTitle,
  oldLead,
  oldTitle,
  trigger,
  packetPath,
  packetContent,
  summaryPath,
  summaryContent,
  latestPlan,
  openWorkers = [],
  steer = "",
  alreadyRetired = false,
}) {
  const laneUpper = (laneName || laneId).toUpperCase();
  const workerLines = openWorkers.length
    ? openWorkers.map(
        (w) => `- ${w.title || w.labels?.job || w.id} (${w.id}) [${w.status || "running"}]`,
      )
    : ["- none"];

  const retirementLine = alreadyRetired
    ? `The previous lead (${oldLead?.title || oldLead?.id}) has already been retired to "${oldTitle}".`
    : `The previous lead (${oldLead?.title || oldLead?.id}) will be retired to "${oldTitle}" once you confirm takeover.`;

  return [
    `You are ${newTitle || `★ ${laneUpper} ord${nextOrd}`}, the successor lead for lane \`${laneId}\` (handoff trigger=${trigger} from ${oldLead?.id || oldTitle}).`,
    retirementLine,
    "",
    `- **Handoff packet:** \`${packetPath}\``,
    `- **Brainstorm summary:** \`${summaryPath}\``,
    `- **Latest plan:** \`${latestPlan}\``,
    "",
    "### Open Workers Re-pointed to You",
    ...workerLines,
    "",
    `--- BEGIN HANDOFF PACKET (${packetPath}) ---`,
    defangPromptFences(String(packetContent ?? "").trim()),
    `--- END HANDOFF PACKET ---`,
    "",
    `--- BEGIN BRAINSTORM SUMMARY (${summaryPath}) ---`,
    defangPromptFences(String(summaryContent ?? "").trim()),
    `--- END BRAINSTORM SUMMARY ---`,
    ...(String(steer ?? "").trim()
      ? ["", "--- BEGIN OVERLORD STEER ---", defangPromptFences(String(steer).trim().slice(0, 2000)), "--- END OVERLORD STEER ---"]
      : []),
    "",
    ...(alreadyRetired ? [] : [TAKEOVER_CONFIRM_INSTRUCTION]),
  ].join("\n");
}

export function resolveLeadProfile(oldLead, profilesPath) {
  const oldLabels = oldLead?.labels ?? {};
  const rawProvider = String(oldLead?.provider || "claude");
  const isAgy = rawProvider.startsWith("antigravity");
  const fallbackProfileName = isAgy ? "Lead - Gemini" : "Lead - Claude";
  const desiredKey = String(oldLabels.profile || fallbackProfileName).trim();

  const { profiles } = loadProfiles(profilesPath, { autoSeed: false });
  const profile =
    findProfile(desiredKey, profiles) || findProfile(fallbackProfileName, profiles);
  const spawnCfg = profile
    ? toPaseoSpawnConfig(profile)
    : {
        provider: rawProvider.includes("/") ? rawProvider.split("/")[0] : rawProvider,
        model:
          oldLead?.model ||
          (rawProvider.includes("/")
            ? rawProvider.split("/").slice(1).join("/")
            : isAgy
              ? "gemini-4-argon"
              : "claude-opus-5-5"),
        modeId: oldLead?.modeId || (isAgy ? "accept-edits" : "auto"),
        thinkingOptionId: oldLead?.thinkingOptionId || "medium",
        ...(oldLead?.featureValues ? { featureValues: { ...oldLead.featureValues } } : {}),
        notes: "",
        systemPrompt: "",
      };

  return {
    profileName: profile?.name || desiredKey || fallbackProfileName,
    profile,
    spawnCfg,
  };
}

const sharedHttpInFlightBySlot = new Map();
const sharedHttpCompletedBySlot = new Map();
const sharedHttpEvictedSuccessors = new Set();

/** True only for a definite "agent does not exist" error; any other fetch failure is transient and must not read as dead. */
export function isAgentNotFoundError(err) {
  return /not[ _-]?found|no such agent|unknown agent|\b404\b/i.test(String(err?.message ?? err));
}

export function resetLeadHandoffState() {
  sharedHttpEvictedSuccessors.clear();
  sharedHttpInFlightBySlot.clear();
  sharedHttpCompletedBySlot.clear();
}

export function createLeadHandoffCoordinator(deps = {}) {
  const rootDir = deps.rootDir || REPO_ROOT;
  const flagged150 = new Set();
  const writePrompted250 = new Set();
  const autoHandedOff250 = new Set();
  const forced300 = new Set();
  const selfHandedOff = new Set();
  const pendingTakeover = new Map(); // successorId -> takeover record
  const confirmedTakeovers = new Set();
  const deletedHeartbeats = [];
  const inFlightBySlot = deps.sharedSlots ? sharedHttpInFlightBySlot : new Map();
  const evictedSuccessors = deps.sharedSlots ? sharedHttpEvictedSuccessors : new Set(); // dead pending successors: a lagging roster must never offer them for adoption again
  const completedBySlot = deps.sharedSlots ? sharedHttpCompletedBySlot : new Map();

  // The once-only sets are claimed before the awaited label write (so concurrent evaluations don't double-fire); a throw releases the claim.
  const rollbackOnThrow = async (set, id, fn) => {
    try { await fn(); } catch (err) { set.delete(id); throw err; }
  };

  const getBase = () => (typeof deps.baseHome === "function" ? deps.baseHome() : deps.baseHome);

  const setLabels = async (agentId, labels, name) => {
    if (typeof deps.setLabels === "function") {
      return await deps.setLabels(agentId, labels, name);
    }
  };

  const sendMessage = async (agentId, text) => {
    if (typeof deps.sendMessage === "function") {
      return await deps.sendMessage(agentId, text);
    }
  };

  const deleteHeartbeat = async (agentId) => {
    deletedHeartbeats.push(agentId);
    if (typeof deps.deleteHeartbeat === "function") {
      return await deps.deleteHeartbeat(agentId);
    }
  };

  const listAgents = async () => {
    if (typeof deps.listAgents === "function") {
      return (await deps.listAgents()) || [];
    }
    return [];
  };

  const getAgent = async (agentId) => {
    if (typeof deps.getAgent === "function") {
      const a = await deps.getAgent(agentId);
      if (a) return a;
    }
    const all = await listAgents();
    return all.find((x) => x.id === agentId) ?? null;
  };

  const appendLog = (teamId, entry) => {
    if (typeof deps.appendLog === "function") {
      return deps.appendLog(teamId, entry);
    }
    return appendVsLogEntry({
      teamId,
      laneId: entry.lane || teamId,
      agent: entry.agent || "plugin",
      type: entry.type || "handoff",
      text: entry.text,
      refs: entry.refs || [],
    });
  };

  // A repeat of a finished/in-flight handoff returns the earlier result. If that handoff left the old lead pending (auto-250) and this
  // request wants it retired now (handoff_lead), confirm the takeover here instead of returning with two live leads.
  // Returns null when the earlier handoff's pending successor is dead (closed non-resumable / archived / retired / not a lead): the slot
  // is evicted so the caller falls through to a fresh spawn (or adopt) instead of leaving the lane on the old lead with a dead successor.
  // A fetch error is not "dead": only a definite not-found / non-lead answer evicts. `evicted` collects the dead successor ids.
  async function settleDeduped(slotKey, prev, retireNow, oldLeadId, evicted) {
    if (prev?.pendingConfirmation && prev.successorId && !confirmedTakeovers.has(prev.successorId)) {
      let succ;
      let lookupFailed = false;
      try { succ = await getAgent(prev.successorId); } catch { lookupFailed = true; }
      if (!lookupFailed && (!succ || succ.archivedAt || effectiveAgentRole(succ) !== "lead" || isRetiredAgent(succ))) {
        completedBySlot.delete(slotKey);
        pendingTakeover.delete(prev.successorId);
        selfHandedOff.delete(oldLeadId ?? prev.oldLeadId);
        evicted?.add(prev.successorId);
        // Best-effort: stop the dead successor from being adopted again or counted as a lead.
        if (succ && String(succ.labels?.role ?? "") === "lead") {
          await setLabels(succ.id, { ...(succ.labels ?? {}), role: "former-lead", "vs.handoff-from": "" }).catch(() => {});
        }
        return null;
      }
    }
    let out = { ...(prev ?? {}), triggered: false, deduped: true, reason: "already-handed-off" };
    if (retireNow && prev?.pendingConfirmation && prev.successorId) {
      const c = await confirmTakeover(prev.successorId);
      if (c.confirmed || c.alreadyConfirmed) {
        out = { ...out, pendingConfirmation: false, retiredImmediately: true };
        completedBySlot.set(slotKey, { ...prev, pendingConfirmation: false, retiredImmediately: true });
      } else {
        out = { ...out, ok: false, error: c.error ?? "could not retire the old lead" };
      }
    }
    return out;
  }

  async function spawnSuccessor({
    oldLead,
    trigger,
    retireImmediately = false,
    forceSynthesize = false,
    job,
    steer,
  }) {
    const { teamId, teamName, laneId, laneName } = resolveTeamAndLane(oldLead, rootDir);

    // A stale predecessor can't be steered or asked to write Judgment: retire it now. Its packet is never synthesized over.
    const stalePred = isStalePredecessor(oldLead);
    let retireNow = retireImmediately || stalePred;

    const timer = createSpawnTimer("lead-handoff");
    if (typeof deps.connectMs === "number") timer.add("connect", deps.connectMs);
    let allAgents = await listAgents();
    const rawOldOrd = parseLeadOrd(oldLead);
    // Idempotent over retries and server restarts: a live lead already stamped vs.handoff-from=<this lead> is the successor of an
    // earlier attempt (createAgent timed out but the agent exists, or the in-memory slots were lost). Adopt it, never mint a second.
    const evictedBefore = evictedSuccessors.size;
    let adoptable, maxOtherOrd, oldOrd, nextOrd;
    const planOrds = () => {
      adoptable = allAgents.map((x) => x?.agent ?? x).find((a) => a?.id && a.id !== oldLead?.id && !a.archivedAt && !a.internal
        && !evictedSuccessors.has(a.id) && a.labels?.["vs.handoff-from"] === oldLead?.id && effectiveAgentRole(a) === "lead" && !isRetiredAgent(a)) ?? null;
      if (adoptable && trigger === "hard-300") retireNow = true; // forced: the pending successor takes over now, the old lead does not run on
      maxOtherOrd = highestLaneLeadOrd(adoptable ? allAgents.filter((a) => (a?.agent ?? a) !== adoptable) : allAgents, laneId, oldLead?.id);
      const hasExplicitOldOrd = Boolean(String(oldLead?.labels?.ord ?? "").trim()) || /(?:\bord|★\s*[A-Za-z]{2,5})(\d+)\b/i.test(String(oldLead?.title ?? ""));
      oldOrd = !hasExplicitOldOrd && maxOtherOrd > rawOldOrd ? maxOtherOrd : rawOldOrd;
      nextOrd = adoptable && parseLeadOrd(adoptable) > oldOrd ? parseLeadOrd(adoptable) : Math.max(oldOrd, maxOtherOrd) + 1;
    };
    planOrds();

    const slotPrefix = deps.sharedSlots ? `${rootDir}:` : "";
    const slotKey = `${slotPrefix}${teamId}:${laneId}:ord${oldOrd}`;
    const canDedupeSlot = trigger !== "hard-300";
    if (canDedupeSlot && completedBySlot.has(slotKey)) {
      const d = await settleDeduped(slotKey, completedBySlot.get(slotKey), retireImmediately, oldLead?.id, evictedSuccessors);
      if (d) return d;
    }
    if (canDedupeSlot && inFlightBySlot.has(slotKey)) {
      const d = await settleDeduped(slotKey, await inFlightBySlot.get(slotKey), retireImmediately, oldLead?.id, evictedSuccessors);
      if (d) return d;
    }
    // A dedupe eviction means the roster read above is stale (it may still show the dead successor as adoptable): re-plan on a fresh one.
    if (evictedSuccessors.size > evictedBefore) {
      allAgents = await listAgents();
      planOrds();
    }

    const runSpawn = async () => {
    const laneUpper = (laneName || laneId).toUpperCase();
    const { newTitle, oldTitle } = leadTitles({ laneId, laneName, nextOrd, oldOrd, oldLead, job, rootDir });
    const openWorkers = findOpenWorkersForLead(allAgents, oldLead, teamId, laneId);
    timer.mark("fetchAgents");

    const packetPath = getHandoffPacketPath(teamId, laneId, getBase());
    let packetContent = "";
    let synthesized = false;

    const packetExists = existsSync(packetPath);
    let packetStale = false;
    if (packetExists && oldLead?.createdAt) {
      try {
        const createdMs = Date.parse(oldLead.createdAt);
        const mtimeMs = statSync(packetPath).mtimeMs;
        if (!Number.isNaN(createdMs) && mtimeMs < createdMs) {
          packetStale = true;
        }
      } catch {}
    }

    // Never overwrite a predecessor-written packet: synthesize only when none exists, when the existing one is older
    // than this predecessor's own creation, or when the caller forced it (e.g. the 300k hard cap).
    const synthesizeNow = !packetExists || packetStale || forceSynthesize;
    if (synthesizeNow) {
      const synthReason = !packetExists ? "no packet" : packetStale ? "stale packet" : "forced synthesis";
      const syn = synthesizeHandoffPacket({
        lead: oldLead,
        teamId,
        teamName,
        laneId,
        laneName,
        openWorkers,
        rootDir,
        baseHome: getBase(),
        reason: synthReason,
      });
      packetContent = syn.content;
      synthesized = true;
    } else {
      packetContent = readFileSync(packetPath, "utf8");
    }

    const summary = readBrainstormSummary(laneId, rootDir);
    const cwd = oldLead?.cwd || rootDir;
    const latestPlan = findLanePlanFile(cwd, rootDir, laneId, summary.content);
    const { profileName, spawnCfg } = resolveLeadProfile(oldLead, deps.profilesPath);

    const prompt = buildSuccessorPrompt({
      laneId,
      laneName,
      nextOrd,
      newTitle,
      oldLead,
      oldTitle,
      trigger,
      packetPath,
      packetContent,
      summaryPath: summary.path,
      summaryContent: summary.content,
      latestPlan,
      openWorkers,
      steer,
      alreadyRetired: retireNow,
    });

    const newLabels = {
      team: teamId,
      lane: laneId,
      lead: laneId,
      role: "lead",
      ord: String(nextOrd),
      profile: profileName,
      "vs.handoff-from": oldLead.id,
      "vs.handoff-trigger": trigger,
    };

    timer.mark("prep");
    let created = adoptable;
    if (!adoptable && typeof deps.createAgent === "function") {
      created = await deps.createAgent({
        config: {
          provider: spawnCfg.provider,
          model: spawnCfg.model,
          cwd,
          title: newTitle,
          modeId: spawnCfg.modeId,
          thinkingOptionId: spawnCfg.thinkingOptionId,
          ...(spawnCfg.featureValues ? { featureValues: { ...spawnCfg.featureValues } } : {}),
          ...(spawnCfg.systemPrompt ? { systemPrompt: spawnCfg.systemPrompt } : {}),
        },
        cwd,
        title: newTitle,
        prompt,
        initialPrompt: prompt,
        labels: newLabels,
        // Labels never reach the plugin's before(agent.create); env does, so the profile is forced at spawn.
        env: { VS_ROLE: "lead", ...(profileName ? { VS_PROFILE: profileName } : {}) },
      });
    }

    timer.mark("createAgent");
    // No real successor id -> nothing was spawned: fail before re-parenting workers or touching the old lead.
    const successorId = String(created?.id ?? "").trim();
    if (!successorId) throw new Error(`lead-handoff: successor spawn for lane "${laneId}" returned no agent id; old lead ${oldLead.id} left in place`);
    const successor = {
      id: successorId,
      title: created?.title || newTitle,
      provider: created?.provider || spawnCfg.provider,
      model: created?.model || spawnCfg.model,
      modeId: created?.modeId ?? spawnCfg.modeId,
      thinkingOptionId: created?.thinkingOptionId ?? spawnCfg.thinkingOptionId,
      ...(spawnCfg.featureValues ? { featureValues: { ...spawnCfg.featureValues } } : {}),
      cwd,
      status: created?.status || "idle",
      labels: { ...(created?.labels ?? {}), ...newLabels },
      prompt,
    };

    // Re-point open in-flight workers and notify them to report to the new lead.
    const repointedWorkers = [];
    for (const w of openWorkers) {
      const updatedWorkerLabels = {
        ...(w.labels ?? {}),
        "vs.parent": successor.id, // the one parent key (RunnerBackend.toAgent reads it; X1c dropped paseo.parent-agent-id)
      };
      // Best-effort per worker: a failed repoint must not abort the handoff after the successor exists (that strands two leads).
      try {
        await setLabels(w.id, updatedWorkerLabels);
        repointedWorkers.push(w.id);
        await sendMessage(w.id, `Report to ${successor.title} (${successor.id}).`);
      } catch {}
    }

    timer.mark("repoint");
    // Delete old lead's heartbeat.
    await deleteHeartbeat(oldLead.id);

    // Record handoff log entry with trigger=self | auto-250 | hard-300.
    const logText = `lead ${oldLead.id} -> ${successor.id} (ord${oldOrd} -> ord${nextOrd}): handoff (trigger=${trigger})`.slice(
      0,
      240,
    );
    appendLog(teamId, {
      agent: successor.id,
      lane: laneId,
      type: "handoff",
      text: logText,
      refs: [packetPath, oldLead.id, successor.id],
    });

    const oldLabels = { ...(oldLead?.labels ?? {}) };
    const takeoverRecord = {
      oldLeadId: oldLead.id,
      successorId: successor.id,
      oldTitle,
      ord: String(oldOrd),
      teamId,
      laneId,
      trigger,
      oldLabels,
    };

    const buildResult = (retired) => ({
      ok: true,
      handoffId: `${teamId}:${laneId}:ord${oldOrd}->ord${nextOrd}`,
      trigger,
      oldLeadId: oldLead.id,
      successorId: successor.id,
      successor,
      ord: oldOrd,
      nextOrd,
      title: successor.title,
      oldTitle,
      teamId,
      laneId,
      packetPath,
      synthesizedPacket: synthesized,
      prompt,
      repointedWorkers,
      retiredImmediately: retired,
      pendingConfirmation: !retired,
    });

    if (retireNow) {
      // Record the created successor BEFORE the retire write: if it throws and the retry's roster lags, the retry finds this pending
      // handoff (settleDeduped -> confirmTakeover) instead of minting a second successor.
      pendingTakeover.set(successor.id, takeoverRecord);
      completedBySlot.set(slotKey, buildResult(false));
      await setLabels(
        oldLead.id,
        {
          ...oldLabels,
          role: "former-lead",
          ord: String(oldOrd),
          "handoff-successor": successor.id,
        },
        oldTitle,
      );
      pendingTakeover.delete(successor.id);
      confirmedTakeovers.add(successor.id);
      await sweepEarlierLaneLeads({ teamId, laneId, laneName, successorId: successor.id, excludeIds: new Set([successor.id, oldLead.id]), maxOrd: nextOrd, roster: allAgents });
    } else {
      pendingTakeover.set(successor.id, takeoverRecord);
    }

    timer.mark("retire");
    timer.flush({ teamId, laneId, agent: successor.id });
    const result = buildResult(retireNow);
    completedBySlot.set(slotKey, result);
    return result;
    };

    const p = runSpawn();
    if (canDedupeSlot) inFlightBySlot.set(slotKey, p);
    try {
      return await p;
    } finally {
      if (inFlightBySlot.get(slotKey) === p) inFlightBySlot.delete(slotKey);
    }
  }

  function isLostOrClosedLead(agent) {
    return Boolean(agent?.lost) || ["closed", "lost"].includes(String(agent?.status ?? "").trim().toLowerCase());
  }

  function agentTeamAndLane(agent, teams) {
    const rawTeam = String(agent?.labels?.team ?? "").trim();
    const rawLane = String(agent?.labels?.lane || agent?.labels?.lead || "").trim();
    const teamObj = rawTeam ? findTeamInRegistry(rawTeam, teams) : null;
    const preferTeamId = teamObj?.id || rawTeam;
    const resolved = rawLane ? findLaneInRegistry(rawLane, teams, preferTeamId) : null;
    if (resolved && (!preferTeamId || resolved.team.id.toLowerCase() === preferTeamId.toLowerCase())) {
      return { teamId: resolved.team.id.toLowerCase(), laneId: resolved.lane.id.toLowerCase() };
    }
    const fallback = resolveTeamAndLane(agent, rootDir);
    return {
      teamId: String(teamObj?.id || rawTeam || fallback.teamId || "").trim().toLowerCase(),
      laneId: String(resolved?.lane?.id || rawLane || fallback.laneId || "").trim().toLowerCase(),
    };
  }

  async function retireLeadRecord(old, { successorId, laneId, laneName, nextOrd }) {
    const oldOrd = parseLeadOrd(old);
    const { oldTitle } = leadTitles({
      laneId,
      laneName,
      nextOrd: nextOrd ?? oldOrd + 1,
      oldOrd,
      oldLead: old,
      rootDir,
    });
    const nextLabels = {
      ...(old.labels ?? {}),
      role: "former-lead",
      ord: String(oldOrd),
      ...(successorId ? { "handoff-successor": successorId } : {}),
    };
    await deleteHeartbeat(old.id);
    await setLabels(old.id, nextLabels, oldTitle);
    return { id: old.id, oldTitle: old.title ?? "", newTitle: oldTitle, ord: oldOrd };
  }

  async function sweepEarlierLaneLeads({ teamId, laneId, laneName, successorId, excludeIds, maxOrd, roster }) {
    const list = Array.isArray(roster) ? roster : await listAgents().catch(() => []);
    const teams = loadTeamsRegistry(rootDir);
    const foundLane = findLaneInRegistry(String(laneId || teamId || "vibesquad"), teams, teamId ? String(teamId) : "");
    const wantTeam = String(teamId || foundLane?.team?.id || "vibesquad").trim().toLowerCase();
    const wantLane = String(foundLane?.lane?.id || laneId || wantTeam).trim().toLowerCase();
    const laneLeads = list
      .map((raw) => raw?.agent ?? raw)
      .filter((a) => {
        if (!a?.id || a.archivedAt || a.internal || (a.status === "closed" && a.resumable !== true)) return false;
        if (effectiveAgentRole(a) !== "lead" || isRetiredAgent(a)) return false;
        const { teamId: aTeam, laneId: aLane } = agentTeamAndLane(a, teams);
        return aTeam === wantTeam && aLane === wantLane;
      });
    const res = resolveLeadWinner(laneLeads);
    const pendingSet = new Set(res.pending ?? []);
    const contenderSet = new Set(res.conflict ? (res.contenders ?? []) : []);
    const laneLeadIds = new Set(laneLeads.map((a) => a.id));
    for (const a of laneLeads) {
      if (excludeIds.has(a.id) || pendingTakeover.has(a.id) || pendingSet.has(a.id) || contenderSet.has(a.id)) continue;
      if (isHandoffPending(a, laneLeadIds)) continue;
      if (Number.isFinite(maxOrd) && parseLeadOrd(a) >= maxOrd) continue;
      try {
        await retireLeadRecord(a, { successorId, laneId, laneName, nextOrd: maxOrd });
      } catch {}
    }
  }

  async function retireStaleLeads({ teamId: rawTeamId, laneId: rawLaneId, callerId } = {}) {
    const teams = loadTeamsRegistry(rootDir);
    const foundLane = findLaneInRegistry(String(rawLaneId || rawTeamId || "vibesquad"), teams, rawTeamId ? String(rawTeamId) : "");
    const teamId = (rawTeamId && findTeamInRegistry(String(rawTeamId), teams)?.id) || foundLane?.team?.id || safeSegment(rawTeamId || "vibesquad");
    const laneId = foundLane?.lane?.id || safeSegment(rawLaneId || teamId);
    const laneName = foundLane?.lane?.name || laneId;
    const wantTeam = teamId.toLowerCase();
    const wantLane = laneId.toLowerCase();

    const rawList = await listAgents();
    const allAgents = (Array.isArray(rawList) ? rawList : []).map((x) => x?.agent ?? x).filter(Boolean);
    const laneLeads = allAgents.filter((a) => {
      if (!a?.id || a.archivedAt || a.internal || (a.status === "closed" && a.resumable !== true)) return false;
      if (effectiveAgentRole(a) !== "lead" || isRetiredAgent(a)) return false;
      const { teamId: aTeam, laneId: aLane } = agentTeamAndLane(a, teams);
      return aTeam === wantTeam && aLane === wantLane;
    });

    if (callerId) {
      const caller = allAgents.find((a) => a.id === callerId) ?? (await getAgent(callerId).catch(() => null));
      if (!caller) {
        throw Object.assign(new Error(`lead-handoff: forbidden: caller ${callerId} not found`), { status: 403 });
      }
      {
        const callerRole = effectiveAgentRole(caller);
        if ((callerRole !== "lead" && callerRole !== "brainstorm") || isRetiredAgent(caller) || caller.archivedAt) {
          throw Object.assign(
            new Error("lead-handoff: forbidden: only the owner, a brainstorm (Buddy) or a lead may retire stale leads"),
            { status: 403 },
          );
        }
        if (isLostOrClosedLead(caller)) {
          throw Object.assign(
            new Error(`lead-handoff: forbidden: ${callerId} is lost/closed, not an active live lead or Buddy`),
            { status: 403 },
          );
        }
        const { teamId: callerTeamId, laneId: callerLaneId } = agentTeamAndLane(caller, teams);
        if (callerTeamId !== wantTeam) {
          throw Object.assign(
            new Error(`lead-handoff: forbidden: target lane "${laneId}" is not in the caller's Squad "${callerTeamId}"`),
            { status: 403 },
          );
        }
        if (callerLaneId !== wantLane) {
          const callerTeamObj = findTeamInRegistry(callerTeamId, teams);
          const callerLaneObj = findLaneInRegistry(callerLaneId, teams, callerTeamId)?.lane;
          if (effectiveAgentRole(caller) !== "lead" || !callerTeamObj || !callerLaneObj || !isHubLane(callerTeamObj, callerLaneObj)) {
            throw Object.assign(
              new Error("lead-handoff: forbidden: only the Squad's hub lead (Overlord) or the owner may retire stale leads in another lane"),
              { status: 403 },
            );
          }
          const hubLeads = allAgents.filter((a) => {
            if (!a?.id || a.archivedAt || a.internal || (a.status === "closed" && a.resumable !== true)) return false;
            if (effectiveAgentRole(a) !== "lead" || isRetiredAgent(a)) return false;
            const { teamId: aTeam, laneId: aLane } = agentTeamAndLane(a, teams);
            return aTeam === callerTeamId && aLane === callerLaneId;
          });
          const hubRes = resolveLeadWinner(hubLeads);
          if (hubRes.conflict || !hubRes.winner || hubRes.winner.id !== callerId) {
            throw Object.assign(
              new Error(`lead-handoff: forbidden: ${callerId} is not the active hub lead (Overlord) of Squad "${teamId}" (${hubRes.winner?.id || "conflict"})`),
              { status: 403 },
            );
          }
        }
      }
    }

    if (!laneLeads.length) {
      return { ok: true, action: "retire", teamId, laneId, winnerId: null, title: "", retired: [] };
    }

    const res = resolveLeadWinner(laneLeads);
    if (callerId && laneLeads.some((a) => a.id === callerId) && (res.conflict || callerId !== res.winner?.id)) {
      throw Object.assign(
        new Error(`lead-handoff: forbidden: ${callerId} is not the active lead of lane "${laneId}" (${res.winner?.id || "conflict"})`),
        { status: 403 },
      );
    }

    if (res.conflict || !res.winner) {
      const ids = (res.contenders?.length ? res.contenders : laneLeads).map((a) => `${a.title || a.id} (${a.id})`).join(", ");
      return {
        ok: false,
        error: `cannot retire leads in lane "${laneId}": top leads are genuinely ambiguous (${ids})`,
      };
    }

    const winner = res.winner;
    const laneLeadIds = new Set(laneLeads.map((a) => a.id));
    const pendingSet = new Set(res.pending ?? []);
    for (const a of laneLeads) {
      // vs.handoff-from is permanent history; only a successor whose predecessor is still an unretired lane lead is mid-takeover.
      if (pendingTakeover.has(a.id) || isHandoffPending(a, laneLeadIds)) pendingSet.add(a.id);
    }
    if (pendingSet.size > 0) {
      const ids = [...pendingSet].join(", ");
      return {
        ok: false,
        error: `cannot retire leads in lane "${laneId}": takeover is pending (${ids})`,
      };
    }

    const winnerOrd = parseLeadOrd(winner);
    const retired = [];
    for (const old of laneLeads) {
      if (old.id === winner.id || pendingSet.has(old.id) || pendingTakeover.has(old.id) || isHandoffPending(old, laneLeadIds)) continue;
      if (parseLeadOrd(old) >= winnerOrd) continue;
      const item = await retireLeadRecord(old, { successorId: winner.id, laneId, laneName, nextOrd: winnerOrd });
      retired.push(item);
    }

    if (retired.length) {
      const retiredSummary = retired.map((r) => `${r.id} (ord${r.ord})`).join(", ");
      try {
        appendLog(teamId, {
          agent: callerId || winner.id,
          lane: laneId,
          type: "handoff",
          text: `lead retire in ${laneId}: kept ${winner.title || winner.id} (${winner.id}); retired ${retiredSummary}`.slice(0, 240),
          refs: [winner.id, ...retired.map((r) => r.id)],
        });
      } catch {}
    }

    return {
      ok: true,
      action: "retire",
      teamId,
      laneId,
      winnerId: winner.id,
      title: winner.title ?? "",
      retired,
    };
  }

  async function confirmTakeover(successorId) {
    const id = String(successorId ?? "").trim();
    if (!id) return { confirmed: false, error: "successorId is required" };
    if (confirmedTakeovers.has(id)) {
      return { confirmed: false, alreadyConfirmed: true, successorId: id };
    }

    const succAgent = await getAgent(id);
    if (!succAgent || succAgent.archivedAt || effectiveAgentRole(succAgent) !== "lead" || isRetiredAgent(succAgent)) {
      return { confirmed: false, error: "successor is not a live lead", successorId: id };
    }
    let rec = pendingTakeover.get(id) || null;
    if (!rec) {
      const succ = succAgent;
      const fromId = succ?.labels?.["vs.handoff-from"];
      if (fromId) {
        const old = await getAgent(fromId);
        if (old) {
          const { teamId, laneId, laneName } = resolveTeamAndLane(old, rootDir);
          const oldOrd = parseLeadOrd(old);
          rec = {
            oldLeadId: old.id,
            successorId: id,
            oldTitle: leadTitles({ laneId, laneName, nextOrd: oldOrd + 1, oldOrd, oldLead: old, rootDir }).oldTitle,
            ord: String(oldOrd),
            teamId,
            laneId,
            trigger: succ?.labels?.["vs.handoff-trigger"] || "auto-250",
            oldLabels: { ...(old.labels ?? {}) },
          };
        }
      }
    }

    if (!rec) {
      return { confirmed: false, error: "no pending takeover for agent", successorId: id };
    }

    const currentOld = await getAgent(rec.oldLeadId);
    const mergedOldLabels = {
      ...rec.oldLabels,
      ...(currentOld?.labels ?? {}),
      role: "former-lead",
      ord: rec.ord,
      "handoff-successor": id,
    };

    try {
      await setLabels(rec.oldLeadId, mergedOldLabels, rec.oldTitle);
    } catch (err) {
      // Nothing was mutated: the takeover stays pending and a retry can confirm it.
      return { confirmed: false, error: `could not retire the old lead: ${err?.message ?? err}`, successorId: id };
    }
    pendingTakeover.delete(id);
    confirmedTakeovers.add(id);

    const { teamId: succTeamId, laneId: succLaneId, laneName: succLaneName } = resolveTeamAndLane(succAgent, rootDir);
    await sweepEarlierLaneLeads({
      teamId: rec.teamId || succTeamId,
      laneId: rec.laneId || succLaneId,
      laneName: succLaneName,
      successorId: id,
      excludeIds: new Set([id, rec.oldLeadId]),
      maxOrd: parseLeadOrd(succAgent),
    });

    return {
      confirmed: true,
      oldLeadId: rec.oldLeadId,
      successorId: id,
      oldTitle: rec.oldTitle,
      labels: mergedOldLabels,
    };
  }

  async function triggerSelfHandoff(leadOrId, options = {}) {
    const lead = typeof leadOrId === "string" ? await getAgent(leadOrId) : leadOrId;
    if (!lead || !lead.id) throw new Error("lead agent not found");
    const { teamId, laneId } = resolveTeamAndLane(lead, rootDir);
    const slotPrefix = deps.sharedSlots ? `${rootDir}:` : "";
    const slotKey = `${slotPrefix}${teamId}:${laneId}:ord${parseLeadOrd(lead)}`;
    if (selfHandedOff.has(lead.id) || completedBySlot.has(slotKey)) {
      const d = await settleDeduped(slotKey, completedBySlot.get(slotKey), Boolean(options.retireImmediately), lead.id, evictedSuccessors);
      if (d) return { ok: true, stage: "self", ...d };
    }
    if (inFlightBySlot.has(slotKey)) {
      const d = await settleDeduped(slotKey, await inFlightBySlot.get(slotKey), Boolean(options.retireImmediately), lead.id, evictedSuccessors);
      if (d) return { ok: true, stage: "self", ...d };
    }
    selfHandedOff.add(lead.id);
    let res;
    try {
      res = await spawnSuccessor({
        oldLead: lead,
        trigger: options.trigger === "buddy" || options.trigger === "overlord" ? options.trigger : "self",
        retireImmediately: Boolean(options.retireImmediately),
        forceSynthesize: Boolean(options.forceSynthesize),
        job: options.job,
        steer: options.steer,
      });
    } catch (err) {
      selfHandedOff.delete(lead.id); // a failed spawn must stay retryable
      throw err;
    }
    if (res?.ok === false) selfHandedOff.delete(lead.id);
    return { stage: "self", triggered: !res.deduped, ...res };
  }

  async function evaluateLead(lead, options = {}) {
    if (!lead || !lead.id) return { stage: "none", triggered: false };
    const labels = lead.labels ?? {};
    if (isRetiredAgent(lead)) {
      return { stage: "retired", triggered: false };
    }

    const { teamId, laneId, teamDef } = resolveTeamAndLane(lead, rootDir);
    const thresholds =
      options.thresholds ||
      (typeof deps.getThresholds === "function"
        ? deps.getThresholds(teamDef || teamId, rootDir)
        : loadLeadThresholds(teamDef || teamId, rootDir));

    const used = leadUsedTokens(lead, options.usedTokens);
    const { flagTokens, autoHandoffTokens, hardCapTokens } = thresholds;

    // K2: before any stage, a Claude lead at the soft threshold is compacted in place once (idle only, tracked by vs.compacted-at).
    // Anything but a clean "ok" under the soft threshold falls through to the unchanged ladder below.
    if (typeof deps.compactStep === "function" && used >= flagTokens && !labels["vs.compacted-at"]) {
      const res = await deps.compactStep(lead, { focus: LEAD_COMPACT_FOCUS, cap: flagTokens, kind: "lead", teamId, laneId }).catch(() => null);
      if (res?.outcome === "ok") return { stage: "compact", triggered: true, usedTokens: res.after, beforeTokens: used };
      // Mid-turn: usage upserts arrive with status=running. Wait for the idle upsert instead of nudging or handing off now (no stamp, no
      // nudge). The hard cap is the exception: past it a running lead still goes to the forced handoff below.
      if (res?.outcome === "skipped" && res.reason === "busy" && used < hardCapTokens) {
        return { stage: "compact-deferred", triggered: false, usedTokens: used };
      }
    }

    // Stage 4: >= 300k Hard Ceiling Forced Handoff (fires at most once per lead).
    if (used >= hardCapTokens) {
      if (forced300.has(lead.id) || labels["handoff-hard-300"] === "1") {
        return { stage: "hard-300", triggered: false, usedTokens: used };
      }
      forced300.add(lead.id);
      const packetPath = getHandoffPacketPath(teamId, laneId, getBase());
      const needsSynthesis =
        !existsSync(packetPath) ||
        Boolean(options.forceSynthesize) ||
        autoHandedOff250.has(lead.id);
      await rollbackOnThrow(forced300, lead.id, () => setLabels(lead.id, {
        ...labels,
        "handoff-flagged": "1",
        "handoff-hard-300": "1",
      }));
      const spawned = await spawnSuccessor({
        oldLead: {
          ...lead,
          labels: { ...labels, "handoff-flagged": "1", "handoff-hard-300": "1" },
        },
        trigger: "hard-300",
        retireImmediately: false,
        forceSynthesize: needsSynthesis,
      });
      return { stage: "hard-300", triggered: true, usedTokens: used, ...spawned };
    }

    // Stage 3: >= 250k and < 300k VS Auto-Handoff.
    if (used >= autoHandoffTokens) {
      if (autoHandedOff250.has(lead.id) || labels["handoff-auto-250"] === "1") {
        return { stage: "auto-250", triggered: false, usedTokens: used };
      }
      // A stale predecessor (stuck initializing/queued, or silent too long) can't be steered: hand it off now.
      const stalePred = isStalePredecessor(lead);
      const isRunning = lead.status === "running";
      const packetPath = getHandoffPacketPath(teamId, laneId, getBase());
      const hasPacket = existsSync(packetPath);

      if (!stalePred && (isRunning || !hasPacket)) {
        if (writePrompted250.has(lead.id) || labels["handoff-write-prompted"] === "1") {
          return {
            stage: "prompt-250",
            triggered: false,
            waitingForIdleOrPacket: true,
            usedTokens: used,
          };
        }
        writePrompted250.add(lead.id);
        await rollbackOnThrow(writePrompted250, lead.id, async () => {
          await setLabels(lead.id, {
            ...labels,
            "handoff-flagged": "1",
            "handoff-write-prompted": "1",
          });
          await sendMessage(lead.id, WRITE_HANDOFF_PROMPT);
        });
        return {
          stage: "prompt-250",
          triggered: true,
          waitingForIdleOrPacket: true,
          usedTokens: used,
        };
      }

      autoHandedOff250.add(lead.id);
      await rollbackOnThrow(autoHandedOff250, lead.id, () => setLabels(lead.id, {
        ...labels,
        "handoff-flagged": "1",
        "handoff-auto-250": "1",
      }));
      const spawned = await spawnSuccessor({
        oldLead: {
          ...lead,
          labels: { ...labels, "handoff-flagged": "1", "handoff-auto-250": "1" },
        },
        trigger: "auto-250",
        retireImmediately: false,
        forceSynthesize: false,
      });
      return { stage: "auto-250", triggered: true, usedTokens: used, ...spawned };
    }

    // Stage 1: >= 150k Soft Flag + Nudge (fires at most once per lead).
    if (used >= flagTokens) {
      // "handoff-nudged" (not "handoff-flagged") proves the nudge went out: the browser used to pre-set handoff-flagged as a display flag,
      // which silently suppressed the nudge for three leads in a row.
      if (flagged150.has(lead.id) || labels["handoff-nudged"] === "1") {
        return { stage: "flag-150", triggered: false, usedTokens: used };
      }
      flagged150.add(lead.id);
      const nextLabels = {
        ...labels,
        "needs-you": SOFT_FLAG_REASON,
        "needs-you-reason": SOFT_FLAG_REASON,
        "needs-you-at": new Date().toISOString(),
        "handoff-flagged": "1",
        "handoff-nudged": "1",
      };
      await rollbackOnThrow(flagged150, lead.id, async () => {
        await setLabels(lead.id, nextLabels);
        await sendMessage(lead.id, SOFT_FLAG_NUDGE);
      });
      return {
        stage: "flag-150",
        triggered: true,
        usedTokens: used,
        reason: SOFT_FLAG_REASON,
        nudge: SOFT_FLAG_NUDGE,
      };
    }

    return { stage: "none", triggered: false, usedTokens: used };
  }

  return {
    evaluateLead,
    triggerSelfHandoff,
    confirmTakeover,
    spawnSuccessor,
    retireStaleLeads,
    hasPendingTakeover: (successorId) => pendingTakeover.has(String(successorId ?? "")),
    getPendingTakeover: (successorId) => pendingTakeover.get(String(successorId ?? "")) ?? null,
    deletedHeartbeats,
    state: {
      flagged150,
      writePrompted250,
      autoHandedOff250,
      forced300,
      selfHandedOff,
      pendingTakeover,
      confirmedTakeovers,
    },
  };
}

/** opts.agentsForTest: DI-only roster for the callerId re-check (never read from an HTTP body; X1c). */
export async function performLeadHandoffHttp(body = {}, rootDir = REPO_ROOT, { agentsForTest } = {}) {
  const trigger = String(body.trigger || "self").trim();
  const injectedClient = body.agentClient || null;
  const client = injectedClient || (body.skipBackend ? null : createAgentClient(rootDir));
  const backend = getBackend(client);
  let connected = Boolean(injectedClient);
  const connectT0 = Date.now();
  let connectMs;
  let backgroundHandoff = null;

  try {
    if (client && !injectedClient && typeof backend.connect === "function") {
      await backend.connect().catch(() => {});
      connected = true;
      connectMs = Date.now() - connectT0;
    }

    const deps = {
      connectMs,
      rootDir,
      baseHome: body.baseHome,
      profilesPath: body.profilesPath,
      sharedSlots: body.sharedSlots ?? true,
      async listAgents() {
        if (Array.isArray(body.agents)) return body.agents;
        if (connected && client) return listDaemonAgents(backend);
        if (Array.isArray(agentsForTest)) return agentsForTest;
        return [];
      },
      async getAgent(id) {
        if (body.oldLead && body.oldLead.id === id) return body.oldLead;
        if (Array.isArray(body.agents)) {
          const found = body.agents.find((a) => a.id === id);
          if (found) return found;
        }
        if (connected && client && typeof backend.fetchAgent === "function") {
          // Only a definite not-found means "gone"; any other failure propagates so callers don't treat a blip as a dead agent.
          const r = await backend.fetchAgent(id).catch((err) => {
            if (isAgentNotFoundError(err)) return null;
            throw err;
          });
          return r?.agent ?? null;
        }
        if (Array.isArray(agentsForTest)) {
          const found = agentsForTest.map((a) => a?.agent ?? a).find((a) => a?.id === id);
          if (found) return found;
        }
        return null;
      },
      async setLabels(agentId, labels, name) {
        if (connected && client && typeof backend.updateAgent === "function") {
          await backend.updateAgent(agentId, { ...(name ? { name } : {}), labels });
        }
      },
      async sendMessage(agentId, text) {
        if (connected && client && typeof backend.sendAgentPrompt === "function") {
          await backend.sendAgentPrompt(agentId, text).catch(() => {});
        }
      },
      async createAgent(payload) {
        if (connected && client && typeof backend.createAgent === "function") {
          return await backend.createAgent({
            config: payload.config,
            initialPrompt: payload.initialPrompt || payload.prompt,
            labels: payload.labels,
            ...(payload.env ? { env: payload.env } : {}),
          });
        }
        return null;
      },
      async deleteHeartbeat(agentId) {
        if (isRunnerId(agentId)) {
          try { (await sharedSchedules()).deleteHeartbeat(agentId); } catch {} // runner lanes: heartbeats live in the VS store
          return;
        }
        if (connected && client && typeof backend.deleteHeartbeat === "function") {
          await backend.deleteHeartbeat(agentId).catch(() => {});
        }
      },
    };
    const coordinator = createLeadHandoffCoordinator(deps);

    if (body.action === "confirm" || body.confirmSuccessorId) {
      return await coordinator.confirmTakeover(body.confirmSuccessorId || body.successorId || body.agentId);
    }

    if (body.action === "retire") {
      const forbid = (why) => Object.assign(new Error(`lead-handoff: forbidden: ${why}`), { status: 403 });
      const teams = loadTeamsRegistry(rootDir);
      let targetTeamId = String(body.teamId || body.team || "").trim();
      let targetLaneId = String(body.laneId || body.lane || "").trim();
      if (body.callerId) {
        const callerId = String(body.callerId);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(callerId)) throw forbid("bad callerId");
        let caller = Array.isArray(agentsForTest) ? agentsForTest.map((a) => a?.agent ?? a).find((a) => a?.id === callerId) ?? null : null;
        if (!caller && isRunnerId(callerId)) caller = readRunnerAgentSync(callerId);
        if (!caller && connected && client && typeof backend.fetchAgent === "function") {
          caller = (await backend.fetchAgent(callerId).catch(() => null))?.agent ?? null;
        }
        if (!caller) throw forbid("caller not found");
        const callerRole = effectiveAgentRole(caller);
        const callerLost = Boolean(caller.lost) || ["closed", "lost"].includes(String(caller.status ?? "").trim().toLowerCase());
        if ((callerRole !== "lead" && callerRole !== "brainstorm") || isRetiredAgent(caller) || caller.archivedAt) {
          throw forbid("only the owner, a brainstorm (Buddy) or a lead may retire stale leads");
        }
        if (callerLost) {
          throw forbid(`${callerId} is lost/closed, not the active live ${callerRole === "lead" ? "lead" : "Buddy"}`);
        }
        const callerTeam = findTeamInRegistry(String(caller.labels?.team || ""), teams);
        const callerLane = findLaneInRegistry(String(caller.labels?.lane || caller.labels?.lead || ""), teams, callerTeam?.id)?.lane;
        if (!callerTeam || !callerLane) throw forbid("caller team/lane not in registry");
        const target = targetLaneId ? findLaneInRegistry(targetLaneId, teams, callerTeam.id) : { team: callerTeam, lane: callerLane };
        if (!target || target.team.id !== callerTeam.id) throw forbid(`target lane "${targetLaneId}" is not in the caller's Squad "${callerTeam.id}"`);
        if (target.lane.id !== callerLane.id && !(callerRole === "lead" && isHubLane(callerTeam, callerLane))) {
          throw forbid("only the Squad's hub lead (Overlord) or the owner may retire stale leads in another lane");
        }
        targetTeamId = callerTeam.id;
        targetLaneId = target.lane.id;
      } else {
        const found = findLaneInRegistry(targetLaneId || targetTeamId || "vibesquad", teams, targetTeamId);
        if (!found) throw new Error(`lead-handoff: unknown lane "${targetLaneId || targetTeamId || "vibesquad"}"`);
        targetTeamId = found.team.id;
        targetLaneId = found.lane.id;
      }
      return await coordinator.retireStaleLeads({ teamId: targetTeamId, laneId: targetLaneId, callerId: body.callerId });
    }

    // In-process callers may pass oldLead; HTTP callers can't (sanitizeBody strips it and `agents`), so the
    // lead is a live role=lead agent from the daemon, by agentId or by lane. Never synthesized from the body.
    let lead = body.oldLead || null;
    if (!lead && body.agentId != null && !/^[A-Za-z0-9_-]{1,64}$/.test(String(body.agentId))) {
      throw new Error("lead-handoff: bad agentId");
    }
    if (!lead && body.agentId) {
      if (Array.isArray(body.agents)) {
        lead = body.agents.find((a) => (a?.agent ?? a)?.id === body.agentId) ?? null;
        if (lead?.agent) lead = lead.agent;
      }
      if (!lead && connected && client && typeof backend.fetchAgent === "function") {
        const fetched = await backend.fetchAgent(body.agentId).catch(() => null);
        lead = fetched?.agent ?? null;
      }
    }
    if (!lead) {
      const liveList = Array.isArray(body.agents)
        ? body.agents.map((a) => a?.agent ?? a)
        : connected && client
          ? await listDaemonAgents(backend)
          : [];
      if (body.agentId) {
        lead = liveList.find((a) => a?.id === body.agentId) ?? null;
      }
      if (!lead) {
        const wantLane = String(body.laneId || body.lane || body.teamId || body.team || "vibesquad").trim().toLowerCase();
        const laneLeads = liveList.filter((a) => {
          if (!a || a.archivedAt || a.internal || (a.status === "closed" && a.resumable !== true)) return false;
          if (effectiveAgentRole(a) !== "lead" || isRetiredAgent(a)) return false;
          const aLane = String(a.labels?.lane || a.labels?.lead || "").trim().toLowerCase();
          return aLane === wantLane;
        });
        if (laneLeads.length) {
          lead = resolveLeadWinner(laneLeads).winner ?? laneLeads[0];
        }
      }
    }
    if (!lead || !lead.id) throw new Error(`lead agent not found: ${body.agentId || body.laneId || body.lane || "vibesquad"}`);
    if (!body.oldLead && effectiveAgentRole(lead) !== "lead") throw new Error(`not a lead: ${lead.id}`);
    // A Buddy or lead hands off a live lead: the target must be one (not archived, not closed-dead, not already retired).
    // A closed-but-resumable lead (lost, no successor) is accepted as the source and retired, not required to be live.
    if ((trigger === "buddy" || trigger === "self" || trigger === "overlord") && (lead.archivedAt || (lead.status === "closed" && lead.resumable !== true) || isRetiredAgent(lead))) {
      throw new Error(`lead-handoff: ${lead.id} is not a live lead`);
    }
    // Defence in depth: the handoff_lead tool sends callerId, so re-check it from the caller's own record. Local-token holders
    // are the owner by design and stay trusted; legacy calls without callerId (auto/soft triggers) are unchanged.
    const forbid = (why) => Object.assign(new Error(`lead-handoff: forbidden: ${why}`), { status: 403 });
    let forcedLog = null; // written only once a handoff really spawns (not on a deduped repeat or failed spawn)
    // The Overlord trigger is new and cross-lane: it always needs a verifiable callerId (no legacy callerId-less path).
    if (trigger === "overlord" && !body.callerId) throw forbid("overlord handoff needs a callerId");
    if (body.callerId && (trigger === "buddy" || trigger === "self" || trigger === "overlord")) {
      const callerId = String(body.callerId);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(callerId)) throw forbid("bad callerId");
      if (trigger === "self") {
        if (callerId !== lead.id) throw forbid("a lead may only hand off itself");
      } else {
        // X1c: the caller's record comes from the runner (or the DI-only agentsForTest), never from a body roster.
        let caller = Array.isArray(agentsForTest) ? agentsForTest.map((a) => a?.agent ?? a).find((a) => a?.id === callerId) ?? null : null;
        if (!caller && isRunnerId(callerId)) caller = readRunnerAgentSync(callerId);
        if (!caller && connected && client && typeof backend.fetchAgent === "function") {
          caller = (await backend.fetchAgent(callerId).catch(() => null))?.agent ?? null;
        }
        if (!caller) throw forbid("caller not found");
        const wantRole = trigger === "overlord" ? "lead" : "brainstorm";
        if (effectiveAgentRole(caller) !== wantRole || isRetiredAgent(caller) || caller.archivedAt || (caller.status === "closed" && caller.resumable !== true)) {
          throw forbid(trigger === "overlord" ? "caller is not a live lead" : "caller is not a live Buddy");
        }
        const teams = loadTeamsRegistry(rootDir);
        const laneOf = (a) => findLaneInRegistry(String(a.labels?.lane || a.labels?.lead || ""), teams)?.lane;
        const callerLane = laneOf(caller);
        const leadLane = laneOf(lead);
        const callerTeam = findTeamInRegistry(String(caller.labels?.team || ""), teams);
        const leadTeam = findTeamInRegistry(String(lead.labels?.team || ""), teams);
        if (trigger === "overlord") {
          if (!callerLane || !leadLane || !callerTeam || !leadTeam || callerTeam.id !== leadTeam.id) throw forbid("caller is not in the lead's Squad");
          const inSquad = (a, lane) => findLaneInRegistry(String(a.labels?.lane || a.labels?.lead || ""), teams)?.team.id === callerTeam.id && (callerTeam.lanes || []).some((l) => l.id === lane.id);
          if (!inSquad(caller, callerLane) || !inSquad(lead, leadLane)) throw forbid("caller or target lane is not in the caller's Squad");
          if (!isHubLane(callerTeam, callerLane)) throw forbid("caller is not the Squad's hub lead (Overlord)");
          if (callerId === lead.id || callerLane.id === leadLane.id) throw forbid("the Overlord may not use the overlord trigger on itself or its own lane");
          // O6 floor: a healthy lead under 100k is steered, not handed off. --force needs a steer and is logged.
          const steerNote = String(body.steer ?? "").trim().slice(0, 2000);
          // List entries (fetchAgents/listAgents) omit lastPromptAt/lastProgressAt: enrich from the single-agent read so a wedged lead is seen as wedged.
          let fresh = null;
          if (lead.lastPromptAt === undefined) {
            if (isRunnerId(lead.id)) fresh = readRunnerAgentSync(lead.id);
            if (!fresh && connected && client && typeof backend.fetchAgent === "function") fresh = (await backend.fetchAgent(lead.id).catch(() => null))?.agent ?? null;
          }
          const floorLead = fresh ? { ...lead, lastPromptAt: fresh.lastPromptAt, lastProgressAt: fresh.lastProgressAt, status: fresh.status ?? lead.status, pendingPermissions: fresh.pendingPermissions ?? lead.pendingPermissions, requiresAttention: fresh.requiresAttention ?? lead.requiresAttention } : lead;
          const floor = overlordFloorVerdict(floorLead, { force: body.force === true, steer: steerNote });
          if (floor.refuse) throw Object.assign(new Error(`lead-handoff: ${floor.message}`), { status: 409 });
          if (floor.forced) {
            forcedLog = {
              teamId: callerTeam.id,
              laneId: leadLane.id,
              agent: callerId,
              type: "decision",
              text: `Overlord ${callerId} forced a lead handoff below the ${LEAD_HANDOFF_MIN_TOKENS} floor: lane ${leadLane.id}, target ${lead.id}, ${floor.tokens} tokens. Steer: ${steerNote.slice(0, 160)}`,
              refs: [lead.id, callerId],
            };
          }
        } else if (!callerLane || !leadLane || callerLane.id !== leadLane.id || !callerTeam || !leadTeam || callerTeam.id !== leadTeam.id) {
          throw forbid("caller is not a Buddy of the lead's lane");
        }
      }
    }

    const handoffPromise =
      trigger === "self" || trigger === "buddy" || trigger === "overlord"
        ? coordinator.triggerSelfHandoff(lead, {
            trigger,
            steer: trigger === "overlord" ? body.steer : undefined,
            retireImmediately: Boolean(body.retireImmediately),
            forceSynthesize: Boolean(body.forceSynthesize),
            job: body.job,
          }).then((r) => {
            if (forcedLog && r && r.ok !== false && r.triggered !== false && !r.deduped) {
              try { appendVsLogEntry(forcedLog); } catch {}
            }
            return r;
          })
        : coordinator.evaluateLead(lead, {
            usedTokens: body.usedTokens,
            forceSynthesize: Boolean(body.forceSynthesize),
          });

    const waitMs = body.async === true ? 0 : typeof body.httpWaitMs === "number" ? body.httpWaitMs : null;
    if (waitMs !== null) {
      const TIMEOUT = Symbol("timeout");
      let timer;
      const raced = await Promise.race([
        handoffPromise,
        new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), Math.max(0, waitMs)); }),
      ]).finally(() => clearTimeout(timer));
      if (raced === TIMEOUT) {
        backgroundHandoff = handoffPromise.catch(() => {});
        const { teamId, laneId, laneName } = resolveTeamAndLane(lead, rootDir);
        const oldOrd = parseLeadOrd(lead);
        const nextOrd = oldOrd + 1;
        const { newTitle } = leadTitles({ laneId, laneName, nextOrd, oldOrd, oldLead: lead, job: body.job, rootDir });
        return {
          ok: true,
          accepted: true,
          status: 202,
          handoffId: `${teamId}:${laneId}:ord${oldOrd}->ord${nextOrd}`,
          trigger,
          oldLeadId: lead.id,
          ord: oldOrd,
          nextOrd,
          title: newTitle,
          teamId,
          laneId,
        };
      }
      return raced;
    }

    return await handoffPromise;
  } finally {
    if (!injectedClient && client && typeof backend.close === "function") {
      if (backgroundHandoff) backgroundHandoff.finally(() => backend.close().catch(() => {}));
      else await backend.close().catch(() => {});
    }
  }
}
