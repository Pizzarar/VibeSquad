import type { PaseoAgent } from "@getpaseo/client";
import { useSyncExternalStore } from "react";
import { isLocallyHidden, isMarkedUnread } from "./attentionLocal.ts";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_REASON, LEGACY_NEEDS_UNTIL, getUserName, needsYouBadge } from "./userName.ts";
import teamsFile from "../teams.example.json" with { type: "json" };
import {
  UNASSIGNED_TEAM_ID,
  UNASSIGNED_TEAM_NAME,
  findLaneInRegistry,
  formatDisplayTitle,
  laneCodesForTeam,
  isBrainstormAgent as identityIsBrainstormAgent,
  kindOf as identityKindOf,
  ordOf as identityOrdOf,
  resolveAgentIdentity,
  topicOf as identityTopicOf,
} from "./identity.ts";
import type { PinFields } from "./pins.ts";
import { isRemote, needsPairing } from "./remoteSession.ts";
import { mergeTeams } from "./teamsMerge.ts";

// A lane is a pinned Team in the UI. Pin fields (state, doneAt, order, lastProfile) live in src/pins.ts
// and round-trip through saveTeams untouched; lanes without `state` count as pinned.
export type LaneDef = { id: string; name: string; code?: string; paths?: string[]; aliases?: string[]; hub?: boolean } & PinFields;
/** The Squad's hub lane (RiffBot's). Explicit `hub: true` wins; with no flagged lane, the lane whose id is the Squad id. */
export function isHubLane(team: Pick<TeamDef, "id" | "lanes">, lane: Pick<LaneDef, "id" | "hub">): boolean {
  if (lane.hub === true) return true;
  return lane.id != null && !team.lanes.some((l) => l.hub === true) && lane.id === team.id;
}

export type TeamDef = {
  id: string;
  name: string;
  color: string;
  lanes: LaneDef[];
  paths: string[];
  brainstormWarnTokens?: number;
  brainstormRestartTokens?: number;
  leadFlagTokens?: number;
  leadAutoHandoffTokens?: number;
  leadHardCapTokens?: number;
  /** Per-Squad "Vibe mode": Buddy auto-dispatches routine work. Off when absent. */
  vibeMode?: boolean;
};
export type TeamConfig = TeamDef;

export const BRAINSTORM_WARN_DEFAULT = 80_000;
export const BRAINSTORM_RESTART_DEFAULT = 150_000;

export const LEAD_FLAG_DEFAULT = 150_000;
export const LEAD_AUTO_HANDOFF_DEFAULT = 250_000;
export const LEAD_HARD_CAP_DEFAULT = 300_000;

export function getBrainstormThresholds(
  team?: { brainstormWarnTokens?: number; brainstormRestartTokens?: number } | null,
): { warnTokens: number; restartTokens: number } {
  return {
    warnTokens: team?.brainstormWarnTokens ?? BRAINSTORM_WARN_DEFAULT,
    restartTokens: team?.brainstormRestartTokens ?? BRAINSTORM_RESTART_DEFAULT,
  };
}

export function getLeadThresholds(
  team?: { leadFlagTokens?: number; leadAutoHandoffTokens?: number; leadHardCapTokens?: number } | null,
): { flagTokens: number; autoHandoffTokens: number; hardCapTokens: number } {
  const fileAny = registryFile as {
    leadFlagTokens?: number;
    leadHandoffTokens?: number;
    leadAutoHandoffTokens?: number;
    leadHardCapTokens?: number;
  };
  return {
    flagTokens: team?.leadFlagTokens ?? fileAny.leadFlagTokens ?? fileAny.leadHandoffTokens ?? LEAD_FLAG_DEFAULT,
    autoHandoffTokens: team?.leadAutoHandoffTokens ?? fileAny.leadAutoHandoffTokens ?? LEAD_AUTO_HANDOFF_DEFAULT,
    hardCapTokens: team?.leadHardCapTokens ?? fileAny.leadHardCapTokens ?? LEAD_HARD_CAP_DEFAULT,
  };
}

export function leadLadderFor(
  team?: { leadFlagTokens?: number; leadAutoHandoffTokens?: number; leadHardCapTokens?: number } | null,
): { warnAt: number; alertAt: number; capAt: number } {
  const t = getLeadThresholds(team);
  return { warnAt: t.flagTokens, alertAt: t.autoHandoffTokens, capAt: t.hardCapTokens };
}

const TEAMS_KEY = "vibesquad.teams";
// Last registry file seen from the server (~/.vibesquad/teams.json etc.); the bundled example until the first GET lands.
let registryFile: { teams: TeamDef[]; [k: string]: unknown } = teamsFile as { teams: TeamDef[] };
const diskTeams = (): TeamDef[] => JSON.parse(JSON.stringify(registryFile.teams));

// localStorage is only a first-paint cache; refreshTeams() replaces it with the server's registry.
function loadTeams(): TeamDef[] {
  try {
    const raw = localStorage.getItem(TEAMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Only a revisioned { revision, teams } cache counts; a bare array predates revision tracking and may carry stale names.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.revision === "string" && parsed.revision !== "unknown" && Array.isArray(parsed.teams)) return parsed.teams;
    }
  } catch {}
  return teamsFile.teams as TeamDef[];
}

// Live binding: importers see the new array after saveTeams(). Components re-render via useTeams().
export let TEAMS: TeamDef[] = loadTeams();
let teamsVersion = 0;
const teamListeners = new Set<() => void>();
const notifyTeams = () => {
  teamsVersion++;
  teamListeners.forEach((l) => l());
};

export const getTeams = (): TeamDef[] => TEAMS;
export const getDiskTeams = diskTeams;

const cacheTeams = (next: TeamDef[]) => {
  try {
    // Skip caching until a revision is known so an unrevisioned copy can never seed a later first paint.
    if (teamsRevision === "unknown") localStorage.removeItem(TEAMS_KEY);
    else localStorage.setItem(TEAMS_KEY, JSON.stringify({ revision: teamsRevision, teams: next }));
  } catch {}
};

// Bumped by every local save so an in-flight refresh can't land a copy older than the edit.
let saveSeq = 0;

// Revision of the registry file our TEAMS came from (GET /api/teams). Unknown until the first GET lands,
// so a save before then always gets 409 and merges onto the real file.
let teamsRevision = "unknown";

const applyLocal = (next: TeamDef[]) => {
  TEAMS = next;
  cacheTeams(next);
  notifyTeams();
};

/** The registry as this UI last saw it, plus the file revision it came from (base for a later saveTeams). */
export type TeamsSnapshot = { teams: TeamDef[]; revision: string };
export const snapshotTeams = (): TeamsSnapshot => ({ teams: TEAMS, revision: teamsRevision });

export type TeamsUpdater = (cur: TeamDef[]) => TeamDef[];

