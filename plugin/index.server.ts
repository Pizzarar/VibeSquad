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
import { execFile } from "node:child_process";
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
import { writeBriefFile } from "@vibesquad/server/brief-write.mjs";
import { defangPromptFences } from "@vibesquad/server/write-guards.mjs";
import { detachLiveChildren } from "@vibesquad/server/detach-children.mjs";
import { briefRootFor } from "@vibesquad/server/brief-path.mjs";
import { DEFAULT_PACK_PROFILES, deriveRole } from "@vibesquad/server/profiles.mjs";
import { normalizeProviderFamily, resolveProfileWithFailover } from "@vibesquad/server/provider-failover.mjs";
import { leanApplies, leanProviderOptions } from "@vibesquad/server/lean-tools.mjs";
import { makeVsHttpHandler, vsHttp } from "./server/remote-proxy.ts";
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
const TRANSIENT_ERROR = /googleapis|EOF|no such host|ECONNRESET|stream idle timeout|context deadline exceeded|stream was interrupted|temporarily unavailable/i;
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
  "- R8 (Worktrees & Lanes): Address feature lanes by their `@<code>` handle (e.g. `@bug`, `@ade`, `@uip`, `@art`). Create linked git worktrees only via `vs worktree create <unit>` (stored in the managed worktree sanctuary, never as sibling folders in the projects directory), and sweep merged worktrees with `vs worktree sweep --apply`.",
  "- R9 (Owner shorthand & interrupts): Decode keyboard/phonetic shorthand silently (`dameon`→daemon, `emini`→gemini, `paseo la`→paseo ls, `gold`→hold, `sotpped`→stopped, `ahvent`→haven't). Translate mechanism suggestions into cleaner primitives (`vs who`, worktree sanctuary, role-tier failover) and record the translation in Decided. Treat `/btw` / `also` / `on another note` as separate queued units, split multi-item dumps into parallel `@lane` units, and treat short approvals (`send it`, `go for b`, `do it`) as terminal go-signals.",
  "- R10 (Releases): Never run release, publish, tag or signing scripts yourself. When the owner asks for a release, send `vs log handoff \"release <project> <stable|beta> <commit|branch>\" -> Release Desk` plus a Paseo message to the Release Desk Buddy (`vs who brainstorm --lane release-desk`) with the change list and credits, then go back to your work. The desk versions, audits, signs, publishes and reports back.",
  "- Attribution (Community Accolades): Whenever designing, committing, or releasing parity/plugin-inspired features, record the original plugin/project name and publisher in plans, commits, `CREDITS.md`, and release notes using: \"Implemented <feature> — Thanks to <Plugin/Project> by <Author>\".",
].join("\n");

export const WORKER_PACK = [
  "Role: worker.",
  "- Never run `vs log` writes. Put your result (PASS/FAIL, what changed, refs) in your final message; a digest agent logs it for the lead.",
  "- Your final message is the report; never call built-in SendMessage or ListAgents; mid-task use `send` (VS MCP; `send_agent_prompt` on the Paseo MCP).",
  "- Report blockers to your lead in your final message. Do not edit lead-only docs or spawn successors.",
].join("\n");

export const BRAINSTORM_PACK = [
  "Role: brainstorm (the Brainstorm, head of a Team).",
  "- Read `docs/brainstorm/<lane>.md` before anything else. After every decision update it as a short diff (<5k tokens; sections: Who's here / Done when / Decided / Open / In flight). Keep `## Done when`; never edit `## Who's here` (VS writes it). The brief is the handoff: don't write dated docs/BRAINSTORM_HANDOFF_*.md files.",
  "- You may write `vs log decision \"...\"`, `vs log needs-you \"...\"`, `vs log handoff \"...\"`, and `vs log metric \"...\"` (240 chars max). Hand build work to a lead (if your lane has no live lead, you may spawn one — or several in parallel across lanes that have none); do not implement.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section. Every plan lists its blocks in a `| Block | Touches | Clashes with |` table (files/areas each touches, what it clashes with). Whenever designing parity or plugin-inspired features, record the original plugin/project creator in the plan, commits, `CREDITS.md`, and release notes using: \"Implemented <feature> — Thanks to <Plugin/Project> by <Author>\".",
  "- Never complete a Team yourself. When the lead reported PASS on the last plan block and nothing is Open, post: \"<Team> looks done. ✓ Mark complete · Not yet\" followed by a fenced block containing the single line `vs:looks-done` (VS offers `✓ Goal shipped` on standing teams and `✓ Mark complete` on disposable teams). Only the user's click completes a Team.",
  "- At >=80k tokens, update the brief now. At the hard limit VS retires you; the next click on the pin starts a fresh Brainstorm from the brief.",
  "- If the user raises something that belongs to another Team, offer: \"That sounds like <Team>. Send it there?\" followed by a fenced block: line 1 `vs:send-to <lane-id>`, then the idea text (VS shows a one-click Send button). Unrelated loose ideas: `vs inbox add \"<idea>\"` (or the UI's `Park in Inbox`) and reply \"parked N ideas → Inbox\".",
  "- \"I just thought of X\" / \"spin up a Brainstorm for X\" is a new-pin request: run `vs pin new \"<short name>\" --brief \"<X in 1-3 lines>\"` (same Squad by default). It refuses when X overlaps an existing Team and names it: offer that Team instead. For work in flight that isn't a Team yet, check `vs who brainstorm` / `vs log --since-me` first. Don't spawn the Brainstorm; the first click on the new pin starts it.",
].join("\n");

