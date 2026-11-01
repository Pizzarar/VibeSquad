import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import os from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { effectiveAgentRole, findLaneInRegistry, isRetiredAgent, topicOf } from "./identity.mjs";
import { findProfile, loadProfiles, toPaseoSpawnConfig } from "./profiles.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MAX_SUMMARY_CHARS = 20_000;
const MAX_LOG_TEXT = 240;

function safeSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "") || "vibesquad";
}

export function readPaseoConfig(_rootDir = REPO_ROOT) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  let listen = "127.0.0.1:6767";
  let serverId = "";
  const cfg = readJsonFileWithBom(join(home, "config.json"), {
    label: "~/.paseo/config.json",
    fallback: null,
    recordWarning: true,
  });
  if (cfg.ok && cfg.data) {
    listen = cfg.data.daemon?.listen ?? listen;
  }
  try {
    serverId = readFileSync(join(home, "server-id"), "utf8").trim();
  } catch {}
  return { listen: process.env.PASEO_DAEMON ?? listen, serverId, home };
}

export function createDaemonClient(rootDir = REPO_ROOT) {
  const { listen } = readPaseoConfig(rootDir);
  const wsUrl = listen.startsWith("ws://") || listen.startsWith("wss://") ? `${listen.replace(/\/$/, "")}/ws` : `ws://${listen}/ws`;
  return new DaemonClient({
    url: wsUrl,
    clientId: `vibesquad-bf-${Date.now().toString(36)}`,
    clientType: "cli",
    appVersion: "0.0.1",
    connectTimeoutMs: 5000,
    reconnect: { enabled: false },
  });
}

function resolveTeamsFilePath(rootDir = REPO_ROOT) {
  if (process.env.VIBESQUAD_TEAMS_FILE) {
    const p = resolve(process.env.VIBESQUAD_TEAMS_FILE);
    if (existsSync(p)) return p;
  }
  if (!process.env.VIBESQUAD_IGNORE_HOME_TEAMS) {
    const homeTeams = join(
      process.env.VIBESQUAD_HOME || join(os.homedir(), ".vibesquad"),
      "teams.json",
    );
    if (existsSync(homeTeams)) return homeTeams;
  }
  const local = join(rootDir, "teams.json");
  if (existsSync(local)) return local;
  return join(rootDir, "teams.example.json");
}

function loadTeamsConfig(rootDir = REPO_ROOT) {
  const file = resolveTeamsFilePath(rootDir);
  const res = readJsonFileWithBom(file, { label: "teams.json", fallback: { teams: [] }, recordWarning: true });
  return res.data ?? { teams: [] };
}

function laneDisplayName(laneId, rootDir = REPO_ROOT) {
  const cfg = loadTeamsConfig(rootDir);
  const needle = String(laneId ?? "").toLowerCase();
  for (const t of cfg.teams ?? []) {
    for (const l of t.lanes ?? []) {
      if (String(l.id).toLowerCase() === needle || (l.aliases ?? []).some((a) => String(a).toLowerCase() === needle)) {
        return { teamId: t.id, laneId: l.id, laneName: l.name || l.id };
      }
    }
  }
  return { teamId: "", laneId: safeSegment(laneId), laneName: String(laneId || "vibesquad").replace(/-/g, " ") };
}

function readLocalAgentRecord(agentId, rootDir = REPO_ROOT) {
  if (!agentId) return null;
  const { home } = readPaseoConfig(rootDir);
  const agentsRoot = join(home, "agents");
  try {
    for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = join(agentsRoot, dir.name, `${agentId}.json`);
      if (existsSync(candidate)) {
        return readJsonFileWithBom(candidate, { recordWarning: false, rewriteBom: false }).data;
      }
    }
  } catch {}
  return null;
}

function defaultSummaryTemplate(laneId, laneName) {
  const upper = (laneName || laneId).toUpperCase();
  return [
    `# Brainstorm Summary · ${upper} (\`${laneId}\`)`,
    "",
    `> Rolling lane summary (\`< ~5k\` tokens). Updated on every plan handoff to \`★ ${upper}\`.`,
    "",
    "## Decided",
    "- (none recorded yet)",
    "",
    "## Open",
    "- (none recorded yet)",
    "",
    "## In Flight",
    "- (none recorded yet)",
    "",
  ].join("\n");
}