/**
 * Save locally and to the shared teams registry (the same file the CLI and plugin read). Pass an updater to
 * have it re-run on the fresh file if someone else wrote it first. A plain array is merged onto the fresh
 * file (only the teams and lanes this edit touched win); its base is the live TEAMS unless the caller edited
 * an older copy, e.g. a modal open across polls, which must pass that copy as `base`.
 */
export async function saveTeams(next: TeamDef[] | TeamsUpdater, opts: { base?: TeamsSnapshot } = {}): Promise<{ disk: boolean }> {
  if (teamsRevision === "unknown") {
    await refreshTeams();
  }
  saveSeq++;
  // Before the first GET lands TEAMS may be a stale cache or the bundled example; only trust the server's copy.
  const base = opts.base?.teams ?? (teamsRevision !== "unknown" ? diskTeams() : TEAMS);
  const edit = typeof next === "function" ? next : (fresh: TeamDef[]) => mergeTeams(base, next, fresh);
  let teams = typeof next === "function" ? next(TEAMS) : next;
  // The revision our edit was made against: an older one makes the server answer 409 so we merge.
  let revision = opts.base?.revision ?? teamsRevision;
  applyLocal(teams);
  const headers = { "content-type": "application/json" };
  const endpoints = isRemote()
    ? ([["/api/teams", "PUT"]] as const)
    : ([["/api/teams", "PUT"], ["/__vibesquad/teams", "POST"]] as const);
  for (const [url, method] of endpoints) {
    try {
      let conflicts = 0;
      for (;;) {
        const r = await fetch(url, { method, headers, body: JSON.stringify({ teams, revision }) });
        if (r.ok) {
          const data = await r.json().catch(() => null);
          if (typeof data?.revision === "string") teamsRevision = data.revision;
          registryFile = { ...registryFile, teams };
          return { disk: true };
        }
        if (r.status !== 409) break;
        // A second conflict in a row: show what's on disk rather than retry forever.
        if (++conflicts > 1) {
          void refreshTeams();
          return { disk: false };
        }
        // Someone else wrote the file: re-apply the edit to the registry the server sent back, then retry once.
        const data = await r.json().catch(() => null);
        if (!Array.isArray(data?.teams)) break;
        const { error: _error, ...file } = data;
        registryFile = file;
        teamsRevision = revision = typeof data.revision === "string" ? data.revision : "unknown";
        teams = edit(data.teams);
        saveSeq++;
        applyLocal(teams);
      }
    } catch {}
  }
  return { disk: false };
}

/** Pull the registry from the server; the file wins over the localStorage cache. Returns true if TEAMS changed. */
export async function refreshTeams(): Promise<boolean> {
  const seq = saveSeq;
  try {
    const r = await fetch("/api/teams", { cache: "no-store" });
    if (!r.ok) return false;
    const data = await r.json();
    if (!Array.isArray(data?.teams) || seq !== saveSeq) return false;
    registryFile = data;
    if (typeof data.revision === "string") teamsRevision = data.revision;
    if (JSON.stringify(data.teams) === JSON.stringify(TEAMS)) {
      cacheTeams(TEAMS);
      return false;
    }
    TEAMS = data.teams;
    cacheTeams(TEAMS);
    notifyTeams();
    return true;
  } catch {
    return false;
  }
}

/** Drop the localStorage cache and go back to the last registry file the server sent. */
export function resetTeamsToDisk(): void {
  try {
    localStorage.removeItem(TEAMS_KEY);
  } catch {}
  TEAMS = diskTeams();
  notifyTeams();
  void refreshTeams();
}

// Agents edit the registry too (`vs pin new`), so re-read it on focus and every 10s while visible.
if (typeof window !== "undefined" && typeof document !== "undefined" && !(isRemote() && needsPairing(true, location.hash))) {
  void refreshTeams();
  window.addEventListener("focus", () => void refreshTeams());
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshTeams();
  }, 10_000);
}

export function subscribeTeams(l: () => void): () => void {
  teamListeners.add(l);
  return () => teamListeners.delete(l);
}
export const getTeamsVersion = (): number => teamsVersion;

/** Subscribes a component to team edits; the returned number changes on every save. */
export function useTeams(): number {
  return useSyncExternalStore(subscribeTeams, getTeamsVersion);
}
export const UNASSIGNED: TeamDef = {
  id: UNASSIGNED_TEAM_ID,
  name: UNASSIGNED_TEAM_NAME,
  color: "#777",
  lanes: [],
  paths: [],
};

export type Kind = "lead" | "old-lead" | "brainstorm" | "worker";
export type AgentType =
  | "lead"
  | "retired-lead"
  | "brainstorm"
  | "implement"
  | "mechanical"
  | "review"
  | "audit"
  | "spec"
  | "art"
  | "unknown";

export type Attention = { reason: string; tone: "permission" | "error" | "needs-you" | "finished" } | null;

export type Member = {
  agent: PaseoAgent;
  team: TeamDef;
  laneId: string | null;
  kind: Kind;
  agentType: AgentType;
  attention: Attention;
};

export type TeamView = {
  team: TeamDef;
  members: Member[];
  // One entry per declared lane, plus "_other" for team members with no lane.
  // lead/brainstorm = the newest live one; any further live ones are duplicates to retire.
  lanes: {
    lane: LaneDef;
    lead: Member | null;
    duplicateLeads: Member[];
    brainstorm: Member | null;
    duplicateBrainstorms: Member[];
    topicBrainstorms: Member[];
    members: Member[];
  }[];
  needsYou: number;
  running: number;
  unsorted: Member[];
};

const labelsOf = (a: PaseoAgent): Record<string, string> => (a.labels ?? {}) as Record<string, string>;

export function kindOf(a: PaseoAgent): Kind {
  const rawRole = (a as any).role as string | undefined;
  const l = labelsOf(a);
  return identityKindOf({ labels: rawRole && !l.role ? { ...l, role: rawRole } : l });
}

export function isBrainstormAgent(a: PaseoAgent): boolean {
  const rawRole = (a as any).role as string | undefined;
  const l = labelsOf(a);
  return identityIsBrainstormAgent({ labels: rawRole && !l.role ? { ...l, role: rawRole } : l });
}

export function isTopicBrainstorm(m: Member | PaseoAgent): boolean {
  const a = "agent" in m ? m.agent : m;
  if (!isBrainstormAgent(a)) return false;
  return Boolean(topicOfBrainstorm(a));
}

export function topicOfBrainstorm(m: Member | PaseoAgent): string {
  const a = "agent" in m ? m.agent : m;
  return identityTopicOf({ labels: labelsOf(a) });
}

export function brainstormUsedTokens(agent: PaseoAgent): number {
  const a = agent as any;
  const mock = Number(a.labels?.["vs.mock-tokens"]);
  if (Number.isFinite(mock) && mock > 0) return mock;
  if (typeof a.contextUsage?.usedTokens === "number" && a.contextUsage.usedTokens > 0) return a.contextUsage.usedTokens;
  if (typeof a.lastUsage?.contextWindowUsedTokens === "number" && a.lastUsage.contextWindowUsedTokens > 0) {
    return a.lastUsage.contextWindowUsedTokens;
  }
  const usage = a.usage ?? a.lastUsage;
  const input = Number(usage?.inputTokens ?? 0);
  return Math.max(input, 0);
}

