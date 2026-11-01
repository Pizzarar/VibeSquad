import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appendVsLogEntry,
  createDaemonClient,
  findNewestPlanFile,
  readBrainstormSummary,
} from "./brainstorm.mjs";
import { effectiveAgentRole, isDigestAgent, isRetiredAgent, ordOf } from "./identity.mjs";
import { LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE, readJsonFileWithBom } from "./user-settings.mjs";
import { findProfile, loadProfiles, toPaseoSpawnConfig } from "./profiles.mjs";

// import.meta.dirname is undefined when bundled into the Paseo plugin; fall back like plugin/index.server.ts.
const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));

export const LEAD_FLAG_DEFAULT = 150_000;
export const LEAD_AUTO_HANDOFF_DEFAULT = 250_000;
export const LEAD_HARD_CAP_DEFAULT = 300_000;

export const SOFT_FLAG_REASON = "Lead at 150k+ tokens: wrap up and hand off at a good stopping point";
export const SOFT_FLAG_NUDGE =
  "Wrap up: stop dispatching new blocks, let in-flight workers finish, write your handoff doc.";
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
  if (process.env.VIBESQUAD_TEAMS_FILE) {
    const p = resolve(process.env.VIBESQUAD_TEAMS_FILE);
    if (existsSync(p)) return p;
  }
  if (!process.env.VIBESQUAD_IGNORE_HOME_TEAMS) {
    const homeTeams = join(getBaseHome(), "teams.json");
    if (existsSync(homeTeams)) return homeTeams;
  }
  const local = join(rootDir, "teams.json");
  if (existsSync(local)) return local;
  return join(rootDir, "teams.example.json");
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
  const laneId = safeSegment(
    matchedLane?.id || laneHint || matchedTeam?.lanes?.[0]?.id || teamId || "vibesquad",
  );
  const laneName =
    matchedLane?.name ||
    (laneHint ? laneHint.replace(/-/g, " ") : matchedTeam?.lanes?.[0]?.name || teamName);

  return { teamId, teamName, laneId, laneName, teamDef: matchedTeam };
}