export function readBrainstormSummary(laneRaw, rootDir = REPO_ROOT) {
  const { laneId, laneName } = laneDisplayName(laneRaw, rootDir);
  const safeLane = safeSegment(laneId || laneRaw || "vibesquad");
  const relPath = `docs/brainstorm/${safeLane}.md`;
  const fullPath = join(rootDir, "docs", "brainstorm", `${safeLane}.md`);
  let content = "";
  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, "utf8");
  } else {
    content = defaultSummaryTemplate(safeLane, laneName);
  }
  return { laneId: safeLane, path: relPath, fullPath, content };
}

export function writeBrainstormSummary(laneRaw, content, rootDir = REPO_ROOT) {
  const text = String(content ?? "");
  if (text.length > MAX_SUMMARY_CHARS) {
    throw new Error(`Summary is ${text.length} chars; must be <= ${MAX_SUMMARY_CHARS} chars (~5k tokens)`);
  }
  const { laneId } = laneDisplayName(laneRaw, rootDir);
  const safeLane = safeSegment(laneId || laneRaw || "vibesquad");
  const relPath = `docs/brainstorm/${safeLane}.md`;
  const dir = join(rootDir, "docs", "brainstorm");
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, `${safeLane}.md`);
  writeFileSync(fullPath, text, "utf8");
  return { laneId: safeLane, path: relPath, fullPath, content: text };
}