export function classifyAgent(a: PaseoAgent): AgentType {
  const k = kindOf(a);
  if (k === "lead") return "lead";
  if (k === "old-lead") return "retired-lead";
  if (k === "brainstorm") return "brainstorm";

  const l = labelsOf(a);
  const hay = `${l.role ?? ""} ${l.profile ?? ""} ${l.job ?? ""} ${l.task ?? ""} ${a.title ?? ""}`.toLowerCase();

  if (/\b(art|sprite|pixel|visual|theme|duet|painter|director|neon)\b/.test(hay)) return "art";
  if (/\b(audit|scout|inventory|discover|probe|recon)\b/.test(hay)) return "audit";
  if (/\b(spec|plan|planner|architect|design)\b/.test(hay)) return "spec";
  if (/\b(review|check|critique|vet|verify|qa|gate)\b/.test(hay)) return "review";
  if (/\b(mech|mechanical|sweep|lint|format|rename|cleanup|migration)\b/.test(hay)) return "mechanical";
  if (/\b(impl|implement|build|fix|code|patch|feature|step|filer|anchor)\b/.test(hay)) return "implement";
  return "unknown";
}

export const AGENT_TYPE_LABEL: Record<AgentType, string> = {
  lead: "LEAD",
  "retired-lead": "RETIRED LEAD",
  brainstorm: "BRAINSTORM",
  implement: "IMPLEMENT",
  mechanical: "MECHANICAL",
  review: "REVIEW",
  audit: "AUDIT",
  spec: "SPEC / PLAN",
  art: "ART",
  unknown: "WORKER",
};

// Longer names for the cast sheet and roster panel.
export const AGENT_TYPE_NAME: Record<AgentType, string> = {
  lead: "Lead (The Boss)",
  "retired-lead": "Retired Lead",
  brainstorm: "Brainstorm (Buddy)",
  implement: "Implement",
  mechanical: "Mechanical",
  review: "Review",
  audit: "Audit / Scout",
  spec: "Spec / Planner",
  art: "Art",
  unknown: "Worker",
};

export function attentionOf(a: PaseoAgent): Attention {
  const l = labelsOf(a);
  if (a.pendingPermissions && a.pendingPermissions.length > 0)
    return { tone: "permission", reason: `${a.pendingPermissions.length} permission request(s)` };
  const needs = l["needs-you"] || l[LEGACY_NEEDS_LABEL];
  const until = Date.parse(l["needs-you-until"] || l[LEGACY_NEEDS_UNTIL] || "");
  const snoozed = !Number.isNaN(until) && until > Date.now();
  if (needs && needs !== "cleared" && !snoozed) return { tone: "needs-you", reason: l["needs-you-reason"] || l[LEGACY_NEEDS_REASON] || needs };
  if (isMarkedUnread(a.id) && !isLocallyHidden(a.id, "unread")) return { tone: "needs-you", reason: "marked unread" };
  if (a.status === "error" && !isLocallyHidden(a.id, a.lastError ?? "error")) return { tone: "error", reason: a.lastError ?? "error" };
  if (a.requiresAttention && !isLocallyHidden(a.id, a.attentionReason ?? "attention"))
    return { tone: a.attentionReason === "error" ? "error" : "finished", reason: a.attentionReason ?? "attention" };
  return null;
}

// Path segment match: "efi-" matches .../worktrees/0zaxy8af/efi-uilab-pmc7d, case-insensitive.
function teamByPath(cwd: string): TeamDef | null {
  const segs = (cwd ?? "").toLowerCase().split(/[\\/]+/);
  for (const t of TEAMS) {
    for (const p of t.paths) {
      const needle = p.toLowerCase();
      if (segs.some((s) => (needle.endsWith("-") ? s.startsWith(needle) : s === needle))) return t;
    }
  }
  return null;
}

function laneById(id: string | undefined): { team: TeamDef; lane: LaneDef } | null {
  if (!id) return null;
  const needle = id.trim().toLowerCase();
  if (!needle) return null;
  for (const t of TEAMS)
    for (const lane of t.lanes)
      if (lane.id.toLowerCase() === needle || lane.aliases?.some((a) => a.toLowerCase() === needle))
        return { team: t, lane };
  return null;
}

function canonicalLaneKey(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const found = laneById(trimmed);
  return (found ? found.lane.id : trimmed).toLowerCase();
}

/** Resolve team and lane for an agent from its labels or working directory via Identity v2. */
export function teamForAgent(a: PaseoAgent): { team: TeamDef; laneId: string } {
  const resolved = resolveAgentIdentity(a as any, { teams: TEAMS, cwd: a.cwd ?? "" });
  if (!resolved.isOrphan) {
    const team = TEAMS.find((t) => t.id === resolved.teamId) ?? UNASSIGNED;
    if (team !== UNASSIGNED) {
      return { team, laneId: resolved.laneId };
    }
  }
  return { team: UNASSIGNED, laneId: "" };
}

/**
 * Resolve every agent to its Squad (`team`) and Feature Lane (`laneId`) via `src/identity.ts`.
 * Orphans and unmatched agents land in `UNASSIGNED` (`_unassigned`).
 */
export function resolve(agents: Map<string, PaseoAgent>): Member[] {
  return [...agents.values()].map((agent) => {
    const resolved = resolveAgentIdentity(agent as any, {
      teams: TEAMS,
      cwd: agent.cwd ?? "",
      agentsById: agents as any,
    });
    const team = resolved.isOrphan
      ? UNASSIGNED
      : (TEAMS.find((t) => t.id === resolved.teamId) ?? UNASSIGNED);
    const keptLane = resolved.autofixedFromCwd && resolved.callerLane
      ? resolved.callerLane.trim().toLowerCase()
      : resolved.laneId;
    const laneId = team === UNASSIGNED ? null : (keptLane || null);
    const attention = attentionOf(agent);
    const prev = memberCache.get(agent);
    if (prev && prev.team === team && prev.laneId === laneId && sameAttention(prev.attention, attention)) return prev;
    const m: Member = { agent, team, laneId, kind: kindOf(agent), agentType: classifyAgent(agent), attention };
    memberCache.set(agent, m);
    return m;
  });
}

/**
 * One-click helper for the Unassigned tray: assigns an orphan/unassigned agent to a registered lane,
 * deriving `team` from the lane registry and clearing `orphan`.
 */
