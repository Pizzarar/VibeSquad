import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

function resolveTeamsFilePath(rootDir = DEFAULT_ROOT) {
  if (process.env.VIBESQUAD_TEAMS_FILE) {
    const p = path.resolve(process.env.VIBESQUAD_TEAMS_FILE);
    if (fs.existsSync(p)) return p;
  }
  if (!process.env.VIBESQUAD_IGNORE_HOME_TEAMS) {
    const homeTeams = path.join(
      process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"),
      "teams.json",
    );
    if (fs.existsSync(homeTeams)) return homeTeams;
  }
  const local = path.join(rootDir, "teams.json");
  if (fs.existsSync(local)) return local;
  return path.join(rootDir, "teams.example.json");
}

export const UNASSIGNED_TEAM_ID = "_unassigned";
export const UNASSIGNED_TEAM_NAME = "Unassigned";
export const DIGEST_PROFILE = "Pre-check - Flash";

/**
 * Load the Squad & Lane registry from teams.json.
 * Accepts either a parsed teams array, a parsed teams.json object, or a repo root path.
 */
export function loadTeamsRegistry(rootDirOrTeams = DEFAULT_ROOT) {
  if (Array.isArray(rootDirOrTeams)) return rootDirOrTeams;
  if (rootDirOrTeams && typeof rootDirOrTeams === "object" && Array.isArray(rootDirOrTeams.teams)) {
    return rootDirOrTeams.teams;
  }
  const rootDir = typeof rootDirOrTeams === "string" ? rootDirOrTeams : DEFAULT_ROOT;
  try {
    const file = resolveTeamsFilePath(rootDir);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.teams) ? parsed.teams : [];
  } catch {
    return [];
  }
}

function extractLabels(agentOrLabels) {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return {};
  if (agentOrLabels.labels && typeof agentOrLabels.labels === "object") {
    return agentOrLabels.labels;
  }
  if (
    agentOrLabels.config &&
    typeof agentOrLabels.config === "object" &&
    agentOrLabels.config.labels &&
    typeof agentOrLabels.config.labels === "object"
  ) {
    return agentOrLabels.config.labels;
  }
  if (
    "lane" in agentOrLabels ||
    "team" in agentOrLabels ||
    "role" in agentOrLabels ||
    "ord" in agentOrLabels ||
    "lead" in agentOrLabels ||
    "orphan" in agentOrLabels ||
    "digestFor" in agentOrLabels ||
    "profile" in agentOrLabels ||
    "topic" in agentOrLabels
  ) {
    return agentOrLabels;
  }
  return {};
}

/**
 * Strictly label-based retired role check (never inspects title/name).
 */
export function isRetiredRole(roleValue) {
  const r = String(roleValue ?? "").trim().toLowerCase();
  if (!r) return false;
  return r.startsWith("former-") || r === "old-lead" || r === "retired" || r === "old";
}

/**
 * Strictly label/status-based retired check (never inspects title/name).
 */
export function isRetiredAgent(agentOrLabels) {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return false;
  const labels = extractLabels(agentOrLabels);
  if (isRetiredRole(labels.role)) return true;
  if (agentOrLabels.archivedAt) return true;
  if (agentOrLabels.status === "closed") return true;
  return false;
}

/**
 * Strictly label-based digest check (never inspects title/name).
 */
export function isDigestAgent(agentOrLabels) {
  const labels = extractLabels(agentOrLabels);
  if (labels.digestFor) return true;
  const role = String(labels.role ?? "").trim().toLowerCase();
  if (role === "digest") return true;
  const profile = String(labels.profile ?? "").trim();
  if (/^pre-check\s*-\s*flash$/i.test(profile)) return true;
  return false;
}

/**
 * Canonical role label value for an agent/labels object (never inspects title/name).
 * Preserves former-lead / former-brainstorm / digest / lead / brainstorm / worker.
 */
