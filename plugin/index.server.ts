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
} from "../server/lead-handoff.mjs";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole,
  findLaneInRegistry,
  isDigestAgent as isDigestIdentity,
  isRetiredAgent,
  isRetiredRole,
  matchPathInRegistry,
  normalizeRoleLabel,
  resolveAgentIdentity,
  topicOf,
} from "../server/identity.mjs";

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
const WAKE_TYPES = new Set(["done", "blocker", "decision", "needs-aub", "aub"]);
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
  "- To flag something for the owner, set label needs-aub=\"<one-line reason>\" on yourself (`paseo agent update $PASEO_AGENT_ID --label needs-aub=\"...\"`).",
  "- Catch up on Squad state with `vs log --since-me` (shares `decision` / `aub` / `needs-aub` entries across all lanes in the Squad). Naming conventions: docs/NAMING.md.",
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
  "Role: brainstorm (mascot: Buddy).",
  "- You may write `vs log decision \"...\"`, `vs log needs-aub \"...\"`, `vs log handoff \"...\"`, and `vs log metric \"...\"` (240 chars max). Hand build work to a lead; do not implement.",
  "- Keep `docs/brainstorm/<lane>.md` (<5k tokens, sections: Decided / Open / In flight) updated with every plan handoff.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section.",
  "- At >=80k tokens, add a one-line footer to your reply: \"getting heavy, restart from summary?\".",
  "- When the user drops unrelated ideas mid-chat, run `vs inbox add \"<idea 1>\" \"<idea 2>\"` (or use the UI's `Park in Inbox` button) and reply \"parked N ideas → Inbox\" instead of derailing the current chat.",
  "- \"Spin up a buddy (for X)\" / \"spin up another buddy\" / \"get me a buddy for X\": spawn a new Buddy (role=brainstorm, title BRAINSTORM · <LANE> · <topic X>) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).",
].join("\n");

export const LEAD_FALLBACK_PACK = [
  "Role: lead.",
  "- Dispatch workers, read their digests via `vs log --since-me` (never raw transcripts), log decisions/blockers with `vs log`.",
  "- Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k. Run `vs handoff` and fill the Judgment section.",
  "- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section.",
  "- \"Spin up a buddy (for X)\" / \"spin up another buddy\" / \"get me a buddy for X\": spawn a new Buddy (role=brainstorm, title BRAINSTORM · <LANE> · <topic X>) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).",
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
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.profiles)
          ? parsed.profiles
          : Array.isArray(parsed?.daemon?.agentProfiles)
            ? parsed.daemon.agentProfiles
            : [];
      if (list.length > 0) return list as StoredProfile[];
    } catch {
      // try next
    }
  }
  return [];
}

const LEGACY_ALIASES: Record<string, string> = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
};

export function resolveStoredProfile(
  profileHint?: string,
  provider?: string,
  title?: string | null,
  role?: string,
  profiles = loadStoredProfiles(),
): StoredProfile | null {
  if (!profiles.length) return null;
  const rawHint = (profileHint ?? "").trim();
  const mappedHint = LEGACY_ALIASES[rawHint] || rawHint;
  if (mappedHint) {
    const exact = profiles.find((p) => p.name === mappedHint || p.name.toLowerCase() === mappedHint.toLowerCase());
    if (exact) return exact;
  }
  const cleanTitle = (title ?? "").trim();
  if (cleanTitle) {
    const byTitle = profiles.find((p) => cleanTitle.toLowerCase().startsWith(p.name.toLowerCase()));
    if (byTitle) return byTitle;
  }
  const isAgy = (provider ?? "").startsWith("antigravity-cli");
  if (role === "lead") {
    const want = isAgy ? "Lead - Gemini" : "Lead - Claude";
    return profiles.find((p) => p.name === want) ?? null;
  }
  if (role === "brainstorm") {
    const want = isAgy ? "Brainstorm - Gemini" : "Brainstorm - Claude";
    return profiles.find((p) => p.name === want) ?? null;
  }
  return null;
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

function loadTeams(): TeamDef[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveTeamsFilePath(), "utf8"));
    if (Array.isArray(parsed?.teams)) return parsed.teams;
  } catch {}
  return [];
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

export function rolePack(role: string, cwd: string): string {
  if (role === "lead") {
    try {
      const text = fs.readFileSync(path.join(findProjectRoot(cwd), "docs", "LEAD_RULES.md"), "utf8").trim();
      if (text) return text;
    } catch {
      // fall through
    }
    return LEAD_FALLBACK_PACK;
  }
  if (role === "brainstorm") return BRAINSTORM_PACK;
  if (role === "worker") return WORKER_PACK;
  return "";
}