export async function assignAgentToLane(
  agent: PaseoAgent,
  laneId: string,
  updateFn?: (id: string, patch: { name?: string; labels?: Record<string, string> }) => Promise<void>,
): Promise<{ laneId: string; teamId: string; labels: Record<string, string> }> {
  const found = laneById(laneId) ?? findLaneInRegistry(laneId, TEAMS);
  if (!found) {
    throw new Error(`Unknown lane "${laneId}"`);
  }
  const existing = labelsOf(agent);
  // Send only the keys that change. The daemon merges label patches, so resending the whole (possibly
  // stale) snapshot would write back values changed since this render, e.g. a needs-you already cleared.
  // The agent object is not mutated: the daemon's upsert updates the store.
  const nextLabels: Record<string, string> = {
    lane: found.lane.id,
    team: found.team.id,
    orphan: "",
    ...(existing.role ? {} : { role: "worker" }),
    ...("lead" in existing ? { lead: found.lane.id } : {}),
  };
  if (typeof updateFn === "function") {
    await updateFn(agent.id, { labels: nextLabels });
  }
  return { laneId: found.lane.id, teamId: found.team.id, labels: { ...existing, ...nextLabels } };
}

const memberCache = new WeakMap<PaseoAgent, Member>();
const sameAttention = (a: Attention, b: Attention) => a === b || (!!a && !!b && a.tone === b.tone && a.reason === b.reason);

const newest = (a: Member, b: Member) => (b.agent.updatedAt ?? "").localeCompare(a.agent.updatedAt ?? "");

export function isFormerBrainstormMember(m: Member): boolean {
  return !m.agent.archivedAt && labelsOf(m.agent).role === "former-brainstorm" && !topicOfBrainstorm(m.agent);
}

export const formerNewest = (a: Member, b: Member): number => {
  const ta = Date.parse((a.agent as any).createdAt ?? a.agent.updatedAt ?? "");
  const tb = Date.parse((b.agent as any).createdAt ?? b.agent.updatedAt ?? "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta;
  return newest(a, b);
};

/**
 * The lane's main (or topic) Buddy. Live only by default; `includeClosed` also takes a closed, unarchived
 * one (every session is closed after a daemon restart) so opening a pin reopens it instead of spawning a
 * new Buddy (docs/PLAN_BUGS_BATCH1.md block 0c). A live one always wins.
 */
export function findCrossTeamBrainstorm(members: Member[], laneId: string, topic = "", opts: { includeClosed?: boolean } = {}): Member | null {
  const targetLane = canonicalLaneKey(laneId);
  if (!targetLane) return null;
  const wantTopic = topic.trim().toLowerCase();
  const hits = members.filter((m) => {
    if (m.kind !== "brainstorm" || m.agent.archivedAt || (m.agent.status === "closed" && !opts.includeClosed)) return false;
    const l = labelsOf(m.agent);
    const explicitLane = String(l.lane || "").trim();
    if (explicitLane && canonicalLaneKey(explicitLane) !== targetLane) return false;
    const mLane = canonicalLaneKey(m.laneId || l.lane || l.lead);
    if (mLane !== targetLane) return false;
    const mTopic = topicOfBrainstorm(m).trim().toLowerCase();
    return mTopic === wantTopic;
  });
  const closed = (m: Member) => (m.agent.status === "closed" ? 1 : 0);
  if (hits.length > 0) return hits.sort((a, b) => closed(a) - closed(b) || newest(a, b))[0] ?? null;
  if (!wantTopic && opts.includeClosed) {
    const former = members
      .filter((m) => {
        if (!isFormerBrainstormMember(m)) return false;
        const fl = labelsOf(m.agent);
        const fExplicit = String(fl.lane || "").trim();
        if (fExplicit && canonicalLaneKey(fExplicit) !== targetLane) return false;
        return canonicalLaneKey(m.laneId || fl.lane || fl.lead) === targetLane;
      })
      .sort(formerNewest);
    return former[0] ?? null;
  }
  return null;
}

// Pick the lane's lead/brainstorm: live (not closed) first, else the newest closed non-archived one,
// so a session unloaded by a daemon restart still shows in its lane card.
function pickLead(cands: Member[]): Member | null {
  const open = cands.filter((m) => !m.agent.archivedAt);
  const live = open.filter((m) => m.agent.status !== "closed");
  return (live.length ? live : open).sort(newest)[0] ?? null;
}

// Live = not closed and not archived, newest first.
const liveSorted = (cands: Member[]): Member[] =>
  cands.filter((m) => m.agent.status !== "closed" && !m.agent.archivedAt).sort(newest);

function titleCaseWords(raw: string): string {
  return raw
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Derives a clean lowercase kebab-case feature lane slug and display name for a Squad.
 * Avoids duplicating `squadId` if `topic` already starts with it.
 */
export function slugifyFeatureLane(squadId: string, topic: string): { id: string; name: string } {
  const squadSlug =
    squadId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "squad";
  const rawTopic = topic.trim();
  const topicSlug = rawTopic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!topicSlug) {
    return { id: squadSlug, name: squadId.trim() || "Main" };
  }
  const hasPrefix = topicSlug === squadSlug || topicSlug.startsWith(`${squadSlug}-`);
  const id = hasPrefix ? topicSlug : `${squadSlug}-${topicSlug}`;
  const strippedSlug =
    topicSlug.startsWith(`${squadSlug}-`) && topicSlug.length > squadSlug.length + 1
      ? topicSlug.slice(squadSlug.length + 1)
      : topicSlug;
  const hasUpperAndSpaces = /[A-Z]/.test(rawTopic) && !/^[-_a-z0-9]+$/i.test(rawTopic);
  let name: string;
  if (hasUpperAndSpaces) {
    const prefixRe = new RegExp(`^${squadId.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s·:-]+`, "i");
    const cleaned = rawTopic.replace(prefixRe, "").trim();
    name = (cleaned || rawTopic).replace(/\s+/g, " ");
  } else {
    name = titleCaseWords(strippedSlug);
  }
  return { id, name };
}

function deriveDynamicLaneName(team: TeamDef, laneId: string, laneMembers: Member[]): string {
  const buddies = laneMembers.filter((m) => m.kind === "brainstorm");
  for (const b of buddies) {
    const topic = topicOfBrainstorm(b);
    if (topic) {
      return /[A-Z]/.test(topic) ? topic : titleCaseWords(topic);
    }
  }
  return slugifyFeatureLane(team.id, laneId).name;
}

const OVERLAP_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "have",
  "has",
  "had",
  "not",
  "are",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "new",
  "add",
  "fix",
  "update",
  "make",
  "use",
  "using",
  "work",
  "feature",
  "lane",
  "buddy",
  "buddies",
  "squad",
  "squads",
  "brainstorm",
  "lead",
  "worker",
  "team",
  "project",
  "app",
  "ord",
  "old",
  "plan",
  "spec",
  "test",
  "tests",
  "doc",
  "docs",
  "spin",
  "another",
  "get",
  "talk",
  "here",
  "runs",
]);