export function normalizeRoleLabel(agentOrLabels, fallbackRole = "worker") {
  const labels = extractLabels(agentOrLabels);
  if (isDigestAgent(labels)) return "digest";
  const raw = String(labels.role ?? "").trim().toLowerCase();
  if (raw === "old-lead" || raw === "retired" || raw === "former-lead" || raw === "old") return "former-lead";
  if (raw === "former-brainstorm") return "former-brainstorm";
  if (raw.startsWith("former-")) return raw;
  if (raw === "lead") return "lead";
  if (raw === "brainstorm" || raw === "buddy") return "brainstorm";
  if (raw === "worker") return "worker";
  const fb = String(fallbackRole || "worker").trim().toLowerCase();
  if (fb === "buddy") return "brainstorm";
  return fb || "worker";
}

/**
 * Effective runtime role for live roster/routing checks (never inspects title/name).
 * Returns "retired" | "digest" | "lead" | "brainstorm" | "worker".
 */
export function effectiveAgentRole(agentOrLabels, fallbackRole = "worker") {
  if (isRetiredAgent(agentOrLabels)) return "retired";
  if (isDigestAgent(agentOrLabels)) return "digest";
  const role = normalizeRoleLabel(agentOrLabels, fallbackRole);
  if (role === "lead") return "lead";
  if (role === "brainstorm") return "brainstorm";
  return "worker";
}

/**
 * UI/roster kind strictly from role labels (never inspects title/name).
 * Returns "old-lead" | "lead" | "brainstorm" | "worker".
 */
export function kindOf(agentOrLabels) {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.role ?? "").trim().toLowerCase();
  if (isRetiredRole(raw)) return "old-lead";
  if (raw === "lead") return "lead";
  if (raw === "brainstorm" || raw === "buddy") return "brainstorm";
  return "worker";
}

export function isBrainstormAgent(agentOrLabels) {
  return kindOf(agentOrLabels) === "brainstorm";
}

/**
 * Lead ordinal as a number strictly from labels.ord (defaults to 1).
 */
