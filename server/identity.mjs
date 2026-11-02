import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFileWithBom } from "./user-settings.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";

// import.meta.url is undefined when bundled into the Paseo plugin; fall back like plugin/index.server.ts.
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


// ---- Lane codes (docs/PLAN_LANE_CODES.md) ----
// Reserved codes for lanes whose generic code would be unhelpful (the hub lane).
const RESERVED_LANE_CODES = { vibesquad: "Hub" };

const codeCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A stored `code` if it is 2-5 alphanumerics (all-caps kept, e.g. ADE; else Capitalised), else "". */
export function cleanLaneCode(raw) {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9]{2,5}$/.test(s)) return "";
  return s === s.toUpperCase() ? s : codeCase(s);
}

/**
 * Candidate codes for a lane, best first. Rule: an all-caps acronym (2-5 letters) among the first three words of the
 * name wins ("Basic ADE (...)" -> Ade, "UI Lab" -> Ui); otherwise the first word's first 3 letters ("Bug Chaser" -> Bug,
 * "Token Checker" -> Tok). Collisions fall back to 4-5 letters of the first word, then first word + next initials.
 */
export function laneCodeCandidates(lane) {
  const id = String(lane?.id ?? "");
  const reserved = RESERVED_LANE_CODES[id.toLowerCase()];
  const name = String(lane?.name ?? "").trim() || id;
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = [];
  const add = (c) => {
    const k = cleanLaneCode(c);
    if (k && !out.includes(k)) out.push(k);
  };
  if (reserved) add(reserved);
  const acronym = words.slice(0, 3).find((w) => /^[A-Z]{2,5}$/.test(w));
  if (acronym) add(acronym);
  const first = (words[0] ?? id).replace(/[^A-Za-z0-9]/g, "");
  for (const n of [3, 4, 5]) add(first.slice(0, n));
  for (let i = 1; i < words.length && i < 4; i++) add(first.slice(0, 3) + words[i].charAt(0));
  add(first.slice(0, 2) + (words[1] ?? "x").charAt(0));
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") add(first.slice(0, 3) + ch);
  return out;
}

/**
 * Codes for every lane of one Squad, keyed by lane id. Stored codes win; the rest are generated in registry order,
 * the first free candidate each, so the result is stable for a given registry and unique within the Squad.
 */
export function laneCodesForTeam(team) {
  const out = {};
  const used = new Set();
  const lanes = team?.lanes ?? [];
  for (const lane of lanes) {
    const c = cleanLaneCode(lane.code);
    if (c && !used.has(c.toLowerCase())) {
      out[lane.id] = c;
      used.add(c.toLowerCase());
    }
  }
  for (const lane of lanes) {
    if (out[lane.id]) continue;
    const c = laneCodeCandidates(lane).find((k) => !used.has(k.toLowerCase())) ?? codeCase(String(lane.id).slice(0, 5));
    out[lane.id] = c;
    used.add(c.toLowerCase());
  }
  return out;
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
} = {}) {
  const laneUpper = String(laneName || laneId || "AGENT").trim().toUpperCase();
  const c = cleanLaneCode(code) || laneCodeCandidates({ id: laneId, name: laneName || laneId })[0] || laneUpper;
  const r = String(role || "worker").trim().toLowerCase();
  const ordRaw = String(ord || "").replace(/^ord/i, "").trim();
  const ordClean = ordRaw || "1";
  const cleanTopic = String(topic || "").trim();
  const cleanJob = String(job || "").trim();

  if (r === "lead") {
    return cleanJob ? `★ ${c}${ordClean} · ${cleanJob}` : `★ ${c}${ordClean}`;
  }
  if (r === "former-lead" || r === "old-lead" || r === "retired") {
    return cleanJob ? `(old) ${c}${ordClean} · ${cleanJob}` : `(old) ${c}${ordClean}`;
  }
  if (r === "brainstorm" || r === "buddy") {
    const topicMatchesLane =
      !cleanTopic ||
      cleanTopic.toLowerCase() === String(laneName || "").trim().toLowerCase() ||
      cleanTopic.toLowerCase() === String(laneId || "").trim().toLowerCase();
    return topicMatchesLane ? `${c} Buddy` : `${c} Buddy · ${cleanTopic}`;
  }
  if (r === "former-brainstorm" || r === "digest") {
    return String(title || "").trim() || `${laneUpper} · ${r}`;
  }
  return `${c}${ordRaw} · ${cleanJob || "worker"}`;
}
