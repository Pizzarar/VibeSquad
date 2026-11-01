import rawConfig from "../teams.example.json" with { type: "json" };

export const UNASSIGNED_TEAM_ID = "_unassigned";
export const UNASSIGNED_TEAM_NAME = "Unassigned";
export const DIGEST_PROFILE = "Pre-check - Flash";

export interface RegistryLane {
  id: string;
  name: string;
  paths?: string[];
  aliases?: string[];
  dynamic?: boolean;
}

export interface RegistryTeam {
  id: string;
  name: string;
  color?: string;
  lanes?: RegistryLane[];
  paths?: string[];
}

export type AgentKind = "lead" | "old-lead" | "brainstorm" | "worker";

export interface IdentityInput {
  id?: string;
  title?: string | null;
  cwd?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  parentAgentId?: string | null;
  labels?: Record<string, unknown> | null;
  config?: {
    cwd?: string | null;
    labels?: Record<string, unknown> | null;
  } | null;
}

export interface ResolvedIdentity {
  laneId: string;
  laneName: string;
  teamId: string;
  teamName: string;
  role: string;
  effectiveRole: "retired" | "digest" | "lead" | "brainstorm" | "worker";
  ord: string;
  ordNum: number;
  topic: string;
  isRetired: boolean;
  isDigest: boolean;
  isOrphan: boolean;
  orphan: string;
  source: "registry" | "cwd-autofix" | "team-fallback" | "parent" | "orphan";
  autofixedFromCwd: boolean;
  usedTeamFallback: boolean;
  teamMismatch: boolean;
  callerTeam: string;
  callerLane: string;
}

const DEFAULT_TEAMS: RegistryTeam[] = Array.isArray((rawConfig as { teams?: RegistryTeam[] })?.teams)
  ? ((rawConfig as { teams: RegistryTeam[] }).teams)
  : [];

function extractLabels(agentOrLabels: IdentityInput | Record<string, unknown> | null | undefined): Record<string, string> {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return {};
  const maybeAgent = agentOrLabels as IdentityInput;
  if (maybeAgent.labels && typeof maybeAgent.labels === "object") {
    return maybeAgent.labels as Record<string, string>;
  }
  if (maybeAgent.config?.labels && typeof maybeAgent.config.labels === "object") {
    return maybeAgent.config.labels as Record<string, string>;
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
    return agentOrLabels as Record<string, string>;
  }
  return {};
}

export function isRetiredRole(roleValue?: string | null): boolean {
  const r = String(roleValue ?? "").trim().toLowerCase();
  if (!r) return false;
  return r.startsWith("former-") || r === "old-lead" || r === "retired" || r === "old";
}

export function isRetiredAgent(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): boolean {
  if (!agentOrLabels || typeof agentOrLabels !== "object") return false;
  const labels = extractLabels(agentOrLabels);
  if (isRetiredRole(labels.role)) return true;
  const maybeAgent = agentOrLabels as IdentityInput;
  if (maybeAgent.archivedAt) return true;
  if (maybeAgent.status === "closed") return true;
  return false;
}

export function isDigestAgent(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): boolean {
  const labels = extractLabels(agentOrLabels);
  if (labels.digestFor) return true;
  const role = String(labels.role ?? "").trim().toLowerCase();
  if (role === "digest") return true;
  const profile = String(labels.profile ?? "").trim();
  if (/^pre-check\s*-\s*flash$/i.test(profile)) return true;
  return false;
}

export function normalizeRoleLabel(
  agentOrLabels: IdentityInput | Record<string, string> | null | undefined,
  fallbackRole = "worker",
): string {
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

export function effectiveAgentRole(
  agentOrLabels: IdentityInput | Record<string, string> | null | undefined,
  fallbackRole = "worker",
): "retired" | "digest" | "lead" | "brainstorm" | "worker" {
  if (isRetiredAgent(agentOrLabels)) return "retired";
  if (isDigestAgent(agentOrLabels)) return "digest";
  const role = normalizeRoleLabel(agentOrLabels, fallbackRole);
  if (role === "lead") return "lead";
  if (role === "brainstorm") return "brainstorm";
  return "worker";
}

export function kindOf(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): AgentKind {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.role ?? "").trim().toLowerCase();
  if (isRetiredRole(raw)) return "old-lead";
  if (raw === "lead") return "lead";
  if (raw === "brainstorm" || raw === "buddy") return "brainstorm";
  return "worker";
}

export function isBrainstormAgent(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): boolean {
  return kindOf(agentOrLabels) === "brainstorm";
}

