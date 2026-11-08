import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
let teamsTmpSeq = 0;

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
 * Shared atomic + revision-checked writer for teams.json (used by both the server PUT/POST handler and `vs pin`).
 * Returns `{ status: 200 | 409, file, prevTeams, body }`.
 */
export function writeTeamsRegistry(parsed, rootDir = REPO_ROOT) {
  const teams = Array.isArray(parsed) ? parsed : parsed?.teams;
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
    return { status: 409, file: readPath, prevTeams: cur.teams, body: { error: "teams.json changed", ...cur, revision: currentRevision } };
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Unique per write, so two PUTs in this process never share a temp file.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++teamsTmpSeq}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
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
    },
  };
}