/** Appended to the Buddy pack only for the Squad's hub Buddy (RiffBot; isHubLane contract). Team Buddies never get it. */
export const HUB_BUDDY_RULES = [
  "Hub rules (OVERRIDE feature-Buddy rules above):",
  "- You are this Squad's hub (RiffBot). You ONLY sort, split into parallel lanes, and coordinate lane convergence; Team Buddies do all feature design and plan writing.",
  "- Never write `docs/PLAN_*.md` files, never design implementation blocks, never mark the hub done, and never spawn a Lead.",
  "- End **every** reply with `Open threads:` listing ideas that have no Team yet (or `none`). Keep `## Unsplit threads` in the brief in sync.",
  "- As soon as a thread can be worked on its own (its files and decisions don't overlap another thread or an in-flight Team), say how many parallel lanes we can run and propose them in a `vs:spin-off` block. Don't wait for details to be figured out — confirming the `vs:spin-off` block spins up each lane's Brainstorm Buddy to design it in parallel. When you merge or hold back an idea, give the reason in one line. Never spin off without the user's confirmation.",
  "- Propose spin-offs as one fenced block, line 1 ```vs:spin-off, then one Team per line: `Name | 1-line brief`. The user edits in words (4 proposed, \"energy and food in one lane called Needs\" → re-post the block with 3); only the newest block gets the button.",
  "- If the user keeps riffing on a thread that already has a Team, redirect: \"That's <Team>'s. Send it there?\" plus `vs:send-to`.",
  "- Lane convergence & merge: watch `## Teams` and `vs log --since-me` for lanes that need to work together (e.g. UI + Art touching the same screen/contract). To sync two active lanes without merging, log `vs log decision \"Sync @<laneA> + @<laneB>: <shared contract>\"` and route the contract via `vs:send-to <lane-id>`. When two lanes should combine into one, run `vs pin merge <from-lane> <into-lane>` after user confirmation to fold `<from-lane>`'s brief/decisions into `<into-lane>` and mark `<from-lane>` done.",
  "- On boot, read `## Teams` and `## Unsplit threads`. Your first message is the Squad status in ≤6 lines, plus the top parallel split you'd propose now.",
  "- Never mark the hub done. Never spawn a Lead.",
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
  "- Title each worker `<your Code><your ord> · <job>` (e.g. `Hub5 · drop files`) and label it `job=<job>` and `ord=<your ord>`, so its title matches the generated one. Spawn workers with `spawn_worker` (VS MCP: `title`, `profile`, `prompt`, `cwd`, `labels` `{job, ord}`; the profile supplies provider/model/mode). On the Paseo MCP use `create_agent` and pass `provider`, `model`, `mode` and the `profile` label, with no `features` (the plugin adds provider feature defaults).",
  "- When a plan block passes (PASS) or the whole plan is complete, add that line under `## In flight` in `docs/brainstorm/<lane>.md` so the Brainstorm can spot \"looks done\". Touch nothing else in the brief.",
  "- Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k. Run `vs handoff` and fill the Judgment section.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section. Whenever designing, committing, or releasing parity/plugin-inspired features, record the original plugin/project creator in plans, commits, `CREDITS.md`, and release notes using: \"Implemented <feature> — Thanks to <Plugin/Project> by <Author>\".",
  "- \"Spin up a buddy (for X)\" / \"spin up another buddy\" / \"get me a buddy for X\": spawn a new Buddy (role=brainstorm, title <Code> Buddy · <topic X>, Code = the new lane's short code) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).",
  "- Write JSON files with node (e.g. fs.writeFileSync(..., 'utf8')), never PowerShell Set-Content (which writes a UTF-8 BOM that breaks JSON parsers).",
  "- Plans carry a parallel table (block | touches | clashes with); run non-clashing blocks at the same time by default; say why in one line when you don't.",
  "- Only one full `npm test` runs at a time machine-wide (the wrapper refuses a second): workers run only the tests for their own files; the lead hands out the full-suite slot.",
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
  lanes?: { id: string; hub?: boolean; aliases?: string[] }[];
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
  "Art - Gemini": "Art Director - Gemini",
  "Art - Opus": "Art Painter - Opus",
  "Builder - Gemini": "Lead - Gemini",
  "Reviewer - Gemini": "Review - Gemini",
  Lead: "Lead - Claude",
  Brainstorm: "Brainstorm - Claude",
  Buddy: "Brainstorm - Claude",
  RiffBot: "Brainstorm - Claude",
  Worker: "Implement - Sonnet",
  Coder: "Work Order - DSP",
  Reviewer: "Review - Gemini",
  Fast: "Pre-check - Flash",
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
  profiles?: StoredProfile[],
): ProfileMatch | null {
  const customProfilesPassed = profiles !== undefined;
  const list = profiles ?? loadStoredProfiles();
  if (!list.length && customProfilesPassed) return null;
  const rawHint = (profileHint ?? "").trim();
  const mappedHint = LEGACY_ALIASES[rawHint] || rawHint;
  if (mappedHint) {
    const exact = list.find((p) => p.name === mappedHint || p.name.toLowerCase() === mappedHint.toLowerCase() || (p.id && p.id === mappedHint));
    if (exact) return { profile: exact, explicit: true };
    if (!customProfilesPassed && !process.env.VIBESQUAD_PROFILES_PATH) {
      const fallback = (DEFAULT_PACK_PROFILES as any[]).find(
        (p) => p.name === mappedHint || p.name.toLowerCase() === mappedHint.toLowerCase() || (p.id && p.id === mappedHint),
      );
      if (fallback) return { profile: { ...fallback, role: deriveRole(fallback.name, fallback.role) }, explicit: true };
    }
  }
  if (!list.length) return null;
  const fuzzy = (profile: StoredProfile | undefined) => (profile ? { profile, explicit: false } : null);
  const cleanTitle = (title ?? "").trim();
  if (cleanTitle) {
    const byTitle = list.find((p) => cleanTitle.toLowerCase().startsWith(p.name.toLowerCase()));
    if (byTitle) return fuzzy(byTitle);
  }
  const isAgy = (provider ?? "").startsWith("antigravity");
  if (role === "lead") {
    const want = isAgy ? "Lead - Gemini" : "Lead - Claude";
    return fuzzy(list.find((p) => p.name === want));
  }
  if (role === "brainstorm") {
    const want = isAgy ? "Brainstorm - Gemini" : "Brainstorm - Claude";
    return fuzzy(list.find((p) => p.name === want));
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

/** Plugin-side mirror of isHubLane (src/teams.ts): lane `hub: true`, else the lane whose id is the Squad id when no lane is flagged. */
export function isHubCwd(team: TeamDef | undefined, laneId: string | undefined): boolean {
  const lanes = team?.lanes ?? [];
  const lane = lanes.find((l) => l.id === laneId);
  return Boolean(team && lane && (lane.hub === true || (!lanes.some((l) => l.hub === true) && lane.id === team.id)));
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
    lane: resolved.isOrphan ? (safeLabels.lane || safeLabels.lead || "").trim() : keptLaneOf(resolved),
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

/** The live role a retired agent used to hold: a former Buddy maps to brainstorm, every other retired role to lead. */
export function retiredHolderRole(target: { labels?: Labels } | null | undefined): "lead" | "brainstorm" {
  return String(target?.labels?.role ?? "").trim().toLowerCase() === "former-brainstorm" ? "brainstorm" : "lead";
}

/**
 * Paseo wraps an agent-to-agent send (MCP send_agent_prompt / paseo send) in a
 * `<paseo-system kind="agent-message" source-agent-id=...>` envelope. Returns the sender and body,
 * or null for anything else (the user typing, plugin wakeups, handoff prompts).
 */
export function parseAgentMessageEnvelope(
  text: string | null | undefined,
): { senderId: string; senderTitle: string; messageId: string; body: string } | null {
  const m = /<paseo-system\b([^>]*)>([\s\S]*?)(?:<\/paseo-system>|$)/.exec(String(text ?? ""));
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
  if (attrs.kind !== "agent-message" || !attrs["source-agent-id"]) return null;
  const decode = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  return {
    senderId: decode(attrs["source-agent-id"]),
    senderTitle: decode(attrs["source-agent-title"] ?? ""),
    messageId: decode(attrs["message-id"] ?? ""),
    body: decode(m[2]!.trim()),
  };
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


/** Per-step timer for the `hook-timing` metric (docs/research/feel-baseline-2026-11.md). Timers only; never throws. */
export interface StepTimer {
  /** Record the ms elapsed since the previous mark (or start) under `name`. */
  mark(name: string): void;
  total(): number;
  summary(): string;
  steps: Array<[string, number]>;
}
export function stepTimer(): StepTimer {
  const t0 = Date.now();
  let last = t0;
  const steps: Array<[string, number]> = [];
  return {
    steps,
    mark(name) {
      const now = Date.now();
      steps.push([name, now - last]);
      last = now;
    },
    total: () => Date.now() - t0,
    summary() {
      // Total first and 0ms steps dropped: the team-log line is capped at MAX_TEXT chars.
      return `total=${Date.now() - t0} ` + steps.filter(([, ms]) => ms > 0).map(([n, ms]) => `${n}=${ms}`).join(" ");
    },
  };
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

export function rolePack(role: string, cwd: string, vibeMode = false, isHub = false): string {
  if (role === "lead") {
    try {
      const text = fs.readFileSync(path.join(findProjectRoot(cwd), "docs", "LEAD_RULES.md"), "utf8").trim();
      if (text) return text;
    } catch {
      // fall through
    }
    return LEAD_FALLBACK_PACK;
  }
  if (role === "brainstorm") return [BRAINSTORM_PACK, vibeMode && VIBE_MODE_BUDDY_RULES, isHub && HUB_BUDDY_RULES].filter(Boolean).join("\n");
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
    defangPromptFences(text.slice(0, MAX_BRIEF_CHARS)),
    `--- END docs/brainstorm/${lane}.md ---`,
  ].join("\n");
}

/** The safe-slug used for `docs/lanes/<lane>/` artifact folders (SPEC.md + TASKS.json). */
export function laneArtifactSlug(lane: string): string {
  return String(lane ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The durable lane artifact as a prompt block (SPEC.md + a TASKS.json summary), or ""
 * when the lane has neither file. Unlike a Buddy brief, this survives provider switches
 * and restarts, so every spawn (brainstorm/lead/worker) re-reads the same source of truth.
 */
export function laneArtifactBlock(root: string, lane: string): string {
  const safeLane = laneArtifactSlug(lane);
  if (!safeLane) return "";
  const dir = path.join(root, "docs", "lanes", safeLane);
  let spec = "";
  let tasks = "";
  try {
    spec = fs.readFileSync(path.join(dir, "SPEC.md"), "utf8").trim();
  } catch {
    /* no SPEC.md */
  }
  try {
    tasks = fs.readFileSync(path.join(dir, "TASKS.json"), "utf8").trim();
  } catch {
    /* no TASKS.json */
  }
  if (!spec && !tasks) return "";
  const parts = [
    `<!-- vibesquad:lane-artifact:begin lane=${safeLane} -->`,
    `Lane Artifact (docs/lanes/${safeLane}/ — durable source of truth across restarts & provider switches):`,
  ];
  if (spec) {
    parts.push(`\n## SPEC.md (docs/lanes/${safeLane}/SPEC.md)\n${defangPromptFences(spec.slice(0, MAX_BRIEF_CHARS))}`);
  }
  if (tasks) {
    parts.push(`\n## TASKS.json (docs/lanes/${safeLane}/TASKS.json)\n${defangPromptFences(tasks.slice(0, MAX_BRIEF_CHARS))}`);
  }
  parts.push(`<!-- vibesquad:lane-artifact:end -->`);
  return parts.join("\n");
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
  // An empty read is a writer mid-truncate, not an empty brief: appending to it would wipe the brief.
  if (!before.trim()) return "missing";
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
  writeBriefFile(file, lane, after);
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

export function injectedPrefix(role: string, cwd: string, vibeMode = false, isHub = false): string {
  return [EVERYONE_LAYER, rolePack(role, cwd, vibeMode, isHub)].filter(Boolean).join("\n\n");
}

/** Async so the daemon event loop is never blocked: git runs in child processes, the common case needs one. */
export async function inspectGitSpawnState(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  let resolved = "";
  try {
    resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved)) return null;
  } catch {
    return null;
  }

  const runGit = (args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      try {
        execFile(
          "git",
          ["--no-optional-locks", ...args],
          { cwd: resolved, encoding: "utf8", timeout: 3000, windowsHide: true },
          (err, stdout) => resolve(err ? null : String(stdout ?? "")),
        );
      } catch {
        resolve(null);
      }
    });

  // One process in the common case: --branch carries head + upstream ahead/behind, the entries are the dirty count.
  // (Windows pays ~250 ms of synchronous CreateProcess per spawn, so one spawn beats four parallel ones.)
  const statusOut = await runGit(["status", "--porcelain=v2", "--branch", "-uno"]);
  if (statusOut === null) return null;
  let branch = "HEAD";
  let upstreamAb: string | null = null;
  let dirty = 0;
  for (const line of statusOut.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head : "HEAD";
    } else if (line.startsWith("# branch.ab ")) {
      const m = /^# branch.ab \+(\d+) -(\d+)\s*$/.exec(line);
      if (m) upstreamAb = `${m[2]} ${m[1]}`;
    } else if (line.trim().length > 0 && !line.startsWith("#")) {
      dirty++;
    }
  }

  // No upstream: same fallback chain as before (origin/<branch>, then origin/HEAD), tried in parallel, first win kept.
  let revOut = upstreamAb;
  if (revOut === null) {
    const [byBranch, byHead] = await Promise.all([
      runGit(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]),
      runGit(["rev-list", "--left-right", "--count", "origin/HEAD...HEAD"]),
    ]);
    revOut = byBranch ?? byHead;
  }
  let behind = 0;
  let ahead = 0;
  if (revOut) {
    const [bRaw, aRaw] = revOut.trim().split(/\s+/);
    behind = Number.isFinite(Number(bRaw)) ? Number(bRaw) : 0;
    ahead = Number.isFinite(Number(aRaw)) ? Number(aRaw) : 0;
  }

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
  /** Min quiet window after a Lead turn during which wakeups are deferred/coalesced. */
  leadWakeCooldownMs?: number;
  /** Root holding docs/brainstorm/<lane>.md briefs (defaults to the VibeSquad repo). */
  briefRoot?: string;
  /** Grace before a retired Buddy is archived, so an in-flight turn is not killed mid-stream. */
  brainstormArchiveGraceMs?: number;
  /** Post-spawn profile fix: the plugin SDK has no model/mode/thinking setters, so this goes via the daemon client. */
  applyAgentSettings?(agentId: string, patch: AgentSettingsPatch): Promise<void>;
  /** Stop and archive an agent that must not run (e.g. wrong provider for its explicit profile). */
  refuseAgent?(agentId: string): Promise<void>;
  /** Delay after agent.created before checking whether an idle 0-token agent needs its initial prompt redelivered. */
  firstPromptRedeliverMs?: number;
  /** Provider usage snapshot (array or () => array) used to fail over capped providers before spawn. */
  usageProviders?: any[] | (() => any[]);
  /** Capped-provider map/array (tests inject this to avoid touching ~/.vibesquad/capped-providers.json). */
  cappedProviders?: any;
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

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// In-process daemon client (a websocket call, same updateAgent the `paseo agent update` CLI makes) instead of a
// whole CLI process per label write (median 4 s, max 9 s).
export function daemonSetLabels(agentId: string, labels: Labels, name?: string): Promise<void> {
  if (!AGENT_ID_RE.test(agentId)) return Promise.reject(new Error("invalid agent id"));
  return withDaemonClient((client) => client.updateAgent(agentId, { ...(name ? { name } : {}), labels }));
}

export function daemonArchive(agentId: string): Promise<void> {
  if (!AGENT_ID_RE.test(agentId)) return Promise.reject(new Error("invalid agent id"));
  return withDaemonClient(async (client) => {
    await client.archiveAgent(agentId);
  });
}

const DEFAULT_DEPS: Deps = {
  setLabels: daemonSetLabels,
  archiveAgent: daemonArchive,
  applyAgentSettings: daemonApplyAgentSettings,
  refuseAgent: daemonRefuseAgent,
  debounceMs: 3000,
  retryBaseMs: 5000,
  watchIntervalMs: 1500,
  startWatcher: true,
  leadWakeCooldownMs: 3000,
  brainstormArchiveGraceMs: 120_000,
  firstPromptRedeliverMs: 30_000,
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
  // The runner hook host (server/backend/runner-hooks.mjs) runs inside MCP stdio servers, where stdout is the protocol channel.
  (process.env.VS_PLUGIN_LOG === "stderr" ? console.error : console.log)(`[vibesquad] ${message}`);
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
    const pendingInitialPrompts: { id?: string; title: string; cwd: string; prompt: string; at: number }[] = [];
    const initialPromptsById = new Map<string, string>();
    const turnSeen = new Set<string>();
    const firstPromptRedelivered = new Set<string>();
    const firstPromptTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const markTurnSeen = (agentId: string | null | undefined) => {
      const id = String(agentId ?? "").trim();
      if (!id) return;
      turnSeen.add(id);
      const t = firstPromptTimers.get(id);
      if (t) {
        firstPromptTimers.delete(id);
        clearTimeout(t);
        timers.delete(t);
      }
    };

    // R2-1 remote proxy RPC (vs.http). Gated off by default; see server/remote-proxy.ts.
    if (typeof server.handle === "function") server.handle(vsHttp, makeVsHttpHandler());
    const digested = new Set<string>();
    const retries = new Map<string, number>();
    const offsets = new Map<string, number>();
    const misrouteCounts = new Map<string, number>();
    const relayCounts = new Map<string, number>();
    const forwardedFromRetired = new Set<string>(); // `${retiredId}:${messageId}` already redirected
    const pendingWake = new Map<string, LogEntry[]>(); // lead id -> entries awaiting a wake
    const lastWakeAt = new Map<string, number>(); // lead id -> last wake sent / turn_started timestamp (ms)
    const deferredWakeTimers = new Map<string, ReturnType<typeof setTimeout>>(); // lead id -> pending wake re-check timer
    const flushingLeads = new Set<string>(); // lead ids with an in-flight flushWake
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

    const labelsFor = async (paseo: Paseo, agent: { id: string; title: string | null; labels?: Labels }) => {
      const s = await snap(paseo, agent.id);
      if (s) return { snap: s, labels: s.labels ?? {}, fromPayload: false };
      // The refresh failed (daemon / runner hiccup): the event payload still carries the agent's own labels. Using {} here would
      // read a lead as a worker and let the label writes below downgrade it.
      const p = agent as any;
      return { snap: p?.labels ? ({ ...p, labels: p.labels } as AgentSnap) : null, labels: (p?.labels ?? {}) as Labels, fromPayload: true };
    };

    const teamOf = (labels: Labels, cwd?: string): { team: string; lane: string } | null => {
      const derived = deriveTeamForSpawn(labels, cwd, currentTeams());
      if (derived.team) return { team: teamIdOf(derived.team, currentTeams()), lane: derived.lane || derived.team };
      if (labels.team) return { team: teamIdOf(labels.team, currentTeams()), lane: labels.lane || resolveByCwd(cwd, currentTeams())?.lane || "" };
      return resolveByCwd(cwd, currentTeams());
    };

    const recentBeforeMismatches = new Map<string, number>();
    const beforeConfiguredSpawns = new Map<string, number>();

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
        provider: s.provider ?? agent.provider ?? s.config?.provider,
        model: s.model ?? agent.model ?? s.config?.model ?? null,
        modeId: s.currentModeId ?? s.modeId ?? agent.currentModeId ?? agent.modeId ?? s.config?.modeId ?? null,
        thinkingOptionId: s.thinkingOptionId ?? agent.thinkingOptionId ?? s.config?.thinkingOptionId ?? null,
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
        for (const d of diffs.filter((x) => x.caller && fresh(x) && labels["vs.spawn-configured"] !== "1")) {
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
      const now = Date.now();
      for (const [k, ts] of beforeConfiguredSpawns) {
        if (now - ts >= 30_000) beforeConfiguredSpawns.delete(k);
      }
      const spawnKey = `${agent.title ?? ""}::${cwd}`;
      const configuredByBefore =
        labels["vs.spawn-configured"] === "1" || // runner spawns: before() ran in the caller's process, so the maps below are empty here
        (agent.id && beforeConfiguredSpawns.has(agent.id)) || beforeConfiguredSpawns.has(spawnKey);
      if (agent.id) beforeConfiguredSpawns.delete(agent.id);
      beforeConfiguredSpawns.delete(spawnKey);
      const isRunning = (s.status ?? agent.status) === "running" || (s.status ?? agent.status) === "initializing";
      if (configuredByBefore || isRunning) {
        return;
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

    /**
     * Normalize a capped-provider source (array of families, `{ providers: [...] }`, or a
     * `{ family: value }` map) into `{ normalizedFamily: value }`. Unknown keys are dropped.
     */
    const normalizeCappedProviders = (raw: any): Record<string, any> => {
      if (Array.isArray(raw)) {
        const out: Record<string, any> = {};
        for (const item of raw) {
          const fam = normalizeProviderFamily(
            typeof item === "string" ? item : item?.id ?? item?.provider ?? item?.name,
          );
          if (fam) out[fam] = item && typeof item === "object" ? item : { capped: true };
        }
        return out;
      }
      if (raw && typeof raw === "object") {
        if (Array.isArray(raw.providers)) return normalizeCappedProviders(raw.providers);
        if (raw.capped && typeof raw.capped === "object" && !Array.isArray(raw.capped)) {
          return normalizeCappedProviders(raw.capped);
        }
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
          const fam = normalizeProviderFamily(k);
          if (fam) out[fam] = v ?? { capped: true };
        }
        return out;
      }
      return {};
    };

    /**
     * Capped providers keyed by normalized family. Sources, in order: deps.cappedProviders
     * (tests), VIBESQUAD_CAPPED_PROVIDERS_PATH, then ~/.vibesquad/capped-providers.json. An
     * empty map means no provider is capped, so spawns are left alone when nothing declares one.
     */
    const readCappedProviderMap = (): Record<string, any> => {
      if (deps.cappedProviders !== undefined && deps.cappedProviders !== null) {
        return normalizeCappedProviders(deps.cappedProviders);
      }
      const file = process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH
        ? path.resolve(process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH)
        : path.join(baseDir(), "capped-providers.json");
      if (!fs.existsSync(file)) return {};
      try {
        return normalizeCappedProviders(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        return {};
      }
    };

    // ---- Hook 1: before agent.create ---------------------------------------

    stops.push(
      server.before("agent.create", async (ctx: { request: any }) => {
        const t0 = Date.now();
        const st = stepTimer() as StepTimer & { team?: string; lane?: string };
        try {
          return await beforeAgentCreate(ctx, st);
        } finally {
          log(`spawn-timing hook=${Date.now() - t0}ms`);
          const text = `hook-timing hook=before.agent.create ${st.summary()}`;
          setImmediate(() => {
            try {
              log(text);
              appendLog(st.team || UNASSIGNED_TEAM_ID, { agent: "plugin", lane: st.lane || "unassigned", type: "metric", text });
            } catch {
              /* timers must never break a spawn */
            }
          });
        }
      }),
    );
    const beforeAgentCreate = async ({ request }: { request: any }, st: StepTimer & { team?: string; lane?: string }) => {
        const config: any = request.config ?? {};
        const env = (request as any).env as Record<string, string> | undefined;
        const rawReqLabels = ((request as any).labels ?? config?.labels) as Labels | undefined;
        const callerLane = String(rawReqLabels?.lane || rawReqLabels?.lead || "").trim(); // legacy `lead` label = lane; // before identity resolution rewrites it from cwd
        const reqLabels: Labels = { ...(rawReqLabels ?? {}) };
        const rawRole = (reqLabels.role || config?.role || env?.VS_ROLE || "").trim().toLowerCase();
        const title: string = config?.title ?? (request as any).title ?? (request as any).name ?? "";
        const cwd: string = config?.cwd ?? (request as any).cwd ?? "";
        const provider: string = config?.provider ?? (request as any).provider ?? "";
        const initialPrompt = String(
          (request as any).prompt ??
            (request as any).initialPrompt ??
            config?.prompt ??
            config?.initialPrompt ??
            "",
        ).trim();
        const reqAgentId = String((request as any).id ?? config?.id ?? "").trim();
        if (initialPrompt) {
          if (reqAgentId) initialPromptsById.set(reqAgentId, initialPrompt);
          pendingInitialPrompts.push({ id: reqAgentId || undefined, title, cwd, prompt: initialPrompt, at: Date.now() });
          while (pendingInitialPrompts.length > 100) pendingInitialPrompts.shift();
        }
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

        // MCP create_agent sends no labels and no env.VS_ROLE: infer the role from the
        // documented title convention (★ … → lead; BRAINSTORM · / <Code> Buddy / RiffBot →
        // brainstorm). Archived/demoted "(old)" titles resolve to no title role.
        const titleRole = /^\s*\(old\)/i.test(title)
          ? ""
          : /^\s*★\s/u.test(title)
            ? "lead"
            : /^\s*(?:brainstorm\s*·|riffbot\b|[a-z0-9_-]{2,8}\s+buddy\b)/i.test(title)
              ? "brainstorm"
              : "";

        // Paseo hands this hook only { config, env }: spawn labels never arrive here, so
        // VibeSquad's own spawn paths also pass env VS_PROFILE. Label-only spawns are
        // corrected in agent.created instead.
        const profileHint = config.profile || reqLabels.profile || env?.VS_PROFILE;
        let profileMatch = matchStoredProfile(profileHint, provider, title, explicitRole || titleRole || "worker");
        let matchedProfile = profileMatch?.profile ?? null;

        st.mark("match-profile");
        // Remember whether the caller explicitly named the profile BEFORE any failover, so a
        // fuzzy (role/title/cwd) match can never be promoted to an explicit match and silently
        // overwrite the caller's provider/model. An explicit profile owns the provider choice;
        // a fuzzy match only infers a default and must not clobber the caller's selection.
        const wasExplicit = Boolean(profileMatch?.explicit);

        // Auto-failover: when the matched profile's provider is over quota or capped, switch
        // to its healthy counterpart before the session is created. Only when usage/capped
        // data is actually present (tests or on-disk), so normal spawns are unaffected.
        const usageList: any[] = [
          ...(typeof deps.usageProviders === "function"
            ? deps.usageProviders()
            : Array.isArray(deps.usageProviders)
              ? deps.usageProviders
              : []),
        ];
        for (const family of Object.keys(readCappedProviderMap())) {
          usageList.push({ id: family, status: "exhausted", usedPct: 100 });
        }
        if (usageList.length > 0 && matchedProfile) {
          // Only fail over a fuzzy match when the caller is actually on the matched profile's
          // provider (or left the provider blank). A role/title/cwd inference that picked a
          // default profile must never drag the caller onto another provider, e.g. a fuzzy
          // "Lead - Claude" match failing over to Gemini and overwriting a caller-chosen
          // `codex`/`opencode` provider+model. Explicit profiles always fail over.
          const callerPm = splitProviderModel(config.provider, config.model);
          const matchedPm = splitProviderModel(matchedProfile.provider, matchedProfile.model);
          const fuzzyOnCallerProvider = !callerPm.provider || callerPm.provider === matchedPm.provider;
          if (wasExplicit || fuzzyOnCallerProvider) {
            const fo = resolveProfileWithFailover(matchedProfile, loadStoredProfiles(), usageList);
            if (fo.failedOver && fo.profile) {
              matchedProfile = fo.profile;
              // Preserve explicitness: a fuzzy match stays fuzzy so the caller's provider/model
              // are never clobbered by the explicit-profile override below.
              profileMatch = { profile: fo.profile, explicit: wasExplicit };
              if (nextReqLabels?.profile) nextReqLabels.profile = fo.profile.name;
              reqLabels.profile = fo.profile.name;
              log(`profile-failover: ${fo.fromProfile}->${fo.toProfile} reason=${fo.reason}`);
            }
          }
        }

        if (String(profileHint ?? "").trim() && !profileMatch?.explicit) {
          log(`profile "${profileHint}" named by spawn "${title}" is not in profiles.json; caller settings kept`);
        }

        const role = explicitRole || matchedProfile?.role || titleRole || "worker";

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

        st.mark("resolve-identity-labels");
        const keepCaller = Boolean(String(reqLabels["profile-override"] || env?.VS_PROFILE_OVERRIDE || "").trim());
        if (matchedProfile && profileMatch?.explicit && !keepCaller) {
          const now = Date.now();
          for (const [k, ts] of beforeConfiguredSpawns) {
            if (now - ts >= 30_000) beforeConfiguredSpawns.delete(k);
          }
          beforeConfiguredSpawns.set(`${title}::${cwd}`, now);
          if (reqAgentId) beforeConfiguredSpawns.set(reqAgentId, now);
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

        const explicitLane = (reqLabels.orphan === "1" ? "" : callerLane || env?.VS_LANE || "").trim();
        const envOrReqLabels: Labels = {
          ...(env?.VS_TEAM ? { team: env.VS_TEAM } : {}),
          ...(explicitLane ? { lane: explicitLane } : {}),
          ...reqLabels,
        };
        const spawnLoc = teamOf(envOrReqLabels, cwd);
        const spawnTeamId = spawnLoc?.team;
        const spawnTeam =
          (explicitLane ? findLaneInRegistry(explicitLane, currentTeams())?.team : undefined) ??
          (spawnTeamId ? currentTeams().find((t) => t.id === spawnTeamId) : undefined);
        const vibeMode = spawnTeam?.vibeMode === true;
        const isHubBuddy =
          role === "brainstorm" && !topicOf(reqLabels) && Boolean(explicitLane) && isHubCwd(spawnTeam, explicitLane);
        st.team = spawnTeamId;
        st.lane = explicitLane;
        const prefix = injectedPrefix(role, cwd, vibeMode, isHubBuddy);
        const profileNotes = isHubBuddy ? "" : dedupeNotesAgainst((matchedProfile?.notes ?? "").trim(), prefix);
        const gitState = await inspectGitSpawnState(cwd);
        st.mark("git-spawn-state");
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
          const where = teamOf(envOrReqLabels, cwd);
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

        st.mark("layer-prompt");
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

        st.mark("lane-brief");
        // Durable lane artifacts (docs/lanes/<lane>/SPEC.md + TASKS.json) ride along on every
        // spawn — brainstorm, lead and worker alike — so provider switches and restarts never
        // lose the lane's source of truth.
        const artifactLane = (reqLabels.orphan === "1" ? "" : callerLane || env?.VS_LANE || spawnLoc?.lane || "").trim();
        if (artifactLane) {
          const currentSys = String(next.systemPrompt ?? sanitizedSysPrompt ?? "");
          const artMarker = "<!-- vibesquad:lane-artifact:begin lane=";
          if (!currentSys.includes(artMarker)) {
            const briefRoot = deps.briefRoot ?? briefRootFor(reqLabels.team || env?.VS_TEAM || spawnTeamId || "", artifactLane, REPO_ROOT);
            const artBlock = laneArtifactBlock(briefRoot, artifactLane);
            if (artBlock) {
              next.systemPrompt = [currentSys.trim(), artBlock].filter(Boolean).join("\n\n");
              changed = true;
            }
          }
        }

        st.mark("lane-artifacts");
        if (leanApplies(next.provider ?? provider, env)) {
          next.providerOptions = leanProviderOptions(next.providerOptions, role);
          changed = true;
        }

        // Turn-1 `vs` CLI commands need the role/lane/team in env immediately, before the
        // agent exists (agent.created runs later). Propagate only what isn't already set.
        const nextEnv: Record<string, string> = { ...(env ?? {}) };
        let envChanged = false;
        if (role && !nextEnv.VS_ROLE) {
          nextEnv.VS_ROLE = role;
          envChanged = true;
        }
        if (spawnTeamId && !nextEnv.VS_TEAM) {
          nextEnv.VS_TEAM = spawnTeamId;
          envChanged = true;
        }
        if (explicitLane && !nextEnv.VS_LANE) {
          nextEnv.VS_LANE = explicitLane;
          envChanged = true;
        }
        if (envChanged) changed = true;

        return changed
          ? {
              ...request,
              ...(nextReqLabels && (request as any).labels ? { labels: nextReqLabels } : {}),
              config: next,
              ...(envChanged ? { env: nextEnv } : {}),
            }
          : undefined;
    };

    // ---- agent.created: auto-label, antigravity everyone-layer, first dispatch

    stops.push(
      server.on("agent.created", async ({ agent }: { agent: any }, { paseo }: { paseo: any }) => {
        paseoApi = paseo;
        const st = stepTimer();
        let timedTeam = "";
        let timedLane = "";
        try {
          const { snap: me, labels, fromPayload } = await labelsFor(paseo, agent);
          st.mark("labels-for");
          if (fromPayload && Object.keys(labels).length === 0) {
            log(`agent.created for ${agent?.id}: no labels from the refresh or the payload; skipping label writes`);
            return;
          }
          // Runner spawns: before(agent.create) already logged these metrics in the caller's process (the dedupe maps are not shared).
          const beforeRan = labels["vs.spawn-configured"] === "1";
          // Never let a wrong-provider agent go on to retire a predecessor or count as a dispatch.
          if ((await enforceProfileAfterSpawn(agent, me, labels)) === "refused") return;
          st.mark("enforce-profile");
          const parentId = agent.parentAgentId || labels["paseo.parent-agent-id"];
          const parent = parentId ? await snap(paseo, parentId) : null;
          st.mark("parent-snap");
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
              if (beforeRan || (prevTs && Date.now() - prevTs < 2000)) {
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
              if (beforeRan || (prevTs && Date.now() - prevTs < 2000)) {
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
              if (beforeRan || (prevTs && Date.now() - prevTs < 2000)) {
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
            if (beforeRan || (prevTs && Date.now() - prevTs < 2000)) {
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

          timedTeam = team;
          timedLane = lane;
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

          st.mark("lead-ord-scan");
          if (Object.keys(want).length > 0) {
            await deps.setLabels(agent.id, { ...labels, ...want }).catch((e) => log(`label failed: ${e}`));
          }
          st.mark("set-labels");

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

          st.mark("retire-predecessors");
          if (team && lane) await refreshLaneWhosHere(paseo, lane);
          st.mark("refresh-whos-here");

          // Block 2a: If a new agent had an initial prompt and stays idle with 0 tokens ~30 s after
          // creation without ever running, redeliver the initial prompt once and log first-prompt-redelivered.
          const aid = String(agent?.id ?? "").trim();
          const directPrompt = String(
            (agent as any)?.prompt ??
              (agent as any)?.initialPrompt ??
              (me as any)?.prompt ??
              (me as any)?.initialPrompt ??
              "",
          ).trim();
          let rememberedPrompt = directPrompt || (aid ? initialPromptsById.get(aid) ?? "" : "");
          if (!rememberedPrompt && aid) {
            const now = Date.now();
            const aTitle = String(agent.title ?? me?.title ?? "");
            let idx = pendingInitialPrompts.findIndex(
              (p) => now - p.at < 300_000 && p.title === aTitle && (!p.cwd || !agentCwd || p.cwd === agentCwd),
            );
            if (idx < 0) {
              idx = pendingInitialPrompts.findIndex(
                (p) => now - p.at < 300_000 && (!p.cwd || !agentCwd || p.cwd === agentCwd),
              );
            }
            if (idx >= 0) {
              rememberedPrompt = pendingInitialPrompts[idx]!.prompt;
              pendingInitialPrompts.splice(idx, 1);
            }
          }
          if (rememberedPrompt && aid) {
            initialPromptsById.set(aid, rememberedPrompt);
            if (!firstPromptTimers.has(aid) && !firstPromptRedelivered.has(aid) && !turnSeen.has(aid)) {
              const redeliverMs = Math.max(0, deps.firstPromptRedeliverMs ?? 30_000);
              const fallbackTeam = team ? teamIdOf(team, currentTeams()) : "";
              const fallbackLane = lane;
              const t = later(async () => {
                firstPromptTimers.delete(aid);
                if (firstPromptRedelivered.has(aid) || turnSeen.has(aid)) return;
                const cur: any = await snap(paseo, aid);
                if (!cur || cur.archivedAt || cur.status !== "idle") return;
                const usedTokens =
                  (cur.lastUsage?.contextWindowUsedTokens ?? 0) + (cur.lastUsage?.inputTokens ?? 0);
                if (usedTokens > 0 || cur.lastUserMessageAt || turnSeen.has(aid) || firstPromptRedelivered.has(aid)) {
                  return;
                }
                const tl = await paseo.agents
                  .ref(aid)
                  .timeline?.refetch?.({ direction: "tail", limit: 5 })
                  .catch(() => null);
                if ((tl?.entries ?? []).length > 0) return;
                if (firstPromptRedelivered.has(aid) || turnSeen.has(aid)) return;
                firstPromptRedelivered.add(aid);
                try {
                  await paseo.agents.ref(aid).send(rememberedPrompt);
                  const where =
                    teamOf(cur.labels ?? {}, cur.cwd ?? agentCwd) ??
                    (fallbackTeam ? { team: fallbackTeam, lane: fallbackLane || fallbackTeam } : null);
                  const text = `first-prompt-redelivered: agent=${aid}`;
                  log(text);
                  if (where) {
                    appendLog(where.team, {
                      agent: "plugin",
                      lane: where.lane,
                      type: "metric",
                      text,
                      refs: [aid],
                    });
                  }
                } catch (err) {
                  log(`first-prompt redeliver failed for ${aid}: ${err}`);
                }
              }, redeliverMs);
              firstPromptTimers.set(aid, t);
            }
          }

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
          st.mark("first-dispatch-metric");
        } catch (err) {
          log(`agent.created handler failed: ${err}`);
        } finally {
          const text = `hook-timing hook=agent.created ${st.summary()}`;
          setImmediate(() => {
            try {
              log(text);
              appendLog(timedTeam ? teamIdOf(timedTeam, currentTeams()) : UNASSIGNED_TEAM_ID, {
                agent: "plugin",
                lane: timedLane || "unassigned",
                type: "metric",
                text,
                refs: agent?.id ? [agent.id] : [],
              });
            } catch {
              /* timers must never break the handler */
            }
          });
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
          markTurnSeen(agent?.id);
          try {
            if (outcome.kind === "failed") {
              const { snap: me, labels } = await labelsFor(paseo, agent);
              if (!isDigestAgent(labels) && effectiveAgentRole({ labels }) === "lead") {
                const handoffRes = await checkLeadTokens(paseo, agent.id, me, labels);
                if (handoffRes?.stage === "auto-250" || handoffRes?.stage === "hard-300") return;
                void flushWake(paseo, agent.id);
              }
              return await handleFailure(paseo, agent, String(outcome.error?.message ?? ""));
            }
            if (outcome.kind !== "completed") {
              // Cancelled / other non-completed outcomes produce no digest, but a lead's
              // held wakeups should still flush now that its turn is over.
              const { labels } = await labelsFor(paseo, agent);
              if (!isDigestAgent(labels) && effectiveAgentRole({ labels }) === "lead") {
                void flushWake(paseo, agent.id);
              }
              return;
            }
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
              void flushWake(paseo, agent.id);
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
        String(worker.id).startsWith("rn-")
          ? `run \`vs status ${worker.id}\` (its last assistant message) and read any report it names. Do not modify files.`
          : `run \`paseo inspect ${worker.id}\` / read its last assistant message and any report it names. Do not modify files.`,
        `Then run exactly once:`,
        `vs log done "<PASS|FAIL>: <1-line summary, max 200 chars>" --digest --ref ${worker.id}`,
        `Use FAIL if the worker reported errors, failing tests, or did not finish. If its report states neither PASS nor FAIL, log nothing. Then stop.`,
      ].join("\n");

      const startedAt = Date.now();
      /** A [done] entry for this worker written since the digest started (by the digest agent). */
      const verdictLogged = () => {
        try {
          const lines = fs.readFileSync(logPath(teamIdOf(team, currentTeams())), "utf8").split(/\r?\n/).slice(-200);
          return lines.some((l) => {
            if (!l.trim()) return false;
            try {
              const e = JSON.parse(l) as LogEntry;
              return e.type === "done" && (e.refs ?? []).includes(worker.id) && Date.parse(e.ts) >= startedAt - 1000;
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      };
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
            // The digest ended its turn without logging a verdict (it errored in-turn or skipped the command).
            if (!verdictLogged()) return fallback("logged nothing");
          })
          .catch(() => fallback("errored"));
      } catch (err) {
        log(`digest spawn failed for ${worker.id}: ${err}`);
        await fallback("spawn failed");
      }
    }

    async function checkLeadTokens(_paseo: Paseo, id: string, me: AgentSnap | null, labels: Labels) {
      const leadSnap = me ? { ...me, id, labels: { ...(me.labels ?? {}), ...labels } } : { id, title: null, labels };
      return await handoffCoordinator.evaluateLead(leadSnap).catch((e: unknown) => {
        log(`lead handoff check failed: ${e}`);
        return null;
      });
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
      // A relay is routine (the old lead finishing up, or its children ending turns): its own
      // `relay-old` counter, so `misroute-old` counts only real sends to a retired agent.
      const dateStr = new Date().toISOString().slice(0, 10);
      const countKey = `${dateStr}:${where.team}`;
      const dailyCount = (relayCounts.get(countKey) ?? 0) + 1;
      relayCounts.set(countKey, dailyCount);
      appendLog(where.team, {
        agent: String(agent.id ?? "former-lead"),
        lane: where.lane,
        type: "metric",
        text: `relay-old: date=${dateStr} count=${dailyCount} target=${targetId}`,
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
        // Only agents created before the new one are its predecessors (a replayed `created` must not retire a later sibling).
        .filter((a) => {
          const mine = Date.parse((newSnap as any)?.createdAt ?? "");
          const theirs = Date.parse((a as any).createdAt ?? "");
          return !Number.isFinite(mine) || !Number.isFinite(theirs) || theirs <= mine;
        })
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

    async function findLead(paseo: Paseo, team: string, lane: string, role: "lead" | "brainstorm" = "lead"): Promise<AgentSnap | null> {
      const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
      const wantLane = (lane || "").toLowerCase();
      const leads = (res.entries as any[])
        .map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }) as AgentSnap)
        .filter((a) => !a.archivedAt && !a.internal && a.status !== "closed")
        .filter((a) => effectiveAgentRole(a) === role)
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
      const role = retiredHolderRole(target);
      const current = await findLead(paseo, team, rawLane || target.labels?.lane || target.labels?.lead || "", role);
      // The successor talking to its predecessor (handoff questions) is not a misroute.
      if (current && senderId && current.id === senderId) return undefined;

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

      const oldShort = extractLeadShortName(target);
      if (!current) {
        throw new Error(`${oldShort} is retired and no live ${role === "brainstorm" ? "Buddy" : "lead"} exists for ${team}/${lane}`);
      }
      const currentLead = current;
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

    // Paseo's before() only fires for agent.create / agent.session_open / workspace.create, so these
    // never see an MCP send_agent_prompt (kept in case a host adds them). The live redirect is the
    // agent.turn_started handler below, which fires on the retired agent itself.
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
          markTurnSeen(agent?.id);
          try {
            const me = await snap(paseo, agent.id);
            if (me && effectiveAgentRole(me) === "lead") lastWakeAt.set(agent.id, Date.now());
            if (!me || !isRetiredLeadSnap(me)) return;
            const page = await paseo.agents
              .ref(agent.id)
              .timeline?.refetch?.({ direction: "tail", limit: 10 })
              .catch(() => null);
            let lastUser: any = null;
            for (const entry of page?.entries ?? []) {
              const item = entry?.item ?? entry;
              if ((item?.type === "user_message" || item?.role === "user") && item?.text?.trim()) {
                lastUser = item;
              }
            }
            // Only another agent's send is a misroute: the user typing, plugin wakeups and handoff
            // prompts to a retiring lead stay with it.
            const msg = parseAgentMessageEnvelope(lastUser?.text);
            if (!msg || msg.senderId === agent.id) return;
            const key = `${agent.id}:${msg.messageId || lastUser.messageId || msg.body}`;
            if (forwardedFromRetired.has(key)) return;
            forwardedFromRetired.add(key);
            const from = msg.senderTitle ? `${msg.senderTitle} (${msg.senderId})` : msg.senderId;
            const prompt = `Forwarded by VibeSquad: ${from} sent this to retired ${extractLeadShortName(me)} (${me.id}).\n\n${msg.body}`;
            // Not awaited: a send can block for up to 60 s and the hook RPC times out first.
            void handleSendAgentPrompt({ agentId: agent.id, senderAgentId: msg.senderId, prompt }, { paseo }).catch(
              (e: any) => {
                log(`turn_started redirect failed: ${e}`);
                if (/ is retired and no live /.test(String(e?.message ?? ""))) {
                  paseo.agents.ref(msg.senderId).send(String(e.message)).catch(() => {});
                }
              },
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
          if (lead.status === "idle") void flushWake(paseo, lead.id);
        } catch (err) {
          log(`wake dispatch failed: ${err}`);
        }
      }
    }

    /** Clear a lead's pending re-check timer (so a fresh, possibly shorter delay can be set). */
    function clearWakeRecheck(leadId: string) {
      const t = deferredWakeTimers.get(leadId);
      if (t) {
        deferredWakeTimers.delete(leadId);
        clearTimeout(t);
        timers.delete(t);
      }
    }

    /** Schedule a single deferred re-check for a lead (cooldown or running-lead hold). */
    function scheduleWakeRecheck(paseo: Paseo, leadId: string, delay: number) {
      if (deferredWakeTimers.has(leadId)) return;
      const t = later(() => {
        deferredWakeTimers.delete(leadId);
        // recheck=true: the timer only fires once and never re-schedules on a still-running lead.
        void flushWake(paseo, leadId, true);
      }, delay);
      deferredWakeTimers.set(leadId, t);
    }

    async function flushWake(paseo: Paseo, leadId: string, recheck = false) {
      if (flushingLeads.has(leadId)) return;
      if (!pendingWake.get(leadId)?.length) return;
      flushingLeads.add(leadId);
      const cooldownMs = deps.leadWakeCooldownMs ?? 3000;
      let tookQueue = false;
      try {
        // A fresh flushWake invalidates any pending re-check timer so a shorter delay
        // (e.g. the lead just went idle) isn't blocked by a longer pending one.
        clearWakeRecheck(leadId);

        // Re-verify the Lead's live snapshot right before sending.
        const liveLead = await snap(paseo, leadId);
        // Shutting down: keep the queue, nothing more to do.
        if (lifetime.signal.aborted) return;
        // Vanished agent: keep the queue (never send on a null snapshot).
        if (!liveLead) return;

        // Archived/closed lead: discard its held wakeups (the lead is gone).
        if (liveLead.archivedAt || liveLead.status === "closed") {
          pendingWake.delete(leadId);
          lastWakeAt.delete(leadId);
          return;
        }

        // No longer a lead (e.g. retired): don't send to it; re-route its held wakeups
        // through the normal queueWake/dispatchWakes path to the current lead.
        if (effectiveAgentRole(liveLead) !== "lead") {
          const entries = pendingWake.get(leadId) ?? [];
          if (entries.length) {
            pendingWake.delete(leadId);
            lastWakeAt.delete(leadId);
            const where = teamOf(liveLead.labels, liveLead.cwd);
            if (where) {
              for (const entry of entries) queueWake(where.team, entry);
            }
          }
          return;
        }

        // Mid-turn: hold. At most one re-check per hold — turn_ended handles normal
        // completion, so a lead stuck in "running" is not snap()'d every cooldown forever.
        if (liveLead.status && liveLead.status !== "idle") {
          if (!recheck) scheduleWakeRecheck(paseo, leadId, cooldownMs);
          return;
        }

        // Coalesce/defer wakeups within the cooldown window of the last wake sent or
        // turn_started (the notifyOnFinish double-wake case). A normal post-turn flush
        // is NOT penalized: turn_ended does not update lastWakeAt.
        const elapsed = Date.now() - (lastWakeAt.get(leadId) ?? 0);
        if (elapsed < cooldownMs) {
          scheduleWakeRecheck(paseo, leadId, cooldownMs - elapsed);
          return;
        }
        const queue = pendingWake.get(leadId);
        if (!queue?.length) return;
        pendingWake.delete(leadId);
        tookQueue = true;
        const last = queue[queue.length - 1]!;
        const more = queue.length > 1 ? ` (+${queue.length - 1} more)` : "";
        const text = `New team log event in lane ${last.lane}: [${last.type}] ${last.text}${more}. Run 'vs log --since-me' if more context is needed.`;
        try {
          await paseo.agents.ref(leadId).send(text);
        } catch (e) {
          log(`wakeup send failed: ${e}`);
        }
        lastWakeAt.set(leadId, Date.now());
      } finally {
        flushingLeads.delete(leadId);
        // Entries queued while we awaited the send: flush them next.
        if (tookQueue && pendingWake.get(leadId)?.length) {
          void flushWake(paseo, leadId);
        }
      }
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
      for (const t of deferredWakeTimers.values()) clearTimeout(t);
      deferredWakeTimers.clear();
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
