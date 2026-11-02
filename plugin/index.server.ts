// @vibesquad/plugin — slim Paseo server plugin.
//
//   1. before("agent.create")  fixed-order, cache-stable prompt layering + A1 spawn guard
//      agent.created           team/lane auto-labelling + first-dispatch context metric
//   2. agent.turn_ended        worker digest via Pre-check - Flash (direct-write fallback)
//   3. log.jsonl watcher       event-driven lead wakeups (replaces heartbeats / A2 nudge)
//   4. agent.turn_ended        100k handoff prompt, 130k handoff-ready label, A4 retry
//
// Note: the before("agent.create") request carries no labels or parent (only
// config + env), so role comes from env VS_ROLE or the title convention and
// team from cwd. Labels and parentage are handled in agent.created.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  createLeadHandoffCoordinator,
} from "@vibesquad/server/lead-handoff.mjs";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole,
  findLaneInRegistry,
  isDigestAgent as isDigestIdentity,
  isRetiredAgent,
  formatDisplayTitle,
  isRetiredRole,
  laneCodeFor,
  laneLeadMismatch,
  matchPathInRegistry,
  normalizeRoleLabel,
  resolveAgentIdentity,
  topicOf,
} from "@vibesquad/server/identity.mjs";
import { refreshWhosHere } from "@vibesquad/server/whos-here.mjs";
import { detachLiveChildren } from "@vibesquad/server/detach-children.mjs";
import { briefRootFor } from "@vibesquad/server/brief-path.mjs";
import { deriveRole } from "@vibesquad/server/profiles.mjs";
import { leanApplies, leanProviderOptions } from "@vibesquad/server/lean-tools.mjs";
import {
  LEGACY_NEEDS_LABEL,
  LEGACY_USER_TYPE,
  loadUserSettings,
  readJsonFileWithBom,
} from "@vibesquad/server/user-settings.mjs";

type Labels = Record<string, string>;
type Paseo = any;

export const HANDOFF_FLAG_TOKENS = LEAD_FLAG_DEFAULT;
export const HANDOFF_AUTO_TOKENS = LEAD_AUTO_HANDOFF_DEFAULT;
export const HANDOFF_HARD_CAP_TOKENS = LEAD_HARD_CAP_DEFAULT;
export const HANDOFF_PROMPT_TOKENS = LEAD_FLAG_DEFAULT;
export const HANDOFF_READY_TOKENS = LEAD_AUTO_HANDOFF_DEFAULT;
export const DIGEST_PROVIDER = "antigravity-cli/gemini-3.8-flash";
export const DIGEST_PROFILE = "Pre-check - Flash";
export const DIGEST_MODE_ID = "default";
export const DIGEST_THINKING_OPTION_ID = "low";
const WAKE_TYPES = new Set(["done", "blocker", "decision", "needs-you", "you", LEGACY_NEEDS_LABEL, LEGACY_USER_TYPE]);
const TRANSIENT_ERROR = /googleapis|EOF|no such host|ECONNRESET/i;
const MAX_RETRIES = 2;
const MAX_TEXT = 240;
const REPO_ROOT = path.resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta?.dirname === "string" ? path.join(import.meta.dirname, "..") : path.join(os.homedir(), "projects", "VibeSquad")));

// ---------------------------------------------------------------------------
// Static prompt layers (no timestamps / per-spawn values: keeps caches warm)
// ---------------------------------------------------------------------------

export const EVERYONE_LAYER = [
  "Team rules (VibeSquad):",
  "- Your lead is the agent in your team and lane with label role=lead (never one titled (old)). Find it with `vs who lead`.",
  "- A Squad (`team` label) can run multiple feature lanes (`lane` label) in parallel, each with 1 Buddy (`role=brainstorm`, mascot name \"Buddy\") and 1 Lead (`role=lead`).",
  `- To flag something for the owner (${loadUserSettings().userName}), set label needs-you=\"<one-line reason>\" on yourself (\`paseo agent update $PASEO_AGENT_ID --label needs-you=\"...\"\`).`,
  "- Catch up on Squad state with `vs log --since-me` (shares `decision` / `you` / `needs-you` entries across all lanes in the Squad). Naming conventions: docs/NAMING.md.",
  "- R1 (Search/Read): Use your provider's native search/read tools. If you must use the shell, cap the output (`| head -50`, `-m`, `Select-Object -First`).",
  "- R3 (Images): Don't re-read an image file you've already seen unless it changed. Take screenshots at the needed size, not full-page tall captures.",
  "- R4 (Large files): For files over ~30k chars, grep first, then read with offset/limit. Never re-read from byte 0.",
  "- R6 (Waiting): Wait on agents with `paseo wait <id> --timeout <s>` (always with a timeout). No sleep/poll loops.",
  "- R2/R7 (Git state): Git state in the spawn context is a starting point only. Re-check right before commit/push/merge, not every turn. Fetch at most once per worktree per hour unless about to merge.",
].join("\n");

export const WORKER_PACK = [
  "Role: worker.",
  "- Never run `vs log` writes. Put your result (PASS/FAIL, what changed, refs) in your final message; a digest agent logs it for the lead.",
  "- Your final message is the report; never call built-in SendMessage or ListAgents; mid-task use Paseo send_agent_prompt.",
  "- Report blockers to your lead in your final message. Do not edit lead-only docs or spawn successors.",
].join("\n");

export const BRAINSTORM_PACK = [
  "Role: brainstorm (the Brainstorm, head of a Team).",
  "- Read `docs/brainstorm/<lane>.md` before anything else. After every decision update it as a short diff (<5k tokens; sections: Who's here / Done when / Decided / Open / In flight). Keep `## Done when`; never edit `## Who's here` (VS writes it). The brief is the handoff: don't write dated docs/BRAINSTORM_HANDOFF_*.md files.",
  "- You may write `vs log decision \"...\"`, `vs log needs-you \"...\"`, `vs log handoff \"...\"`, and `vs log metric \"...\"` (240 chars max). Hand build work to a lead; do not implement.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section. Every plan lists its blocks in a `| Block | Touches | Clashes with |` table (files/areas each touches, what it clashes with).",
  "- Never complete a Team yourself. When the lead reported PASS on the last plan block and nothing is Open, post: \"<Team> looks done. ✓ Mark complete · Not yet\" followed by a fenced block containing the single line `vs:looks-done`. Only the user's click completes a Team.",
  "- At >=80k tokens, update the brief now. At the hard limit VS retires you; the next click on the pin starts a fresh Brainstorm from the brief.",
  "- If the user raises something that belongs to another Team, offer: \"That sounds like <Team>. Send it there?\" followed by a fenced block: line 1 `vs:send-to <lane-id>`, then the idea text (VS shows a one-click Send button). Unrelated loose ideas: `vs inbox add \"<idea>\"` (or the UI's `Park in Inbox`) and reply \"parked N ideas → Inbox\".",
  "- \"I just thought of X\" / \"spin up a Brainstorm for X\" is a new-pin request: run `vs pin new \"<short name>\" --brief \"<X in 1-3 lines>\"` (same Squad by default). It refuses when X overlaps an existing Team and names it: offer that Team instead. For work in flight that isn't a Team yet, check `vs who brainstorm` / `vs log --since-me` first. Don't spawn the Brainstorm; the first click on the new pin starts it.",
  "- In a hub chat, sort every new idea: stays here / existing Team (`vs:send-to`) / new Team (`vs:spin-off`). Anything that isn't hub business gets proposed as a spin-off. Never spin off without the user's confirmation.",
  "- Propose spin-offs as one fenced block, line 1 ```vs:spin-off, then one Team per line: `Name | 1-line brief`. The user edits in words (4 proposed, \"energy and food in one lane called Needs\" → re-post the block with 3); only the newest block gets the button.",
].join("\n");

/** Appended to the Buddy pack only while the Squad's `vibeMode` is on (teams.json). Off = pack text unchanged. */
export const VIBE_MODE_BUDDY_RULES = [
  "Vibe mode is ON for this Squad:",
  "- Act on your own for bug fixes, approved plan blocks and parity gaps: dispatch them without waiting. Log each auto call as `vs log decision \"(auto) ...\"`.",
  "- New features, scope changes, public/outward actions, money and destructive actions wait for the user: collect them into ONE needs-you digest, not one ping each.",
].join("\n");

export const LEAD_FALLBACK_PACK = [
  "Role: lead.",
  "- Dispatch workers, read their digests via `vs log --since-me` (never raw transcripts), log decisions/blockers with `vs log`. When you start a plan, set `job=<objective in a few words>` (`paseo agent update --label job=...`); refer to agents by short name (e.g. Bug1, Hub5).",
  "- Title each worker `<your Code><your ord> · <job>` (e.g. `Hub5 · drop files`) and label it `job=<job>` and `ord=<your ord>`, so its title matches the generated one.",
  "- When a plan block passes (PASS) or the whole plan is complete, add that line under `## In flight` in `docs/brainstorm/<lane>.md` so the Brainstorm can spot \"looks done\". Touch nothing else in the brief.",
  "- Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k. Run `vs handoff` and fill the Judgment section.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section.",
  "- \"Spin up a buddy (for X)\" / \"spin up another buddy\" / \"get me a buddy for X\": spawn a new Buddy (role=brainstorm, title <Code> Buddy · <topic X>, Code = the new lane's short code) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).",
  "- Write JSON files with node (e.g. fs.writeFileSync(..., 'utf8')), never PowerShell Set-Content (which writes a UTF-8 BOM that breaks JSON parsers).",
  "- Plans carry a parallel table (block | touches | clashes with); run non-clashing blocks at the same time by default; say why in one line when you don't.",
  "- Restart the VibeSquad server only when a merged change needs it, and log it (`vs log metric \"server restart: <why>\"`).",
].join("\n");

export const ROLE_PACKS = {
  worker: WORKER_PACK,
  brainstorm: BRAINSTORM_PACK,
  lead: LEAD_FALLBACK_PACK,
};

// ---------------------------------------------------------------------------
// teams.json
// ---------------------------------------------------------------------------

interface TeamDef {
  id: string;
  name?: string;
  vibeMode?: boolean;
  lanes?: { id: string; aliases?: string[] }[];
  paths?: string[];
}

export interface StoredProfile {
  id?: string;
  name: string;
  role?: string;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, any>;
  notes?: string;
}

