import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { handleRunnerApi } from "./runner-api.mjs";
import { forceRestartRunner, unstick } from "./unstick.mjs";
import { handleSchedulesApi } from "./schedules.mjs";
import { sharedRunnerBackend, isRunnerId, listRunnerAgentsSync, readRunnerAgentSync } from "./backend/index.mjs";
import { handleTerminalsApi, isTerminalsPath } from "./terminals-api.mjs";
import { handleGitApi, isGitPath } from "./git-api.mjs";
import { handleProvidersApi } from "./providers-catalog.mjs";
import { getStale, peekStale, readBuildStamp } from "./stale-runtime.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFirstRunStatus } from "./first-run.mjs";
import { resolveTeamsFilePath, resolveTeamsWritePath } from "./teams-file.mjs";
import { seedHubBriefs } from "./hub-seed.mjs";
import { resolveProjectPath } from "./brief-path.mjs";
import { contentRevision, createWindowLimiter } from "./write-guards.mjs";
import { ADE_GATED_READ_PATHS, isUnsafeRoot, handleFileList, handleFsList, handleFsMutation, handleFsWatch, handleFsRead, handleFsResolve, handleSearch } from "./file-search.mjs";
import { handleSecretInputRequest } from "./secret-input.mjs";
import {
  LEGACY_NEEDS_LABEL,
  LEGACY_USER_TYPE,
  clearConfigWarning,
  getConfigWarnings,
  loadUserSettings,
  parseJsonWithBom,
  readJsonFileWithBom,
  saveRemoteAccess,
  saveUserSettings,
  stripBom,
} from "./user-settings.mjs";
import { authenticate, getAuthStatus, handleCaCrt, handleDevices, handleLocalLogin, handleLocalLoginNonce, handlePairRedeem, handlePairStart, handleRevoke, hasDistIndex, isLocal, isLocalBrowserSafe, isLocalOwner, netConfig, READ_ONLY_ERROR } from "./auth.mjs";
import {
  appendVsLogEntry,
  createAgentClient,
  findExistingLaneBrainstorm,
  performBrainstormRestart,
  readBrainstormSummary,
  resetBrainstormRestartState,
  writeBrainstormSummary,
} from "./brainstorm.mjs";
import {
  addInboxCards,
  buildTopicBrainstormPrompt,
  buildTopicTitle,
  getInboxPath,
  handoffTopicBrainstorm,
  listInboxCards,
  openTopicBrainstorm,
  parkTopicBrainstorm,
  readInboxCards,
  sortIdeaCard,
  triageInboxCards,
  writeInboxCards,
} from "./inbox.mjs";
import {
  broadcastWebPush,
  buildVapidHeaders,
  decryptWebPushPayload,
  encryptWebPushPayload,
  evaluateAgentTransition,
  getOrCreateVapidKeys,
  getPushSubsPath,
  getVapidPath,
  readPushSubscriptions,
  removePushSubscription,
  restartPushWatcher,
  savePushSubscription,
  sendTestPush,
  sendWebPushToSubscription,
  startPushWatcher,
  stopPushWatcher,
  toBase64Url,
  fromBase64Url,
  writePushSubscriptions,
} from "./push.mjs";
import { removeTeamWorktrees, resolveManagedWorktreeRoot } from "./team-worktrees.mjs";
import { extractManagedWorktreeRepoName } from "./identity.mjs";
import {
  DEFAULT_PACK_PROFILES,
  DEFAULT_PROFILES,
  LEGACY_PROFILE_ALIASES,
  SHARED_NOTE_PREFIX,
  buildDefaultPackNotesMap,
  deriveRole,
  detectNoteWarnings,
  diffProfiles,
  findProfile,
  getPaseoConfigPath,
  getProfilesPath,
  importPaseoProfiles,
  loadProfiles,
  normalizeProfile,
  readPaseoConfig,
  saveProfiles,
  seedDefaultPack,
  syncProfilesToPaseo,
  toPaseoProfileShape,
  toPaseoSpawnConfig,
} from "./profiles.mjs";
import {
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  SOFT_FLAG_NUDGE,
  SOFT_FLAG_REASON,
  TAKEOVER_CONFIRM_INSTRUCTION,
  WRITE_HANDOFF_PROMPT,
  buildSuccessorPrompt,
  createLeadHandoffCoordinator,
  findOpenWorkersForLead,
  getHandoffPacketPath,
  leadUsedTokens,
  listDaemonAgents,
  loadLeadThresholds,
  parseLeadOrd,
  performLeadHandoffHttp,
  readLaneLogEntries,
  resolveLeadProfile,
  resolveTeamAndLane,
  synthesizeHandoffPacket,
} from "./lead-handoff.mjs";

export {
  appendVsLogEntry,
  createAgentClient,
  findExistingLaneBrainstorm,
  performBrainstormRestart,
  readBrainstormSummary,
  resetBrainstormRestartState,
  writeBrainstormSummary,
  addInboxCards,
  buildTopicBrainstormPrompt,
  buildTopicTitle,
  getInboxPath,
  handoffTopicBrainstorm,
  listInboxCards,
  openTopicBrainstorm,
  parkTopicBrainstorm,
  readInboxCards,
  sortIdeaCard,
  triageInboxCards,
  writeInboxCards,
  broadcastWebPush,
  buildVapidHeaders,
  decryptWebPushPayload,
  encryptWebPushPayload,
  evaluateAgentTransition,
  getOrCreateVapidKeys,
  getPushSubsPath,
  getVapidPath,
  readPushSubscriptions,
  removePushSubscription,
  restartPushWatcher,
  savePushSubscription,
  sendTestPush,
  sendWebPushToSubscription,
  startPushWatcher,
  stopPushWatcher,
  toBase64Url,
  fromBase64Url,
  writePushSubscriptions,
  DEFAULT_PACK_PROFILES,
  DEFAULT_PROFILES,
  LEGACY_PROFILE_ALIASES,
  SHARED_NOTE_PREFIX,
  buildDefaultPackNotesMap,
  deriveRole,
  detectNoteWarnings,
  diffProfiles,
  findProfile,
  getPaseoConfigPath,
  getProfilesPath,
  importPaseoProfiles,
  loadProfiles,
  normalizeProfile,
  readPaseoConfig,
  saveProfiles,
  seedDefaultPack,
  syncProfilesToPaseo,
  toPaseoProfileShape,
  toPaseoSpawnConfig,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  SOFT_FLAG_NUDGE,
  SOFT_FLAG_REASON,
  TAKEOVER_CONFIRM_INSTRUCTION,
  WRITE_HANDOFF_PROMPT,
  buildSuccessorPrompt,
  createLeadHandoffCoordinator,
  findOpenWorkersForLead,
  getHandoffPacketPath,
  leadUsedTokens,
  listDaemonAgents,
  loadLeadThresholds,
  parseLeadOrd,
  performLeadHandoffHttp,
  readLaneLogEntries,
  resolveLeadProfile,
  resolveTeamAndLane,
  synthesizeHandoffPacket,
};

const REPO_ROOT = resolve(import.meta.dirname, "..");

const TEAM_ID = /^[A-Za-z0-9_-]+$/;
const teamDir = (team) => join(process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "teams", team);
const LOG_TYPES = new Set(["done", "decision", "blocker", "needs-you", "handoff", "you", "metric", LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE]);
const UI_LOG_TYPES = new Set(["you", "needs-you", "handoff", "metric", "decision", LEGACY_USER_TYPE, LEGACY_NEEDS_LABEL]);