function normalizeKeywordToken(word: string): string {
  const w = word.toLowerCase().trim();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(?:s|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function extractOverlapTokens(
  text: string,
  ignoreTokens: Set<string>,
): { keywords: Set<string>; files: Set<string> } {
  const files = new Set<string>();
  const fileMatches = text.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,6}\b/g) ?? [];
  for (const rawFile of fileMatches) {
    const clean = rawFile.replace(/\\/g, "/").toLowerCase().replace(/^\.?\//, "");
    if (clean.length >= 3) {
      files.add(clean);
      const base = clean.split("/").pop() ?? "";
      if (base.length >= 3) files.add(base);
    }
  }
  const keywords = new Set<string>();
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const raw of words) {
    if (raw.length < 3) continue;
    if (OVERLAP_STOP_WORDS.has(raw) || ignoreTokens.has(raw)) continue;
    const norm = normalizeKeywordToken(raw);
    if (norm.length < 3 || OVERLAP_STOP_WORDS.has(norm) || ignoreTokens.has(norm)) continue;
    keywords.add(norm);
  }
  return { keywords, files };
}

export type BuddyOverlapLogEntry = {
  lane?: string;
  type?: string;
  text?: string;
  refs?: string[];
};

export type BuddyOverlapResult = {
  laneId: string;
  laneName: string;
  buddy?: Member;
  reason: string;
};

/**
 * Checks whether `topic` overlaps an existing Feature Lane / Buddy in `view`
 * (by normalized keywords >=3 chars excluding stop words, or file/path tokens,
 * across lane id/name, live Buddy/Lead titles & topics, and recent `vs log` entries).
 */
export function checkBuddyOverlap(
  topic: string,
  view: TeamView,
  logEntries?: BuddyOverlapLogEntry[],
  allMembers?: Member[],
): BuddyOverlapResult | null {
  const rawTopic = topic.trim();
  if (!rawTopic) return null;

  const squadIgnore = new Set<string>();
  for (const part of `${view.team.id} ${view.team.name}`.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part) {
      squadIgnore.add(part);
      squadIgnore.add(normalizeKeywordToken(part));
    }
  }

  const query = extractOverlapTokens(rawTopic, squadIgnore);
  const derivedLane = slugifyFeatureLane(view.team.id, rawTopic);
  const derivedSlug = derivedLane.id.toLowerCase();

  let best: (BuddyOverlapResult & { score: number }) | null = null;

  const crossPool = allMembers ?? view.members;
  const crossExact =
    findCrossTeamBrainstorm(crossPool, derivedSlug) ??
    findCrossTeamBrainstorm(crossPool, rawTopic) ??
    findCrossTeamBrainstorm(crossPool, derivedSlug, rawTopic);
  if (crossExact) {
    const crossLaneInfo = laneById(crossExact.laneId || labelsOf(crossExact.agent).lane || derivedSlug);
    const hitLaneId = crossLaneInfo?.lane.id || crossExact.laneId || labelsOf(crossExact.agent).lane || derivedLane.id;
    const hitLaneName = crossLaneInfo?.lane.name || derivedLane.name;
    best = {
      laneId: hitLaneId,
      laneName: hitLaneName,
      buddy: crossExact,
      reason: `Overlaps existing feature lane "${hitLaneName}" (${hitLaneId}) · Buddy "${crossExact.agent.title || hitLaneName}" on matching feature lane "${hitLaneName}". Consider using that Buddy instead.`,
      score: 15,
    };
  }

  if (query.keywords.size === 0 && query.files.size === 0 && !best) return null;

  for (const laneEntry of view.lanes) {
    const { lane, brainstorm, topicBrainstorms, lead } = laneEntry;
    if (lane.id === "_other") continue;

    const crossLaneBs = allMembers ? findCrossTeamBrainstorm(allMembers, lane.id) : null;
    const liveMainBs =
      brainstorm && brainstorm.agent.status !== "closed" && !brainstorm.agent.archivedAt
        ? brainstorm
        : crossLaneBs ?? undefined;
    const liveTopicBs = topicBrainstorms.filter((b) => b.agent.status !== "closed" && !b.agent.archivedAt);
    const liveLead = lead && lead.agent.status !== "closed" && !lead.agent.archivedAt ? lead : undefined;

    const isDefaultMainLane =
      lane.id.toLowerCase() === view.team.id.toLowerCase() &&
      lane.name.toLowerCase() === view.team.name.toLowerCase();

    const laneCorpusParts: string[] = [];
    if (!isDefaultMainLane) {
      laneCorpusParts.push(lane.id, lane.name, ...(lane.aliases ?? []));
    }
    if (liveMainBs) {
      laneCorpusParts.push(liveMainBs.agent.title ?? "", topicOfBrainstorm(liveMainBs));
    }
    for (const tb of liveTopicBs) {
      laneCorpusParts.push(tb.agent.title ?? "", topicOfBrainstorm(tb));
    }
    if (liveLead) {
      laneCorpusParts.push(liveLead.agent.title ?? "", labelsOf(liveLead.agent).topic ?? "");
    }

    const matchingLogs = (logEntries ?? []).filter((e) => {
      const el = (e.lane ?? "").trim().toLowerCase();
      if (!el) return view.lanes.filter((x) => x.lane.id !== "_other").length === 1;
      return (
        el === lane.id.toLowerCase() ||
        el === lane.name.toLowerCase() ||
        Boolean(lane.aliases?.some((a) => a.toLowerCase() === el))
      );
    });
    const logCorpusParts: string[] = [];
    for (const entry of matchingLogs) {
      if (entry.text) logCorpusParts.push(entry.text);
      if (Array.isArray(entry.refs)) logCorpusParts.push(...entry.refs);
    }

    const laneTokens = extractOverlapTokens(laneCorpusParts.join(" "), squadIgnore);
    const logTokens = extractOverlapTokens(logCorpusParts.join(" "), squadIgnore);

    const matchedFiles = new Set<string>();
    for (const f of query.files) {
      if (laneTokens.files.has(f) || logTokens.files.has(f)) matchedFiles.add(f);
    }

    const matchedLaneKeywords = new Set<string>();
    const matchedLogKeywords = new Set<string>();
    for (const kw of query.keywords) {
      if (laneTokens.keywords.has(kw)) matchedLaneKeywords.add(kw);
      else if (logTokens.keywords.has(kw)) matchedLogKeywords.add(kw);
    }

    const exactSlugMatch =
      !isDefaultMainLane &&
      (lane.id.toLowerCase() === derivedSlug || lane.name.toLowerCase() === rawTopic.toLowerCase());

    const score =
      (exactSlugMatch ? 10 : 0) +
      matchedFiles.size * 5 +
      matchedLaneKeywords.size * 3 +
      matchedLogKeywords.size * 2;

    if (score <= 0) continue;

    // Pick the most relevant Buddy in this lane if one exists.
    let pickedBuddy: Member | undefined =
      liveMainBs ?? liveTopicBs[0] ?? brainstorm ?? topicBrainstorms[0] ?? crossLaneBs ?? undefined;
    if (liveTopicBs.length > 0) {
      let bestBsScore = -1;
      for (const cand of [...(liveMainBs ? [liveMainBs] : []), ...liveTopicBs]) {
        const candTokens = extractOverlapTokens(
          `${cand.agent.title ?? ""} ${topicOfBrainstorm(cand)}`,
          squadIgnore,
        );
        let s = 0;
        for (const f of query.files) if (candTokens.files.has(f)) s += 5;
        for (const kw of query.keywords) if (candTokens.keywords.has(kw)) s += 3;
        if (s > bestBsScore) {
          bestBsScore = s;
          pickedBuddy = cand;
        }
      }
    }

    const matchedList = [...matchedFiles, ...matchedLaneKeywords, ...matchedLogKeywords];
    const detail =
      matchedList.length > 0
        ? `shared scope (${matchedList.slice(0, 4).join(", ")})`
        : `matching feature lane "${lane.name}"`;
    const buddyDesc = pickedBuddy ? ` · Buddy "${pickedBuddy.agent.title || lane.name}"` : "";
    const reason = `Overlaps existing feature lane "${lane.name}" (${lane.id})${buddyDesc} on ${detail}. Consider using that Buddy instead.`;

    if (!best || score > best.score) {
      best = {
        laneId: lane.id,
        laneName: lane.name,
        ...(pickedBuddy ? { buddy: pickedBuddy } : {}),
        reason,
        score,
      };
    }
  }

  if (allMembers) {
    for (const m of allMembers) {
      if (m.kind !== "brainstorm" || m.agent.archivedAt || m.agent.status === "closed") continue;
      const l = labelsOf(m.agent);
      const rawLane = (m.laneId || l.lane || l.lead || "").trim();
      if (!rawLane) continue;
      const laneInfo = laneById(rawLane);
      const candLaneId = laneInfo?.lane.id || rawLane;
      const candLaneName = laneInfo?.lane.name || slugifyFeatureLane(m.team.id, candLaneId).name;
      const candTokens = extractOverlapTokens(
        `${candLaneId} ${candLaneName} ${m.agent.title ?? ""} ${topicOfBrainstorm(m)}`,
        squadIgnore,
      );
      const matchedFiles = new Set<string>();
      for (const f of query.files) if (candTokens.files.has(f)) matchedFiles.add(f);
      const matchedKws = new Set<string>();
      for (const kw of query.keywords) if (candTokens.keywords.has(kw)) matchedKws.add(kw);
      const exactMatch =
        candLaneId.toLowerCase() === derivedSlug ||
        candLaneId.toLowerCase() === rawTopic.toLowerCase() ||
        candLaneName.toLowerCase() === rawTopic.toLowerCase();
      const score = (exactMatch ? 12 : 0) + matchedFiles.size * 5 + matchedKws.size * 3;
      if (score <= 0) continue;
      const matchedList = [...matchedFiles, ...matchedKws];
      const detail =
        matchedList.length > 0
          ? `shared scope (${matchedList.slice(0, 4).join(", ")})`
          : `matching feature lane "${candLaneName}"`;
      const reason = `Overlaps existing feature lane "${candLaneName}" (${candLaneId}) · Buddy "${m.agent.title || candLaneName}" on ${detail}. Consider using that Buddy instead.`;
      if (!best || score > best.score || (score === best.score && !best.buddy)) {
        best = {
          laneId: candLaneId,
          laneName: candLaneName,
          buddy: m,
          reason,
          score,
        };
      }
    }
  }

  if (!best) return null;
  const { score: _score, ...result } = best;
  return result;
}