function baseDir(): string {
  return path.resolve(process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
}

function profilesFilePath(): string {
  if (process.env.VIBESQUAD_PROFILES_PATH) return path.resolve(process.env.VIBESQUAD_PROFILES_PATH);
  return path.join(baseDir(), "profiles.json");
}

export function loadStoredProfiles(): StoredProfile[] {
  for (const candidate of [
    profilesFilePath(),
    process.env.PASEO_CONFIG_PATH ? path.resolve(process.env.PASEO_CONFIG_PATH) : path.join(os.homedir(), ".paseo", "config.json"),
  ]) {
    const { value: parsed } = readJsonFileWithBom(candidate, { fallback: null });
    if (!parsed) continue;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : Array.isArray(parsed?.daemon?.agentProfiles)
          ? parsed.daemon.agentProfiles
          : [];
    // Stored profiles may lack `role` (paseo config.json strips it): derive it from the name.
    if (list.length > 0) return list.map((p: any) => (p && typeof p === "object" ? { ...p, role: deriveRole(p.name, p.role) } : p)) as StoredProfile[];
  }
  return [];
}

const LEGACY_ALIASES: Record<string, string> = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
};

export interface ProfileMatch {
  profile: StoredProfile;
  /** True only when the caller named the profile (config.profile, `profile` label, VS_PROFILE). */
  explicit: boolean;
}

export function matchStoredProfile(
  profileHint?: string,
  provider?: string,
  title?: string | null,
  role?: string,
  profiles = loadStoredProfiles(),
): ProfileMatch | null {
  if (!profiles.length) return null;
  const rawHint = (profileHint ?? "").trim();
  const mappedHint = LEGACY_ALIASES[rawHint] || rawHint;
  if (mappedHint) {
    const exact = profiles.find((p) => p.name === mappedHint || p.name.toLowerCase() === mappedHint.toLowerCase());
    if (exact) return { profile: exact, explicit: true };
  }
  const fuzzy = (profile: StoredProfile | undefined) => (profile ? { profile, explicit: false } : null);
  const cleanTitle = (title ?? "").trim();
  if (cleanTitle) {
    const byTitle = profiles.find((p) => cleanTitle.toLowerCase().startsWith(p.name.toLowerCase()));
    if (byTitle) return fuzzy(byTitle);
  }
  const isAgy = (provider ?? "").startsWith("antigravity-cli");
  if (role === "lead") {
    const want = isAgy ? "Lead - Gemini" : "Lead - Claude";
    return fuzzy(profiles.find((p) => p.name === want));
  }
  if (role === "brainstorm") {
    const want = isAgy ? "Brainstorm - Gemini" : "Brainstorm - Claude";
    return fuzzy(profiles.find((p) => p.name === want));
  }
  return null;
}

export function resolveStoredProfile(
  profileHint?: string,
  provider?: string,
  title?: string | null,
  role?: string,
  profiles = loadStoredProfiles(),
): StoredProfile | null {
  return matchStoredProfile(profileHint, provider, title, role, profiles)?.profile ?? null;
}

export type ProfileField = "provider" | "model" | "mode" | "thinking";

export interface ProfileFieldDiff {
  field: ProfileField;
  caller: string;
  profile: string;
}

/** "claude/opus" → { provider: "claude", model: "opus" }; a separate model wins. */
export function splitProviderModel(provider?: string | null, model?: string | null): { provider: string; model: string } {
  const raw = String(provider ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash < 0) return { provider: raw, model: String(model ?? "").trim() };
  return { provider: raw.slice(0, slash), model: String(model ?? "").trim() || raw.slice(slash + 1) };
}

/**
 * Fields where an explicit profile and the caller disagree. Only fields the profile
 * sets count; `caller` is "" when the caller left the field blank (a fill, not a clash).
 */
export function profileFieldDiffs(
  caller: { provider?: string | null; model?: string | null; modeId?: string | null; thinkingOptionId?: string | null },
  profile: StoredProfile,
): ProfileFieldDiff[] {
  const c = splitProviderModel(caller.provider, caller.model);
  const p = splitProviderModel(profile.provider, profile.model);
  const pairs: [ProfileField, string, string][] = [
    ["provider", c.provider, p.provider],
    ["model", c.model, p.model],
    ["mode", String(caller.modeId ?? "").trim(), String(profile.modeId ?? "").trim()],
    ["thinking", String(caller.thinkingOptionId ?? "").trim(), String(profile.thinkingOptionId ?? "").trim()],
  ];
  return pairs.filter(([, cv, pv]) => pv && cv !== pv).map(([field, cv, pv]) => ({ field, caller: cv, profile: pv }));
}

export function profileOverrideMetric(agent: string, profile: string, d: ProfileFieldDiff, suffix = ""): string {
  return `profile-override: agent=${agent || "(unnamed)"} profile=${profile} field=${d.field} caller=${d.caller || "(none)"} profile=${d.profile}${suffix ? ` ${suffix}` : ""}`;
}

function resolveTeamsFilePath(): string {
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
  const local = path.join(REPO_ROOT, "teams.json");
  if (fs.existsSync(local)) return local;
  return path.join(REPO_ROOT, "teams.example.json");
}

// Lanes are added to teams.json at runtime (new pins, feature lanes), so re-read it
// whenever the file changes instead of trusting a snapshot from plugin load.
let teamsCache: { file: string; mtimeMs: number; size: number; teams: TeamDef[] } | null = null;

function loadTeams(): TeamDef[] {
  const file = resolveTeamsFilePath();
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (stat && teamsCache && teamsCache.file === file && teamsCache.mtimeMs === stat.mtimeMs && teamsCache.size === stat.size) {
    return teamsCache.teams;
  }
  const { value: parsed } = readJsonFileWithBom(file, { fallback: null, label: "teams.json" });
  const teams: TeamDef[] = Array.isArray(parsed?.teams) ? parsed.teams : [];
  teamsCache = stat ? { file, mtimeMs: stat.mtimeMs, size: stat.size, teams } : null;
  return teams;
}

function safeSegment(value: string): string {
  return String(value || "").replace(/[^A-Za-z0-9_-]+/g, "_");
}

export function teamIdOf(value: string | undefined, teams = loadTeams()): string {
  if (!value) return "";
  const needle = value.toLowerCase();
  const hit = teams.find((t) => t.id.toLowerCase() === needle || (t.name ?? "").toLowerCase() === needle);
  return safeSegment(hit ? hit.id : needle);
}

export function resolveByCwd(cwd: string | undefined, teams = loadTeams()): { team: string; lane: string } | null {
  const matched = matchPathInRegistry(cwd, teams);
  if (!matched) return null;
  return { team: matched.team.id, lane: matched.lane.id };
}

export function deriveTeamForSpawn(
  labels: Labels | undefined,
  cwd: string | undefined,
  teams = loadTeams(),
): {
  team: string;
  lane: string;
  callerTeam: string;
  callerLane: string;
  mismatch: boolean;
  autofixedFromCwd: boolean;
  usedTeamFallback: boolean;
  isOrphan: boolean;
  source: string;
  role: string;
} {
  const safeLabels = labels ?? {};
  const resolved = resolveAgentIdentity(safeLabels, {
    cwd,
    teams,
    recomputeOrphan: true,
  });
  return {
    team: resolved.isOrphan ? "" : resolved.teamId,
    lane: resolved.isOrphan ? (safeLabels.lane || safeLabels.lead || "").trim() : resolved.laneId,
    callerTeam: resolved.callerTeam,
    callerLane: resolved.callerLane,
    mismatch: resolved.teamMismatch,
    autofixedFromCwd: resolved.autofixedFromCwd,
    usedTeamFallback: resolved.usedTeamFallback,
    isOrphan: resolved.isOrphan,
    source: resolved.source,
    role: resolved.role,
  };
}

export function sanitizeLegacyRosterPrompt(systemPrompt: string | undefined): string {
  if (!systemPrompt) return "";
  return systemPrompt.replace(
    /To find a project's current lead:\s*run\s*`paseo\s+ls\s+-g\s+--json`[^\r\n]*/gi,
    "To find a project's current lead: run `vs who lead`.",
  );
}

export function isRetiredLeadSnap(
  target: { title?: string | null; status?: string; archivedAt?: string | null; labels?: Labels } | null | undefined,
): boolean {
  if (!target) return false;
  return isRetiredRole(target.labels?.role);
}

export function extractLeadShortName(target: { id: string; title?: string | null; labels?: Labels }): string {
  const ord = target.labels?.ord;
  if (ord) return `ord${String(ord).replace(/^ord/i, "")}`;
  return (target.title ?? "").trim() || target.id.slice(0, 8);
}

/**
 * Lane label to write after resolution: an explicit lane label is never overwritten (an unknown
 * or throwaway lane like `walk-*` / `*-tmp` keeps its own slug instead of being folded into the
 * cwd lane, so it never collides with that lane's real lead/Buddy). The cwd lane only fills a blank.
 */
export function keptLaneOf(resolved: { laneId: string; callerLane: string; autofixedFromCwd: boolean }): string {
  const caller = (resolved.callerLane ?? "").trim().toLowerCase();
  if (resolved.autofixedFromCwd && caller) return caller;
  return resolved.laneId;
}

/** Topic key for a brainstorm: non-empty for topic brainstorms, "" for main lane brainstorms. */
export function brainstormTopicOf(labels: Labels, _title?: string | null): string {
  return topicOf(labels).toLowerCase();
}

/** Whether `a` occupies the same (team, lane, role, topic) slot as `target`. */
export function sameLaneRole(
  a: { labels: Labels; title?: string | null; cwd?: string },
  target: { role: string; team: string; lane: string; topic?: string },
  teams = loadTeams(),
): boolean {
  const aRole = effectiveAgentRole(a);
  if (aRole !== target.role) return false;
  const resolved = resolveAgentIdentity(a, { cwd: a.cwd, teams });
  if (resolved.isOrphan) return false;
  if (resolved.teamId !== target.team || resolved.laneId.toLowerCase() !== target.lane.toLowerCase()) return false;
  if (target.role === "brainstorm") {
    const aTopic = brainstormTopicOf(a.labels);
    const tTopic = (target.topic ?? "").trim().toLowerCase();
    return aTopic === tTopic;
  }
  return true;
}

/** Throwaway workers are not worth a [done] entry: no job label, or "probe" in the title/job. */
export function isDigestNoise(labels: Labels, title?: string | null): boolean {
  const job = String(labels.job ?? "").trim();
  return !job || /\bprobe/i.test(job) || /\bprobe/i.test(String(title ?? ""));
}

/** A report is loggable as [done] only if it states PASS or FAIL. */
export function statesVerdict(text: string): boolean {
  return /\b(PASS|FAIL)\b/.test(text);
}

/** Role label to stamp on a spawn: a digest is labelled `worker` (digestFor/profile mark it), never `digest`. */
export function spawnRoleLabel(role: string): string {
  return role === "digest" ? "worker" : role;
}