const MAX_BODY_BYTES = 1024 * 1024;
const RUNNER_INPUT_RE = /^\/__vibesquad\/runner\/agents\/[^/]+\/input$/;
const MAX_RUNNER_INPUT_BYTES = 24 * 1024 * 1024; // composer image attachments (base64) ride this one route
const AGENT_ID_STRICT = /^[A-Za-z0-9_-]{1,64}$/;
// Test/DI hooks and server-derived values that must never be taken from an HTTP body. `cwd` and `labels`
// are derived from the lane or the daemon's own agent record; the timing knobs would skip cooldowns.
export const INTERNAL_BODY_KEYS = [
  "baseHome", "profilesPath", "agentClient", "clientFactory", "oldAgent", "oldLead", "execSpawn", "teamsFilePath",
  "skipBackend", "agents", "cwd", "labels", "title", "forceNew", "cooldownMs", "emptyRetryMs", "backstopDelayMs",
];

export function sanitizeBody(body) {
  const out = { ...(body && typeof body === "object" ? body : {}) };
  for (const k of INTERNAL_BODY_KEYS) delete out[k];
  return out;
}

/** readBody + sanitizeBody: what every write handler that hands its body to a helper must use. */
const readCleanBody = async (req) => sanitizeBody(await readBody(req));

// Agent archives reachable over HTTP (brainstorm-restart, inbox park/handoff-topic) share one budget, so a
// loop over agent ids can't retire every Buddy at once.
export const ARCHIVE_BUDGET_PER_MIN = 10;
export const archiveBudget = createWindowLimiter({ max: ARCHIVE_BUDGET_PER_MIN });
const overArchiveBudget = (res) => {
  if (archiveBudget.take()) return false;
  sendJson(res, 429, { ok: false, error: `too many agent restarts/archives: ${ARCHIVE_BUDGET_PER_MIN} per minute` });
  return true;
};

