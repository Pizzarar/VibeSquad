#!/usr/bin/env node
// vs — VibeSquad team log and handoff packet CLI.
//
// Writes tiny typed state once (~/.vibesquad/teams/<team>/log.jsonl) and reads
// only the slice a caller needs. Node built-ins only; no install step.
//
//   vs log <type> "<text>" [--ref <ref>...] [--digest]
//   vs log --since-me [--limit <N>] [--peek]
//   vs handoff [--out <path>]
//
// Caller identity comes from PASEO_AGENT_ID (or --agent). Labels are read from
// the local Paseo agent store, which is what the daemon persists live agent
// state to, so this works whether the daemon is up, down, or absent. If the
// agent is not in the store, a bounded `paseo inspect` probe (1500ms) supplies
// the cwd, and teams.json path rules decide the team/lane. Every lookup falls
// back cleanly so the CLI also runs in offline unit tests.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}
import {
  addInboxCards,
  handoffTopicBrainstorm,
  listInboxCards,
  openTopicBrainstorm,
  parkTopicBrainstorm,
  triageInboxCards,
} from "../server/inbox.mjs";
import { createDaemonClient, readBrainstormSummary, writeBrainstormSummary } from "../server/brainstorm.mjs";
import { getBackend, getCliBackend, hasCustomMockCli, hasCustomOfflineStore as hasCustomOfflineStoreAt, isRunnerId, listRunnerAgentsSync, readRunnerAgentSync, run, sharedRunnerBackend } from "../server/backend/index.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { bestOverlap, newPinBrief, slugLaneId, takenLaneIds, uniqueLaneId } from "../server/pin-ideas.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "../server/teams-file.mjs";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole as resolveEffectiveAgentRole,
  findLaneInRegistry,
  findTeamInRegistry,
  isDigestAgent,
  freezeLaneCodes,
  isRetiredRole,
  normalizeRoleLabel,
  ordStringOf,
  resolveAgentIdentity,
} from "../server/identity.mjs";
import { loadProfiles } from "../server/profiles.mjs";
import { staleWarning } from "../server/stale-runtime.mjs";
import { localTokenPath, requestLocalLoginUrl } from "../server/local-token.mjs";
import {
  readLaneSpec,
  writeLaneSpec,
  readLaneTasks,
  upsertLaneTask,
  renderLaneArtifactBlock,
} from "../server/lane-spec.mjs";
import {
  createManagedWorktree,
  sweepMergedWorktrees,
  cleanupProjectsFolder,
  resolveManagedWorktreeRoot,
} from "../server/team-worktrees.mjs";
import { appendLesson, readLessons } from "../server/lessons.mjs";
import {
  LEGACY_NEEDS_LABEL,
  LEGACY_NEEDS_REASON,
  LEGACY_NEEDS_UNTIL,
  LEGACY_USER_TYPE,
  loadUserSettings,
  parseJsonWithBom,
  readJsonFileWithBom,
  stripBom,
} from "../server/user-settings.mjs";

const LOG_TYPES = [
  "done",
  "decision",
  "blocker",
  "needs-you",
  "handoff",
  "you",
  LEGACY_NEEDS_LABEL,
  LEGACY_USER_TYPE,
  "metric",
  "tokens-per-plan",
  "restart-feedback",
  "audit-delta",
];
const LOG_TYPE_SET = new Set(LOG_TYPES);
const HIGH_PRIORITY = new Set(["decision", "you", "needs-you", LEGACY_USER_TYPE, LEGACY_NEEDS_LABEL]);
const MAX_TEXT = 240;
const MAX_READ_LINES = 40;
const MAX_HANDOFF_LOG_LINES = 20;
const DAEMON_TIMEOUT_MS = 1500;
const GH_TIMEOUT_MS = 2000;

const BASE_DIR = path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
const PASEO_HOME = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
// Root dir the lane-spec artifacts resolve against. VIBESQUAD_ROOT lets tests (and the installed
// runtime) point the durable docs/lanes/<lane>/ tree at a specific checkout.
const LANE_SPEC_ROOT = path.resolve(process.env.VIBESQUAD_ROOT || path.resolve(import.meta.dirname, ".."));

// ---------------------------------------------------------------------------
// teams.json
// ---------------------------------------------------------------------------

function resolveTeamsFilePath() {
  return resolveSharedTeamsFilePath(path.resolve(import.meta.dirname, ".."));
}

function loadTeamsFile() {
  const candidates = [resolveTeamsFilePath()];
  for (const file of candidates) {
    const { value: parsed } = readJsonFileWithBom(file, { fallback: null, label: "teams.json" });
    if (Array.isArray(parsed?.teams)) return parsed;
  }
  return { teams: [] };
}

const TEAMS_FILE = loadTeamsFile();
const TEAM_DEFS = TEAMS_FILE.teams;

function safeSegment(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]+/g, "_");
}

function findTeamDef(value) {
  if (!value) return null;
  const needle = String(value).toLowerCase();
  return TEAM_DEFS.find((t) => String(t.id).toLowerCase() === needle || String(t.name).toLowerCase() === needle) ?? null;
}

function resolveTeam(value) {
  const raw = String(value ?? "").trim() || "VibeSquad";
  const def = findTeamDef(raw);
  if (def) return { id: safeSegment(def.id), name: def.name ?? def.id, lanes: def.lanes ?? [], paths: def.paths ?? [], known: true };
  return { id: safeSegment(raw.toLowerCase()), name: raw, lanes: [], paths: [], known: false };
}

function findLane(value) {
  if (!value) return null;
  const stripped = String(value).trim().replace(/^@+/, "");
  const needle = stripped.toLowerCase();
  for (const team of TEAM_DEFS) {
    for (const lane of team.lanes ?? []) {
      if (String(lane.id).toLowerCase() === needle || (lane.aliases ?? []).some((a) => String(a).toLowerCase() === needle)) {
        return { team, lane };
      }
    }
  }
  // `@<code>` / `<code>` handles (e.g. @bug -> bug-chaser) and name matches.
  return findLaneInRegistry(value, TEAM_DEFS);
}

function matchTeamBySegments(targetPath) {
  if (!targetPath) return null;
  const segs = String(targetPath).toLowerCase().split(/[\\/]+/);
  for (const team of TEAM_DEFS) {
    for (const entry of team.paths ?? []) {
      const needle = String(entry).toLowerCase();
      if (segs.some((s) => (needle.endsWith("-") ? s.startsWith(needle) : s === needle))) return team;
    }
  }
  return null;
}

