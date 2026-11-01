import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE, loadUserSettings, saveUserSettings } from "./user-settings.mjs";
import { authenticate, getAuthStatus, handleCaCrt, handleDevices, handlePairRedeem, handlePairStart, handleRevoke, hasDistIndex, isLocal, isLocalBrowserSafe, netConfig } from "./auth.mjs";
import {
  appendVsLogEntry,
  createDaemonClient,
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
  savePushSubscription,
  sendTestPush,
  sendWebPushToSubscription,
  startPushWatcher,
  toBase64Url,
  fromBase64Url,
  writePushSubscriptions,
} from "./push.mjs";
import {
  DEFAULT_PACK_PROFILES,
  DEFAULT_PROFILES,
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
  createDaemonClient,
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
  savePushSubscription,
  sendTestPush,
  sendWebPushToSubscription,
  startPushWatcher,
  toBase64Url,
  fromBase64Url,
  writePushSubscriptions,
  DEFAULT_PACK_PROFILES,
  DEFAULT_PROFILES,
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
  loadLeadThresholds,
  parseLeadOrd,
  performLeadHandoffHttp,
  readLaneLogEntries,
  resolveLeadProfile,
  resolveTeamAndLane,
  synthesizeHandoffPacket,
};

const REPO_ROOT = resolve(import.meta.dirname, "..");

// Read the daemon's listen address and server id straight from Paseo's own config,
// so VibeSquad follows the daemon if it moves. PASEO_DAEMON overrides.
export function readPaseo(_rootDir = REPO_ROOT) {
  const home = join(homedir(), ".paseo");
  let listen = "127.0.0.1:6767";
  let serverId = "";
  try {
    listen = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).daemon?.listen ?? listen;
  } catch {}
  try {
    serverId = readFileSync(join(home, "server-id"), "utf8").trim();
  } catch {}
  return { listen: process.env.PASEO_DAEMON ?? listen, serverId };
}

const TEAM_ID = /^[A-Za-z0-9_-]+$/;
const teamDir = (team) => join(process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "teams", team);
const LOG_TYPES = new Set(["done", "decision", "blocker", "needs-you", "handoff", "you", "metric", LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE]);
const UI_LOG_TYPES = new Set(["you", "needs-you", "handoff", "metric", "decision", LEGACY_USER_TYPE, LEGACY_NEEDS_LABEL]);

const MAX_BODY_BYTES = 1024 * 1024;
const AGENT_ID_STRICT = /^[A-Za-z0-9_-]{1,64}$/;
// Test/DI hooks that must never be taken from an HTTP body.
const INTERNAL_BODY_KEYS = ["baseHome", "profilesPath", "daemonClient", "oldAgent", "oldLead", "execSpawn", "teamsFilePath", "skipDaemon", "agents"];