/** A squad's lanes minus removed ones (Remove team): what lane pickers and counts offer. */
export const shownLanesOf = (team: Pick<TeamDef, "lanes">): LaneDef[] => (team.lanes ?? []).filter((l) => l.state !== "removed");

/** Counts toward a needs-you badge: open attention on a live (not archived, not closed) agent that is not a retired lead. */
export const countsAsNeedsYou = (m: Member): boolean =>
  Boolean(m.attention) && m.attention!.tone !== "finished" && m.kind !== "old-lead" && !m.agent.archivedAt && m.agent.status !== "closed";

export function buildTeamViews(members: Member[]): TeamView[] {
  const all = [...TEAMS, UNASSIGNED];
  return all
    .map((team) => {
      const mine = members.filter((m) => m.team.id === team.id);
      // Removed lanes (Remove team) are hidden. An agent still labelled with one shows up as a dynamic lane so it can be found.
      const shownLanes = shownLanesOf(team);
      const declaredMatches = (laneId: string) =>
        shownLanes.some(
          (l) =>
            l.id.toLowerCase() === laneId.toLowerCase() ||
            Boolean(l.aliases?.some((a) => a.toLowerCase() === laneId.toLowerCase())),
        );
      const dynamicLanes: LaneDef[] = [];
      const seenDynamic = new Set<string>();
      for (const m of mine) {
        const lid = m.laneId?.trim();
        if (!lid || lid === "_other") continue;
        const key = lid.toLowerCase();
        if (declaredMatches(lid) || seenDynamic.has(key)) continue;
        seenDynamic.add(key);
        const laneMembers = mine.filter((x) => (x.laneId ?? "").toLowerCase() === key);
        dynamicLanes.push({
          id: lid,
          name: deriveDynamicLaneName(team, lid, laneMembers),
        });
      }
      const laneDefs: LaneDef[] = [
        ...shownLanes,
        ...dynamicLanes,
        { id: "_other", name: shownLanes.length || dynamicLanes.length ? "Other" : "Agents" },
      ];
      const lanes = laneDefs
        .map((lane) => {
          const matchesLane = (m: Member) => {
            const l = labelsOf(m.agent);
            const lid = m.laneId ?? l.lane ?? l.lead ?? "_other";
            return (
              lid === lane.id ||
              lid.toLowerCase() === lane.id.toLowerCase() ||
              Boolean(lane.aliases?.some((a) => a.toLowerCase() === lid.toLowerCase()))
            );
          };
          const inLane = mine.filter(matchesLane);
          const crossTeamInLane =
            lane.id === "_other"
              ? []
              : members.filter((m) => m.team.id !== team.id && !inLane.includes(m) && matchesLane(m));
          const allInLane = [...inLane, ...crossTeamInLane];
          const leads = liveSorted(allInLane.filter((m) => m.kind === "lead"));
          const nonTopicBrainstormCands = allInLane.filter((m) => m.kind === "brainstorm" && !isTopicBrainstorm(m));
          const nonInboxBrainstormCands = allInLane.filter(
            (m) => m.kind === "brainstorm" && !labelsOf(m.agent)["vs.inbox-card-id"]?.trim(),
          );
          const mainBrainstormCands =
            nonTopicBrainstormCands.length > 0 ? nonTopicBrainstormCands : nonInboxBrainstormCands;
          const brainstorms = liveSorted(mainBrainstormCands);
          const topicBrainstorms = inLane
            .filter((m) => m.kind === "brainstorm" && isTopicBrainstorm(m) && !m.agent.archivedAt)
            .sort(newest);
          const lead = leads[0] ?? pickLead(allInLane.filter((m) => m.kind === "lead"));
          const formerBs = allInLane.filter(isFormerBrainstormMember).sort(formerNewest);
          const brainstorm = brainstorms[0] ?? pickLead(mainBrainstormCands) ?? formerBs[0] ?? null;
          return {
            lane,
            lead,
            duplicateLeads: leads.slice(1),
            brainstorm,
            duplicateBrainstorms: brainstorms.slice(1),
            topicBrainstorms,
            members: inLane,
          };
        })
        .filter((l) => l.lane.id !== "_other" || l.members.length > 0);
      return {
        team,
        members: mine,
        lanes,
        needsYou: mine.filter(countsAsNeedsYou).length,
        running: mine.filter((m) => m.agent.status === "running").length,
        unsorted: mine.filter((m) => isUnsortedMember(m.agent)),
      };
    })
    .filter((v) => v.team !== UNASSIGNED || v.members.length > 0);
}

