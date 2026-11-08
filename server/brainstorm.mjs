import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import os from "node:os";
import { effectiveAgentRole, findLaneInRegistry, formatDisplayTitle, isHubLane, isRetiredAgent, laneCodeFor, resolveWorktreeRootPath, topicOf } from "./identity.mjs";
import { findProfileOrFallback, loadProfiles, readCappedProviders, resolveProfileWithFailover, toPaseoSpawnConfig } from "./profiles.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";
import { briefRootFor, laneWorkingDir } from "./brief-path.mjs";
import { defangPromptFences } from "./write-guards.mjs";
import { detachLiveChildrenViaClient, listDaemonAgents } from "./detach-children.mjs";
import { getBackend, sharedRunnerBackend } from "./backend/index.mjs";
import { SPAWN_TIMING } from "./backend/runner-backend.mjs";
import { BRIEF_HISTORY_KEEP, BRIEF_SHRINK_FROM, BRIEF_SHRINK_TO, backupBrief, writeBriefFile } from "./brief-write.mjs";
import { liveInFlightBlock } from "./in-flight.mjs";
import { refreshWhosHere } from "./whos-here.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";

// import.meta.dirname is undefined when bundled into the Paseo plugin; fall back like server/hooks/agent-duties.ts.
const REPO_ROOT = resolve(process.env.VIBESQUAD_ROOT || (typeof import.meta.dirname === "string" ? join(import.meta.dirname, "..") : join(homedir(), "projects", "VibeSquad")));
const MAX_SUMMARY_CHARS = 20_000;
const MAX_LOG_TEXT = 240;

function safeSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "") || "vibesquad";
}

/**
 * Archive a retired Buddy without taking its lead and workers along (Paseo cascades archives to
 * children, docs/PLAN_BUGS_BATCH1.md block 0). Live children are detached first; if any detach fails,
 * the Buddy stays retired but unarchived rather than risk the cascade.
 */
export async function archiveBuddyKeepingChildren(client, agentId) {
  const backend = getBackend(client);
  if (typeof backend?.archiveAgent !== "function") return { archived: false, detached: [], failed: [] };
  const { detached, failed } = await detachLiveChildrenViaClient(client, agentId);
  if (detached.length) console.log(`[vibesquad] detached ${detached.length} child(ren) of ${agentId} before archive: ${detached.join(", ")}`);
  if (failed.length) {
    console.warn(`[vibesquad] kept ${agentId} unarchived: could not detach ${failed.map((f) => f.id).join(", ")}`);
    return { archived: false, detached, failed };
  }
  await backend.archiveAgent(agentId).catch(() => {});
  return { archived: true, detached, failed };
}

/** The agent backend a server-side caller works through: the runner. */
export function createAgentClient(_rootDir = REPO_ROOT) {
  return sharedRunnerBackend();
}

function resolveTeamsFilePath(rootDir = REPO_ROOT) {
  return resolveSharedTeamsFilePath(rootDir);
}

function loadTeamsConfig(rootDir = REPO_ROOT) {
  const file = resolveTeamsFilePath(rootDir);
  const res = readJsonFileWithBom(file, { label: "teams.json", fallback: { teams: [] }, recordWarning: true });
  return res.data ?? { teams: [] };
}

/** Lane-code Buddy title: `<Code> Buddy[ · topic]` (docs/NAMING.md). */
export function buddyTitle(laneId, laneName, topic, rootDir = REPO_ROOT) {
  const teams = loadTeamsConfig(rootDir).teams;
  const list = Array.isArray(teams) ? teams : [];
  const code = laneCodeFor(laneId, list);
  const found = findLaneInRegistry(laneId, list);
  const needle = String(laneId ?? "").toLowerCase();
  const isHub = found
    ? isHubLane(found.team, found.lane)
    : list.some((t) => String(t.id).toLowerCase() === needle && isHubLane(t, { id: t.id }));
  return formatDisplayTitle({ role: "brainstorm", laneId, laneName, code, topic, hub: isHub });
}

function laneDisplayName(laneId, rootDir = REPO_ROOT) {
  const cfg = loadTeamsConfig(rootDir);
  const needle = String(laneId ?? "").toLowerCase();
  for (const t of cfg.teams ?? []) {
    for (const l of t.lanes ?? []) {
      if (String(l.id).toLowerCase() === needle || (l.aliases ?? []).some((a) => String(a).toLowerCase() === needle)) {
        return { teamId: t.id, laneId: l.id, laneName: l.name || l.id };
      }
    }
  }
  for (const t of cfg.teams ?? []) {
    if (String(t.id).toLowerCase() === needle && isHubLane(t, { id: t.id })) {
      return { teamId: t.id, laneId: t.id, laneName: "RiffBot" };
    }
  }
  return { teamId: "", laneId: safeSegment(laneId), laneName: String(laneId || "vibesquad").replace(/-/g, " ") };
}

export { briefRootFor, laneWorkingDir };

export const NO_BRIEF_LINE = "(no brief yet)";

export function readBrainstormSummary(laneRaw, rootDir = REPO_ROOT, { teamId: teamHint = "" } = {}) {
  const resolved = laneDisplayName(laneRaw, rootDir);
  const laneId = resolved.laneId;
  const teamId = resolved.teamId || String(teamHint || "");
  const safeLane = safeSegment(laneId || laneRaw || "vibesquad");
  const relPath = `docs/brainstorm/${safeLane}.md`;
  // Only the lane's project dir counts; a stale copy under rootDir is ignored once the project dir resolves.
  const fullPath = join(briefRootFor(teamId, laneId, rootDir), "docs", "brainstorm", `${safeLane}.md`);
  const content = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : NO_BRIEF_LINE;
  return { laneId: safeLane, path: relPath, fullPath, content };
}

export { BRIEF_HISTORY_KEEP, BRIEF_SHRINK_FROM, BRIEF_SHRINK_TO, backupBrief };

// The installed app's rootDir is its own runtime folder (no .git); a brief landing there is invisible to the lane.
export function isInstalledRuntime(rootDir) {
  return /[\\/]runtime$/i.test(resolve(rootDir)) && !existsSync(join(rootDir, ".git"));
}