export function sanitizeBody(body) {
  const out = { ...(body && typeof body === "object" ? body : {}) };
  for (const k of INTERNAL_BODY_KEYS) delete out[k];
  return out;
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let body = "";
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        fail(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      body += c;
    });
    req.on("end", () => {
      if (done) return;
      try {
        ok(JSON.parse(body || "{}"));
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

let exposure = { lanEnabled: false, exposedIps: [] };
export function setExposure(lanEnabled, exposedIps) {
  exposure = { lanEnabled: Boolean(lanEnabled), exposedIps: lanEnabled ? [...(exposedIps ?? [])] : [] };
}

const isTrusted = (req) => isLocalBrowserSafe(req) || Boolean(authenticate(req));

export function handleHealth(req, res, rootDir = REPO_ROOT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const distReady = hasDistIndex(rootDir);
  if (!isTrusted(req)) return sendJson(res, distReady ? 200 : 503, { ok: distReady, distReady });
  const { port } = netConfig();
  const extra = { port, lanEnabled: exposure.lanEnabled, exposedIps: exposure.exposedIps };
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
  return sendJson(res, 200, full);
}

// Writes the Team Settings editor's teams back to teams.json. Keeps the other top-level keys.
function handleTeams(req, res, rootDir) {
  const file = join(rootDir, "teams.json");
  if (req.method === "GET") {
    const readFile = existsSync(file) ? file : join(rootDir, "teams.example.json");
    try {
      const cur = JSON.parse(readFileSync(readFile, "utf8"));
      return sendJson(res, 200, cur);
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }
  if (req.method !== "POST" && req.method !== "PUT") {
    res.statusCode = 405;
    return res.end();
  }
  readBody(req).then((parsed) => {
    try {
      const teams = Array.isArray(parsed) ? parsed : parsed.teams;
      if (!Array.isArray(teams)) throw new Error("teams must be an array");
      const cur = JSON.parse(readFileSync(file, "utf8"));
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
      writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      sendJson(res, 200, {
        ok: true,
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
  if (req.method === "GET") return sendJson(res, 200, { ok: true, ...loadUserSettings() });
  if (req.method === "POST" || req.method === "PUT") {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, ...saveUserSettings({ userName: body?.userName }) });
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
      const { team, type = "you", text, refs, agent = loadUserSettings().userName, lane = "" } = await readBody(req);
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

function paseoAgentCwds() {
  const out = [];
  const agentsRoot = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "agents");
  try {
    for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of readdirSync(join(agentsRoot, dir.name))) {
        if (!f.endsWith(".json")) continue;
        try {
          const cwd = JSON.parse(readFileSync(join(agentsRoot, dir.name, f), "utf8"))?.cwd;
          if (typeof cwd === "string" && cwd.trim()) out.push(cwd.trim());
        } catch {}
      }
    }
  } catch {}
  return out;
}

function allowedAttachRoots(rootDir, opts) {
  const roots = [rootDir, ...(opts.allowedCwdRoots ?? []), ...paseoAgentCwds()];
  for (const file of [join(rootDir, "teams.json"), join(rootDir, "teams.example.json")]) {
    try {
      for (const t of JSON.parse(readFileSync(file, "utf8")).teams ?? []) for (const p of t.paths ?? []) roots.push(p);
      break;
    } catch {}
  }
  return roots.map(realOrNull).filter(Boolean);
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
    const { cwd, files } = await readBody(req);
    if (typeof cwd !== "string" || !existsSync(cwd) || !statSync(cwd).isDirectory()) return sendJson(res, 400, { error: "cwd is not a directory" });
    const realCwd = realpathSync(resolve(cwd));
    if (!allowedAttachRoots(rootDir, opts).some((root) => insideDir(realCwd, root))) return sendJson(res, 403, { error: "cwd is not a known agent or team path" });
    if (!Array.isArray(files) || !files.length) return sendJson(res, 400, { error: "no files given" });
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

// GET ?team&lane: does the successor packet exist? POST {team,lane,agentId}: run `vs handoff` to make it.
async function handleHandoff(req, res, rootDir) {
  try {
    const q = req.method === "GET" ? new URL(req.url, "http://x").searchParams : null;
    const body = req.method === "POST" ? await readBody(req) : {};
    const team = String(q?.get("team") ?? body.team ?? "");
    const lane = String(q?.get("lane") ?? body.lane ?? "");
    if (!TEAM_ID.test(team) || !TEAM_ID.test(lane)) return sendJson(res, 400, { error: "bad team/lane" });
    const packet = join(teamDir(team), `packet-${lane}.md`);
    if (req.method === "GET") return sendJson(res, 200, { exists: existsSync(packet), path: packet });
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    if (body.agentId !== undefined && !AGENT_ID_STRICT.test(String(body.agentId))) return sendJson(res, 400, { error: "bad agentId" });
    const cli = join(rootDir, "cli", "vs.mjs");
    if (!existsSync(cli)) return sendJson(res, 200, { exists: existsSync(packet), path: packet, ran: false, note: "cli/vs.mjs not found" });
    execFileSync(process.execPath, [cli, "handoff"], {
      cwd: rootDir,
      env: { ...process.env, ...(body.agentId ? { PASEO_AGENT_ID: String(body.agentId) } : {}) },
      timeout: 60_000,
      stdio: "pipe",
      windowsHide: true,
    });
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
      const s = readBrainstormSummary(lane, rootDir);
      return sendJson(res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readBody(req);
      const lane = body.laneId || body.lane || "vibesquad";
      const content = String(body.content ?? "");
      if (content.length >= 20_000) {
        return sendJson(res, 400, { ok: false, error: `Summary is ${content.length} chars; must be < 20000 chars (~5k tokens)` });
      }
      const s = writeBrainstormSummary(lane, content, rootDir);
      return sendJson(res, 200, { ok: true, laneId: s.laneId, path: s.path, content: s.content });
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
      const body = await readBody(req);
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
    const body = await readBody(req);
    const result = await performBrainstormRestart(sanitizeBody(body), rootDir);
    return sendJson(res, 200, result);
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
    const body = await readBody(req);
    const result = await performLeadHandoffHttp(
      actionOverride ? { ...sanitizeBody(body), action: actionOverride } : sanitizeBody(body),
      rootDir,
    );
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
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
      const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
    const result = removePushSubscription(body);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handlePushTest(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = await readBody(req);
    const result = await sendTestPush(body);
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleProfiles(req, res) {
  try {
    if (req.method === "GET") {
      const state = loadProfiles(undefined, { autoSeed: false });
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
        diff,
        warningsByProfile,
        installedProviders: state.installedProviders,
      });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readBody(req);
      const saved = saveProfiles(body);
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
    const body = await readBody(req);
    if (body.mode === "default") {
      const seeded = seedDefaultPack();
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
      const existing = loadProfiles().profiles;
      const byName = new Map(existing.map((p) => [p.name, p]));
      for (const p of imported.profiles) byName.set(p.name, p);
      finalProfiles = [...byName.values()];
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

function readDesktopVersion(rootDir = REPO_ROOT) {
  try {
    const conf = JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
    if (conf?.version) return String(conf.version);
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    if (pkg?.version) return String(pkg.version);
  } catch {}
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

export function lookupAgentCwd(agentId, paseoHome) {
  const id = String(agentId ?? "").trim();
  if (!AGENT_ID_RE.test(id)) return null;
  const home = paseoHome || process.env.PASEO_HOME || join(homedir(), ".paseo");
  const agentsRoot = join(home, "agents");
  try {
    if (existsSync(agentsRoot)) {
      for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const candidate = join(agentsRoot, dir.name, `${id}.json`);
        if (existsSync(candidate)) {
          const record = JSON.parse(readFileSync(candidate, "utf8"));
          const cwd = record?.cwd ?? record?.Cwd ?? "";
          if (typeof cwd === "string" && cwd.trim()) return cwd.trim();
        }
      }
    }
  } catch {}
  return null;
}

function imageAllowedRoots() {
  const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const roots = [paseoHome];
  const tmp = tmpdir();
  try {
    for (const d of readdirSync(tmp)) if (d.startsWith("paseo-attachments-")) roots.push(join(tmp, d));
  } catch {}
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
    if (!IMAGE_MIME[extname(p).toLowerCase()]) return null;
    const real = realpathSync(resolve(p));
    if (!statSync(real).isFile()) return null;
    const allRoots = Array.isArray(roots) ? [...roots] : imageAllowedRoots();
    let resolvedExtra = null;
    if (typeof extraCwd === "string" && extraCwd.trim()) {
      resolvedExtra = extraCwd.trim();
    } else if (extraCwd && typeof extraCwd === "object") {
      resolvedExtra = extraCwd.extraCwd || (extraCwd.agentId ? lookupAgentCwd(extraCwd.agentId, extraCwd.paseoHome) : null);
    }
    if (resolvedExtra) {
      try {
        allRoots.push(realpathSync(resolve(resolvedExtra)));
      } catch {}
    }
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

// Connect-style middleware: handles /__vibesquad/* and /api/*, calls next() for everything else.
// Everything except health, /ca.crt and /pair needs a paired device or a same-origin loopback caller.
export function createVibesquadMiddleware(rootDir = REPO_ROOT, opts = {}) {
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/health" || path === "/__vibesquad/health") return handleHealth(req, res, rootDir);
    if (path === "/ca.crt") return handleCaCrt(req, res);
    if (path === "/pair") return handlePairRedeem(req, res);
    if ((path.startsWith("/__vibesquad/") || path.startsWith("/api/")) && !isTrusted(req)) {
      if (isLocal(req)) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 401, { error: "unpaired device" });
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return sendJson(res, 413, { error: "payload too large" });
    if (path === "/api/auth/status" || path === "/__vibesquad/auth/status") return handleAuthStatus(req, res, rootDir);
    if (path === "/api/teams") return handleTeams(req, res, rootDir);
    if (path === "/api/profiles") return handleProfiles(req, res);
    if (path === "/__vibesquad/local-image") return handleLocalImage(req, res);
    if (path === "/VibeSquad-setup.exe" || path === "/__vibesquad/desktop/VibeSquad-setup.exe") {
      return handleDesktopInstaller(req, res, rootDir);
    }
    if (path === "/__vibesquad/desktop/update.json") {
      return handleDesktopUpdateJson(req, res, rootDir);
    }
    if (!path.startsWith("/__vibesquad/")) return next?.();
    switch (path) {
      case "/__vibesquad/pair/start":
        return handlePairStart(req, res);
      case "/__vibesquad/devices":
        return handleDevices(req, res);
      case "/__vibesquad/devices/revoke":
        return handleRevoke(req, res, readBody);
      case "/__vibesquad/teams":
        return handleTeams(req, res, rootDir);
      case "/__vibesquad/settings":
        return handleSettings(req, res);
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
      case "/__vibesquad/push/test":
        return handlePushTest(req, res);
      case "/__vibesquad/profiles":
        return handleProfiles(req, res);
      case "/__vibesquad/profiles/import":
        return handleProfilesImport(req, res);
      case "/__vibesquad/profiles/diff":
        return handleProfilesDiff(req, res);
      default:
        return next?.();
    }
  };
}
