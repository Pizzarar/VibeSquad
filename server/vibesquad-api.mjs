import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loopLagStats } from "../runner/loop-lag.mjs";
import { fetchTesterTimeline, handleRunnerApi, sanitizeTesterInput, sendTesterInput, testerTeamRecords } from "./runner-api.mjs";
import { forceRestartRunner, unstick } from "./unstick.mjs";
import { tailLines } from "./log-tail.mjs";
import { handleSchedulesApi } from "./schedules.mjs";
import { sharedRunnerBackend, isRunnerId, listRunnerAgents, readRunnerCwd, readRunnerCwdSync } from "./backend/index.mjs";
import { readDiscovery, runnerHome } from "./backend/runner-client.mjs";
import { bootingHolder } from "../runner/lock.mjs";
import { lastAssistantText } from "./mcp/tools.mjs";
import { digestVerdictText, isReviewerAgent } from "./verdict.mjs";
import { drainedLogRefusal, isDrainedFeedback } from "./restart-coord.mjs";
import { handleTerminalsApi, isTerminalsPath } from "./terminals-api.mjs";
import { handleGitApi, isGitPath } from "./git-api.mjs";
import { handleProvidersApi } from "./providers-catalog.mjs";
import { peekStale, readBuildStamp, refreshStale } from "./stale-runtime.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { findBuiltApk } from "./android-apk-paths.mjs";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactHostPathTokens, redactHostPaths } from "./redact-host-paths.mjs";
import { isRelayRequest } from "./relay-tunnel.mjs";
import { inspectFirstRunStatus } from "./first-run.mjs";
import { foldersOf, isTeamAsleep, patchTeamsRegistryAsync, readTeamsConfig, resolveTeamsFilePath, resolveTeamsWritePath, teamsRevision, validateFoldersBody, validateTeamsBody, writeTeamsRegistry, writeTeamsRegistryAsync } from "./teams-file.mjs";
import { seedHubBriefs } from "./hub-seed.mjs";
import { isServerSideFsError } from "./file-lock.mjs";
import { primaryProjectsDir, resolveProjectPath } from "./brief-path.mjs";
import { contentRevision, createWindowLimiter, defangPromptFences } from "./write-guards.mjs";
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
import { getHostId } from "./host-id.mjs";
import { authenticate, playtestCaller, callerFromRequest, callerOf, getAuthStatus, handleCaCrt, handleDevices, handleLocalLogin, handleLocalLoginNonce, handleLocalProof, extractDeviceToken, handleEnter, handlePairApprove, handlePairPending, handlePairRedeem, handlePairStart, handlePairStatus, handleRevoke, hasAgentHeaders, hasDistIndex, isLocal, isLocalBrowserSafe, isLocalOwner, isOwnerDevice, netConfig, OWNER_PLAYTEST_ROLE, originRefusal, ownerProof, READ_ONLY_ERROR, resolveNonAgentCaller, sendCrossSiteRefused, setRelayStatusProvider } from "./auth.mjs";
import {
  appendVsLogEntry,
  authorizeBuddyRestartRequest,
  createAgentClient,
  findExistingLaneBrainstorm,
  laneWorkingDir,
  performBrainstormRestart,
  readBrainstormSummary,
  resetBrainstormRestartState,
  writeBrainstormSummary,
} from "./brainstorm.mjs";
import {
  addInboxCards,
  addInboxCardsAsync,
  attachInboxMedia,
  INBOX_MEDIA_MAX_BYTES,
  getInboxPath,
  listInboxCards,
  loadTeamsForInbox,
  pickBugIntakeAgent,
  readInboxCards,
  resolveBugLaneId,
  sendInboxCard,
  sortIdeaCard,
  assertInboxTriageCaller,
  assertInboxTriageRole,
  triageCardIds,
  triageInboxCards,
  triageInboxCardsAsync,
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
import { extractManagedWorktreeRepoName, findLaneInRegistry, loadTeamsRegistry } from "./identity.mjs";
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
  authorizeBuddyRestartRequest,
  createAgentClient,
  findExistingLaneBrainstorm,
  performBrainstormRestart,
  readBrainstormSummary,
  resetBrainstormRestartState,
  writeBrainstormSummary,
  addInboxCards,
  getInboxPath,
  listInboxCards,
  readInboxCards,
  sendInboxCard,
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

// Agent archives reachable over HTTP (brainstorm-restart) share one budget, so a
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
// X1c: a request that names an agent (x-vs-agent-id) is never the owner, whatever else it carries (auth.mjs ownerProof).
// E6a: a paired device is trusted only as an owner device or a bug-tester; a bug-tester is then held to TESTER_ROUTE_ALLOWLIST
// by gated() (never the read-only all-GET view), and a record with any other role is not trusted at all (fail closed).
// PTO v1.1: an owner-playtest device is trusted only so gated() can hold it to PLAYTEST_ROUTE_ALLOWLIST (playtestGated).
const isTrusted = (req) => isLocalBrowserSafe(req) || trustedDevice(authenticate(req));
// PTO R1 L1: an owner-playtest record is trusted only with an id (an id-less one is still caught by the playtest gate first).
const trustedDevice = (dev) => isOwnerDevice(dev) || dev?.role === "bug-tester" || (dev?.role === OWNER_PLAYTEST_ROLE && Boolean(dev.id));
const isOwner = (req) => ownerProof(req);
/** E6a: the bug-tester device record behind `req` (header token, cookie or relay channel), or null. Owner proof wins. */
const testerDeviceOf = (req) => {
  if (isOwner(req)) return null;
  const dev = authenticate(req);
  return dev?.role === "bug-tester" ? dev : null;
};
/**
 * PTO v1.1: the owner-playtest device record behind `req` (header token, cookie or relay channel), or null. Only the local
 * owner (loopback + local token, no agent headers) wins over it. Agent headers never hide it (PTO R1 M1): an unverified
 * x-vs-agent-id must not turn a playtest credential into an "unknown" caller. Same answer as `isOwner ? null : ...`, one
 * authenticate() pass (an owner-playtest record is never an owner device).
 */
const playtestDeviceOf = (req) => {
  if (!hasAgentHeaders(req) && isLocalOwner(req)) return null;
  const dev = authenticate(req);
  return dev?.role === OWNER_PLAYTEST_ROLE ? dev : null;
};
const localAccess = (req) => (isOwner(req) ? "owner" : testerDeviceOf(req) ? "bug-tester" : playtestDeviceOf(req) ? OWNER_PLAYTEST_ROLE : "read-only");
/** E6a: { role, allowedTeams, deviceName } for /health and /auth/status (role null for a non-device read-only caller). */
function deviceFields(req) {
  const tester = testerDeviceOf(req);
  if (tester) return { role: "bug-tester", allowedTeams: testerAllowedTeams(tester), deviceName: String(tester.name ?? "") };
  const playtest = playtestDeviceOf(req);
  if (playtest) return { role: OWNER_PLAYTEST_ROLE, allowedTeams: null, deviceName: String(playtest.name ?? "") };
  if (!isOwner(req)) return { role: null, allowedTeams: null, deviceName: null };
  const dev = authenticate(req);
  return { role: "owner", allowedTeams: null, deviceName: dev ? String(dev.name ?? "") : null };
}
const TEAM_ID_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const testerAllowedTeams = (dev) => (Array.isArray(dev?.allowedTeams) ? dev.allowedTeams : []).map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => TEAM_ID_OK.test(t));

// ---- X1c: what a verified agent may write (docs/PLAN_X1_IDENTITY.md "Server middleware is default-deny") ----
// Every non-GET/HEAD and every gated read needs the owner, except these routes for a verified agent; each handler then
// re-checks the agent's role for what it asks (attribution on the logs, lane roles on the brief/handoff/triage routes, the
// runner's own scope rules on the forwarded runner calls). Everything else is owner-only by construction: no list to maintain.
export const AGENT_WRITE_ALLOWLIST = Object.freeze([
  "/__vibesquad/log",
  "/__vibesquad/vs-log",
  "/__vibesquad/inbox",
  "/__vibesquad/inbox/triage",
  "/__vibesquad/handoff",
  "/__vibesquad/lead-handoff",
  "/__vibesquad/lead-handoff/confirm",
  "/__vibesquad/brainstorm-restart",
  "/__vibesquad/brainstorm-summary",
  "/__vibesquad/runner/spawn",
  /^\/__vibesquad\/runner\/agents\/[^/]+\/(input|cancel|meta|archive|unarchive|resume)$/,
]);
// ---- E6a: what a bug-tester device may reach (deny-by-default; docs/PLAN_E6_TESTER_ROLES.md) ----
// A tester is never the owner and never gets the read-only all-GET view: only these method + path pairs, on a canonical
// path, reach a handler, and every handler re-scopes to the caller's allowedTeams (runner-api.mjs handleTesterRunnerApi,
// handleTester* below). Anything else is 403 before routing.
const TESTER_RUNNER_AGENT_RE = /^\/__vibesquad\/runner\/agents\/rn-[A-Za-z0-9_-]{1,64}(\/timeline)?$/;
const TESTER_RUNNER_INPUT_RE = /^\/__vibesquad\/runner\/agents\/rn-[A-Za-z0-9_-]{1,64}\/input$/;
export const TESTER_ROUTE_ALLOWLIST = Object.freeze([
  Object.freeze({ methods: Object.freeze(["GET", "HEAD"]), path: "/api/auth/status" }),
  Object.freeze({ methods: Object.freeze(["GET", "HEAD"]), path: "/__vibesquad/auth/status" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: "/api/teams" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: "/__vibesquad/teams" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: "/__vibesquad/runner/status" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: "/__vibesquad/runner/events" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: "/__vibesquad/runner/agents" }),
  Object.freeze({ methods: Object.freeze(["GET"]), path: TESTER_RUNNER_AGENT_RE }),
  Object.freeze({ methods: Object.freeze(["POST"]), path: TESTER_RUNNER_INPUT_RE }),
  Object.freeze({ methods: Object.freeze(["POST"]), path: "/__vibesquad/tester/report" }),
  Object.freeze({ methods: Object.freeze(["GET", "POST"]), path: "/__vibesquad/tester/thread" }),
  Object.freeze({ methods: Object.freeze(["GET", "POST"]), path: "/__vibesquad/inbox" }),
  Object.freeze({ methods: Object.freeze(["POST"]), path: "/__vibesquad/inbox/attachment" }),
  Object.freeze({ methods: Object.freeze(["POST"]), path: "/__vibesquad/inbox/send" }),
]);
// ---- PTO v1.1: what an owner-playtest device (the Godot playtest addon) may reach (deny-by-default) ----
// docs/lanes/playtest-overlay/PLAN_V1_1_ROLE.md. Never the owner, never the read-only all-GET view, never a static file:
// only these method + path pairs, on a canonical path, reach a handler. Report/thread then still need a header token
// (ownerPlaytestPrincipal: no cookie, no relay, no agent headers). Anything else is 403 before routing.
export const PLAYTEST_ROUTE_ALLOWLIST = Object.freeze([
  Object.freeze({ methods: Object.freeze(["GET", "HEAD"]), path: "/api/auth/status" }),
  Object.freeze({ methods: Object.freeze(["GET", "HEAD"]), path: "/__vibesquad/auth/status" }),
  Object.freeze({ methods: Object.freeze(["POST"]), path: "/__vibesquad/tester/report" }),
  Object.freeze({ methods: Object.freeze(["GET", "POST"]), path: "/__vibesquad/tester/thread" }),
]);
export const playtestRouteAllowed = (method, path) =>
  PLAYTEST_ROUTE_ALLOWLIST.some((r) => r.methods.includes(String(method ?? "").toUpperCase()) && r.path === path);
export const testerRouteAllowed = (method, path) =>
  TESTER_ROUTE_ALLOWLIST.some((r) => r.methods.includes(String(method ?? "").toUpperCase()) && (r.path instanceof RegExp ? r.path.test(path) : r.path === path));
/** A path a tester route may be matched against: plain ASCII segments, no dot segments, encoding, doubled or back slashes, NUL. */
export const isCanonicalTesterPath = (path) =>
  typeof path === "string" &&
  /^\/[A-Za-z0-9\/_.-]*$/.test(path) &&
  !path.includes("//") &&
  !path.split("/").some((seg) => seg === "." || seg === "..") &&
  !/[%\\\u0000]/.test(path);

/** A path shape no tester route ever has: doubled or back slashes, %-encoding, NUL or a dot segment. */
const isSuspectPath = (path) => typeof path === "string" && (path.includes("//") || /[%\\\u0000]/.test(path) || path.split("/").some((seg) => seg === "." || seg === ".."));

export const agentWriteAllowed = (path) => AGENT_WRITE_ALLOWLIST.some((r) => (r instanceof RegExp ? r.test(path) : r === path));