/** `teamId` is the Squad id for a lane not yet in teams.json (createPin writes the brief before adding the lane). */
export function writeBrainstormSummary(laneRaw, content, rootDir = REPO_ROOT, { teamId: teamHint = "" } = {}) {
  const text = String(content ?? "");
  if (text.length > MAX_SUMMARY_CHARS) {
    throw new Error(`Summary is ${text.length} chars; must be <= ${MAX_SUMMARY_CHARS} chars (~5k tokens)`);
  }
  const resolved = laneDisplayName(laneRaw, rootDir);
  const laneId = resolved.laneId;
  const teamId = resolved.teamId || String(teamHint || "");
  const safeLane = safeSegment(laneId || laneRaw || "vibesquad");
  const relPath = `docs/brainstorm/${safeLane}.md`;
  const root = briefRootFor(teamId, laneId, rootDir);
  const dir = join(root, "docs", "brainstorm");
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, `${safeLane}.md`);
  writeBriefFile(fullPath, safeLane, text);
  const fallback = resolve(root) === resolve(rootDir) && isInstalledRuntime(rootDir);
  if (fallback) {
    try {
      appendVsLogEntry({ teamId: teamId || "vibesquad", laneId: safeLane, agent: "server", type: "metric", text: `brief-fallback lane=${safeLane} path=${fullPath}` });
    } catch {}
  }
  return { laneId: safeLane, path: relPath, fullPath, content: text, ...(fallback ? { fallback: true } : {}) };
}

