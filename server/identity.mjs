import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFileWithBom } from "./user-settings.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";
import { isHubLane, BUG_LANE_FALLBACK_IDS, AUDIT_LANE_FALLBACK_IDS, laneKindOf, findBugLane, findAuditLane, isHiddenLane, cleanLaneCode, laneCodeCandidates, laneCodesForTeam, freezeLaneCodes } from "./lane-pure.mjs";
export { isHubLane, BUG_LANE_FALLBACK_IDS, AUDIT_LANE_FALLBACK_IDS, laneKindOf, findBugLane, findAuditLane, isHiddenLane, cleanLaneCode, laneCodeCandidates, laneCodesForTeam, freezeLaneCodes };

// import.meta.url is undefined when bundled into the Paseo plugin; fall back like server/hooks/agent-duties.ts.
const DEFAULT_ROOT = path.resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.url === "string" && import.meta.url ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..") : path.join(os.homedir(), "projects", "VibeSquad")));

function resolveTeamsFilePath(rootDir = DEFAULT_ROOT) {
  return resolveSharedTeamsFilePath(rootDir);
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
  const file = resolveTeamsFilePath(rootDir);
  const res = readJsonFileWithBom(file, {
    label: "teams.json",
    fallback: null,
    recordWarning: true,
  });
  return Array.isArray(res.data?.teams) ? res.data.teams : [];
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
 * Throwaway/temporary lane slugs (`*-tmp`, `*-scratch`, `tmp-*`, `scratch-*`, `walk-*`).
 * These keep their own lane label instead of being folded into the cwd lane.
 */
export function isThrowawayLane(laneValue) {
  const l = String(laneValue ?? "").trim().toLowerCase();
  if (!l) return false;
  return /(^|[-_])(tmp|temp|scratch)$/.test(l) || /^(tmp|temp|scratch|walk)[-_]/.test(l);
}

/**
 * Explicit `lane` and legacy `lead` labels that disagree (e.g. lane=vibesquad, lead=walk-tmp):
 * the lane was rewritten from a guess, so the agent's real lane is unknown. Returns "" when consistent.
 */
export function laneLeadMismatch(agentOrLabels, teams) {
  const labels = extractLabels(agentOrLabels);
  const lane = String(labels.lane ?? "").trim().toLowerCase();
  const lead = String(labels.lead ?? "").trim().toLowerCase();
  if (!lane || !lead || lane === lead) return "";
  if (teams) {
    // Aliases/names of the same registered lane are not a mismatch.
    const a = findLaneInRegistry(lane, teams);
    const b = findLaneInRegistry(lead, teams);
    if (a && b && a.lane.id === b.lane.id) return "";
  }
  return `lane=${lane} lead=${lead}`;
}

/**
 * Strictly label/status-based retired check (never inspects title/name).
 */
/** Below this many context tokens a healthy lead is steered, not handed off (Overlord ladder step 3 floor; also the owner-stamp audit's bucket). */
export const LEAD_HANDOFF_MIN_TOKENS = 100000;

export function isRetiredAgent(agentOrLabels) {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return false;
  const labels = extractLabels(agentOrLabels);
  if (isRetiredRole(labels.role)) return true;
  if (agentOrLabels.archivedAt) return true;
  // A closed agent is retired only when it cannot be resumed in place (exited / no saved session). A lost-but-resumable
  // agent (runner restart) stays live: the roster/who/send treat it as live, so the lane is never left leaderless by a restart.
  if (agentOrLabels.status === "closed" || agentOrLabels.status === "lost") return agentOrLabels.resumable !== true;
  return false;
}

/**
 * Shared predicate: is an agent live for roster / lead resolution / send routing?
 * Non-archived, non-internal, non-retired-role, and not closed-dead. A closed agent is live only when the runner marked it
 * `resumable` (lost, saved session, no exit); a closed agent with no resumable session is retired. Every agent is a runner
 * agent and carries `resumable` from toAgent() (X1c dropped the non-runner clause).
 */
export function isLiveAgent(agentOrLabels) {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return false;
  const labels = extractLabels(agentOrLabels);
  if (isRetiredRole(labels.role)) return false;
  if (agentOrLabels.archivedAt || agentOrLabels.archived || agentOrLabels.internal) return false;
  if (agentOrLabels.status === "closed" || agentOrLabels.status === "lost") return agentOrLabels.resumable === true;
  return true;
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
export function findLaneInRegistry(laneQuery, teams = loadTeamsRegistry(), preferTeamId = "") {
  const raw = String(laneQuery ?? "").trim();
  const hadAt = raw.startsWith("@");
  const q = raw.replace(/^@+/, "").trim().toLowerCase();
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
  // Lane-code handles: `@bug` / `bug` resolve to the lane whose stored or generated code matches.
  // Several Squads can share a code (standing bug lanes): the caller's own team wins, then a non-hidden lane (the pre-backfill holder: bug-chaser is standing but visible, backfilled lanes are hidden), then array order.
  const hits = [];
  for (const team of teams) {
    const codes = laneCodesForTeam(team);
    for (const lane of team.lanes || []) {
      if (String(codes[lane.id] ?? "").toLowerCase() === q || String(lane.code ?? "").toLowerCase() === q) {
        hits.push({ team, lane });
      }
    }
  }
  if (hits.length) {
    const own = preferTeamId ? hits.find((h) => h.team.id === preferTeamId) : null;
    return own ?? hits.find((h) => !h.lane.hidden) ?? hits[0];
  }
  return null;
}

/**
 * The `@<lowercase-code>` handle for a lane id/alias/name/code/handle query (e.g. "@bug", "@ade", "@hub").
 * Unknown queries fall back to their stripped, lowercased self so the `@` prefix is always preserved.
 */
export function formatLaneHandle(laneIdOrQuery, teams = loadTeamsRegistry()) {
  const found = findLaneInRegistry(laneIdOrQuery, teams);
  if (found) {
    const code = laneCodesForTeam(found.team)[found.lane.id] ?? "";
    return `@${String(code || found.lane.id).toLowerCase()}`;
  }
  const q = String(laneIdOrQuery ?? "").replace(/^@+/, "").trim().toLowerCase();
  return `@${q}`;
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
      // A Squad-level path only names a lane when the Squad has exactly one; never guess lanes[0].
      if (p && norm.includes(p)) {
        if (team.lanes?.length === 1) return { team, lane: team.lanes[0] };
        break;
      }
    }
  }
  return null;
}