export function ordOf(agentOrLabels) {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.ord ?? "").trim();
  if (!raw) return 1;
  const n = Number.parseInt(raw.replace(/^ord/i, ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * Lead ordinal as a string strictly from labels.ord (defaults to "1").
 */
export function ordStringOf(agentOrLabels) {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.ord ?? "").trim();
  if (!raw) return "1";
  const cleaned = raw.replace(/^ord/i, "").trim();
  return /^\d+$/.test(cleaned) ? cleaned : "1";
}

/**
 * Brainstorm topic strictly from labels.topic or labels["vs.inbox-card-id"].
 */
export function topicOf(agentOrLabels) {
  const labels = extractLabels(agentOrLabels);
  return String(labels.topic ?? labels["vs.inbox-card-id"] ?? "").trim();
}

/**
 * Look up a lane in the teams.json registry by id, alias, or name (case-insensitive).
 * Returns { team, lane } or null.
 */
export function findLaneInRegistry(laneQuery, teams = loadTeamsRegistry()) {
  const q = String(laneQuery ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const team of teams) {
    for (const lane of team.lanes || []) {
      if (String(lane.id ?? "").toLowerCase() === q) {
        return { team, lane };
      }
      if (Array.isArray(lane.aliases) && lane.aliases.some((a) => String(a).toLowerCase() === q)) {
        return { team, lane };
      }
    }
  }
  for (const team of teams) {
    for (const lane of team.lanes || []) {
      if (String(lane.name ?? "").toLowerCase() === q) {
        return { team, lane };
      }
    }
  }
  return null;
}

/**
 * Look up a Squad (team) in the teams.json registry by id or name (case-insensitive).
 */
export function findTeamInRegistry(teamQuery, teams = loadTeamsRegistry()) {
  const q = String(teamQuery ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const team of teams) {
    if (String(team.id ?? "").toLowerCase() === q || String(team.name ?? "").toLowerCase() === q) {
      return team;
    }
  }
  return null;
}

/**
 * Check if a lane string is a dynamic feature lane slug prefixed with `<team.id>-`
 * (e.g. `efi-ui`, `efi-combat`, `vibesquad-voice`).
 */
function matchDynamicPrefixedLane(laneQuery, rawTeam, teams) {
  const q = String(laneQuery ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const team of teams) {
    const tid = String(team.id ?? "").toLowerCase();
    if (!tid) continue;
    if (q.startsWith(`${tid}-`) && q.length > tid.length + 1) {
      if (rawTeam) {
        const matchedCallerTeam = findTeamInRegistry(rawTeam, teams);
        if (matchedCallerTeam && matchedCallerTeam.id !== team.id) {
          continue;
        }
      }
      return {
        team,
        lane: {
          id: String(laneQuery).trim(),
          name: String(laneQuery).trim(),
          dynamic: true,
        },
      };
    }
  }
  return null;
}

/**
 * Walk up from `startDir` looking for a `.git` file with a `gitdir:` pointer to `/.git/worktrees/`,
 * returning the main repository path if found.
 */
export function resolveWorktreeRootPath(startDir) {
  if (!startDir || typeof startDir !== "string") return null;
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  for (let i = 0; i < 12; i++) {
    const dotGit = path.join(dir, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isFile()) {
        const raw = fs.readFileSync(dotGit, "utf8");
        const m = raw.match(/gitdir:\s*(.+)/i);
        if (m) {
          const gitDir = path.resolve(dir, m[1].trim());
          const norm = gitDir.replace(/\\/g, "/");
          const idx = norm.lastIndexOf("/.git/worktrees/");
          if (idx !== -1) {
            return norm.slice(0, idx);
          }
        }
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function matchSinglePathString(targetPath, teams) {
  const norm = String(targetPath ?? "").replace(/\\/g, "/").toLowerCase();
  if (!norm) return null;
  for (const team of teams) {
    for (const lane of team.lanes || []) {
      const lanePaths = Array.isArray(lane.paths) ? lane.paths : [];
      for (const pat of lanePaths) {
        const p = String(pat ?? "").replace(/\\/g, "/").toLowerCase();
        if (p && norm.includes(p)) {
          return { team, lane };
        }
      }
    }
  }
  for (const team of teams) {
    const teamPaths = Array.isArray(team.paths) ? team.paths : [];
    for (const pat of teamPaths) {
      const p = String(pat ?? "").replace(/\\/g, "/").toLowerCase();
      if (p && norm.includes(p)) {
        const defaultLane = team.lanes?.[0] || { id: team.id, name: team.name };
        return { team, lane: defaultLane };
      }
    }
  }
  return null;
}

/**
 * Match a working directory (or its git worktree main repo root) against registered lane/team paths.
 * Returns { team, lane } or null.
 */
export function matchPathInRegistry(cwd, teams = loadTeamsRegistry()) {
  if (!cwd) return null;
  const direct = matchSinglePathString(cwd, teams);
  if (direct) return direct;
  const wtRoot = resolveWorktreeRootPath(cwd);
  if (wtRoot) {
    return matchSinglePathString(wtRoot, teams);
  }
  return null;
}

function resolveParentMapLookup(parentId, options) {
  if (!parentId) return null;
  if (typeof options?.getParent === "function") {
    return options.getParent(parentId);
  }
  const byId = options?.agentsById;
  if (!byId) return null;
  if (byId instanceof Map) return byId.get(parentId) || null;
  if (typeof byId === "object") return byId[parentId] || null;
  return null;
}

/**
 * Resolve an agent's canonical Identity v2 (`lane`, `team`, `role`, `ord`, `topic`, `isOrphan`, `source`).
 */
export function resolveAgentIdentity(agentOrInput, options = {}) {
  const teams = options.teams ?? loadTeamsRegistry(options.rootDir);
  const labels = extractLabels(agentOrInput);
  const cwd = String(options.cwd ?? agentOrInput?.cwd ?? agentOrInput?.config?.cwd ?? "").trim();
  const fallbackRole = options.fallbackRole ?? "worker";

  const role = normalizeRoleLabel(labels, fallbackRole);
  const effectiveRole = effectiveAgentRole(agentOrInput, fallbackRole);
  const retired = isRetiredAgent(agentOrInput);
  const digest = isDigestAgent(labels);
  const ord = ordStringOf(labels);
  const ordNum = ordOf(labels);
  const topic = topicOf(labels);

  const rawLane = String(options.lane ?? labels.lane ?? labels.lead ?? "").trim();
  const rawTeam = String(options.team ?? labels.team ?? "").trim();
  const explicitOrphan =
    (labels.orphan === "1" || labels.orphan === "true") && !options.recomputeOrphan;

  // Step 1: Registry lookup on `labels.lane` (or legacy `labels.lead`)
  if (rawLane && !explicitOrphan) {
    const regMatch = findLaneInRegistry(rawLane, teams) || matchDynamicPrefixedLane(rawLane, rawTeam, teams);
    if (regMatch) {
      const { team, lane } = regMatch;
      const callerTeamObj = rawTeam ? findTeamInRegistry(rawTeam, teams) : null;
      const teamMismatch = Boolean(rawTeam && (!callerTeamObj || callerTeamObj.id !== team.id));
      return {
        laneId: lane.id,
        laneName: lane.name || lane.id,
        teamId: team.id,
        teamName: team.name || team.id,
        role,
        effectiveRole,
        ord,
        ordNum,
        topic,
        isRetired: retired,
        isDigest: digest,
        isOrphan: false,
        orphan: "",
        source: "registry",
        autofixedFromCwd: false,
        usedTeamFallback: false,
        teamMismatch,
        callerTeam: rawTeam,
        callerLane: rawLane,
      };
    }
  }

  if (explicitOrphan) {
    return {
      laneId: "",
      laneName: UNASSIGNED_TEAM_NAME,
      teamId: UNASSIGNED_TEAM_ID,
      teamName: UNASSIGNED_TEAM_NAME,
      role,
      effectiveRole,
      ord,
      ordNum,
      topic,
      isRetired: retired,
      isDigest: digest,
      isOrphan: true,
      orphan: "1",
      source: "orphan",
      autofixedFromCwd: false,
      usedTeamFallback: false,
      teamMismatch: false,
      callerTeam: rawTeam,
      callerLane: rawLane,
    };
  }

  // Step 2: Match `cwd` against registered lane/team paths
  if (cwd) {
    const pathMatch = matchPathInRegistry(cwd, teams);
    if (pathMatch) {
      const { team, lane } = pathMatch;
      const callerTeamObj = rawTeam ? findTeamInRegistry(rawTeam, teams) : null;
      const teamMismatch = Boolean(rawTeam && (!callerTeamObj || callerTeamObj.id !== team.id));
      return {
        laneId: lane.id,
        laneName: lane.name || lane.id,
        teamId: team.id,
        teamName: team.name || team.id,
        role,
        effectiveRole,
        ord,
        ordNum,
        topic,
        isRetired: retired,
        isDigest: digest,
        isOrphan: false,
        orphan: "",
        source: "cwd-autofix",
        autofixedFromCwd: true,
        usedTeamFallback: false,
        teamMismatch,
        callerTeam: rawTeam,
        callerLane: rawLane,
      };
    }
  }

  // Step 3: Legacy 2-week `labels.team` fallback
  if (rawTeam && (!cwd || !rawLane)) {
    const matchedTeam = findTeamInRegistry(rawTeam, teams);
    if (matchedTeam) {
      const defaultLane = matchedTeam.lanes?.[0] || { id: matchedTeam.id, name: matchedTeam.name };
      const laneId = rawLane || defaultLane.id;
      const laneName = rawLane ? rawLane : defaultLane.name || defaultLane.id;
      return {
        laneId,
        laneName,
        teamId: matchedTeam.id,
        teamName: matchedTeam.name || matchedTeam.id,
        role,
        effectiveRole,
        ord,
        ordNum,
        topic,
        isRetired: retired,
        isDigest: digest,
        isOrphan: false,
        orphan: "",
        source: "team-fallback",
        autofixedFromCwd: false,
        usedTeamFallback: true,
        teamMismatch: false,
        callerTeam: rawTeam,
        callerLane: rawLane,
      };
    }
  }

  // Step 4: Parent chain (`paseo.parent-agent-id`, depth <= 8)
  const depth = Number(options._depth ?? 0);
  const parentId = String(labels["paseo.parent-agent-id"] ?? agentOrInput?.parentAgentId ?? "").trim();
  if (parentId && depth < 8) {
    const parentAgent = resolveParentMapLookup(parentId, options);
    if (parentAgent) {
      const parentResolved = resolveAgentIdentity(parentAgent, {
        ...options,
        cwd: undefined,
        lane: undefined,
        team: undefined,
        _depth: depth + 1,
      });
      if (!parentResolved.isOrphan && parentResolved.laneId && parentResolved.teamId !== UNASSIGNED_TEAM_ID) {
        return {
          laneId: parentResolved.laneId,
          laneName: parentResolved.laneName,
          teamId: parentResolved.teamId,
          teamName: parentResolved.teamName,
          role,
          effectiveRole,
          ord,
          ordNum,
          topic,
          isRetired: retired,
          isDigest: digest,
          isOrphan: false,
          orphan: "",
          source: "parent",
          autofixedFromCwd: false,
          usedTeamFallback: false,
          teamMismatch: false,
          callerTeam: rawTeam,
          callerLane: rawLane,
        };
      }
    }
  }

  // Step 5: Unmatched -> Orphan
  return {
    laneId: "",
    laneName: UNASSIGNED_TEAM_NAME,
    teamId: UNASSIGNED_TEAM_ID,
    teamName: UNASSIGNED_TEAM_NAME,
    role,
    effectiveRole,
    ord,
    ordNum,
    topic,
    isRetired: retired,
    isDigest: digest,
    isOrphan: true,
    orphan: "1",
    source: "orphan",
    autofixedFromCwd: false,
    usedTeamFallback: false,
    teamMismatch: false,
    callerTeam: rawTeam,
    callerLane: rawLane,
  };
}

/**
 * Generate a display-only title from resolved labels (`docs/NAMING.md`).
 * Never used to infer identity; only formats titles for display/lint.
 */
export function formatDisplayTitle({
  role = "worker",
  laneName = "",
  laneId = "",
  ord = "1",
  topic = "",
  job = "",
  title = "",
} = {}) {
  const laneUpper = String(laneName || laneId || "AGENT").trim().toUpperCase();
  const r = String(role || "worker").trim().toLowerCase();
  const ordClean = String(ord || "1").replace(/^ord/i, "").trim() || "1";
  const cleanTopic = String(topic || "").trim();

  if (r === "lead") {
    return `★ ${laneUpper} ord${ordClean}`;
  }
  if (r === "former-lead" || r === "old-lead" || r === "retired") {
    return `(old) ${laneUpper} ord${ordClean}`;
  }
  if (r === "brainstorm" || r === "buddy") {
    const topicMatchesLane =
      !cleanTopic ||
      cleanTopic.toLowerCase() === String(laneName || "").trim().toLowerCase() ||
      cleanTopic.toLowerCase() === String(laneId || "").trim().toLowerCase();
    return topicMatchesLane ? `BRAINSTORM · ${laneUpper}` : `BRAINSTORM · ${laneUpper} · ${cleanTopic}`;
  }
  if (r === "former-brainstorm" || r === "digest") {
    return String(title || "").trim() || `${laneUpper} · ${r}`;
  }
  const cleanJob = String(job || "").trim() || "worker";
  return `${laneUpper} · ${cleanJob}`;
}
