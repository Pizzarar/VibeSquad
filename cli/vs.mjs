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
// Caller identity comes from VS_AGENT_ID (PASEO_AGENT_ID is still read: the runner exports both, old prompts use it) or --agent.
// Labels are read from the runner's own agent log; teams.json path rules decide the team/lane for everything else.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}
import {
  addInboxCards,
  INBOX_STATUSES,
  listInboxCards,
  assertInboxTriageCaller,
  triageInboxCards,
} from "../server/inbox.mjs";
import { createAgentClient, readBrainstormSummary, writeBrainstormSummary } from "../server/brainstorm.mjs";
import { getBackend, isRunnerId, listRunnerAgentsSync, readRunnerAgentSync, sharedRunnerBackend } from "../server/backend/index.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { bestOverlap, newPinBrief, slugLaneId, takenLaneIds, uniqueLaneId } from "../server/pin-ideas.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath, teamsRevision, writeTeamsRegistry } from "../server/teams-file.mjs";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole as resolveEffectiveAgentRole,
  findBugLane,
  findLaneInRegistry,
  findTeamInRegistry,
  isHubLane,
  isDigestAgent,
  freezeLaneCodes,
  isRetiredRole,
  normalizeRoleLabel,
  ordStringOf,
  resolveAgentIdentity,
  resolveLeadWinner,
  whoCandidate,
} from "../server/identity.mjs";
import { loadProfiles } from "../server/profiles.mjs";
import { readLiveCapDoc, setProviderCapped } from "../server/provider-failover.mjs";
import { staleWarning } from "../server/stale-runtime.mjs";
import { LOCAL_TOKEN_HEADER, localTokenPath, readLocalToken, requestLocalLoginUrl } from "../server/local-token.mjs";
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
const GH_TIMEOUT_MS = 2000;

const BASE_DIR = path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
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