/** Layers 1 and 3 joined in the fixed order; layer 2 (AGENTS.md) is loaded by the provider. */
export function injectedPrefix(role: string, cwd: string): string {
  return [EVERYONE_LAYER, rolePack(role, cwd)].filter(Boolean).join("\n\n");
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
  debounceMs: 3000,
  retryBaseMs: 5000,
  watchIntervalMs: 1500,
  startWatcher: true,
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
  lastUsage?: { contextWindowUsedTokens?: number; inputTokens?: number } | null;
}

function log(message: string) {
  console.log(`[vibesquad] ${message}`);
}

export function createPlugin(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...DEFAULT_DEPS, ...overrides };

  return function contribute(server: PluginServerContext) {
    const teams = loadTeams();
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
        appendLog(teamIdOf(team, teams), {
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
      const derived = deriveTeamForSpawn(labels, cwd, teams);
      if (derived.team) return { team: teamIdOf(derived.team, teams), lane: derived.lane || derived.team };
      if (labels.team) return { team: teamIdOf(labels.team, teams), lane: labels.lane || resolveByCwd(cwd, teams)?.lane || "" };
      return resolveByCwd(cwd, teams);
    };

    const recentBeforeMismatches = new Map<string, number>();

    // ---- Hook 1: before agent.create ---------------------------------------

    stops.push(
      server.before("agent.create", ({ request }: { request: any }) => {
        const config: any = request.config ?? {};
        const env = (request as any).env as Record<string, string> | undefined;
        const rawReqLabels = ((request as any).labels ?? config?.labels) as Labels | undefined;
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

        const matchedProfile = resolveStoredProfile(
          config.profile || reqLabels.profile || env?.VS_PROFILE,
          provider,
          title,
          explicitRole || "worker",
        );

        const role = explicitRole || matchedProfile?.role || "worker";

        if (rawReqLabels) {
          const resolved = resolveAgentIdentity(reqLabels, {
            cwd,
            teams,
            fallbackRole: role,
            recomputeOrphan: true,
          });
          if (!resolved.isOrphan) {
            if (reqLabels.lane !== resolved.laneId) {
              reqLabels.lane = resolved.laneId;
              changed = true;
            }
            if (reqLabels.team !== resolved.teamId) {
              reqLabels.team = resolved.teamId;
              changed = true;
            }
            if (!reqLabels.role) {
              reqLabels.role = resolved.role;
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
            if (resolved.autofixedFromCwd) {
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
              reqLabels.role = resolved.role;
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

        if (matchedProfile) {
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

        // A1: Antigravity must never hang on an unsurfaced permission prompt.
        if (provider.startsWith("antigravity-cli")) {
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

        const prefix = injectedPrefix(role, cwd);
        const profileNotes = (matchedProfile?.notes ?? "").trim();
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
                text: `prompt-injection role=${role} provider=${provider} chars=${prefix.length}`,
              });
            } catch (err) {
              log(`metric write failed: ${err}`);
            }
          }
        }
        return changed
          ? {
              ...request,
              ...(nextReqLabels && (request as any).labels ? { labels: nextReqLabels } : {}),
              config: next,
            }
          : undefined;
      }),
    );

    // ---- agent.created: auto-label, antigravity everyone-layer, first dispatch

    stops.push(
      server.on("agent.created", async ({ agent }: { agent: any }, { paseo }: { paseo: any }) => {
        paseoApi = paseo;
        try {
          const { snap: me, labels } = await labelsFor(paseo, agent);
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
              teams,
              fallbackRole: labels.role || "worker",
              recomputeOrphan: true,
              agentsById: parent && parentId ? { [parentId]: parent } : undefined,
            },
          );

          const want: Labels = {};
          let lane = "";
          let team = "";

          if (!resolved.isOrphan) {
            lane = resolved.laneId;
            team = resolved.teamId;
            if (labels.lane !== resolved.laneId) want.lane = resolved.laneId;
            if (labels.team !== resolved.teamId) want.team = resolved.teamId;
            if (!labels.role) want.role = resolved.role;
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
            if (resolved.autofixedFromCwd) {
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
            if (!labels.role) want.role = resolved.role;
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

          if (Object.keys(want).length > 0) {
            await deps.setLabels(agent.id, { ...labels, ...want }).catch((e) => log(`label failed: ${e}`));
          }

          const finalRole = labels.role || want.role || "";
          const finalTopic = finalRole === "brainstorm" ? brainstormTopicOf({ ...labels, ...want }) : "";
          if ((finalRole === "lead" || finalRole === "brainstorm") && team && lane) {
            await retirePredecessors(paseo, agent.id, finalRole, teamIdOf(team, teams), lane, finalTopic).catch((e) =>
              log(`retire scan failed: ${e}`),
            );
          }

          // First-dispatch context metric for a lead's first spawned child.
          if (parentId && parent && pl.role === "lead" && team) {
            const n = (childCount.get(parentId) ?? 0) + 1;
            childCount.set(parentId, n);
            if (n === 1 && !firstDispatchLogged.has(parentId)) {
              firstDispatchLogged.add(parentId);
              const used = parent.lastUsage?.contextWindowUsedTokens ?? parent.lastUsage?.inputTokens ?? 0;
              appendLog(teamIdOf(team, teams), {
                agent: "plugin",
                lane,
                type: "metric",
                text: `first-dispatch context: ${Math.round(used / 1000)}k tokens (lead=${parentId}, ord=${pl.ord ?? "?"})`,
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
      if (isDigestAgent(labels, worker.title)) return;
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
        `Use FAIL if the worker reported errors, failing tests, or did not finish. Then stop.`,
      ].join("\n");

      const fallback = async (why: string) => {
        const last = await lastAssistantText(paseo, worker.id);
        const line = last.split(/\r?\n/).find((l) => l.trim()) ?? "no final message";
        appendLog(teamIdOf(team, teams), {
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

    /** Lane integrity: a lane keeps one live lead and one live brainstorm per (team, lane, topic); the predecessor is marked former-*. */
    async function retirePredecessors(paseo: Paseo, newId: string, role: string, team: string, lane: string, topic = "") {
      const newSnap = await snap(paseo, newId);
      const handoffFrom = newSnap?.labels?.["vs.handoff-from"] ?? "";
      const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
      const others = (res.entries as any[])
        .map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }) as AgentSnap)
        .filter((a) => a.id !== newId && !a.archivedAt && !a.internal && a.status !== "closed")
        .filter((a) => !isRetiredAgent(a))
        .filter((a) => sameLaneRole(a, { role, team, lane, topic }, teams));
      for (const old of others) {
        if (role === "lead" && (old.id === handoffFrom || handoffCoordinator.hasPendingTakeover(newId))) {
          // Delayed retirement: wait until successor confirms takeover in turn_ended / confirmTakeover.
          continue;
        }
        const former = role === "lead" ? "former-lead" : "former-brainstorm";
        const ord = old.labels.ord;
        const laneName = teams.flatMap((t: any) => t.lanes ?? []).find((x: any) => x.id === lane || x.aliases?.includes(lane))?.name ?? lane;
        const oldTitle = (old.title ?? "").trim();
        const name =
          role === "lead"
            ? ord
              ? `(old) ${laneName.toUpperCase()} ord${ord}`
              : `(old) ${oldTitle}`
            : `(old) ${oldTitle || "BRAINSTORM"}`;
        let renamed = true;
        await deps.setLabels(old.id, { role: former, ...(role === "lead" && ord ? { ord } : {}) }, name).catch((e) => {
          renamed = false;
          log(`retire failed: ${e}`);
        });
        log(`retired ${old.id} (${role} -> ${former}) in ${team}/${lane}`);
        if (role === "brainstorm" && renamed) {
          await Promise.resolve()
            .then(() => paseo.agents.ref(old.id).archive())
            .catch(() => deps.archiveAgent(old.id))
            .catch((e: unknown) => log(`archive failed for ${old.id}: ${e}`));
        }
      }
    }

    async function findLead(paseo: Paseo, team: string, lane: string): Promise<AgentSnap | null> {
      const res = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200 } });
      const wantLane = (lane || "").toLowerCase();
      const leads = (res.entries as any[])
        .map((e) => ({ ...e.agent, labels: e.agent.labels ?? {} }) as AgentSnap)
        .filter((a) => !a.archivedAt && !a.internal && a.status !== "closed")
        .filter((a) => effectiveAgentRole(a) === "lead")
        .filter((a) => {
          const d = deriveTeamForSpawn(a.labels, a.cwd, teams);
          const aTeam = teamIdOf(d.team || a.labels.team, teams);
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

      const { team: rawTeam, lane: rawLane } = deriveTeamForSpawn(target.labels, target.cwd, teams);
      const team = teamIdOf(rawTeam || target.labels?.team || "", teams);
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