const forbidden = (why) => Object.assign(new Error(why), { status: 403 });
const PLAYTEST_FORBIDDEN = "forbidden: owner-playtest device can only file playtest reports and use the reply thread";
const sameId = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
/** The verified agent caller of a request, or null for the owner (handlers treat null as today's owner path). */
const agentCaller = (req) => { const c = callerOf(req); return c?.kind === "agent" ? c : null; };

/**
 * X1c log attribution for a verified agent (`/log`, `/vs-log`; X1b routes the MCP `report` tool and `vs log` here):
 * `you` is the owner's. A lead/Buddy keeps today's types; `agent` is always the verified id. A plain worker logs only
 * `metric`, and `done`/`blocker` with refs forced to itself (noteWorkerDone then only ever closes the author); it never refs
 * another agent. A digest worker logs `done`/`metric` only, refs forced to the worker it digests (`digestFor`).
 */
export function agentLogFields(caller, { type, refs }) {
  const list = Array.isArray(refs) ? refs.map(String) : [];
  if (type === "you" || type === LEGACY_USER_TYPE) throw forbidden(`log type "${type}" is the owner's; an agent cannot write it`);
  if (caller.role === "lead" || caller.role === "brainstorm") return { agent: caller.id, type, refs: list };
  if (caller.digest) {
    if (type !== "done" && type !== "metric") throw forbidden(`a digest worker may only log done or metric, not ${type}`);
    return { agent: caller.id, type, refs: [String(caller.digestFor)] };
  }
  if (type === "done" || type === "blocker") return { agent: caller.id, type, refs: [caller.id] };
  if (type === "metric") return { agent: caller.id, type, refs: list.filter((r) => !isRunnerId(r) || r === caller.id) };
  throw forbidden(`a worker may only log done, blocker or metric, not ${type}; put it in your final message for your lead`);
}

/**
 * idea-476 (2): an agent's 'drained restart' (vs log restart-feedback, the MCP report tool) is refused with 409 while the
 * runner still holds background work in its lane (restart-coord drainedLogRefusal names each holder and pid), so a lead's
 * drain means drained. The held list and the roster come from the runner; either unreadable refuses too (fail closed:
 * nothing is recorded as drained on a guess). Any other entry, and the owner's shell, pass untouched.
 */
export async function drainedFeedbackGate(caller, type, text, backend, teams = null) {
  if (!caller || type !== "metric" || !isDrainedFeedback(text)) return;
  const b = backend ?? sharedRunnerBackend();
  let held = null;
  let agents = null;
  try {
    const h = await b.rc.request("GET", "/health", undefined, { restartWait: false });
    held = Array.isArray(h?.heldAgents) ? { ids: h.heldAgents, work: h.heldWork && typeof h.heldWork === "object" ? h.heldWork : {} } : null;
  } catch (e) { console.warn(`[vibesquad] drained gate: runner /health failed: ${e?.message ?? e}`); }
  if (held?.ids?.length) {
    // idea-475 R2: archived records too, so an archived holder's shell reads as a gone owner (ownerGone), not a live blocker.
    try { agents = await b.listAgents({ filter: { includeArchived: true } }); } catch (e) { console.warn(`[vibesquad] drained gate: agent list failed: ${e?.message ?? e}`); }
  }
  const why = drainedLogRefusal(caller.id, { held, agents, teams: teams ?? loadTeamsRegistry(), callerTeam: caller.team ?? null, callerLane: caller.lane ?? null });
  if (why) throw Object.assign(new Error(why), { status: 409 });
}

/**
 * idea-175: a digest's `done` entry starts with the digested worker's own verdict line (`PASS|FAIL H/M/L <hash>`), copied
 * byte-for-byte here in code, never the model's paraphrase; a disagreeing digest word is marked VERDICT-MISMATCH, and a
 * reviewer with no verdict line logs NO-VERDICT. Any other entry is unchanged. An unreadable worker report is marked UNVERIFIED.
 */
export async function verbatimDigestText(caller, type, text, backend) {
  if (!caller?.digest || type !== "done" || !caller.digestFor) return text;
  const id = String(caller.digestFor);
  try {
    const b = backend ?? sharedRunnerBackend();
    // idea-308: a windowed tail read (O(tail), not O(log)); only a tail with no assistant reply in it falls back to the full read.
    const [rec, tail] = await Promise.all([b.fetchAgent(id), b.fetchAgentTimeline(id, { direction: "tail", limit: 400 })]);
    const tl = tail?.hasOlder && !lastAssistantText(tail, Infinity) ? await b.fetchAgentTimeline(id, { direction: "tail" }) : tail;
    const worker = rec?.agent ?? rec;
    const profile = String(worker?.labels?.profile ?? worker?.profile ?? "").trim() || null;
    return digestVerdictText({ workerText: lastAssistantText(tl, Infinity), digestText: text, reviewer: isReviewerAgent(worker), profile }).text;
  } catch {
    return `UNVERIFIED (worker report unreadable): ${text}`;
  }
}

/**
 * X1c lane role check: the agent must be one of `roles` on exactly (team, lane), or the Squad's Overlord for any lane of its
 * Squad. The lane is resolved through the registry (id / alias / name / code) so an alias cannot name another Squad's lane.
 */
function assertAgentOnLane(caller, { teamId, lane }, rootDir, roles, what) {
  const teams = loadTeamsRegistry(rootDir);
  const hit = findLaneInRegistry(String(lane ?? ""), teams, String(teamId ?? "")) ?? null;
  const wantTeam = hit ? hit.team.id : String(teamId ?? "");
  const wantLane = hit ? hit.lane.id : String(lane ?? "");
  if (!wantTeam || !sameId(caller.team, wantTeam)) throw forbidden(`${what}: ${caller.id} is not in Squad "${wantTeam || teamId || "?"}"`);
  if (caller.overlord) return "overlord";
  if (!roles.includes(caller.role) || !sameId(caller.lane, wantLane)) {
    throw forbidden(`${what}: only the ${roles.join("/")} of lane "${wantLane}" (or the Squad's Overlord, or the owner) may do this; ${caller.id} is the ${caller.role ?? "worker"} of "${caller.lane ?? "?"}"`);
  }
  return "lane";
}

/**
 * idea-176: an agent's /log, /vs-log and /inbox write is bound to its own Squad (caller.team). The body's team, when given,
 * must be that Squad (any case); a missing one becomes the caller's. No grant widens this: the Overlord's one cross-Squad
 * grant is runner input to another Squad's live lead (runner/runner.mjs crossSquadInput), never a log or inbox write here.
 * The owner (caller null: app, phone, owner shell) keeps the body's team. Returns the team to write, or `bodyTeam` as given.
 */
function bindAgentTeam(caller, bodyTeam, what) {
  if (!caller) return bodyTeam;
  const own = String(caller.team ?? "").trim();
  if (!own) throw forbidden(`${what}: ${caller.id} has no Squad; an agent writes only its own Squad's ${what}`);
  const want = String(bodyTeam ?? "").trim();
  if (want && !sameId(want, own)) throw forbidden(`${what}: ${caller.id} is in Squad "${own}", not "${want}"; an agent writes only its own Squad's ${what}`);
  return own;
}

/** X1c: an agent's `callerId` must be the verified id (missing → filled in); never another agent's. */
function bindCallerId(caller, body, what) {
  if (!caller) return body;
  if (body.callerId != null && body.callerId !== "" && String(body.callerId) !== caller.id) throw forbidden(`${what}: callerId "${body.callerId}" is not the verified caller ${caller.id}`);
  return { ...body, callerId: caller.id };
}

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
  if (path === "/__vibesquad/devices" || path === "/__vibesquad/pair/pending") return true; // X1 E4a M3: device inventory, pending pairings
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
  // E6a: a bug-tester gets liveness and its own scope only: no port, LAN IPs, loop stats, stale paths or config warnings.
  if (testerDeviceOf(req)) return sendJson(res, distReady ? 200 : 503, { ok: distReady, distReady, localAccess: "bug-tester", ...deviceFields(req) });
  // PTO v1.1: an owner-playtest device likewise gets liveness and its own role only.
  if (playtestDeviceOf(req)) return sendJson(res, distReady ? 200 : 503, { ok: distReady, distReady, localAccess: OWNER_PLAYTEST_ROLE, ...deviceFields(req) });
  const { port } = netConfig();
  const warnings = getConfigWarnings();
  const send = (stale) => {
    const extra = {
      localAccess: localAccess(req),
      ...deviceFields(req),
      port,
      lanEnabled: exposure.lanEnabled,
      exposedIps: exposure.exposedIps,
      ...loopLagStats(),
      stale,
      ...(warnings.length ? { configWarnings: warnings } : {}),
    };
    if (!distReady) return sendJson(res, 503, { ok: false, distReady: false, error: "dist/index.html missing", ...extra });
    return sendJson(res, 200, { ok: true, distReady: true, ...extra });
  };
  // Read-only callers (incl. the remote proxy) get the cached value: git + stale.json stay with the owner and startup.
  if (!isOwner(req)) return send(peekStale(rootDir));
  // Owner: await the async, single-flight refresh (idea-225: git runs off the loop, never execFileSync on the request
  // path) so the reply and stale.json are current. refreshStale is cached 60s, so most polls resolve at once.
  return refreshStale({ rootDir })
    .catch(() => peekStale(rootDir))
    .then((stale) => send(stale))
    .catch(() => {});
}

// E5: the relay host's status() for the Host pill (serve.mjs registers it; null = no relay configured). Trusted callers only.
let relayStatus = null;
export function setRelayStatus(fn) {
  relayStatus = typeof fn === "function" ? fn : null;
  setRelayStatusProvider(relayStatus); // pair/start relay links (auth.mjs relayPairingFor) read the same status
}

export function handleAuthStatus(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const full = getAuthStatus(rootDir);
  if (!isTrusted(req)) return sendJson(res, 200, { ok: true, paired: false, hostId: full.hostId, distReady: full.distReady, caFingerprint: full.caFingerprint });
  // E6a: a bug-tester sees that it is paired and its scope; never the LAN / Meshnet addresses, installer links or relay detail.
  if (testerDeviceOf(req)) {
    return sendJson(res, 200, { ok: true, paired: true, hostId: full.hostId, distReady: full.distReady, caFingerprint: full.caFingerprint, localAccess: "bug-tester", ...deviceFields(req) });
  }
  // PTO v1.1: an owner-playtest device sees the same minimal shape (the addon reads `role` to warn on a full owner token).
  if (playtestDeviceOf(req)) {
    return sendJson(res, 200, { ok: true, paired: true, hostId: full.hostId, distReady: full.distReady, caFingerprint: full.caFingerprint, localAccess: OWNER_PLAYTEST_ROLE, ...deviceFields(req) });
  }
  let relay = null;
  try {
    relay = relayStatus?.() ?? null;
  } catch {}
  return sendJson(res, 200, { ...full, paired: true, localAccess: localAccess(req), ...deviceFields(req), relay });
}

export { teamsRevision, validateTeamsBody, writeTeamsRegistry };

// The teams registry the CLI and plugin read (see teams-file.mjs). Writes keep the other top-level keys.
// GET adds `revision`; a write that sends one must still match the file, or it gets 409 with the current registry.
function handleTeams(req, res, rootDir) {
  if (req.method === "GET") {
    const file = resolveTeamsFilePath(rootDir);
    const r = readJsonFileWithBom(file, { label: "teams.json", fallback: null, recordWarning: true });
    if (r.ok && r.data) {
      // hostId rides on the envelope only (never inside the lane/agent records; Overlord decision, E4a).
      return sendJson(res, 200, { ...r.data, folders: foldersOf(r.data), revision: teamsRevision(file), hostId: getHostId() });
    }
    // idea-242 L1: the read/parse detail (Node's fs message names the path) goes to the server log only.
    console.warn(`[vibesquad] GET teams: ${file}: ${r.detail || r.error || "no registry data"}`);
    return sendJson(res, 500, { error: "teams.json is unreadable or invalid; see the server log" });
  }
  if (req.method === "PATCH") return handleTeamsPatch(req, res, rootDir);
  if (req.method !== "POST" && req.method !== "PUT") {
    res.statusCode = 405;
    return res.end();
  }
  readBody(req).then(async (parsed) => {
    try {
      validateTeamsBody(Array.isArray(parsed) ? parsed : parsed?.teams); // the caller's fault: 400 with the reason
      if (!Array.isArray(parsed) && parsed?.folders !== undefined) validateFoldersBody(parsed.folders); // B11a
    } catch (e) {
      res.statusCode = 400;
      return res.end(String(e));
    }
    let result;
    try {
      result = await writeTeamsRegistryAsync(parsed, rootDir);
    } catch (e) {
      // idea-232 L3 (X1 E4a R2 L3 parity): a lock timeout or write failure is a generic retryable 503. file-lock's
      // message carries the lock path and holder pid, so the detail goes to the server log only.
      console.warn(`[vibesquad] teams.json write failed: ${e?.message ?? e}`);
      return sendJson(res, 503, { error: "teams registry busy or unwritable; retry", retryable: true });
    }
    if (result.status === 200) {
      try {
        seedHubBriefs(result.prevTeams, result.body.teams, rootDir);
      } catch (e) {
        console.warn(`[vibesquad] hub brief seed failed after a teams write: ${e?.message ?? e}`); // the write landed
      }
    }
    sendJson(res, result.status, result.body);
  }, (e) => {
    res.statusCode = e?.status === 413 ? 413 : 400;
    res.end(String(e?.message ?? e));
  });
}