export function ordOf(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): number {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.ord ?? "").trim();
  if (!raw) return 1;
  const n = Number.parseInt(raw.replace(/^ord/i, ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

export function ordStringOf(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): string {
  const labels = extractLabels(agentOrLabels);
  const raw = String(labels.ord ?? "").trim();
  if (!raw) return "1";
  const cleaned = raw.replace(/^ord/i, "").trim();
  return /^\d+$/.test(cleaned) ? cleaned : "1";
}

export function topicOf(agentOrLabels: IdentityInput | Record<string, string> | null | undefined): string {
  const labels = extractLabels(agentOrLabels);
  return String(labels.topic ?? labels["vs.inbox-card-id"] ?? "").trim();
}

export function findLaneInRegistry(
  laneQuery: string | null | undefined,
  teams: RegistryTeam[] = DEFAULT_TEAMS,
): { team: RegistryTeam; lane: RegistryLane } | null {
  const q = String(laneQuery ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const team of teams) {
    for (const lane of team.lanes ?? []) {
      if (String(lane.id ?? "").toLowerCase() === q) {
        return { team, lane };
      }
      if (Array.isArray(lane.aliases) && lane.aliases.some((a) => String(a).toLowerCase() === q)) {
        return { team, lane };
      }
    }
  }
  for (const team of teams) {
    for (const lane of team.lanes ?? []) {
      if (String(lane.name ?? "").toLowerCase() === q) {
        return { team, lane };
      }
    }
  }
  return null;
}

export function findTeamInRegistry(
  teamQuery: string | null | undefined,
  teams: RegistryTeam[] = DEFAULT_TEAMS,
): RegistryTeam | null {
  const q = String(teamQuery ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const team of teams) {
    if (String(team.id ?? "").toLowerCase() === q || String(team.name ?? "").toLowerCase() === q) {
      return team;
    }
  }
  return null;
}

function matchDynamicPrefixedLane(
  laneQuery: string,
  rawTeam: string,
  teams: RegistryTeam[],
): { team: RegistryTeam; lane: RegistryLane } | null {
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

export function matchPathInRegistry(
  cwd: string | null | undefined,
  teams: RegistryTeam[] = DEFAULT_TEAMS,
): { team: RegistryTeam; lane: RegistryLane } | null {
  const norm = String(cwd ?? "").replace(/\\/g, "/").toLowerCase();
  if (!norm) return null;
  for (const team of teams) {
    for (const lane of team.lanes ?? []) {
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
        const defaultLane = team.lanes?.[0] ?? { id: team.id, name: team.name };
        return { team, lane: defaultLane };
      }
    }
  }
  return null;
}

export interface ResolveIdentityOptions {
  teams?: RegistryTeam[];
  cwd?: string;
  lane?: string;
  team?: string;
  fallbackRole?: string;
  recomputeOrphan?: boolean;
  agentsById?: Map<string, IdentityInput> | Record<string, IdentityInput>;
  getParent?: (id: string) => IdentityInput | null | undefined;
  _depth?: number;
}

function resolveParentMapLookup(parentId: string, options?: ResolveIdentityOptions): IdentityInput | null {
  if (!parentId) return null;
  if (typeof options?.getParent === "function") {
    return options.getParent(parentId) ?? null;
  }
  const byId = options?.agentsById;
  if (!byId) return null;
  if (byId instanceof Map) return byId.get(parentId) ?? null;
  if (typeof byId === "object") return byId[parentId] ?? null;
  return null;
}

export function resolveAgentIdentity(
  agentOrInput: IdentityInput | Record<string, string> | null | undefined,
  options: ResolveIdentityOptions = {},
): ResolvedIdentity {
  const teams = options.teams ?? DEFAULT_TEAMS;
  const labels = extractLabels(agentOrInput);
  const maybeAgent = (agentOrInput ?? {}) as IdentityInput;
  const cwd = String(options.cwd ?? maybeAgent.cwd ?? maybeAgent.config?.cwd ?? "").trim();
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
    const regMatch = findLaneInRegistry(rawLane, teams) ?? matchDynamicPrefixedLane(rawLane, rawTeam, teams);
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
      const defaultLane = matchedTeam.lanes?.[0] ?? { id: matchedTeam.id, name: matchedTeam.name };
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
  const parentId = String(labels["paseo.parent-agent-id"] ?? maybeAgent.parentAgentId ?? "").trim();
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

export function formatDisplayTitle({
  role = "worker",
  laneName = "",
  laneId = "",
  ord = "1",
  topic = "",
  job = "",
  title = "",
}: {
  role?: string;
  laneName?: string;
  laneId?: string;
  ord?: string | number;
  topic?: string;
  job?: string;
  title?: string;
} = {}): string {
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