function findLane(value, preferTeamId = "") {
  if (!value) return null;
  const stripped = String(value).trim().replace(/^@+/, "");
  const needle = stripped.toLowerCase();
  const liveTeams = loadTeamsFile().teams; // live read: TEAM_DEFS is a module-load snapshot, stale after a lane add/rename
  for (const team of liveTeams) {
    for (const lane of team.lanes ?? []) {
      if (String(lane.id).toLowerCase() === needle || (lane.aliases ?? []).some((a) => String(a).toLowerCase() === needle)) {
        return { team, lane };
      }
    }
  }
  // `@<code>` / `<code>` handles (e.g. @bug -> bug-chaser) and name matches.
  return findLaneInRegistry(value, liveTeams, preferTeamId);
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

  return null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = { _: [], ref: [] };
  const valued = new Set([
    "reason",
    "steer",
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
    "park",
    "accept",
    "reject",
    "setStatus",
    "card",
    "note",
    "binDir",
    "base",
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
    "provider",
    "cwd",
    "prompt",
    "promptFile",
    "title",
    "note",
    "since",
    "source",
    "revision",
    "stall",
    "owner",
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
    "noForce",
    "force",
    "print",
    "stdin",
    "apply",
    "sweep",
    "suite",
    "restart",
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

export function resolveIdentity(flags = {}, { recordWins = false } = {}) {
  const envAgentId = recordWins
    ? (process.env.VS_AGENT_ID || process.env.PASEO_AGENT_ID)
    : (process.env.PASEO_AGENT_ID ?? process.env.VS_AGENT_ID);
  // A caller that is a runner agent with a record is who its labels say: --agent/--role/--ord are claims, never overrides
  // (a worker passing `--role lead` or `--agent <lead>` must not pass a lead gate). --lane/--team still aim the verb.
  const envId = String(envAgentId ?? "").trim();
  const callerRecord = envId && isRunnerId(envId) ? readRunnerAgentSync(envId) : null;
  const agentId = String((recordWins || callerRecord ? envAgentId : (flags.agent ?? envAgentId)) ?? "").trim();

  // rn- ids belong to the runner: read its log (labels/role/lane).
  let record = isRunnerId(agentId) ? readRunnerAgentSync(agentId) : null;

  const labels = record?.labels ?? {};
  const title = record?.title ?? "";
  const cwd = record?.cwd || process.cwd();

  const pick = (flagName, envName) => {
    // recordWins (handoff_lead, spawn): a runner record's labels are the caller's identity; CLI flags never override it and VS_* env only fills in when there is no record.
    const claim = flagName === "role" || flagName === "ord";
    if (callerRecord && claim) return ""; // the record's labels supply role/ord
    const value = (recordWins ? undefined : flags[flagName]) ?? (recordWins && record ? undefined : process.env[envName]);
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };

  const laneFromFlag = pick("lane", "VS_LANE");
  const laneFromLabels = labels.lane || labels.lead || "";
  const teamFromFlag = pick("team", "VS_TEAM");
  const laneRaw = laneFromFlag || (!teamFromFlag ? laneFromLabels : "");
  const laneHit = findLane(laneRaw, teamFromFlag || labels.team || "");

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
  vs profiles [--role <role>] [--name <name>] [--notes] [--json]
  vs log <type> "<text>" [--ref <ref>...] [--digest]
  vs log --since-me [--limit <N>] [--peek]
  vs handoff [--out <path>]
  vs inbox add "<idea 1>" ["<idea 2>" ...] [--lane <lane>|bug] [--from-brainstorm] [--source <tag>]  (--lane bug = your Squad's Bug Runner lane)
  vs inbox list [--lane <lane>|bug]
  vs inbox triage --merge <targetId> <sourceId...> | --bounce <cardId> --lane <newLane> | --archive|--park <cardId...> (leads/Buddies of the card's Squad + owner)
  vs pin new "<name>" --brief "<idea>" [--team <squad>] [--force]
  vs pin merge <from-lane> <into-lane> [--note "<shared contract>"] [--team <squad>]
  vs spec [show] [--lane <lane>] [--team <team>]
  vs spec write "<markdown>" | --stdin | --file <path> [--lane <lane>] [--team <team>]
  vs task list [--lane <lane>] [--json]
  vs task set <unit-id> [--goal <g>] [--files <f1,f2>] [--done-check <cmd>] [--status <todo|running|done|blocked>] [--branch <b>] [--commit <sha>]
  vs cap [list | add <provider> | clear <provider>]
  vs spawn --title "<t>" --profile "<profile>" --prompt "<text>" | --prompt-file <path|-> [--cwd <dir>] [--stakes <tierA-security|tierA-invariant|normal|mechanical>]   start a worker in your lane (long brief: --prompt-file <path>, or "-" for stdin)
  vs lead handoff [--lane <code>] [--steer "<note>"]   hand the lane's lead to a successor (Buddy: its own lane's lead; lead: itself; Overlord: any lane in its Squad, steer goes to the successor)
  vs restart [--dry-run] [--timeout <sec>] [--no-force]   OWNER/Overlord only, never from a worker: restart the runner + VS server detached, once idle (waits for running:0, default 600s); result in ~/.vibesquad/restart-<ts>.json
  vs buddy restart --lane <code> [--reason "<why>"] [--profile "<Brainstorm profile>" | --provider claude|gemini]   restart a lane's Buddy via the brainstorm-restart path, or start its first one if it has none (lane lead: its own lane; Overlord: any lane in its Squad; owner: any)
  vs send <agent> "<text>" | --prompt-file <path|->   message an agent (long text: --prompt-file <path>, or "-" for stdin)
  vs status <agent>   status + last assistant message
  vs ls [--lane <lane>] [--team <team>]   list live agents in your lane
  vs logs <agent> [--limit <N>]   agent timeline entries
  vs inspect <agent>   full agent record
  vs stop <agent>   interrupt an agent's current turn
  vs archive <agent>   archive a single agent
  vs archive --sweep [--apply]   long-done worker sweep across all Squads (same predicate as the 5-min sweep): dry run by default, --apply archives; needs the running server
  vs wait <agent> [--timeout <seconds>]   block until idle (exit 0), error or blocked (1), timeout (2); no limit by default
  vs watch add <agent...> [--suite] [--restart] [--stall <min>] [--owner <agent>]   register a watch set (agents + your suite run + a restart) and end your turn; one ping when it completes or stalls (--stall default 15 min)
  vs watch list | vs watch cancel <id>   list or cancel your watch sets (only the same-Squad Overlord may name another owner via --owner)
  vs mcp alias-report [--since <30m|12h|7d>] [--json]   Paseo-name alias hits per alias + caller
  vs install-shim [--bin-dir <dir>] [--force]
  vs open [--print]   open the local web UI with owner access (sets the vs_local cookie); --print shows a one-time URL (60 s)
  vs pair [--json]   mint a pairing code on the running local server (headless/SSH): prints the link, 6-digit code, CA fingerprint and an ASCII QR
  vs devices list [--json] | vs devices revoke <id|--all>   paired devices in ~/.vibesquad/devices.json; revoke drops the token (lost phone)

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

// Runner agents live in the runner's own logs: shape them as agent rows.
function listAgentsViaRunner() {
  return listRunnerAgentsSync().map((a) => ({
    id: a.id,
    name: a.title,
    title: a.title,
    status: a.status,
    queued: a.queued ?? null,
    cwd: a.cwd ?? "",
    archivedAt: a.archivedAt ?? null,
    archived: Boolean(a.archivedAt),
    internal: false,
    labels: a.labels ?? {},
    requiresAttention: false,
    attentionReason: null,
    pendingPermissions: [],
    usage: null,
    lastUsage: a.lastUsage ?? null,
    resumable: a.resumable === true,
    lost: a.lost === true,
    createdAt: a.createdAt ?? null,
    updatedAt: a.updatedAt ?? null,
  }));
}

function collectAgents() {
  return { agents: listAgentsViaRunner(), source: "runner" };
}

function resolveCallerUsage(identity) {
  if (!identity.agentId) return null;
  if (isRunnerId(identity.agentId)) {
    const u = readRunnerAgentSync(identity.agentId)?.lastUsage;
    if (!u) return null;
    return { input: Number(u.inputTokens ?? 0), output: Number(u.outputTokens ?? 0), cached: 0 };
  }
  return null;
}

/** spawnSync wrapper for git / gh probes: never throws, always returns a result object. */
function run(command, args, timeoutMs) {
  try {
    return spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { status: null, stdout: "", stderr: String(err?.message ?? err), error: err };
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
  lines.push(`- **Generated:** ${now}`);

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

/** `--lane bug` means the calling agent's own Squad bug lane (each Squad has its own); any other value is a lane id as typed. Returns { laneId, teamId }: a lane that resolves to a known Squad carries that Squad's id (never a conflicting --team). */
function resolveInboxScope(flags) {
  const raw = flags.lane ? String(flags.lane).trim() : "";
  const flagTeam = flags.team ? String(flags.team) : undefined;
  if (!raw) return { laneId: undefined, teamId: flagTeam };
  if (raw.replace(/^@+/, "").toLowerCase() !== "bug") {
    const hit = findLane(raw, flagTeam || "");
    return { laneId: raw, teamId: hit ? hit.team.id : flagTeam };
  }
  const me = resolveIdentity({ ...flags, lane: undefined }, { recordWins: true });
  const lane = findBugLane(me.team);
  if (!lane) throw new Error(`Squad ${me.team?.id || "(unknown)"} has no bug lane; pass the lane id explicitly`);
  return { laneId: lane.id, teamId: me.team.id };
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
      ...resolveInboxScope(flags),
      source: flags.source ? String(flags.source) : flags.fromBrainstorm ? "brainstorm-dump" : "cli",
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
    const listStatus = flags.status ? String(flags.status) : "open";
    if (listStatus !== "all" && listStatus !== "open" && !INBOX_STATUSES.includes(listStatus)) {
      throw new Error(`inbox list --status must be one of: open, all, ${INBOX_STATUSES.join(", ")}`);
    }
    const cards = listInboxCards({
      ...resolveInboxScope(flags),
      status: listStatus,
      baseHome,
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(cards, null, 2) + "\n");
      return 0;
    }
    if (!cards.length) {
      process.stdout.write("(0 ideas in Inbox)\n");
      return 0;
    }
    for (const c of cards) {
      process.stdout.write(`${formatInboxCardLine(c)}\n`);
    }
    return 0;
  }

  if (sub === "triage") {
    // One gate for every mutating triage action. Empty agent id = the owner at a local shell: accepted trust
    // model (an agent could edit inbox.json directly anyway). An agent id with no runner record fails closed.
    const gate = (cardIds, { ownerOnly = false } = {}) => {
      const me = resolveIdentity(flags, { recordWins: true });
      if (me.agentId && !(isRunnerId(me.agentId) && readRunnerAgentSync(me.agentId))) {
        throw new Error(`inbox triage denied: agent ${me.agentId} has no runner record, so its role/Squad cannot be verified`);
      }
      if (ownerOnly && me.agentId) throw new Error("deleting cards is owner-only; use --archive");
      assertInboxTriageCaller({ agentId: me.agentId, role: me.role, teamId: me.team.id }, cardIds, baseHome);
    };
    if (flags.merge) {
      const mergeStr = String(flags.merge).trim();
      let targetId = mergeStr;
      let sourceIds = flags._.map((s) => String(s).trim()).filter(Boolean);
      if (mergeStr.includes(",")) {
        const parts = mergeStr.split(",").map((s) => s.trim()).filter(Boolean);
        targetId = parts[0];
        sourceIds = [...parts.slice(1), ...sourceIds];
      }
      gate([targetId, ...sourceIds]);
      const res = triageInboxCards({ action: "merge", targetId, sourceIds, baseHome });
      process.stdout.write(`merged [${res.mergedIds.join(", ")}] → ${res.card.id} (${res.card.title})\n`);
      return 0;
    }
    if (flags.bounce) {
      const cardId = String(flags.bounce).trim();
      const laneId = String(flags.lane || flags._[0] || "").trim();
      if (!laneId) throw new Error("inbox triage --bounce <cardId> requires --lane <newLane>");
      gate([cardId]);
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
    if (flags.accept || flags.reject || flags.setStatus) {
      const cardId = String(flags.accept || flags.reject || flags.setStatus).trim();
      const status = flags.accept ? "accepted" : flags.reject ? "rejected" : String(flags.status || "").trim();
      if (!INBOX_STATUSES.includes(status)) {
        throw new Error(`inbox triage status must be one of: ${INBOX_STATUSES.join(", ")}`);
      }
      gate([cardId]);
      const res = triageInboxCards({ action: "update", cardId, patch: { status }, baseHome });
      process.stdout.write(`${res.card.id} → ${res.card.status}
`);
      return 0;
    }
    if (flags.archive || flags.park) {
      const verb = flags.archive ? "archive" : "park";
      const cardIds = [String(flags.archive || flags.park), ...flags._].map((s) => String(s).trim()).filter(Boolean);
      gate(cardIds);
      for (const cardId of cardIds) {
        const res = verb === "archive"
          ? triageInboxCards({ action: "archive", cardId, baseHome })
          : triageInboxCards({ action: "update", cardId, patch: { status: "parked" }, baseHome });
        process.stdout.write(`${verb === "archive" ? "archived" : "parked"} ${res.card.id}
`);
      }
      return 0;
    }
    if (flags.delete) {
      gate([], { ownerOnly: true });
      const res = triageInboxCards({ action: "delete", cardId: String(flags.delete).trim(), baseHome });
      process.stdout.write(`deleted ${res.card.id}
`);
      return 0;
    }
    throw new Error("inbox triage needs --merge <targetId> <sourceId...>, --bounce <cardId> --lane <newLane>, --accept|--reject <cardId>, --archive|--park <cardId...>, or --set-status <cardId> --status <status>");
  }

  throw new Error(`unknown inbox subcommand "${sub}". Use: vs inbox add | list | triage`);
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
  const status = entry.queued ? `queued(${entry.queued.ahead})` : entry.status;
  return `${entry.title} · ${entry.id} · ${status} · ${entry.tokensLabel}`;
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
    const hit = whoCandidate(a, { teams: TEAM_DEFS, wantTeamId, wantLane, squadWide, removedLanes });
    if (!hit) continue;
    const { teamId, lane, role } = hit;
    const status = a.lost ? "lost" : String(a.status ?? "unknown").trim();
    const title = String(a.title ?? a.name ?? "").trim();

    if (target === "lead" && role !== "lead") continue;
    if (target === "brainstorm" && role !== "brainstorm") continue;
    if (target === "workers" && role !== "worker") continue;
    if (target === "all" && role !== "lead" && role !== "brainstorm" && role !== "worker") continue;

    rawMatched.push({ agent: a, title: title || a.id, role, status, teamId, lane, queued: a.queued ?? null });
  }

  if (squadWide) {
    const order = new Map(identity.team.lanes.map((l, i) => [String(l.id).toLowerCase(), i]));
    const rank = (m) => order.get(m.lane.toLowerCase()) ?? order.size;
    rawMatched.sort((x, y) => rank(x) - rank(y) || x.lane.localeCompare(y.lane));
  }

  const matched = rawMatched.map(({ agent: a, title, role, status, teamId, lane, queued }) => {
    const { tokens, tokensLabel } = extractAgentTokens(a);
    const entry = {
      id: a.id,
      title,
      role,
      status,
      queued,
      team: teamId,
      lane,
      tokens,
      tokensLabel,
    };
    return { ...entry, line: formatWhoLine(entry) };
  });

  // Single-role seats resolve a winner (docs/PLAN_BUGS_BATCH2.md block 0 for Buddies): a closed-but-resumable holder
  // (a lost lead/Buddy) loses to a live one, and 2+ live holders of the same seat is a conflict. Buddies are one seat per topic.
  if (target === "lead" || target === "brainstorm") {
    const topicKey = (m) =>
      String(m.agent.labels?.topic ?? m.agent.labels?.["vs.inbox-card-id"] ?? "").trim().toLowerCase();
    const groups = new Map();
    for (const m of rawMatched) {
      const k = target === "lead" ? "" : topicKey(m);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const winners = [];
    const conflictRows = [];
    const handoffPending = new Map(); // winner id -> successor short name
    const shortTitle = (t) => String(t).split(" · ")[0].trim() || String(t);
    for (const group of groups.values()) {
      const { winner, conflict, pending } = resolveLeadWinner(group.map((m) => m.agent));
      if (conflict) conflictRows.push(...group);
      else if (winner) {
        winners.push(winner);
        if (pending.length) {
          const succ = group.find((m) => m.agent.id === pending[pending.length - 1]);
          handoffPending.set(winner.id, succ ? shortTitle(succ.title) : pending[0]);
        }
      }
    }
    const conflictIds = new Set(conflictRows.map((m) => m.agent.id));
    const entries = (conflictIds.size
      ? matched.filter((m) => conflictIds.has(m.id))
      : matched.filter((m) => winners.some((w) => w.id === m.id))
    ).map((m) => (handoffPending.has(m.id) ? { ...m, handoffPending: handoffPending.get(m.id), line: `${m.line} · handoff pending → ${handoffPending.get(m.id)}` } : m));
    const status = conflictIds.size ? "conflict" : entries.length ? "ok" : "none";
    const exitCode = conflictIds.size ? 2 : entries.length ? 0 : 1;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ status, entries }, null, 2) + "\n");
      return exitCode;
    }
    if (!entries.length) {
      process.stdout.write("NONE\n");
      return 1;
    }
    if (conflictIds.size) {
      process.stdout.write("CONFLICT\n");
      for (const item of entries) process.stdout.write(`${item.line}\n`);
      return 2;
    }
    for (const item of entries) process.stdout.write(`${item.line}\n`);
    return 0;
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
  let record = isRunnerId(agentId) ? readRunnerAgentSync(agentId) : null;

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
      if (a.archivedAt || a.archived || a.internal || (status.toLowerCase() === "closed" && a.resumable !== true)) continue;
      if (isRetiredAgent(a.labels ?? {})) continue;
      const aResolved = resolveAgentIdentity(a, { teams: TEAM_DEFS, cwd: a.cwd, agentsById });
      if (aResolved.isOrphan) continue;
      if (aResolved.teamId.toLowerCase() !== wantTeamId || aResolved.laneId.toLowerCase() !== wantLane) continue;
      if (effectiveAgentRole(a) !== "lead") continue;
      leadCandidates.push(a);
    }
    if (leadCandidates.length > 0) {
      const { winner } = resolveLeadWinner(leadCandidates);
      const lead = winner;
      const { tokens, tokensLabel } = extractAgentTokens(lead);
      const title = String(lead.title ?? lead.name ?? lead.id).trim();
      const status = lead.lost ? "lost" : String(lead.status ?? "unknown").trim();
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

/**
 * Main checkout for `dir`: parent of `git rev-parse --git-common-dir`. For a linked worktree this is the
 * primary checkout, not the worktree itself. Falls back to `dir` when git fails or `dir` is not a repo.
 */
export function resolveMainCheckout(dir) {
  const start = path.resolve(dir);
  try {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: start, encoding: "utf8" });
    const out = r.status === 0 ? String(r.stdout || "").trim() : "";
    if (out && path.basename(out) === ".git") return path.dirname(path.resolve(out));
  } catch {
    // fall through
  }
  return start;
}

export function installVsShim({ binDirs, targetScript, baseHome, force = false } = {}) {
  const resolvedBaseHome = path.resolve(
    baseHome || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"),
  );
  const ownRoot = path.resolve(import.meta.dirname, "..");
  // A linked worktree must never be pinned into a shim: point at the main checkout instead (--force opts out).
  const mainRoot = resolveMainCheckout(ownRoot);
  const inLinkedWorktree = path.resolve(mainRoot) !== ownRoot;
  const repoRoot = inLinkedWorktree && !force ? mainRoot : ownRoot;
  const runtimeDir = path.join(resolvedBaseHome, "runtime");
  // The default global shim is the machine's `vs`: a linked worktree (a unit branch) must not rewrite it.
  if (inLinkedWorktree && !force && !(Array.isArray(binDirs) && binDirs.length)) {
    throw new Error(`refusing to write the default global shim from a linked worktree (${ownRoot}); run install-shim from the main checkout (${mainRoot}), or pass --bin-dir <dir> or --force`);
  }
  // Default global bin dirs must not get a fallback runtime that lives under the temp dir (test HOME leak).
  if (!(Array.isArray(binDirs) && binDirs.length) && !force) {
    const rel = path.relative(path.resolve(os.tmpdir()), runtimeDir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      throw new Error(`refusing to write the default global shim with a runtime under the temp dir (${runtimeDir}); pass --bin-dir <dir> or --force`);
    }
  }

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
    "scripts/restart-runtime.mjs", // `vs restart` launches it from beside cli/
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
  const mainRepoScript = path.join(mainRoot, "cli", "vs.mjs");
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
  // Remove placeholder "(none recorded yet)" or "None." if present in this section
  for (let i = endIdx - 1; i > headIdx; i--) {
    if (/^[-*]\s+\(?(?:none|nothing)(?: recorded)?(?: yet)?\)?\.?$/i.test(lines[i].trim())) {
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

function loadPinTeamsSnapshot(flags) {
  const file = resolveTeamsFilePath();
  const revision = String(flags?.revision ?? flags?.base ?? process.env.VS_TEAMS_REVISION ?? teamsRevision(file));
  const { value: cur } = readJsonFileWithBom(file, { fallback: null, label: "teams.json" });
  const prevDoc = Array.isArray(cur?.teams) ? structuredClone(cur) : null;
  const doc = prevDoc ? structuredClone(prevDoc) : structuredClone(TEAMS_FILE);
  return { file, revision, prevDoc, doc };
}

function findSquadInDoc(doc, value) {
  if (!value) return null;
  const needle = String(value).toLowerCase();
  return (
    (doc.teams ?? []).find((t) => String(t.id).toLowerCase() === needle || String(t.name).toLowerCase() === needle) ??
    findTeamDef(value)
  );
}

function savePinTeams(doc, revision, flags, { prevDoc = null, writeBrief } = {}) {
  if (typeof flags?.beforeWrite === "function") flags.beforeWrite();
  const res = writeTeamsRegistry({ ...doc, teams: doc.teams, revision });
  if (res.status === 409) {
    process.stderr.write(
      `Error: teams.json changed (stale revision ${revision}, current ${res.body?.revision ?? "unknown"}); re-read teams.json and retry.\n`,
    );
    return { ok: false, status: 409, revision: res.body?.revision };
  }
  let written;
  if (typeof writeBrief === "function") {
    try {
      written = writeBrief();
    } catch (err) {
      if (prevDoc && Array.isArray(prevDoc.teams)) {
        try {
          writeTeamsRegistry({ ...prevDoc, teams: prevDoc.teams, revision: res.body?.revision });
        } catch {}
      }
      throw err;
    }
  }
  return { ok: true, status: res.status, file: res.file, revision: res.body?.revision, written };
}

export function commandPinMerge(flags) {
  const fromRaw = String(flags._[0] ?? "").trim();
  const intoRaw = String(flags._[1] ?? "").trim();
  if (!fromRaw || !intoRaw) {
    throw new Error('usage: vs pin merge <from-lane> <into-lane> [--note "<shared contract>"] [--team <squad>]');
  }
  const note = String(flags.note ?? flags.brief ?? "").trim();
  const { file, revision, prevDoc, doc } = loadPinTeamsSnapshot(flags);
  const identity = resolveIdentity({ ...flags, lane: undefined });
  const squadDef = findSquadInDoc(doc, flags.team ? String(flags.team) : identity.team.id) ?? findSquadInDoc(doc, identity.team.name);
  if (!squadDef) throw new Error(`unknown squad "${flags.team ?? identity.team.name}". Pass --team <squad>.`);

  const target = doc.teams.find((t) => t.id === squadDef.id);
  if (!target) throw new Error(`squad "${squadDef.id}" is not in ${file}`);

  const lanes = target.lanes ?? [];
  const fromLane = matchLaneRef(lanes, fromRaw);
  const intoLane = matchLaneRef(lanes, intoRaw);
  if (!fromLane) throw new Error(`unknown source lane "${fromRaw}" in ${squadDef.name}`);
  if (!intoLane) throw new Error(`unknown target lane "${intoRaw}" in ${squadDef.name}`);
  if (fromLane.id === intoLane.id) throw new Error("source and target lanes must be different");

  const briefRoot = process.env.VIBESQUAD_ROOT ? path.resolve(process.env.VIBESQUAD_ROOT) : undefined;
  const fromBrief = readBrainstormSummary(fromLane.id, briefRoot, { teamId: squadDef.id }).content;
  const intoSummary = readBrainstormSummary(intoLane.id, briefRoot, { teamId: squadDef.id });
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

  const nowIso = new Date().toISOString();
  const existingAliases = Array.isArray(intoLane.aliases) ? intoLane.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
  const seenAliases = new Set([
    String(intoLane.id ?? "").toLowerCase(),
    ...(intoLane.code ? [String(intoLane.code).toLowerCase()] : []),
    ...existingAliases.map((a) => a.toLowerCase()),
  ]);
  const mergedAliases = [...existingAliases];
  for (const rawAlias of [
    fromLane.id,
    fromLane.code ? String(fromLane.code).toLowerCase() : null,
    ...(fromLane.aliases ?? []),
  ]) {
    const cleanAlias = String(rawAlias ?? "").trim();
    if (!cleanAlias) continue;
    const key = cleanAlias.toLowerCase();
    if (seenAliases.has(key)) continue;
    seenAliases.add(key);
    mergedAliases.push(cleanAlias);
  }
  target.lanes = lanes.map((l) => {
    if (l.id === fromLane.id) {
      const { doneAt, ...rest } = l;
      return { ...rest, state: "removed", removedAt: nowIso };
    }
    if (l.id === intoLane.id && mergedAliases.length > 0) {
      return { ...l, aliases: mergedAliases };
    }
    return l;
  });
  const saved = savePinTeams(doc, revision, flags, {
    prevDoc,
    writeBrief: () => writeBrainstormSummary(intoLane.id, merged, briefRoot, { teamId: squadDef.id }),
  });
  if (!saved.ok) return 1;
  const written = saved.written;

  const logEntry = {
    ts: nowIso,
    agent: identity.agent || "RiffBot",
    lane: intoLane.id,
    type: "decision",
    text: `Merged ${fromLane.name || fromLane.id} (${fromLane.id}) -> ${intoLane.name || intoLane.id} (${intoLane.id})${note ? `: ${note}` : ""}`.slice(0, MAX_TEXT),
    refs: [fromLane.id, intoLane.id, written.path],
  };
  const homeDir = path.resolve(process.env.VIBESQUAD_HOME || BASE_DIR);
  appendLog({ ...identity, team: squadDef, lane: intoLane.id, teamDir: path.join(homeDir, "teams", squadDef.id) }, logEntry);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, squad: squadDef.id, from: fromLane.id, into: intoLane.id, brief: written.path, revision: saved.revision }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `Merged ${fromLane.name} (${fromLane.id}) into ${intoLane.name} (${intoLane.id}). Updated ${written.path} and marked ${fromLane.id} removed.\n`,
  );
  return 0;
}

export function commandPin(flags) {
  const sub = String(flags._.shift() ?? "").toLowerCase();
  if (sub === "merge") return commandPinMerge(flags);
  if (sub !== "new") throw new Error('usage: vs pin new "<name>" --brief "<idea>" [--team <squad>] [--force] | vs pin merge <from-lane> <into-lane> [--note "<contract>"]');
  const name = flags._.join(" ").trim();
  if (!name) throw new Error('pin new needs a name: vs pin new "<name>" --brief "<idea>"');
  const brief = String(flags.brief ?? "").trim() || name;

  const { file, revision, prevDoc, doc } = loadPinTeamsSnapshot(flags);
  const identity = resolveIdentity({ ...flags, lane: undefined });
  const squadDef = findSquadInDoc(doc, flags.team ? String(flags.team) : identity.team.id) ?? findSquadInDoc(doc, identity.team.name);
  if (!squadDef) throw new Error(`unknown squad "${flags.team ?? identity.team.name}". Pass --team <squad>.`);
  const target = doc.teams.find((t) => t.id === squadDef.id);
  if (!target) throw new Error(`squad "${squadDef.id}" is not in ${file}`);
  const lanes = target.lanes ?? [];

  // Done and removed teams never count as a match; --force skips the refusal entirely (ids still dedupe below).
  const live = lanes.filter((l) => l.state !== "done" && l.state !== "removed");
  const same = live.find((l) => String(l.name).toLowerCase() === name.toLowerCase() || l.id === slugLaneId(name));
  const hit = flags.force ? null : same ? { lane: same } : bestOverlap(`${name}
${brief}`, live);
  if (hit) {
    process.stderr.write(`Sounds like ${hit.lane.name} (${hit.lane.id}) in ${squadDef.name}. Use that Team${same ? "" : ", or re-run with --force to pin a new one"}.\n`);
    return 1;
  }

  const briefRoot = process.env.VIBESQUAD_ROOT ? path.resolve(process.env.VIBESQUAD_ROOT) : undefined;
  const slug = slugLaneId(name);
  const reopenTarget = lanes.find(
    (l) =>
      (l.state === "done" || l.state === "removed") &&
      (String(l.name ?? "").toLowerCase() === name.toLowerCase() || String(l.id).toLowerCase() === slug),
  );
  if (reopenTarget) {
    const curSummary = readBrainstormSummary(reopenTarget.id, briefRoot, { teamId: squadDef.id });
    const updatedBrief = curSummary.content.includes("## Open")
      ? appendBulletsToSection(curSummary.content, "Open", [`- ${brief.replace(/\r?\n/g, "\n  ")}`])
      : newPinBrief(reopenTarget.id, name, brief);
    target.lanes = freezeLaneCodes(
      (target.lanes ?? []).map((l) => {
        if (l.id !== reopenTarget.id) return l;
        const { doneAt, removedAt, ...rest } = l;
        return { ...rest, name, state: "pinned" };
      }),
    );
    const saved = savePinTeams(doc, revision, flags, {
      prevDoc,
      writeBrief: () => writeBrainstormSummary(reopenTarget.id, updatedBrief, briefRoot, { teamId: squadDef.id }),
    });
    if (!saved.ok) return 1;
    const written = saved.written;

    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, squad: squadDef.id, laneId: reopenTarget.id, name, brief: written.path, teamsFile: saved.file, revision: saved.revision }, null, 2) + "\n",
      );
      return 0;
    }
    process.stdout.write(
      `Pinned ${name} (${reopenTarget.id}) in ${squadDef.name}. Brief: ${written.path}. No agent started; the first click on the pin starts its Brainstorm.\n`,
    );
    return 0;
  }

  const taken = new Set(takenLaneIds((doc.teams ?? []).flatMap((t) => t.lanes ?? [])));
  let id = uniqueLaneId(slugLaneId(name), taken);
  // Lane ids and brief files are global: skip ids that still have a brief on disk.
  while (fs.existsSync(readBrainstormSummary(id, briefRoot, { teamId: squadDef.id }).fullPath)) {
    taken.add(id);
    id = uniqueLaneId(slugLaneId(name), taken);
  }

  // Freeze: persist generated codes on every lane of the Squad that lacks one, plus the new lane's.
  target.lanes = freezeLaneCodes([...freezeLaneCodes(target.lanes ?? []), { id, name, state: "pinned" }]);
  const saved = savePinTeams(doc, revision, flags, {
    prevDoc,
    writeBrief: () => writeBrainstormSummary(id, newPinBrief(id, name, brief), briefRoot, { teamId: squadDef.id }),
  });
  if (!saved.ok) return 1;
  const written = saved.written;

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, squad: squadDef.id, laneId: id, name, brief: written.path, teamsFile: saved.file, revision: saved.revision }, null, 2) + "\n");
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