// B11a: PATCH /api/teams — one folder op (createFolder | renameFolder | deleteFolder | setFolderAsleep | setTeamFolder),
// applied to the current registry under the teams.json lock. Owner-only like PUT (not in AGENT_WRITE_ALLOWLIST; testers GET only).
function handleTeamsPatch(req, res, rootDir) {
  readBody(req).then(async (op) => {
    let result;
    try {
      result = await patchTeamsRegistryAsync(op, rootDir);
    } catch (e) {
      console.warn(`[vibesquad] teams.json folder write failed: ${e?.message ?? e}`);
      return sendJson(res, 503, { error: "teams registry busy or unwritable; retry", retryable: true });
    }
    sendJson(res, result.status, result.body);
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
    // idea-242 L1: a 500 is an fs fault whose message names the path (rename/write of settings.json): log it, answer generic.
    // The 409/413 messages are ours and path-free (readJsonFileWithBom's `error` carries no path).
    if (status === 500) {
      console.warn(`[vibesquad] settings save failed: ${e?.message ?? e}`);
      return sendJson(res, 500, { ok: false, error: "settings save failed; see the server log" });
    }
    return sendJson(res, status, { ok: false, error: String(e?.message ?? e) });
   }
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

async function handleLog(req, res, opts = {}) {
  try {
    if (req.method === "GET") {
      const team = new URL(req.url, "http://x").searchParams.get("team") ?? "";
      if (!TEAM_ID.test(team)) return sendJson(res, 400, { error: "bad team" });
      const file = join(teamDir(team), "log.jsonl");
      if (!existsSync(file)) return sendJson(res, 200, []);
      // Tail from EOF, async (unit-loop-stall): the UI polls this, and reading the whole multi-MB log stalled the loop.
      const lines = await tailLines(file, 100);
      const out = [];
      for (const l of lines) {
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
      return sendJson(res, 200, out);
    }
    if (req.method === "POST") {
      const { team: bodyTeam, type = "you", text, refs, agent = loadUserSettings().userName, lane = "" } = await readCleanBody(req);
      // X1c: a verified agent is attributed by the server (never the body), with the worker/digest/lead rules.
      const caller = agentCaller(req);
      const team = bindAgentTeam(caller, bodyTeam, "log"); // idea-176
      if (!TEAM_ID.test(String(team))) return sendJson(res, 400, { error: "bad team" });
      if (!LOG_TYPES.has(type) || !UI_LOG_TYPES.has(type)) return sendJson(res, 400, { error: `type ${type} not allowed from the UI` });
      const t = String(text ?? "").trim();
      if (!t) return sendJson(res, 400, { error: "empty text" });
      if (t.length > 240) return sendJson(res, 400, { error: `text is ${t.length} chars, limit 240` });
      const who = caller ? agentLogFields(caller, { type, refs }) : { agent: String(agent), type, refs: Array.isArray(refs) ? refs.map(String) : [] };
      await drainedFeedbackGate(caller, who.type, t, opts.backend); // idea-476: a drain is only logged once the lane holds nothing
      const { entry } = appendVsLogEntry({
        teamId: String(team),
        laneId: String(lane || team),
        agent: who.agent,
        type: who.type,
        text: await verbatimDigestText(caller, who.type, t, opts.backend),
        refs: who.refs,
      });
      return sendJson(res, 200, entry);
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    if (sendServerFsError(res, e, "log")) return; // idea-249: an fs fault names the host path; log it, answer generic
    sendJson(res, e?.status === 403 || e?.status === 409 ? e.status : 400, { error: String(e?.message ?? e) });
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

// Runner roster for the sync root getters below. Callers read the last completed scan; one scan feeds navRoots and
// liveRunnerAgents. unit-roster-no-refold: at most ONE scan runs at a time and later callers share it. A fresh request (a 403
// retry: a scan already in flight listed the dir before the new agent existed) gets one follow-up scan after the current one,
// shared by every fresh caller that arrived meanwhile. A scan asks the live runner (it holds every agent folded); while the runner
// is booting it folds nothing (that fold competed with the runner's own boot fold) and the last roster stands; only with the
// runner down does it fold the logs, and then only the bytes appended since the last read (roster-index.mjs).
let runnerRoster = { at: 0, agents: [] };
let rosterInflight = null;
let rosterFollowUp = null;
let rosterEpoch = 0;
const rosterDeps = { runner: () => sharedRunnerBackend(), home: () => runnerHome(), discovery: readDiscovery, booting: (home) => bootingHolder(home), fold: () => listRunnerAgents() };
let rosterScans = { runner: 0, fold: 0, skippedBooting: 0 };
/** The runner's roster, null while it boots (keep the last one), else the index fold. */
async function scanRunnerRoster() {
  const home = rosterDeps.home();
  if (rosterDeps.discovery(home)) {
    try {
      const agents = await rosterDeps.runner().listAgents();
      rosterScans.runner++;
      return agents;
    } catch { /* stale runner.json (a new runner is booting), hung or refused: judged below */ }
  }
  if (rosterDeps.booting(home)) { rosterScans.skippedBooting++; return null; }
  rosterScans.fold++;
  return rosterDeps.fold();
}
function refreshRunnerRoster(fresh = false) {
  if (rosterInflight && fresh) {
    rosterFollowUp ??= rosterInflight.then(() => { rosterFollowUp = null; return refreshRunnerRoster(); });
    return rosterFollowUp;
  }
  if (rosterInflight) return rosterInflight;
  const epoch = rosterEpoch;
  const p = scanRunnerRoster()
    .then((agents) => {
      if (epoch !== rosterEpoch || !agents) return;
      runnerRoster = { at: Date.now(), agents: agents.filter((a) => !a.archivedAt) };
      navRootsCache.clear();
    })
    .catch(() => {})
    .finally(() => { if (rosterInflight === p) rosterInflight = null; });
  rosterInflight = p;
  return p;
}
/** Live (non-archived) runner agents; kicks a background rescan when older than 30s (the stale list is served meanwhile). */
function runnerRosterNow(now = Date.now()) {
  if (now - runnerRoster.at >= 30_000) refreshRunnerRoster();
  return runnerRoster.agents;
}
export const _runnerRosterReady = (fresh = false) => refreshRunnerRoster(fresh);

// Quick open / find in files call per keystroke: reuse the roots for 30s. getter(true) (a 403 miss, file-search.mjs) awaits a
// brand-new scan, so a worktree created a moment ago is allowed on the retry.
const navRootsCache = new Map();
function buildNavRoots(rootDir, opts) {
  // Runner (rn-) agents are the default and often sit in worktrees outside the project roots.
  let runnerCwds = [];
  try { runnerCwds = [...new Set(runnerRosterNow().map((a) => a.cwd))].map(realOrNull).filter(Boolean); } catch {}
  // A home dir or drive root as a browse root would expose everything under it.
  const roots = [...new Set([...allowedAttachRoots(rootDir, opts), ...runnerCwds])].filter((r) => !isUnsafeRoot(r));
  navRootsCache.set(rootDir, { at: Date.now(), roots });
  return roots;
}
const navRoots = (rootDir, opts) => (fresh) => {
  if (fresh) return refreshRunnerRoster(true).then(() => buildNavRoots(rootDir, opts));
  const hit = navRootsCache.get(rootDir);
  if (hit && Date.now() - hit.at < 30_000) return hit.roots;
  return buildNavRoots(rootDir, opts);
};
export const _navRootsForTest = (rootDir, opts) => navRoots(rootDir, opts);
export const _liveRunnerAgentsForTest = (now) => liveRunnerAgents(now);

/**
 * Other worktrees a relative file link may point into when the file is missing under `cwd`: the managed sanctuary
 * dirs for the same repo, plus cwds of live agents in the same team + lane. Lane cwds must already be allowed roots.
 */
function liveRunnerAgents(now = Date.now()) {
  return runnerRosterNow(now);
}
export const _resetLaneAgentsCache = () => { rosterEpoch++; rosterInflight = null; rosterFollowUp = null; rosterScans = { runner: 0, fold: 0, skippedBooting: 0 }; runnerRoster = { at: 0, agents: [] }; navRootsCache.clear(); };
/** Test seam: override how a roster scan reaches the runner / judges boot / folds (unset keys keep production), and its counters. */
export const _rosterDepsForTest = (over = {}) => { const prev = { ...rosterDeps }; Object.assign(rosterDeps, over); return () => Object.assign(rosterDeps, prev); };
export const _rosterScansForTest = () => ({ ...rosterScans });

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
    try { const cwd = await readRunnerCwd(id); if (cwd) return cwd; } catch {} // on-disk record: no HTTP round trip
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
      return sendFor(req, res, 200, { // idea-249 M1: the packet path is the owner's HandoffModal only
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
    // X1c: the owner, that lane's lead (for itself), or the Squad's Overlord (for the lane's lead) may run the handoff.
    const caller = agentCaller(req);
    if (caller) {
      if (caller.role !== "lead" || !sameId(caller.team, team)) throw forbidden(`handoff: only the lead of ${team}/${lane}, the Squad's Overlord, or the owner may run it; ${caller.id} is the ${caller.role ?? "worker"} of ${caller.team ?? "?"}/${caller.lane ?? "?"}`);
      if (!caller.overlord) {
        if (!sameId(caller.lane, lane)) throw forbidden(`handoff: ${caller.id} leads ${caller.lane ?? "?"}, not ${lane}`);
        if (body.agentId !== undefined && String(body.agentId) !== caller.id) throw forbidden("handoff: a lead hands off itself only");
        body.agentId = caller.id;
      }
    }
    const cli = join(rootDir, "cli", "vs.mjs");
    if (!existsSync(cli)) return sendFor(req, res, 200, { exists: existsSync(packet), path: packet, ran: false, note: "cli/vs.mjs not found" });
    if (handoffRunning) return sendJson(res, 429, { error: "a handoff is already running; try again when it finishes" });
    handoffRunning = true;
    lastHandoffError = null;
    const run = runVsHandoff(cli, rootDir, { ...process.env, ...(body.agentId ? { PASEO_AGENT_ID: String(body.agentId) } : {}) })
      .then(
        () => ({ done: true }),
        (err) => {
          // idea-249: execFile's message is "Command failed: <node path> <cli path> handoff" plus stderr: log it, keep the exit only.
          console.warn(`[vibesquad] vs handoff failed: ${err?.message ?? err}`);
          lastHandoffError = `vs handoff ${err?.killed ? "timed out" : `exited ${err?.code ?? "with an error"}`}; see the server log`;
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
    if (!outcome.done) return sendFor(req, res, 202, { exists: existsSync(packet), path: packet, accepted: true, running: true });
    if (outcome.error) return sendJson(res, 500, { error: outcome.error });
    sendFor(req, res, 200, { exists: existsSync(packet), path: packet, ran: true });
  } catch (e) {
    sendCaughtError(req, res, e, "handoff"); // idea-249 L2: a 403 or a bad/oversized body keeps its status; the rest is generic
  }
}

async function handleBrainstormSummary(req, res, rootDir) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const lane = q.get("lane") || q.get("laneId") || "vibesquad";
      const teamId = q.get("teamId") || q.get("team") || "";
      const s = readBrainstormSummary(lane, rootDir, { teamId });
      // cwd: the folder a never-spawned lane (a Squad hub with no agents yet) starts in; null when the registry names none that exists.
      // idea-249 M2: the lane cwd is a host path: the owner's UI only (s.path is repo-relative and stays).
      return sendFor(req, res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content, revision: contentRevision(s.content), cwd: laneWorkingDir(teamId, s.laneId, rootDir) }, rootDir);
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readCleanBody(req);
      const lane = body.laneId || body.lane || "vibesquad";
      const teamId = String(body.teamId || body.team || "");
      const content = String(body.content ?? "");
      // X1c: an agent writes only its own lane's brief (as its Buddy or lead), or any lane of its Squad as the Overlord.
      const caller = agentCaller(req);
      if (caller) assertAgentOnLane(caller, { teamId, lane }, rootDir, ["brainstorm", "lead"], "brainstorm-summary");
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
      return sendFor(req, res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content, revision: contentRevision(s.content), ...(s.fallback ? { fallback: true } : {}) }, rootDir);
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    if (sendServerFsError(res, e, "brainstorm-summary")) return; // idea-249: an fs fault names the host path; log it, answer generic
    sendJson(res, e?.status === 403 ? 403 : 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleVsLog(req, res, opts = {}) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const team = q.get("team") || q.get("teamId") || "vibesquad";
      const lane = q.get("lane") || q.get("laneId") || team;
      if (!TEAM_ID.test(team) || !TEAM_ID.test(lane)) return sendJson(res, 400, { ok: false, error: "bad team/lane" });
      const baseHome = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
      const file = join(baseHome, "logs", `${team}--${lane}.jsonl`);
      if (!existsSync(file)) return sendJson(res, 200, { ok: true, entries: [] });
      const entries = (await tailLines(file, 100))
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
      // X1c: a verified agent is attributed by the server (never the body), with the worker/digest/lead rules.
      const caller = agentCaller(req);
      const teamId = (caller ? bindAgentTeam(caller, body.teamId || body.team, "vs-log") : body.teamId || body.team) || "vibesquad"; // idea-176
      const laneId = body.laneId || body.lane || teamId;
      if (!TEAM_ID.test(String(teamId)) || !TEAM_ID.test(String(laneId))) return sendJson(res, 400, { ok: false, error: "bad team/lane" });
      const type = body.type || "metric";
      const text = String(body.text ?? "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "empty text" });
      const who = caller ? agentLogFields(caller, { type, refs: body.refs }) : { agent: body.agent || body.agentId || loadUserSettings().userName, type, refs: body.refs };
      await drainedFeedbackGate(caller, who.type, text, opts.backend); // idea-476: a drain is only logged once the lane holds nothing
      const resEntry = appendVsLogEntry({
        teamId,
        laneId,
        agent: who.agent,
        type: who.type,
        text: await verbatimDigestText(caller, who.type, text, opts.backend),
        refs: who.refs,
      });
      return sendJson(res, 200, { ok: true, entry: resEntry.entry }); // idea-242 L1: no host log path in the answer
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    if (sendServerFsError(res, e, "vs-log")) return; // idea-249: an fs fault names the host path; log it, answer generic
    sendJson(res, e?.status === 403 || e?.status === 409 ? e.status : 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleBrainstormRestart(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    // X1c: an agent's callerId is the verified id (a lead's own record then decides, as before); the owner keeps today's path.
    const body = bindCallerId(agentCaller(req), await readCleanBody(req), "buddy restart");
    if (body?.agentId != null && body.agentId !== "" && !AGENT_ID_STRICT.test(String(body.agentId))) {
      return sendJson(res, 400, { ok: false, error: "bad agentId" });
    }
    // O5: a denied callerId must not spend a budget slot (a worker could otherwise exhaust it and block real restarts).
    await authorizeBuddyRestartRequest(body, rootDir);
    if (body.reason === "start-brainstorm" || body.agentId === "start-brainstorm") {
      if (overSpawnBudget(res)) return;
    } else {
      // A restart archives the old Buddy and spawns a new one: it spends from both budgets.
      if (overArchiveBudget(res)) return;
      if (overSpawnBudget(res)) return;
    }
    const result = await performBrainstormRestart(body, rootDir);
    // ok:false (e.g. agent-list-unavailable) must not look like success to the UI.
    return sendFor(req, res, result?.ok === false ? 503 : 200, result, rootDir); // idea-249 M3: no host path to an agent
  } catch (e) {
    return sendCaughtError(req, res, e, "buddy restart", { fallback: 400, rootDir }); // idea-249 M3/L2
  }
}

async function handleLeadHandoff(req, res, rootDir, actionOverride) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    // X1c: an agent's callerId is the verified id (performLeadHandoffHttp then re-checks self/Buddy/Overlord from its record);
    // a takeover is confirmed by the successor itself. The owner keeps today's path.
    const caller = agentCaller(req);
    const body = bindCallerId(caller, await readCleanBody(req), "lead-handoff");
    if (caller && (actionOverride === "confirm" || body.action === "confirm" || body.confirmSuccessorId)) {
      const succ = String(body.confirmSuccessorId || body.successorId || body.agentId || "");
      if (succ !== caller.id) throw forbidden(`lead-handoff: only the successor (${succ || "?"}) or the owner confirms its takeover, not ${caller.id}`);
    }
    const result = await performLeadHandoffHttp(
      actionOverride ? { ...body, action: actionOverride } : { httpWaitMs: 2000, ...body },
      rootDir,
    );
    const status = result?.status || (result?.accepted ? 202 : 200);
    return sendFor(req, res, status, result, rootDir); // idea-249 M3: packetPath, the successor's cwd/prompt: owner only
  } catch (e) {
    return sendCaughtError(req, res, e, "lead-handoff", { fallback: 400, rootDir }); // idea-249 M3/L2: a 409 floor refusal stays 409
  }
}

/**
 * idea-235 (idea-232 parity) / idea-249: a server-side fault is the server's problem, not the caller's. Node's fs messages
 * (and file-lock's) carry the host path and holder pid, so the detail goes to the server log and the caller gets a generic
 * answer. sendServerError always sends; sendServerFsError sends only for an fs/lock fault (isServerSideFsError) and leaves
 * the handler's own path-free validation text (a 400/403/404 about the caller's input) to the caller. Both return true when
 * they sent the response.
 */
function sendServerError(res, e, what, { status = 500, error = `${what} failed; see the server log`, retryable = false } = {}) {
  console.warn(`[vibesquad] ${what} failed: ${e?.message ?? e}`);
  if (!res.headersSent) sendJson(res, status, { ok: false, error, ...(retryable ? { retryable: true } : {}) });
  return true;
}
function sendServerFsError(res, e, what, opts) {
  return isServerSideFsError(e) ? sendServerError(res, e, what, opts) : false;
}
const INBOX_BUSY = { status: 503, error: "inbox busy or unwritable; retry", retryable: true };

/**
 * idea-249 (fix round): a handler's catch-all that keeps the status of the caller's own mistake. An fs/lock fault is a
 * generic 500 (sendServerError). An error that carries a 4xx status (403 forbidden, 404, 409 refusal, 413 body, a runner's
 * 4xx answer) or a bad JSON body (SyntaxError → 400) keeps its status and text; a plain Error of ours keeps its text at
 * `fallback` when that is a 4xx (the handler's validation). Anything else (system, programming, 5xx runner error) is logged
 * and answered generically. A non-owner caller's text still passes redactHostPaths.
 */
function sendCaughtError(req, res, e, what, { fallback = 500, rootDir = REPO_ROOT } = {}) {
  if (isServerSideFsError(e)) return sendServerError(res, e, what);
  const st = Number(e?.status);
  const ours = e?.constructor === Error && e.code === undefined;
  const status = st >= 400 && st < 500 ? st : e instanceof SyntaxError ? 400 : ours && fallback < 500 ? fallback : 0;
  if (!status) return sendServerError(res, e, what, st >= 500 && st < 600 ? { status: st } : undefined);
  if (!res.headersSent) sendFor(req, res, status, { ok: false, error: String(e?.message ?? e) }, rootDir);
  return true;
}

// ---- idea-249 (fix round): a non-owner caller (agent, read-only device) never gets a host path ----
/** The owner (app, phone, owner shell) per the resolved caller; an agent, a read-only device or an unresolved request is not. */
const ownerRequest = (req) => callerOf(req)?.kind === "owner";
export { redactHostPaths };
/** sendJson that keeps host-path fields for the owner only (idea-249: settings path, packet path, lane cwd are owner UI). */
function sendFor(req, res, status, data, rootDir = REPO_ROOT) {
  return sendJson(res, status, ownerRequest(req) ? data : redactHostPaths(data, rootDir));
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
      // idea-176: a verified agent parks ideas in its own Squad only (body team checked, lanes resolved in that Squad).
      const caller = agentCaller(req);
      const scope = caller ? { teamId: bindAgentTeam(caller, body.teamId, "inbox") } : {};
      const result = await addInboxCardsAsync(body, rootDir, scope);
      return sendJson(res, 200, result);
    }
    res.statusCode = 405;
    res.end();
  } catch (e) {
    if (sendServerFsError(res, e, `inbox ${req.method === "GET" ? "list" : "add"}`, INBOX_BUSY)) return;
    return sendJson(res, e?.status === 403 ? 403 : 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxTriage(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    // X1c: an agent triages only as a lead/Buddy of the cards' Squad; delete is the owner's. idea-137: the role check
    // comes first, before the body is parsed and before any action/card validation can answer a worker with a 400/404.
    const caller = agentCaller(req);
    if (caller) assertInboxTriageRole(caller);
    const body = await readCleanBody(req);
    if (caller) {
      if (String(body.action || "").trim() === "delete") throw forbidden("inbox delete is owner-only; archive it instead");
      assertInboxTriageCaller(caller, triageCardIds(body));
    }
    const result = await triageInboxCardsAsync(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    if (sendServerFsError(res, e, "inbox triage", INBOX_BUSY)) return;
    return sendJson(res, e?.status === 403 ? 403 : e?.status === 404 ? 404 : 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleInboxSend(req, res, rootDir) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readCleanBody(req);
    const result = await sendInboxCard(body, rootDir);
    return sendJson(res, 200, result);
  } catch (e) {
    if (sendServerFsError(res, e, "inbox send", INBOX_BUSY)) return;
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

function readRawBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        fail(Object.assign(new Error("attachment too large (8 MB max)"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !done && ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function handleInboxAttachment(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const mime = String(req.headers["content-type"] || "");
    const cardId = new URL(req.url, "http://x").searchParams.get("cardId") || "";
    const bytes = await readRawBody(req, INBOX_MEDIA_MAX_BYTES);
    return sendJson(res, 200, await attachInboxMedia({ cardId, mime, bytes }));
  } catch (e) {
    if (sendServerFsError(res, e, "inbox attachment", INBOX_BUSY)) return;
    return sendJson(res, e?.status === 413 ? 413 : 400, { ok: false, error: String(e?.message ?? e) });
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
    return sendServerError(res, e, "push vapid key"); // idea-249
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
    if (sendServerFsError(res, e, "push subscribe")) return; // idea-249: an fs fault names the host path; log it, answer generic
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
    if (sendServerFsError(res, e, "push unsubscribe")) return; // idea-249: an fs fault names the host path; log it, answer generic
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
    return sendCaughtError(req, res, e, "push test"); // idea-249 L2
  }
}

async function handleProfiles(req, res) {
  try {
    if (req.method === "GET") {
      const state = loadProfiles(undefined, { autoImportPaseo: true, listBuiltins: true }); // idea-274
      const diff = diffProfiles(state.profiles, state.paseoProfiles);
      const warningsByProfile = { ...(state.warningsByProfile ?? {}) };
      for (const d of diff) {
        if (d.warnings?.length) warningsByProfile[d.name] = d.warnings;
      }
      return sendFor(req, res, 200, { // idea-249 M2: the profiles path is the owner's settings screen only
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
      return sendFor(req, res, 200, { // idea-249 M2: the profiles path is the owner's settings screen only
        ok: true,
        path: saved.path,
        profiles: saved.profiles,
      });
    }
    res.statusCode = 405;
    return res.end();
  } catch (e) {
    if (sendServerFsError(res, e, "profiles")) return; // idea-249: an fs fault names the host path; log it, answer generic
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
      return sendFor(req, res, 200, { // idea-249 M2: the profiles path is the owner's settings screen only
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
      return sendFor(req, res, 200, { // idea-249 M2: the profiles path is the owner's settings screen only
        ok: true,
        mode: "default",
        path: seeded.path,
        profiles: seeded.profiles,
        warningsByProfile: {},
      });
    }
    const saved = saveProfiles({ profiles: finalProfiles });
    return sendFor(req, res, 200, { // idea-249 M2: the profiles path is the owner's settings screen only
      ok: true,
      mode: "paseo",
      path: saved.path,
      profiles: saved.profiles,
      warningsByProfile: imported.warningsByProfile,
    });
  } catch (e) {
    if (sendServerFsError(res, e, "profiles import")) return; // idea-249: an fs fault names the host path; log it, answer generic
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
    if (sendServerFsError(res, e, "profiles diff")) return; // idea-249: an fs fault names the host path; log it, answer generic
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
  const built = findBuiltApk(rootDir);
  if (built) return built;
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
  const sha = artifactSha256(file, stat);
  if (sha) res.setHeader("x-vibesquad-sha256", sha);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

/** The APK download path, case-insensitive (phones lowercase typed URLs: /vibesquad.apk). */
export const isAndroidApkPath = (path) => /^\/(?:__vibesquad\/android\/)?vibesquad\.apk$/i.test(path);

// sha256 of a served download artifact (APK, desktop installer): x-vibesquad-apk-sha256 and the pair dialog's
// per-artifact SHA-256 (idea-384). Never hashes on the request path: trust the build sidecar (<file>.sha256) when it is
// at least as new as the file, else hash by stream in the background (header / field omitted until ready).
// Cache is keyed by path+mtime+size so the hash always matches the bytes served.
const artifactHashCache = new Map();
const artifactHashPending = new Map(); // `${file}|${key}` -> Promise<string> ("" on read error)
function cachedArtifactSha256(file, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = artifactHashCache.get(file);
  if (hit?.key === key) return { key, hash: hit.hash };
  try {
    const side = `${file}.sha256`;
    if (existsSync(side) && statSync(side).mtimeMs >= stat.mtimeMs) {
      const hash = readFileSync(side, "utf8").trim().split(/\s+/)[0].toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hash)) {
        artifactHashCache.set(file, { key, hash });
        return { key, hash };
      }
    }
  } catch {}
  return { key, hash: "" };
}
function hashArtifactInBackground(file, key) {
  const pend = `${file}|${key}`;
  let p = artifactHashPending.get(pend);
  if (p) return p;
  p = new Promise((done) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => {
        const hash = h.digest("hex");
        artifactHashCache.set(file, { key, hash });
        artifactHashPending.delete(pend);
        done(hash);
      })
      .on("error", () => {
        artifactHashPending.delete(pend);
        done("");
      });
  });
  artifactHashPending.set(pend, p);
  return p;
}
/** Lowercase hex SHA-256 of `file` if known now, else "" (and a background hash starts). */
function artifactSha256(file, stat) {
  const { key, hash } = cachedArtifactSha256(file, stat);
  if (hash) return hash;
  void hashArtifactInBackground(file, key);
  return "";
}
/** Lowercase hex SHA-256 of `file`, waiting for the stream hash when not cached; "" when missing/unreadable. */
async function artifactSha256Async(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return "";
  }
  const { key, hash } = cachedArtifactSha256(file, stat);
  return hash || hashArtifactInBackground(file, key);
}

/** idea-384: SHA-256 (lowercase hex) of the files /VibeSquad-setup.exe and /VibeSquad.apk serve, for the pair dialog. */
export function downloadArtifactSha256s(rootDir = REPO_ROOT) {
  const one = (file) => {
    try {
      return existsSync(file) ? artifactSha256(file, statSync(file)) || null : null;
    } catch {
      return null;
    }
  };
  return { desktopInstaller: one(resolveDesktopInstallerPath(rootDir)), androidApk: one(resolveAndroidApkPath(rootDir)) };
}
/** Same, waiting for any in-flight hash (bounded by `timeoutMs`; a slow disk yields null, never a stale hash). */
export async function downloadArtifactSha256sAsync(rootDir = REPO_ROOT, { timeoutMs = 10_000 } = {}) {
  const one = async (file) => {
    if (!existsSync(file)) return null;
    let timer;
    const timeout = new Promise((done) => (timer = setTimeout(() => done(""), timeoutMs)));
    try {
      return (await Promise.race([artifactSha256Async(file), timeout])) || null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [desktopInstaller, androidApk] = await Promise.all([one(resolveDesktopInstallerPath(rootDir)), one(resolveAndroidApkPath(rootDir))]);
  return { desktopInstaller, androidApk };
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
  const sha = artifactSha256(file, stat);
  if (sha) res.setHeader("x-vibesquad-apk-sha256", sha);
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
  // idea-384: https off-loopback; the LAN/Meshnet plain-http listener no longer serves the installer (it 301s to https).
  const downloadUrl = `${ip === "127.0.0.1" ? "http" : "https"}://${ip}:${port}/__vibesquad/desktop/VibeSquad-setup.exe`;
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
    const cwd = readRunnerCwdSync(id);
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
    if (sendServerFsError(res, e, "scripts")) return; // idea-249: an fs fault names the host path; log it, answer generic
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

// ---- E6a: bug-tester handlers (docs/PLAN_E6_TESTER_ROLES.md) ----
// Reached only through testerGated (TESTER_ROUTE_ALLOWLIST). Every one re-scopes to caller.allowedTeams and the Squad's bug
// lane, stamps the tester server-side, and answers with the tester's own data only (never the owner's inbox, registry
// paths, other Squads' cards or agent internals); free text going back out is host-path redacted.
const TESTER_REPORT_MAX_BYTES = Math.ceil(INBOX_MEDIA_MAX_BYTES / 3) * 4 + MAX_BODY_BYTES; // base64 screenshot + the JSON around it
const TESTER_TEXT_MAX_CHARS = 8000;
const TESTER_SOURCE = "alpha-tester";
const TESTER_THREAD_DEFAULT = 50;
const TESTER_THREAD_MAX = 200;
const TESTER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const testerStatus = (msg, status) => Object.assign(new Error(msg), { status });
const redactTester = (t) => redactHostPathTokens(String(t ?? ""));
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const testerName = (caller) => String(caller?.name ?? "").replace(/[\r\n\]]/g, " ").trim() || "tester";
/** The card header every tester card starts with (server-stamped). */
const testerStamp = (caller) => `[Alpha Tester: ${testerName(caller)}]`;

// ---- PTO-B1: the local owner on the same report/thread handlers (docs/lanes/playtest-overlay/PLAN_V1.md) ----
// The owner's in-game playtest dock (loopback + the per-install local token, auth.mjs isLocalOwner; PTO-B1b: or a paired
// owner device that authenticated with a header token) files reports and reads the reply thread through the handlers below
// with a synthetic caller that carries only its principal ("local-owner" or "device:<id>", never a secret). Differences from a tester: `teamId` is required
// (400 missing, 404 unknown; no default Squad), the card is stamped `[Owner playtest]` with source `owner-playtest` and the
// server-only meta `ownerPlaytest: true` + `ownerPlaytestBy: <principal>` (never testerDeviceId), clientReportId dedupes per
// (owner principal, Squad), a thread POST
// may tag only an owner-playtest card of that Squad and is sent as an owner line `[Owner playtest(· card:<id>)] `.
const OWNER_PLAYTEST_SOURCE = "owner-playtest";
const OWNER_PLAYTEST_STAMP = "[Owner playtest]";
const OWNER_PLAYTEST_LOCAL = "local-owner";
/** The synthetic handler caller for one owner principal: OWNER_PLAYTEST_LOCAL or `device:<device id>`. */
const ownerPlaytestCaller = (principal) => Object.freeze({ kind: "owner-playtest", principal });
/** The principal that filed an owner-playtest card. A B1 card (before ownerPlaytestBy existed) was the local owner's. */
const ownerPlaytestByOf = (c) => (typeof c?.ownerPlaytestBy === "string" ? c.ownerPlaytestBy : OWNER_PLAYTEST_LOCAL);
const isOwnerPlaytest = (caller) => caller?.kind === "owner-playtest";
/** True for an owner-playtest report card (server meta only: a body can never set ownerPlaytest, see addInboxCardsAsync). */
const isOwnerPlaytestCard = (c) => c?.ownerPlaytest === true && c.source === OWNER_PLAYTEST_SOURCE && !c.testerDeviceId;
const ownerPlaytestChatPrefix = (cardId = null) => (cardId ? `[Owner playtest · card:${cardId}] ` : "[Owner playtest] ");
/** The card id an owner-playtest chat line carries (`[Owner playtest · card:<id>] ...`), or null. */
const ownerPlaytestChatCardId = (text) => /^\[Owner playtest · card:(idea-\d{1,12})\] /.exec(String(text ?? ""))?.[1] ?? null;

/** The registry records of the caller's allowedTeams (runner-api testerTeamRecords over teams.json). */
function testerTeamsOf(caller, rootDir) {
  return testerTeamRecords(caller, loadTeamsForInbox(rootDir));
}

/** The allowed Squad a tester request names (`teamId`, default its first): 403 outside allowedTeams, 404 gone, 409 no bug lane. */
function testerTeamFor(caller, teamId, rootDir) {
  if (isOwnerPlaytest(caller)) return ownerPlaytestTeamFor(teamId, rootDir);
  const allowed = (caller?.allowedTeams ?? []).map((t) => String(t).trim().toLowerCase());
  const want = typeof teamId === "string" && teamId.trim() ? teamId.trim().toLowerCase() : allowed[0] ?? "";
  if (!want || !allowed.includes(want)) throw testerStatus("forbidden: that Squad is not on this tester's invite", 403);
  const team = testerTeamsOf(caller, rootDir).find((t) => String(t.id).trim().toLowerCase() === want);
  if (!team) throw testerStatus(`Squad "${want}" not found`, 404);
  const laneId = resolveBugLaneId(team);
  if (!laneId) throw testerStatus(`Squad "${team.id}" has no bug lane`, 409);
  return { team, laneId };
}

/** PTO-B1: the Squad an owner playtest request names. `teamId` is required: 400 missing, 404 unknown, 409 no bug lane. */
function ownerPlaytestTeamFor(teamId, rootDir) {
  if (typeof teamId !== "string" || !teamId.trim()) throw testerStatus("teamId is required", 400);
  const want = teamId.trim().toLowerCase();
  const team = TEAM_ID_OK.test(want) ? loadTeamsForInbox(rootDir).find((t) => t && String(t.id ?? "").trim().toLowerCase() === want) : null;
  if (!team) throw testerStatus(`Squad "${redactTester(want.slice(0, 64))}" not found`, 404);
  const laneId = resolveBugLaneId(team);
  if (!laneId) throw testerStatus(`Squad "${team.id}" has no bug lane`, 409);
  return { team, laneId };
}

/** The live bug-intake agent of `team` (bug lane Buddy, else its Lead), or null. Never creates one. */
async function testerIntakeAgentFor(backend, team) {
  const agents = await backend.listAgents().catch(() => []);
  const a = pickBugIntakeAgent(Array.isArray(agents) ? agents : [], team);
  return a && !a.archivedAt ? a : null;
}

function sendTesterError(res, e, what) {
  const status = [400, 403, 404, 405, 409, 413, 429].includes(e?.status) ? e.status : null;
  if (status) return sendJson(res, status, { ok: false, error: redactTester(e?.message ?? e) });
  if (sendServerFsError(res, e, what, INBOX_BUSY)) return;
  return sendServerError(res, e, what); // idea-249: detail to the log only
}

/** readBody for a tester route: a JSON object or a 400 (a bad body is the client's fault, never a 500). */
async function readTesterBody(req, limit = MAX_BODY_BYTES) {
  let body;
  try {
    body = await readBody(req, limit);
  } catch (e) {
    throw e?.status ? e : testerStatus("invalid JSON body", 400);
  }
  if (!isPlainObj(body)) throw testerStatus("body must be a JSON object", 400);
  return body;
}

/** The tester's free text: non-empty, at most TESTER_TEXT_MAX_CHARS, control characters and prompt fences defanged. */
function testerText(v) {
  const t = stripControl(String(typeof v === "string" ? v : "")).trim();
  if (!t) throw testerStatus("text is required", 400);
  if (t.length > TESTER_TEXT_MAX_CHARS) throw testerStatus(`text too long (${TESTER_TEXT_MAX_CHARS} chars max)`, 413);
  return defangPromptFences(t);
}
const stripControl = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""); // keeps \t and \n
/** One telemetry value: control chars out, capped, prompt fences defanged, code fences broken, one line. */
function clipTelemetry(v, max) {
  let t = stripControl(String(v)).replace(/\s*\n\s*/g, " ⏎ ").trim();
  if (t.length > max) t = `${t.slice(0, max)}…`;
  return defangPromptFences(t).replace(/`{3,}/g, (m) => "ʼ".repeat(m.length));
}
function safeJsonText(v) {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

// Telemetry contract (locked with @playtest-overlay): the known fields below are sanitized and rendered into the card; any other
// key inside `telemetry` is kept on the stored card (forward-compat) as cleaned JSON, never rendered. Prototype keys are
// dropped at every depth, logLines is trimmed server-side to its last TESTER_LOG_LINES_MAX lines (never a reject) before it is
// defanged, and the stored telemetry must serialize to at most TESTER_TELEMETRY_MAX_BYTES UTF-8 bytes (413 otherwise).
export const TESTER_TELEMETRY_MAX_BYTES = 65536;
export const TESTER_LOG_LINES_MAX = 200;
const TESTER_TELEMETRY_MAX_DEPTH = 16;
const TESTER_RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TESTER_TELEMETRY_KNOWN = new Set(["clickedPoint", "cursorNode", "scene", "state", "buildHash", "logLines", "seed", "adapter", "viewport", "engine", "platform"]);

/** A forward-compat telemetry value as clean JSON: prototype keys dropped at every depth, control chars out, no non-finite numbers. */
function cleanTelemetryJson(v, depth = 0) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return stripControl(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (depth >= TESTER_TELEMETRY_MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.map((x) => cleanTelemetryJson(x, depth + 1)).map((x) => (x === undefined ? null : x));
  if (isPlainObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (TESTER_RESERVED_KEYS.has(k)) continue;
      const c = cleanTelemetryJson(v[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/**
 * The telemetry a report may carry, sanitized and capped: clickedPoint {x,y}, cursorNode, scene, state, buildHash, logLines,
 * seed, adapter {name,version}, viewport {w,h}, engine, platform; plus (`keepUnknown`, i.e. a `telemetry` object) unknown keys.
 * Throws 413 when the result serializes past TESTER_TELEMETRY_MAX_BYTES.
 */
export function sanitizeTesterTelemetry(src, { keepUnknown = false } = {}) {
  const t = isPlainObj(src) ? src : {};
  const out = {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const str = (v) => typeof v === "string" && v.trim() !== "";
  if (isPlainObj(t.clickedPoint)) {
    const x = num(t.clickedPoint.x);
    const y = num(t.clickedPoint.y);
    if (x !== null && y !== null) out.clickedPoint = { x, y };
  }
  for (const [k, max] of [["cursorNode", 300], ["scene", 300], ["buildHash", 120], ["seed", 200], ["engine", 120], ["platform", 120]]) {
    if (str(t[k])) out[k] = clipTelemetry(t[k], max);
  }
  if (isPlainObj(t.adapter) && (str(t.adapter.name) || str(t.adapter.version))) {
    out.adapter = {
      ...(str(t.adapter.name) ? { name: clipTelemetry(t.adapter.name, 120) } : {}),
      ...(str(t.adapter.version) ? { version: clipTelemetry(t.adapter.version, 120) } : {}),
    };
  }
  if (isPlainObj(t.viewport)) {
    const w = num(t.viewport.w);
    const h = num(t.viewport.h);
    if (w !== null && h !== null) out.viewport = { w, h };
  }
  if (t.state !== undefined && t.state !== null) {
    const raw = typeof t.state === "string" ? t.state : safeJsonText(cleanTelemetryJson(t.state)).slice(0, 4000);
    if (raw.trim()) out.state = clipTelemetry(raw, 2000);
  }
  if (Array.isArray(t.logLines)) {
    // trim to the newest lines first (never a reject), then clip + defang each
    const lines = t.logLines.filter((l) => typeof l === "string").slice(-TESTER_LOG_LINES_MAX).map((l) => clipTelemetry(l, 500));
    if (lines.length) out.logLines = lines;
  }
  if (keepUnknown) {
    for (const k of Object.keys(t)) {
      if (TESTER_TELEMETRY_KNOWN.has(k) || TESTER_RESERVED_KEYS.has(k) || !k.trim() || k.length > 128) continue;
      const c = cleanTelemetryJson(t[k], 1);
      if (c !== undefined) out[k] = c;
    }
  }
  if (Buffer.byteLength(safeJsonText(out), "utf8") > TESTER_TELEMETRY_MAX_BYTES) {
    throw testerStatus(`telemetry too large (${TESTER_TELEMETRY_MAX_BYTES} bytes of JSON max after logLines trimming)`, 413);
  }
  return out;
}

/** The card text of a tester report: the server stamp, the tester's words, then the telemetry as a fixed markdown block. */
function testerReportMarkdown(caller, text, tel) {
  const facts = [];
  if (tel.scene) facts.push(`- Scene: ${tel.scene}`);
  if (tel.state) facts.push(`- State: ${tel.state}`);
  if (tel.buildHash) facts.push(`- Build: ${tel.buildHash}`);
  if (tel.seed) facts.push(`- Seed: ${tel.seed}`);
  if (tel.engine) facts.push(`- Engine: ${tel.engine}`);
  if (tel.platform) facts.push(`- Platform: ${tel.platform}`);
  if (tel.adapter) facts.push(`- Adapter: ${[tel.adapter.name, tel.adapter.version].filter(Boolean).join(" ")}`);
  if (tel.viewport) facts.push(`- Viewport: ${tel.viewport.w}x${tel.viewport.h}`);
  if (tel.clickedPoint) facts.push(`- Clicked point: x=${tel.clickedPoint.x}, y=${tel.clickedPoint.y}`);
  if (tel.cursorNode) facts.push(`- Cursor node: ${tel.cursorNode}`);
  if (tel.logLines?.length) facts.push(`- Log (last ${tel.logLines.length} lines):`, "```text", ...tel.logLines, "```");
  return [isOwnerPlaytest(caller) ? OWNER_PLAYTEST_STAMP : testerStamp(caller), text, ...(facts.length ? ["", "**Telemetry**", ...facts] : [])].join("\n");
}

/** Same magic-byte check as server/inbox.mjs sniffImage (which attachInboxMedia enforces): full 8-byte PNG signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function sniffTesterImage(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "";
}

/** body.screenshotBase64 (plain or a data: URL; optional screenshotMime) -> { mime, bytes }, or null when absent. */
function decodeTesterScreenshot(body) {
  let b64 = typeof body.screenshotBase64 === "string" ? body.screenshotBase64.trim() : "";
  if (!b64) return null;
  let mime = typeof body.screenshotMime === "string" ? body.screenshotMime.split(";")[0].trim().toLowerCase() : "";
  const m = /^data:([a-z0-9.+/-]{1,64});base64,/i.exec(b64);
  if (m) {
    mime = m[1].toLowerCase();
    b64 = b64.slice(m[0].length);
  }
  b64 = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw testerStatus("screenshotBase64 is not base64", 400);
  if (Math.floor((b64.length * 3) / 4) > INBOX_MEDIA_MAX_BYTES + 2) throw testerStatus("screenshot too large (8 MB max)", 413);
  const bytes = Buffer.from(b64, /[-_]/.test(b64) ? "base64url" : "base64");
  if (!bytes.length) throw testerStatus("empty screenshot", 400);
  if (bytes.length > INBOX_MEDIA_MAX_BYTES) throw testerStatus("screenshot too large (8 MB max)", 413);
  // Always sniff the bytes, even with a client-declared mime: a mismatch fails here, before any card is parked, instead
  // of parking a card whose attachInboxMedia then fails (and whose clientReportId would then dedupe the valid resend).
  const sniffed = sniffTesterImage(bytes);
  if (!sniffed || (mime && mime !== sniffed)) throw testerStatus("screenshot must be png, jpeg or webp, and match its declared type", 400);
  return { mime: sniffed, bytes };
}

/** Park one tester card on `team`'s bug lane: forced source, lane and tester meta (addInboxCardsAsync scope). */
async function parkTesterCard(caller, team, laneId, text, rootDir, telemetry = null, clientReportId = null) {
  const owner = isOwnerPlaytest(caller);
  const who = owner ? { ownerPlaytest: true, ownerPlaytestBy: caller.principal } : { testerDeviceId: String(caller.id), testerDeviceName: testerName(caller) };
  const meta = { ...who, ...(telemetry ? { telemetry } : {}), ...(clientReportId ? { clientReportId } : {}) };
  // `ideas: [text]`: one card whatever the line count (a plain multi-line `text` would be split into one card per line).
  const r = await addInboxCardsAsync({ ideas: [text], teamId: team.id }, rootDir, { teamId: team.id, laneId, source: owner ? OWNER_PLAYTEST_SOURCE : TESTER_SOURCE, meta });
  const card = r?.added?.[0];
  if (!card) throw new Error("tester card was not parked");
  return card;
}

const TESTER_CLIENT_REPORT_ID_MAX = 128;
/** body.clientReportId: absent -> null; else a 1..128 char string without control characters, or a 400. */
function testerClientReportId(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.length || v.length > TESTER_CLIENT_REPORT_ID_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
    throw testerStatus(`clientReportId must be a string of 1-${TESTER_CLIENT_REPORT_ID_MAX} characters`, 400);
  }
  return v;
}
/** The card this caller already filed for (team, clientReportId), or null. Scoped to the caller: another tester's id never matches. */
function findTesterReport(caller, teamId, clientReportId) {
  if (isOwnerPlaytest(caller)) {
    return readInboxCards().find((c) => isOwnerPlaytestCard(c) && ownerPlaytestByOf(c) === caller.principal && sameId(c.teamId, teamId) && c.clientReportId === clientReportId) ?? null;
  }
  return readInboxCards().find((c) => c?.testerDeviceId === caller.id && sameId(c.teamId, teamId) && c.clientReportId === clientReportId) ?? null;
}
/** In-flight reports keyed by (caller.id, teamId, clientReportId): a concurrent resend waits for the first instead of parking twice. */
const testerReportsInFlight = new Map();

/** A card as its tester sees it: no attachment paths, delivery target or other owner-side fields; text redacted. */
function testerCardView(c) {
  return {
    id: c.id,
    text: redactTester(c.text),
    teamId: c.teamId ?? null,
    laneId: c.laneId ?? null,
    status: c.status ?? "parked",
    source: c.source ?? TESTER_SOURCE,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    delivered: Boolean(c.deliveredAt),
    deliveredAt: c.deliveredAt ?? null,
    attachments: Array.isArray(c.attachments) ? c.attachments.length : 0,
  };
}

const TESTER_CARD_ID_RE = /^idea-\d{1,12}$/;
/** The card id a stamped tester chat line carries (`[Alpha Tester · <name> · card:<id>] ...`), or null. */
const testerChatCardId = (text) => /^\[Alpha Tester · [^\]\n·]* · card:(idea-\d{1,12})\] /.exec(String(text ?? ""))?.[1] ?? null;
/** The caller's own card `cardId` (testerDeviceId === caller.id, on an allowed Squad), else 403 (also for a missing card). */
function ownTesterCard(caller, cardId) {
  const id = String(cardId ?? "").trim();
  const allowed = (caller?.allowedTeams ?? []).map((t) => String(t).toLowerCase());
  const card = /^idea-\d+$/.test(id) ? readInboxCards().find((c) => c?.id === id) : null;
  if (!card || card.testerDeviceId !== caller.id || !allowed.includes(String(card.teamId ?? "").toLowerCase())) {
    throw testerStatus("forbidden: not one of this tester's cards", 403);
  }
  return card;
}

/** PTO-B1: an owner-playtest report card `cardId` on `team`, else 403 (also for a missing card or a tester's card). */
function ownerPlaytestCard(cardId, team) {
  const id = String(cardId ?? "").trim();
  const card = /^idea-\d+$/.test(id) ? readInboxCards().find((c) => c?.id === id) : null;
  if (!card || !isOwnerPlaytestCard(card) || !sameId(card.teamId, team.id)) throw testerStatus("forbidden: not an owner playtest card of that Squad", 403);
  return card;
}

/**
 * Deliver a tester card to its bug lane: { delivered, deliveryError?, agentId }. A delivery failure is not a request error.
 * `agentClient`: the injected backend (createVibesquadMiddleware opts.backend, tests); null = sendInboxCard's own runner client.
 */
async function deliverTesterCard(cardId, rootDir, agentClient = null, { teamId = null, ownerPlaytest = false } = {}) {
  // B11a: a tester card for an asleep Squad stays parked (undelivered) until the owner wakes the folder or sends it by hand.
  // The owner's own playtest report is owner-typed and always goes through.
  if (!ownerPlaytest && teamId && isTeamAsleep(String(teamId), readTeamsConfig(rootDir))) {
    return { delivered: false, reason: "Squad asleep", agentId: null };
  }
  try {
    const r = await sendInboxCard({ cardId, ...(agentClient ? { agentClient } : {}) }, rootDir);
    return { delivered: true, agentId: r?.agentId ?? r?.card?.deliveredTo ?? null };
  } catch (e) {
    return { delivered: false, deliveryError: redactTester(e?.message ?? e), agentId: null };
  }
}

/** Test hook (B11a): the tester-card delivery gate. */
export const _deliverTesterCardForTest = (...a) => deliverTesterCard(...a);

/** GET /api/teams, /__vibesquad/teams for a tester: its Squads only, each with just its bug lane; no paths, no other lanes. */
function handleTesterTeams(req, res, { rootDir, caller }) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  try {
    const str = (v) => (typeof v === "string" && v.trim() ? redactTester(v) : undefined);
    const teams = testerTeamsOf(caller, rootDir).map((team) => {
      const laneId = resolveBugLaneId(team);
      const lane = (Array.isArray(team.lanes) ? team.lanes : []).find((l) => l?.id === laneId);
      const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, str(o?.[k])]).filter(([, v]) => v !== undefined));
      return { id: String(team.id), ...pick(team, ["name", "title"]), lanes: laneId ? [{ id: laneId, ...pick(lane, ["name", "title", "code"]), kind: "bug" }] : [] };
    });
    return sendJson(res, 200, { teams, hostId: getHostId() });
  } catch (e) {
    return sendTesterError(res, e, "tester teams");
  }
}

/**
 * POST /__vibesquad/tester/report: { teamId?, text, telemetry? | clickedPoint/cursorNode/scene/state/buildHash/logLines,
 * screenshotBase64?, screenshotMime? } -> one card on the Squad's bug lane (source alpha-tester, tester meta), its screenshot
 * attached, delivered to the bug-intake agent. Answers { ok, cardId, delivered, deliveryError?, laneId, threadAgentId }.
 */
async function handleTesterReport(req, res, { rootDir, caller, backend, deliveryClient = null }) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  try {
    const body = await readTesterBody(req, TESTER_REPORT_MAX_BYTES);
    const { team, laneId } = testerTeamFor(caller, body.teamId, rootDir);
    const clientReportId = testerClientReportId(body.clientReportId);
    const text = testerText(body.text);
    const fromTelemetry = isPlainObj(body.telemetry);
    const telemetry = sanitizeTesterTelemetry(fromTelemetry ? body.telemetry : body, { keepUnknown: fromTelemetry });
    const shot = decodeTesterScreenshot(body); // validated before the card exists: a bad screenshot parks nothing
    if (!clientReportId) return sendJson(res, 200, await fileTesterReport({ caller, team, laneId, text, telemetry, shot, rootDir, backend, deliveryClient }));
    // Idempotent resend: scoped to (caller.id, teamId, clientReportId), so one tester can never probe another's ids.
    // PTO-B1: the owner's key has another shape (4 items), so it can never collide with a tester device's key; PTO-B1b: it
    // carries the owner principal, so the local owner and each owner device dedupe only their own retries.
    const key = JSON.stringify(isOwnerPlaytest(caller) ? [OWNER_PLAYTEST_SOURCE, String(caller.principal), String(team.id).toLowerCase(), clientReportId] : [String(caller.id), String(team.id).toLowerCase(), clientReportId]);
    for (let pending = testerReportsInFlight.get(key); pending; pending = testerReportsInFlight.get(key)) await pending.catch(() => {});
    const prior = findTesterReport(caller, team.id, clientReportId);
    if (prior) {
      const threadAgentId = prior.deliveredTo ?? (await testerIntakeAgentFor(backend, team))?.id ?? null;
      return sendJson(res, 200, { ok: true, cardId: prior.id, delivered: Boolean(prior.deliveredAt), laneId: prior.laneId ?? laneId, threadAgentId, deduplicated: true });
    }
    const run = fileTesterReport({ caller, team, laneId, text, telemetry, shot, rootDir, backend, deliveryClient, clientReportId });
    testerReportsInFlight.set(key, run);
    try {
      return sendJson(res, 200, await run);
    } finally {
      testerReportsInFlight.delete(key);
    }
  } catch (e) {
    return sendTesterError(res, e, "tester report");
  }
}

/** Park, attach and deliver one validated tester report; resolves to the POST /tester/report answer body. */
async function fileTesterReport({ caller, team, laneId, text, telemetry, shot, rootDir, backend, deliveryClient = null, clientReportId = null }) {
  const card = await parkTesterCard(caller, team, laneId, testerReportMarkdown(caller, text, telemetry), rootDir, telemetry, clientReportId);
  const out = { ok: true, cardId: card.id, laneId };
  if (shot) {
    try {
      await attachInboxMedia({ cardId: card.id, mime: shot.mime, bytes: shot.bytes });
      out.screenshotAttached = true;
    } catch (e) {
      out.screenshotAttached = false;
      out.screenshotError = redactTester(e?.message ?? e);
    }
  }
  const d = await deliverTesterCard(card.id, rootDir, deliveryClient, { teamId: team.id, ownerPlaytest: isOwnerPlaytest(caller) });
  out.delivered = d.delivered;
  if (d.deliveryError) out.deliveryError = d.deliveryError;
  if (d.reason) out.reason = d.reason;
  out.threadAgentId = d.agentId ?? (await testerIntakeAgentFor(backend, team))?.id ?? null;
  return out;
}

/**
 * GET /__vibesquad/tester/thread?teamId=&limit=&after= -> { ok, teamId, laneId, agent: { id, title, status } | null, messages,
 * cursor }; `after` (a message id) returns only the messages strictly after it when it is still in the window; `cursor` is the
 * last returned id (or `after` when nothing is newer, or null). messages[] carry `cardId` when the line was card-tagged.
 * POST { teamId?, text, cardId? } -> the line goes to the bug-intake agent, prefixed (with `card:<cardId>` for one of the
 * caller's own cards on that Squad) and non-owner -> { ok, agentId }.
 */
async function handleTesterThread(req, res, { rootDir, caller, backend }) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const { team, laneId } = testerTeamFor(caller, q.get("teamId") || q.get("team") || "", rootDir);
      const limit = Math.min(Math.max(Number(q.get("limit")) || TESTER_THREAD_DEFAULT, 1), TESTER_THREAD_MAX);
      const after = (q.get("after") ?? "").trim();
      const a = await testerIntakeAgentFor(backend, team);
      if (!a) return sendJson(res, 200, { ok: true, teamId: String(team.id), laneId, agent: null, messages: [], cursor: null });
      const t = await fetchTesterTimeline(backend, a.id, { limit: after ? TESTER_THREAD_MAX : limit });
      const all = t.entries.map((e) => {
        const role = e.item.type === "user_message" ? "user" : "assistant";
        const cardId = role === "user" ? (isOwnerPlaytest(caller) ? ownerPlaytestChatCardId : testerChatCardId)(e.item.text) : null;
        return { id: `${a.id}:${e.seqStart ?? ""}`, role, text: e.item.text, ts: e.timestamp ?? null, ...(cardId ? { cardId } : {}) };
      });
      const at = after ? all.findIndex((m) => m.id === after) : -1;
      const messages = at >= 0 ? all.slice(at + 1, at + 1 + limit) : all.slice(-limit);
      const cursor = messages.length ? messages[messages.length - 1].id : at >= 0 ? after : null;
      return sendJson(res, 200, { ok: true, teamId: String(team.id), laneId, agent: { id: a.id, title: redactTester(a.title ?? ""), status: String(a.status ?? "unknown") }, messages, cursor });
    }
    if (req.method === "POST") {
      const body = await readTesterBody(req);
      const { team } = testerTeamFor(caller, body.teamId, rootDir);
      const text = testerText(body.text);
      let cardId = null;
      if (body.cardId !== undefined && body.cardId !== null) {
        if (typeof body.cardId !== "string" || !TESTER_CARD_ID_RE.test(body.cardId.trim())) throw testerStatus("cardId must be an inbox card id (idea-<n>)", 400);
        const card = isOwnerPlaytest(caller) ? ownerPlaytestCard(body.cardId, team) : ownTesterCard(caller, body.cardId);
        if (!sameId(card.teamId, team.id)) throw testerStatus("forbidden: not one of this tester's cards", 403);
        cardId = card.id;
      }
      const a = await testerIntakeAgentFor(backend, team);
      if (!a) throw testerStatus(`no live bug-intake agent in Squad "${team.id}"; your report is parked in the inbox`, 409);
      if (isOwnerPlaytest(caller)) await backend.sendAgentPrompt(a.id, `${ownerPlaytestChatPrefix(cardId)}${sanitizeTesterInput(text)}`, { owner: true });
      else await sendTesterInput(backend, caller, a.id, text, { cardId });
      return sendJson(res, 200, { ok: true, agentId: a.id });
    }
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    return sendTesterError(res, e, "tester thread");
  }
}

/** GET/POST /__vibesquad/inbox for a tester: list its own cards; park a plain text card on an allowed Squad's bug lane. */
async function handleTesterInbox(req, res, { rootDir, caller }) {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const want = (q.get("teamId") || q.get("team") || "").trim().toLowerCase();
      const allowed = (caller.allowedTeams ?? []).map((t) => String(t).toLowerCase());
      if (want && want !== "all" && !allowed.includes(want)) throw testerStatus("forbidden: that Squad is not on this tester's invite", 403);
      const cards = readInboxCards()
        .filter((c) => c?.testerDeviceId === caller.id && allowed.includes(String(c.teamId ?? "").toLowerCase()))
        .filter((c) => !want || want === "all" || String(c.teamId).toLowerCase() === want)
        .filter((c) => c.status !== "archived")
        .map(testerCardView);
      return sendJson(res, 200, { ok: true, cards });
    }
    if (req.method === "POST") {
      const body = await readTesterBody(req);
      const { team, laneId } = testerTeamFor(caller, body.teamId, rootDir);
      const card = await parkTesterCard(caller, team, laneId, `${testerStamp(caller)}\n${testerText(body.text)}`, rootDir);
      return sendJson(res, 200, { ok: true, cardId: card.id, laneId, card: testerCardView(card) });
    }
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    return sendTesterError(res, e, `tester inbox ${req.method === "GET" ? "list" : "add"}`);
  }
}

/** POST /__vibesquad/inbox/attachment?cardId= for a tester: raw image body onto one of its own undelivered cards. */
async function handleTesterInboxAttachment(req, res, { caller }) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  try {
    const card = ownTesterCard(caller, new URL(req.url, "http://x").searchParams.get("cardId"));
    const mime = String(req.headers["content-type"] || "");
    const bytes = await readRawBody(req, INBOX_MEDIA_MAX_BYTES);
    const r = await attachInboxMedia({ cardId: card.id, mime, bytes });
    return sendJson(res, 200, { ok: true, cardId: card.id, attachment: { mime: r?.attachment?.mime ?? null, bytes: r?.attachment?.bytes ?? bytes.length } });
  } catch (e) {
    if (!e?.status && e instanceof Error && !isServerSideFsError(e)) e.status = 400; // attachInboxMedia's validation errors
    return sendTesterError(res, e, "tester inbox attachment");
  }
}

/** POST /__vibesquad/inbox/send { cardId } for a tester: deliver one of its own cards to its bug lane. */
async function handleTesterInboxSend(req, res, { rootDir, caller, deliveryClient = null }) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  try {
    const body = await readTesterBody(req);
    const card = ownTesterCard(caller, body.cardId);
    if (card.deliveredAt) return sendJson(res, 200, { ok: true, cardId: card.id, delivered: true, already: true });
    const d = await deliverTesterCard(card.id, rootDir, deliveryClient, { teamId: card.teamId });
    return sendJson(res, 200, { ok: true, cardId: card.id, delivered: d.delivered, ...(d.deliveryError ? { deliveryError: d.deliveryError } : {}), ...(d.reason ? { reason: d.reason } : {}), agentId: d.agentId });
  } catch (e) {
    return sendTesterError(res, e, "tester inbox send");
  }
}

// Connect-style middleware: handles /__vibesquad/* and /api/*, calls next() for everything else.
// Everything except health, /ca.crt, /pair and /__vibesquad/local-login needs a paired device or a same-origin loopback
// caller. The caller is resolved once per request (auth.mjs callerFromRequest: owner | agent | unknown); every write and
// every gated read needs the owner, except AGENT_WRITE_ALLOWLIST for a verified agent (default-deny, X1c). A caller with
// neither proof is read-only (GET/HEAD, minus isGatedRead). opts.backend: the runner backend (tests); default shared.
export function createVibesquadMiddleware(rootDir = REPO_ROOT, opts = {}) {
  const readOnlyCache = createReadOnlyCache(opts.readOnlyCacheMs);
  const verifyAgent = opts.verifyAgent ?? ((c) => (opts.backend ?? sharedRunnerBackend()).verifyAgent(c));
  refreshRunnerRoster(); // background scan so the first file request already knows the runner worktrees
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/health" || path === "/__vibesquad/health") return handleHealth(req, res, rootDir);
    if (path === "/ca.crt") return handleCaCrt(req, res);
    if (path === "/pair") return handlePairRedeem(req, res);
    if (path === "/pair/status") return handlePairStatus(req, res); // E4b: cookie-scoped pending/approved/gone, nothing else
    if (path === "/__vibesquad/enter") return handleEnter(req, res);
    if (path === "/__vibesquad/local-login") return handleLocalLogin(req, res);
    if (path === "/__vibesquad/local-login/nonce") return handleLocalLoginNonce(req, res);
    if (path === "/__vibesquad/local-proof") return handleLocalProof(req, res); // X1 L3: server proves the token before `vs pair` sends it
    const isApi = path.startsWith("/__vibesquad/") || path.startsWith("/api/");
    // E6a: a bug-tester never reaches anything through a doubled slash, backslash, %-encoding or dot segment (e.g. //api/settings,
    // which is not an API path and would otherwise fall through to next()). Checked only for such paths, so plain static
    // requests pay nothing.
    if (isSuspectPath(path) && testerDeviceOf(req)) return sendJson(res, 403, { error: "forbidden: bug-tester device cannot access this route" });
    // PTO R1 M1: an owner-playtest device credential is gated on EVERY path (API, static/SPA, suspect spellings), before the
    // trust check, the agent-header branch and caller resolution, so nothing (an x-vs-agent-id, a non-API path) can route it
    // around PLAYTEST_ROUTE_ALLOWLIST. Report/thread still refuse agent headers, cookies and relay in ownerPlaytestPrincipal.
    const playtestDev = playtestDeviceOf(req);
    if (playtestDev) return playtestGated(req, res, path, playtestCaller(playtestDev));
    if (isApi && !isTrusted(req)) {
      if (originRefusal(req)) return sendCrossSiteRefused(req, res); // X1-E4b L4: a cookie write that failed the same-origin proof
      if (isLocal(req)) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 401, { error: "unpaired device" });
    }
    // Agent headers need the runner (one GET /verify-agent per request); everything else resolves synchronously as before.
    if (isApi && hasAgentHeaders(req)) {
      return callerFromRequest(req, { verifyAgent }).then(
        (caller) => gated(req, res, next, path, isApi, caller),
        (e) => sendServerError(res, e, "agent caller check"), // idea-249
      );
    }
    return gated(req, res, next, path, isApi, isApi ? resolveNonAgentCaller(req) : { kind: ownerProof(req) ? "owner" : "unknown" });
  };

  function gated(req, res, next, path, isApi, caller) {
    if (caller.kind === "tester") return testerGated(req, res, path, caller); // E6a: first, before any owner/read-only rule
    if (caller.kind === "playtest") return playtestGated(req, res, path, caller); // PTO v1.1: defence in depth (the middleware gates it first)
    const owner = caller.kind === "owner";
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (caller.kind === "denied") return sendJson(res, caller.status, { error: caller.error });
    if (path === "/__vibesquad/tester/report" || path === "/__vibesquad/tester/thread") return ownerPlaytestGated(req, res, path, caller);
    if (isApi && !owner && (write || isGatedRead(path, req.url))) {
      if (caller.kind !== "agent" && originRefusal(req)) return sendCrossSiteRefused(req, res); // X1-E4b L4 (never for an agent caller)
      if (caller.kind !== "agent") return sendJson(res, 403, { error: READ_ONLY_ERROR, readOnly: true });
      if (!write || !agentWriteAllowed(path)) return sendJson(res, 403, { error: `agent ${caller.id} may not ${req.method} ${path} (owner-only route)` });
    }
    const cachedRead = (run) => readOnlyCache(path, owner, run);
    // An owner write (install, toggle) can change what those reads return.
    if (write && owner) readOnlyCache.clear();
    const bodyLimit = RUNNER_INPUT_RE.test(path) ? MAX_RUNNER_INPUT_BYTES : path === "/__vibesquad/inbox/attachment" ? INBOX_MEDIA_MAX_BYTES : MAX_BODY_BYTES;
    if (Number(req.headers["content-length"] ?? 0) > bodyLimit) return sendJson(res, 413, { error: "payload too large" });
    if (path === "/api/auth/status" || path === "/__vibesquad/auth/status") return handleAuthStatus(req, res, rootDir);
    if (path === "/api/teams") return handleTeams(req, res, rootDir);
    if (path === "/api/profiles") return handleProfiles(req, res);
    if (path === "/__vibesquad/local-image") return handleLocalImage(req, res);
    if (path === "/VibeSquad-setup.exe" || path === "/__vibesquad/desktop/VibeSquad-setup.exe") {
      return handleDesktopInstaller(req, res, rootDir);
    }
    if (isAndroidApkPath(path)) {
      return handleAndroidApk(req, res, rootDir);
    }
    if (path === "/__vibesquad/desktop/update.json") {
      return handleDesktopUpdateJson(req, res, rootDir);
    }
    if (!path.startsWith("/__vibesquad/")) return next?.();
    if (path.startsWith("/__vibesquad/runner/")) return handleRunnerApi(req, res, { readBody: (r) => readBody(r, bodyLimit), sendJson, caller, testerTeams: null, ...(opts.backend ? { backend: opts.backend } : {}) });
    if (path === "/__vibesquad/schedules" || path.startsWith("/__vibesquad/schedules/")) return handleSchedulesApi(req, res, { readBody, sendJson });
    // idea-343: gh-repos / gh-clone (git-api NO_CWD_ACTIONS) need the owner, by the same gate as every git route and as runner
    // spawn above: GET gh-repos is a gated read (isGatedRead -> isGitPath), POST gh-clone a write, so a local-token owner,
    // a paired LAN device or a relay owner device reaches them; a read-only loopback caller gets 403; an agent caller gets
    // 403 too (neither route is in AGENT_WRITE_ALLOWLIST, and a gated GET is never open to agents). No host-only gate: an
    // owner remote session can already spawn agents that run shell, so a loopback-only clone protected nothing.
    if (isGitPath(path)) return handleGitApi(req, res, { readBody, sendJson, resolveCwd: (cwd) => resolveShellCwd(cwd, rootDir, opts), projectsDir: () => primaryProjectsDir(rootDir) });
    if (isTerminalsPath(path)) return handleTerminalsApi(req, res, { readBody, sendJson, resolveCwd: (cwd) => resolveShellCwd(cwd, rootDir, opts) });
    if (path === "/__vibesquad/providers" || path.startsWith("/__vibesquad/providers/")) return handleProvidersApi(req, res, { sendJson: (r, status, data) => sendFor(req, r, status, data, rootDir), readBody: readCleanBody });
    switch (path) {
      case "/__vibesquad/pair/start":
        return handlePairStart(req, res, readBody);
      case "/__vibesquad/pair/pending": // E4b: tickets waiting on this paired device's Approve
        return handlePairPending(req, res);
      case "/__vibesquad/pair/approve": // E4b: minting device only (owner-gated as non-GET above, re-checked inside)
        return handlePairApprove(req, res, readBody);
      case "/__vibesquad/devices":
        return handleDevices(req, res);
      case "/__vibesquad/devices/revoke":
        return handleRevoke(req, res, readBody);
      case "/__vibesquad/teams":
        return handleTeams(req, res, rootDir);
      case "/__vibesquad/first-run/status":
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return cachedRead(() => inspectFirstRunStatus(opts.firstRun)).then((st) => sendJson(res, 200, st), (e) => sendServerError(res, e, "first-run status")); // idea-249
      case "/__vibesquad/settings":
        return handleSettings(req, res).catch((e) => {
          console.warn(`[vibesquad] settings request failed: ${e?.message ?? e}`); // idea-242 L1: detail to the log only
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "settings request failed; see the server log" });
        });
      case "/__vibesquad/log":
        return handleLog(req, res, opts);
      case "/__vibesquad/attach":
      case "/__vibesquad/attach-files":
        return handleAttach(req, res, rootDir, opts);
      case "/__vibesquad/handoff":
        return handleHandoff(req, res, rootDir);
      case "/__vibesquad/brainstorm-summary":
        return handleBrainstormSummary(req, res, rootDir);
      case "/__vibesquad/vs-log":
        return handleVsLog(req, res, opts);
      case "/__vibesquad/unstick": // owner-only: POST is gated above (isOwner for every non-GET)
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return readBody(req).then((body) => unstick({ confirmRestart: body?.confirmRestart === true })).then((r) => sendJson(res, 200, r), (e) => sendCaughtError(req, res, e, "unstick")); // idea-249 L2: a bad body stays 400
      case "/__vibesquad/restart-runner": // owner-only (same guard as Unstick): park live turns cleanly, then restart the runner
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return forceRestartRunner().then((r) => sendJson(res, 200, r), (e) => sendServerError(res, e, "restart-runner")); // idea-249
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
      case "/__vibesquad/inbox/send":
        return handleInboxSend(req, res, rootDir);
      case "/__vibesquad/inbox/attachment": // owner-only (non-GET gate above): raw image body, ?cardId=
        return handleInboxAttachment(req, res);
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
          .catch((e) => sendServerFsError(res, e, "remove-team-worktrees") || sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }));
      default:
        return next?.();
    }
  }

  /**
   * PTO-B1 / B1b: the owner principal allowed on the E6a report/thread routes, or null. Never with agent headers. Either
   *  - the local owner (auth.mjs isLocalOwner: loopback socket + loopback Host/Origin + the per-install local token), or
   *  - B1b: a paired device with role owner that authenticated by a HEADER token (x-vs-device-token / Authorization:
   *    Bearer; extractDeviceToken fromHeader). A cookie-only owner device is refused: the cookie is the browser's ambient
   *    credential, so these game-facing routes stay closed to CSRF; a header can't be attached cross-site without a CORS
   *    preflight this server never grants. Revoked/unknown tokens never get here (isTrusted: 401 remote, 403 loopback).
   *  - An E5 relay request is refused: its only credential is the channel identity (auth.mjs authenticate ignores any
   *    header on it) and relay-tunnel.mjs drops authorization / x-vs-device-token before dispatch, so it is never a
   *    header-token caller; the game talks plain HTTP to the server's Tailscale address instead (PLAN_V1: relay out of scope).
   */
  function ownerPlaytestPrincipal(req, caller) {
    if ((caller.kind !== "owner" && caller.kind !== "playtest") || hasAgentHeaders(req)) return null;
    if (caller.kind === "owner" && isLocalOwner(req)) return OWNER_PLAYTEST_LOCAL;
    if (isRelayRequest(req)) return null;
    const { token, fromHeader } = extractDeviceToken(req);
    if (!token || !fromHeader) return null;
    const dev = authenticate(req); // header path: the same lookup isTrusted / resolveNonAgentCaller already passed
    if (!dev?.id) return null;
    // PTO v1.1: an owner-playtest device (header token) files as `device:<id>`, the same principal shape as an owner device,
    // so its cards stay owner-source `[Owner playtest]` and dedupe per device. The record must match the resolved caller.
    if (caller.kind === "playtest") return dev.role === OWNER_PLAYTEST_ROLE && dev.id === caller.id ? `device:${dev.id}` : null;
    return isOwnerDevice(dev) ? `device:${dev.id}` : null;
  }

  /**
   * PTO-B1: the E6a report/thread routes for a non-tester caller. Only an owner principal (ownerPlaytestPrincipal above)
   * reaches them. A cookie-only or relayed owner device, an agent and a read-only caller get 403 here.
   */
  function ownerPlaytestGated(req, res, path, caller) {
    const principal = ownerPlaytestPrincipal(req, caller);
    if (!principal) {
      if (caller.kind !== "agent" && originRefusal(req)) return sendCrossSiteRefused(req, res); // X1-E4b L4, as gated()
      return sendJson(res, 403, { ok: false, error: "forbidden: the playtest report/thread routes need a bug-tester device, the local owner token or an owner / owner-playtest device token header" });
    }
    if (path === "/__vibesquad/tester/report" ? req.method !== "POST" : req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method not allowed" });
    }
    const limit = path === "/__vibesquad/tester/report" ? TESTER_REPORT_MAX_BYTES : MAX_BODY_BYTES;
    if (Number(req.headers["content-length"] ?? 0) > limit) return sendJson(res, 413, { error: "payload too large" });
    const backend = opts.backend ?? sharedRunnerBackend();
    const ctx = { rootDir, caller: ownerPlaytestCaller(principal), backend, deliveryClient: opts.backend ?? null };
    return path === "/__vibesquad/tester/report" ? handleTesterReport(req, res, ctx) : handleTesterThread(req, res, ctx);
  }

  /**
   * PTO v1.1: the whole route table for an owner-playtest device (deny-by-default: PLAYTEST_ROUTE_ALLOWLIST on a canonical
   * path, API or not). Report/thread then go through ownerPlaytestGated, which still demands a header token.
   */
  function playtestGated(req, res, path, caller) {
    if (!isCanonicalTesterPath(path) || !playtestRouteAllowed(req.method, path)) return sendJson(res, 403, { error: PLAYTEST_FORBIDDEN });
    if (path === "/api/auth/status" || path === "/__vibesquad/auth/status") return handleAuthStatus(req, res, rootDir);
    if (path === "/__vibesquad/tester/report" || path === "/__vibesquad/tester/thread") return ownerPlaytestGated(req, res, path, caller);
    return sendJson(res, 403, { error: PLAYTEST_FORBIDDEN }); // unreachable: allowlist above
  }

  /** E6a: the whole route table for a bug-tester device (deny-by-default: TESTER_ROUTE_ALLOWLIST on a canonical path). */
  function testerGated(req, res, path, caller) {
    if (!isCanonicalTesterPath(path) || !testerRouteAllowed(req.method, path)) {
      return sendJson(res, 403, { error: "forbidden: bug-tester device cannot access this route" });
    }
    const limit = path === "/__vibesquad/tester/report" ? TESTER_REPORT_MAX_BYTES : path === "/__vibesquad/inbox/attachment" ? INBOX_MEDIA_MAX_BYTES : MAX_BODY_BYTES;
    if (Number(req.headers["content-length"] ?? 0) > limit) return sendJson(res, 413, { error: "payload too large" });
    const backend = opts.backend ?? sharedRunnerBackend();
    const ctx = { rootDir, caller, backend, deliveryClient: opts.backend ?? null };
    if (path === "/api/auth/status" || path === "/__vibesquad/auth/status") return handleAuthStatus(req, res, rootDir);
    if (path === "/api/teams" || path === "/__vibesquad/teams") return handleTesterTeams(req, res, ctx);
    if (path.startsWith("/__vibesquad/runner/")) {
      return handleRunnerApi(req, res, { readBody: (r) => readBody(r, MAX_BODY_BYTES), sendJson, caller, backend, testerTeams: () => testerTeamsOf(caller, rootDir) });
    }
    if (path === "/__vibesquad/tester/report") return handleTesterReport(req, res, ctx);
    if (path === "/__vibesquad/tester/thread") return handleTesterThread(req, res, ctx);
    if (path === "/__vibesquad/inbox") return handleTesterInbox(req, res, ctx);
    if (path === "/__vibesquad/inbox/attachment") return handleTesterInboxAttachment(req, res, ctx);
    if (path === "/__vibesquad/inbox/send") return handleTesterInboxSend(req, res, ctx);
    return sendJson(res, 403, { error: "forbidden: bug-tester device cannot access this route" }); // unreachable: allowlist above
  }
}
