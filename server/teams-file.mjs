import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { isForbiddenRealHome, isForbiddenRepoTeams } from "./test-guard.mjs";
import { clearConfigWarning, readJsonFileWithBom } from "./user-settings.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEAM_ID = /^[A-Za-z0-9_-]+$/;
const MAX_TEAMS = 200;
const MAX_LANES = 500;
const MAX_PATHS = 64;
const MAX_PATH_LEN = 1024;
const LEAD_FLAG_DEFAULT = 150_000;
const LEAD_AUTO_HANDOFF_DEFAULT = 250_000;
const LEAD_HARD_CAP_DEFAULT = 300_000;
const MAX_FOLDERS = 64;
const MAX_FOLDER_NAME = 64;
let teamsTmpSeq = 0;

// ---- B11a: project folders + Active/Asleep (docs/lanes/boring-mode) ----
// A folder is `{ name, asleep }` at the top level of teams.json; a team joins one with `team.folder = <name>`. A team in an
// asleep folder gets no automated wakes (idle kicks, schedules, watch pings, tester-card delivery, token nudges, restart
// drain asks). Nothing is killed on sleep and owner-typed messages always go through. No `folders` key = one asleep Backlog.

export const DEFAULT_FOLDERS = Object.freeze([Object.freeze({ name: "Backlog", asleep: true })]);

/** The folder list of a parsed teams.json (or `{ folders }`): its own when it has one, else a fresh copy of the default. */
export function foldersOf(data) {
  if (Array.isArray(data?.folders)) return data.folders;
  return DEFAULT_FOLDERS.map((f) => ({ ...f }));
}

const lc = (v) => String(v ?? "").trim().toLowerCase();

/**
 * True when a team sits in an asleep folder. `teamOrId` is a team object or an id looked up (case-insensitive) in `cfg.teams`.
 * No folder, an unknown folder or an unknown team: awake (false), so a typo never silences a Squad.
 */
export function isTeamAsleep(teamOrId, cfg = {}) {
  const team = typeof teamOrId === "string"
    ? (Array.isArray(cfg?.teams) ? cfg.teams.find((t) => lc(t?.id) === lc(teamOrId) && lc(teamOrId)) : null)
    : teamOrId;
  const name = typeof team?.folder === "string" ? team.folder : "";
  if (!name) return false;
  const folder = foldersOf(cfg).find((f) => f?.name === name);
  return Boolean(folder?.asleep);
}

/** Lowercased ids of every asleep team in `cfg` (`{ teams, folders }`). */
export function asleepTeamIds(cfg = {}) {
  const out = new Set();
  for (const t of Array.isArray(cfg?.teams) ? cfg.teams : []) {
    if (t?.id && isTeamAsleep(t, cfg)) out.add(lc(t.id));
  }
  return out;
}

const teamsConfigCache = new Map();
/**
 * `{ teams, folders }` from the live registry, cached on the file's path + mtime + size + inode so per-tick callers (idle
 * kick, schedules, watch sets) see a wake on their next tick without re-parsing an unchanged file.
 */
export function readTeamsConfig(rootDir = REPO_ROOT) {
  const file = resolveTeamsFilePath(rootDir);
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {}
  const key = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "missing";
  const hit = teamsConfigCache.get(file);
  if (hit && hit.key === key) return hit.cfg;
  const res = readJsonFileWithBom(file, { label: "teams.json", fallback: null, recordWarning: true });
  const data = res.data && typeof res.data === "object" ? res.data : {};
  const cfg = { teams: Array.isArray(data.teams) ? data.teams : [], folders: foldersOf(data) };
  teamsConfigCache.set(file, { key, cfg });
  return cfg;
}