function normalizePathKey(p) {
  if (!p) return "";
  const resolved = path.resolve(String(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function teamByPath(cwd) {
  if (!cwd) return null;
  const direct = matchTeamBySegments(cwd);
  if (direct) return direct;

  try {
    let dir = path.resolve(String(cwd));
    for (let i = 0; i < 16; i++) {
      const dotGit = path.join(dir, ".git");
      try {
        const st = fs.statSync(dotGit);
        if (st.isFile()) {
          const raw = fs.readFileSync(dotGit, "utf8");
          const m = /^\s*gitdir:\s*(.+?)\s*$/im.exec(raw);
          if (m && m[1]) {
            const gitdirRaw = m[1].trim();
            const gitdirResolved = path.resolve(dir, gitdirRaw);
            const byGitdir = matchTeamBySegments(gitdirResolved) || matchTeamBySegments(gitdirRaw);
            if (byGitdir) return byGitdir;
          }
        }
        break;
      } catch {
        // continue walking up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore filesystem errors
  }

  const targetKey = normalizePathKey(cwd);
  if (targetKey) {
    for (const [, file] of buildAgentIndex()) {
      try {
        const record = parseJsonWithBom(fs.readFileSync(file, "utf8"));
        if (record?.cwd && record?.labels?.team && normalizePathKey(record.cwd) === targetKey) {
          const found = findTeamDef(record.labels.team) || findLane(record.labels.team)?.team;
          if (found) return found;
        }
      } catch {
        // skip unreadable record
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paseo agent store (labels, status, cwd)
// ---------------------------------------------------------------------------

const AGENTS_ROOT = path.join(PASEO_HOME, "agents");
let agentIndex = null;

function buildAgentIndex() {
  if (agentIndex) return agentIndex;
  const index = new Map();
  try {
    const dirs = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const full = path.join(AGENTS_ROOT, dir.name);
      let files = [];
      try {
        files = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        index.set(file.name.slice(0, -5), path.join(full, file.name));
      }
    }
  } catch {
    // no Paseo store on this machine
  }
  agentIndex = index;
  return index;
}

function readAgentRecord(agentId) {
  if (!agentId) return null;
  const file = buildAgentIndex().get(String(agentId));
  if (!file) return null;
  try {
    return parseJsonWithBom(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const cliBackend = getCliBackend();
const hasCustomOfflineStore = () => hasCustomOfflineStoreAt(PASEO_HOME);

function runPaseo(args, timeoutMs = DAEMON_TIMEOUT_MS) {
  return cliBackend.runCli(PASEO_HOME, args, timeoutMs);
}

// Live daemon lookup by id. The local store already has labels, so the CLI
// probe is only needed for an agent Paseo has not persisted (or another host).
function inspectAgentViaDaemon(agentId) {
  const out = runPaseo(["inspect", agentId, "--json"]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    return {
      id: parsed.Id ?? parsed.id ?? agentId,
      title: parsed.Name ?? parsed.Title ?? parsed.title ?? parsed.name ?? "",
      cwd: parsed.Cwd ?? parsed.cwd ?? "",
      labels: parsed.Labels ?? parsed.labels ?? {},
      status: parsed.Status ?? parsed.status,
      usage: parsed.LastUsage ?? parsed.lastUsage ?? parsed.usage ?? null,
      contextWindowUsedTokens:
        parsed.ContextWindowUsedTokens ??
        parsed.contextWindowUsedTokens ??
        parsed.LastUsage?.ContextWindowUsedTokens ??
        parsed.lastUsage?.contextWindowUsedTokens,
      inputTokens:
        parsed.InputTokens ??
        parsed.inputTokens ??
        parsed.LastUsage?.InputTokens ??
        parsed.lastUsage?.inputTokens,
    };
  } catch {
    return null;
  }
}

function listAgentsViaDaemon() {
  const out = runPaseo(["ls", "-g", "--json", "-a"]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((a) => {
      const record = readAgentRecord(a.id);
      const title = a.title ?? a.name ?? record?.title ?? record?.name ?? "";
      return {
        id: a.id,
        name: title,
        title,
        status: a.status ?? record?.lastStatus ?? record?.status ?? "unknown",
        cwd: a.cwd ?? record?.cwd ?? "",
        archivedAt: a.archivedAt ?? record?.archivedAt ?? null,
        archived: Boolean(a.archived || record?.archived || a.archivedAt || record?.archivedAt),
        internal: Boolean(a.internal || record?.internal),
        labels: { ...(record?.labels ?? {}), ...(a.labels ?? {}) },
        requiresAttention: Boolean(a.requiresAttention ?? record?.requiresAttention),
        attentionReason: a.attentionReason ?? record?.attentionReason ?? null,
        pendingPermissions: a.pendingPermissions ?? record?.pendingPermissions ?? [],
        usage: a.usage ?? a.lastUsage ?? record?.lastUsage ?? record?.usage ?? null,
        contextWindowUsedTokens: a.contextWindowUsedTokens ?? record?.contextWindowUsedTokens,
        inputTokens: a.inputTokens ?? record?.inputTokens,
      };
    });
  } catch {
    return null;
  }
}

function listAgentsOffline() {
  const agents = [];
  for (const [id, file] of buildAgentIndex()) {
    try {
      const record = parseJsonWithBom(fs.readFileSync(file, "utf8"));
      if (record.internal) continue;
      const title = record.title ?? record.name ?? "";
      agents.push({
        id: record.id ?? id,
        name: title,
        title,
        status: record.lastStatus ?? record.status ?? "unknown",
        cwd: record.cwd ?? "",
        archivedAt: record.archivedAt ?? null,
        archived: Boolean(record.archived || record.archivedAt),
        internal: Boolean(record.internal),
        labels: record.labels ?? {},
        requiresAttention: Boolean(record.requiresAttention),
        attentionReason: record.attentionReason ?? null,
        pendingPermissions: record.pendingPermissions ?? [],
        usage: record.lastUsage ?? record.usage ?? null,
        contextWindowUsedTokens: record.contextWindowUsedTokens,
        inputTokens: record.inputTokens,
      });
    } catch {
      // skip corrupt store entries
    }
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = { _: [], ref: [] };
  const valued = new Set([
    "agent",
    "team",
    "lane",
    "role",
    "name",
    "ord",
    "limit",
    "out",
    "ref",
    "merge",
    "bounce",
    "status",
    "scope",
    "delete",
    "archive",
    "card",
    "note",
    "binDir",
    "brief",
    "timeout",
    "file",
    "goal",
    "files",
    "doneCheck",
    "branch",
    "commit",
    "projectsDir",
    "category",
    "cause",
    "rule",
    "query",
    "profile",
    "cwd",
    "prompt",
    "title",
    "note",
  ]);
  const booleans = new Set([
    "sinceMe",
    "peek",
    "digest",
    "digestHook",
    "help",
    "fromBrainstorm",
    "splitDump",
    "json",
    "notes",
    "dryRun",
    "force",
    "print",
    "stdin",
    "apply",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawKey = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!valued.has(key)) throw new Error(`unknown option "--${rawKey}"`);
    let value = inline;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`--${rawKey} needs a value`);
    }
    if (key === "ref") flags.ref.push(value);
    else flags[key] = value;
  }
  return flags;
}

const UNASSIGNED_LANE = "unassigned";

function resolveIdentity(flags) {
  const agentId = String(flags.agent ?? process.env.PASEO_AGENT_ID ?? process.env.VS_AGENT_ID ?? "").trim();

  // rn- ids belong to the runner: read its log (labels/role/lane) instead of asking Paseo.
  let record = isRunnerId(agentId) ? readRunnerAgentSync(agentId) : agentId ? readAgentRecord(agentId) : null;
  if (!record && agentId && !isRunnerId(agentId)) record = inspectAgentViaDaemon(agentId);

  const labels = record?.labels ?? {};
  const title = record?.title ?? "";
  const cwd = record?.cwd || process.cwd();

  const pick = (flagName, envName) => {
    const value = flags[flagName] ?? process.env[envName];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };

  const laneFromFlag = pick("lane", "VS_LANE");
  const laneFromLabels = labels.lane || labels.lead || "";
  const teamFromFlag = pick("team", "VS_TEAM");
  const laneRaw = laneFromFlag || (!teamFromFlag ? laneFromLabels : "");
  const laneHit = findLane(laneRaw);

  // Team: explicit flag/env wins, then the lane's owning team, then the label,
  // then the folder. A --lane alone is enough to land in the right team.
  let teamRaw = teamFromFlag;
  if (!teamRaw && laneHit && laneRaw) teamRaw = laneHit.team.id;
  if (!teamRaw) teamRaw = labels.team || "";

  let team = resolveTeam(teamRaw);
  if (!teamRaw) {
    const byPath = teamByPath(cwd);
    if (byPath) team = resolveTeam(byPath.name);
  }

  let lane = laneHit ? laneHit.lane.id : laneRaw;
  if (!lane && teamFromFlag && laneFromLabels) {
    const labelLaneHit = findLane(laneFromLabels);
    if (labelLaneHit && labelLaneHit.team.id === team.id) lane = labelLaneHit.lane.id;
  }
  // No lane label: a one-lane squad is unambiguous; otherwise don't guess lanes[0].
  if (!lane && team.lanes.length === 1) lane = team.lanes[0].id;
  if (!lane && team.lanes.length > 1) lane = UNASSIGNED_LANE;
  if (!lane) lane = team.id || "vibesquad";

  const role = normalizeRoleLabel(
    {
      ...labels,
      ...(pick("role", "VS_ROLE") ? { role: pick("role", "VS_ROLE") } : {}),
    },
    "worker",
  );

  const ord = pick("ord", "VS_ORD") || ordStringOf(labels);

  const profile = labels.profile || "";
  const digest =
    Boolean(flags.digest || flags.digestHook) ||
    process.env.VS_DIGEST === "1" ||
    isDigestAgent(labels);

  return {
    agentId,
    agent: agentId || loadUserSettings(BASE_DIR).userName,
    title,
    cwd,
    labels,
    profile,
    digest,
    role,
    ord,
    team,
    lane,
    teamDir: path.join(BASE_DIR, "teams", team.id),
  };
}

// ---------------------------------------------------------------------------
// Log storage
// ---------------------------------------------------------------------------

function logFile(identity) {
  return path.join(identity.teamDir, "log.jsonl");
}

function laneLogFile(identity) {
  return path.join(BASE_DIR, "logs", `${safeSegment(identity.team.id)}--${safeSegment(identity.lane)}.jsonl`);
}

function cursorFile(identity) {
  return path.join(identity.teamDir, "cursors.json");
}

function readLog(identity) {
  const file = logFile(identity);
  let raw = "";
  try {
    raw = stripBom(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = stripBom(line).trim();
    if (!clean) continue;
    try {
      entries.push(JSON.parse(clean));
    } catch {
      // leave malformed lines out of the view; don't rewrite them
    }
  }
  return entries;
}

function appendLog(identity, entry) {
  fs.mkdirSync(identity.teamDir, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(logFile(identity), line, "utf8");
  try {
    const laneFile = laneLogFile(identity);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.appendFileSync(laneFile, line, "utf8");
  } catch {
    // non-fatal
  }
  return line;
}

function readCursors(identity) {
  const { value: parsed } = readJsonFileWithBom(cursorFile(identity), { fallback: {} });
  return parsed && typeof parsed === "object" ? parsed : {};
}

function writeCursors(identity, cursors) {
  fs.mkdirSync(identity.teamDir, { recursive: true });
  fs.writeFileSync(cursorFile(identity), JSON.stringify(cursors, null, 2) + "\n", "utf8");
}

// Re-read just before writing so two agents reading at once don't clobber each
// other's cursor.
function setCursor(identity, key, cursor) {
  const cursors = readCursors(identity);
  cursors[key] = cursor;
  writeCursors(identity, cursors);
}

function cursorKey(identity) {
  return identity.agentId || `${identity.lane}:${identity.role}`;
}

function formatEntry(entry) {
  const refs = Array.isArray(entry.refs) && entry.refs.length ? `  [refs: ${entry.refs.join(", ")}]` : "";
  const type = String(entry.type ?? "?").padEnd(9);
  const lane = String(entry.lane ?? "?").padEnd(10);
  return `${entry.ts ?? "?"}  ${type} ${lane} ${entry.agent ?? "?"}: ${entry.text ?? ""}${refs}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const USAGE = `vs — VibeSquad team log, live roster, profiles, handoff packet, and idea inbox

Usage:
  vs whoami [--agent <id>] [--lane <lane>] [--json]
  vs who [lead|brainstorm|buddy|workers|all] [--team <team>] [--lane <lane>] [--json]
  vs migrate identity [--dry-run] [--json]
  vs profiles [--role <role>] [--name <name>] [--notes] [--json]
  vs log <type> "<text>" [--ref <ref>...] [--digest]
  vs log --since-me [--limit <N>] [--peek]
  vs handoff [--out <path>]
  vs inbox add "<idea 1>" ["<idea 2>" ...] [--lane <lane>] [--from-brainstorm]
  vs inbox list [--lane <lane>]
  vs inbox triage --merge <targetId> <sourceId...> | --bounce <cardId> --lane <newLane>
  vs pin new "<name>" --brief "<idea>" [--team <squad>] [--force]
  vs pin merge <from-lane> <into-lane> [--note "<shared contract>"] [--team <squad>]
  vs spec [show] [--lane <lane>] [--team <team>]
  vs spec write "<markdown>" | --stdin | --file <path> [--lane <lane>] [--team <team>]
  vs task list [--lane <lane>] [--json]
  vs task set <unit-id> [--goal <g>] [--files <f1,f2>] [--done-check <cmd>] [--status <todo|running|done|blocked>] [--branch <b>] [--commit <sha>]
  vs cap [list | add <provider> | clear <provider>]
  vs spawn --title "<t>" --profile "<profile>" --prompt "<text>" [--cwd <dir>]   start a worker in your lane (runner or Paseo)
  vs send <agent> "<text>"   message an agent
  vs status <agent>   status + last assistant message
  vs wait <agent> [--timeout <seconds>]   block until idle (exit 0), error or blocked (1), timeout (2); no limit by default
  vs install-shim [--bin-dir <dir>]
  vs open [--print]   open the local web UI with owner access (sets the vs_local cookie); --print shows a one-time URL (60 s)

Types: ${LOG_TYPES.join(", ")} (text 1..${MAX_TEXT} chars)

Identity: PASEO_AGENT_ID + --team/--lane/--role/--ord (or VS_TEAM/VS_LANE/VS_ROLE/VS_ORD).
Storage:  VIBESQUAD_HOME (default ~/.vibesquad)

Only role=lead, role=brainstorm, Owner (type "you"), and the Pre-check - Flash
digest may write to the team log. Workers are logged by the digest.`;

function commandLog(flags) {
  const identity = resolveIdentity(flags);

  if (flags.sinceMe) return readSinceMe(flags, identity);

  if (!flags._.length) throw new Error(`log needs a type. Types: ${LOG_TYPES.join(", ")}`);
  const rawType = flags._[0];
  const textRaw = flags._.slice(1).join(" ");

  if (!LOG_TYPE_SET.has(rawType)) {
    throw new Error(`unknown log type "${rawType}". Allowed: ${LOG_TYPES.join(", ")}`);
  }
  const isMetricSubtype = rawType === "tokens-per-plan" || rawType === "restart-feedback" || rawType === "audit-delta";
  const type = isMetricSubtype ? "metric" : rawType;
  const text = isMetricSubtype && !textRaw.startsWith(`${rawType}:`) ? `${rawType}: ${textRaw}` : textRaw;

  const trimmed = textRaw.trim();
  if (trimmed.length === 0) {
    throw new Error(`log text must be 1..${MAX_TEXT} chars (got 0)`);
  }
  if (text.length > MAX_TEXT) {
    throw new Error(`log text must be 1..${MAX_TEXT} chars (got ${text.length})`);
  }

  const mayWrite =
    identity.role === "lead" ||
    identity.role === "brainstorm" ||
    type === "you" ||
    type === LEGACY_USER_TYPE ||
    identity.digest;
  if (!mayWrite) {
    throw new Error(
      "role=worker cannot write directly to the team log; worker results are logged by Pre-check - Flash digest.",
    );
  }

  const entry = {
    ts: new Date().toISOString(),
    agent: identity.agentId || loadUserSettings(BASE_DIR).userName,
    lane: identity.lane,
    type,
    text,
    refs: flags.ref,
  };
  const line = appendLog(identity, entry);
  process.stdout.write(line);
  return 0;
}

function readSinceMe(flags, identity) {
  let limit = MAX_READ_LINES;
  if (flags.limit !== undefined) {
    const parsed = Number(flags.limit);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--limit must be a positive integer (got "${flags.limit}")`);
    limit = Math.min(parsed, MAX_READ_LINES);
  }

  const entries = readLog(identity);
  const cursors = readCursors(identity);
  const key = cursorKey(identity);
  const rawStart = Number(cursors[key]?.line ?? 0);
  const start = Number.isInteger(rawStart) && rawStart >= 0 ? Math.min(rawStart, entries.length) : 0;

  const unread = entries.slice(start);
  const matching = unread
    .filter((e) => e?.lane === identity.lane || HIGH_PRIORITY.has(e?.type))
    .slice(-limit);

  // Owner's entries come first when they are unread, then the rest in order.
  const isOwner = (e) => e?.type === "you" || e?.type === LEGACY_USER_TYPE;
  const owner = matching.filter(isOwner);
  const rest = matching.filter((e) => !isOwner(e));
  const ordered = [...owner, ...rest];

  if (ordered.length) process.stdout.write(ordered.map(formatEntry).join("\n") + "\n");

  if (!flags.peek) {
    setCursor(identity, key, { line: entries.length, ts: new Date().toISOString() });
  }
  return 0;
}

function lastHandoffIndex(entries, lane) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "handoff" && entries[i]?.lane === lane) return i;
  }
  return -1;
}

function laneMembers(agents, team) {
  return agents.filter((a) => {
    const labels = a.labels ?? {};
    if (labels.team) return resolveTeam(labels.team).id === team.id;
    const byPath = teamByPath(a.cwd);
    return byPath ? resolveTeam(byPath.name).id === team.id : false;
  });
}

// Runner agents live in the runner's own logs, not in Paseo's store: shape them like the Paseo rows.
function listAgentsViaRunner() {
  return listRunnerAgentsSync().map((a) => ({
    id: a.id,
    name: a.title,
    title: a.title,
    status: a.status,
    cwd: a.cwd ?? "",
    archivedAt: a.archivedAt ?? null,
    archived: Boolean(a.archivedAt),
    internal: false,
    labels: a.labels ?? {},
    requiresAttention: false,
    attentionReason: null,
    pendingPermissions: [],
    usage: null,
  }));
}

function collectAgents() {
  const live = listAgentsViaDaemon();
  const runnerAgents = listAgentsViaRunner();
  if (live && live.length) return { agents: [...live, ...runnerAgents], source: "daemon" };
  return { agents: [...listAgentsOffline(), ...runnerAgents], source: "offline" };
}

function resolveCallerUsage(identity) {
  if (!identity.agentId || isRunnerId(identity.agentId)) return null;
  const out = runPaseo(["inspect", identity.agentId, "--json"]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    const usage = parsed.LastUsage;
    if (!usage) return null;
    return {
      input: Number(usage.InputTokens ?? 0),
      output: Number(usage.OutputTokens ?? 0),
      cached: Number(usage.CachedTokens ?? 0),
    };
  } catch {
    return null;
  }
}

function openPrs(cwd) {
  const remote = run("git", ["remote"], 1500);
  if (remote.error || remote.status !== 0 || !String(remote.stdout ?? "").trim()) return ["none (local repo)"];

  const gh = run("gh", ["pr", "list", "--limit", "5", "--json", "number,title,state,isDraft,headRefName"], GH_TIMEOUT_MS);
  if (gh.error || gh.status !== 0 || !String(gh.stdout ?? "").trim()) return ["none (local repo)"];

  try {
    const prs = JSON.parse(gh.stdout);
    if (!Array.isArray(prs) || prs.length === 0) return ["none (local repo)"];
    return prs.map((pr) => {
      const draft = pr.isDraft ? " (draft)" : "";
      return `#${pr.number} ${pr.title} — ${pr.state}${draft} — ${pr.headRefName}`;
    });
  } catch {
    return ["none (local repo)"];
  }
}

function buildHandoffPacket(identity, agents, source) {
  const entries = readLog(identity);
  const lines = [];
  const now = new Date().toISOString();

  lines.push(`# Handoff — ${identity.team.name} / ${identity.lane} / ord${identity.ord}`);
  lines.push("");
  lines.push("## Auto State");
  lines.push("");
  lines.push(`- **Team / Lane / Ord:** ${identity.team.name} / ${identity.lane} / ord${identity.ord}`);
  lines.push(`- **Generated:** ${now} (${source === "daemon" ? "daemon reachable" : "daemon offline — local agent store"})`);

  const usage = resolveCallerUsage(identity);
  if (usage) {
    lines.push(
      `- **Context Usage:** ~${Math.round(usage.input / 1000)}k tokens (last turn: ${usage.input} in / ${usage.output} out; ${usage.cached} cached read tokens this session)`,
    );
  } else {
    lines.push("- **Context Usage:** unknown (no usage recorded for this agent)");
  }

  const members = laneMembers(agents, identity.team);
  const inFlight = members.filter((a) => {
    const role = a.labels?.role ?? "";
    const status = String(a.status ?? "").toLowerCase();
    return role === "worker" && !["idle", "closed", "done"].includes(status);
  });

  lines.push("- **Workers in Flight:**");
  if (!inFlight.length) {
    lines.push("  - none");
  } else {
    for (const worker of inFlight) {
      const last = [...entries].reverse().find((e) => e?.agent === worker.id);
      const task = worker.labels?.task || worker.name || worker.id;
      const lastLine = last ? `last log: ${last.type} — ${last.text}` : "last log: none (workers report via digest)";
      lines.push(`  - ${task} (${worker.id.slice(0, 8)}) — ${worker.status || "unknown"} — ${lastLine}`);
    }
  }

  const needsYou = members.filter((a) => {
    const value = a.labels?.["needs-you"] || a.labels?.[LEGACY_NEEDS_LABEL];
    if (!value || value === "cleared") return false;
    const until = Date.parse(a.labels?.["needs-you-until"] || a.labels?.[LEGACY_NEEDS_UNTIL] || "");
    return Number.isNaN(until) || until <= Date.now();
  });
  const attention = members.filter((a) => a.requiresAttention);
  const perms = members.filter((a) => Array.isArray(a.pendingPermissions) && a.pendingPermissions.length > 0);

  lines.push("- **Pending Permissions & needs-you:**");
  if (!needsYou.length && !attention.length && !perms.length) {
    lines.push("  - none");
  } else {
    for (const a of perms) lines.push(`  - permission: ${a.name || a.id} (${a.pendingPermissions.length} pending)`);
    for (const a of needsYou) {
      lines.push(`  - needs-you: ${a.name || a.id} — ${a.labels?.["needs-you-reason"] || a.labels?.[LEGACY_NEEDS_REASON] || a.labels?.["needs-you"] || a.labels?.[LEGACY_NEEDS_LABEL]}`);
    }
    for (const a of attention) {
      const alreadyListed = needsYou.includes(a) || perms.includes(a);
      if (!alreadyListed) lines.push(`  - attention: ${a.name || a.id} — ${a.attentionReason || "needs attention"}`);
    }
  }

  lines.push("- **Recent Team Log (since last handoff):**");
  const start = lastHandoffIndex(entries, identity.lane) + 1;
  const recent = entries
    .slice(start)
    .filter((e) => e?.lane === identity.lane || HIGH_PRIORITY.has(e?.type))
    .slice(-MAX_HANDOFF_LOG_LINES);
  if (!recent.length) {
    lines.push("  - none");
  } else {
    for (const entry of recent) {
      const refs = Array.isArray(entry.refs) && entry.refs.length ? ` [refs: ${entry.refs.join(", ")}]` : "";
      lines.push(`  - [${entry.ts}] ${entry.type} ${entry.agent}: ${entry.text}${refs}`);
    }
  }

  lines.push("- **Open PRs:**");
  for (const pr of openPrs(identity.cwd)) lines.push(`  - ${pr}`);

  lines.push("");
  lines.push("## Judgment (Lead fills in — max 40 lines total)");
  lines.push("");
  lines.push("### Decisions");
  lines.push("");
  lines.push("### Gotchas");
  lines.push("");
  lines.push("### Next 3 Steps");
  lines.push("");
  lines.push("### Don't-Do");
  lines.push("");

  return lines.join("\n");
}

function commandHandoff(flags) {
  const identity = resolveIdentity(flags);
  const { agents, source } = collectAgents();
  const packet = buildHandoffPacket(identity, agents, source);

  fs.mkdirSync(identity.teamDir, { recursive: true });
  const out = flags.out
    ? path.resolve(String(flags.out))
    : path.join(identity.teamDir, `packet-${safeSegment(identity.lane)}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, packet, "utf8");

  // Keep an ord-stamped snapshot too, so old packets stay readable after handoff.
  const snapshot = path.join(identity.teamDir, `handoff-${safeSegment(identity.lane)}-ord${safeSegment(identity.ord)}.md`);
  if (path.resolve(snapshot) !== path.resolve(out)) fs.writeFileSync(snapshot, packet, "utf8");

  process.stdout.write(out + "\n");
  return 0;
}

function formatInboxCardLine(card) {
  const related = card.relatedCardId ? ` (goes with ${card.relatedCardId})` : "";
  return `[${card.id}] ${card.laneId} · ${card.scope} — ${card.title}${related}`;
}

function commandInbox(flags) {
  const sub = String(flags._.shift() ?? "list").toLowerCase();
  const baseHome = path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));

  if (sub === "add") {
    const ideas = flags._.map((s) => String(s).trim()).filter(Boolean);
    if (!ideas.length) {
      throw new Error('inbox add needs at least one idea: vs inbox add "<idea 1>" ["<idea 2>" ...]');
    }
    const res = addInboxCards({
      ideas,
      laneId: flags.lane ? String(flags.lane) : undefined,
      teamId: flags.team ? String(flags.team) : undefined,
      source: flags.fromBrainstorm ? "brainstorm-dump" : "cli",
      splitDump: Boolean(flags.splitDump),
      baseHome,
    });
    process.stdout.write(`${res.summary}\n`);
    for (const c of res.added) {
      process.stdout.write(`${formatInboxCardLine(c)}\n`);
    }
    return 0;
  }

  if (sub === "list" || sub === "ls") {
    const cards = listInboxCards({
      laneId: flags.lane ? String(flags.lane) : undefined,
      teamId: flags.team ? String(flags.team) : undefined,
      status: flags.status ? String(flags.status) : "parked",
      baseHome,
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(cards, null, 2) + "\n");
      return 0;
    }
    if (!cards.length) {
      process.stdout.write("(0 parked ideas in Inbox)\n");
      return 0;
    }
    for (const c of cards) {
      process.stdout.write(`${formatInboxCardLine(c)}\n`);
    }
    return 0;
  }

  if (sub === "triage") {
    if (flags.merge) {
      const mergeStr = String(flags.merge).trim();
      let targetId = mergeStr;
      let sourceIds = flags._.map((s) => String(s).trim()).filter(Boolean);
      if (mergeStr.includes(",")) {
        const parts = mergeStr.split(",").map((s) => s.trim()).filter(Boolean);
        targetId = parts[0];
        sourceIds = [...parts.slice(1), ...sourceIds];
      }
      const res = triageInboxCards({ action: "merge", targetId, sourceIds, baseHome });
      process.stdout.write(`merged [${res.mergedIds.join(", ")}] → ${res.card.id} (${res.card.title})\n`);
      return 0;
    }
    if (flags.bounce) {
      const cardId = String(flags.bounce).trim();
      const laneId = String(flags.lane || flags._[0] || "").trim();
      if (!laneId) throw new Error("inbox triage --bounce <cardId> requires --lane <newLane>");
      const res = triageInboxCards({
        action: "bounce",
        cardId,
        laneId,
        teamId: flags.team ? String(flags.team) : undefined,
        scope: flags.scope ? String(flags.scope) : undefined,
        baseHome,
      });
      process.stdout.write(`bounced ${res.card.id} → ${res.card.laneId} (${res.card.teamId})\n`);
      return 0;
    }
    if (flags.archive || flags.delete) {
      const action = flags.archive ? "archive" : "delete";
      const cardId = String(flags.archive || flags.delete).trim();
      const res = triageInboxCards({ action, cardId, baseHome });
      process.stdout.write(`${action}d ${res.card.id}\n`);
      return 0;
    }
    throw new Error("inbox triage needs --merge <targetId> <sourceId...> or --bounce <cardId> --lane <newLane>");
  }

  if (sub === "open-topic") {
    const cardId = String(flags.card || flags._[0] || "").trim();
    if (!cardId) throw new Error("inbox open-topic requires <cardId>");
    return openTopicBrainstorm({ cardId, baseHome }).then((res) => {
      process.stdout.write(`opened ${res.title} (${res.agentId}) for card #${res.card.id}\n`);
      return 0;
    });
  }

  if (sub === "handoff-topic") {
    const cardId = String(flags.card || flags._[0] || "").trim();
    const agentId = String(flags.agent || process.env.PASEO_AGENT_ID || "").trim();
    const planNote = flags.note ? String(flags.note) : flags._.slice(1).join(" ").trim();
    return handoffTopicBrainstorm({ cardId, agentId, planNote, baseHome }).then((res) => {
      process.stdout.write(`handed off card #${res.card.id} (${res.card.title}); closed ${res.archivedAgentId || "topic chat"}\n`);
      return 0;
    });
  }

  if (sub === "park-topic") {
    const cardId = String(flags.card || flags._[0] || "").trim();
    const agentId = String(flags.agent || process.env.PASEO_AGENT_ID || "").trim();
    const summaryNote = flags.note ? String(flags.note) : flags._.slice(1).join(" ").trim();
    return parkTopicBrainstorm({ cardId, agentId, summaryNote, baseHome }).then((res) => {
      process.stdout.write(`parked topic back to card #${res.card.id} (${res.card.title})\n`);
      return 0;
    });
  }

  throw new Error(`unknown inbox subcommand "${sub}". Use: vs inbox add | list | triage | open-topic | handoff-topic | park-topic`);
}

const WHO_TARGETS = new Set(["lead", "brainstorm", "buddy", "workers", "worker", "all"]);

function isRetiredAgent(labels) {
  return isRetiredRole(labels?.role);
}

function isDigestAgentRecord(labels) {
  return isDigestAgent(labels);
}

function effectiveAgentRole(a) {
  return resolveEffectiveAgentRole(a);
}

function resolveAgentTeamAndLane(a) {
  const resolved = resolveAgentIdentity(a, {
    teams: TEAM_DEFS,
    cwd: a.cwd,
  });
  if (!resolved.isOrphan) {
    return { teamId: resolved.teamId, lane: resolved.laneId, isOrphan: false };
  }
  return { teamId: "", lane: "", isOrphan: true };
}

function extractAgentTokens(a) {
  const usage = a?.lastUsage ?? a?.usage ?? a?.LastUsage ?? null;
  const candidates = [
    a?.labels?.["vs.mock-tokens"],
    a?.contextUsage?.usedTokens,
    a?.contextWindowUsedTokens,
    usage?.contextWindowUsedTokens ?? usage?.ContextWindowUsedTokens,
    usage?.usedTokens ?? usage?.UsedTokens,
    a?.inputTokens,
    usage?.inputTokens ?? usage?.InputTokens,
    usage?.cachedInputTokens ?? usage?.CachedTokens,
  ];
  let tokens = 0;
  for (const c of candidates) {
    const num = Number(c);
    if (Number.isFinite(num) && num > 0) {
      tokens = num;
      break;
    }
  }
  const tokensLabel = tokens > 0 && tokens < 1000 ? "1k" : `${Math.round(tokens / 1000)}k`;
  return { tokens, tokensLabel };
}

function formatWhoLine(entry) {
  return `${entry.title} · ${entry.id} · ${entry.status} · ${entry.tokensLabel}`;
}

async function enrichZeroTokenAgents(candidates) {
  const needInspect = candidates.filter((a) => !isRunnerId(a.id) && extractAgentTokens(a).tokens === 0);
  if (!needInspect.length) return;

  if (!hasCustomOfflineStore() && !hasCustomMockCli()) {
    const backend = getBackend(createDaemonClient());
    let timer = null;
    try {
      await Promise.race([
        (async () => {
          if (typeof backend.connect === "function") await backend.connect();
          const liveMap = new Map();
          if (typeof backend.fetchAgents === "function") {
            const res = await backend.fetchAgents({ filter: { includeArchived: false } }).catch(() => null);
            const list = Array.isArray(res)
              ? res
              : Array.isArray(res?.agents)
                ? res.agents
                : Array.isArray(res?.entries)
                  ? res.entries.map((e) => e.agent ?? e)
                  : [];
            for (const item of list) {
              if (item?.id) liveMap.set(item.id, item);
            }
          }
          for (const a of needInspect) {
            let live = liveMap.get(a.id) ?? null;
            if (!live && typeof backend.fetchAgent === "function") {
              const fetched = await backend.fetchAgent(a.id).catch(() => null);
              live = fetched?.agent ?? (fetched?.id ? fetched : null);
            }
            if (live) {
              a.lastUsage = live.lastUsage ?? live.usage ?? a.lastUsage ?? null;
              a.usage = live.lastUsage ?? live.usage ?? a.usage ?? null;
              a.contextUsage = live.contextUsage ?? a.contextUsage;
              a.contextWindowUsedTokens =
                live.contextWindowUsedTokens ??
                live.lastUsage?.contextWindowUsedTokens ??
                a.contextWindowUsedTokens;
              a.inputTokens = live.inputTokens ?? live.lastUsage?.inputTokens ?? a.inputTokens;
              a.labels = { ...(live.labels ?? {}), ...(a.labels ?? {}) };
            }
          }
        })(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DAEMON_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // ignore daemon errors
    } finally {
      if (timer) clearTimeout(timer);
      if (typeof backend?.close === "function") {
        await Promise.resolve(backend.close()).catch(() => {});
      }
    }
  }

  for (const a of needInspect) {
    if (extractAgentTokens(a).tokens > 0 && !hasCustomMockCli()) continue;
    const inspected = inspectAgentViaDaemon(a.id);
    if (inspected) {
      a.usage = inspected.usage ?? a.usage ?? null;
      a.contextWindowUsedTokens = a.contextWindowUsedTokens ?? inspected.contextWindowUsedTokens;
      a.inputTokens = a.inputTokens ?? inspected.inputTokens;
      a.labels = { ...(inspected.labels ?? {}), ...(a.labels ?? {}) };
    }
  }
}

async function commandWho(flags) {
  const rawTarget = String(flags._[0] ?? "all").trim().toLowerCase();
  if (!WHO_TARGETS.has(rawTarget)) {
    throw new Error(`unknown who target "${rawTarget}". Use: lead | brainstorm | buddy | workers | all`);
  }
  const target =
    rawTarget === "buddy"
      ? "brainstorm"
      : rawTarget === "worker"
        ? "workers"
        : rawTarget;

  const identity = resolveIdentity(flags);
  const wantTeamId = identity.team.id.toLowerCase();
  const wantLane = identity.lane.toLowerCase();
  // `who all` without --lane lists the whole squad, grouped by lane.
  const explicitLane = flags.lane ?? process.env.VS_LANE;
  const squadWide = target === "all" && !(typeof explicitLane === "string" && explicitLane.trim());

  const { agents } = collectAgents();
  const rawMatched = [];
  // Removed teams (Remove team in the UI) are hidden; a leftover agent labelled with one is not listed.
  const removedLanes = new Set((identity.team.lanes ?? []).filter((l) => l.state === "removed").map((l) => String(l.id).toLowerCase()));

  for (const a of agents) {
    const status = String(a.status ?? "unknown").trim();
    if (a.archivedAt || a.archived || a.internal || status.toLowerCase() === "closed") continue;

    const title = String(a.title ?? a.name ?? "").trim();
    const labels = a.labels ?? {};
    if (isRetiredAgent(labels)) continue;

    const { teamId, lane } = resolveAgentTeamAndLane(a);
    if (teamId.toLowerCase() !== wantTeamId) continue;
    if (!squadWide && lane.toLowerCase() !== wantLane) continue;
    if (removedLanes.has(lane.toLowerCase())) continue;

    const role = effectiveAgentRole(a);
    if (target === "lead" && role !== "lead") continue;
    if (target === "brainstorm" && role !== "brainstorm") continue;
    if (target === "workers" && role !== "worker") continue;
    if (target === "all" && role !== "lead" && role !== "brainstorm" && role !== "worker") continue;

    rawMatched.push({ agent: a, title: title || a.id, role, status, teamId, lane });
  }

  await enrichZeroTokenAgents(rawMatched.map((m) => m.agent));

  if (squadWide) {
    const order = new Map(identity.team.lanes.map((l, i) => [String(l.id).toLowerCase(), i]));
    const rank = (m) => order.get(m.lane.toLowerCase()) ?? order.size;
    rawMatched.sort((x, y) => rank(x) - rank(y) || x.lane.localeCompare(y.lane));
  }

  const matched = rawMatched.map(({ agent: a, title, role, status, teamId, lane }) => {
    const { tokens, tokensLabel } = extractAgentTokens(a);
    const entry = {
      id: a.id,
      title,
      role,
      status,
      team: teamId,
      lane,
      tokens,
      tokensLabel,
    };
    return { ...entry, line: formatWhoLine(entry) };
  });

  // Two live main Buddies for one (lane, topic) is a conflict too (docs/PLAN_BUGS_BATCH2.md block 0).
  // Topic Buddies are separate seats, so only same-topic pairs count.
  const bsTopics = rawMatched.map((m) => String(m.agent.labels?.topic ?? m.agent.labels?.["vs.inbox-card-id"] ?? "").trim().toLowerCase());
  const bsConflict = target === "brainstorm" && bsTopics.some((t, i) => bsTopics.indexOf(t) !== i);
  if (target === "lead" || bsConflict) {
    const status = matched.length === 1 ? "ok" : matched.length === 0 ? "none" : "conflict";
    const exitCode = matched.length === 1 ? 0 : matched.length === 0 ? 1 : 2;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ status, entries: matched }, null, 2) + "\n");
      return exitCode;
    }
    if (matched.length === 0) {
      process.stdout.write("NONE\n");
      return 1;
    }
    if (matched.length === 1) {
      process.stdout.write(`${matched[0].line}\n`);
      return 0;
    }
    process.stdout.write("CONFLICT\n");
    for (const item of matched) {
      process.stdout.write(`${item.line}\n`);
    }
    return 2;
  }

  const status = matched.length > 0 ? "ok" : "none";
  const exitCode = matched.length > 0 ? 0 : 1;
  if (flags.json) {
    process.stdout.write(JSON.stringify({ status, entries: matched }, null, 2) + "\n");
    return exitCode;
  }
  if (matched.length === 0) {
    process.stdout.write("NONE\n");
    return 1;
  }
  let lastLane = null;
  for (const item of matched) {
    if (squadWide && item.lane !== lastLane) {
      process.stdout.write(`[${item.lane}]\n`);
      lastLane = item.lane;
    }
    process.stdout.write(`${item.line}\n`);
  }
  return 0;
}

async function commandWhoami(flags) {
  const agentId = String(flags.agent ?? process.env.PASEO_AGENT_ID ?? process.env.VS_AGENT_ID ?? "").trim();
  // `--agent` names a specific target: resolve it strictly from that agent's own record.
  // The caller's VS_LANE / VS_TEAM / VS_ROLE / VS_ORD env describe the *caller*, and must not
  // leak onto a different agent's identity (e.g. a worker's VS_ROLE=worker overriding a lead).
  const explicitTarget = typeof flags.agent === "string" && flags.agent.trim() !== "";
  let record = isRunnerId(agentId) ? readRunnerAgentSync(agentId) : agentId ? readAgentRecord(agentId) : null;
  if (!record && agentId && !isRunnerId(agentId)) record = inspectAgentViaDaemon(agentId);

  const labels = record?.labels ?? {};
  const cwd = record?.cwd || process.cwd();

  const pick = (flagName, envName) => {
    const value = flags[flagName] ?? (explicitTarget ? "" : process.env[envName]);
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };

  const laneOverride = pick("lane", "VS_LANE");
  const teamOverride = pick("team", "VS_TEAM");
  const roleOverride = pick("role", "VS_ROLE");
  const ordOverride = pick("ord", "VS_ORD");

  const { agents } = collectAgents();
  const agentsById = new Map(agents.map((a) => [a.id, a]));

  const resolved = resolveAgentIdentity(
    {
      ...(record ?? {}),
      cwd,
      labels: {
        ...labels,
        ...(laneOverride ? { lane: laneOverride } : {}),
        ...(teamOverride ? { team: teamOverride } : {}),
        ...(roleOverride ? { role: roleOverride } : {}),
        ...(ordOverride ? { ord: ordOverride } : {}),
      },
    },
    {
      teams: TEAM_DEFS,
      cwd,
      lane: laneOverride || undefined,
      team: teamOverride || undefined,
      fallbackRole: roleOverride || labels.role || "worker",
      recomputeOrphan: Boolean(laneOverride || teamOverride),
      agentsById,
    },
  );

  let currentLead = null;
  if (!resolved.isOrphan && resolved.laneId && resolved.teamId) {
    const wantTeamId = resolved.teamId.toLowerCase();
    const wantLane = resolved.laneId.toLowerCase();
    const leadCandidates = [];
    for (const a of agents) {
      const status = String(a.status ?? "unknown").trim();
      if (a.archivedAt || a.archived || a.internal || status.toLowerCase() === "closed") continue;
      if (isRetiredAgent(a.labels ?? {})) continue;
      const aResolved = resolveAgentIdentity(a, { teams: TEAM_DEFS, cwd: a.cwd, agentsById });
      if (aResolved.isOrphan) continue;
      if (aResolved.teamId.toLowerCase() !== wantTeamId || aResolved.laneId.toLowerCase() !== wantLane) continue;
      if (effectiveAgentRole(a) !== "lead") continue;
      leadCandidates.push(a);
    }
    if (leadCandidates.length > 0) {
      await enrichZeroTokenAgents(leadCandidates);
      const lead = leadCandidates[0];
      const { tokens, tokensLabel } = extractAgentTokens(lead);
      const title = String(lead.title ?? lead.name ?? lead.id).trim();
      const status = String(lead.status ?? "unknown").trim();
      const line = formatWhoLine({ id: lead.id, title, status, tokensLabel });
      currentLead = {
        id: lead.id,
        title,
        status,
        ord: ordStringOf(lead.labels ?? {}),
        tokens,
        tokensLabel,
        line,
        summary: `${title} (${lead.id})`,
      };
    }
  }

  // Lane-less is orphan: JSON says lane: null + orphan: true, never lane: "".
  const orphan = Boolean(resolved.isOrphan || !resolved.laneId);
  const exitCode = orphan ? 1 : 0;
  if (flags.json) {
    const out = {
      agentId: agentId || null,
      lane: orphan ? null : resolved.laneId,
      squad: resolved.teamId,
      squadName: resolved.teamName,
      team: resolved.teamId,
      teamName: resolved.teamName,
      role: resolved.role,
      ord: resolved.ord,
      orphan,
      source: resolved.source,
      currentLead,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return exitCode;
  }

  const ordPart =
    resolved.role === "lead" || resolved.role === "former-lead" ? ` · ord: ord${resolved.ord}` : "";
  const leadSummary = currentLead ? `${currentLead.title} (${currentLead.id})` : "NONE";
  process.stdout.write(
    `lane: ${resolved.laneId || "unassigned"} · squad: ${resolved.teamId} (${resolved.teamName}) · role: ${resolved.role}${ordPart} · lead: ${leadSummary}\n`,
  );
  return exitCode;
}

function summarizeMigrationLabels(labels = {}) {
  const parts = [];
  if (labels.lane) parts.push(`lane=${labels.lane}`);
  else if (labels.lead) parts.push(`lead=${labels.lead}`);
  if (labels.team) parts.push(`team=${labels.team}`);
  if (labels.role) parts.push(`role=${labels.role}`);
  if (labels.ord) parts.push(`ord=${labels.ord}`);
  if (labels.orphan) parts.push(`orphan=${labels.orphan}`);
  return parts.length ? `{${parts.join(", ")}}` : "{}";
}

function migrationLabelsEqual(a = {}, b = {}) {
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== "");
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined && b[k] !== "");
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

function commandMigrate(flags) {
  const sub = String(flags._[0] ?? "identity").trim().toLowerCase();
  if (sub && sub !== "identity") {
    throw new Error(`unknown migrate target "${sub}". Use: vs migrate identity [--dry-run] [--json]`);
  }
  const dryRun = Boolean(flags.dryRun);

  agentIndex = null;
  const storeIndex = buildAgentIndex();
  const recordsById = new Map();

  for (const [id, file] of storeIndex.entries()) {
    try {
      const record = parseJsonWithBom(fs.readFileSync(file, "utf8"));
      if (record.internal) continue;
      recordsById.set(record.id ?? id, {
        id: record.id ?? id,
        file,
        record,
      });
    } catch {
      // skip corrupt store files
    }
  }

  const daemonList = listAgentsViaDaemon();
  if (Array.isArray(daemonList)) {
    for (const d of daemonList) {
      if (!d?.id || d.internal) continue;
      if (!recordsById.has(d.id)) {
        recordsById.set(d.id, {
          id: d.id,
          file: storeIndex.get(d.id) || null,
          record: d,
        });
      }
    }
  }

  const agentsById = new Map();
  for (const [id, item] of recordsById.entries()) {
    agentsById.set(id, item.record);
  }

  const entries = [];
  let changedCount = 0;
  let unchangedCount = 0;
  let orphanCount = 0;
  let archivedOrphanCount = 0;

  for (const [id, item] of recordsById.entries()) {
    const rec = item.record;
    const currentLabels = { ...(rec.labels ?? {}) };
    const archived = Boolean(rec.archivedAt || rec.archived);
    const status = archived ? "archived" : String(rec.lastStatus ?? rec.status ?? "unknown");
    const title = String(rec.title ?? rec.name ?? id).trim();

    const resolved = resolveAgentIdentity(rec, {
      teams: TEAM_DEFS,
      cwd: rec.cwd,
      agentsById,
      recomputeOrphan: true,
    });

    const proposedLabels = { ...currentLabels };
    // Digests are spawned with role=worker (digestFor/profile mark them): don't flip that label to role=digest.
    proposedLabels.role =
      resolved.role === "digest" && currentLabels.role !== "digest" ? "worker" : resolved.role;
    if (resolved.role === "lead" || resolved.role === "former-lead") {
      proposedLabels.ord = resolved.ord || "1";
    }

    if (!resolved.isOrphan) {
      proposedLabels.lane = resolved.laneId;
      proposedLabels.team = resolved.teamId;
      delete proposedLabels.orphan;
      if ("lead" in proposedLabels) {
        proposedLabels.lead = resolved.laneId;
      }
    } else {
      proposedLabels.orphan = "1";
    }

    const changed = !migrationLabelsEqual(currentLabels, proposedLabels);
    const isOrphan = Boolean(resolved.isOrphan);
    if (changed) changedCount++;
    else unchangedCount++;
    // Archived agents are history, not orphans to fix: count them apart so `orphans` lists only live ones.
    if (isOrphan && archived) archivedOrphanCount++;
    else if (isOrphan) orphanCount++;

    const tag = isOrphan ? (archived ? "ARCHIVED-ORPHAN" : "ORPHAN") : changed ? "CHANGED" : "OK";
    entries.push({
      id,
      file: item.file,
      status,
      title,
      source: resolved.source,
      currentLabels,
      proposedLabels,
      changed,
      orphan: isOrphan,
      tag,
      line: `${id} (${status}) [${title}]: ${summarizeMigrationLabels(currentLabels)} -> ${summarizeMigrationLabels(proposedLabels)} [${tag}]`,
    });
  }

  let backupDir = null;
  if (!dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = path.join(BASE_DIR, "backups", `identity-v2-${ts}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const candidateTeams of [
      path.join(BASE_DIR, "teams.json"),
      path.join(import.meta.dirname, "..", "teams.json"),
    ]) {
      if (fs.existsSync(candidateTeams)) {
        fs.copyFileSync(candidateTeams, path.join(backupDir, "teams.json"));
        break;
      }
    }
    const teamsRoot = path.join(BASE_DIR, "teams");
    if (fs.existsSync(teamsRoot)) {
      for (const dir of fs.readdirSync(teamsRoot, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const srcLog = path.join(teamsRoot, dir.name, "log.jsonl");
        if (fs.existsSync(srcLog)) {
          const dstDir = path.join(backupDir, "teams", dir.name);
          fs.mkdirSync(dstDir, { recursive: true });
          fs.copyFileSync(srcLog, path.join(dstDir, "log.jsonl"));
        }
      }
    }

    for (const entry of entries) {
      if (!entry.changed) continue;
      if (entry.file && fs.existsSync(entry.file)) {
        try {
          const diskRec = parseJsonWithBom(fs.readFileSync(entry.file, "utf8"));
          diskRec.labels = { ...entry.proposedLabels };
          fs.writeFileSync(entry.file, JSON.stringify(diskRec, null, 2) + "\n", "utf8");
        } catch {
          // ignore write error on individual store file
        }
      }
      if (!hasCustomOfflineStore()) {
        const updateArgs = ["agent", "update", entry.id];
        for (const [k, v] of Object.entries(entry.proposedLabels)) {
          updateArgs.push("--label", `${k}=${v}`);
        }
        runPaseo(updateArgs);
      }
    }
    agentIndex = null;
  }

  const summary = {
    dryRun,
    backupDir,
    total: entries.length,
    changed: changedCount,
    unchanged: unchangedCount,
    orphans: orphanCount,
    archivedOrphans: archivedOrphanCount,
    entries: entries.map(({ file: _file, ...rest }) => rest),
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  for (const entry of entries) {
    process.stdout.write(`${entry.line}\n`);
  }
  process.stdout.write(
    `total=${summary.total} changed=${summary.changed} unchanged=${summary.unchanged} orphans=${summary.orphans} archived-orphans=${summary.archivedOrphans}${backupDir ? ` backup=${backupDir}` : ""}\n`,
  );
  return 0;
}

function commandProfiles(flags) {
  const { profiles } = loadProfiles(undefined, { autoSeed: false });
  const rawRole = flags.role ? String(flags.role).trim().toLowerCase() : "";
  const wantRole =
    rawRole === "buddy"
      ? "brainstorm"
      : rawRole === "workers"
        ? "worker"
        : rawRole;
  const wantName = flags.name ? String(flags.name).trim().toLowerCase() : "";
  const includeNotes = Boolean(flags.notes);

  const matched = profiles.filter((p) => {
    if (wantRole && String(p.role ?? "").toLowerCase() !== wantRole) return false;
    if (wantName && !String(p.name ?? "").toLowerCase().includes(wantName)) return false;
    return true;
  });

  if (flags.json) {
    const out = matched.map((p) => {
      const item = {
        id: p.id ?? "",
        name: p.name,
        role: p.role,
        provider: p.provider,
        model: p.model,
        modeId: p.modeId ?? "default",
        ...(p.thinkingOptionId ? { thinkingOptionId: p.thinkingOptionId } : {}),
        ...(includeNotes ? { notes: p.notes ?? "" } : {}),
      };
      return item;
    });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return matched.length > 0 ? 0 : 1;
  }

  if (matched.length === 0) {
    process.stdout.write("NONE\n");
    return 1;
  }

  for (const p of matched) {
    const id = p.id || "-";
    const mode = p.modeId || "default";
    process.stdout.write(`${p.name} · ${id} · ${p.provider}/${p.model} · mode=${mode}\n`);
    if (includeNotes && p.notes) {
      process.stdout.write(`  notes: ${p.notes}\n`);
    }
  }
  return 0;
}

export function installVsShim({ binDirs, targetScript, baseHome } = {}) {
  const resolvedBaseHome = path.resolve(
    baseHome || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"),
  );
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const runtimeDir = path.join(resolvedBaseHome, "runtime");

  const runtimeFiles = [
    "cli/vs.mjs",
    "teams.json",
    "teams.example.json",
    "server/teams-file.mjs",
    "server/user-settings.mjs",
    "server/identity.mjs",
    "server/inbox.mjs",
    "server/profiles.mjs",
    "server/brainstorm.mjs",
    "server/brief-path.mjs",
    "server/whos-here.mjs",
    "server/stale-runtime.mjs",
    "server/pin-ideas.mjs",
    "docs/profiles/DEFAULT_PACK.md",
    ...vsImportClosure(repoRoot),
  ];

  if (path.resolve(repoRoot) !== path.resolve(runtimeDir)) {
    for (const rel of runtimeFiles) {
      const src = path.join(repoRoot, rel);
      const dst = path.join(runtimeDir, rel);
      try {
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } else if (rel === "teams.json" && !fs.existsSync(dst)) { const ex = path.join(repoRoot, "teams.example.json"); if (fs.existsSync(ex)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(ex, dst); } }
      } catch {
        // best-effort copy
      }
    }
    try {
      const srcNm = path.join(repoRoot, "node_modules");
      const dstNm = path.join(runtimeDir, "node_modules");
      if (fs.existsSync(srcNm) && !fs.existsSync(dstNm)) {
        fs.symlinkSync(srcNm, dstNm, process.platform === "win32" ? "junction" : "dir");
      }
    } catch {
      // non-fatal
    }
  }

  const primaryScript = path.resolve(targetScript || path.join(repoRoot, "cli", "vs.mjs"));
  const mainRepoScript = repoRoot.includes(".worktrees")
    ? path.resolve(repoRoot, "..", "..", "cli", "vs.mjs")
    : primaryScript;
  const fallbackScript = path.join(runtimeDir, "cli", "vs.mjs");

  const primaryPosix = primaryScript.replace(/\\/g, "/");
  const mainRepoPosix = mainRepoScript.replace(/\\/g, "/");
  const fallbackPosix = fallbackScript.replace(/\\/g, "/");

  const resolvedBinDirs =
    Array.isArray(binDirs) && binDirs.length
      ? binDirs.map((d) => path.resolve(String(d)))
      : process.platform === "win32"
        ? [
            path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm"),
            path.join(os.homedir(), ".local", "bin"),
          ]
        : [path.join(os.homedir(), ".local", "bin")];

  const shContent = [
    "#!/bin/sh",
    `if [ -f "${primaryPosix}" ]; then`,
    `  exec node "${primaryPosix}" "$@"`,
    `elif [ -f "${mainRepoPosix}" ]; then`,
    `  exec node "${mainRepoPosix}" "$@"`,
    `elif [ -f "${fallbackPosix}" ]; then`,
    `  exec node "${fallbackPosix}" "$@"`,
    "else",
    '  exec node "$HOME/.vibesquad/runtime/cli/vs.mjs" "$@"',
    "fi",
    "",
  ].join("\n");

  const cmdContent = [
    "@echo off",
    "@chcp 65001 >nul 2>nul",
    `if exist "${primaryScript}" (`,
    `  node "${primaryScript}" %*`,
    `) else if exist "${mainRepoScript}" (`,
    `  node "${mainRepoScript}" %*`,
    `) else if exist "${fallbackScript}" (`,
    `  node "${fallbackScript}" %*`,
    ") else (",
    '  node "%USERPROFILE%\\.vibesquad\\runtime\\cli\\vs.mjs" %*',
    ")",
    "",
  ].join("\r\n");

  const ps1Content = [
    "#!/usr/bin/env pwsh",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    `$primary = "${primaryScript}"`,
    `$mainRepo = "${mainRepoScript}"`,
    `$fallback = "${fallbackScript}"`,
    "if (Test-Path -LiteralPath $primary) {",
    "  & node $primary @args",
    "  exit $LASTEXITCODE",
    "} elseif (Test-Path -LiteralPath $mainRepo) {",
    "  & node $mainRepo @args",
    "  exit $LASTEXITCODE",
    "} elseif (Test-Path -LiteralPath $fallback) {",
    "  & node $fallback @args",
    "  exit $LASTEXITCODE",
    "} else {",
    '  & node "$HOME\\.vibesquad\\runtime\\cli\\vs.mjs" @args',
    "  exit $LASTEXITCODE",
    "}",
    "",
  ].join("\n");

  const files = [];
  for (const dir of resolvedBinDirs) {
    fs.mkdirSync(dir, { recursive: true });
    const shFile = path.join(dir, "vs");
    const cmdFile = path.join(dir, "vs.cmd");
    const ps1File = path.join(dir, "vs.ps1");
    fs.writeFileSync(shFile, shContent, "utf8");
    fs.writeFileSync(cmdFile, cmdContent, "utf8");
    fs.writeFileSync(ps1File, ps1Content, "utf8");
    try {
      fs.chmodSync(shFile, 0o755);
      fs.chmodSync(ps1File, 0o755);
    } catch {
      // ignore chmod on Windows
    }
    files.push(shFile, cmdFile, ps1File);
  }

  return {
    ok: true,
    runtimeDir,
    targetScript: primaryScript,
    fallbackScript,
    binDirs: resolvedBinDirs,
    files,
  };
}

// ---------------------------------------------------------------------------
// vs pin new: a pinned Team from an idea (docs/PLAN_PINNED_FEATURES.md §5). Writes the lane to
// teams.json and the brief; never spawns an agent (the first click on the pin starts its Brainstorm).
// ---------------------------------------------------------------------------

function extractBriefBullets(markdown, heading) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const headIdx = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\b`, "i").test(l.trim()));
  if (headIdx < 0) return [];
  const out = [];
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^[-*]\s+\((?:none|what makes|VibeSquad)/i.test(trimmed)) continue;
    out.push(lines[i]);
  }
  return out;
}

function appendBulletsToSection(markdown, heading, bullets) {
  if (!bullets.length) return markdown;
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const headIdx = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\b`, "i").test(l.trim()));
  if (headIdx < 0) {
    return [...lines, "", `## ${heading}`, ...bullets].join("\n");
  }
  let endIdx = headIdx + 1;
  while (endIdx < lines.length && !/^##\s+/.test(lines[endIdx].trim())) endIdx++;
  // Remove placeholder "(none recorded yet)" if present in this section
  for (let i = endIdx - 1; i > headIdx; i--) {
    if (/^[-*]\s+\(none recorded yet\)/i.test(lines[i].trim())) {
      lines.splice(i, 1);
      endIdx--;
    }
  }
  while (endIdx > headIdx + 1 && !lines[endIdx - 1].trim()) endIdx--;
  lines.splice(endIdx, 0, ...bullets);
  return lines.join("\n");
}

function matchLaneRef(lanes, rawRef) {
  const clean = String(rawRef ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (!clean) return null;
  return (
    lanes.find((l) => String(l.id).toLowerCase() === clean) ??
    lanes.find((l) => String(l.name ?? "").toLowerCase() === clean) ??
    lanes.find((l) => String(l.code ?? "").toLowerCase() === clean) ??
    lanes.find((l) => (l.aliases ?? []).some((a) => String(a).toLowerCase() === clean)) ??
    null
  );
}

function commandPinMerge(flags) {
  const fromRaw = String(flags._[0] ?? "").trim();
  const intoRaw = String(flags._[1] ?? "").trim();
  if (!fromRaw || !intoRaw) {
    throw new Error('usage: vs pin merge <from-lane> <into-lane> [--note "<shared contract>"] [--team <squad>]');
  }
  const note = String(flags.note ?? flags.brief ?? "").trim();
  const identity = resolveIdentity({ ...flags, lane: undefined });
  const squadDef = findTeamDef(flags.team ? String(flags.team) : identity.team.id) ?? findTeamDef(identity.team.name);
  if (!squadDef) throw new Error(`unknown squad "${flags.team ?? identity.team.name}". Pass --team <squad>.`);

  let file = resolveTeamsFilePath();
  if (path.basename(file) === "teams.example.json") file = path.join(BASE_DIR, "teams.json");
  const { value: cur } = readJsonFileWithBom(file, { fallback: null, label: "teams.json" });
  const doc = Array.isArray(cur?.teams) ? cur : { ...TEAMS_FILE };
  const target = doc.teams.find((t) => t.id === squadDef.id);
  if (!target) throw new Error(`squad "${squadDef.id}" is not in ${file}`);

  const lanes = target.lanes ?? [];
  const fromLane = matchLaneRef(lanes, fromRaw);
  const intoLane = matchLaneRef(lanes, intoRaw);
  if (!fromLane) throw new Error(`unknown source lane "${fromRaw}" in ${squadDef.name}`);
  if (!intoLane) throw new Error(`unknown target lane "${intoRaw}" in ${squadDef.name}`);
  if (fromLane.id === intoLane.id) throw new Error("source and target lanes must be different");

  const fromBrief = readBrainstormSummary(fromLane.id).content;
  const intoSummary = readBrainstormSummary(intoLane.id);
  let merged = intoSummary.content.includes("## Open")
    ? intoSummary.content
    : newPinBrief(intoLane.id, intoLane.name || intoLane.id, "");

  const tagBullet = (line) =>
    /^\s*[-*]\s+/.test(line) ? line.replace(/^(\s*[-*]\s+)/, `$1[from ${fromLane.name || fromLane.id}] `) : line;

  const decidedBullets = [
    ...(note ? [`- [Merged ${fromLane.name || fromLane.id} -> ${intoLane.name || intoLane.id}] ${note}`] : []),
    ...extractBriefBullets(fromBrief, "Decided").map(tagBullet),
  ];
  const openBullets = extractBriefBullets(fromBrief, "Open").map(tagBullet);

  merged = appendBulletsToSection(merged, "Decided", decidedBullets);
  merged = appendBulletsToSection(merged, "Open", openBullets);
  const written = writeBrainstormSummary(intoLane.id, merged);

  const nowIso = new Date().toISOString();
  target.lanes = lanes.map((l) => (l.id === fromLane.id ? { ...l, state: "done", doneAt: nowIso } : l));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);

  const logEntry = {
    ts: nowIso,
    agent: identity.agent || "RiffBot",
    lane: intoLane.id,
    type: "decision",
    text: `Merged ${fromLane.name || fromLane.id} (${fromLane.id}) -> ${intoLane.name || intoLane.id} (${intoLane.id})${note ? `: ${note}` : ""}`.slice(0, MAX_TEXT),
    refs: [fromLane.id, intoLane.id, written.path],
  };
  appendLog({ ...identity, team: squadDef, lane: intoLane.id, teamDir: path.join(BASE_DIR, "teams", squadDef.id) }, logEntry);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, squad: squadDef.id, from: fromLane.id, into: intoLane.id, brief: written.path }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `Merged ${fromLane.name} (${fromLane.id}) into ${intoLane.name} (${intoLane.id}). Updated ${written.path} and marked ${fromLane.id} done.\n`,
  );
  return 0;
}

function commandPin(flags) {
  const sub = String(flags._.shift() ?? "").toLowerCase();
  if (sub === "merge") return commandPinMerge(flags);
  if (sub !== "new") throw new Error('usage: vs pin new "<name>" --brief "<idea>" [--team <squad>] [--force] | vs pin merge <from-lane> <into-lane> [--note "<contract>"]');
  const name = flags._.join(" ").trim();
  if (!name) throw new Error('pin new needs a name: vs pin new "<name>" --brief "<idea>"');
  const brief = String(flags.brief ?? "").trim() || name;

  const identity = resolveIdentity({ ...flags, lane: undefined });
  const squadDef = findTeamDef(flags.team ? String(flags.team) : identity.team.id) ?? findTeamDef(identity.team.name);
  if (!squadDef) throw new Error(`unknown squad "${flags.team ?? identity.team.name}". Pass --team <squad>.`);
  const lanes = squadDef.lanes ?? [];

  // Done and removed teams never count as a match; --force skips the refusal entirely (ids still dedupe below).
  const live = lanes.filter((l) => l.state !== "done" && l.state !== "removed");
  const same = live.find((l) => String(l.name).toLowerCase() === name.toLowerCase() || l.id === slugLaneId(name));
  const hit = flags.force ? null : same ? { lane: same } : bestOverlap(`${name}
${brief}`, live);
  if (hit) {
    process.stderr.write(`Sounds like ${hit.lane.name} (${hit.lane.id}) in ${squadDef.name}. Use that Team${same ? "" : ", or re-run with --force to pin a new one"}.\n`);
    return 1;
  }

  const taken = new Set(takenLaneIds(TEAM_DEFS.flatMap((t) => t.lanes ?? [])));
  let id = uniqueLaneId(slugLaneId(name), taken);
  // Lane ids and brief files are global: skip ids that still have a brief on disk.
  while (fs.existsSync(readBrainstormSummary(id).fullPath)) {
    taken.add(id);
    id = uniqueLaneId(slugLaneId(name), taken);
  }

  const written = writeBrainstormSummary(id, newPinBrief(id, name, brief));
  let file = resolveTeamsFilePath();
  if (path.basename(file) === "teams.example.json") file = path.join(BASE_DIR, "teams.json");
  // Re-read the file right before the write (the UI may have saved since TEAM_DEFS loaded) and swap it in with a
  // rename, so a reader never sees half a file. The UI's revision check then refetches instead of overwriting this lane.
  const { value: cur } = readJsonFileWithBom(file, { fallback: null, label: "teams.json" });
  const doc = Array.isArray(cur?.teams) ? cur : { ...TEAMS_FILE };
  const target = doc.teams.find((t) => t.id === squadDef.id);
  if (!target) throw new Error(`squad "${squadDef.id}" is not in ${file}`);
  // Freeze: persist generated codes on every lane of the Squad that lacks one, plus the new lane's.
  target.lanes = freezeLaneCodes([...freezeLaneCodes(target.lanes ?? []), { id, name, state: "pinned" }]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, squad: squadDef.id, laneId: id, name, brief: written.path, teamsFile: file }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Pinned ${name} (${id}) in ${squadDef.name}. Brief: ${written.path}. No agent started; the first click on the pin starts its Brainstorm.\n`);
  return 0;
}

/** Maps a waitForFinish result to the CLI exit code and a one-line summary. */
export function summarizeWait(agentId, result) {
  const status = result?.status ?? "error";
  const code = status === "idle" ? 0 : status === "timeout" ? 2 : 1;
  const extra = status === "error" && result?.error ? ` (${result.error})` : "";
  return { code, line: `${agentId}: ${status}${extra}` };
}

/** vs wait <agent> [--timeout s]: waits on the daemon (waitForFinish). Injectable client for tests. */
export async function runWait(client, agentId, timeoutSec) {
  const backend = getBackend(client);
  const timeoutMs = timeoutSec === undefined ? 0 : Math.round(timeoutSec * 1000);
  return summarizeWait(agentId, await backend.waitForFinish(agentId, timeoutMs));
}

async function commandWait(flags) {
  const agentId = flags._[0] ?? "";
  if (!agentId) throw new Error("usage: vs wait <agent> [--timeout <seconds>]");
  let timeoutSec;
  if (flags.timeout !== undefined) {
    timeoutSec = Number(flags.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("--timeout must be a positive number of seconds");
  }
  if (isRunnerId(agentId)) {
    const { code, line } = await runWait(sharedRunnerBackend(), agentId, timeoutSec);
    process.stdout.write(line + "\n");
    return code;
  }
  const backend = getBackend(createDaemonClient());
  try {
    await backend.connect();
    const { code, line } = await runWait(backend, agentId, timeoutSec);
    process.stdout.write(line + "\n");
    return code;
  } finally {
    await Promise.resolve(backend.close?.()).catch(() => {});
  }
}

// vs spawn / send / status share server/mcp/tools.mjs with the VS MCP server. Injectable ctx for tests.
export async function runAgentVerb(verb, flags, ctx) {
  const id = String(flags._[0] ?? "");
  let args;
  if (verb === "spawn") {
    args = {
      title: flags.title,
      profile: flags.profile,
      prompt: flags.prompt ?? flags._.join(" "),
      ...(flags.cwd ? { cwd: path.resolve(String(flags.cwd)) } : {}),
    };
  } else if (verb === "send") {
    args = { id, text: flags._.slice(1).join(" ") };
  } else {
    args = { id };
  }
  const tool = verb === "spawn" ? "spawn_worker" : verb;
  return callTool(ctx, tool, args);
}

async function commandAgentVerb(verb, flags) {
  if (verb === "spawn" && (!flags.profile || !(flags.prompt ?? flags._.length))) {
    throw new Error('usage: vs spawn --title "<t>" --profile "<profile>" --prompt "<text>" [--cwd <dir>]');
  }
  if (verb === "send" && (!flags._[0] || flags._.length < 2)) throw new Error('usage: vs send <agent> "<text>"');
  if (verb === "status" && !flags._[0]) throw new Error("usage: vs status <agent>");
  const identity = resolveIdentity(flags);
  const ctx = createContext({
    identity: { agentId: identity.agentId, team: identity.team.id, lane: identity.lane, role: identity.role },
  });
  const result = await runAgentVerb(verb, flags, ctx);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

// Every repo file cli/vs.mjs can reach through relative imports (static or dynamic), so the runtime copy stays complete.
function vsImportClosure(repoRoot) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, rel), "utf8"); } catch { return; }
    seen.add(rel);
    for (const m of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+\.(?:mjs|js|cjs))["']/g)) {
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  };
  walk("cli/vs.mjs");
  // The MCP server is spawned by path (not imported) and loads these lazily.
  for (const entry of ["server/mcp/server.mjs", "server/backend/index.mjs"]) walk(entry);
  return [...seen];
}

function commandInstallShim(flags) {
  const binDirs = flags.binDir ? [path.resolve(String(flags.binDir))] : undefined;
  const res = installVsShim({ binDirs, baseHome: BASE_DIR });
  if (flags.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }
  for (const f of res.files) {
    process.stdout.write(`${f}\n`);
  }
  return 0;
}

// The launcher-only bootstrap: the server hands out a single-use nonce URL (the master token never goes on a
// command line); /__vibesquad/local-login checks it, sets the vs_local cookie and redirects to /.
async function commandOpen(flags) {
  const url = await requestLocalLoginUrl({ file: localTokenPath(BASE_DIR) });
  if (flags.print) {
    process.stdout.write(url + "\n");
    return 0;
  }
  const [cmd, args] =
    process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  const r = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`could not open a browser (${r.error?.message ?? `exit ${r.status}`}); run vs open --print and paste the URL`);
  process.stdout.write("Opened VibeSquad with owner access.\n");
  return 0;
}

// ---------------------------------------------------------------------------
// vs spec / vs task / vs cap — durable lane artifacts (docs/lanes/<lane>/)
// ---------------------------------------------------------------------------

function specLine(unit) {
  const files = Array.isArray(unit.files) ? unit.files.map(String).join(", ") : "";
  return `- ${unit.id} [${unit.status}] goal="${unit.goal ?? ""}" files=[${files}] doneCheck="${unit.doneCheck ?? ""}"`;
}

function commandSpec(flags) {
  const identity = resolveIdentity(flags);
  const rootDir = LANE_SPEC_ROOT;
  const sub = String(flags._[0] ?? "").toLowerCase();

  if (sub === "" || sub === "show" || sub === "read") {
    const spec = readLaneSpec(identity.team.id, identity.lane, rootDir);
    const content = spec.exists ? spec.content : "(no lane spec yet)";
    process.stdout.write(content.endsWith("\n") ? content : content + "\n");
    return 0;
  }

  if (sub === "write") {
    let content = "";
    if (flags.stdin) {
      content = fs.readFileSync(0, "utf8");
    } else if (flags.file) {
      content = fs.readFileSync(path.resolve(String(flags.file)), "utf8");
    } else {
      content = flags._.slice(1).join(" ").trim();
      if (!content) {
        throw new Error('spec write needs markdown: vs spec write "<markdown>" (or --stdin / --file <path>)');
      }
    }
    const written = writeLaneSpec(identity.team.id, identity.lane, content, rootDir);
    process.stdout.write(written.fullPath + "\n");
    return 0;
  }

  throw new Error(`unknown spec subcommand "${sub}". Use: vs spec show | write`);
}

function commandTask(flags) {
  const identity = resolveIdentity(flags);
  const rootDir = LANE_SPEC_ROOT;
  const sub = String(flags._[0] ?? "list").toLowerCase();

  if (sub === "list" || sub === "ls") {
    const board = readLaneTasks(identity.team.id, identity.lane, rootDir);
    if (flags.json) {
      process.stdout.write(JSON.stringify(board, null, 2) + "\n");
      return 0;
    }
    if (!board.units.length) {
      process.stdout.write("(no tasks)\n");
      return 0;
    }
    for (const unit of board.units) process.stdout.write(specLine(unit) + "\n");
    return 0;
  }

  if (sub === "set") {
    const id = String(flags._[1] ?? "").trim();
    if (!id) throw new Error("task set needs a unit id: vs task set <unit-id> [--goal <g>] [--files <f1,f2>] [--done-check <cmd>] [--status <todo|running|done|blocked>] [--branch <b>] [--commit <sha>]");
    const status = flags.status !== undefined ? String(flags.status) : undefined;
    if (status && !["todo", "running", "done", "blocked"].includes(status)) {
      throw new Error(`--status must be todo|running|done|blocked (got "${status}")`);
    }
    const patch = { id };
    if (flags.goal !== undefined) patch.goal = String(flags.goal);
    if (flags.doneCheck !== undefined) patch.doneCheck = String(flags.doneCheck);
    if (flags.files !== undefined) patch.files = String(flags.files).split(",").map((s) => s.trim()).filter(Boolean);
    if (status !== undefined) patch.status = status;
    if (flags.branch !== undefined) patch.branch = String(flags.branch);
    if (flags.commit !== undefined) patch.commit = String(flags.commit);

    const res = upsertLaneTask(identity.team.id, identity.lane, patch, rootDir);
    if (flags.json) {
      process.stdout.write(JSON.stringify(res.unit, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(specLine(res.unit) + "\n");
    return 0;
  }

  throw new Error(`unknown task subcommand "${sub}". Use: vs task list | set`);
}

function cappedProvidersFile() {
  return path.join(BASE_DIR, "capped-providers.json");
}

function readCappedProviders() {
  const { value } = readJsonFileWithBom(cappedProvidersFile(), { fallback: null, label: "capped-providers.json" });
  if (value && typeof value === "object" && value.capped && typeof value.capped === "object" && !Array.isArray(value.capped)) {
    return value;
  }
  return { capped: {} };
}

function writeCappedProviders(doc) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(cappedProvidersFile(), JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function commandCap(flags) {
  const sub = String(flags._[0] ?? "list").toLowerCase();

  if (sub === "list" || sub === "ls") {
    const doc = readCappedProviders();
    if (flags.json) {
      process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
      return 0;
    }
    const entries = Object.entries(doc.capped);
    if (!entries.length) {
      process.stdout.write("(no capped providers)\n");
      return 0;
    }
    for (const [provider, info] of entries) {
      process.stdout.write(`${provider}: ${info?.reason ?? ""} (${info?.updatedAt ?? ""})\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const provider = String(flags._[1] ?? "").trim().toLowerCase();
    if (!provider) throw new Error("cap add needs a provider: vs cap add <provider>");
    const doc = readCappedProviders();
    doc.capped[provider] = { reason: "cli cap", updatedAt: new Date().toISOString() };
    writeCappedProviders(doc);
    process.stdout.write(`capped ${provider}\n`);
    return 0;
  }

  if (sub === "clear") {
    const provider = String(flags._[1] ?? "").trim().toLowerCase();
    if (!provider) throw new Error("cap clear needs a provider: vs cap clear <provider>");
    const doc = readCappedProviders();
    delete doc.capped[provider];
    writeCappedProviders(doc);
    process.stdout.write(`cleared ${provider}\n`);
    return 0;
  }

  throw new Error(`unknown cap subcommand "${sub}". Use: vs cap list | add | clear`);
}

function commandWorktree(flags) {
  const sub = String(flags._[0] ?? "root").toLowerCase();
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const apply = Boolean(flags.apply);

  if (sub === "create" || sub === "add") {
    const branch = String(flags._[1] ?? flags.branch ?? "").trim();
    if (!branch) throw new Error("worktree create needs a branch: vs worktree create <branch>");
    const res = createManagedWorktree(repoRoot, branch);
    if (flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else {
      process.stdout.write(res.path + "\n");
    }
    return 0;
  }

  if (sub === "sweep") {
    const res = sweepMergedWorktrees(repoRoot, { apply });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }

  if (sub === "cleanup-projects") {
    const projectsDir = flags.projectsDir ? path.resolve(String(flags.projectsDir)) : path.dirname(repoRoot);
    const res = cleanupProjectsFolder(projectsDir, { apply });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }

  if (sub === "root" || sub === "path") {
    process.stdout.write(resolveManagedWorktreeRoot() + "\n");
    return 0;
  }

  throw new Error(`unknown worktree subcommand "${sub}". Use: vs worktree create | sweep | cleanup-projects | root`);
}

function commandLesson(flags) {
  const sub = String(flags._[0] ?? "list").toLowerCase();
  if (sub === "add") {
    const title = String(flags._[1] ?? flags.title ?? "").trim();
    const rule = String(flags._[2] ?? flags.rule ?? "").trim();
    const category = String(flags.category ?? "general").trim();
    const cause = String(flags.cause ?? title).trim();
    if (!title || !rule) {
      throw new Error('lesson add needs title and rule: vs lesson add "<title>" "<rule>" [--category <cat>] [--cause <cause>]');
    }
    const saved = appendLesson({ category, title, cause, rule });
    if (flags.json) {
      process.stdout.write(JSON.stringify(saved, null, 2) + "\n");
    } else {
      process.stdout.write(`Logged lesson ${saved.id}: ${saved.title}\n`);
    }
    return 0;
  }

  const query = sub === "list" || sub === "ls" ? (flags._[1] ?? flags.query) : (flags._[0] ?? flags.query);
  const items = readLessons({ category: flags.category, query });
  if (flags.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
  } else if (!items.length) {
    process.stdout.write("(no logged lessons in JSONL store; see docs/LESSONS.md)\n");
  } else {
    for (const l of items) process.stdout.write(`- [${l.category}] ${l.title}: ${l.rule}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }

  const command = flags._.shift() ?? "";

  if (flags.help || command === "" || command === "help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  try {
    if (command === "whoami") return commandWhoami(flags);
    if (command === "who") return commandWho(flags);
    if (command === "migrate") return commandMigrate(flags);
    if (command === "profiles") return commandProfiles(flags);
    if (command === "log") return commandLog(flags);
    if (command === "handoff") return commandHandoff(flags);
    if (command === "inbox") return commandInbox(flags);
    if (command === "pin") return commandPin(flags);
    if (command === "spec") return commandSpec(flags);
    if (command === "task") return commandTask(flags);
    if (command === "cap") return commandCap(flags);
    if (command === "worktree") return commandWorktree(flags);
    if (command === "lesson" || command === "lessons") return commandLesson(flags);
    if (command === "wait") return commandWait(flags);
    if (command === "spawn" || command === "send" || command === "status") return commandAgentVerb(command, flags);
    if (command === "install-shim") return commandInstallShim(flags);
    if (command === "open") return commandOpen(flags);
    process.stderr.write(`Error: unknown command "${command}". Try "vs --help".\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

const invokedArg = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfFile = path.resolve(import.meta.filename);
const invokedBase = path.basename(invokedArg, path.extname(invokedArg)).toLowerCase();
if (invokedArg === selfFile || invokedBase === "vs") {
  const warning = staleWarning();
  if (warning) process.stderr.write(`${warning}
`);
  const result = main(process.argv.slice(2));
  if (result && typeof result.then === "function") {
    result.then(
      (code) => {
        process.exitCode = typeof code === "number" ? code : 0;
      },
      (err) => {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    process.exitCode = result;
  }
}