export const sortMembers = (ms: Member[]) => [...ms].sort(newest);

// ── B8: LAN banner dismiss helpers ───────────────────────────────────────────
export function lanIpSetKey(ips: string[]): string {
  return [...ips].map((s) => s.trim()).filter(Boolean).sort().join(",");
}

export function isLanBannerDismissed(ips: string[], dismissedKey: string | null | undefined): boolean {
  return ips.length > 0 && Boolean(dismissedKey) && lanIpSetKey(ips) === dismissedKey;
}

// ── B10: Unsorted agent detection ─────────────────────────────────────────────
export function isUnsortedMember(agent: Pick<PaseoAgent, "labels" | "archivedAt" | "status" | "cwd">): boolean {
  if (agent.archivedAt || agent.status === "closed") return false;
  if (!agent.cwd) return false;
  const labels = (agent.labels ?? {}) as Record<string, string>;
  return !labels.lane?.trim() && !labels.lead?.trim() && !labels.team?.trim();
}

// Token budget: leads hand off around leadFlagTokens (see Lead profile notes).
export const LEAD_BUDGET: number =
  (teamsFile as { leadFlagTokens?: number }).leadFlagTokens ?? teamsFile.leadHandoffTokens ?? LEAD_FLAG_DEFAULT;
export const WORKER_BUDGET: number = teamsFile.workerBudgetTokens;
export const budgetFor = (m: Member | PaseoAgent): number => {
  const k = "agent" in m ? m.kind : kindOf(m);
  if (k === "lead") {
    const team = "agent" in m ? m.team : teamForAgent(m).team;
    return getLeadThresholds(team).flagTokens;
  }
  if (k === "brainstorm") {
    const team = "agent" in m ? m.team : teamForAgent(m).team;
    return getBrainstormThresholds(team).restartTokens;
  }
  return WORKER_BUDGET;
};