/** Throws on a folders array the registry can't safely hold: `{ name, asleep }`, names trimmed, non-empty and unique. */
export function validateFoldersBody(folders) {
  if (!Array.isArray(folders)) throw new Error("folders must be an array");
  if (folders.length > MAX_FOLDERS) throw new Error("too many folders");
  const seen = new Set();
  for (const f of folders) {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("each folder must be an object");
    if (typeof f.name !== "string" || !f.name.trim() || f.name !== f.name.trim() || f.name.length > MAX_FOLDER_NAME) {
      throw new Error("bad folder name");
    }
    if (typeof f.asleep !== "boolean") throw new Error(`folder ${f.name}: asleep must be a boolean`);
    if (seen.has(f.name)) throw new Error(`duplicate folder ${f.name}`);
    seen.add(f.name);
  }
}

// The one teams registry lookup shared by the server, the CLI and the plugin's server modules.
// Order: VIBESQUAD_TEAMS_FILE > <VIBESQUAD_HOME or ~/.vibesquad>/teams.json > <repo>/teams.json > teams.example.json.
// VIBESQUAD_IGNORE_HOME_TEAMS skips the home file. Env is read per call so tests can point it at temp dirs.

export function vibesquadHome() {
  return path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
}

export function homeTeamsFilePath() {
  return path.join(vibesquadHome(), "teams.json");
}

export function resolveTeamsFilePath(rootDir = REPO_ROOT) {
  if (process.env.VIBESQUAD_TEAMS_FILE) {
    const p = path.resolve(process.env.VIBESQUAD_TEAMS_FILE);
    if (fs.existsSync(p)) return p;
  }
  if (!process.env.VIBESQUAD_IGNORE_HOME_TEAMS && !isForbiddenRealHome(vibesquadHome())) {
    const homeTeams = homeTeamsFilePath();
    if (fs.existsSync(homeTeams)) return homeTeams;
  }
  const local = path.join(rootDir, "teams.json");
  if (fs.existsSync(local) && !isForbiddenRepoTeams(local)) return local;
  return path.join(rootDir, "teams.example.json");
}

/** Where a save goes: the file being read, except the bundled example is never overwritten. */
export function resolveTeamsWritePath(rootDir = REPO_ROOT) {
  if (process.env.VIBESQUAD_TEAMS_FILE) return path.resolve(process.env.VIBESQUAD_TEAMS_FILE);
  const read = resolveTeamsFilePath(rootDir);
  if (path.basename(read) !== "teams.example.json") return read;
  return process.env.VIBESQUAD_IGNORE_HOME_TEAMS ? path.join(rootDir, "teams.json") : homeTeamsFilePath();
}

/** Content hash of the registry file; a PUT that sends a stale one gets 409 instead of overwriting newer edits. */
export function teamsRevision(file) {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "none";
  }
}

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
    if (t.folder !== undefined && (typeof t.folder !== "string" || !t.folder.trim() || t.folder !== t.folder.trim() || t.folder.length > MAX_FOLDER_NAME)) {
      throw new Error(`team ${t.id}: bad folder`);
    }
    if (t.quickLanes !== undefined) {
      if (!t.quickLanes || typeof t.quickLanes !== "object" || Array.isArray(t.quickLanes)) {
        throw new Error(`team ${t.id}: bad quickLanes`);
      }
      for (const v of Object.values(t.quickLanes)) {
        if (v !== undefined && (typeof v !== "string" || !TEAM_ID.test(v))) {
          throw new Error(`team ${t.id}: bad quickLanes`);
        }
      }
    }
    if (t.lanes === undefined) continue;
    if (!Array.isArray(t.lanes) || t.lanes.length > MAX_LANES) throw new Error(`team ${t.id}: lanes must be an array`);
    for (const l of t.lanes) {
      if (!l || typeof l !== "object" || Array.isArray(l)) throw new Error(`team ${t.id}: each lane must be an object`);
      if (typeof l.id !== "string" || !TEAM_ID.test(l.id)) throw new Error(`team ${t.id}: bad lane id`);
      checkPaths(l, `lane ${l.id}`);
    }
  }
}