export function findNewestPlanFile(cwd, rootDir = REPO_ROOT) {
  const dirs = [cwd ? join(cwd, "docs") : null, join(rootDir, "docs")].filter(Boolean);
  for (const d of dirs) {
    try {
      if (!existsSync(d)) continue;
      const plans = readdirSync(d)
        .filter((f) => /^PLAN_.*\.md$/i.test(f))
        .map((f) => {
          const full = join(d, f);
          return { name: f, rel: `docs/${f}`, mtime: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (plans.length > 0) return plans[0].rel;
    } catch {}
  }
  return "docs/PLAN_BRAINSTORM_FLOW.md";
}

/**
 * The newest plan file this lane names: a `docs/PLAN_*.md` mentioned in its brief or in
 * `docs/lanes/<lane>/TASKS.json` (read from the lane's cwd, then the repo root), newest mtime first.
 * A fresh lane names none and gets "(none yet)", never another lane's plan from a shared docs/ folder.
 */
export function findLanePlanFile(cwd, rootDir = REPO_ROOT, laneId = "", briefText = "") {
  const texts = [String(briefText ?? "")];
  const safeLane = laneId ? safeSegment(laneId) : "";
  if (safeLane) {
    for (const base of [cwd, rootDir]) {
      if (!base) continue;
      try {
        const f = join(base, "docs", "lanes", safeLane, "TASKS.json");
        if (existsSync(f)) texts.push(readFileSync(f, "utf8"));
      } catch {}
    }
  }
  const named = new Set();
  for (const t of texts) for (const m of t.matchAll(/docs\/(PLAN_[\w.-]*\.md)/gi)) named.add(m[1]);
  let best = null;
  for (const name of named) {
    for (const base of [cwd, rootDir]) {
      if (!base) continue;
      try {
        const full = join(base, "docs", name);
        if (!existsSync(full)) continue;
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { rel: `docs/${name}`, mtime };
        break;
      } catch {}
    }
  }
  return best ? best.rel : "(none yet)";
}

export function appendVsLogEntry({ teamId, laneId, agent = "you", type = "metric", text, refs = [] }) {
  const baseHome = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  const safeTeam = safeSegment(teamId || "vibesquad");
  const safeLane = safeSegment(laneId || safeTeam || "vibesquad");
  const cleanText = String(text ?? "").trim().slice(0, MAX_LOG_TEXT);
  if (!cleanText) throw new Error("log text cannot be empty");

  const entry = {
    ts: new Date().toISOString(),
    agent: String(agent || "you"),
    lane: safeLane,
    type: String(type || "metric"),
    text: cleanText,
    refs: Array.isArray(refs) ? refs.map(String) : [],
  };
  const line = JSON.stringify(entry) + "\n";

  const logsDir = join(baseHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  const laneLogPath = join(logsDir, `${safeTeam}--${safeLane}.jsonl`);
  appendFileSync(laneLogPath, line, "utf8");

  const tDir = join(baseHome, "teams", safeTeam);
  mkdirSync(tDir, { recursive: true });
  const teamLogPath = join(tDir, "log.jsonl");
  appendFileSync(teamLogPath, line, "utf8");

  return { entry, path: laneLogPath, teamLogPath };
}

/** Boot-prompt line for a successor Buddy in a Vibe mode Squad: the old Buddy's check-in heartbeat does not follow it. */
export const VIBE_HEARTBEAT_LINE =
  "- Vibe mode is ON: your predecessor's check-in heartbeat targets the old Buddy. Recreate it for yourself (`create_heartbeat`, same prompt, your agent id as target), then delete the old one.";

/** Boot-prompt rules for the Squad's hub Buddy (RiffBot). Appended only for the hub lane; a Team Buddy's prompt is unchanged. */
export const HUB_BOOT_RULES = [
  `- You are this Squad's hub (RiffBot). Keep \`## Teams\` (one line per Team: state + current block) and \`## Unsplit threads\` in the brief; add them if missing. Boot from them and the live Teams below.`,
  `- First message: the Squad status in <=6 lines, plus the top split you'd propose now (a \`vs:spin-off\` block, still confirmed by the user).`,
  `- Never mark the hub done; never spawn a feature-lane Lead (exception: you may message or spawn the Overlord, the hub lane's Lead, for cross-lane ops). Team Buddies design; you sort and split.`,
];

const TEAM_STATES = new Set(["pinned", "done"]);

const sameLane = (a, laneId) => String(a?.labels?.lane || a?.labels?.lead || "").trim().toLowerCase() === String(laneId).toLowerCase();

/**
 * Live Teams block for a hub boot prompt: one line per non-hub, non-removed lane with its state and its
 * live lead's `job`. `agents` null means the daemon list could not be read. Pure.
 */
export function hubTeamsBlock({ team, agents }) {
  const out = ["Teams in this Squad (live, generated at boot):"];
  const lanes = (team?.lanes ?? []).filter((l) => l.id !== "_other" && !isHubLane(team, l) && (l.state ?? "pinned") !== "removed");
  if (!lanes.length) out.push("- (no Teams besides the hub yet)");
  const live = agents == null ? null : agents.map((a) => a?.agent ?? a).filter((a) => a && !a.archivedAt && !a.internal && a.status !== "closed" && !isRetiredAgent(a));
  for (const l of lanes) {
    const state = TEAM_STATES.has(l.state) ? l.state : "pinned";
    const lead = live?.find((a) => sameLane(a, l.id) && effectiveAgentRole(a) === "lead");
    const job = String(lead?.labels?.job ?? "").trim();
    const who = live == null ? "lead unknown" : lead ? `lead working${job ? `: ${job}` : ""}` : "no lead running";
    out.push(`- ${l.name || l.id} (\`${l.id}\`) · ${state} · ${who}`);
  }
  return out.join("\n");
}

export function buildBrainstormInitialPrompt({ laneId, laneUpper, buddyName, summaryContent, latestPlan, pendingPrompt, inFlight, vibeMode = false, hubTeams = "", autoRetire = false, standing = false }) {
  const tail =
    pendingPrompt && String(pendingPrompt).trim()
      ? `Pending message from the user to answer now:\n${defangPromptFences(String(pendingPrompt).trim())}`
      : autoRetire
        ? `Summary loaded from docs/brainstorm/${laneId}.md. Keep this first turn small: read the brief above, then wait for the user.`
        : `Summary loaded from docs/brainstorm/${laneId}.md. Work the top Open item now: reply with your take or the next question on it, in a few short sentences. Ask the user only if you are blocked. Do not just confirm you are ready.`;

  return [
    `You are ${buddyName || `BRAINSTORM · ${laneUpper}`} (fresh start for lane \`${laneId}\`). Read the brief below before anything else.`,
    "",
    "Rules (BF-P1):",
    `- Update \`docs/brainstorm/${laneId}.md\` after every decision as a short diff (< ~5k tokens; sections: Who's here / Done when / Decided / Open / In flight). Keep \`## Done when\`. Never edit \`## Who's here\`; VibeSquad writes it. The brief is the handoff; do not write dated docs/BRAINSTORM_HANDOFF_*.md files.`,
    ...(hubTeams
      ? []
      : [
          standing
            ? `- Never complete the team yourself. When the lead reported PASS on the last plan block and nothing is Open, post "<Team> looks done. ✓ Goal shipped · Not yet" with the line \`vs:looks-done\` in a code fence (offers \`✓ Goal shipped\` on standing teams and \`✓ Mark complete\` on disposable teams).`
            : `- Never complete the team yourself. When the lead reported PASS on the last plan block and nothing is Open, post "<Team> looks done. ✓ Mark complete · Not yet" with the line \`vs:looks-done\` in a code fence.`,
        ]),
    `- To find your current lead for handoff: run \`vs who lead\`.`,
    `- Before handing off a plan that adds a command, rule or feature, check for an existing primitive (\`vs --help\`, the VS MCP tool list, skills). Name what you checked in the plan's Decided section.`,
    `- At >=80k context tokens, update the brief now. At the hard limit VibeSquad retires you; the next click on the pin starts a fresh Brainstorm from the brief.`,
    ...(vibeMode ? [VIBE_HEARTBEAT_LINE] : []),
    ...(hubTeams ? HUB_BOOT_RULES : []),
    `- Latest plan file: \`${latestPlan}\``,
    "",
    `--- BEGIN docs/brainstorm/${laneId}.md ---`,
    defangPromptFences(summaryContent.trim()),
    `--- END docs/brainstorm/${laneId}.md ---`,
    "",
    ...(inFlight ? [inFlight, ""] : []),
    ...(hubTeams ? [hubTeams, ""] : []),
    tail,
  ].join("\n");
}

const SPAWN_LAG_TICK_MS = 50;

/** True for the errors a caller-side abort or daemon wait deadline produces (the daemon usually finishes the create anyway). */
export function isCreateTimeoutError(err) {
  // The daemon's own provider-refresh deadline is a definitive failure (nothing is being built), so it is not recoverable.
  if (/Timed out refreshing/i.test(String(err?.message ?? err ?? ""))) return false;
  return /time(d)?[ -]?out|timeout|abort/i.test(`${err?.name ?? ""} ${err?.message ?? err ?? ""}`);
}

function agentListOf(raw) {
  return Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw?.agents) ? raw.agents : [];
}

/**
 * createAgent timed out but Paseo keeps building the agent (docs/research/spawn-hang-2026-11-06.md: 4/4 slow Bugc spawns landed
 * without their initial prompt). Poll the agent list for the label-matched agent; once it is idle with no activity send the
 * initial prompt exactly once, and if it already has activity adopt it untouched. Returns the agent, or null when it never showed.
 */
export async function recoverTimedOutCreate({ backend, labels, title, initialPrompt, startedMs, waitMs = 120_000, pollMs = 5_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const list = backend.listAgents ?? backend.fetchAgents;
  if (typeof list !== "function") return null;
  const deadline = now() + waitMs;
  for (;;) {
    let found = null;
    try {
      for (const item of agentListOf(await list.call(backend))) {
        const a = item?.agent ?? item;
        if (!a?.id || a.archivedAt || a.id === labels["vs.restarted-from"]) continue; // never adopt the predecessor
        const l = a.labels ?? {};
        // Labels only (a title alone can match another lane's or an older Buddy): role, lane, team and the restart origin must all agree.
        const sameRestart = Boolean(labels["vs.restarted-from"]) && l["vs.restarted-from"] === labels["vs.restarted-from"];
        const matches = Boolean(labels.role) && l.role === labels.role && l.lane === labels.lane && l.team === labels.team && sameRestart;
        const ts = Date.parse(a.createdAt || a.updatedAt || "");
        if (matches && Number.isFinite(ts) && ts >= startedMs - 5000) {
          found = a;
          break;
        }
      }
    } catch {}
    if (found && found.status !== "initializing") {
      if (found.status === "error" || found.status === "closed") return null;
      // lastActivityAt is stamped at creation by RunnerBackend.toAgent, so it proves nothing; real activity is a non-idle status,
      // a user message or used tokens (as server/hooks/agent-duties.ts does).
      const usedTokens = (found.lastUsage?.contextWindowUsedTokens ?? 0) + (found.lastUsage?.inputTokens ?? 0);
      const hasActivity = found.status !== "idle" || Boolean(found.lastUserMessageAt) || usedTokens > 0;
      if (!hasActivity && initialPrompt && typeof backend.sendAgentPrompt === "function") {
        await backend.sendAgentPrompt(found.id, initialPrompt);
      }
      return found;
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

// Per-step spawn timing (docs/PLAN_SPAWN_SPEED.md): marks are ms since start, flushed as one log line + one `spawn-timing` metric.
export function createSpawnTimer(kind) {
  const t0 = Date.now();
  const marks = [];
  let last = t0;
  // Event-loop lag (docs/PLAN_VS_SHIM_AND_SPAWN_HANG.md B2): worst timer drift of this process while the spawn ran. Rides on
  // the same `spawn-timing` metric; a large value means our own loop was blocked, not just Paseo.
  let lagMax = 0;
  let lagLast = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - lagLast - SPAWN_LAG_TICK_MS);
    lagLast = now;
    if (now - t0 > 600_000) clearInterval(lagTimer);
  }, SPAWN_LAG_TICK_MS);
  lagTimer.unref?.();
  let lagStopped = false;
  const stopLag = () => {
    if (lagStopped) return;
    lagStopped = true;
    clearInterval(lagTimer);
    lagMax = Math.max(lagMax, Date.now() - lagLast - SPAWN_LAG_TICK_MS);
  };
  return {
    /** Stop the lag sampler without reporting (early returns and throws of the spawn path). Idempotent. */
    stop: stopLag,
    add(step, ms) {
      marks.push([step, ms]);
    },
    mark(step, sub) {
      const now = Date.now();
      marks.push(sub ? [step, now - last, sub] : [step, now - last]);
      last = now;
    },
    summary() {
      stopLag();
      return `${kind}: ${marks.map(([k, v, sub]) => `${k}=${v}ms${sub ? `(${sub})` : ""}`).join(" ")} total=${Date.now() - t0}ms loopLagMax=${Math.max(0, lagMax)}ms`;
    },
    flush({ teamId, laneId, agent }) {
      const text = `spawn-timing ${this.summary()}`;
      console.log(`[vibesquad] ${text}`);
      try {
        appendVsLogEntry({ teamId, laneId, agent, type: "metric", text });
      } catch {}
    },
  };
}

/** The createAgent sub-parts object (SPAWN_TIMING) rendered as `k=v,k=v`, or undefined when absent. */
function formatSpawnSubParts(parts) {
  return parts ? Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(",") : undefined;
}

const restartedAgents = new Map();
const lastAutoRestartByLane = new Map();

export function resetBrainstormRestartState() {
  restartedAgents.clear();
  lastAutoRestartByLane.clear();
}

function parseBrainstormTopic(agent) {
  return topicOf(agent).toLowerCase();
}

export function findExistingLaneBrainstorm(agents, laneId, topic = "") {
  if (!agents || !laneId) return null;
  const list = Array.isArray(agents)
    ? agents
    : agents instanceof Map
      ? [...agents.values()]
      : typeof agents[Symbol.iterator] === "function"
        ? [...agents]
        : [];
  const wantLane = String(laneId).trim().toLowerCase();
  const wantTopic = String(topic ?? "").trim().toLowerCase();
  const matches = list
    .map((item) => item?.agent ?? item)
    .filter(Boolean)
    .filter((a) => {
      // Closed is not retired: every agent is `closed` after a daemon restart, and a closed Buddy is
      // reopened from its session, never replaced (docs/PLAN_BUGS_BATCH1.md block 0c). Archived or a
      // retired role (former-brainstorm) still never counts.
      if (a.archivedAt || isRetiredAgent({ labels: a.labels ?? {} })) return false;
      // A restarted Buddy keeps role=brainstorm on the daemon until its backgrounded retire lands.
      if (restartedAgents.has(a.id)) return false;
      if (effectiveAgentRole({ ...a, status: undefined }) !== "brainstorm") return false;
      const labels = a.labels ?? {};
      const aLane = String(labels.lane || labels.lead || "").trim().toLowerCase();
      if (aLane !== wantLane) return false;
      return parseBrainstormTopic(a) === wantTopic;
    });
  // A running/idle Buddy beats a closed one; then newest first.
  const closed = (a) => (a.status === "closed" ? 1 : 0);
  matches.sort((a, b) => closed(a) - closed(b) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return matches[0] ?? null;
}

const retiredTitleOf = (title) => {
  const t = String(title || "").trim() || "Buddy";
  return t.toLowerCase().startsWith("(old)") ? t : `(old) ${t}`;
};

/**
 * Backstop for one main Buddy per (team, lane, topic) (docs/PLAN_BUGS_BATCH2.md block 0): after a real
 * spawn of `newId`, retire every other unarchived role=brainstorm in the lane, live or closed. Closed
 * ones matter most: the plugin's agent.created retire skips them, so a closed old Buddy kept
 * role=brainstorm and came back when messaged. Retire = cancel (if live), "(old)" title,
 * former-brainstorm + vs.restarted-into, then archive with its children detached. Never throws.
 */
export async function retireOtherLaneBuddies(client, { newId, teamId, laneId, topic = "", exceptIds = [] }) {
  const retired = [];
  if (!client || !newId || !laneId) return retired;
  const backend = getBackend(client);
  const agents = await listDaemonAgents(client);
  const wantLane = String(laneId).toLowerCase();
  const wantTeam = String(teamId || "").toLowerCase();
  const wantTopic = String(topic || "").trim().toLowerCase();
  const skip = new Set([newId, ...exceptIds]);
  for (const a of agents) {
    if (!a?.id || skip.has(a.id) || a.archivedAt || restartedAgents.has(a.id)) continue;
    const labels = a.labels ?? {};
    if (effectiveAgentRole({ labels }) !== "brainstorm") continue;
    if (String(labels.lane || labels.lead || "").trim().toLowerCase() !== wantLane) continue;
    if (wantTeam && labels.team && String(labels.team).toLowerCase() !== wantTeam) continue;
    if (parseBrainstormTopic(a) !== wantTopic) continue;
    restartedAgents.set(a.id, { newAgentId: newId, ts: Date.now(), tokens: 0 });
    if (a.status !== "closed") await backend.cancelAgent?.(a.id)?.catch?.(() => {});
    const retiredLabels = { ...labels, role: "former-brainstorm", "vs.restarted-into": newId };
    await backend.updateAgent?.(a.id, { name: retiredTitleOf(a.title), labels: retiredLabels })?.catch?.(() => {});
    await archiveBuddyKeepingChildren(client, a.id);
    console.log(`[vibesquad] retired duplicate Buddy ${a.id} in ${teamId}/${laneId} (into ${newId})`);
    retired.push(a.id);
  }
  return retired;
}

// Pinned-team quick start (docs/PLAN_PINNED_FEATURES.md §3): concurrent "start-brainstorm" calls for the
// same lane share one spawn, so a double-click or two open tabs can't create two Brainstorms.
const startInFlight = new Map();

export function performBrainstormRestart(body, rootDir = REPO_ROOT) {
  const isStart = String(body?.reason || "").trim() === "start-brainstorm" || String(body?.agentId || "") === "start-brainstorm";
  if (body?.forceNew) return performBrainstormRestartOnce(body, rootDir);
  if (!isStart) {
    // A restart click while the first one is still spawning (createAgent took ~110 s at 04:24Z) shares that
    // spawn: two clicks made two Buddies, the second retired the first (docs/PLAN_BUGS_BATCH1.md block 0c).
    const oldId = String(body?.agentId || "").trim();
    if (!oldId) return performBrainstormRestartOnce(body, rootDir);
    const rkey = `restart:${oldId}`;
    const busy = startInFlight.get(rkey);
    if (busy) return busy.then((r) => (r?.ok ? { ...r, reused: true, reason: "already-restarting" } : r));
    const once = performBrainstormRestartOnce(body, rootDir).finally(() => startInFlight.delete(rkey));
    startInFlight.set(rkey, once);
    return once;
  }
  const key = [body.teamId || body.team || "", body.laneId || body.lane || "", body.topic || ""].map((s) => String(s).trim().toLowerCase()).join(":");
  const pending = startInFlight.get(key);
  if (pending) return pending.then((r) => (r?.ok && r.newAgentId ? { ...r, reused: true, existingAgentId: r.newAgentId } : r));
  const run = performBrainstormRestartOnce(body, rootDir).finally(() => startInFlight.delete(key));
  startInFlight.set(key, run);
  return run;
}

async function performBrainstormRestartOnce(body, rootDir = REPO_ROOT) {
  const reason = String(body.reason || "manual").trim();
  const agentId = String(body.agentId || (reason === "start-brainstorm" ? "start-brainstorm" : "")).trim();
  if (!agentId) throw new Error("agentId is required");

  const pendingPrompt = typeof body.pendingPrompt === "string" ? body.pendingPrompt : "";
  const timer = createSpawnTimer(agentId === "start-brainstorm" ? "new-buddy" : "buddy-restart");

  const injectedClient = body.agentClient || null;
  const client = injectedClient || (body.skipBackend ? null : (body.clientFactory || createAgentClient)(rootDir));
  const backend = getBackend(client);
  let oldAgent = body.oldAgent || null;
  let connected = Boolean(injectedClient);
  // Retiring the predecessor (cancel -> update -> archive, ~4-6 s) runs after the reply is sent; the client closes once it settles.
  let retireDone = null;
  try {
    if (client) {
      try {
        if (!injectedClient && typeof backend.connect === "function") {
          await backend.connect();
          connected = true;
          timer.mark("connect");
        }
        if (!oldAgent && agentId !== "start-brainstorm" && connected && typeof backend.fetchAgent === "function") {
          const fetched = await backend.fetchAgent(agentId).catch(() => null);
          oldAgent = fetched?.agent ?? null;
          timer.mark("fetchAgent");
        }
      } catch {
        if (!oldAgent) oldAgent = null;
      }
    }

    const oldLabels = { ...(oldAgent?.labels ?? {}) };
    // Only known Buddies restart: a lead, worker, unlabelled or unknown id would be retired and archived
    // (S4 mass-archive guard), so anything else fails closed.
    if (agentId !== "start-brainstorm" && !(oldAgent && ["brainstorm", "former-brainstorm"].includes(oldLabels.role))) {
      throw new Error(`not a brainstorm agent: ${agentId}`);
    }
    const laneHint = body.laneId || body.lane || oldLabels.lane || oldLabels.lead || "vibesquad";
    const resolved = laneDisplayName(laneHint, rootDir);
    const laneId = safeSegment(body.laneId || body.lane || resolved.laneId || "vibesquad");
    const teamId = safeSegment(resolved.teamId || body.teamId || body.team || oldLabels.team || "vibesquad");
    const laneUpper = (resolved.laneName || laneId).toUpperCase();
    const topic = String(body.topic ?? oldLabels.topic ?? "").trim();

    if (agentId !== "start-brainstorm" && reason !== "start-brainstorm") {
      if (
        restartedAgents.has(agentId) ||
        oldLabels.role === "former-brainstorm" ||
        Boolean(oldLabels["vs.restarted-into"]) ||
        Boolean(oldAgent?.archivedAt)
      ) {
        return {
          ok: true,
          skipped: true,
          reason: "already-restarted",
          oldAgentId: agentId,
          newAgentId: oldLabels["vs.restarted-into"] || restartedAgents.get(agentId)?.newAgentId || null,
          laneId,
          teamId,
        };
      }
    }

    let liveForBoot; // live agent list for the boot prompt's In-flight block (undefined = not read yet)
    const laneCooldownKey = `${teamId}:${laneId}:${topic.toLowerCase()}`;
    if (reason.startsWith("auto")) {
      const cooldownMs = typeof body.cooldownMs === "number" ? body.cooldownMs : 60_000;
      const lastEntry = lastAutoRestartByLane.get(laneCooldownKey);
      if (lastEntry && Date.now() - lastEntry.ts < cooldownMs) {
        return {
          ok: true,
          skipped: true,
          reason: "cooldown-active",
          oldAgentId: agentId,
          newAgentId: lastEntry.newAgentId,
          laneId,
          teamId,
        };
      }
    }

    if ((reason === "start-brainstorm" || agentId === "start-brainstorm") && !body.forceNew) {
      // Fail closed: if the live-agent list can't be read (daemon restarting), spawning could create a
      // second Buddy for the lane. An empty list gets one retry before it is believed.
      const asList = (res) => (Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : null);
      const readLive = async () => {
        if (body.agents) return body.agents instanceof Map ? [...body.agents.values()] : Array.isArray(body.agents) ? body.agents : [];
        // A client was expected but never connected (runner restarting): unknown, not empty.
        if (client && !connected) return null;
        if (connected && client && typeof backend.fetchAgents === "function") {
          // Runner down (the supervisor is restarting it): unreadable list, not "no agents". fetchAgents below then fails closed.
          await backend.requireRunning?.().catch(() => {});
          const res = await backend.fetchAgents().catch(() => null);
          return asList(res);
        }
        if (connected && client && typeof backend.listAgents === "function") return asList(await backend.listAgents().catch(() => null));
        return [];
      };
      let liveAgents = await readLive();
      if (liveAgents && liveAgents.length === 0 && connected && client && !body.agents) {
        await new Promise((r) => setTimeout(r, typeof body.emptyRetryMs === "number" ? body.emptyRetryMs : 250));
        liveAgents = await readLive();
      }
      if (!liveAgents) {
        return { ok: false, spawned: false, reason: "agent-list-unavailable", error: "Could not read the live agent list; not starting a Buddy so the lane can't get a duplicate. Try again in a moment.", laneId, teamId };
      }
      timer.mark("fetchAgents");
      liveForBoot = liveAgents;
      const existing = findExistingLaneBrainstorm(liveAgents, laneId, topic);
      if (existing) {
        if (existing.labels && existing.labels.team !== teamId) {
          existing.labels = { ...existing.labels, team: teamId };
          await backend?.updateAgent?.(existing.id, { labels: existing.labels })?.catch?.(() => {});
        }
        // Reopen a closed Buddy (daemon restart unloads every session) from its saved session.
        const reopened = existing.status === "closed" && connected && typeof backend?.refreshAgent === "function";
        let reopenedAgent = null;
        let reopenFailed = existing.status === "closed" && !reopened; // nothing here can reopen it
        if (reopened) {
          let refreshFailure = null;
          const refreshed = await backend.refreshAgent(existing.id).catch((e) => {
            // 409, or any throw from a Paseo id (it throws plain Errors for a gone session): replace. A runner (rn-) failure (agent cap, runner down, IPC) leaves a
            // resumable Buddy alone: report the error rather than spawn a second one.
            if (e?.status === 409 || !String(existing.id).startsWith("rn-")) {
              reopenFailed = true;
              console.warn(`[vibesquad] reopen ${existing.id} not resumable: ${e?.message ?? e}; spawning a replacement`);
            } else refreshFailure = e;
            return null;
          });
          if (refreshFailure) {
            const msg = refreshFailure?.message ?? String(refreshFailure);
            console.warn(`[vibesquad] reopen ${existing.id} failed: ${msg}; not replacing`);
            return { ok: false, spawned: false, reason: "reopen-failed", error: `Could not reopen ${existing.title || existing.id}: ${msg}. Try again in a moment.`, existingAgentId: existing.id, laneId, teamId };
          }
          // A backend may hand back the agent still closed without throwing.
          const fresh = refreshed?.agent ?? refreshed;
          if (!reopenFailed && fresh?.status === "closed") reopenFailed = true;
          // A backend that returns nothing gives no status; the reload succeeded, so show it as idle.
          reopenedAgent = fresh?.id ? fresh : { ...existing, status: "idle", archivedAt: null };
        }
        // A Buddy that won't reopen is replaced (the post-spawn backstop retires it), never silently "reused".
        if (!reopenFailed) return {
          ok: true,
          reused: true,
          ...(reopened ? { reopened: true } : {}),
          existingAgentId: existing.id,
          newAgentId: existing.id,
          title: existing.title || buddyTitle(laneId, resolved.laneName, topic, rootDir),
          laneId,
          teamId,
          message: `Open existing brainstorm (${existing.title || existing.id})`,
          agent: reopenedAgent ?? existing,
        };
      }
    }

    const tokens =
      Number(body.usedTokens) ||
      Number(oldLabels["vs.mock-tokens"]) ||
      Number(oldAgent?.contextUsage?.usedTokens) ||
      Number(oldAgent?.lastUsage?.contextWindowUsedTokens) ||
      Number(oldAgent?.lastUsage?.inputTokens) ||
      0;

    if (typeof body.summaryUpdate === "string" && body.summaryUpdate.trim()) {
      writeBrainstormSummary(laneId, body.summaryUpdate, rootDir);
    }
    const summary = readBrainstormSummary(laneId, rootDir);
    // A never-spawned Team (e.g. an EFI pin) starts in its own repo, not wherever VibeSquad runs.
    const cwd = oldAgent?.cwd || laneWorkingDir(teamId, laneId, rootDir) || rootDir;
    const latestPlan = findLanePlanFile(cwd, rootDir, laneId, summary.content);

    if (reason === "handoff") {
      appendVsLogEntry({
        teamId,
        laneId,
        agent: agentId,
        type: "metric",
        text: `tokens-per-plan-handoff: ${tokens} tok (${latestPlan})`,
        refs: [latestPlan, summary.path],
      });
    }

    appendVsLogEntry({
      teamId,
      laneId,
      agent: agentId,
      type: "metric",
      text: `brainstorm-restart (${reason}): ${tokens} tok -> spawning fresh ${buddyTitle(laneId, resolved.laneName, "", rootDir)}`,
      refs: [summary.path, latestPlan],
    });

    const newTitle = buddyTitle(laneId, resolved.laneName, topic, rootDir);

    const rawOldProvider = String(body.provider || oldAgent?.provider || "claude");
    const fallbackProfileName = rawOldProvider.startsWith("antigravity") ? "Brainstorm - Gemini" : "Brainstorm - Claude";
    // Remote callers can't send `profile` (REMOTE_FORBIDDEN_BODY_KEYS): the lane's lastProfile in teams.json decides.
    const bootTeams = loadTeamsConfig(rootDir).teams ?? [];
    const sameId = (x, y) => String(x ?? "").toLowerCase() === String(y ?? "").toLowerCase();
    const bootTeam = bootTeams.find((t) => sameId(t.id, teamId));
    const bootLane = bootTeam?.lanes?.find((l) => sameId(l.id, laneId));
    const laneLastProfile = typeof bootLane?.lastProfile === "string" ? bootLane.lastProfile.trim() : "";
    const { profiles } = loadProfiles(body.profilesPath, { autoSeed: false });
    const rawProfileName = typeof body.profileName === "string" ? body.profileName.trim() : "";
    const validProfileName = rawProfileName
      ? profiles.find((p) => p?.role === "brainstorm" && String(p.name).toLowerCase() === rawProfileName.toLowerCase())?.name ||
        (rawProfileName.toLowerCase() === "brainstorm - claude"
          ? "Brainstorm - Claude"
          : rawProfileName.toLowerCase() === "brainstorm - gemini"
            ? "Brainstorm - Gemini"
            : undefined)
      : undefined;
    const requestedProfile =
      typeof body.profile === "string" && body.profile.trim()
        ? body.profile.trim()
        : validProfileName;
    // On a provider switch an explicit requested profile is authoritative: never fall back to the old
    // labels.profile, which may still point at the opposite provider from an earlier (inverted) switch attempt.
    const desiredProfileKey =
      reason === "provider-switch" && requestedProfile
        ? requestedProfile
        : String(requestedProfile || oldLabels.profile || laneLastProfile || fallbackProfileName).trim();
    let profile = findProfileOrFallback(desiredProfileKey, fallbackProfileName, profiles);
    if (profile && !body.forceProvider) {
      const cappedMap = readCappedProviders({
        useDiskCaps: true,
        ...(body.cappedProviders !== undefined ? { cappedProviders: body.cappedProviders } : {}),
        ...(body.cappedProvidersPath ? { cappedProvidersPath: body.cappedProvidersPath } : {}),
      });
      const usageList = [
        ...(Array.isArray(body.usageProviders) ? body.usageProviders : []),
        ...Object.keys(cappedMap).map((id) => ({ id, status: "exhausted", usedPct: 100 })),
      ];
      if (usageList.length > 0) {
        const fo = resolveProfileWithFailover(profile, profiles, usageList, {
          useDiskCaps: true,
          ...(body.cappedProviders !== undefined ? { cappedProviders: body.cappedProviders } : {}),
        });
        if (fo.failedOver && fo.profile) {
          profile = fo.profile;
        }
      }
    }

    const spawnCfg = profile
      ? toPaseoSpawnConfig(profile)
      : {
          provider: rawOldProvider.includes("/") ? rawOldProvider.split("/")[0] : rawOldProvider,
          model:
            oldAgent?.model ||
            (rawOldProvider.includes("/")
              ? rawOldProvider.split("/").slice(1).join("/")
              : rawOldProvider.startsWith("antigravity")
                ? "gemini-4-argon"
                : "claude-opus-5-5"),
          modeId: oldAgent?.modeId || (rawOldProvider.startsWith("antigravity-cli") ? "accept-edits" : "auto"),
          thinkingOptionId: oldAgent?.thinkingOptionId || "medium",
          ...(oldAgent?.featureValues ? { featureValues: { ...oldAgent.featureValues } } : {}),
          notes: "",
          systemPrompt: "",
        };

    const provider = spawnCfg.provider;
    // A staged provider switch can override the profile's default model / mode / thinking with the values the
    // user picked in the top bar. Empty strings fall back to the profile's defaults so a bare profileName still works.
    const model = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : spawnCfg.model;
    const modeId = (typeof body.modeId === "string" && body.modeId.trim()) ? body.modeId.trim() : spawnCfg.modeId;
    const thinkingOptionId = (typeof body.thinkingOptionId === "string" && body.thinkingOptionId.trim()) ? body.thinkingOptionId.trim() : spawnCfg.thinkingOptionId;
    // When the caller staged an explicit model/mode/thinking override, the plugin's before("agent.create") and
    // enforceProfileAfterSpawn must keep those values instead of rewriting them back to the matched profile's defaults.
    const hasCallerOverride =
      (typeof body.model === "string" && body.model.trim()) ||
      (typeof body.modeId === "string" && body.modeId.trim()) ||
      (typeof body.thinkingOptionId === "string" && body.thinkingOptionId.trim());
    const featureValues = spawnCfg.featureValues ? { ...spawnCfg.featureValues } : undefined;

    const newLabels = {
      team: teamId,
      lane: laneId,
      lead: laneId,
      role: "brainstorm",
      ...(topic ? { topic } : {}),
      ...(oldLabels["vs.inbox-card-id"] ? { "vs.inbox-card-id": oldLabels["vs.inbox-card-id"] } : {}),
      profile: profile?.name || oldLabels.profile || fallbackProfileName,
      ...(hasCallerOverride ? { "profile-override": "1" } : {}),
      "vs.restarted-from": agentId,
      "vs.restart-tokens": String(tokens),
      "vs.restart-reason": reason,
      // Pinned-team quick start: the drawer shows "── Fresh session · from brief ⋯ ──" for this label.
      ...(body.mode === "quick-start" ? { "vs.fresh-session": "brief" } : {}),
    };
    timer.mark("prep");
    if (liveForBoot === undefined) {
      const src = body.agents
        ? (body.agents instanceof Map ? [...body.agents.values()] : body.agents)
        : connected && client && typeof backend.fetchAgents === "function"
          ? await Promise.race([
              backend.fetchAgents().then((r) => (Array.isArray(r) ? r : Array.isArray(r?.entries) ? r.entries : Array.isArray(r?.agents) ? r.agents : null)),
              new Promise((r) => setTimeout(() => r(null), 1500)),
            ]).catch(() => null)
          : null;
      liveForBoot = Array.isArray(src) ? src : null;
    }
    timer.mark("inFlight");
    const isBootHub = Boolean(bootTeam && !topic && (bootLane ? isHubLane(bootTeam, bootLane) : isHubLane(bootTeam, { id: laneId })));
    const hubTeams = isBootHub ? hubTeamsBlock({ team: bootTeam, agents: liveForBoot }) : "";
    const initialPrompt = buildBrainstormInitialPrompt({
      hubTeams,
      inFlight: liveInFlightBlock({ agents: liveForBoot, laneId, teamId }),
      laneId,
      laneUpper,
      buddyName: newTitle,
      summaryContent: summary.content,
      latestPlan,
      pendingPrompt,
      vibeMode: bootTeam?.vibeMode === true,
      autoRetire: reason.startsWith("auto"),
    });

    // The spawn env sets VS_BRIEF_INLINE, so the plugin won't log brief-injected; this is the live check for the lane.
    try {
      appendVsLogEntry({ teamId, laneId, agent: agentId, type: "metric", text: `brief-inlined: lane=${laneId} chars=${summary.content.length}` });
    } catch {}
    let created = null;
    let spawnErrParts = null;
    if (connected && client && typeof backend.createAgent === "function") {
      const spawnStartMs = Date.now();
      try {
        created = await backend.createAgent({
          config: {
            provider,
            model,
            cwd,
            title: newTitle,
            modeId,
            thinkingOptionId,
            ...(featureValues && Object.keys(featureValues).length ? { featureValues } : {}),
            ...(spawnCfg.systemPrompt ? { systemPrompt: spawnCfg.systemPrompt } : {}),
          },
          ...(oldAgent?.workspaceId ? { workspaceId: oldAgent.workspaceId } : {}),
          initialPrompt,
          labels: newLabels,
          // Labels never reach the plugin's before(agent.create); env does, so the profile is forced at spawn.
          env: { VS_ROLE: "brainstorm", ...(newLabels.profile ? { VS_PROFILE: newLabels.profile } : {}), ...(hasCallerOverride ? { VS_PROFILE_OVERRIDE: "1" } : {}), VS_LANE: laneId, VS_TEAM: teamId, VS_BRIEF_INLINE: "1" },
        });
      } catch (err) {
        spawnErrParts = err?.[SPAWN_TIMING] ?? null;
        if (isCreateTimeoutError(err)) {
          const recovered = await recoverTimedOutCreate({
            backend,
            labels: newLabels,
            title: newTitle,
            initialPrompt,
            startedMs: spawnStartMs,
            ...(body.createRecovery ?? {}),
          }).catch(() => null);
          if (recovered) created = recovered;
        }
        if (!created) try {
          const raw =
            typeof backend.fetchAgents === "function"
              ? await backend.fetchAgents()
              : typeof backend.listAgents === "function"
                ? await backend.listAgents()
                : null;
          const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw?.agents) ? raw.agents : [];
          for (const item of list) {
            const a = item?.agent ?? item;
            if (!a?.id || a.archivedAt || a.id === oldAgent?.id || a.id === agentId) continue;
            const labels = a.labels ?? {};
            const isLaneBs =
              effectiveAgentRole({ labels }) === "brainstorm" &&
              sameLane(a, laneId) &&
              (!teamId || !labels.team || sameId(labels.team, teamId)) &&
              parseBrainstormTopic(a) === topic.toLowerCase();
            if (!isLaneBs && a.title !== newTitle) continue;
            const ts = Date.parse(a.createdAt || a.updatedAt || "");
            const isRecent = Number.isFinite(ts) && ts >= spawnStartMs - 5000;
            if (a.status === "initializing" || a.status === "error" || isRecent) {
              await backend.archiveAgent?.(a.id)?.catch?.(() => {});
            }
          }
        } catch {}
        if (!created) {
          // The 252s stall lives on the timeout/throw path: report the partial per-await timing before failing.
          timer.mark("createAgent", formatSpawnSubParts(spawnErrParts));
          timer.flush({ teamId, laneId, agent: agentId });
          throw err;
        }
      }
    }

    const createParts = created?.[SPAWN_TIMING] ?? spawnErrParts;
    timer.mark("createAgent", formatSpawnSubParts(createParts));
    const spawned = Boolean(created?.id);
    if (!created) {
      created = {
        id: `bs-${laneId}-${Date.now().toString(36)}`,
        title: newTitle,
        provider,
        model,
        modeId,
        thinkingOptionId,
        ...(featureValues ? { featureValues } : {}),
        cwd,
        status: "idle",
        labels: { ...newLabels },
        updatedAt: new Date().toISOString(),
        pendingPermissions: [],
        requiresAttention: false,
      };
    } else {
      const mergedLabels = { ...(created.labels ?? {}), ...newLabels };
      delete mergedLabels["vs.mock-tokens"];
      created = {
        ...created,
        title: created.title || newTitle,
        modeId: created.modeId ?? modeId,
        thinkingOptionId: created.thinkingOptionId ?? thinkingOptionId,
        ...(featureValues && !created.featureValues ? { featureValues } : {}),
        labels: mergedLabels,
      };
    }

    if (agentId !== "start-brainstorm") {
      const retiredLabels = {
        ...oldLabels,
        role: "former-brainstorm",
        "vs.restarted-into": created.id,
      };
      delete retiredLabels["vs.mock-tokens"];
      restartedAgents.set(agentId, { newAgentId: created.id, ts: Date.now(), tokens });
      if (oldAgent && typeof oldAgent === "object") {
        oldAgent.labels = retiredLabels;
        oldAgent.archivedAt = oldAgent.archivedAt || new Date().toISOString();
      }
      if (connected && client) {
        const rawOldTitle = String(oldAgent?.title || newTitle).trim();
        const retiredTitle = rawOldTitle.toLowerCase().startsWith("(old)") ? rawOldTitle : `(old) ${rawOldTitle}`;
        const retireT0 = Date.now();
        retireDone = (async () => {
          await backend.cancelAgent?.(agentId)?.catch?.(() => {});
          await backend.updateAgent?.(agentId, { name: retiredTitle, labels: retiredLabels })?.catch?.(() => {});
          await archiveBuddyKeepingChildren(client, agentId);
          console.log(`[vibesquad] spawn-timing retire-background=${Date.now() - retireT0}ms`);
        })().catch(() => {});
        if (reason.startsWith("auto")) {
          await retireDone;
          retireDone = null;
        }
      }
    }
    if (reason.startsWith("auto")) {
      appendVsLogEntry({
        teamId,
        laneId,
        agent: agentId,
        type: "metric",
        text: `brainstorm-retired (${reason}): ${tokens} tok, successor=${created.id}`,
        refs: [summary.path, created.id],
      });
      try {
        const live = body.agents
          ? body.agents instanceof Map ? [...body.agents.values()] : body.agents
          : connected && client
            ? await listDaemonAgents(client)
            : null;
        if (Array.isArray(live) && live.length) {
          const withoutOld = live.filter((a) => (a?.agent ?? a)?.id !== agentId);
          if (spawned && !withoutOld.some((a) => (a?.agent ?? a)?.id === created.id)) {
            withoutOld.push(created);
          }
          refreshWhosHere({ laneId, agents: withoutOld, rootDir });
        }
      } catch {}
    }
    if (spawned) {
      // Backstop (PLAN_BUGS_BATCH2 block 0): the start-brainstorm path above never retires anyone, and the
      // plugin's agent.created retire skips closed Buddies. Wait a moment so the plugin retires the live ones
      // first (with its brief snapshot); this then catches whatever is still role=brainstorm in the lane.
      // It uses its own client so the spawn's client still closes as soon as the restart retire settles.
      const delayMs = typeof body.backstopDelayMs === "number" ? body.backstopDelayMs : 5000;
      const newId = created.id;
      void (async () => {
        await new Promise((r) => setTimeout(r, delayMs).unref?.()); // the HTTP server keeps the process up
        const c = getBackend(injectedClient || (body.clientFactory || createAgentClient)(rootDir));
        try {
          if (!injectedClient) await c.connect?.();
          await retireOtherLaneBuddies(c, { newId, teamId, laneId, topic, exceptIds: [agentId] });
        } finally {
          if (!injectedClient) await c.close?.()?.catch?.(() => {});
        }
      })().catch((e) => console.warn(`[vibesquad] duplicate-Buddy backstop failed: ${e?.message ?? e}`));
    }
    timer.flush({ teamId, laneId, agent: created.id });

    if (reason.startsWith("auto")) {
      lastAutoRestartByLane.set(laneCooldownKey, {
        newAgentId: created.id,
        ts: Date.now(),
        oldAgentId: agentId,
      });
    }

    return {
      ok: true,
      ...(reason.startsWith("auto") ? { retired: true } : {}),
      oldAgentId: agentId,
      newAgentId: created.id,
      title: created.title || newTitle,
      laneId,
      teamId,
      usedTokens: tokens,
      summaryPath: summary.path,
      latestPlan,
      spawnConfig: spawnCfg,
      profile: newLabels.profile,
      agent: created,
      ...(pendingPrompt ? { pendingPrompt } : {}),
    };
  } finally {
    timer.stop(); // every return/throw path: the 50ms lag sampler must not outlive the spawn
    if (!injectedClient && client && typeof backend.close === "function") {
      if (retireDone) retireDone.finally(() => backend.close().catch(() => {}));
      else await backend.close().catch(() => {});
    }
  }
}