/** Next lead ord for a lane: one past the highest ord on any lead or former lead in it (self excluded). */
export function nextLeadOrd(agents: Array<{ id: string; labels?: Labels }>, lane: string, selfId: string): string {
  const want = lane.trim().toLowerCase();
  let max = 0;
  for (const a of agents) {
    if (a.id === selfId || !want) continue;
    const l = a.labels ?? {};
    if (String(l.lane || l.lead || "").trim().toLowerCase() !== want) continue;
    const role = String(l.role ?? "").trim().toLowerCase();
    if (role !== "lead" && !isRetiredRole(role)) continue;
    const n = Number(String(l.ord ?? "").replace(/^ord/i, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

/** Digest/pre-check agents must never be digested again (infinite spawn loop). */
export function isDigestAgent(labels: Labels, _title?: string | null): boolean {
  return isDigestIdentity(labels);
}

// ---------------------------------------------------------------------------
// Team log
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  agent: string;
  lane: string;
  type: string;
  text: string;
  refs: string[];
}

function logPath(team: string): string {
  return path.join(baseDir(), "teams", safeSegment(team), "log.jsonl");
}

export function appendLog(team: string, entry: Omit<LogEntry, "ts" | "refs"> & { refs?: string[] }): void {
  const file = logPath(team);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const full: LogEntry = {
    ts: new Date().toISOString(),
    refs: [],
    ...entry,
    text: entry.text.slice(0, MAX_TEXT),
  };
  fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Prompt layering
// ---------------------------------------------------------------------------

function findProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "docs", "LEAD_RULES.md")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(cwd);
}

export function rolePack(role: string, cwd: string, vibeMode = false): string {
  if (role === "lead") {
    try {
      const text = fs.readFileSync(path.join(findProjectRoot(cwd), "docs", "LEAD_RULES.md"), "utf8").trim();
      if (text) return text;
    } catch {
      // fall through
    }
    return LEAD_FALLBACK_PACK;
  }
  if (role === "brainstorm") return vibeMode ? `${BRAINSTORM_PACK}\n${VIBE_MODE_BUDDY_RULES}` : BRAINSTORM_PACK;
  if (role === "worker") return WORKER_PACK;
  return "";
}

// ---------------------------------------------------------------------------
// Lane briefs (docs/brainstorm/<lane>.md)
// ---------------------------------------------------------------------------

const MAX_BRIEF_CHARS = 20_000;
const MAX_SNAPSHOT_CHARS = 600;

export function briefPathFor(root: string, lane: string): string {
  const slug = String(lane ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  return path.join(root, "docs", "brainstorm", `${slug || "vibesquad"}.md`);
}

export function briefBeginMarker(lane: string): string {
  return `--- BEGIN docs/brainstorm/${lane}.md ---`;
}

/** The lane brief as a prompt block, or "" when the lane has no brief on disk. */
export function laneBriefBlock(root: string, lane: string): string {
  if (!lane) return "";
  let text = "";
  try {
    text = fs.readFileSync(briefPathFor(root, lane), "utf8").trim();
  } catch {
    return "";
  }
  if (!text) return "";
  return [
    `Lane brief for \`${lane}\`: read it before anything else; it is the Buddy handoff.`,
    briefBeginMarker(lane),
    text.slice(0, MAX_BRIEF_CHARS),
    `--- END docs/brainstorm/${lane}.md ---`,
  ].join("\n");
}

/**
 * Append a retiring Buddy's last turn under `## In flight` when the brief has not
 * been touched since that turn. Returns what happened, for the retire metric.
 */
export function snapshotIntoBrief(
  root: string,
  lane: string,
  old: { id: string; updatedAt?: string },
  lastTurn: string,
): "snapshotted" | "current" | "missing" | "no-turn" | "too-large" {
  const file = briefPathFor(root, lane);
  let before = "";
  let mtimeMs = 0;
  try {
    before = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return "missing";
  }
  const turn = String(lastTurn ?? "").replace(/\s+/g, " ").trim();
  if (!turn) return "no-turn";
  const lastActive = Date.parse(old.updatedAt ?? "");
  if (Number.isFinite(lastActive) && mtimeMs >= lastActive) return "current";
  const clipped = turn.length > MAX_SNAPSHOT_CHARS ? `${turn.slice(0, MAX_SNAPSHOT_CHARS)}…` : turn;
  const line = `- Last turn of retired Buddy ${old.id.slice(0, 8)} (${new Date().toISOString().slice(0, 10)}): ${clipped}`;
  if (before.includes(line)) return "current";
  const lines = before.split(/\r?\n/);
  const head = lines.findIndex((l) => /^##\s+in[ -]flight\b/i.test(l.trim()));
  if (head < 0) {
    lines.push("", "## In flight", line);
  } else {
    let end = head + 1;
    while (end < lines.length && !/^##\s/.test(lines[end])) end++;
    while (end > head + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, line);
  }
  const after = lines.join("\n");
  if (after.length > MAX_BRIEF_CHARS) return "too-large";
  fs.writeFileSync(file, after, "utf8");
  return "snapshotted";
}

/** Layers 1 and 3 joined in the fixed order; layer 2 (AGENTS.md) is loaded by the provider. */
/**
 * Profile notes (stored in profiles.json, so old installs keep the old text) repeat the
 * R1-R7 rules that EVERYONE_LAYER already injects. Drop those lines so each rule appears once.
 */
export function dedupeNotesAgainst(notes: string, prefix: string): string {
  const tags = new Set([...prefix.matchAll(/^- (R[\d/R]+)\b/gm)].map((m) => m[1]));
  const lines = prefix.split("\n").map((l) => l.trim());
  return notes
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      if (lines.includes(t)) return false;
      const m = t.match(/^[-*]\s*\**(R[\d/R]+)\b/);
      return !(m && tags.has(m[1]));
    })
    .join("\n")
    .trim();
}

/**
 * First-dispatch metric line. Only `contextWindowUsedTokens` is a context size; `inputTokens` is one
 * request's input (about 2k on Antigravity), so a missing window reads n/a instead of a wrong number.
 */
export function firstDispatchMetricText(
  parent: { lastUsage?: { contextWindowUsedTokens?: number } | null; provider?: string; model?: string | null },
  parentId: string,
  ord?: string,
): string {
  const used = parent.lastUsage?.contextWindowUsedTokens;
  const size = typeof used === "number" && Number.isFinite(used) && used > 0 ? Math.round(used / 1000) + "k tokens" : "n/a";
  return "first-dispatch context: " + size + " (lead=" + parentId + ", ord=" + (ord ?? "?") + ", provider=" + (parent.provider || "?") + ", model=" + (parent.model || "?") + ")";
}

export function injectedPrefix(role: string, cwd: string, vibeMode = false): string {
  return [EVERYONE_LAYER, rolePack(role, cwd, vibeMode)].filter(Boolean).join("\n\n");
}

export function inspectGitSpawnState(cwd: string): string | null {
  if (!cwd) return null;
  let resolved = "";
  try {
    resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved)) return null;
  } catch {
    return null;
  }

  const runGit = (args: string[]) => {
    try {
      return spawnSync("git", args, {
        cwd: resolved,
        encoding: "utf8",
        timeout: 1000,
        windowsHide: true,
      });
    } catch {
      return null;
    }
  };

  const branchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchRes || branchRes.status !== 0) return null;
  const branch = String(branchRes.stdout ?? "").trim() || "HEAD";

  let behind = 0;
  let ahead = 0;
  let revRes = runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!revRes || revRes.status !== 0) {
    revRes = runGit(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]);
  }
  if (!revRes || revRes.status !== 0) {
    revRes = runGit(["rev-list", "--left-right", "--count", "origin/HEAD...HEAD"]);
  }
  if (revRes && revRes.status === 0 && revRes.stdout) {
    const [bRaw, aRaw] = String(revRes.stdout).trim().split(/\s+/);
    behind = Number.isFinite(Number(bRaw)) ? Number(bRaw) : 0;
    ahead = Number.isFinite(Number(aRaw)) ? Number(aRaw) : 0;
  }

  const statusRes = runGit(["status", "--porcelain", "-uno"]);
  const dirty =
    statusRes && statusRes.status === 0 && statusRes.stdout
      ? String(statusRes.stdout)
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0).length
      : 0;

  return `Starting git state (snapshot at spawn — re-check before commit/push/merge): branch=${branch}, origin=${behind} behind / ${ahead} ahead, dirty=${dirty} files.`;
}

// ---------------------------------------------------------------------------
// Dependencies (swappable in tests)
// ---------------------------------------------------------------------------

export interface Deps {
  setLabels(agentId: string, labels: Labels, name?: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  deleteHeartbeat?(agentId: string): Promise<void>;
  debounceMs: number;
  retryBaseMs: number;
  watchIntervalMs: number;
  startWatcher: boolean;
  /** Root holding docs/brainstorm/<lane>.md briefs (defaults to the VibeSquad repo). */
  briefRoot?: string;
  /** Grace before a retired Buddy is archived, so an in-flight turn is not killed mid-stream. */
  brainstormArchiveGraceMs?: number;
  /** Post-spawn profile fix: the plugin SDK has no model/mode/thinking setters, so this goes via the daemon client. */
  applyAgentSettings?(agentId: string, patch: AgentSettingsPatch): Promise<void>;
  /** Stop and archive an agent that must not run (e.g. wrong provider for its explicit profile). */
  refuseAgent?(agentId: string): Promise<void>;
}

export interface AgentSettingsPatch {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

async function withDaemonClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const { createDaemonClient } = await import("@vibesquad/server/brainstorm.mjs");
  const client: any = createDaemonClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function daemonApplyAgentSettings(agentId: string, patch: AgentSettingsPatch): Promise<void> {
  return withDaemonClient(async (client) => {
    if (patch.model) await client.setAgentModel(agentId, patch.model);
    if (patch.modeId) await client.setAgentMode(agentId, patch.modeId);
    if (patch.thinkingOptionId) await client.setAgentThinkingOption(agentId, patch.thinkingOptionId);
  });
}

function daemonRefuseAgent(agentId: string): Promise<void> {
  return withDaemonClient(async (client) => {
    await client.cancelAgent(agentId).catch(() => {});
    await client.archiveAgent(agentId);
  });
}

/** cmd.exe splits on whitespace and treats `&|<>^` as syntax; quote such args for the shell. */
export function quoteArg(value: string): string {
  if (process.platform !== "win32" || !/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// cmd.exe still expands %VAR% and breaks out of quotes on `"`, so refuse those outright.
const UNSAFE_SHELL_ARG = /[\r\n\0"%]/;

function assertSafeCliArgs(agentId: string, args: string[]): void {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid agent id");
  if (process.platform === "win32" && args.some((a) => UNSAFE_SHELL_ARG.test(a))) throw new Error("refusing argument with shell metacharacters");
}

function cliSetLabels(agentId: string, labels: Labels, name?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["agent", "update", agentId];
    if (name) args.push("--name", name);
    for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
    try {
      assertSafeCliArgs(agentId, args);
    } catch (e) {
      return reject(e);
    }
    const cli = process.env.PASEO_CLI || "paseo";
    const child = spawn(cli, args.map(quoteArg), { stdio: "ignore", windowsHide: true, shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`paseo agent update exited ${code}`))));
  });
}

function cliArchive(agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      assertSafeCliArgs(agentId, [agentId]);
    } catch (e) {
      return reject(e);
    }
    const cli = process.env.PASEO_CLI || "paseo";
    const child = spawn(cli, ["agent", "archive", agentId].map(quoteArg), { stdio: "ignore", windowsHide: true, shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`paseo agent archive exited ${code}`))));
  });
}