/**
 * Shared locked + atomic + revision-checked writer for teams.json. Returns `{ status: 200 | 409, file, prevTeams, body }`.
 * Sync (blocks while the lock is busy): `vs pin` and other one-shot callers. The server uses writeTeamsRegistryAsync.
 */
export function writeTeamsRegistry(parsed, rootDir = REPO_ROOT) {
  const { file, write } = teamsRegistryWrite(parsed, rootDir);
  return withFileLockSync(file, write);
}

/** writeTeamsRegistry for the server process: waits for the lock without blocking the event loop (idea-227). */
export async function writeTeamsRegistryAsync(parsed, rootDir = REPO_ROOT) {
  const { file, write } = teamsRegistryWrite(parsed, rootDir);
  return withFileLock(file, write);
}

/**
 * B11a: one folder/team-folder edit applied to the CURRENT registry inside the lock, so it never clobbers a concurrent write.
 * `op`: createFolder {name, asleep?} | renameFolder {name, newName} | deleteFolder {name} | setFolderAsleep {name, asleep}
 * | setTeamFolder {teamId, folder|null}; optional `revision` is checked like a PUT. Returns `{ status, file, prevTeams, body }`
 * (400 bad op, 404 unknown folder/team, 409 duplicate name or stale revision).
 */
export async function patchTeamsRegistryAsync(op, rootDir = REPO_ROOT) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return { status: 400, body: { error: "body must be an object" } };
  const file = resolveTeamsWritePath(rootDir);
  return withFileLock(file, (lock) => {
    const { cur, readPath, currentRevision } = readCurrentRegistry(rootDir);
    if (typeof op.revision === "string" && op.revision !== currentRevision) {
      return { status: 409, file: readPath, prevTeams: cur.teams, body: { error: "teams.json changed", ...cur, folders: foldersOf(cur), revision: currentRevision } };
    }
    const r = applyFolderOp(op, Array.isArray(cur.teams) ? cur.teams : [], foldersOf(cur));
    if (r.error) return { status: r.status, file: readPath, prevTeams: cur.teams, body: { error: r.error } };
    try {
      validateTeamsBody(r.teams);
      validateFoldersBody(r.folders);
    } catch (e) {
      return { status: 400, file: readPath, prevTeams: cur.teams, body: { error: String(e?.message ?? e) } };
    }
    return commitRegistry(lock, { rootDir, file, parsed: {}, cur, teams: r.teams, folders: r.folders });
  });
}

/** Pure: the `{ teams, folders }` after one PATCH op, or `{ status, error }`. Never mutates its inputs. */
export function applyFolderOp(op, teams, folders) {
  const name = typeof op.name === "string" ? op.name.trim() : "";
  const has = (n) => folders.some((f) => f.name === n);
  const bad = (status, error) => ({ status, error });
  switch (op.op) {
    case "createFolder": {
      if (!name) return bad(400, "name is required");
      if (op.asleep !== undefined && typeof op.asleep !== "boolean") return bad(400, "asleep must be a boolean");
      if (has(name)) return bad(409, `folder ${name} already exists`);
      return { teams, folders: [...folders, { name, asleep: op.asleep === true }] };
    }
    case "renameFolder": {
      const newName = typeof op.newName === "string" ? op.newName.trim() : "";
      if (!name || !newName) return bad(400, "name and newName are required");
      if (!has(name)) return bad(404, `no folder ${name}`);
      if (newName !== name && has(newName)) return bad(409, `folder ${newName} already exists`);
      return {
        teams: teams.map((t) => (t?.folder === name ? { ...t, folder: newName } : t)),
        folders: folders.map((f) => (f.name === name ? { ...f, name: newName } : f)),
      };
    }
    case "deleteFolder": {
      if (!name) return bad(400, "name is required");
      if (!has(name)) return bad(404, `no folder ${name}`);
      return {
        teams: teams.map((t) => (t?.folder === name ? withoutFolder(t) : t)),
        folders: folders.filter((f) => f.name !== name),
      };
    }
    case "setFolderAsleep": {
      if (!name) return bad(400, "name is required");
      if (typeof op.asleep !== "boolean") return bad(400, "asleep must be a boolean");
      if (!has(name)) return bad(404, `no folder ${name}`);
      return { teams, folders: folders.map((f) => (f.name === name ? { ...f, asleep: op.asleep } : f)) };
    }
    case "setTeamFolder": {
      const teamId = typeof op.teamId === "string" ? op.teamId : "";
      if (!teamId) return bad(400, "teamId is required");
      if (op.folder !== null && op.folder !== undefined && typeof op.folder !== "string") return bad(400, "folder must be a string or null");
      const folder = typeof op.folder === "string" ? op.folder.trim() : "";
      const idx = teams.findIndex((t) => lc(t?.id) === lc(teamId));
      if (idx < 0) return bad(404, `no team ${teamId}`);
      if (folder && !has(folder)) return bad(404, `no folder ${folder}`);
      const next = teams.slice();
      next[idx] = folder ? { ...teams[idx], folder } : withoutFolder(teams[idx]);
      return { teams: next, folders };
    }
    default:
      return bad(400, "unknown op");
  }
}