export function parseLeadOrd(lead) {
  return ordOf(lead);
}

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

    const parentId = l["paseo.parent-agent-id"] || a.parentAgentId || "";
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
    `# Handoff — ${teamName || teamId} / ${laneId} / ord${ord} (Synthesized by VibeSquad at 300k hard cap)`,
    "",
    "## Auto State",
    "",
    `- **Team / Lane / Ord:** ${teamName || teamId} / ${laneId} / ord${ord}`,
    `- **Predecessor Lead:** ${lead?.title || lead?.id} (${lead?.id || "unknown"})`,
    `- **Generated:** ${now} (forced handoff synthesis)`,
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
  oldLead,
  oldTitle,
  trigger,
  packetPath,
  packetContent,
  summaryPath,
  summaryContent,
  latestPlan,
  openWorkers = [],
}) {
  const laneUpper = (laneName || laneId).toUpperCase();
  const workerLines = openWorkers.length
    ? openWorkers.map(
        (w) => `- ${w.title || w.labels?.job || w.id} (${w.id}) [${w.status || "running"}]`,
      )
    : ["- none"];

  return [
    `You are ★ ${laneUpper} ord${nextOrd}, the successor lead for lane \`${laneId}\` (handoff trigger=${trigger} from ${oldLead?.id || oldTitle}).`,
    `The previous lead (${oldLead?.title || oldLead?.id}) will be retired to "${oldTitle}" once you confirm takeover.`,
    "",
    `- **Handoff packet:** \`${packetPath}\``,
    `- **Brainstorm summary:** \`${summaryPath}\``,
    `- **Latest plan:** \`${latestPlan}\``,
    "",
    "### Open Workers Re-pointed to You",
    ...workerLines,
    "",
    `--- BEGIN HANDOFF PACKET (${packetPath}) ---`,
    String(packetContent ?? "").trim(),
    `--- END HANDOFF PACKET ---`,
    "",
    `--- BEGIN BRAINSTORM SUMMARY (${summaryPath}) ---`,
    String(summaryContent ?? "").trim(),
    `--- END BRAINSTORM SUMMARY ---`,
    "",
    TAKEOVER_CONFIRM_INSTRUCTION,
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

  async function spawnSuccessor({
    oldLead,
    trigger,
    retireImmediately = false,
    forceSynthesize = false,
  }) {
    const { teamId, teamName, laneId, laneName } = resolveTeamAndLane(oldLead, rootDir);
    const oldOrd = parseLeadOrd(oldLead);
    const nextOrd = oldOrd + 1;
    const laneUpper = (laneName || laneId).toUpperCase();
    const newTitle = `★ ${laneUpper} ord${nextOrd}`;
    const oldTitle = `(old) ${laneUpper} ord${oldOrd}`;

    const allAgents = await listAgents();
    const openWorkers = findOpenWorkersForLead(allAgents, oldLead, teamId, laneId);

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

    if (!packetExists || packetStale || forceSynthesize) {
      const syn = synthesizeHandoffPacket({
        lead: oldLead,
        teamId,
        teamName,
        laneId,
        laneName,
        openWorkers,
        rootDir,
        baseHome: getBase(),
      });
      packetContent = syn.content;
      synthesized = true;
    } else {
      packetContent = readFileSync(packetPath, "utf8");
    }

    const summary = readBrainstormSummary(laneId, rootDir);
    const cwd = oldLead?.cwd || rootDir;
    const latestPlan = findNewestPlanFile(cwd, rootDir);
    const { profileName, spawnCfg } = resolveLeadProfile(oldLead, deps.profilesPath);

    const prompt = buildSuccessorPrompt({
      laneId,
      laneName,
      nextOrd,
      oldLead,
      oldTitle,
      trigger,
      packetPath,
      packetContent,
      summaryPath: summary.path,
      summaryContent: summary.content,
      latestPlan,
      openWorkers,
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

    let created = null;
    if (typeof deps.createAgent === "function") {
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
      });
    }

    const successorId = created?.id || `lead-${laneId}-ord${nextOrd}-${Date.now().toString(36)}`;
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
        "paseo.parent-agent-id": successor.id,
      };
      await setLabels(w.id, updatedWorkerLabels);
      await sendMessage(w.id, `Report to ${successor.title} (${successor.id}).`);
      repointedWorkers.push(w.id);
    }

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

    if (retireImmediately) {
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
      confirmedTakeovers.add(successor.id);
    } else {
      pendingTakeover.set(successor.id, takeoverRecord);
    }

    return {
      ok: true,
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
      retiredImmediately: retireImmediately,
      pendingConfirmation: !retireImmediately,
    };
  }

  async function confirmTakeover(successorId) {
    const id = String(successorId ?? "").trim();
    if (!id) return { confirmed: false, error: "successorId is required" };
    if (confirmedTakeovers.has(id)) {
      return { confirmed: false, alreadyConfirmed: true, successorId: id };
    }

    let rec = pendingTakeover.get(id) || null;
    if (!rec) {
      const succ = await getAgent(id);
      const fromId = succ?.labels?.["vs.handoff-from"];
      if (fromId) {
        const old = await getAgent(fromId);
        if (old) {
          const { teamId, laneId, laneName } = resolveTeamAndLane(old, rootDir);
          const oldOrd = parseLeadOrd(old);
          rec = {
            oldLeadId: old.id,
            successorId: id,
            oldTitle: `(old) ${(laneName || laneId).toUpperCase()} ord${oldOrd}`,
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

    pendingTakeover.delete(id);
    confirmedTakeovers.add(id);

    const currentOld = await getAgent(rec.oldLeadId);
    const mergedOldLabels = {
      ...rec.oldLabels,
      ...(currentOld?.labels ?? {}),
      role: "former-lead",
      ord: rec.ord,
      "handoff-successor": id,
    };

    await setLabels(rec.oldLeadId, mergedOldLabels, rec.oldTitle);

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
    if (selfHandedOff.has(lead.id)) {
      return { stage: "self", triggered: false, reason: "already-handed-off" };
    }
    selfHandedOff.add(lead.id);
    const res = await spawnSuccessor({
      oldLead: lead,
      trigger: "self",
      retireImmediately: Boolean(options.retireImmediately),
      forceSynthesize: Boolean(options.forceSynthesize),
    });
    return { stage: "self", triggered: true, ...res };
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
      await setLabels(lead.id, {
        ...labels,
        "handoff-flagged": "1",
        "handoff-hard-300": "1",
      });
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
      const isRunning = lead.status === "running";
      const packetPath = getHandoffPacketPath(teamId, laneId, getBase());
      const hasPacket = existsSync(packetPath);

      if (isRunning || !hasPacket) {
        if (writePrompted250.has(lead.id) || labels["handoff-write-prompted"] === "1") {
          return {
            stage: "prompt-250",
            triggered: false,
            waitingForIdleOrPacket: true,
            usedTokens: used,
          };
        }
        writePrompted250.add(lead.id);
        await setLabels(lead.id, {
          ...labels,
          "handoff-flagged": "1",
          "handoff-write-prompted": "1",
        });
        await sendMessage(lead.id, WRITE_HANDOFF_PROMPT);
        return {
          stage: "prompt-250",
          triggered: true,
          waitingForIdleOrPacket: true,
          usedTokens: used,
        };
      }

      autoHandedOff250.add(lead.id);
      await setLabels(lead.id, {
        ...labels,
        "handoff-flagged": "1",
        "handoff-auto-250": "1",
      });
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
      if (flagged150.has(lead.id) || labels["handoff-flagged"] === "1") {
        return { stage: "flag-150", triggered: false, usedTokens: used };
      }
      flagged150.add(lead.id);
      const nextLabels = {
        ...labels,
        "needs-you": SOFT_FLAG_REASON,
        "needs-you-reason": SOFT_FLAG_REASON,
        "handoff-flagged": "1",
      };
      await setLabels(lead.id, nextLabels);
      await sendMessage(lead.id, SOFT_FLAG_NUDGE);
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

export async function performLeadHandoffHttp(body = {}, rootDir = REPO_ROOT) {
  const trigger = String(body.trigger || "self").trim();
  const injectedClient = body.daemonClient || null;
  const client = injectedClient || (body.skipDaemon ? null : createDaemonClient(rootDir));
  let connected = Boolean(injectedClient);

  try {
    if (client && !injectedClient && typeof client.connect === "function") {
      await client.connect().catch(() => {});
      connected = true;
    }

    const coordinator = createLeadHandoffCoordinator({
      rootDir,
      baseHome: body.baseHome,
      profilesPath: body.profilesPath,
      async listAgents() {
        if (Array.isArray(body.agents)) return body.agents;
        if (connected && client && typeof client.listAgents === "function") {
          const res = await client.listAgents().catch(() => null);
          if (Array.isArray(res?.entries)) return res.entries.map((e) => e.agent ?? e);
          if (Array.isArray(res)) return res;
        }
        return [];
      },
      async getAgent(id) {
        if (body.oldLead && body.oldLead.id === id) return body.oldLead;
        if (Array.isArray(body.agents)) {
          const found = body.agents.find((a) => a.id === id);
          if (found) return found;
        }
        if (connected && client && typeof client.fetchAgent === "function") {
          const r = await client.fetchAgent(id).catch(() => null);
          return r?.agent ?? null;
        }
        return null;
      },
      async setLabels(agentId, labels, name) {
        if (connected && client && typeof client.updateAgent === "function") {
          await client.updateAgent(agentId, { ...(name ? { name } : {}), labels }).catch(() => {});
        }
      },
      async sendMessage(agentId, text) {
        if (connected && client && typeof client.sendAgentPrompt === "function") {
          await client.sendAgentPrompt(agentId, text).catch(() => {});
        }
      },
      async createAgent(payload) {
        if (connected && client && typeof client.createAgent === "function") {
          return await client.createAgent({
            config: payload.config,
            initialPrompt: payload.initialPrompt || payload.prompt,
            labels: payload.labels,
          });
        }
        return null;
      },
      async deleteHeartbeat(agentId) {
        if (connected && client && typeof client.deleteHeartbeat === "function") {
          await client.deleteHeartbeat(agentId).catch(() => {});
        }
      },
    });

    if (body.action === "confirm" || body.confirmSuccessorId) {
      return await coordinator.confirmTakeover(body.confirmSuccessorId || body.successorId || body.agentId);
    }

    const lead = body.oldLead || (body.agentId ? await coordinator.getPendingTakeover(body.agentId) : null) || {
      id: body.agentId || "lead-1",
      title: body.title || "★ VIBESQUAD ord1",
      provider: body.provider || "claude",
      model: body.model || "claude-opus-5-5",
      cwd: body.cwd || rootDir,
      status: body.status || "idle",
      labels: body.labels || { team: body.team || "vibesquad", lane: body.lane || "vibesquad", role: "lead", ord: String(body.ord || "1") },
    };

    if (trigger === "self") {
      return await coordinator.triggerSelfHandoff(lead, {
        retireImmediately: Boolean(body.retireImmediately),
        forceSynthesize: Boolean(body.forceSynthesize),
      });
    }

    return await coordinator.evaluateLead(lead, {
      usedTokens: body.usedTokens,
      forceSynthesize: Boolean(body.forceSynthesize),
    });
  } finally {
    if (!injectedClient && client && typeof client.close === "function") {
      await client.close().catch(() => {});
    }
  }
}
