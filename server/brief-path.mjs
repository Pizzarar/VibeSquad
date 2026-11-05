import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findLaneInRegistry, resolveWorktreeRootPath } from "./identity.mjs";
import { resolveTeamsFilePath } from "./teams-file.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

// The one place that decides which folder holds docs/brainstorm/<lane>.md. Shared by the server and the Paseo plugin.

function loadTeams(rootDir) {
  const res = readJsonFileWithBom(resolveTeamsFilePath(rootDir), { label: "teams.json", fallback: { teams: [] }, recordWarning: true });
  return (res.data ?? { teams: [] }).teams ?? [];
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Folder a never-spawned Team should start in. Registry paths are usually folder names ("MyGame")
 * matched against agent cwds, so try each as an absolute path, then as a sibling of this repo's main checkout,
 * then under ~/projects. Lane paths win over team paths. Returns null when nothing exists on disk.
 */
export function laneWorkingDir(teamId, laneId, rootDir) {
  const teams = loadTeams(rootDir);
  // Lane ids, aliases and names all resolve; the named team's lanes win a tie.
  const hit = (teamId && findLaneInRegistry(laneId, teams.filter((t) => t.id === teamId))) || findLaneInRegistry(laneId, teams);
  const team = hit?.team || teams.find((t) => t.id === teamId);
  if (!team) return null;
  const lane = hit?.lane;
  const candidates = [...(lane?.paths ?? []), ...(lane?.path ? [lane.path] : []), ...(team.paths ?? [])]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);
  for (const p of candidates) {
    const full = resolveProjectPath(p, rootDir, { warn: true });
    if (full) return full;
  }
  return null;
}

const projectBases = (rootDir) => {
  const mainRoot = resolveWorktreeRootPath(rootDir) || rootDir;
  return [...new Set([dirname(resolve(mainRoot)), dirname(resolve(rootDir)), join(homedir(), "projects")])];
};

/**
 * One registry path ("MyGame" or an absolute path) as an existing folder inside the project roots, or null.
 * UNC / device paths are refused before any fs call (a stat would reach out over SMB).
 */
export function resolveProjectPath(p, rootDir, { warn = false } = {}) {
  const raw = String(p ?? "").trim();
  if (!raw || /^[\\/]{2}/.test(raw)) return null;
  const bases = projectBases(rootDir);
  const tries = isAbsolute(raw) ? [resolve(raw)] : bases.map((base) => resolve(base, raw));
  for (const full of tries) {
    if (!insideProjectRoots(full, bases)) {
      if (warn && isDir(full)) console.warn(`[vibesquad] ignoring lane path outside the project folders: ${full}`);
      continue;
    }
    if (isDir(full)) return full;
  }
  return null;
}

// A lane folder must be a project under one of the sibling roots (the main checkout counts), never a root itself or above it.
function insideProjectRoots(full, bases) {
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return bases.some((base) => {
    const rel = relative(norm(resolve(base)), norm(full));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}


/**
 * Folder holding `docs/brainstorm/<lane>.md`: the lane's project working dir, because the installed app's
 * rootDir is its own runtime folder. Falls back to rootDir only when no project dir resolves (dev).
 */
export function briefRootFor(teamId, laneId, rootDir) {
  return laneWorkingDir(teamId, laneId, rootDir) || rootDir;
}