function withoutFolder(t) {
  const { folder: _folder, ...rest } = t;
  return rest;
}

function readCurrentRegistry(rootDir) {
  const readPath = resolveTeamsFilePath(rootDir);
  const curRes = readJsonFileWithBom(readPath, {
    label: "teams.json",
    fallback: {},
    recordWarning: true,
  });
  const { revision: _staleRevision, ...cur } = curRes.data ?? {};
  return { cur, readPath, currentRevision: teamsRevision(readPath) };
}

/** Validates the body (throws) and returns the locked write for <teams.json>.lock. */
function teamsRegistryWrite(parsed, rootDir) {
  const teams = Array.isArray(parsed) ? parsed : parsed?.teams;
  validateTeamsBody(teams);
  const folders = !Array.isArray(parsed) && parsed?.folders !== undefined ? parsed.folders : undefined;
  if (folders !== undefined) validateFoldersBody(folders);
  const file = resolveTeamsWritePath(rootDir);
  return { file, write: (lock) => {
    const { cur, readPath, currentRevision } = readCurrentRegistry(rootDir);
    if (!Array.isArray(parsed) && typeof parsed.revision === "string" && parsed.revision !== currentRevision) {
      return { status: 409, file: readPath, prevTeams: cur.teams, body: { error: "teams.json changed", ...cur, folders: foldersOf(cur), revision: currentRevision } };
    }
    return commitRegistry(lock, { rootDir, file, parsed: Array.isArray(parsed) ? {} : parsed, cur, teams, folders });
  } };
}

/** Writes `cur` + the new teams (+ folders when given; else the file's own are kept) atomically under the held lock. */
function commitRegistry(lock, { rootDir, file, parsed, cur, teams, folders }) {
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
    ...(folders !== undefined ? { folders } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Unique per write, so two PUTs in this process never share a temp file.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++teamsTmpSeq}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    // idea-234 (L4 parity with file-lock updateJsonFile): a holder reaped as stale must not rename its stale view over
    // the newer writer's teams.json. Checked last, right before the rename; the catch below drops the temp file.
    lock.assertOwned();
    fs.renameSync(tmp, file);
    // Drop the read cache now: an in-process write must never depend on the stat key (NTFS may reuse an ino) changing.
    teamsConfigCache.delete(file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  clearConfigWarning(file);
  return {
    status: 200,
    file,
    prevTeams: cur.teams,
    body: {
      ok: true,
      revision: teamsRevision(resolveTeamsFilePath(rootDir)),
      teams: next.teams,
      leadFlagTokens: next.leadFlagTokens,
      leadAutoHandoffTokens: next.leadAutoHandoffTokens,
      leadHardCapTokens: next.leadHardCapTokens,
      folders: foldersOf(next),
    },
  };
}