// Agent spawns reachable over HTTP (brainstorm-restart start + restart) get their own budget, so a remote
// loop can't flood the host with Buddies even within the proxy's per-endpoint limit.
export const SPAWN_BUDGET_PER_MIN = 10;
export const spawnBudget = createWindowLimiter({ max: SPAWN_BUDGET_PER_MIN });
const overSpawnBudget = (res) => {
  if (spawnBudget.take()) return false;
  sendJson(res, 429, { ok: false, error: `too many agent spawns: ${SPAWN_BUDGET_PER_MIN} per minute` });
  return true;
};

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((ok, fail) => {
    let body = "";
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        fail(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      body += c;
    });
    req.on("end", () => {
      if (done) return;
      try {
        ok(parseJsonWithBom(body || "{}"));
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(JSON.stringify(data));
}

let exposure = { lanEnabled: false, exposedIps: [], toggleHandler: null };
export function setExposure(lanEnabled, exposedIps, toggleHandler = exposure.toggleHandler) {
  exposure = {
    lanEnabled: Boolean(lanEnabled),
    exposedIps: lanEnabled ? [...(exposedIps ?? [])] : [],
    toggleHandler: typeof toggleHandler === "function" ? toggleHandler : exposure.toggleHandler,
  };
}

// Trusted = may read. Owner = may also change things: a paired device, or a loopback caller with the local token.
const isTrusted = (req) => isLocalBrowserSafe(req) || Boolean(authenticate(req));
const isOwner = (req) => Boolean(authenticate(req)) || isLocalOwner(req);
const localAccess = (req) => (isOwner(req) ? "owner" : "read-only");

// GETs a read-only loopback caller still can't make: they hand out a credential, write a key, or launch provider CLIs.
export function isGatedRead(pathOrMethod, urlOrPath = "") {
  const path =
    typeof urlOrPath === "string" && urlOrPath.startsWith("/") && !String(pathOrMethod ?? "").startsWith("/")
      ? urlOrPath.split("?")[0]
      : pathOrMethod;
  const url =
    typeof urlOrPath === "string" && urlOrPath.startsWith("/") && !String(pathOrMethod ?? "").startsWith("/")
      ? urlOrPath
      : urlOrPath;
  if (path === "/__vibesquad/push/vapid-public-key") return true; // creates and writes vapid.json on first call
  if (path === "/__vibesquad/providers" || String(path).startsWith("/__vibesquad/providers/")) {
    return new URL(url, "http://x").searchParams.get("refresh") === "1"; // bypasses the probe TTL: spawns the provider CLIs
  }
  if (path === "/__vibesquad/local-image") return true; // file contents
  if (path === "/__vibesquad/schedules" || path.startsWith("/__vibesquad/schedules/")) return true; // prompts, target configs, run logs
  if (isTerminalsPath(path)) return true; // live shells and script logs
  if (isGitPath(path)) return true; // diffs are file contents (writes are owner-gated as non-GET)
  if (ADE_GATED_READ_PATHS.includes(path)) return true; // quick open / find in files: workspace file names and contents
  return false;
}

const READ_ONLY_CACHE_MS = 30_000;

/**
 * Ungated GETs that shell out (`--version`s): a read-only caller shares one in-flight run and
 * reuses its result for READ_ONLY_CACHE_MS, so it can't make the server spawn more than one process per route per
 * window. Owners always run fresh (and refresh the cache); `.clear()` drops it after an owner write.
 */
export function createReadOnlyCache(ttlMs = READ_ONLY_CACHE_MS, now = () => Date.now()) {
  const entries = new Map(); // key -> { at, promise }
  const cached = (key, owner, run) => {
    const hit = entries.get(key);
    if (!owner && hit && (hit.at === null || now() - hit.at < ttlMs)) return hit.promise;
    const entry = { at: null, promise: null };
    entry.promise = Promise.resolve()
      .then(run)
      .finally(() => {
        entry.at = now();
      });
    entries.set(key, entry);
    return entry.promise;
  };
  cached.clear = () => entries.clear();
  return cached;
}

/** WebPush endpoints are capability URLs (whoever has one can push to that device): only the push service origin leaves. */
export function redactPushEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function handleHealth(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const distReady = hasDistIndex(rootDir);
  if (!isTrusted(req)) return sendJson(res, distReady ? 200 : 503, { ok: distReady, distReady });
  const { port } = netConfig();
  const warnings = getConfigWarnings();
  const extra = {
    localAccess: localAccess(req),
    port,
    lanEnabled: exposure.lanEnabled,
    exposedIps: exposure.exposedIps,
    // Read-only callers (incl. the remote proxy) get the cached value: git + stale.json stay with the owner and startup.
    stale: isOwner(req) ? getStale({ rootDir }) : peekStale(),
    ...(warnings.length ? { configWarnings: warnings } : {}),
  };
  if (!distReady) return sendJson(res, 503, { ok: false, distReady: false, error: "dist/index.html missing", ...extra });
  return sendJson(res, 200, { ok: true, distReady: true, ...extra });
}

export function handleAuthStatus(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const full = getAuthStatus(rootDir);
  if (!isTrusted(req)) return sendJson(res, 200, { ok: true, distReady: full.distReady, caFingerprint: full.caFingerprint });
  return sendJson(res, 200, { ...full, localAccess: localAccess(req) });
}

/** Content hash of the registry file; a PUT that sends a stale one gets 409 instead of overwriting newer edits. */
export function teamsRevision(file) {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return "none";
  }
}

const MAX_TEAMS = 200;
const MAX_LANES = 500;
const MAX_PATHS = 64;
const MAX_PATH_LEN = 1024;

/** Throws on a teams array the registry can't safely hold (ids are slug-safe, paths are strings). */
export function validateTeamsBody(teams) {
  if (!Array.isArray(teams)) throw new Error("teams must be an array");
  if (teams.length > MAX_TEAMS) throw new Error("too many teams");
  const checkPaths = (obj, where) => {
    if (obj.paths !== undefined) {
      if (!Array.isArray(obj.paths) || obj.paths.length > MAX_PATHS) throw new Error(`${where}: paths must be an array of strings`);
      for (const p of obj.paths) if (typeof p !== "string" || p.length > MAX_PATH_LEN) throw new Error(`${where}: paths must be strings`);
    }
    if (obj.path != null && (typeof obj.path !== "string" || obj.path.length > MAX_PATH_LEN)) throw new Error(`${where}: path must be a string`);
  };
  for (const t of teams) {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("each team must be an object");
    if (typeof t.id !== "string" || !TEAM_ID.test(t.id)) throw new Error("bad team id");
    checkPaths(t, `team ${t.id}`);
    if (t.lanes === undefined) continue;
    if (!Array.isArray(t.lanes) || t.lanes.length > MAX_LANES) throw new Error(`team ${t.id}: lanes must be an array`);
    for (const l of t.lanes) {
      if (!l || typeof l !== "object" || Array.isArray(l)) throw new Error(`team ${t.id}: each lane must be an object`);
      if (typeof l.id !== "string" || !TEAM_ID.test(l.id)) throw new Error(`team ${t.id}: bad lane id`);
      checkPaths(l, `lane ${l.id}`);
    }
  }
}

// The teams registry the CLI and plugin read (see teams-file.mjs). Writes keep the other top-level keys.
// GET adds `revision`; a write that sends one must still match the file, or it gets 409 with the current registry.
let teamsTmpSeq = 0;

function handleTeams(req, res, rootDir) {
  if (req.method === "GET") {
    const file = resolveTeamsFilePath(rootDir);
    const r = readJsonFileWithBom(file, { label: "teams.json", fallback: null, recordWarning: true });
    if (r.ok && r.data) {
      return sendJson(res, 200, { ...r.data, revision: teamsRevision(file) });
    }
    return sendJson(res, 500, { error: r.error || "Failed to read teams.json" });
  }
  if (req.method !== "POST" && req.method !== "PUT") {
    res.statusCode = 405;
    return res.end();
  }
  readBody(req).then((parsed) => {
    try {
      const teams = Array.isArray(parsed) ? parsed : parsed.teams;
      validateTeamsBody(teams);
      const readPath = resolveTeamsFilePath(rootDir);
      const curRes = readJsonFileWithBom(readPath, {
        label: "teams.json",
        fallback: {},
        recordWarning: true,
      });
      const { revision: _staleRevision, ...cur } = curRes.data ?? {};
      const currentRevision = teamsRevision(readPath);
      if (!Array.isArray(parsed) && typeof parsed.revision === "string" && parsed.revision !== currentRevision) {
        return sendJson(res, 409, { error: "teams.json changed", ...cur, revision: currentRevision });
      }
      const firstTeam = teams[0] ?? null;
      const leadFlagTokens =
        typeof parsed.leadFlagTokens === "number"
          ? parsed.leadFlagTokens
          : typeof firstTeam?.leadFlagTokens === "number"
            ? firstTeam.leadFlagTokens
            : cur.leadFlagTokens ?? cur.leadHandoffTokens ?? LEAD_FLAG_DEFAULT;
      const leadAutoHandoffTokens =
        typeof parsed.leadAutoHandoffTokens === "number"
          ? parsed.leadAutoHandoffTokens
          : typeof firstTeam?.leadAutoHandoffTokens === "number"
            ? firstTeam.leadAutoHandoffTokens
            : cur.leadAutoHandoffTokens ?? LEAD_AUTO_HANDOFF_DEFAULT;
      const leadHardCapTokens =
        typeof parsed.leadHardCapTokens === "number"
          ? parsed.leadHardCapTokens
          : typeof firstTeam?.leadHardCapTokens === "number"
            ? firstTeam.leadHardCapTokens
            : cur.leadHardCapTokens ?? LEAD_HARD_CAP_DEFAULT;
      const next = {
        ...cur,
        leadHandoffTokens: leadFlagTokens,
        leadFlagTokens,
        leadAutoHandoffTokens,
        leadHardCapTokens,
        ...(typeof parsed.brainstormWarnTokens === "number" ? { brainstormWarnTokens: parsed.brainstormWarnTokens } : {}),
        ...(typeof parsed.brainstormRestartTokens === "number" ? { brainstormRestartTokens: parsed.brainstormRestartTokens } : {}),
        teams,
      };
      const file = resolveTeamsWritePath(rootDir);
      mkdirSync(dirname(file), { recursive: true });
      // Unique per write, so two PUTs in this process never share a temp file.
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++teamsTmpSeq}`;
      try {
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      clearConfigWarning(file);
      seedHubBriefs(cur.teams, teams, rootDir);
      sendJson(res, 200, {
        ok: true,
        revision: teamsRevision(resolveTeamsFilePath(rootDir)),
        teams: next.teams,
        leadFlagTokens: next.leadFlagTokens,
        leadAutoHandoffTokens: next.leadAutoHandoffTokens,
        leadHardCapTokens: next.leadHardCapTokens,
      });
    } catch (e) {
      res.statusCode = 400;
      res.end(String(e));
    }
  }, (e) => {
    res.statusCode = e?.status === 413 ? 413 : 400;
    res.end(String(e?.message ?? e));
  });
}

// GET ?team=<id>: recent log.jsonl entries. POST {team,type,text,refs?}: append (240-char limit).
async function handleSettings(req, res) {
  if (req.method === "GET") {
    const current = loadUserSettings();
    const warnings = getConfigWarnings();
    return sendJson(res, 200, {
      ok: true,
      ...current,
      activeLanEnabled: exposure.lanEnabled,
      exposedIps: exposure.exposedIps,
      ...(warnings.length ? { configWarnings: warnings } : {}),
    });
  }
  if (req.method === "POST" || req.method === "PUT") {
   try {
    const body = await readCleanBody(req);
    const patch = {};
    if (body && "userName" in body) patch.userName = body.userName;
    if (body && "lanEnabled" in body) patch.lanEnabled = Boolean(body.lanEnabled);
    if (body && "pushEvents" in body) patch.pushEvents = body.pushEvents;
    if (body && Array.isArray(body.dismissedCards)) patch.dismissedCards = body.dismissedCards;
    let saved = saveUserSettings(patch);
    if (
      body &&
      (typeof body.remoteEnabled === "boolean" ||
        (body.remote && typeof body.remote === "object" && typeof body.remote.enabled === "boolean"))
    ) {
      const wantRemote =
        typeof body.remoteEnabled === "boolean" ? body.remoteEnabled : Boolean(body.remote.enabled);
      saved = saveRemoteAccess(wantRemote);
    }
    if ("lanEnabled" in patch && typeof exposure.toggleHandler === "function") {
      try {
        const resToggle = await exposure.toggleHandler(saved.lanEnabled);
        if (resToggle && typeof resToggle === "object") {
          if ("lanEnabled" in resToggle) exposure.lanEnabled = Boolean(resToggle.lanEnabled);
          if (Array.isArray(resToggle.exposedIps)) exposure.exposedIps = resToggle.exposedIps.filter(Boolean);
        }
      } catch {}
    }
    const warnings = getConfigWarnings();
    return sendJson(res, 200, {
      ok: true,
      ...saved,
      activeLanEnabled: exposure.lanEnabled,
      exposedIps: exposure.exposedIps,
      ...(warnings.length ? { configWarnings: warnings } : {}),
    });
   } catch (e) {
    // A refused save (unreadable settings.json) is a conflict the owner must fix; anything else is a server fault.
    const status = e?.code === "SETTINGS_UNREADABLE" ? 409 : e?.status === 413 ? 413 : 500;
    return sendJson(res, status, { ok: false, error: String(e?.message ?? e) });
   }
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

async function handleLog(req, res) {
  try {
    if (req.method === "GET") {
      const team = new URL(req.url, "http://x").searchParams.get("team") ?? "";
      if (!TEAM_ID.test(team)) return sendJson(res, 400, { error: "bad team" });
      const file = join(teamDir(team), "log.jsonl");
      if (!existsSync(file)) return sendJson(res, 200, []);
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-100);
      const out = [];
      for (const l of lines) {
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
      return sendJson(res, 200, out);
    }
    if (req.method === "POST") {
      const { team, type = "you", text, refs, agent = loadUserSettings().userName, lane = "" } = await readCleanBody(req);
      if (!TEAM_ID.test(String(team))) return sendJson(res, 400, { error: "bad team" });
      if (!LOG_TYPES.has(type) || !UI_LOG_TYPES.has(type)) return sendJson(res, 400, { error: `type ${type} not allowed from the UI` });
      const t = String(text ?? "").trim();
      if (!t) return sendJson(res, 400, { error: "empty text" });
      if (t.length > 240) return sendJson(res, 400, { error: `text is ${t.length} chars, limit 240` });
      const { entry } = appendVsLogEntry({
        teamId: String(team),
        laneId: String(lane || team),
        agent: String(agent),
        type,
        text: t,
        refs: Array.isArray(refs) ? refs.map(String) : [],
      });
      return sendJson(res, 200, entry);
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    sendJson(res, 400, { error: String(e) });
  }
}

const realOrNull = (p) => {
  try {
    return realpathSync(resolve(String(p)));
  } catch {
    return null;
  }
};
const normPath = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
const insideDir = (child, root) => {
  const c = normPath(child);
  const r = normPath(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
};

// UNC and device paths (\\host\share, //host/share, \\?\UNC\..., \\.\pipe) make Windows contact another
// machine (and send NTLM credentials) on a mere stat. Refuse them before any fs call.
export const isUncLikePath = (p) => /^[\\/]{2}/.test(String(p ?? ""));

/** Lexical allowlist check on the resolved path, before anything touches the disk. Roots count in both forms. */
const lexicallyInside = (p, roots) => {
  const r = resolve(String(p));
  return roots.some((root) => insideDir(r, root) || insideDir(r, resolve(root)));
};

function allowedAttachRoots(rootDir, opts) {
  const roots = [rootDir, ...(opts.allowedCwdRoots ?? [])];
  try {
    const teams = JSON.parse(stripBom(readFileSync(resolveTeamsFilePath(rootDir), "utf8"))).teams ?? [];
    // Same confinement as lane working dirs: a registry path outside the project roots widens nothing.
    for (const t of teams) {
      for (const p of t.paths ?? []) {
        const full = resolveProjectPath(p, rootDir);
        if (full) roots.push(full);
      }
    }
  } catch {}
  return [...new Set(roots)].map(realOrNull).filter(Boolean);
}

/** A terminal / script cwd must sit inside a team path or a runner agent cwd (never an arbitrary path). Returns its real path or null. */
async function resolveShellCwd(cwd, rootDir, opts) {
  if (!cwd || isUncLikePath(cwd)) return null;
  let roots = allowedAttachRoots(rootDir, opts);
  try {
    const agents = await sharedRunnerBackend().listAgents();
    roots = [...new Set([...roots, ...agents.map((a) => realOrNull(a.cwd)).filter(Boolean)])];
  } catch {}
  if (!lexicallyInside(cwd, roots)) return null;
  const real = realOrNull(cwd);
  try {
    if (!real || !statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return roots.some((r) => insideDir(real, r)) ? real : null;
}

// Quick open / find in files call per keystroke: reuse the roots for 30s; file-search.mjs rescans (fresh) once before it answers 403.
const navRootsCache = new Map();
const navRoots = (rootDir, opts) => (fresh) => {
  const hit = navRootsCache.get(rootDir);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.roots;
  // Runner (rn-) agents are the default and often sit in worktrees outside the project roots.
  let runnerCwds = [];
  try { runnerCwds = listRunnerAgentsSync().filter((a) => !a.archivedAt).map((a) => realOrNull(a.cwd)).filter(Boolean); } catch {}
  // A home dir or drive root as a browse root would expose everything under it.
  const roots = [...new Set([...allowedAttachRoots(rootDir, opts), ...runnerCwds])].filter((r) => !isUnsafeRoot(r));
  navRootsCache.set(rootDir, { at: Date.now(), roots });
  return roots;
};

/**
 * Other worktrees a relative file link may point into when the file is missing under `cwd`: the managed sanctuary
 * dirs for the same repo, plus cwds of live agents in the same team + lane. Lane cwds must already be allowed roots.
 */
let laneAgentsCache = { at: 0, agents: [] };
function liveRunnerAgents(now = Date.now()) {
  // listRunnerAgentsSync parses every jsonl: share one scan across 404s for 30s, like navRoots.
  if (now - laneAgentsCache.at >= 30_000) {
    let agents = [];
    try { agents = listRunnerAgentsSync().filter((a) => !a.archivedAt); } catch {}
    laneAgentsCache = { at: now, agents };
  }
  return laneAgentsCache.agents;
}
export const _resetLaneAgentsCache = () => { laneAgentsCache = { at: 0, agents: [] }; };

export function laneWorktreeCandidates(cwd, roots, { sanctuary = resolveManagedWorktreeRoot(), agents } = {}) {
  const out = [];
  const repo = extractManagedWorktreeRepoName(cwd) ?? basename(String(cwd).replace(/[\\/]+$/, ""));
  try {
    const base = join(sanctuary, repo);
    const realBase = realOrNull(base);
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      // A unit entry that is a junction out of the sanctuary must not widen the search.
      const real = realOrNull(join(base, d.name));
      if (real && realBase && insideDir(real, realBase)) out.push(real);
    }
  } catch {}
  try {
    const live = (agents ?? liveRunnerAgents()).filter((a) => !a.archivedAt);
    const here = realOrNull(cwd);
    const mine = live.filter((a) => here && insideDir(realOrNull(a.cwd) ?? "", here) && insideDir(here, realOrNull(a.cwd) ?? "") && a.labels?.team && a.labels?.lane);
    const allowed = typeof roots === "function" ? roots(false) : roots ?? [];
    for (const a of live) {
      if (!mine.some((m) => m.labels.team === a.labels?.team && m.labels.lane === a.labels?.lane)) continue;
      const real = realOrNull(a.cwd);
      if (real && allowed.some((r) => insideDir(real, r))) out.push(real);
    }
  } catch {}
  return [...new Set(out)];
}

/** Host-path-free name for a worktree in a 409 reply: relative to the sanctuary, else just the folder name. */
export function worktreeLabel(dir, sanctuary = resolveManagedWorktreeRoot()) {
  const real = realOrNull(sanctuary);
  const d = realOrNull(dir) ?? dir;
  if (real && insideDir(d, real)) return d.slice(real.length).replace(/^[\\/]+/, "").replace(/\\/g, "/").split("/").slice(1).join("/") || basename(d);
  return basename(d);
}

/** Agent id -> cwd, server-side only: runner record (on-disk log, then the live API), then the repo root. */
export async function agentCwdFor(agentId, rootDir, { runner } = {}) {
  const id = String(agentId ?? "");
  if (!AGENT_ID_STRICT.test(id)) return rootDir;
  if (isRunnerId(id)) {
    try { const rec = readRunnerAgentSync(id); if (rec?.cwd) return rec.cwd; } catch {} // on-disk record: no HTTP round trip
    try {
      const cwd = (await (runner ?? sharedRunnerBackend()).fetchAgent(id)).agent?.cwd;
      if (cwd) return cwd;
    } catch {}
  }
  return rootDir;
}

function isSensitiveSource(real) {
  const home = homedir();
  const blocked = [".vibesquad", ".paseo", ".ssh"].map((d) => realOrNull(join(home, d)) ?? join(home, d));
  if (blocked.some((b) => insideDir(real, b))) return true;
  return real.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".git");
}

// POST {cwd, files[]}: copy into <cwd>/scratch/inputs (A5 workspace read block workaround).
async function handleAttach(req, res, rootDir, opts = {}) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    // The one body that carries a cwd on purpose: it is confined right below (roots + UNC + realpath).
    const { cwd, files } = await readBody(req);
    if (typeof cwd !== "string" || isUncLikePath(cwd)) return sendJson(res, 400, { error: "cwd is not a directory" });
    const roots = allowedAttachRoots(rootDir, opts);
    if (!lexicallyInside(cwd, roots)) return sendJson(res, 403, { error: "cwd is not a known agent or team path" });
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return sendJson(res, 400, { error: "cwd is not a directory" });
    const realCwd = realpathSync(resolve(cwd));
    if (!roots.some((root) => insideDir(realCwd, root))) return sendJson(res, 403, { error: "cwd is not a known agent or team path" });
    if (!Array.isArray(files) || !files.length) return sendJson(res, 400, { error: "no files given" });
    if (files.some((f) => isUncLikePath(f))) return sendJson(res, 403, { error: "source path is not allowed" });
    const dest = join(realCwd, "scratch", "inputs");
    mkdirSync(dest, { recursive: true });
    const copied = [];
    for (const f of files) {
      const src = resolve(String(f));
      if (!existsSync(src) || !statSync(src).isFile()) return sendJson(res, 400, { error: `not a file: ${src}` });
      if (isSensitiveSource(realpathSync(src))) return sendJson(res, 403, { error: "source path is not allowed" });
      const to = join(dest, basename(src));
      copyFileSync(src, to);
      copied.push(to);
    }
    sendJson(res, 200, { dest, copied });
  } catch (e) {
    sendJson(res, e?.status === 413 ? 413 : 400, { error: String(e) });
  }
}

// `vs handoff` runs async (it used to execFileSync for up to 60 s and stall every request), one at a time.
// POST waits at most HANDOFF_HTTP_WAIT_MS, then answers 202 and the run finishes in the background; the UI
// polls GET (running/exists/error). That keeps it well under the 10 s remote proxy timeout.
export const HANDOFF_TIMEOUT_MS = 60_000;
export const HANDOFF_HTTP_WAIT_MS = 2000;
let handoffRunning = false;
let lastHandoffError = null;
const runVsHandoff = (cli, rootDir, env) =>
  new Promise((ok, fail) => {
    execFile(process.execPath, [cli, "handoff"], { cwd: rootDir, env, timeout: HANDOFF_TIMEOUT_MS, windowsHide: true }, (err) =>
      err ? fail(err) : ok(),
    );
  });

// GET ?team&lane: does the successor packet exist? POST {team,lane,agentId}: run `vs handoff` to make it.
async function handleHandoff(req, res, rootDir) {
  try {
    const q = req.method === "GET" ? new URL(req.url, "http://x").searchParams : null;
    const body = req.method === "POST" ? await readCleanBody(req) : {};
    const team = String(q?.get("team") ?? body.team ?? "");
    const lane = String(q?.get("lane") ?? body.lane ?? "");
    if (!TEAM_ID.test(team) || !TEAM_ID.test(lane)) return sendJson(res, 400, { error: "bad team/lane" });
    const packet = join(teamDir(team), `packet-${lane}.md`);
    if (req.method === "GET") {
      return sendJson(res, 200, {
        exists: existsSync(packet),
        path: packet,
        running: handoffRunning,
        ...(lastHandoffError ? { error: lastHandoffError } : {}),
      });
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    if (body.agentId !== undefined && !AGENT_ID_STRICT.test(String(body.agentId))) return sendJson(res, 400, { error: "bad agentId" });
    const cli = join(rootDir, "cli", "vs.mjs");
    if (!existsSync(cli)) return sendJson(res, 200, { exists: existsSync(packet), path: packet, ran: false, note: "cli/vs.mjs not found" });
    if (handoffRunning) return sendJson(res, 429, { error: "a handoff is already running; try again when it finishes" });
    handoffRunning = true;
    lastHandoffError = null;
    const run = runVsHandoff(cli, rootDir, { ...process.env, ...(body.agentId ? { PASEO_AGENT_ID: String(body.agentId) } : {}) })
      .then(
        () => ({ done: true }),
        (err) => {
          lastHandoffError = String(err?.message ?? err);
          return { done: true, error: lastHandoffError };
        },
      )
      .finally(() => {
        handoffRunning = false;
      });
    let timer;
    const outcome = await Promise.race([
      run,
      new Promise((ok) => {
        timer = setTimeout(() => ok({ done: false }), HANDOFF_HTTP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!outcome.done) return sendJson(res, 202, { exists: existsSync(packet), path: packet, accepted: true, running: true });
    if (outcome.error) return sendJson(res, 500, { error: outcome.error });
    sendJson(res, 200, { exists: existsSync(packet), path: packet, ran: true });
  } catch (e) {
    sendJson(res, 500, { error: String(e) });
  }
}

async function handleBrainstormSummary(req, res, rootDir) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const lane = q.get("lane") || q.get("laneId") || "vibesquad";
      const s = readBrainstormSummary(lane, rootDir, { teamId: q.get("teamId") || q.get("team") || "" });
      return sendJson(res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content, revision: contentRevision(s.content) });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readCleanBody(req);
      const lane = body.laneId || body.lane || "vibesquad";
      const teamId = String(body.teamId || body.team || "");
      const content = String(body.content ?? "");
      if (content.length >= 20_000) {
        return sendJson(res, 400, { ok: false, error: `Summary is ${content.length} chars; must be < 20000 chars (~5k tokens)` });
      }
      // Like teams.json: a write that sends the revision it read gets 409 if the brief changed since.
      if (body.revision !== undefined) {
        const cur = readBrainstormSummary(lane, rootDir, { teamId });
        const revision = contentRevision(cur.content);
        if (body.revision !== revision) return sendJson(res, 409, { ok: false, error: "brief changed", content: cur.content, revision });
      }
      const s = writeBrainstormSummary(lane, content, rootDir, { teamId });
      return sendJson(res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content, revision: contentRevision(s.content), ...(s.fallback ? { fallback: true } : {}) });
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleVsLog(req, res) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const team = q.get("team") || q.get("teamId") || "vibesquad";
      const lane = q.get("lane") || q.get("laneId") || team;
      if (!TEAM_ID.test(team) || !TEAM_ID.test(lane)) return sendJson(res, 400, { ok: false, error: "bad team/lane" });
      const baseHome = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
      const file = join(baseHome, "logs", `${team}--${lane}.jsonl`);
      if (!existsSync(file)) return sendJson(res, 200, { ok: true, entries: [] });
      const entries = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-100)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return sendJson(res, 200, { ok: true, entries });
    }
    if (req.method === "POST") {
      const body = await readCleanBody(req);
      const teamId = body.teamId || body.team || "vibesquad";
      const laneId = body.laneId || body.lane || teamId;
      if (!TEAM_ID.test(String(teamId)) || !TEAM_ID.test(String(laneId))) return sendJson(res, 400, { ok: false, error: "bad team/lane" });
      const type = body.type || "metric";
      const text = String(body.text ?? "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "empty text" });
      const resEntry = appendVsLogEntry({
        teamId,
        laneId,
        agent: body.agent || body.agentId || loadUserSettings().userName,
        type,
        text,
        refs: body.refs,
      });
      return sendJson(res, 200, { ok: true, entry: resEntry.entry, path: resEntry.path });
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleBrainstormRestart(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    if (body?.agentId != null && body.agentId !== "" && !AGENT_ID_STRICT.test(String(body.agentId))) {
      return sendJson(res, 400, { ok: false, error: "bad agentId" });
    }
    if (body.reason === "start-brainstorm" || body.agentId === "start-brainstorm") {
      if (overSpawnBudget(res)) return;
    } else {
      // A restart archives the old Buddy and spawns a new one: it spends from both budgets.
      if (overArchiveBudget(res)) return;
      if (overSpawnBudget(res)) return;
    }
    const result = await performBrainstormRestart(body, rootDir);
    // ok:false (e.g. agent-list-unavailable) must not look like success to the UI.
    return sendJson(res, result?.ok === false ? 503 : 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleLeadHandoff(req, res, rootDir, actionOverride) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = await performLeadHandoffHttp(
      actionOverride ? { ...body, action: actionOverride } : { httpWaitMs: 2000, ...body },
      rootDir,
    );
    const status = result?.status || (result?.accepted ? 202 : 200);
    return sendJson(res, status, result);
  } catch (e) {
    return sendJson(res, e?.status === 403 ? 403 : 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInbox(req, res, rootDir) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const cards = listInboxCards(
        {
          teamId: q.get("teamId") || q.get("team") || "",
          laneId: q.get("laneId") || q.get("lane") || "",
          status: q.get("status") || "",
        },
        rootDir,
      );
      return sendJson(res, 200, { ok: true, cards });
    }
    if (req.method === "POST") {
      const body = await readCleanBody(req);
      const result = addInboxCards(body, rootDir);
      return sendJson(res, 200, result);
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxTriage(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = triageInboxCards(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxOpenTopic(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = await openTopicBrainstorm(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxHandoffTopic(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    if (overArchiveBudget(res)) return;
    const result = await handoffTopicBrainstorm(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxParkTopic(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    if (overArchiveBudget(res)) return;
    const result = await parkTopicBrainstorm(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

function handlePushVapidPublicKey(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const vapid = getOrCreateVapidKeys();
    const subs = readPushSubscriptions();
    return sendJson(res, 200, { ok: true, publicKey: vapid.publicKey, subCount: subs.length });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handlePushSubscribe(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = savePushSubscription(body);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handlePushUnsubscribe(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = removePushSubscription(body);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

function handlePushStatus(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const subs = readPushSubscriptions();
  const desktopCount = subs.filter((s) => s.type === "desktop").length;
  return sendJson(res, 200, {
    ok: true,
    count: subs.length,
    webPushCount: subs.length - desktopCount,
    desktopCount,
    subscriptions: subs.map((s) => ({
      type: s.type || "webpush",
      endpoint: redactPushEndpoint(s.endpoint),
      deviceName: s.deviceName || null,
      updatedAt: s.updatedAt || null,
    })),
  });
}

async function handlePushTest(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = await sendTestPush(body);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleProfiles(req, res) {
  try {
    if (req.method === "GET") {
      const state = loadProfiles(undefined, { autoImportPaseo: true });
      const diff = diffProfiles(state.profiles, state.paseoProfiles);
      const warningsByProfile = { ...(state.warningsByProfile ?? {}) };
      for (const d of diff) {
        if (d.warnings?.length) warningsByProfile[d.name] = d.warnings;
      }
      return sendJson(res, 200, {
        ok: true,
        exists: state.exists,
        needsSetup: state.needsSetup,
        source: state.source,
        path: state.path,
        profiles: state.profiles,
        paseoProfiles: state.paseoProfiles,
        providerOverrides: state.providerOverrides ?? {},
        diff,
        warningsByProfile,
        installedProviders: state.installedProviders,
      });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readCleanBody(req);
      const saved = saveProfiles(body);
      syncProfilesToPaseo(saved.profiles);
      return sendJson(res, 200, {
        ok: true,
        path: saved.path,
        profiles: saved.profiles,
      });
    }
    res.statusCode = 405;
    return res.end();
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleProfilesImport(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    if (body.mode === "default") {
      const seeded = seedDefaultPack();
      syncProfilesToPaseo(seeded.profiles);
      return sendJson(res, 200, {
        ok: true,
        mode: "default",
        path: seeded.path,
        profiles: seeded.profiles,
        warningsByProfile: {},
      });
    }
    const rawSource = Array.isArray(body.profiles)
      ? body.profiles
      : readPaseoConfig().agentProfiles;
    const imported = importPaseoProfiles(rawSource, {
      selectedNames: Array.isArray(body.selectedNames) ? body.selectedNames : undefined,
    });
    let finalProfiles = imported.profiles;
    if (body.merge && existsSync(getProfilesPath())) {
      const existing = [...loadProfiles().profiles];
      for (const p of imported.profiles) {
        const idx = existing.findIndex(
          (e) =>
            (p.id && e.id === p.id) ||
            e.name === p.name ||
            LEGACY_PROFILE_ALIASES[e.name] === p.name,
        );
        if (idx >= 0) existing[idx] = p;
        else existing.push(p);
      }
      finalProfiles = existing;
    }
    if (!finalProfiles.length) {
      const seeded = seedDefaultPack();
      return sendJson(res, 200, {
        ok: true,
        mode: "default",
        path: seeded.path,
        profiles: seeded.profiles,
        warningsByProfile: {},
      });
    }
    const saved = saveProfiles({ profiles: finalProfiles });
    return sendJson(res, 200, {
      ok: true,
      mode: "paseo",
      path: saved.path,
      profiles: saved.profiles,
      warningsByProfile: imported.warningsByProfile,
    });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

function handleProfilesDiff(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const state = loadProfiles(undefined, { autoSeed: false });
    const diff = diffProfiles(state.profiles, state.paseoProfiles);
    const warningsByProfile = {};
    for (const d of diff) {
      if (d.warnings?.length) warningsByProfile[d.name] = d.warnings;
    }
    return sendJson(res, 200, {
      ok: true,
      diff,
      warningsByProfile,
    });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

function resolveDesktopInstallerPath(rootDir = REPO_ROOT) {
  const candidates = [rootDir];
  if (rootDir.includes(".worktrees")) {
    candidates.push(resolve(rootDir, "../.."));
  }
  const stamp = readBuildStamp(rootDir);
  if (stamp?.repo) {
    const repoRoot = stamp.repo.replace(/[\\/]\.git[\\/]?$/, "");
    if (repoRoot && !candidates.includes(repoRoot)) candidates.push(repoRoot);
  }
  for (const base of candidates) {
    const distInstaller = join(base, "dist-desktop", "VibeSquad-setup.exe");
    if (existsSync(distInstaller)) return distInstaller;
    const nsisDir = join(base, "src-tauri", "target", "release", "bundle", "nsis");
    if (existsSync(nsisDir)) {
      try {
        const exe = readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe") || f.endsWith(".exe"));
        if (exe) return join(nsisDir, exe);
      } catch {}
    }
  }
  return join(rootDir, "dist-desktop", "VibeSquad-setup.exe");
}

export function resolveAndroidApkPath(rootDir = REPO_ROOT) {
  const primary = join(rootDir, "dist-desktop", "VibeSquad.apk");
  if (existsSync(primary)) return primary;
  const parent = resolve(rootDir, "../..", "dist-desktop", "VibeSquad.apk");
  if (existsSync(parent)) return parent;
  const apkDir = join(rootDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release");
  if (existsSync(apkDir)) {
    try {
      const apk = readdirSync(apkDir).find((f) => f.endsWith(".apk"));
      if (apk) return join(apkDir, apk);
    } catch {}
  }
  return primary;
}

function readDesktopVersion(rootDir = REPO_ROOT) {
  const conf = readJsonFileWithBom(join(rootDir, "src-tauri", "tauri.conf.json"), {
    label: "tauri.conf.json",
    fallback: null,
    recordWarning: false,
    rewriteBom: false,
  }).data;
  if (conf?.version) return String(conf.version);
  const pkg = readJsonFileWithBom(join(rootDir, "package.json"), {
    label: "package.json",
    fallback: null,
    recordWarning: false,
    rewriteBom: false,
  }).data;
  if (pkg?.version) return String(pkg.version);
  return "0.1.0";
}

export function handleDesktopInstaller(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const file = resolveDesktopInstallerPath(rootDir);
  if (!existsSync(file)) {
    return sendJson(res, 404, { error: "Desktop installer not built yet (run npm run build:desktop)" });
  }
  const stat = statSync(file);
  res.statusCode = 200;
  res.setHeader("content-type", "application/vnd.microsoft.portable-executable");
  res.setHeader("content-length", String(stat.size));
  res.setHeader("content-disposition", 'attachment; filename="VibeSquad-setup.exe"');
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

export function handleAndroidApk(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const file = resolveAndroidApkPath(rootDir);
  if (!existsSync(file)) {
    return sendJson(res, 404, { error: "Android APK not built yet (run npm run build:android)" });
  }
  const stat = statSync(file);
  res.statusCode = 200;
  res.setHeader("content-type", "application/vnd.android.package-archive");
  res.setHeader("content-length", String(stat.size));
  res.setHeader("content-disposition", 'attachment; filename="VibeSquad.apk"');
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

export function handleDesktopUpdateJson(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const { port, meshnetIp, lanIp } = netConfig();
  const reqHost = String(req.headers.host || "").split(":")[0];
  const ip = reqHost && (reqHost === lanIp || reqHost === meshnetIp) ? reqHost : lanIp || meshnetIp || "127.0.0.1";
  const version = readDesktopVersion(rootDir);
  const file = resolveDesktopInstallerPath(rootDir);
  const exists = existsSync(file);
  const stat = exists ? statSync(file) : null;
  const downloadUrl = `http://${ip}:${port}/__vibesquad/desktop/VibeSquad-setup.exe`;
  let signature = "";
  const sigFile = `${file}.sig`;
  if (existsSync(sigFile)) {
    try {
      signature = readFileSync(sigFile, "utf8").trim();
    } catch {}
  }
  return sendJson(res, 200, {
    version,
    notes: "VibeSquad Desktop App (Tauri 2)",
    pub_date: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    available: exists,
    size: stat ? stat.size : 0,
    url: downloadUrl,
    platforms: {
      "windows-x86_64": {
        signature,
        url: downloadUrl,
      },
    },
  });
}

// ---- Local image proxy: chat messages reference file:// images a browser can't load. ----
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const AGENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** A runner agent's cwd from its on-disk record (sync: the image proxy reads it per request); null for any other id. */
export function lookupAgentCwd(agentId) {
  const id = String(agentId ?? "").trim();
  if (!AGENT_ID_RE.test(id) || !isRunnerId(id)) return null;
  try {
    const cwd = readRunnerAgentSync(id)?.cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
  } catch {
    return null;
  }
}

function imageAllowedRoots() {
  const roots = [];
  for (const extra of String(process.env.VIBESQUAD_IMAGE_ROOTS ?? "").split(";")) if (extra.trim()) roots.push(extra.trim());
  const out = [];
  for (const r of roots) {
    try {
      out.push(realpathSync(r));
    } catch {}
  }
  return out;
}

/** Resolves `raw` (file:// URL or absolute path) to a real image file inside the allowlist, else null. */
export function resolveAllowedImage(raw, roots = imageAllowedRoots(), extraCwd = null) {
  try {
    let p = String(raw ?? "");
    if (!p || p.includes("\0")) return null;
    if (/^file:/i.test(p)) p = fileURLToPath(p);
    if (isUncLikePath(p)) return null;
    if (!IMAGE_MIME[extname(p).toLowerCase()]) return null;
    const allRoots = Array.isArray(roots) ? [...roots] : imageAllowedRoots();
    let resolvedExtra = null;
    if (typeof extraCwd === "string" && extraCwd.trim()) {
      resolvedExtra = extraCwd.trim();
    } else if (extraCwd && typeof extraCwd === "object") {
      resolvedExtra = extraCwd.extraCwd || (extraCwd.agentId ? lookupAgentCwd(extraCwd.agentId) : null);
    }
    if (resolvedExtra && !isUncLikePath(resolvedExtra)) {
      try {
        allRoots.push(realpathSync(resolve(resolvedExtra)));
      } catch {}
    }
    if (!lexicallyInside(p, allRoots.filter((r) => !isUncLikePath(r)))) return null;
    const real = realpathSync(resolve(p));
    if (!statSync(real).isFile()) return null;
    const norm = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
    const r = norm(real);
    return allRoots.some((root) => {
      try {
        const realRoot = norm(realpathSync(resolve(root)));
        return r.startsWith(realRoot + sep);
      } catch {
        return r.startsWith(norm(root) + sep);
      }
    })
      ? real
      : null;
  } catch {
    return null;
  }
}

export function handleLocalImage(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const sp = new URL(req.url ?? "", "http://x").searchParams;
  const q = sp.get("path");
  // Never trust a client-sent `cwd` query param; look up cwd server-side by agentId only.
  const agentId = sp.get("agentId") || sp.get("agent") || "";
  const agentCwd = agentId ? lookupAgentCwd(agentId) : null;
  const file = resolveAllowedImage(q, imageAllowedRoots(), agentCwd);
  if (!file) return sendJson(res, 404, { error: "not found" });
  res.statusCode = 200;
  res.setHeader("content-type", IMAGE_MIME[extname(file).toLowerCase()]);
  res.setHeader("content-length", String(statSync(file).size));
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "private, max-age=3600");
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

// GET ?cwd=<path>: reads package.json scripts from the given workspace directory.
// Only allows directories that are trusted agent/team cwd paths.
async function handleWorkspacePackageScripts(req, res, rootDir, opts = {}) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const cwd = new URL(req.url, "http://x").searchParams.get("cwd") ?? "";
    if (!cwd || isUncLikePath(cwd)) return sendJson(res, 400, { ok: false, scripts: {} });
    const allowed = allowedAttachRoots(rootDir, opts);
    if (!lexicallyInside(cwd, allowed)) return sendJson(res, 403, { ok: false, error: "cwd not in allowed roots" });
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return sendJson(res, 400, { ok: false, scripts: {} });
    }
    const realCwd = realpathSync(resolve(cwd));
    if (!allowed.some((root) => insideDir(realCwd, root))) {
      return sendJson(res, 403, { ok: false, error: "cwd not in allowed roots" });
    }
    const pkgPath = join(realCwd, "package.json");
    if (!existsSync(pkgPath)) return sendJson(res, 200, { ok: true, scripts: {} });
    let pkgScripts = {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg.scripts === "object" && pkg.scripts !== null) {
        pkgScripts = pkg.scripts;
      }
    } catch {
      // invalid package.json – return empty
    }
    return sendJson(res, 200, { ok: true, scripts: pkgScripts });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

// Connect-style middleware: handles /__vibesquad/* and /api/*, calls next() for everything else.
// Everything except health, /ca.crt, /pair and /__vibesquad/local-login needs a paired device or a same-origin loopback
// caller; a loopback caller without the local token is read-only (GET/HEAD, minus isGatedRead).
export function createVibesquadMiddleware(rootDir = REPO_ROOT, opts = {}) {
  const readOnlyCache = createReadOnlyCache(opts.readOnlyCacheMs);
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    const cachedRead = (run) => readOnlyCache(path, isOwner(req), run);
    // An owner write (install, toggle) can change what those reads return.
    if (req.method !== "GET" && req.method !== "HEAD" && isOwner(req)) readOnlyCache.clear();
    if (path === "/api/health" || path === "/__vibesquad/health") return handleHealth(req, res, rootDir);
    if (path === "/ca.crt") return handleCaCrt(req, res);
    if (path === "/pair") return handlePairRedeem(req, res);
    if (path === "/__vibesquad/local-login") return handleLocalLogin(req, res);
    if (path === "/__vibesquad/local-login/nonce") return handleLocalLoginNonce(req, res);
    const isApi = path.startsWith("/__vibesquad/") || path.startsWith("/api/");
    if (isApi && !isTrusted(req)) {
      if (isLocal(req)) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 401, { error: "unpaired device" });
    }
    if (isApi && !isOwner(req) && ((req.method !== "GET" && req.method !== "HEAD") || isGatedRead(path, req.url))) {
      return sendJson(res, 403, { error: READ_ONLY_ERROR, readOnly: true });
    }
    const bodyLimit = RUNNER_INPUT_RE.test(path) ? MAX_RUNNER_INPUT_BYTES : MAX_BODY_BYTES;
    if (Number(req.headers["content-length"] ?? 0) > bodyLimit) return sendJson(res, 413, { error: "payload too large" });
    if (path === "/api/auth/status" || path === "/__vibesquad/auth/status") return handleAuthStatus(req, res, rootDir);
    if (path === "/api/teams") return handleTeams(req, res, rootDir);
    if (path === "/api/profiles") return handleProfiles(req, res);
    if (path === "/__vibesquad/local-image") return handleLocalImage(req, res);
    if (path === "/VibeSquad-setup.exe" || path === "/__vibesquad/desktop/VibeSquad-setup.exe") {
      return handleDesktopInstaller(req, res, rootDir);
    }
    if (path === "/VibeSquad.apk" || path === "/__vibesquad/android/VibeSquad.apk") {
      return handleAndroidApk(req, res, rootDir);
    }
    if (path === "/__vibesquad/desktop/update.json") {
      return handleDesktopUpdateJson(req, res, rootDir);
    }
    if (!path.startsWith("/__vibesquad/")) return next?.();
    if (path.startsWith("/__vibesquad/runner/")) return handleRunnerApi(req, res, { readBody: (r) => readBody(r, bodyLimit), sendJson });
    if (path === "/__vibesquad/schedules" || path.startsWith("/__vibesquad/schedules/")) return handleSchedulesApi(req, res, { readBody, sendJson });
    if (isGitPath(path)) return handleGitApi(req, res, { readBody, sendJson, resolveCwd: (cwd) => resolveShellCwd(cwd, rootDir, opts) });
    if (isTerminalsPath(path)) return handleTerminalsApi(req, res, { readBody, sendJson, resolveCwd: (cwd) => resolveShellCwd(cwd, rootDir, opts) });
    if (path === "/__vibesquad/providers" || path.startsWith("/__vibesquad/providers/")) return handleProvidersApi(req, res, { sendJson, readBody: readCleanBody });
    switch (path) {
      case "/__vibesquad/pair/start":
        return handlePairStart(req, res);
      case "/__vibesquad/devices":
        return handleDevices(req, res);
      case "/__vibesquad/devices/revoke":
        return handleRevoke(req, res, readBody);
      case "/__vibesquad/teams":
        return handleTeams(req, res, rootDir);
      case "/__vibesquad/first-run/status":
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return cachedRead(() => inspectFirstRunStatus(opts.firstRun)).then((st) => sendJson(res, 200, st), (e) => sendJson(res, 500, { error: String(e?.message ?? e) }));
      case "/__vibesquad/settings":
        return handleSettings(req, res).catch((e) => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
        });
      case "/__vibesquad/log":
        return handleLog(req, res);
      case "/__vibesquad/attach":
      case "/__vibesquad/attach-files":
        return handleAttach(req, res, rootDir, opts);
      case "/__vibesquad/handoff":
        return handleHandoff(req, res, rootDir);
      case "/__vibesquad/brainstorm-summary":
        return handleBrainstormSummary(req, res, rootDir);
      case "/__vibesquad/vs-log":
        return handleVsLog(req, res);
      case "/__vibesquad/unstick": // owner-only: POST is gated above (isOwner for every non-GET)
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return readBody(req).then((body) => unstick({ confirmRestart: body?.confirmRestart === true })).then((r) => sendJson(res, 200, r), (e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }));
      case "/__vibesquad/restart-runner": // owner-only (same guard as Unstick): park live turns cleanly, then restart the runner
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return forceRestartRunner().then((r) => sendJson(res, 200, r), (e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }));
      case "/__vibesquad/brainstorm-restart":
        return handleBrainstormRestart(req, res, rootDir);
      case "/__vibesquad/lead-handoff":
        return handleLeadHandoff(req, res, rootDir);
      case "/__vibesquad/lead-handoff/confirm":
        return handleLeadHandoff(req, res, rootDir, "confirm");
      case "/__vibesquad/inbox":
        return handleInbox(req, res, rootDir);
      case "/__vibesquad/inbox/triage":
        return handleInboxTriage(req, res, rootDir);
      case "/__vibesquad/inbox/open-topic":
        return handleInboxOpenTopic(req, res, rootDir);
      case "/__vibesquad/inbox/handoff-topic":
        return handleInboxHandoffTopic(req, res, rootDir);
      case "/__vibesquad/inbox/park-topic":
        return handleInboxParkTopic(req, res, rootDir);
      case "/__vibesquad/push/vapid-public-key":
        return handlePushVapidPublicKey(req, res);
      case "/__vibesquad/push/subscribe":
        return handlePushSubscribe(req, res);
      case "/__vibesquad/push/unsubscribe":
        return handlePushUnsubscribe(req, res);
      case "/__vibesquad/push/status":
        return handlePushStatus(req, res);
      case "/__vibesquad/push/test":
        return handlePushTest(req, res);
      case "/__vibesquad/profiles":
        return handleProfiles(req, res);
      case "/__vibesquad/profiles/import":
        return handleProfilesImport(req, res);
      case "/__vibesquad/profiles/diff":
        return handleProfilesDiff(req, res);
      case "/__vibesquad/workspace-package-scripts":
        return handleWorkspacePackageScripts(req, res, rootDir, opts);
      case "/__vibesquad/files":
        return handleFileList(req, res, navRoots(rootDir, opts), sendJson);
      case "/__vibesquad/fs/list":
        return handleFsList(req, res, navRoots(rootDir, opts), sendJson);
      case "/__vibesquad/fs/resolve":
        return handleFsResolve(req, res, (id) => agentCwdFor(id, rootDir), sendJson, navRoots(rootDir, opts));
      case "/__vibesquad/fs/read": {
        const roots = navRoots(rootDir, opts);
        // Cross-worktree lookup is an owner read like the rest of fs/*; a read-only caller gets the plain cwd-only answer.
        return handleFsRead(req, res, roots, sendJson, isOwner(req) ? (cwd) => laneWorktreeCandidates(cwd, roots) : undefined, worktreeLabel);
      }
      case "/__vibesquad/fs/write":
      case "/__vibesquad/fs/create":
      case "/__vibesquad/fs/rename":
      case "/__vibesquad/fs/delete":
      case "/__vibesquad/fs/duplicate": // owner-only: every non-GET is gated above (isOwner)
        return handleFsMutation(path.slice("/__vibesquad/fs/".length), req, res, navRoots(rootDir, opts), sendJson, readBody);
      case "/__vibesquad/fs/watch":
        return handleFsWatch(req, res, navRoots(rootDir, opts), sendJson);
      case "/__vibesquad/search":
        return handleSearch(req, res, navRoots(rootDir, opts), sendJson);
      case "/__vibesquad/secret-input":
        return handleSecretInputRequest(req, res, { readBody: readCleanBody, sendJson, isOwner, secretsDir: opts.secretsDir });
      case "/__vibesquad/remove-team-worktrees":
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return readBody(req)
          .then((body) => sendJson(res, 200, { ok: true, results: removeTeamWorktrees(body?.worktrees) }))
          .catch((e) => sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }));
      default:
        return next?.();
    }
  };
}