export function findNewestPlanFile(cwd, rootDir = REPO_ROOT) {
  const dirs = [cwd ? join(cwd, "docs") : null, join(rootDir, "docs")].filter(Boolean);
  for (const d of dirs) {
    try {
      if (!existsSync(d)) continue;
      const plans = readdirSync(d)
        .filter((f) => /^PLAN_.*\.md$/i.test(f))
        .map((f) => {
          const full = join(d, f);
          return { name: f, rel: `docs/${f}`, mtime: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (plans.length > 0) return plans[0].rel;
    } catch {}
  }
  return "docs/PLAN_BRAINSTORM_FLOW.md";
}

export function appendVsLogEntry({ teamId, laneId, agent = "you", type = "metric", text, refs = [] }) {
  const baseHome = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  const safeTeam = safeSegment(teamId || "vibesquad");
  const safeLane = safeSegment(laneId || safeTeam || "vibesquad");
  const cleanText = String(text ?? "").trim().slice(0, MAX_LOG_TEXT);
  if (!cleanText) throw new Error("log text cannot be empty");

  const entry = {
    ts: new Date().toISOString(),
    agent: String(agent || "you"),
    lane: safeLane,
    type: String(type || "metric"),
    text: cleanText,
    refs: Array.isArray(refs) ? refs.map(String) : [],
  };
  const line = JSON.stringify(entry) + "\n";

  const logsDir = join(baseHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  const laneLogPath = join(logsDir, `${safeTeam}--${safeLane}.jsonl`);
  appendFileSync(laneLogPath, line, "utf8");

  const tDir = join(baseHome, "teams", safeTeam);
  mkdirSync(tDir, { recursive: true });
  const teamLogPath = join(tDir, "log.jsonl");
  appendFileSync(teamLogPath, line, "utf8");

  return { entry, path: laneLogPath, teamLogPath };
}

export function buildBrainstormInitialPrompt({ laneId, laneUpper, summaryContent, latestPlan, pendingPrompt }) {
  const tail =
    pendingPrompt && String(pendingPrompt).trim()
      ? `Pending message from the user to answer now:\n${String(pendingPrompt).trim()}`
      : `Summary loaded from docs/brainstorm/${laneId}.md. Reply in 1-2 short sentences confirming you are ready and listing the current Decided / In-Flight focus.`;

  return [
    `You are BRAINSTORM · ${laneUpper} (fresh context restart for lane \`${laneId}\`).`,
    "",
    "Rules (BF-P1):",
    `- Keep \`docs/brainstorm/${laneId}.md\` updated (< ~5k tokens, sections: Decided / Open / In flight) in the same step as every plan handoff to the lead.`,
    `- To find your current lead for handoff: run \`vs who lead\`.`,
    `- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (\`paseo --help\`, Paseo MCP tool list, \`vs --help\`, skills). Name what you checked in the plan's Decided section.`,
    `- At >=80k context tokens (or after handing off a plan), add one line: "getting heavy, restart from summary?"`,
    `- Latest plan file: \`${latestPlan}\``,
    "",
    `--- BEGIN docs/brainstorm/${laneId}.md ---`,
    summaryContent.trim(),
    `--- END docs/brainstorm/${laneId}.md ---`,
    "",
    tail,
  ].join("\n");
}

const restartedAgents = new Map();
const lastAutoRestartByLane = new Map();

export function resetBrainstormRestartState() {
  restartedAgents.clear();
  lastAutoRestartByLane.clear();
}

function parseBrainstormTopic(agent) {
  return topicOf(agent).toLowerCase();
}

export function findExistingLaneBrainstorm(agents, laneId, topic = "") {
  if (!agents || !laneId) return null;
  const list = Array.isArray(agents)
    ? agents
    : agents instanceof Map
      ? [...agents.values()]
      : typeof agents[Symbol.iterator] === "function"
        ? [...agents]
        : [];
  const wantLane = String(laneId).trim().toLowerCase();
  const wantTopic = String(topic ?? "").trim().toLowerCase();
  const matches = list
    .map((item) => item?.agent ?? item)
    .filter(Boolean)
    .filter((a) => {
      if (isRetiredAgent(a)) return false;
      if (effectiveAgentRole(a) !== "brainstorm") return false;
      const labels = a.labels ?? {};
      const aLane = String(labels.lane || labels.lead || "").trim().toLowerCase();
      if (aLane !== wantLane) return false;
      return parseBrainstormTopic(a) === wantTopic;
    });
  matches.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return matches[0] ?? null;
}

export async function performBrainstormRestart(body, rootDir = REPO_ROOT) {
  const reason = String(body.reason || "manual").trim();
  const agentId = String(body.agentId || (reason === "start-brainstorm" ? "start-brainstorm" : "")).trim();
  if (!agentId) throw new Error("agentId is required");

  const pendingPrompt = typeof body.pendingPrompt === "string" ? body.pendingPrompt : "";

  const injectedClient = body.daemonClient || null;
  const client = injectedClient || (body.skipDaemon ? null : createDaemonClient(rootDir));
  let oldAgent = body.oldAgent || null;
  let connected = Boolean(injectedClient);
  try {
    if (client) {
      try {
        if (!injectedClient && typeof client.connect === "function") {
          await client.connect();
          connected = true;
        }
        if (!oldAgent && agentId !== "start-brainstorm" && connected && typeof client.fetchAgent === "function") {
          const fetched = await client.fetchAgent(agentId).catch(() => null);
          oldAgent = fetched?.agent ?? null;
        }
      } catch {
        if (!oldAgent) oldAgent = null;
      }
    }

    if (!oldAgent && agentId !== "start-brainstorm") {
      oldAgent = readLocalAgentRecord(agentId, rootDir);
    }

    const oldLabels = { ...(oldAgent?.labels ?? {}) };
    const laneHint = body.laneId || body.lane || oldLabels.lane || oldLabels.lead || "vibesquad";
    const resolved = laneDisplayName(laneHint, rootDir);
    const laneId = safeSegment(body.laneId || body.lane || resolved.laneId || "vibesquad");
    const teamId = safeSegment(resolved.teamId || body.teamId || body.team || oldLabels.team || "vibesquad");
    const laneUpper = (resolved.laneName || laneId).toUpperCase();
    const topic = String(body.topic ?? oldLabels.topic ?? "").trim();

    if (agentId !== "start-brainstorm" && reason !== "start-brainstorm") {
      if (
        restartedAgents.has(agentId) ||
        oldLabels.role === "former-brainstorm" ||
        Boolean(oldLabels["vs.restarted-into"]) ||
        Boolean(oldAgent?.archivedAt)
      ) {
        return {
          ok: true,
          skipped: true,
          reason: "already-restarted",
          oldAgentId: agentId,
          newAgentId: oldLabels["vs.restarted-into"] || restartedAgents.get(agentId)?.newAgentId || null,
          laneId,
          teamId,
        };
      }
    }

    const laneCooldownKey = `${teamId}:${laneId}:${topic.toLowerCase()}`;
    if (reason.startsWith("auto")) {
      const cooldownMs = typeof body.cooldownMs === "number" ? body.cooldownMs : 60_000;
      const lastEntry = lastAutoRestartByLane.get(laneCooldownKey);
      if (lastEntry && Date.now() - lastEntry.ts < cooldownMs) {
        return {
          ok: true,
          skipped: true,
          reason: "cooldown-active",
          oldAgentId: agentId,
          newAgentId: lastEntry.newAgentId,
          laneId,
          teamId,
        };
      }
    }

    if ((reason === "start-brainstorm" || agentId === "start-brainstorm") && !body.forceNew) {
      let liveAgents = [];
      if (body.agents) {
        liveAgents = body.agents instanceof Map ? [...body.agents.values()] : Array.isArray(body.agents) ? body.agents : [];
      } else if (connected && client && typeof client.fetchAgents === "function") {
        const res = await client.fetchAgents().catch(() => null);
        liveAgents = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : [];
      } else if (connected && client && typeof client.listAgents === "function") {
        const res = await client.listAgents().catch(() => null);
        liveAgents = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : [];
      }
      const existing = findExistingLaneBrainstorm(liveAgents, laneId, topic);
      if (existing) {
        if (existing.labels && existing.labels.team !== teamId) {
          existing.labels = { ...existing.labels, team: teamId };
          await client?.updateAgent?.(existing.id, { labels: existing.labels })?.catch?.(() => {});
        }
        return {
          ok: true,
          reused: true,
          existingAgentId: existing.id,
          newAgentId: existing.id,
          title: existing.title,
          laneId,
          teamId,
          message: `Open existing brainstorm (${existing.title || existing.id})`,
          agent: existing,
        };
      }
    }

    const tokens =
      Number(body.usedTokens) ||
      Number(oldLabels["vs.mock-tokens"]) ||
      Number(oldAgent?.contextUsage?.usedTokens) ||
      Number(oldAgent?.lastUsage?.contextWindowUsedTokens) ||
      Number(oldAgent?.lastUsage?.inputTokens) ||
      0;

    if (typeof body.summaryUpdate === "string" && body.summaryUpdate.trim()) {
      writeBrainstormSummary(laneId, body.summaryUpdate, rootDir);
    }
    const summary = readBrainstormSummary(laneId, rootDir);
    const cwd = oldAgent?.cwd || rootDir;
    const latestPlan = findNewestPlanFile(cwd, rootDir);

    if (reason === "handoff") {
      appendVsLogEntry({
        teamId,
        laneId,
        agent: agentId,
        type: "metric",
        text: `tokens-per-plan-handoff: ${tokens} tok (${latestPlan})`,
        refs: [latestPlan, summary.path],
      });
    }

    appendVsLogEntry({
      teamId,
      laneId,
      agent: agentId,
      type: "metric",
      text: `brainstorm-restart (${reason}): ${tokens} tok -> spawning fresh BRAINSTORM · ${laneUpper}`,
      refs: [summary.path, latestPlan],
    });

    const newTitle = topic ? `BRAINSTORM · ${laneUpper} · ${topic}` : `BRAINSTORM · ${laneUpper}`;

    const rawOldProvider = String(body.provider || oldAgent?.provider || "claude");
    const fallbackProfileName = rawOldProvider.startsWith("antigravity") ? "Brainstorm - Gemini" : "Brainstorm - Claude";
    const desiredProfileKey = String(body.profile || oldLabels.profile || fallbackProfileName).trim();
    const { profiles } = loadProfiles(body.profilesPath, { autoSeed: false });
    const profile = findProfile(desiredProfileKey, profiles) || findProfile(fallbackProfileName, profiles);

    const spawnCfg = profile
      ? toPaseoSpawnConfig(profile)
      : {
          provider: rawOldProvider.includes("/") ? rawOldProvider.split("/")[0] : rawOldProvider,
          model:
            oldAgent?.model ||
            (rawOldProvider.includes("/")
              ? rawOldProvider.split("/").slice(1).join("/")
              : rawOldProvider.startsWith("antigravity")
                ? "gemini-4-argon"
                : "claude-opus-5-5"),
          modeId: oldAgent?.modeId || (rawOldProvider.startsWith("antigravity-cli") ? "accept-edits" : "auto"),
          thinkingOptionId: oldAgent?.thinkingOptionId || "medium",
          ...(oldAgent?.featureValues ? { featureValues: { ...oldAgent.featureValues } } : {}),
          notes: "",
          systemPrompt: "",
        };

    const provider = spawnCfg.provider;
    const model = spawnCfg.model;
    const modeId = spawnCfg.modeId;
    const thinkingOptionId = spawnCfg.thinkingOptionId;
    const featureValues = spawnCfg.featureValues ? { ...spawnCfg.featureValues } : undefined;

    const newLabels = {
      team: teamId,
      lane: laneId,
      lead: laneId,
      role: "brainstorm",
      ...(topic ? { topic } : {}),
      ...(oldLabels["vs.inbox-card-id"] ? { "vs.inbox-card-id": oldLabels["vs.inbox-card-id"] } : {}),
      profile: profile?.name || oldLabels.profile || fallbackProfileName,
      "vs.restarted-from": agentId,
      "vs.restart-tokens": String(tokens),
      "vs.restart-reason": reason,
    };
    const initialPrompt = buildBrainstormInitialPrompt({
      laneId,
      laneUpper,
      summaryContent: summary.content,
      latestPlan,
      pendingPrompt,
    });

    let created = null;
    if (connected && client && typeof client.createAgent === "function") {
      created = await client.createAgent({
        config: {
          provider,
          model,
          cwd,
          title: newTitle,
          modeId,
          thinkingOptionId,
          ...(featureValues && Object.keys(featureValues).length ? { featureValues } : {}),
          ...(spawnCfg.systemPrompt ? { systemPrompt: spawnCfg.systemPrompt } : {}),
        },
        ...(oldAgent?.workspaceId ? { workspaceId: oldAgent.workspaceId } : {}),
        initialPrompt,
        labels: newLabels,
      });
    }

    if (!created) {
      created = {
        id: `bs-${laneId}-${Date.now().toString(36)}`,
        title: newTitle,
        provider,
        model,
        modeId,
        thinkingOptionId,
        ...(featureValues ? { featureValues } : {}),
        cwd,
        status: "idle",
        labels: { ...newLabels },
        updatedAt: new Date().toISOString(),
        pendingPermissions: [],
        requiresAttention: false,
      };
    } else {
      const mergedLabels = { ...(created.labels ?? {}), ...newLabels };
      delete mergedLabels["vs.mock-tokens"];
      created = {
        ...created,
        title: created.title || newTitle,
        modeId: created.modeId ?? modeId,
        thinkingOptionId: created.thinkingOptionId ?? thinkingOptionId,
        ...(featureValues && !created.featureValues ? { featureValues } : {}),
        labels: mergedLabels,
      };
    }

    if (agentId !== "start-brainstorm") {
      const retiredLabels = {
        ...oldLabels,
        role: "former-brainstorm",
        "vs.restarted-into": created.id,
      };
      delete retiredLabels["vs.mock-tokens"];
      restartedAgents.set(agentId, { newAgentId: created.id, ts: Date.now(), tokens });
      if (oldAgent && typeof oldAgent === "object") {
        oldAgent.labels = retiredLabels;
        oldAgent.archivedAt = oldAgent.archivedAt || new Date().toISOString();
      }
      if (connected && client) {
        const rawOldTitle = String(oldAgent?.title || newTitle).trim();
        const retiredTitle = rawOldTitle.toLowerCase().startsWith("(old)") ? rawOldTitle : `(old) ${rawOldTitle}`;
        await client.cancelAgent?.(agentId)?.catch?.(() => {});
        await client
          .updateAgent?.(agentId, {
            name: retiredTitle,
            labels: retiredLabels,
          })
          ?.catch?.(() => {});
        await client.archiveAgent?.(agentId)?.catch?.(() => {});
      }
    }

    if (reason.startsWith("auto")) {
      lastAutoRestartByLane.set(laneCooldownKey, {
        newAgentId: created.id,
        ts: Date.now(),
        oldAgentId: agentId,
      });
    }

    return {
      ok: true,
      oldAgentId: agentId,
      newAgentId: created.id,
      title: created.title || newTitle,
      laneId,
      teamId,
      usedTokens: tokens,
      summaryPath: summary.path,
      latestPlan,
      spawnConfig: spawnCfg,
      agent: created,
    };
  } finally {
    if (!injectedClient && client && typeof client.close === "function") {
      await client.close().catch(() => {});
    }
  }
}
