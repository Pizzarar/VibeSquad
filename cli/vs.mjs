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
import { createDaemonClient } from "../server/brainstorm.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "../server/teams-file.mjs";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole as resolveEffectiveAgentRole,
  findLaneInRegistry,
  findTeamInRegistry,
  isDigestAgent,
  isRetiredRole,
  normalizeRoleLabel,
  ordStringOf,
  resolveAgentIdentity,
} from "../server/identity.mjs";
import { loadProfiles } from "../server/profiles.mjs";
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
  const needle = String(value).toLowerCase();
  for (const team of TEAM_DEFS) {
    for (const lane of team.lanes ?? []) {
      if (String(lane.id).toLowerCase() === needle || (lane.aliases ?? []).some((a) => String(a).toLowerCase() === needle)) {
        return { team, lane };
      }
    }
  }
  return null;
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

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// cmd.exe still expands %VAR% and breaks out of quotes on `"`, so refuse those outright.
const UNSAFE_SHELL_ARG = /[\r\n\0"%]/;

function run(command, args, timeoutMs) {
  try {
    if (process.platform === "win32" && (command === "paseo" || /\.(cmd|bat)$/i.test(command))) {
      if (args.some((a) => UNSAFE_SHELL_ARG.test(String(a)))) {
        return { status: null, stdout: "", stderr: "refusing argument with shell metacharacters", error: new Error("unsafe argument") };
      }
      const line = [command, ...args].map(shellQuote).join(" ");
      return spawnSync(line, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: true });
    }
    return spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { status: null, stdout: "", stderr: String(err?.message ?? err), error: err };
  }
}

function hasCustomMockCli() {
  const cli = String(process.env.PASEO_CLI ?? "").trim();
  if (!cli || cli === "paseo" || cli === "paseo.cmd") return false;
  if (/[\\/]Programs[\\/]Paseo[\\/]resources[\\/]bin[\\/]paseo(?:\.cmd|\.exe)?$/i.test(cli)) return false;
  return true;
}

function hasCustomOfflineStore() {
  if (hasCustomMockCli()) return false;
  if (!process.env.PASEO_HOME) return false;
  const defaultHome = path.resolve(path.join(os.homedir(), ".paseo"));
  if (path.resolve(PASEO_HOME) === defaultHome) return false;
  return !fs.existsSync(path.join(PASEO_HOME, "server-id"));
}

function runPaseo(args, timeoutMs = DAEMON_TIMEOUT_MS) {
  if (hasCustomOfflineStore()) return null;
  const idArg = args[0] === "inspect" ? args[1] : args[0] === "agent" ? args[2] : undefined;
  if ((args[0] === "inspect" || args[0] === "agent") && !AGENT_ID_RE.test(String(idArg ?? ""))) return null;
  const cli = process.env.PASEO_CLI || "paseo";
  const result = run(cli, args, timeoutMs);
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? null;
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

function resolveIdentity(flags) {
  const agentId = String(flags.agent ?? process.env.PASEO_AGENT_ID ?? "").trim();

  let record = agentId ? readAgentRecord(agentId) : null;
  if (!record && agentId) record = inspectAgentViaDaemon(agentId);

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
  if (!lane && team.lanes.length >= 1) lane = team.lanes[0].id;
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
  vs install-shim [--bin-dir <dir>]

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

function collectAgents() {
  const live = listAgentsViaDaemon();
  if (live && live.length) return { agents: live, source: "daemon" };
  return { agents: listAgentsOffline(), source: "offline" };
}

function resolveCallerUsage(identity) {
  if (!identity.agentId) return null;
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
  const needInspect = candidates.filter((a) => extractAgentTokens(a).tokens === 0);
  if (!needInspect.length) return;

  if (!hasCustomOfflineStore() && !hasCustomMockCli()) {
    const client = createDaemonClient();
    let timer = null;
    try {
      await Promise.race([
        (async () => {
          if (typeof client.connect === "function") await client.connect();
          const liveMap = new Map();
          if (typeof client.fetchAgents === "function") {
            const res = await client.fetchAgents({ filter: { includeArchived: false } }).catch(() => null);
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
            if (!live && typeof client.fetchAgent === "function") {
              const fetched = await client.fetchAgent(a.id).catch(() => null);
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
      if (typeof client?.close === "function") {
        await Promise.resolve(client.close()).catch(() => {});
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

  const { agents } = collectAgents();
  const rawMatched = [];

  for (const a of agents) {
    const status = String(a.status ?? "unknown").trim();
    if (a.archivedAt || a.archived || a.internal || status.toLowerCase() === "closed") continue;

    const title = String(a.title ?? a.name ?? "").trim();
    const labels = a.labels ?? {};
    if (isRetiredAgent(labels)) continue;

    const { teamId, lane } = resolveAgentTeamAndLane(a);
    if (teamId.toLowerCase() !== wantTeamId || lane.toLowerCase() !== wantLane) continue;

    const role = effectiveAgentRole(a);
    if (target === "lead" && role !== "lead") continue;
    if (target === "brainstorm" && role !== "brainstorm") continue;
    if (target === "workers" && role !== "worker") continue;
    if (target === "all" && role !== "lead" && role !== "brainstorm" && role !== "worker") continue;

    rawMatched.push({ agent: a, title: title || a.id, role, status, teamId, lane });
  }

  await enrichZeroTokenAgents(rawMatched.map((m) => m.agent));

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

  if (target === "lead") {
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
  for (const item of matched) {
    process.stdout.write(`${item.line}\n`);
  }
  return 0;
}

async function commandWhoami(flags) {
  const agentId = String(flags.agent ?? process.env.PASEO_AGENT_ID ?? "").trim();
  let record = agentId ? readAgentRecord(agentId) : null;
  if (!record && agentId) record = inspectAgentViaDaemon(agentId);

  const labels = record?.labels ?? {};
  const cwd = record?.cwd || process.cwd();

  const pick = (flagName, envName) => {
    const value = flags[flagName] ?? process.env[envName];
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

  const exitCode = resolved.isOrphan ? 1 : 0;
  if (flags.json) {
    const out = {
      agentId: agentId || null,
      lane: resolved.isOrphan ? null : resolved.laneId,
      squad: resolved.teamId,
      squadName: resolved.teamName,
      team: resolved.teamId,
      teamName: resolved.teamName,
      role: resolved.role,
      ord: resolved.ord,
      orphan: Boolean(resolved.isOrphan),
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

  for (const [id, item] of recordsById.entries()) {
    const rec = item.record;
    const currentLabels = { ...(rec.labels ?? {}) };
    const status = rec.archivedAt || rec.archived ? "archived" : String(rec.lastStatus ?? rec.status ?? "unknown");
    const title = String(rec.title ?? rec.name ?? id).trim();

    const resolved = resolveAgentIdentity(rec, {
      teams: TEAM_DEFS,
      cwd: rec.cwd,
      agentsById,
      recomputeOrphan: true,
    });

    const proposedLabels = { ...currentLabels };
    proposedLabels.role = resolved.role;
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
    if (isOrphan) orphanCount++;

    const tag = isOrphan ? "ORPHAN" : changed ? "CHANGED" : "OK";
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
    `total=${summary.total} changed=${summary.changed} unchanged=${summary.unchanged} orphans=${summary.orphans}${backupDir ? ` backup=${backupDir}` : ""}\n`,
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
    "server/user-settings.mjs",
    "server/identity.mjs",
    "server/inbox.mjs",
    "server/profiles.mjs",
    "server/brainstorm.mjs",
    "docs/profiles/DEFAULT_PACK.md",
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
    if (command === "install-shim") return commandInstallShim(flags);
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
