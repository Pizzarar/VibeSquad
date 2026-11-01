import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The one teams registry lookup shared by the server, the CLI and the plugin's server modules.
// Order: VIBESQUAD_TEAMS_FILE > <VIBESQUAD_HOME or ~/.vibesquad>/teams.json > <repo>/teams.json > teams.example.json.
// VIBESQUAD_IGNORE_HOME_TEAMS skips the home file. Env is read per call so tests can point it at temp dirs.

export function vibesquadHome() {
  return path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
}

export function homeTeamsFilePath() {
  return path.join(vibesquadHome(), "teams.json");
}

export function resolveTeamsFilePath(rootDir) {
  if (process.env.VIBESQUAD_TEAMS_FILE) {
    const p = path.resolve(process.env.VIBESQUAD_TEAMS_FILE);
    if (fs.existsSync(p)) return p;
  }
  if (!process.env.VIBESQUAD_IGNORE_HOME_TEAMS) {
    const homeTeams = homeTeamsFilePath();
    if (fs.existsSync(homeTeams)) return homeTeams;
  }
  const local = path.join(rootDir, "teams.json");
  if (fs.existsSync(local)) return local;
  return path.join(rootDir, "teams.example.json");
}

/** Where a save goes: the file being read, except the bundled example is never overwritten. */
export function resolveTeamsWritePath(rootDir) {
  if (process.env.VIBESQUAD_TEAMS_FILE) return path.resolve(process.env.VIBESQUAD_TEAMS_FILE);
  const read = resolveTeamsFilePath(rootDir);
  if (path.basename(read) !== "teams.example.json") return read;
  return process.env.VIBESQUAD_IGNORE_HOME_TEAMS ? path.join(rootDir, "teams.json") : homeTeamsFilePath();
}