/** vs wait <agent> [--timeout s]: waits on the runner (waitForFinish). Injectable client for tests. */
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
  const backend = getBackend(createAgentClient());
  try {
    await backend.connect();
    const { code, line } = await runWait(backend, agentId, timeoutSec);
    process.stdout.write(line + "\n");
    return code;
  } finally {
    await Promise.resolve(backend.close?.()).catch(() => {});
  }
}

// vs spawn / send / status / ls / logs / inspect / stop / archive / lead share server/mcp/tools.mjs + backend with the VS MCP server. Injectable ctx for tests.
export async function runAgentVerb(verb, flags, ctx) {
  const id = String(flags._[0] ?? "").trim();
  if (verb === "stop" || verb === "archive") {
    if (!id || flags._.length > 1) throw new Error(`usage: vs ${verb} <agent>`);
  }
  if (verb === "inspect") {
    if (!id || flags._.length > 1) throw new Error("usage: vs inspect <agent>");
    const res = await ctx.withBackend({ id }, (b) => (b.fetchAgent ?? b.getAgent).call(b, id));
    return res?.agent ?? res;
  }
  if (verb === "logs") {
    if (!id || flags._.length > 1) throw new Error("usage: vs logs <agent> [--limit <N>]");
    let limit;
    if (flags.limit !== undefined) {
      limit = Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer (got "${flags.limit}")`);
    }
    const opts = { direction: "tail", ...(limit ? { limit } : {}) };
    const res = await ctx.withBackend({ id }, (b) => (b.fetchAgentTimeline ?? b.getAgentTimeline).call(b, id, opts));
    const entries = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : [];
    return { ...(res && typeof res === "object" && !Array.isArray(res) ? res : {}), id, entries };
  }
  if (verb === "archive") {
    const res = await ctx.withBackend({ id }, (b) => b.archiveAgent(id));
    return { id, archived: true, ...(res?.archivedAt ? { archivedAt: res.archivedAt } : {}) };
  }
  let args;
  if (verb === "spawn") {
    args = {
      title: flags.title,
      profile: flags.profile,
      prompt: flags.prompt ?? flags._.join(" "),
      ...(flags.cwd ? { cwd: path.resolve(String(flags.cwd)) } : {}),
      ...(flags.stakes !== undefined ? { stakes: String(flags.stakes) } : {}),
    };
  } else if (verb === "handoff_lead") {
    args = { ...(flags.lane ? { lane: String(flags.lane) } : {}), ...(flags.steer ? { steer: String(flags.steer) } : {}), ...(flags.force ? { force: true } : {}) };
  } else if (verb === "restart_buddy") {
    args = { lane: String(flags.lane), ...(flags.reason ? { reason: String(flags.reason) } : {}), ...(flags.profile ? { profile: String(flags.profile) } : {}), ...(flags.provider ? { provider: String(flags.provider) } : {}) };
  } else if (verb === "watch") {
    args = { action: flags.watchAction };
    if (flags.watchAction === "add") {
      args.agents = [...new Set(flags._.map((s) => String(s).trim()).filter(Boolean))];
      if (flags.suite) args.suite = true;
      if (flags.restart) args.restart = true;
      if (flags.stall !== undefined) args.stallMin = flags.stall;
      if (flags.owner !== undefined) args.owner = String(flags.owner);
    } else if (flags.watchAction === "cancel") {
      args.id = String(flags._[0] ?? "").trim();
    }
  } else if (verb === "send") {
    args = { id, text: flags._.slice(1).join(" ") };
  } else if (verb === "ls") {
    args = {};
  } else {
    args = { id };
  }
  const tool = verb === "spawn" ? "spawn_worker" : verb === "ls" ? "list" : verb === "stop" ? "cancel" : verb;
  return callTool(ctx, tool, args);
}

// Long text must not ride on argv (Windows caps a command line at 32,767 chars): --prompt-file <path>, or "-" /
// --prompt-file - for stdin. Fills flags.prompt (spawn) or the text positional (send) in place.
export function loadPromptInput(verb, flags, readStdin = () => fs.readFileSync(0, "utf8")) {
  if (verb !== "spawn" && verb !== "send") return flags;
  let text;
  if (flags.promptFile !== undefined) {
    const src = String(flags.promptFile);
    text = src === "-" ? readStdin() : fs.readFileSync(path.resolve(src), "utf8");
  } else if (verb === "spawn" && flags.prompt === "-") {
    text = readStdin();
  } else if (verb === "spawn" && flags.prompt === undefined && flags._.length === 1 && flags._[0] === "-") {
    text = readStdin();
  } else if (verb === "send" && flags._.length === 2 && flags._[1] === "-") {
    text = readStdin();
  }
  if (text === undefined) return flags;
  if (!text.trim()) throw new Error("prompt input is empty");
  if (verb === "spawn") {
    flags.prompt = text;
    flags._ = [];
  } else {
    flags._ = [flags._[0], text];
  }
  return flags;
}

// B3 (lean boot): one-time sweep of long-done workers over the running server's runner route (the hook host lives there).
export async function requestWorkerSweep({ apply = false, port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(BASE_DIR), fetchImpl = fetch } = {}) {
  const token = readLocalToken(file);
  if (!token) throw new Error(`no local token at ${file}; start the VibeSquad server once to create it`);
  const res = await fetchImpl(`http://127.0.0.1:${port}/__vibesquad/runner/sweep`, {
    method: "POST",
    headers: { [LOCAL_TOKEN_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify({ apply }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sweep refused (${res.status}): ${body?.error ?? "is the server running this version?"}`);
  return body;
}

export async function commandAgentVerb(verb, flags, makeContext = createContext, out = (s) => process.stdout.write(s), readStdin) {
  if (verb === "archive" && flags.sweep) {
    if (flags._.length) throw new Error("usage: vs archive --sweep [--apply]");
    const report = await requestWorkerSweep({ apply: Boolean(flags.apply) });
    out(JSON.stringify(report, null, 2) + "\n");
    if (report?.busy) process.stderr.write("Warning: the 5-min sweep is running right now; nothing was evaluated. Retry in a moment.\n");
    else if (report?.truncated) process.stderr.write("Warning: truncated: the agent list hit the 200 cap, so more agents exist than this report covers.\n");
    return 0;
  }
  loadPromptInput(verb, flags, readStdin);
  if (verb === "lead") {
    if (flags._.shift() !== "handoff") throw new Error("usage: vs lead handoff [--lane <code>] [--steer \"<note>\"]");
    verb = "handoff_lead";
  }
  if (verb === "buddy") {
    if (flags._.shift() !== "restart" || !flags.lane || flags._.length) throw new Error('usage: vs buddy restart --lane <code> [--reason "<why>"] [--profile "<Brainstorm profile>" | --provider claude|gemini]');
    verb = "restart_buddy";
  }
  if (verb === "watch") {
    let sub = String(flags._.shift() ?? "").toLowerCase();
    if (sub === "ls") sub = "list";
    if (sub !== "add" && sub !== "list" && sub !== "cancel") {
      throw new Error("usage: vs watch add <agent...> [--suite] [--restart] [--stall <min>] | vs watch list | vs watch cancel <id>");
    }
    flags.watchAction = sub;
  }
  if (verb === "spawn" && (!flags.profile || !(flags.prompt ?? flags._.length))) {
    throw new Error('usage: vs spawn --title "<t>" --profile "<profile>" --prompt "<text>" | --prompt-file <path|-> [--cwd <dir>] [--stakes <v>]');
  }
  if (verb === "send" && (!flags._[0] || flags._.length < 2)) throw new Error('usage: vs send <agent> "<text>" | --prompt-file <path|->');
  if (verb === "status" && !flags._[0]) throw new Error("usage: vs status <agent>");
  if ((verb === "inspect" || verb === "stop" || verb === "archive") && (!String(flags._[0] ?? "").trim() || flags._.length > 1)) {
    throw new Error(`usage: vs ${verb} <agent>`);
  }
  if (verb === "logs" && (!String(flags._[0] ?? "").trim() || flags._.length > 1)) {
    throw new Error("usage: vs logs <agent> [--limit <N>]");
  }
  if (verb === "watch") {
    if (flags.watchAction === "add") {
      if (!flags._.length && !flags.suite && !flags.restart) throw new Error("vs watch add needs at least one agent, --suite or --restart");
      for (const a of flags._) {
        const ref = String(a).trim();
        if (ref && !isRunnerId(ref)) throw new Error(`watch agents must be runner ids (rn-...), got "${ref}"`);
      }
      if (flags.stall !== undefined) {
        const stall = Number(flags.stall);
        if (!Number.isFinite(stall) || stall <= 0) throw new Error("--stall must be a positive number of minutes");
      }
    } else if (flags.watchAction === "cancel" && (!String(flags._[0] ?? "").trim() || flags._.length > 1)) {
      throw new Error("usage: vs watch cancel <id>");
    }
  }
  // handoff_lead / spawn: --lane (for handoff_lead) names only the TARGET lane (runAgentVerb reads it); the caller's
  // identity comes from VS_AGENT_ID -> its record labels / VS_* env, never from --agent/--role/--team/--lane/--ord.
  if (verb === "spawn" && (flags.agent || flags.role || flags.team || flags.lane || flags.ord)) {
    process.stderr.write("Warning: vs spawn ignores --agent/--role/--team/--lane/--ord; caller identity comes from VS_AGENT_ID.\n");
  }
  const { agent: _a, role: _r, team: _t, lane: _l, ord: _o, ...callerFlags } = flags;
  const identity =
    verb === "handoff_lead" || verb === "spawn" || verb === "restart_buddy" || verb === "watch"
      ? resolveIdentity(callerFlags, { recordWins: true })
      : resolveIdentity(flags);
  const lane = verb === "ls" && identity.lane === UNASSIGNED_LANE && !flags.lane && !process.env.VS_LANE ? "" : identity.lane;
  const ctx = makeContext({
    identity: { agentId: identity.agentId, team: identity.team.id, lane, role: identity.role },
  });
  const result = await runAgentVerb(verb, flags, ctx);
  out(JSON.stringify(result, null, 2) + "\n");
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
    for (const m of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+\.(?:mjs|js|cjs|ts))["']/g)) {
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
    // The plugin imports the server package by name: @vibesquad/server/x.mjs -> server/x.mjs.
    for (const m of text.matchAll(/(?:from\s+|import\(\s*)["']@vibesquad\/server\/([^"']+\.(?:mjs|js|cjs|ts))["']/g)) walk(path.posix.join("server", m[1]));
  };
  walk("cli/vs.mjs");
  // The MCP server is spawned by path (not imported) and loads these lazily.
  for (const entry of ["server/mcp/server.mjs", "server/backend/index.mjs"]) walk(entry);
  return [...seen];
}

function commandInstallShim(flags) {
  const binDirs = flags.binDir ? [path.resolve(String(flags.binDir))] : undefined;
  const res = installVsShim({ binDirs, baseHome: BASE_DIR, force: Boolean(flags.force) });
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
// vs pair / vs devices — headless pairing + lost-phone revocation (PLAN_ANDROID_END_STATE.md E4a)
// Both need the local filesystem: `vs pair` sends ~/.vibesquad/local-token to the running server's loopback
// listener (the same POST /__vibesquad/pair/start the desktop dialog uses; codes live in that process), and
// `vs devices` edits ~/.vibesquad/devices.json through auth.mjs's own revoke path (the server re-reads it).
// ---------------------------------------------------------------------------

/** The text `vs pair` prints: link, code, CA fingerprint, QR. Pure, for tests. */
export function formatPairOutput(p, qr = "", { port = 4180 } = {}) {
  const lines = [];
  const code = String(p.code ?? "");
  lines.push(`Pairing code:   ${code.slice(0, 3)} ${code.slice(3)}   (expires ${p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString() : "in 5 min"})`);
  lines.push(`Pairing link:   ${p.pairUrl}`);
  if (p.lanPairUrl && p.lanPairUrl !== p.pairUrl) lines.push(`LAN link:       ${p.lanPairUrl}`);
  if (p.pairIpUrl && p.pairIpUrl !== p.pairUrl && p.pairIpUrl !== p.lanPairUrl) lines.push(`IP link:        ${p.pairIpUrl}`);
  lines.push(`CA fingerprint: ${p.caFingerprint?.full || p.caFingerprint?.short || "(no CA yet)"}`);
  if (p.hostId) lines.push(`Host id:        ${p.hostId}`);
  if (p.caHttpUrl) lines.push(`CA download:    ${p.caHttpUrl}`);
  if (p.androidApkAvailable && p.androidApkHttpUrl) lines.push(`Android APK:    ${p.androidApkHttpUrl}`);
  lines.push("");
  lines.push("Scan with the VibeSquad app (or open the link and type the code), then install the CA if asked.");
  lines.push(`Paired devices: vs devices list   ·   lost phone: vs devices revoke <id|--all>   (port ${port})`);
  return lines.join("\n") + "\n" + (qr ? "\n" + qr : "");
}

/** Mints a code on the running local server. Throws when the server is down or has no LAN/Meshnet address. */
export async function requestPairStart({ port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(BASE_DIR), fetchImpl = fetch } = {}) {
  const token = readLocalToken(file);
  if (!token) throw new Error(`no local token at ${file}; start the VibeSquad server once to create it`);
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/__vibesquad/pair/start`, {
      method: "POST",
      headers: { [LOCAL_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`no VibeSquad server on 127.0.0.1:${port} (${e?.cause?.code ?? e?.name ?? e}); start it first (or set VIBESQUAD_PORT)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`pairing refused (${res.status}): ${body?.error ?? "is the server running this version?"}`);
  if (typeof body?.code !== "string" || typeof body?.pairUrl !== "string") throw new Error("unexpected pair/start response");
  return body;
}

async function commandPair(flags) {
  if (flags._.length) throw new Error("usage: vs pair [--json]");
  const port = Number(process.env.VIBESQUAD_PORT || 4180);
  const p = await requestPairStart({ port });
  // Never echo the SVGs; the terminal gets its own rendering of the same link.
  const { qrSvg: _svg, qrSvgIp: _svgIp, lanQrSvg: _svgLan, ...plain } = p;
  if (flags.json) {
    process.stdout.write(JSON.stringify(plain, null, 2) + "\n");
    return 0;
  }
  const { qrTerminal } = await import("../server/qr.mjs");
  const qr = await qrTerminal(p.pairUrl).catch(() => "");
  process.stdout.write(formatPairOutput(plain, qr, { port }));
  return 0;
}

const DEVICES_USAGE = "usage: vs devices list [--json] | vs devices revoke <id|--all>";

/** `vs devices …` argv with `--all` folded into a positional, so the shared parser (which rejects unknown flags) stays untouched. */
export function foldDevicesArgv(argv) {
  return argv[0] === "devices" ? argv.map((a) => (a === "--all" ? "all" : a)) : argv;
}

function formatDeviceLine(d) {
  const seen = d.lastSeenAt ? d.lastSeenAt.replace("T", " ").slice(0, 16) : "never";
  return `${d.id}  ${String(d.name ?? "").padEnd(24).slice(0, 24)}  paired ${String(d.createdAt ?? "").slice(0, 10)}  seen ${seen}`;
}

async function commandDevices(flags) {
  const sub = String(flags._.shift() ?? "");
  const auth = await import("../server/auth.mjs");
  if (sub === "list" || sub === "ls" || sub === "") {
    if (flags._.length) throw new Error(DEVICES_USAGE);
    const devices = auth.listDevices();
    if (flags.json) {
      process.stdout.write(JSON.stringify({ devices }, null, 2) + "\n");
      return 0;
    }
    if (!devices.length) {
      process.stdout.write("No paired devices. Pair one with: vs pair\n");
      return 0;
    }
    process.stdout.write(devices.map(formatDeviceLine).join("\n") + "\n");
    return 0;
  }
  if (sub === "revoke") {
    const target = String(flags._.shift() ?? "");
    if (!target || flags._.length) throw new Error(DEVICES_USAGE);
    if (target === "all") {
      const n = auth.revokeAllDevices();
      process.stdout.write(n ? `Revoked ${n} device${n === 1 ? "" : "s"}; their next request is refused.\n` : "No paired devices to revoke.\n");
      return 0;
    }
    const known = auth.listDevices();
    // A unique id prefix is enough (ids are UUIDs; typing one over SSH is the common case).
    const matches = known.filter((d) => d.id === target || (target.length >= 8 && d.id.startsWith(target)));
    if (!matches.length) throw new Error(`no paired device matches "${target}" (vs devices list)`);
    if (matches.length > 1) throw new Error(`"${target}" matches ${matches.length} devices; give more of the id`);
    if (!auth.revokeDevice(matches[0].id)) throw new Error(`no paired device matches "${target}" (vs devices list)`);
    process.stdout.write(`Revoked ${matches[0].id} (${matches[0].name}); its next request is refused.\n`);
    return 0;
  }
  throw new Error(DEVICES_USAGE);
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
  return readLiveCapDoc({ cappedProvidersPath: cappedProvidersFile() });
}

// ---------------------------------------------------------------------------
// vs mcp alias-report: the VS MCP logs every Paseo-name alias hit as a metric
// ("mcp-alias: tool=<name> caller=<id> lane=<lane>"). Group them so the 7-day zero-hit removal check is one command.
// ---------------------------------------------------------------------------

const ALIAS_HIT_RE = /^mcp-alias:\s+tool=(\S+)\s+caller=(\S+)(?:\s+lane=(\S+))?/;

export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(String(text).trim());
  if (!m) throw new Error(`--since must look like 30m, 12h or 7d (got "${text}")`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
}

/** Groups alias-hit metric entries by alias + caller. An entry is mirrored into a lane log and a team log; identical ts+agent+text counts once. */
export function aliasReport(entries, { sinceMs, now = Date.now() } = {}) {
  const seen = new Set();
  const groups = new Map();
  for (const e of entries) {
    if (e?.type !== "metric") continue;
    const m = ALIAS_HIT_RE.exec(String(e.text ?? ""));
    if (!m) continue;
    const t = Date.parse(e.ts);
    if (sinceMs !== undefined && !(t >= now - sinceMs)) continue;
    const dedupe = `${e.ts}|${e.agent}|${e.text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const [, alias, caller, lane] = m;
    const key = `${alias}\u0000${caller}`;
    const g = groups.get(key) ?? { alias, caller, lane: lane ?? "unknown", hits: 0, lastSeen: e.ts };
    g.hits += 1;
    if (t > Date.parse(g.lastSeen)) {
      g.lastSeen = e.ts;
      g.lane = lane ?? g.lane;
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.hits - a.hits || a.alias.localeCompare(b.alias) || a.caller.localeCompare(b.caller));
}

function readAllTeamLogs() {
  const out = [];
  const teamsDir = path.join(BASE_DIR, "teams");
  let dirs = [];
  try {
    dirs = fs.readdirSync(teamsDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let raw = "";
    try {
      raw = stripBom(fs.readFileSync(path.join(teamsDir, d, "log.jsonl"), "utf8"));
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(stripBom(line)));
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

function commandMcp(flags) {
  if (String(flags._[0] ?? "") !== "alias-report") throw new Error("usage: vs mcp alias-report [--since <dur>] [--json]");
  const sinceMs = flags.since !== undefined ? parseDuration(flags.since) : undefined;
  const rows = aliasReport(readAllTeamLogs(), { sinceMs });
  const total = rows.reduce((n, r) => n + r.hits, 0);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ since: flags.since ?? null, total, groups: rows }, null, 2) + "\n");
    return 0;
  }
  const window = flags.since ? `last ${flags.since}` : "all time";
  if (!rows.length) {
    process.stdout.write(`No Paseo-name alias hits (${window}).\n`);
    return 0;
  }
  process.stdout.write(`Paseo-name alias hits (${window}): ${total}\n`);
  for (const r of rows) process.stdout.write(`${String(r.hits).padStart(5)}  ${r.alias.padEnd(18)} ${r.caller}  lane=${r.lane}  last=${r.lastSeen}\n`);
  return 0;
}

/** Who may restart the runtime: the owner's own shell (no runner agent id) or the Squad's hub lead (Overlord). Any other runner agent is refused. */
export function assertRestartCaller(identity, teams = TEAM_DEFS, env = process.env, readRecord = readRunnerAgentSync) {
  const id = String(env.VS_AGENT_ID || env.PASEO_AGENT_ID || "").trim();
  if (!id || !isRunnerId(id)) return;
  // Fail closed: identity comes only from the runner's own record of this agent id. A runner id with no record gets nothing from
  // VS_ROLE/VS_LANE/VS_TEAM env (spoofable), so it is refused.
  const rec = identity ? null : readRecord(id);
  if (!identity && !rec) throw new Error(`vs restart: ${id} has no runner record, so its role cannot be verified; refusing.`);
  const labels = rec?.labels ?? {};
  const who = identity ?? { role: String(labels.role ?? "").trim().toLowerCase(), team: { id: labels.team ?? "" }, lane: labels.lane || labels.lead || "" };
  const team = teams.find((t) => String(t.id).toLowerCase() === String(who.team?.id ?? "").toLowerCase());
  const lane = team ? findLaneInRegistry(who.lane, teams, team.id)?.lane : null;
  if (who.role !== "lead" || !team || !lane || !isHubLane(team, lane)) {
    throw new Error(`vs restart: ${id} is a ${who.role || "worker"}; restarting the runtime cuts every agent's turn, so only the owner or the Overlord (hub lead) may. Ask your lead.`);
  }
}

/** One launch arg may not carry a quote or control character: it is joined into a single Win32_Process.Create CommandLine. */
function assertSafeLaunchArg(a) {
  if (/["\p{Cc}]/u.test(String(a))) throw new Error(`vs restart: refusing a launch argument with a quote or control character: ${JSON.stringify(String(a))}`);
}

/**
 * vs restart: start scripts/restart-runtime.mjs detached and return at once. Every agent runs on the runner, so the script
 * must not be in the runner's process tree (the shutdown kills agent trees). On Windows it is created through WMI
 * (Win32_Process.Create: parented to the WMI service, hidden, and it does NOT inherit our env, so the relevant
 * VIBESQUAD_* values are passed as flags); elsewhere a detached child.
 */
export function commandRestart(flags, { spawnFn = null, identity = null, teams = TEAM_DEFS, env = process.env, readRecord = readRunnerAgentSync } = {}) {
  if (flags.timeout !== undefined && !/^[1-9]\d{0,6}$/.test(String(flags.timeout))) throw new Error("vs restart: --timeout must be a positive integer (seconds)");
  if (!flags.dryRun) assertRestartCaller(identity, teams, env, readRecord);
  const script = path.resolve(import.meta.dirname, "..", "scripts", "restart-runtime.mjs");
  if (!fs.existsSync(script)) throw new Error(`restart script not found: ${script}`);
  const vsHome = env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");
  const logFile = path.join(vsHome, "logs", `restart-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const args = [script, "--log", logFile];
  if (env.VIBESQUAD_HOME) args.push("--vs-home", vsHome, "--home", path.join(vsHome, "runner"), "--out-dir", vsHome);
  if (env.VIBESQUAD_DESKTOP_CONFIG_DIR?.trim()) args.push("--config-dir", env.VIBESQUAD_DESKTOP_CONFIG_DIR.trim());
  if (env.VIBESQUAD_PORT && /^\d+$/.test(env.VIBESQUAD_PORT)) args.push("--port", env.VIBESQUAD_PORT);
  if (flags.dryRun) args.push("--dry-run");
  if (flags.noForce) args.push("--no-force");
  if (flags.timeout) args.push("--wait-timeout", String(flags.timeout));
  for (const a of [process.execPath, ...args]) assertSafeLaunchArg(a);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (flags.dryRun) {
    const r = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
    process.stdout.write(r.stdout || "");
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status ?? 1;
  }
  let pid = null;
  if (spawnFn) pid = spawnFn(process.execPath, args);
  else if (process.platform === "win32") {
    const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
    const cmdline = [process.execPath, ...args].map((a) => `"${a}"`).join(" ");
    const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${q(cmdline)}; ProcessStartupInformation=$si}; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`could not launch the restart script detached: ${(r.stderr || r.stdout || "").trim()}`);
    pid = Number(String(r.stdout).trim());
  } else {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.unref();
    pid = child.pid;
  }
  process.stdout.write(`restart launched (pid ${pid}); it waits for the runner to go idle, then restarts runner + server.
log: ${logFile}
result: ${vsHome}/restart-<ts>.json (also check: vs restart --dry-run)
`);
  return 0;
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

  if (sub === "add" || sub === "set") {
    const provider = String(flags._[1] ?? "").trim().toLowerCase();
    if (!provider) throw new Error("cap add needs a provider: vs cap add <provider>");
    setProviderCapped(provider, true, {
      reason: "cli cap",
      cappedProvidersPath: cappedProvidersFile(),
      normalizeKey: false,
    });
    process.stdout.write(`capped ${provider}\n`);
    return 0;
  }

  if (sub === "clear") {
    const provider = String(flags._[1] ?? "").trim().toLowerCase();
    if (!provider) throw new Error("cap clear needs a provider: vs cap clear <provider>");
    setProviderCapped(provider, false, {
      cappedProvidersPath: cappedProvidersFile(),
      normalizeKey: false,
    });
    process.stdout.write(`cleared ${provider}\n`);
    return 0;
  }

  throw new Error(`unknown cap subcommand "${sub}". Use: vs cap list | add | clear`);
}

function defaultBaseRef(repoRoot) {
  for (const ref of ["master", "main"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], { cwd: repoRoot, encoding: "utf8" });
    if (r.status === 0) return ref;
  }
  return "HEAD";
}

function commandWorktree(flags) {
  const sub = String(flags._[0] ?? "root").toLowerCase();
  // Main checkout of the caller's cwd (so a worktree-pinned script still targets the real repo); outside a
  // repo, fall back to the main checkout of this script.
  const scriptRoot = path.resolve(import.meta.dirname, "..");
  const cwdRoot = resolveMainCheckout(process.cwd());
  const cwdIsRepo = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: process.cwd(), encoding: "utf8" }).status === 0;
  const repoRoot = cwdIsRepo ? cwdRoot : resolveMainCheckout(scriptRoot);
  const apply = Boolean(flags.apply);

  if (sub === "create" || sub === "add") {
    const branch = String(flags._[1] ?? flags.branch ?? "").trim();
    if (!branch) throw new Error("worktree create needs a branch: vs worktree create <branch>");
    // Base on master (or explicit --base), never the caller's HEAD.
    const baseRef = String(flags.base ?? "").trim() || defaultBaseRef(repoRoot);
    const res = createManagedWorktree(repoRoot, branch, { baseRef });
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

export const KNOWN_VERBS = [
  "whoami",
  "who",
  "profiles",
  "log",
  "handoff",
  "inbox",
  "pin",
  "spec",
  "task",
  "cap",
  "worktree",
  "lesson",
  "lessons",
  "wait",
  "watch",
  "spawn",
  "send",
  "status",
  "lead",
  "buddy",
  "restart",
  "ls",
  "logs",
  "inspect",
  "stop",
  "archive",
  "mcp",
  "install-shim",
  "open",
  "help",
];

const VERB_HINTS = {
  list: "ls",
  ps: "ls",
  run: "spawn",
  create: "spawn",
  start: "spawn",
  cancel: "stop",
  kill: "stop",
  rm: "archive",
  delete: "archive",
  close: "archive",
  tail: "logs",
  show: "inspect",
  get: "inspect",
  info: "inspect",
};

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

export function suggestVerb(raw, verbs = KNOWN_VERBS) {
  const needle = String(raw ?? "").trim().toLowerCase();
  if (!needle) return null;
  if (VERB_HINTS[needle] && verbs.includes(VERB_HINTS[needle])) return VERB_HINTS[needle];
  let best = null;
  let bestScore = Infinity;
  for (const v of verbs) {
    const cand = v.toLowerCase();
    if (cand === needle) return v;
    const d = editDistance(needle, cand);
    const maxDist = Math.max(2, Math.floor(Math.max(needle.length, cand.length) / 2));
    const prefixBonus = cand.startsWith(needle) || needle.startsWith(cand) ? 0.5 : 0;
    const score = d - prefixBonus;
    if (d <= maxDist && score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

export function main(argv) {
  let flags;
  try {
    flags = parseArgs(foldDevicesArgv(argv));
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
    if (command === "profiles") return commandProfiles(flags);
    if (command === "log") return commandLog(flags);
    if (command === "handoff") return commandHandoff(flags);
    if (command === "inbox") return commandInbox(flags);
    if (command === "pin") return commandPin(flags);
    if (command === "spec") return commandSpec(flags);
    if (command === "task") return commandTask(flags);
    if (command === "cap") return commandCap(flags);
    if (command === "restart") return commandRestart(flags);
    if (command === "worktree") return commandWorktree(flags);
    if (command === "lesson" || command === "lessons") return commandLesson(flags);
    if (command === "wait") return commandWait(flags);
    if (
      command === "spawn" ||
      command === "send" ||
      command === "status" ||
      command === "lead" ||
      command === "buddy" ||
      command === "watch" ||
      command === "ls" ||
      command === "logs" ||
      command === "inspect" ||
      command === "stop" ||
      command === "archive"
    ) {
      return commandAgentVerb(command, flags);
    }
    if (command === "mcp") return commandMcp(flags);
    if (command === "install-shim") return commandInstallShim(flags);
    if (command === "open") return commandOpen(flags);
    if (command === "pair") return commandPair(flags);
    if (command === "devices") return commandDevices(flags);
    const hint = suggestVerb(command);
    const didYouMean = hint ? `, did you mean "${hint}"?` : ".";
    process.stderr.write(`Error: unknown verb "${command}"${didYouMean} Try "vs --help".\n`);
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