const DEFAULT_DEPS: Deps = {
  setLabels: cliSetLabels,
  archiveAgent: cliArchive,
  applyAgentSettings: daemonApplyAgentSettings,
  refuseAgent: daemonRefuseAgent,
  debounceMs: 3000,
  retryBaseMs: 5000,
  watchIntervalMs: 1500,
  startWatcher: true,
  brainstormArchiveGraceMs: 120_000,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface AgentSnap {
  id: string;
  title: string | null;
  status?: string;
  cwd?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  internal?: boolean;
  labels: Labels;
  provider?: string;
  model?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number; inputTokens?: number } | null;
}

function log(message: string) {
  console.log(`[vibesquad] ${message}`);
}

export function createPlugin(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...DEFAULT_DEPS, ...overrides };

  return function contribute(server: PluginServerContext) {
    // Read per use (mtime-cached): a snapshot here missed lanes registered after load.
    const currentTeams = () => loadTeams();
    const lifetime = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stops: (() => void)[] = [];
    const firstDispatchLogged = new Set<string>();
    const childCount = new Map<string, number>();
    const digested = new Set<string>();
    const retries = new Map<string, number>();
    const offsets = new Map<string, number>();
    const misrouteCounts = new Map<string, number>();
    const pendingWake = new Map<string, LogEntry[]>(); // lead id -> entries awaiting a wake
    const wakeQueue: { team: string; entry: LogEntry }[] = [];
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    let paseoApi: Paseo = null;

    const handoffCoordinator = createLeadHandoffCoordinator({
      rootDir: REPO_ROOT,
      baseHome: () => baseDir(),
      setLabels: (agentId: string, labels: Labels, name?: string) => deps.setLabels(agentId, labels, name),
      sendMessage: async (agentId: string, text: string) => {
        if (!paseoApi) return;
        await paseoApi.agents.ref(agentId).send(text).catch((e: unknown) => log(`handoff message failed: ${e}`));
      },
      createAgent: async (payload: any) => {
        if (!paseoApi) return null;
        const handle = await paseoApi.agents.create({
          config: payload.config,
          cwd: payload.cwd,
          title: payload.title,
          prompt: payload.prompt,
          labels: payload.labels,
          ...(payload.env ? { env: payload.env } : {}),
        });
        const created = handle?.agent ?? handle;
        return created ? { ...created, id: created.id ?? handle?.id } : null;
      },
      listAgents: async () => {
        if (!paseoApi) return [];
        try {
          const res = await paseoApi.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
          return ((res?.entries ?? []) as any[]).map((e) => ({ ...e.agent, labels: e.agent?.labels ?? {} }));
        } catch {
          return [];
        }
      },
      getAgent: async (agentId: string) => {
        if (!paseoApi) return null;
        return await snap(paseoApi, agentId);
      },
      deleteHeartbeat: async (agentId: string) => {
        if (typeof deps.deleteHeartbeat === "function") {
          await deps.deleteHeartbeat(agentId).catch((e) => log(`deleteHeartbeat failed: ${e}`));
        } else if (typeof paseoApi?.schedules?.deleteHeartbeat === "function") {
          await paseoApi.schedules.deleteHeartbeat(agentId).catch(() => {});
        }
      },
      appendLog: (team: string, entry: any) => {
        appendLog(teamIdOf(team, currentTeams()), {
          agent: entry.agent ?? "plugin",
          lane: entry.lane ?? team,
          type: entry.type ?? "handoff",
          text: entry.text,
          refs: entry.refs ?? [],
        });
      },
    });

    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!lifetime.signal.aborted) fn();
      }, ms);
      timers.add(t);
      return t;
    };

    const snap = async (paseo: Paseo, id: string): Promise<AgentSnap | null> => {
      try {
        const r = await paseo.agents.ref(id).refresh();
        const a = r?.agent;
        return a ? ({ ...a, labels: a.labels ?? {} } as AgentSnap) : null;
      } catch {
        return null;
      }
    };

    const labelsFor = async (paseo: Paseo, agent: { id: string; title: string | null }) => {
      const s = await snap(paseo, agent.id);
      return { snap: s, labels: s?.labels ?? {} };
    };

    const teamOf = (labels: Labels, cwd?: string): { team: string; lane: string } | null => {
      const derived = deriveTeamForSpawn(labels, cwd, currentTeams());
      if (derived.team) return { team: teamIdOf(derived.team, currentTeams()), lane: derived.lane || derived.team };
      if (labels.team) return { team: teamIdOf(labels.team, currentTeams()), lane: labels.lane || resolveByCwd(cwd, currentTeams())?.lane || "" };
      return resolveByCwd(cwd, currentTeams());
    };

    const recentBeforeMismatches = new Map<string, number>();

    const logProfileMetric = (labels: Labels, cwd: string, text: string, refs: string[] = []) => {
      const where = teamOf(labels, cwd);
      if (!where) return log(text);
      try {
        appendLog(where.team, { agent: "plugin", lane: where.lane, type: "metric", text, refs });
      } catch (err) {
        log(`profile metric write failed: ${err}`);
      }
    };

    /**
     * Labels never reach before(agent.create), so a spawn that names its profile only by
     * label (MCP create_agent, `paseo run --label profile=`) is fixed here, after the
     * session exists. Model/mode/thinking are switched; a wrong provider can't be, so the
     * agent is stopped and archived rather than left running on the wrong provider.
     */
    const enforceProfileAfterSpawn = async (agent: any, me: AgentSnap | null, labels: Labels): Promise<"refused" | void> => {
      const hint = String(labels.profile ?? "").trim();
      if (!hint) return;
      const match = matchStoredProfile(hint);
      if (!match?.explicit) return;
      const profile = match.profile;
      const s: any = me ?? {};
      const actual = {
        provider: s.provider ?? agent.provider,
        model: s.model ?? null,
        modeId: s.currentModeId ?? s.modeId ?? null,
        thinkingOptionId: s.thinkingOptionId ?? null,
      };
      const diffs = profileFieldDiffs(actual, profile);
      if (!diffs.length) return;
      const name = agent.title || agent.id;
      const cwd = agent.cwd ?? s.cwd ?? "";
      const refs = agent.id ? [agent.id] : [];
      const fresh = (d: ProfileFieldDiff) => {
        const key = `profile:${agent.title ?? ""}:${d.field}`;
        const ts = recentBeforeMismatches.get(key);
        if (ts && Date.now() - ts < 5000) {
          recentBeforeMismatches.delete(key);
          return false;
        }
        return true;
      };
      if (String(labels["profile-override"] ?? "").trim()) {
        for (const d of diffs.filter((x) => x.caller && fresh(x))) {
          logProfileMetric(labels, cwd, profileOverrideMetric(name, profile.name, d, "kept=caller"), refs);
        }
        return;
      }
      const providerDiff = diffs.find((d) => d.field === "provider");
      if (providerDiff) {
        logProfileMetric(labels, cwd, profileOverrideMetric(name, profile.name, providerDiff, "action=refused"), refs);
        log(`refusing ${agent.id}: profile ${profile.name} wants provider ${providerDiff.profile}, agent runs ${providerDiff.caller}`);
        await (deps.refuseAgent ?? deps.archiveAgent)(agent.id).catch((e) => log(`refuse failed for ${agent.id}: ${e}`));
        return "refused";
      }
      const patch: AgentSettingsPatch = {};
      for (const d of diffs) {
        if (d.field === "model") patch.model = d.profile;
        if (d.field === "mode") patch.modeId = d.profile;
        if (d.field === "thinking") patch.thinkingOptionId = d.profile;
      }
      for (const d of diffs.filter((x) => x.caller && fresh(x))) {
        logProfileMetric(labels, cwd, profileOverrideMetric(name, profile.name, d), refs);
      }
      log(
        `profile override (post-spawn): ${agent.id} ${profile.name} ` +
          diffs.map((d) => `${d.field} ${d.caller || "-"}→${d.profile}`).join(" "),
      );
      if (deps.applyAgentSettings) {
        await deps.applyAgentSettings(agent.id, patch).catch((e) => log(`profile settings fix failed for ${agent.id}: ${e}`));
      }
    };

    // ---- Hook 1: before agent.create ---------------------------------------

    stops.push(
      server.before("agent.create", (ctx: { request: any }) => {
        const t0 = Date.now();
        try {
          return beforeAgentCreate(ctx);
        } finally {
          log(`spawn-timing hook=${Date.now() - t0}ms`);
        }
      }),
    );
    const beforeAgentCreate = ({ request }: { request: any }) => {
        const config: any = request.config ?? {};
        const env = (request as any).env as Record<string, string> | undefined;
        const rawReqLabels = ((request as any).labels ?? config?.labels) as Labels | undefined;
        const callerLane = String(rawReqLabels?.lane || rawReqLabels?.lead || "").trim(); // legacy `lead` label = lane; // before identity resolution rewrites it from cwd
        const reqLabels: Labels = { ...(rawReqLabels ?? {}) };
        const rawRole = (reqLabels.role || config?.role || env?.VS_ROLE || "").trim().toLowerCase();
        const title: string = config?.title ?? (request as any).title ?? (request as any).name ?? "";
        const cwd: string = config?.cwd ?? (request as any).cwd ?? "";
        const provider: string = config?.provider ?? (request as any).provider ?? "";
        let changed = false;
        const next: any = { ...config };
        let nextReqLabels: Labels | undefined = rawReqLabels ? { ...rawReqLabels } : undefined;

        const explicitRole =
          rawRole === "lead"
            ? "lead"
            : rawRole === "brainstorm" || rawRole === "buddy"
              ? "brainstorm"
              : rawRole === "worker"
                ? "worker"
                : "";

        // Paseo hands this hook only { config, env }: spawn labels never arrive here, so
        // VibeSquad's own spawn paths also pass env VS_PROFILE. Label-only spawns are
        // corrected in agent.created instead.
        const profileHint = config.profile || reqLabels.profile || env?.VS_PROFILE;
        const profileMatch = matchStoredProfile(profileHint, provider, title, explicitRole || "worker");
        const matchedProfile = profileMatch?.profile ?? null;
        if (String(profileHint ?? "").trim() && !profileMatch?.explicit) {
          log(`profile "${profileHint}" named by spawn "${title}" is not in profiles.json; caller settings kept`);
        }

        const role = explicitRole || matchedProfile?.role || "worker";

        if (!matchedProfile && (reqLabels.team || reqLabels.lane || reqLabels.role)) {
          log(
            `no profile match for VS spawn "${title}" (provider=${provider}, model=${config?.model ?? ""}, mode=${config?.modeId ?? ""}): pass --label profile=<Profile name>`,
          );
        }

        if (rawReqLabels) {
          const resolved = resolveAgentIdentity(reqLabels, {
            cwd,
            teams: currentTeams(),
            fallbackRole: role,
            recomputeOrphan: true,
          });
          if (!resolved.isOrphan) {
            const wantLane = keptLaneOf(resolved);
            if (reqLabels.lane !== wantLane) {
              reqLabels.lane = wantLane;
              changed = true;
            }
            if (reqLabels.team !== resolved.teamId) {
              reqLabels.team = resolved.teamId;
              changed = true;
            }
            if (!reqLabels.role) {
              reqLabels.role = spawnRoleLabel(resolved.role);
              changed = true;
            }
            if (reqLabels.orphan) {
              reqLabels.orphan = "";
              changed = true;
            }
            if (resolved.teamMismatch) {
              const mismatchKey = `mismatch:${resolved.callerTeam}->${resolved.teamId}:${resolved.laneId}`;
              recentBeforeMismatches.set(mismatchKey, Date.now());
              try {
                appendLog(resolved.teamId, {
                  agent: "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `team-mismatch: caller=${resolved.callerTeam} derived=${resolved.teamId} lane=${resolved.laneId}`,
                });
              } catch (err) {
                log(`mismatch metric write failed: ${err}`);
              }
            }
            if (resolved.autofixedFromCwd && !resolved.callerLane) {
              const autofixKey = `autofix:${resolved.callerLane}->${resolved.laneId}:${cwd}`;
              recentBeforeMismatches.set(autofixKey, Date.now());
              try {
                appendLog(resolved.teamId, {
                  agent: "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `lane-autofix: callerLane=${resolved.callerLane || "(none)"} derivedLane=${resolved.laneId} team=${resolved.teamId} cwd=${cwd}`,
                });
              } catch (err) {
                log(`lane-autofix metric write failed: ${err}`);
              }
            }
            if (resolved.usedTeamFallback) {
              const fbKey = `fallback:${resolved.teamId}:${resolved.laneId}`;
              recentBeforeMismatches.set(fbKey, Date.now());
              try {
                appendLog(resolved.teamId, {
                  agent: "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `team-label-fallback: team=${resolved.teamId} lane=${resolved.laneId}`,
                });
              } catch (err) {
                log(`team-label-fallback metric write failed: ${err}`);
              }
            }
          } else {
            if (reqLabels.orphan !== "1") {
              reqLabels.orphan = "1";
              changed = true;
            }
            if (!reqLabels.role) {
              reqLabels.role = spawnRoleLabel(resolved.role);
              changed = true;
            }
            const orphanKey = `orphan:${resolved.callerLane}:${resolved.callerTeam}:${cwd}`;
            recentBeforeMismatches.set(orphanKey, Date.now());
            try {
              appendLog(UNASSIGNED_TEAM_ID, {
                agent: "plugin",
                lane: resolved.callerLane || "unassigned",
                type: "metric",
                text: `orphan: lane=${resolved.callerLane || "(none)"} team=${resolved.callerTeam || "(none)"} cwd=${cwd || "(none)"}`,
              });
            } catch (err) {
              log(`orphan metric write failed: ${err}`);
            }
          }
          nextReqLabels = { ...reqLabels };
          if ((request as any).labels) {
            Object.assign((request as any).labels, reqLabels);
          }
          if (config?.labels) {
            next.labels = { ...config.labels, ...reqLabels };
            changed = true;
          }
        }

        const keepCaller = Boolean(String(reqLabels["profile-override"] || env?.VS_PROFILE_OVERRIDE || "").trim());
        if (matchedProfile && profileMatch?.explicit && !keepCaller) {
          // An explicitly named profile wins over the caller's provider/model/mode/thinking.
          const diffs = profileFieldDiffs(config, matchedProfile);
          const want = splitProviderModel(matchedProfile.provider, matchedProfile.model);
          const callerPm = splitProviderModel(config.provider, config.model);
          const providerSwapped = !!want.provider && want.provider !== callerPm.provider;
          // A swapped provider can't keep the caller's model/mode/thinking: they belong to the old one.
          if (want.provider) next.provider = want.provider;
          const model = want.model || (providerSwapped ? "" : callerPm.model);
          if (model) next.model = model;
          else delete next.model;
          if (matchedProfile.modeId) next.modeId = matchedProfile.modeId;
          else if (providerSwapped) delete next.modeId;
          if (matchedProfile.thinkingOptionId) next.thinkingOptionId = matchedProfile.thinkingOptionId;
          else if (providerSwapped) delete next.thinkingOptionId;
          if (matchedProfile.featureValues && Object.keys(matchedProfile.featureValues).length > 0) {
            next.featureValues = { ...(next.featureValues ?? {}), ...matchedProfile.featureValues };
          }
          changed = true;
          const clashes = diffs.filter((d) => d.caller);
          if (clashes.length > 0) {
            const pick = (f: ProfileField) => clashes.find((d) => d.field === f);
            const pm = pick("provider") || pick("model");
            const mode = pick("mode");
            log(
              `profile override: ${matchedProfile.name}` +
                (pm ? ` provider/model ${callerPm.provider}/${callerPm.model || "-"}→${want.provider}/${want.model || "-"}` : "") +
                (mode ? ` mode ${mode.caller}→${mode.profile}` : "") +
                (pick("thinking") ? ` thinking ${pick("thinking")!.caller}→${pick("thinking")!.profile}` : ""),
            );
            for (const d of clashes) {
              recentBeforeMismatches.set(`profile:${title}:${d.field}`, Date.now());
              logProfileMetric(reqLabels, cwd, profileOverrideMetric(title, matchedProfile.name, d));
            }
          }
        } else if (matchedProfile) {
          if (profileMatch?.explicit && keepCaller) {
            for (const d of profileFieldDiffs(config, matchedProfile).filter((x) => x.caller)) {
              recentBeforeMismatches.set(`profile:${title}:${d.field}`, Date.now());
              logProfileMetric(reqLabels, cwd, profileOverrideMetric(title, matchedProfile.name, d, "kept=caller"));
            }
          }
          if (!next.modeId && matchedProfile.modeId) {
            next.modeId = matchedProfile.modeId;
            changed = true;
          }
          if (!next.thinkingOptionId && matchedProfile.thinkingOptionId) {
            next.thinkingOptionId = matchedProfile.thinkingOptionId;
            changed = true;
          }
          if (matchedProfile.featureValues && Object.keys(matchedProfile.featureValues).length > 0) {
            const mergedFv = { ...matchedProfile.featureValues, ...(next.featureValues ?? {}) };
            if (JSON.stringify(mergedFv) !== JSON.stringify(next.featureValues ?? {})) {
              next.featureValues = mergedFv;
              changed = true;
            }
          }
        }

        // A1: Antigravity must never hang on an unsurfaced permission prompt. Keyed on the
        // final provider, after any profile override.
        const finalProvider = String(next.provider ?? provider);
        if (finalProvider.startsWith("antigravity-cli")) {
          const fv = { ...(next.featureValues ?? {}) };
          if (!fv.approvalPolicy || fv.approvalPolicy === "agy") fv.approvalPolicy = "skip";
          if (fv.approvalPolicy !== config.featureValues?.approvalPolicy) {
            next.featureValues = fv;
            changed = true;
          }
          if (!next.modeId) {
            next.modeId = "accept-edits";
            changed = true;
          }
        }

        const rawSysPrompt = config.systemPrompt ?? "";
        const sanitizedSysPrompt = sanitizeLegacyRosterPrompt(rawSysPrompt);
        if (sanitizedSysPrompt !== rawSysPrompt) {
          next.systemPrompt = sanitizedSysPrompt;
          changed = true;
        }

        const spawnTeamId = teamOf(reqLabels, cwd)?.team;
        const vibeMode = Boolean(spawnTeamId && currentTeams().find((t) => t.id === spawnTeamId)?.vibeMode === true);
        const prefix = injectedPrefix(role, cwd, vibeMode);
        const profileNotes = dedupeNotesAgainst((matchedProfile?.notes ?? "").trim(), prefix);
        const gitState = inspectGitSpawnState(cwd);
        if (prefix && !sanitizedSysPrompt.includes(EVERYONE_LAYER)) {
          const existing = sanitizedSysPrompt.trim();
          const parts = [prefix];
          if (profileNotes && !existing.includes(profileNotes)) {
            parts.push(profileNotes);
          }
          if (existing) {
            parts.push(existing);
          }
          if (gitState && !existing.includes("Starting git state (snapshot at spawn")) {
            parts.push(gitState);
          }
          next.systemPrompt = parts.join("\n\n");
          changed = true;
          const where = teamOf(reqLabels, cwd);
          if (where) {
            try {
              appendLog(where.team, {
                agent: "plugin",
                lane: where.lane,
                type: "metric",
                text: `prompt-injection role=${role} provider=${finalProvider} chars=${prefix.length}`,
              });
            } catch (err) {
              log(`metric write failed: ${err}`);
            }
          }
        }

        // Every Buddy starts from its lane brief, even when spawned by Roster or the
        // legacy board (whose boot prompt never loads docs/brainstorm/<lane>.md).
        if (role === "brainstorm") {
          // Never guess the lane from cwd: a spawn from inside another lane's worktree got that lane's brief.
          const briefLane = (reqLabels.orphan === "1" ? "" : callerLane || env?.VS_LANE || "").trim();
          const marker = briefBeginMarker(briefLane);
          const reqPrompt = String((request as any).prompt ?? (request as any).initialPrompt ?? "");
          const currentSys = String(next.systemPrompt ?? sanitizedSysPrompt ?? "");
          // VS's own restart path (server/brainstorm.mjs) already puts the brief in the first prompt.
          const fromVsRestart = Boolean(reqLabels["vs.restarted-from"]) || env?.VS_BRIEF_INLINE === "1";
          if (briefLane && !fromVsRestart && !currentSys.includes(marker) && !reqPrompt.includes(marker)) {
            const briefRoot = deps.briefRoot ?? briefRootFor(reqLabels.team || env?.VS_TEAM || "", briefLane, REPO_ROOT);
            const block = laneBriefBlock(briefRoot, briefLane);
            if (block) {
              next.systemPrompt = [currentSys.trim(), block].filter(Boolean).join("\n\n");
              changed = true;
              const where = teamOf(reqLabels, cwd);
              if (where) {
                try {
                  appendLog(where.team, {
                    agent: "plugin",
                    lane: briefLane,
                    type: "metric",
                    text: `brief-injected: lane=${briefLane} chars=${block.length}${/You are the Brainstorm chat for/.test(reqPrompt) ? " source=legacy-board" : ""}`,
                  });
                } catch (err) {
                  log(`brief metric write failed: ${err}`);
                }
              }
            }
          }
        }

        if (leanApplies(next.provider ?? provider, env)) {
          next.providerOptions = leanProviderOptions(next.providerOptions, role);
          changed = true;
        }

        return changed
          ? {
              ...request,
              ...(nextReqLabels && (request as any).labels ? { labels: nextReqLabels } : {}),
              config: next,
            }
          : undefined;
    };

    // ---- agent.created: auto-label, antigravity everyone-layer, first dispatch

    stops.push(
      server.on("agent.created", async ({ agent }: { agent: any }, { paseo }: { paseo: any }) => {
        paseoApi = paseo;
        try {
          const { snap: me, labels } = await labelsFor(paseo, agent);
          // Never let a wrong-provider agent go on to retire a predecessor or count as a dispatch.
          if ((await enforceProfileAfterSpawn(agent, me, labels)) === "refused") return;
          const parentId = agent.parentAgentId || labels["paseo.parent-agent-id"];
          const parent = parentId ? await snap(paseo, parentId) : null;
          const pl = parent?.labels ?? {};
          const agentCwd = agent.cwd ?? me?.cwd ?? "";

          const resolved = resolveAgentIdentity(
            {
              ...agent,
              cwd: agentCwd,
              parentAgentId: parentId,
              labels,
            },
            {
              teams: currentTeams(),
              fallbackRole: labels.role || "worker",
              recomputeOrphan: true,
              agentsById: parent && parentId ? { [parentId]: parent } : undefined,
            },
          );

          const want: Labels = {};
          let lane = "";
          let team = "";

          if (!resolved.isOrphan) {
            lane = keptLaneOf(resolved);
            team = resolved.teamId;
            if (labels.lane !== lane) want.lane = lane;
            if (labels.team !== resolved.teamId) want.team = resolved.teamId;
            if (!labels.role) want.role = spawnRoleLabel(resolved.role);
            if (labels.orphan) want.orphan = "";

            if (resolved.teamMismatch) {
              const mismatchKey = `mismatch:${resolved.callerTeam}->${resolved.teamId}:${resolved.laneId}`;
              const prevTs = recentBeforeMismatches.get(mismatchKey);
              if (prevTs && Date.now() - prevTs < 2000) {
                recentBeforeMismatches.delete(mismatchKey);
              } else {
                appendLog(resolved.teamId, {
                  agent: agent.id || "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `team-mismatch: caller=${resolved.callerTeam} derived=${resolved.teamId} lane=${resolved.laneId}`,
                  refs: agent.id ? [agent.id] : [],
                });
              }
            }
            if (resolved.autofixedFromCwd && !resolved.callerLane) {
              const autofixKey = `autofix:${resolved.callerLane}->${resolved.laneId}:${agentCwd}`;
              const prevTs = recentBeforeMismatches.get(autofixKey);
              if (prevTs && Date.now() - prevTs < 2000) {
                recentBeforeMismatches.delete(autofixKey);
              } else {
                appendLog(resolved.teamId, {
                  agent: agent.id || "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `lane-autofix: callerLane=${resolved.callerLane || "(none)"} derivedLane=${resolved.laneId} team=${resolved.teamId} cwd=${agentCwd}`,
                  refs: agent.id ? [agent.id] : [],
                });
              }
            }
            if (resolved.usedTeamFallback) {
              const fbKey = `fallback:${resolved.teamId}:${resolved.laneId}`;
              const prevTs = recentBeforeMismatches.get(fbKey);
              if (prevTs && Date.now() - prevTs < 2000) {
                recentBeforeMismatches.delete(fbKey);
              } else {
                appendLog(resolved.teamId, {
                  agent: agent.id || "plugin",
                  lane: resolved.laneId,
                  type: "metric",
                  text: `team-label-fallback: team=${resolved.teamId} lane=${resolved.laneId}`,
                  refs: agent.id ? [agent.id] : [],
                });
              }
            }
          } else {
            if (labels.orphan !== "1") want.orphan = "1";
            if (!labels.role) want.role = spawnRoleLabel(resolved.role);
            const orphanKey = `orphan:${resolved.callerLane}:${resolved.callerTeam}:${agentCwd}`;
            const prevTs = recentBeforeMismatches.get(orphanKey);
            if (prevTs && Date.now() - prevTs < 2000) {
              recentBeforeMismatches.delete(orphanKey);
            } else {
              appendLog(UNASSIGNED_TEAM_ID, {
                agent: agent.id || "plugin",
                lane: resolved.callerLane || "unassigned",
                type: "metric",
                text: `orphan: lane=${resolved.callerLane || "(none)"} team=${resolved.callerTeam || "(none)"} cwd=${agentCwd || "(none)"}`,
                refs: agent.id ? [agent.id] : [],
              });
            }
          }

          // A lead always carries an ord: one past the lane's highest lead/former-lead ord.
          if ((labels.role || want.role) === "lead" && !String(labels.ord ?? "").trim()) {
            const ordLane = lane || resolved.callerLane;
            want.ord = "1";
            if (ordLane) {
              await Promise.resolve()
                .then(() => paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } }))
                .then((res: any) => {
                  want.ord = nextLeadOrd((res?.entries ?? []).map((e: any) => e.agent), ordLane, agent.id);
                })
                .catch((e: unknown) => log(`lead ord scan failed for ${agent.id}: ${e}`));
            }
          }

          if (Object.keys(want).length > 0) {
            await deps.setLabels(agent.id, { ...labels, ...want }).catch((e) => log(`label failed: ${e}`));
          }

          const finalRole = labels.role || want.role || "";
          // A lead outlives the Buddy (or old lead) that spawned it: Paseo archives children with their
          // parent, so a chained lead and all its workers went down with every Buddy restart. Start it detached.
          if (finalRole === "lead" && parentId) {
            await Promise.resolve()
              .then(() => paseo.agents.ref(agent.id).detach())
              .then(() => log(`detached new lead ${agent.id} from parent ${parentId}`))
              .catch((e: unknown) => log(`detach failed for lead ${agent.id}: ${e}`));
          }
          const finalTopic = finalRole === "brainstorm" ? brainstormTopicOf({ ...labels, ...want }) : "";
          // An explicit lane label beats cwd for retirement: if the label lane was
          // overridden from cwd, the plugin is guessing, so never retire anyone on a guess.
          const laneOverriddenFromCwd =
            !resolved.isOrphan && resolved.autofixedFromCwd && !!resolved.callerLane && resolved.callerLane !== resolved.laneId;
          if (laneOverriddenFromCwd && (finalRole === "lead" || finalRole === "brainstorm")) {
            log(
              `skipped retire for ${agent.id}: lane label "${resolved.callerLane}" is not in teams.json, cwd guessed "${resolved.laneId}"`,
            );
          }
          if ((finalRole === "lead" || finalRole === "brainstorm") && team && lane && !laneOverriddenFromCwd) {
            await retirePredecessors(paseo, agent.id, finalRole, teamIdOf(team, currentTeams()), lane, finalTopic).catch((e) =>
              log(`retire scan failed: ${e}`),
            );
          }

          if (team && lane) await refreshLaneWhosHere(paseo, lane);

          // First-dispatch context metric for a lead's first spawned child.
          if (parentId && parent && pl.role === "lead" && team) {
            const n = (childCount.get(parentId) ?? 0) + 1;
            childCount.set(parentId, n);
            if (n === 1 && !firstDispatchLogged.has(parentId)) {
              firstDispatchLogged.add(parentId);
              appendLog(teamIdOf(team, currentTeams()), {
                agent: "plugin",
                lane,
                type: "metric",
                text: firstDispatchMetricText(parent, parentId, pl.ord),
              });
            }
          }
        } catch (err) {
          log(`agent.created handler failed: ${err}`);
        }
      }),
    );

    // ---- Hook 2 + 4: turn_ended -------------------------------------------

    stops.push(
      server.on(
        "agent.turn_ended",
        async (
          { agent, turnId, outcome }: { agent: any; turnId: string | null; outcome: any },
          { paseo }: { paseo: any },
        ) => {
          paseoApi = paseo;
          try {
            if (outcome.kind === "failed") return await handleFailure(paseo, agent, outcome.error.message);
            if (outcome.kind !== "completed") return;
            retries.delete(agent.id);

            const { snap: me, labels } = await labelsFor(paseo, agent);
            await relayFromFormerLead(paseo, agent, labels);
            if (isDigestAgent(labels)) return;

            const role = effectiveAgentRole({ labels });
            if (role === "worker") {
              await spawnDigest(paseo, agent, turnId, labels);
            }
            if (role === "lead") {
              if (handoffCoordinator.hasPendingTakeover(agent.id) || labels["vs.handoff-from"]) {
                await handoffCoordinator.confirmTakeover(agent.id).catch((e: unknown) => log(`confirmTakeover failed: ${e}`));
              }
              await checkLeadTokens(paseo, agent.id, me, labels);
              flushWake(paseo, agent.id);
            }
          } catch (err) {
            log(`turn_ended handler failed: ${err}`);
          }
        },
      ),
    );

    async function lastAssistantText(paseo: Paseo, id: string): Promise<string> {
      try {
        const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 20 });
        let last = "";
        for (const { item } of page.entries) {
          if (item.type === "assistant_message" && item.text?.trim()) last = item.text.trim();
        }
        return last;
      } catch {
        return "";
      }
    }

    async function spawnDigest(paseo: Paseo, worker: any, turnId: string | null, labels: Labels) {
      if (isDigestAgent(labels, worker.title) || isDigestNoise(labels, worker.title)) return;
      const key = `${worker.id}:${turnId ?? ""}`;
      if (digested.has(key)) return;
      digested.add(key);
      const where = teamOf(labels, worker.cwd);
      if (!where) return;
      const { team, lane } = where;
      const prompt = [
        `You are a digest agent. Inspect the final result of worker agent ${worker.id} ("${worker.title ?? ""}"):`,
        `run \`paseo inspect ${worker.id}\` / read its last assistant message and any report it names. Do not modify files.`,
        `Then run exactly once:`,
        `vs log done "<PASS|FAIL>: <1-line summary, max 200 chars>" --digest --ref ${worker.id}`,
        `Use FAIL if the worker reported errors, failing tests, or did not finish. If its report states neither PASS nor FAIL, log nothing. Then stop.`,
      ].join("\n");

      const fallback = async (why: string) => {
        const last = await lastAssistantText(paseo, worker.id);
        if (!statesVerdict(last)) return;
        const line = last.split(/\r?\n/).find((l) => l.trim()) ?? "no final message";
        appendLog(teamIdOf(team, currentTeams()), {
          agent: worker.id,
          lane,
          type: "done",
          text: `UNVERIFIED (digest ${why}): ${line}`,
          refs: [worker.id],
        });
      };

      try {
        const digestProfile = resolveStoredProfile(DIGEST_PROFILE, DIGEST_PROVIDER, DIGEST_PROFILE, "worker");
        const digestProvider = digestProfile ? `${digestProfile.provider}/${digestProfile.model}` : DIGEST_PROVIDER;
        const digestModeId = digestProfile?.modeId || DIGEST_MODE_ID;
        const digestThinking = digestProfile?.thinkingOptionId || DIGEST_THINKING_OPTION_ID;
        const digestFeatures = digestProfile?.featureValues ? { ...digestProfile.featureValues } : { approvalPolicy: "skip" };
        const handle = await paseo.agents.create({
          config: {
            provider: digestProvider,
            modeId: digestModeId,
            thinkingOptionId: digestThinking,
            featureValues: digestFeatures,
          },
          cwd: worker.cwd,
          title: `${DIGEST_PROFILE} digest`,
          prompt,
          labels: { team, lane, role: "worker", profile: DIGEST_PROFILE, digestFor: worker.id },
          env: { VS_PROFILE: DIGEST_PROFILE },
          autoArchive: true,
        });
        // Backstop: if the digest agent errors out, write the entry directly.
        void Promise.resolve(handle?.waitForFinish?.(10 * 60_000))
          .then((res: any) => {
            if (res && res.status && res.status !== "idle" && res.status !== "completed" && res.status !== "finished") {
              return fallback("failed");
            }
          })
          .catch(() => fallback("errored"));
      } catch (err) {
        log(`digest spawn failed for ${worker.id}: ${err}`);
        await fallback("spawn failed");
      }
    }

    async function checkLeadTokens(_paseo: Paseo, id: string, me: AgentSnap | null, labels: Labels) {
      const leadSnap = me ? { ...me, id, labels: { ...(me.labels ?? {}), ...labels } } : { id, title: null, labels };
      await handoffCoordinator.evaluateLead(leadSnap).catch((e: unknown) => log(`lead handoff check failed: ${e}`));
    }

    // A4: transient network error retry with exponential backoff.
    async function handleFailure(paseo: Paseo, agent: any, message: string) {
      if (!TRANSIENT_ERROR.test(message)) return;
      const n = retries.get(agent.id) ?? 0;
      if (n >= MAX_RETRIES) {
        log(`transient error on ${agent.id} persisted after ${n} retries: ${message}`);
        return;
      }
      retries.set(agent.id, n + 1);
      const delay = deps.retryBaseMs * 2 ** n;
      log(`transient error on ${agent.id}; retry ${n + 1}/${MAX_RETRIES} in ${delay}ms`);
      later(() => {
        paseo.agents
          .ref(agent.id)
          .send("The previous turn failed on a transient network error. Please continue where you left off.")
          .catch((e: unknown) => log(`retry send failed: ${e}`));
      }, delay);
    }

    // ---- Hook 3: event-driven lead wakeups ---------------------------------

    /** Queue a wakeup for the current lead in (team, lane) after the debounce window. */
    function queueWake(team: string, entry: LogEntry) {
      wakeQueue.push({ team, entry });
      if (wakeTimer) return;
      wakeTimer = later(() => {
        wakeTimer = null;
        void dispatchWakes();
      }, deps.debounceMs);
    }

    function noteEntry(team: string, entry: LogEntry) {
      if (!WAKE_TYPES.has(entry.type)) return;
      queueWake(team, entry);
    }

    /**
     * A retired lead never gets its children's notifications. Relay their turn
     * endings to the current active lead in the same (team, lane) instead.
     */
    async function relayFromFormerLead(paseo: Paseo, agent: any, labels: Labels) {
      const where = teamOf(labels, agent.cwd);
      if (!where) return;
      const isSelfFormer = isRetiredRole(labels.role);
      let relay = isSelfFormer;
      let targetId = String(agent.id ?? "former-lead");
      const parentId = agent.parentAgentId as string | undefined;
      if (!relay && parentId) {
        const parent = await snap(paseo, parentId);
        if (isRetiredRole(parent?.labels.role)) {
          relay = true;
          targetId = String(parent?.id ?? parentId);
        }
      }
      if (!relay) return;
      const dateStr = new Date().toISOString().slice(0, 10);
      const countKey = `${dateStr}:${where.team}`;
      const dailyCount = (misrouteCounts.get(countKey) ?? 0) + 1;
      misrouteCounts.set(countKey, dailyCount);
      appendLog(where.team, {
        agent: String(agent.id ?? "former-lead"),
        lane: where.lane,
        type: "metric",
        text: `misroute-old: date=${dateStr} count=${dailyCount} target=${targetId}`,
        refs: agent.id ? [String(agent.id)] : [],
      });
      queueWake(where.team, {
        ts: new Date().toISOString(),
        agent: String(agent.id ?? "former-lead"),
        lane: where.lane,
        type: "done",
        text: `Relayed from former lead: child/turn completed on ${agent.title || agent.id}`,
        refs: agent.id ? [String(agent.id)] : [],
      });
    }

    /** Keep `## Who's here` in the lane brief current (live titles + worker count, no IDs). */
    async function refreshLaneWhosHere(paseo: Paseo, lane: string) {
      try {
        const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
        const agents = (res.entries as any[]).map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }));
        refreshWhosHere({ laneId: lane, agents, rootDir: REPO_ROOT });
      } catch (e) {
        log(`whos-here refresh failed: ${e}`);
      }
    }

    /** Lane integrity: a lane keeps one live lead and one live brainstorm per (team, lane, topic); the predecessor is marked former-*. */
    async function retirePredecessors(paseo: Paseo, newId: string, role: string, team: string, lane: string, topic = "") {
      const newSnap = await snap(paseo, newId);
      const handoffFrom = newSnap?.labels?.["vs.handoff-from"] ?? "";
      const skipMetric = (reason: string, refs: string[]) => {
        log(`skipped retire in ${team}/${lane}: ${reason}`);
        try {
          appendLog(team, { agent: "plugin", lane, type: "metric", text: `skipped-retire-mismatch: ${reason}`, refs });
        } catch (err) {
          log(`skipped-retire metric write failed: ${err}`);
        }
      };
      // The new agent's own lane is a guess (lane label disagrees with legacy lead label): retire nobody.
      const newMismatch = newSnap ? laneLeadMismatch(newSnap, currentTeams()) : "";
      if (newMismatch) {
        skipMetric(`new=${newId} ${newMismatch} role=${role}`, [newId]);
        return;
      }
      const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
      const others = (res.entries as any[])
        .map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }) as AgentSnap)
        .filter((a) => a.id !== newId && !a.archivedAt && !a.internal && a.status !== "closed")
        .filter((a) => !isRetiredAgent(a))
        .filter((a) => sameLaneRole(a, { role, team, lane, topic }, currentTeams()));
      for (const old of others) {
        if (role === "lead" && (old.id === handoffFrom || handoffCoordinator.hasPendingTakeover(newId))) {
          // Delayed retirement: wait until successor confirms takeover in turn_ended / confirmTakeover.
          continue;
        }
        // Never retire a candidate whose lane is itself a guess: either its lane label
        // disagrees with its legacy lead label, or its lane label is unregistered and cwd filled in.
        const oldMismatch = laneLeadMismatch(old, currentTeams());
        if (oldMismatch) {
          skipMetric(`old=${old.id} new=${newId} ${oldMismatch} role=${role}`, [old.id, newId]);
          continue;
        }
        const oldResolved = resolveAgentIdentity(old, { cwd: old.cwd, teams: currentTeams() });
        if (oldResolved.autofixedFromCwd && oldResolved.callerLane && oldResolved.callerLane.toLowerCase() !== oldResolved.laneId.toLowerCase()) {
          skipMetric(`old=${old.id} new=${newId} lane=${oldResolved.callerLane} cwd-lane=${oldResolved.laneId} role=${role}`, [old.id, newId]);
          continue;
        }
        const former = role === "lead" ? "former-lead" : "former-brainstorm";
        const ord = old.labels.ord;
        const laneName = currentTeams().flatMap((t: any) => t.lanes ?? []).find((x: any) => x.id === lane || x.aliases?.includes(lane))?.name ?? lane;
        const oldTitle = (old.title ?? "").trim();
        const name =
          role === "lead"
            ? ord
              ? formatDisplayTitle({
                  role: "former-lead",
                  laneId: lane,
                  laneName,
                  code: laneCodeFor(lane, currentTeams()),
                  ord,
                  job: old.labels.job,
                })
              : `(old) ${oldTitle}`
            : `(old) ${oldTitle || "Buddy"}`;
        if (role === "brainstorm") {
          // The brief is the Buddy handoff: make sure it holds the predecessor's last turn
          // and the log names both Buddies before anything is relabelled or archived.
          let brief = "missing";
          try {
            brief = snapshotIntoBrief(deps.briefRoot ?? briefRootFor("", lane, REPO_ROOT), lane, old, await lastAssistantText(paseo, old.id));
          } catch (err) {
            log(`brief snapshot failed for ${old.id}: ${err}`);
          }
          try {
            appendLog(team, {
              agent: "plugin",
              lane,
              type: "metric",
              text: `brainstorm-retired: old=${old.id} new=${newId} lane=${lane}${topic ? ` topic=${topic}` : ""} brief=${brief}`,
              refs: [old.id, newId],
            });
          } catch (err) {
            log(`brainstorm-retired metric write failed: ${err}`);
          }
        }
        let renamed = true;
        await deps.setLabels(old.id, { role: former, ...(role === "lead" && ord ? { ord } : {}) }, name).catch((e) => {
          renamed = false;
          log(`retire failed: ${e}`);
        });
        log(`retired ${old.id} (${role} -> ${former}) in ${team}/${lane}`);
        if (role === "brainstorm" && renamed) scheduleBuddyArchive(paseo, old.id);
      }
    }

    /** Archive a retired Buddy after a grace period, never mid-turn and never if it was restored. */
    function scheduleBuddyArchive(paseo: Paseo, id: string, attempt = 0) {
      const grace = Math.max(0, deps.brainstormArchiveGraceMs ?? 120_000);
      later(async () => {
        const cur = await snap(paseo, id);
        if (!cur || cur.archivedAt || cur.status === "closed") return;
        if (cur.labels.role !== "former-brainstorm") return;
        if (cur.status === "running" && attempt < 15) return scheduleBuddyArchive(paseo, id, attempt + 1);
        // Paseo archives children with their parent: detach the Buddy's live lead (and anything else it
        // spawned) first, and keep the Buddy unarchived if that fails (docs/PLAN_BUGS_BATCH1.md block 0).
        const { detached, failed } = await detachLiveChildren(id, {
          list: async () =>
            ((await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } })).entries as any[]).map(
              (e) => e.agent,
            ),
          detach: (childId: string) => paseo.agents.ref(childId).detach(),
        });
        if (detached.length) log(`detached ${detached.join(", ")} from retired Buddy ${id} before archive`);
        if (failed.length) return log(`kept ${id} unarchived: could not detach ${failed.map((f) => f.id).join(", ")}`);
        await Promise.resolve()
          .then(() => paseo.agents.ref(id).archive())
          .catch(() => deps.archiveAgent(id))
          .catch((e: unknown) => log(`archive failed for ${id}: ${e}`));
      }, grace);
    }

    async function findLead(paseo: Paseo, team: string, lane: string): Promise<AgentSnap | null> {
      const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
      const wantLane = (lane || "").toLowerCase();
      const leads = (res.entries as any[])
        .map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }) as AgentSnap)
        .filter((a) => !a.archivedAt && !a.internal && a.status !== "closed")
        .filter((a) => effectiveAgentRole(a) === "lead")
        .filter((a) => {
          const d = deriveTeamForSpawn(a.labels, a.cwd, currentTeams());
          const aTeam = teamIdOf(d.team || a.labels.team, currentTeams());
          const aLane = (d.lane || a.labels.lane || a.labels.lead || "").toLowerCase();
          return aTeam === team && (!wantLane || aLane === wantLane);
        });
      leads.sort((a, b) => {
        const at = Date.parse(a.updatedAt ?? "");
        const bt = Date.parse(b.updatedAt ?? "");
        return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
      });
      return leads[0] ?? null;
    }

    async function handleSendAgentPrompt(input: any, ctx?: { paseo?: Paseo }) {
      const paseo = ctx?.paseo ?? paseoApi;
      if (!paseo) return undefined;
      const req = input?.request ?? input ?? {};
      const targetId = String(
        req.agentId ?? req.targetAgentId ?? req.to ?? input?.agentId ?? input?.targetAgentId ?? "",
      ).trim();
      if (!targetId) return undefined;
      const promptText = String(
        req.prompt ?? req.message ?? req.text ?? input?.prompt ?? input?.message ?? input?.text ?? "",
      );
      const senderId = String(
        req.senderAgentId ??
          req.sourceAgentId ??
          req.fromAgentId ??
          input?.senderAgentId ??
          input?.sourceAgentId ??
          input?.fromAgentId ??
          "",
      ).trim();

      const target = await snap(paseo, targetId);
      if (!target) return undefined;
      const isRetired = Boolean(target.archivedAt || target.status === "closed" || isRetiredLeadSnap(target));
      if (!isRetired) return undefined;

      const { team: rawTeam, lane: rawLane } = deriveTeamForSpawn(target.labels, target.cwd, currentTeams());
      const team = teamIdOf(rawTeam || target.labels?.team || "", currentTeams());
      const lane = rawLane || target.labels?.lane || target.labels?.lead || team;

      const dateStr = new Date().toISOString().slice(0, 10);
      const countKey = `${dateStr}:${team}`;
      const dailyCount = (misrouteCounts.get(countKey) ?? 0) + 1;
      misrouteCounts.set(countKey, dailyCount);
      if (team) {
        appendLog(team, {
          agent: String(senderId || target.id),
          lane: lane || team,
          type: "metric",
          text: `misroute-old: date=${dateStr} count=${dailyCount} target=${target.id}`,
          refs: [target.id],
        });
      }

      const currentLead = await findLead(paseo, team, rawLane || target.labels?.lane || target.labels?.lead || "");
      const oldShort = extractLeadShortName(target);
      if (!currentLead) {
        throw new Error(`${oldShort} is retired and no live lead exists for ${team}/${lane}`);
      }
      const newShort = extractLeadShortName(currentLead);
      const notice = `${oldShort} is retired; delivered to ${newShort}`;
      await paseo.agents.ref(currentLead.id).send(promptText);
      if (senderId) {
        await paseo.agents
          .ref(senderId)
          .send(notice)
          .catch(() => {});
      }
      return {
        redirected: true,
        agentId: currentLead.id,
        targetAgentId: currentLead.id,
        notice,
        request: { ...(input?.request ?? input), agentId: currentLead.id },
      };
    }

    for (const hookName of ["send_agent_prompt", "agent.send"]) {
      try {
        stops.push(
          server.before(hookName as any, (payload: any, ctx?: any) =>
            handleSendAgentPrompt(payload, { paseo: ctx?.paseo ?? paseoApi }),
          ),
        );
      } catch {
        // Host may restrict before() event names
      }
    }

    try {
      stops.push(
        server.on("agent.turn_started" as any, async ({ agent }: { agent: any }, { paseo }: { paseo: any }) => {
          paseoApi = paseo;
          try {
            const me = await snap(paseo, agent.id);
            if (!me || !isRetiredLeadSnap(me)) return;
            const page = await paseo.agents
              .ref(agent.id)
              .timeline?.refetch?.({ direction: "tail", limit: 10 })
              .catch(() => null);
            let lastUserText = "";
            for (const entry of page?.entries ?? []) {
              const item = entry?.item ?? entry;
              if ((item?.type === "user_message" || item?.role === "user") && item?.text?.trim()) {
                lastUserText = item.text.trim();
              }
            }
            if (!lastUserText) return;
            await handleSendAgentPrompt({ agentId: agent.id, prompt: lastUserText }, { paseo }).catch((e) =>
              log(`turn_started redirect failed: ${e}`),
            );
          } catch (err) {
            log(`turn_started handler failed: ${err}`);
          }
        }),
      );
    } catch {
      // Host may restrict on() event names
    }

    async function dispatchWakes() {
      const paseo = paseoApi;
      if (!paseo || !wakeQueue.length) return;
      const batch = wakeQueue.splice(0);
      const byKey = new Map<string, { team: string; lane: string; entries: LogEntry[] }>();
      for (const { team, entry } of batch) {
        const k = `${team}/${entry.lane}`;
        const slot = byKey.get(k) ?? { team, lane: entry.lane, entries: [] };
        slot.entries.push(entry);
        byKey.set(k, slot);
      }
      for (const { team, lane, entries } of byKey.values()) {
        try {
          const lead = await findLead(paseo, team, lane);
          if (!lead) continue;
          const fresh = entries.filter((e) => e.agent !== lead.id);
          if (!fresh.length) continue;
          const queue = pendingWake.get(lead.id) ?? [];
          queue.push(...fresh);
          pendingWake.set(lead.id, queue);
          if (lead.status === "idle") flushWake(paseo, lead.id);
        } catch (err) {
          log(`wake dispatch failed: ${err}`);
        }
      }
    }

    function flushWake(paseo: Paseo, leadId: string) {
      const queue = pendingWake.get(leadId);
      if (!queue?.length) return;
      pendingWake.delete(leadId);
      const last = queue[queue.length - 1]!;
      const more = queue.length > 1 ? ` (+${queue.length - 1} more)` : "";
      const text = `New team log event in lane ${last.lane}: [${last.type}] ${last.text}${more}. Run 'vs log --since-me' if more context is needed.`;
      paseo.agents
        .ref(leadId)
        .send(text)
        .catch((e: unknown) => log(`wakeup send failed: ${e}`));
    }

    /** Read newly appended lines in every team log; exported through the returned handle for tests. */
    function scanLogs(baseline = false) {
      const root = path.join(baseDir(), "teams");
      let dirs: string[] = [];
      try {
        dirs = fs.readdirSync(root);
      } catch {
        return;
      }
      for (const team of dirs) {
        const file = path.join(root, team, "log.jsonl");
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }
        let seen = offsets.get(file);
        if (seen === undefined) {
          if (baseline) {
            offsets.set(file, size); // startup: skip history, only new entries wake anyone
            continue;
          }
          // A log created after startup: read it from the very first byte.
          seen = 0;
        }
        if (size < seen) {
          seen = 0; // truncated: re-read from the start
        }
        if (size === seen) {
          offsets.set(file, seen);
          continue;
        }
        const fd = fs.openSync(file, "r");
        try {
          const buf = Buffer.alloc(size - seen);
          fs.readSync(fd, buf, 0, buf.length, seen);
          const text = buf.toString("utf8");
          const complete = text.lastIndexOf("\n") + 1;
          offsets.set(file, seen + Buffer.byteLength(text.slice(0, complete)));
          for (const line of text.slice(0, complete).split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              noteEntry(team, JSON.parse(line) as LogEntry);
            } catch {
              // skip malformed
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    scanLogs(true); // baseline offsets
    let interval: ReturnType<typeof setInterval> | null = null;
    if (deps.startWatcher) {
      interval = setInterval(() => scanLogs(false), deps.watchIntervalMs);
      interval.unref?.();
    }

    const dispose = () => {
      lifetime.abort();
      if (interval) clearInterval(interval);
      for (const t of timers) clearTimeout(t);
      for (const stop of stops) stop();
    };
    (dispose as any).scanLogs = scanLogs;
    (dispose as any).handoffCoordinator = handoffCoordinator;
    (dispose as any).confirmTakeover = handoffCoordinator.confirmTakeover;
    (dispose as any).sendAgentPrompt = (req: any, ctx?: any) =>
      handleSendAgentPrompt(req, ctx ?? { paseo: paseoApi });
    (dispose as any).setPaseo = (p: Paseo) => {
      paseoApi = p;
    };
    return dispose;
  };
}

// Function declaration (hoisted): Paseo eagerly copies exports before module-level vars initialise.
export default function vibesquad(server: PluginServerContext) {
  return createPlugin()(server);
}