/**
 * Extract the repo name from a managed worktree sanctuary path:
 * `.../VibeSquad/worktrees/<repoName>/<unit>` or `.../.vibesquad/worktrees/<repoName>/<unit>`
 * (case-insensitive). Returns `<repoName>` (original case) or null when the path is not a
 * managed sanctuary path.
 */
export function extractManagedWorktreeRepoName(targetPath) {
  const norm = String(targetPath ?? "").replace(/\\/g, "/");
  if (!norm) return null;
  const m = norm.match(/(?:\/vibesquad\/worktrees\/|\/\.vibesquad\/worktrees\/)([^/]+)/i);
  return m ? m[1] : null;
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
  // Managed sanctuary path whose `.git` file may not exist on disk (e.g. in a unit test):
  // recover the repo name straight from the path and match that.
  const repoName = extractManagedWorktreeRepoName(cwd);
  if (repoName) {
    return matchSinglePathString(repoName, teams);
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

  // Step 3: `labels.team` + an unregistered lane label keeps that lane. A team with no lane is an orphan
  // (falls through to the parent chain), never the Squad's first lane.
  if (rawTeam && rawLane && !cwd) {
    const matchedTeam = findTeamInRegistry(rawTeam, teams);
    if (matchedTeam) {
      return {
        laneId: rawLane,
        laneName: rawLane,
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

  // Step 4: Parent chain (`vs.parent`, the runner's one parent key; depth <= 8)
  const depth = Number(options._depth ?? 0);
  const parentId = String(labels["vs.parent"] ?? agentOrInput?.parentAgentId ?? "").trim();
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



/** The code for one lane (stored or generated, deduped within its Squad). Unknown lane: the undeduped generic code. */
export function laneCodeFor(laneQuery, teams = loadTeamsRegistry()) {
  const found = findLaneInRegistry(laneQuery, teams);
  if (found) return laneCodesForTeam(found.team)[found.lane.id] ?? "";
  return laneCodeCandidates({ id: String(laneQuery ?? ""), name: String(laneQuery ?? "") })[0] ?? "";
}

/**
 * Generate a display-only title from resolved labels (`docs/NAMING.md`).
 * Never used to infer identity; only formats titles for display/lint.
 */
export function formatDisplayTitle({
  role = "worker",
  laneName = "",
  laneId = "",
  code = "",
  ord = "",
  topic = "",
  job = "",
  title = "",
  hub = false,
} = {}) {
  const laneUpper = String(laneName || laneId || "AGENT").trim().toUpperCase();
  const c = cleanLaneCode(code) || laneCodeCandidates({ id: laneId, name: laneName || laneId })[0] || laneUpper;
  const r = String(role || "worker").trim().toLowerCase();
  const ordRaw = String(ord || "").replace(/^ord/i, "").trim();
  const ordClean = ordRaw || "1";
  const cleanTopic = String(topic || "").trim();
  const cleanJob = String(job || "").trim();

  if (r === "lead") {
    if (hub) return cleanJob ? `Overlord · ${cleanJob}` : "Overlord";
    return cleanJob ? `★ ${c}${ordClean} · ${cleanJob}` : `★ ${c}${ordClean}`;
  }
  if (r === "former-lead" || r === "old-lead" || r === "retired") {
    if (hub) return cleanJob ? `(old) Overlord · ${cleanJob}` : "(old) Overlord";
    return cleanJob ? `(old) ${c}${ordClean} · ${cleanJob}` : `(old) ${c}${ordClean}`;
  }
  if (r === "brainstorm" || r === "buddy") {
    const topicMatchesLane =
      !cleanTopic ||
      cleanTopic.toLowerCase() === String(laneName || "").trim().toLowerCase() ||
      cleanTopic.toLowerCase() === String(laneId || "").trim().toLowerCase();
    if (hub && topicMatchesLane) return "RiffBot";
    const displayLane = String(laneName || laneId || c).trim();
    return topicMatchesLane ? displayLane : `${displayLane} · ${cleanTopic}`;
  }
  if (r === "former-brainstorm" || r === "digest") {
    return String(title || "").trim() || `${laneUpper} · ${r}`;
  }
  return `${c}${ordRaw} · ${cleanJob || "worker"}`;
}

/**
 * The `vs who` per-agent filter, shared with the MCP lead-spawn check so both agree on "live in this lane":
 * skips archived/internal/closed-dead (isLiveAgent: a closed-but-resumable agent is live), retired (former-*, (old)),
 * other teams/lanes (unless squadWide) and removed lanes. Returns {role, teamId, lane} (role is the effective role) or null.
 */
export function whoCandidate(a, { teams, wantTeamId, wantLane, squadWide = false, removedLanes = new Set() } = {}) {
  if (!isLiveAgent(a)) return null;
  const resolved = resolveAgentIdentity(a, { teams, cwd: a.cwd });
  const teamId = resolved.isOrphan ? "" : resolved.teamId;
  const lane = resolved.isOrphan ? "" : resolved.laneId;
  if (teamId.toLowerCase() !== String(wantTeamId).toLowerCase()) return null;
  if (!squadWide && lane.toLowerCase() !== String(wantLane).toLowerCase()) return null;
  if (removedLanes.has(lane.toLowerCase())) return null;
  return { role: effectiveAgentRole(a), teamId, lane };
}

/** True when the agent's title prefix (before `·`) is a `★ <Code><ord>` starred lead title. */
export function hasStarLeadTitle(agentOrTitle) {
  const raw = typeof agentOrTitle === "string" ? agentOrTitle : String(agentOrTitle?.title ?? agentOrTitle?.name ?? "");
  const prefix = raw.split("·")[0].trim();
  return prefix.startsWith("★") && prefix.slice(1).trim().length > 0;
}

/**
 * Explicit lead ordinal (>= 1) from `labels.ord` or a `★ <Code><ord>` / `ord<ord>` title prefix (before `·`).
 * Returns 0 when neither is present so unnumbered candidates tie at 0.
 */
export function explicitLeadOrd(agentOrLabels) {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return 0;
  const labels = extractLabels(agentOrLabels);
  const rawLabel = String(labels.ord ?? "").trim();
  let labelOrd = 0;
  if (rawLabel) {
    const cleaned = rawLabel.replace(/^ord/i, "").trim();
    if (/^\d+$/.test(cleaned)) {
      const n = Number.parseInt(cleaned, 10);
      if (Number.isFinite(n) && n >= 1) labelOrd = n;
    }
  }
  const rawTitle = String(agentOrLabels.title ?? agentOrLabels.name ?? "").trim();
  const prefix = rawTitle.split("·")[0].trim();
  let titleOrd = 0;
  const m = /(?:\bord\s*|★\s*[A-Za-z_-]+)(\d+)\b/i.exec(prefix);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1) titleOrd = n;
  }
  return Math.max(labelOrd, titleOrd);
}

/**
 * Pick the single live winner from same-(team,lane,role) candidates (read-only):
 * - Lost/closed agents (`lost: true` or `status === "closed" | "lost"`) never count when any active candidate exists.
 * - Among active settled candidates, the newest ★ / highest-ord lead wins (`hasStarLeadTitle`, then `explicitLeadOrd`, then
 *   `createdAt`, `updatedAt`, `id`). Older/lower-ord/unstarred leads are returned in `stale` (flagged, not CONFLICT).
 * - `conflict` is true only when 2+ top-ranked active candidates tie on `(star, ord)` (`contenders`).
 * Returns `{ winner, conflict, pending, stale, contenders }`.
 */
export function resolveLeadWinner(candidates) {
  const live = (candidates ?? []).filter((a) => a && isLiveAgent(a));
  if (!live.length) return { winner: null, conflict: false, pending: [], stale: [], contenders: [] };
  const isLostOrClosed = (a) =>
    Boolean(a?.lost) || ["closed", "lost"].includes(String(a?.status ?? "").trim().toLowerCase());
  const nonClosed = live.filter((a) => !isLostOrClosed(a));
  // A successor stamped vs.handoff-from=<a live non-closed candidate> is a handoff in flight, not a duplicate: the predecessor stays the
  // winner until the successor confirms (the predecessor is then relabelled former-lead and leaves the set).
  const liveIds = new Set(nonClosed.map((a) => a.id));
  const isPending = (a) => {
    const from = String(a?.labels?.["vs.handoff-from"] ?? "").trim();
    return Boolean(from) && from !== a.id && liveIds.has(from);
  };
  const settled = nonClosed.filter((a) => !isPending(a));
  const pending = settled.length ? nonClosed.filter(isPending).map((a) => a.id) : [];
  const decided = settled.length ? settled : nonClosed;
  const newest = (a, b) => {
    const at = Date.parse(a?.createdAt ?? a?.updatedAt ?? "") || 0;
    const bt = Date.parse(b?.createdAt ?? b?.updatedAt ?? "") || 0;
    if (at !== bt) return bt - at;
    const au = Date.parse(a?.updatedAt ?? "") || 0;
    const bu = Date.parse(b?.updatedAt ?? "") || 0;
    if (au !== bu) return bu - au;
    return String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
  };
  const rank = (a) => ({
    star: hasStarLeadTitle(a) ? 1 : 0,
    ord: explicitLeadOrd(a),
  });
  const compare = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.star !== rb.star) return rb.star - ra.star;
    if (ra.ord !== rb.ord) return rb.ord - ra.ord;
    return newest(a, b);
  };
  const sortedDecided = [...decided].sort(compare);
  const top = sortedDecided[0];
  const topRank = top ? rank(top) : { star: 0, ord: 0 };
  const topTier = sortedDecided.filter((a) => {
    const r = rank(a);
    return r.star === topRank.star && r.ord === topRank.ord;
  });
  const stale = sortedDecided
    .filter((a) => {
      const r = rank(a);
      return r.star !== topRank.star || r.ord !== topRank.ord;
    })
    .map((a) => a.id);
  const conflict = topTier.length >= 2;
  const contenders = conflict ? topTier.map((a) => a.id) : [];
  const pool = sortedDecided.length ? sortedDecided : [...live].sort(compare);
  return { winner: pool[0] ?? null, conflict, pending, stale, contenders };
}