export function matchesSearch(m: Member, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const a = m.agent;
  const hay = [
    a.title,
    a.id,
    a.model,
    a.provider,
    a.cwd,
    m.team.name,
    m.laneId,
    ...Object.entries(labelsOf(a)).map(([k, v]) => `${k}=${v}`),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const PARENT = "paseo.parent-agent-id";

// Live leads that still carry a parent link: a handoff chain that never got cut.
export function chainedLeads(members: Member[]): Member[] {
  return members.filter((m) => m.kind === "lead" && !m.agent.archivedAt && labelsOf(m.agent)[PARENT]);
}

export type HandoffPair = { team: TeamDef; laneId: string | null; oldLead: Member; lead: Member | null; liveWorkers: number };

export function handoffPairs(members: Member[]): HandoffPair[] {
  const out: HandoffPair[] = [];
  for (const oldLead of members.filter((m) => m.kind === "old-lead")) {
    const lead = pickLead(
      members.filter((m) => m.kind === "lead" && m.team.id === oldLead.team.id && m.laneId === oldLead.laneId),
    );
    const liveWorkers = members.filter(
      (m) => m.kind === "worker" && !m.agent.archivedAt && labelsOf(m.agent)[PARENT] === oldLead.agent.id,
    ).length;
    out.push({ team: oldLead.team, laneId: oldLead.laneId, oldLead, lead, liveWorkers });
  }
  return out;
}

const TITLE_MAX = 60; // create_agent rejects longer titles
const clip = (s: string) => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + "\u2026" : s);

/** Naming Standard v2 titles (lane code format). Shared by buildName (TeamActions) so both produce the same string. */
export function titleFor(
  role: "lead" | "brainstorm" | "worker",
  lane: string,
  i: { ord?: string; topic?: string; job?: string; code?: string; laneId?: string; hub?: boolean },
): string {
  return clip(
    formatDisplayTitle({
      role,
      laneName: lane,
      laneId: i.laneId,
      code: i.code || laneCodeOf(i.laneId || lane),
      ord: role === "lead" ? i.ord || "?" : i.ord,
      topic: i.topic,
      job: role === "worker" ? i.job || "job" : i.job,
      hub: role === "brainstorm" && (i.hub ?? isHubLaneId(i.laneId || lane)),
    }),
  );
}

/** `(old) <Code><ord>[ · objective]` for a retired lead. */
export function retiredLeadTitle(lane: string, laneId: string, ord: string | number, job?: string): string {
  return clip(formatDisplayTitle({ role: "former-lead", laneName: lane, laneId, code: laneCodeOf(laneId || lane), ord, job }));
}

/** True when the lane (id, alias or name) is its Squad's hub lane. */
export function isHubLaneId(laneKey: string | undefined): boolean {
  const found = laneById(laneKey);
  if (found) return isHubLane(found.team, found.lane);
  const needle = (laneKey ?? "").trim().toLowerCase();
  if (!needle) return false;
  const team = TEAMS.find((t) => t.id.toLowerCase() === needle);
  return team ? isHubLane(team, { id: team.id }) : false;
}

/** The lane's code: stored `code` or the generated one, deduped within its Squad. */
export function laneCodeOf(laneKey: string | undefined): string {
  const found = laneById(laneKey);
  return found ? (laneCodesForTeam(found.team)[found.lane.id] ?? "") : "";
}

// v2 (lane code) title generated from labels per docs/NAMING.md. Null when required labels are missing or the agent is retired.
// Block 4's one-time rename uses this directly (not expectedTitleFor, which tolerates v1 titles).
export function expectedV2TitleFor(agent: PaseoAgent): string | null {
  const l = labelsOf(agent);
  if (agent.archivedAt || agent.status === "closed" || kindOf(agent) === "old-lead") return null;
  const rawTitle = agent.title ?? "";
  const laneKey = l.lane ?? l.lead;
  const lane = laneKey ? (laneById(laneKey)?.lane.name ?? laneKey) : null;
  const code = laneCodeOf(laneKey);
  const role = l.role ?? (kindOf(agent) === "lead" ? "lead" : kindOf(agent) === "brainstorm" ? "brainstorm" : undefined);
  if (lane && role) {
    switch (role) {
      case "lead": {
        const ord = l.ord;
        return ord ? titleFor("lead", lane, { ord, job: l.job, code, laneId: laneKey }) : null;
      }
      case "brainstorm":
        return titleFor("brainstorm", lane, { topic: l.topic, code, laneId: laneKey });
      case "worker":
        return l.job ? titleFor("worker", lane, { job: l.job, ord: l.ord, code, laneId: laneKey }) : null;
    }
  }
  // DESIGN T1-4: Flag any live title still carrying legacy "(talk here...)" so Fix title cleans it.
  if (/\(talk here/i.test(rawTitle)) {
    return rawTitle.replace(/\s*\(talk here[^)]*\)/gi, "").trim();
  }
  return null;
}

/** The pre-lane-code (v1) title for an agent's labels, or null. Live agents still wearing it are tolerated, not flagged. */
export function legacyTitleFor(agent: PaseoAgent): string | null {
  const l = labelsOf(agent);
  const laneKey = l.lane ?? l.lead;
  if (!laneKey) return null;
  const LANE = (laneById(laneKey)?.lane.name ?? laneKey).toUpperCase();
  const role = l.role ?? (kindOf(agent) === "lead" ? "lead" : kindOf(agent) === "brainstorm" ? "brainstorm" : undefined);
  if (role === "lead") return l.ord ? clip(`★ ${LANE} ord${l.ord}`) : null;
  if (role === "former-lead") return l.ord ? clip(`(old) ${LANE} ord${l.ord}`) : null;
  if (role === "brainstorm") return clip(`BRAINSTORM · ${LANE}${l.topic?.trim() ? ` · ${l.topic.trim()}` : ""}`);
  if (role === "worker") return l.job ? clip(`${LANE} · ${l.job.trim() || "job"}`) : null;
  return null;
}

/** What the title lint expects: the v2 title, except null (no lint) while the live title is still the exact v1 one. */
export function expectedTitleFor(_agent: PaseoAgent): string | null {
  return null;
}

export function lintTitle(_agent: PaseoAgent): string | null {
  return null;
}

export const usedTokens = (m: Member | PaseoAgent): number => {
  const a = "agent" in m ? m.agent : m;
  if (isBrainstormAgent(a) || labelsOf(a)["vs.mock-tokens"]) return brainstormUsedTokens(a);
  return a.lastUsage?.contextWindowUsedTokens ?? brainstormUsedTokens(a);
};

// A worker is over budget once its context passes workerBudgetTokens.
export const isOverBudget = (m: Member): boolean => m.kind === "worker" && usedTokens(m) > WORKER_BUDGET;

export const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Successor ordinal for a lead strictly from `labels.ord` (defaults to 1). */
export function ordOf(a: PaseoAgent): number {
  return identityOrdOf({ labels: labelsOf(a) });
}

/** Lead is due a successor: >=flagTokens (150k) context or flagged handoff-flagged / handoff-ready. */
export const successorDue = (m: Member): boolean =>
  m.kind === "lead" &&
  !m.agent.archivedAt &&
  (usedTokens(m) >= getLeadThresholds(m.team).flagTokens ||
    !!labelsOf(m.agent)["handoff-flagged"] ||
    !!labelsOf(m.agent)["handoff-ready"]);

/** Lane ordinal across every team (0-based), used as the lead's look bucket. */
export function laneOrdinal(laneId: string | null | undefined): number | undefined {
  if (!laneId) return undefined;
  let i = 0;
  for (const t of TEAMS)
    for (const lane of t.lanes) {
      if (lane.id === laneId || lane.aliases?.includes(laneId)) return i;
      i++;
    }
  return undefined;
}

/** Lead look bucket for Avatar: the lane ordinal for live leads, undefined for everyone else. */
export function leadVariant(m: Member | PaseoAgent): number | undefined {
  if ("agent" in m) return m.kind === "lead" ? laneOrdinal(m.laneId) : undefined;
  if (kindOf(m) !== "lead") return undefined;
  const l = labelsOf(m);
  const byLabel = laneOrdinal(l.lane ?? l.lead);
  if (byLabel !== undefined) return byLabel;
  const t = teamByPath(m.cwd); // same fallback resolve() uses for single-lane teams
  return t && t.lanes.length === 1 ? laneOrdinal(t.lanes[0].id) : undefined;
}

// ---- nested agent tree ------------------------------------------------------------

export const MAX_TREE_DEPTH = 6;

export type AgentTree = {
  childrenOf: (parentId: string, showClosed?: boolean) => Member[];
  /** Running agents anywhere below parentId (depth-limited). */
  runningDescendants: (parentId: string) => number;
  totalDescendants: (parentId: string, showClosed?: boolean) => number;
};

const isClosed = (m: Member) => m.agent.status === "closed" || !!m.agent.archivedAt;

/** Builds the parent -> children map once; reuse it across the sidebar and the team page. */
export function buildTree(members: Member[]): AgentTree {
  const byParent = new Map<string, Member[]>();
  for (const m of members) {
    const p = labelsOf(m.agent)[PARENT];
    if (!p || p === m.agent.id) continue;
    const list = byParent.get(p);
    if (list) list.push(m);
    else byParent.set(p, [m]);
  }
  for (const list of byParent.values()) list.sort(newest);
  const childrenOf = (id: string, showClosed = false) => (byParent.get(id) ?? []).filter((m) => showClosed || !isClosed(m));
  const count = (id: string, pick: (m: Member) => boolean, showClosed: boolean) => {
    const seen = new Set<string>([id]);
    const walk = (pid: string, depth: number): number => {
      if (depth >= MAX_TREE_DEPTH) return 0;
      let n = 0;
      for (const c of childrenOf(pid, showClosed)) {
        if (seen.has(c.agent.id)) continue; // parent-pointer cycle
        seen.add(c.agent.id);
        n += (pick(c) ? 1 : 0) + walk(c.agent.id, depth + 1);
      }
      return n;
    };
    return walk(id, 0);
  };
  return {
    childrenOf,
    runningDescendants: (id) => count(id, (m) => m.agent.status === "running", false),
    totalDescendants: (id, showClosed = false) => count(id, () => true, showClosed),
  };
}

/** Who raised an alert, for alert pills: LEAD / WORKER / BRAINSTORM / OLD LEAD. */
export const OWNER_LABEL: Record<Kind, string> = { lead: "LEAD", "old-lead": "OLD LEAD", brainstorm: "BRAINSTORM", worker: "WORKER" };

/** Alert type pill text. "finished" is a completion check, never a raised hand. */
export const alertLabel = (tone: NonNullable<Attention>["tone"], userName: string = getUserName()): string =>
  ({
    permission: "⚑ PERM",
    "needs-you": `★ ${needsYouBadge(userName)}`,
    error: "✖ ERR",
    finished: "✓ DONE",
  })[tone];
