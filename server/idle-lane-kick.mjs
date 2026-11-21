// K1 (PLAN_INBOX_TOP3_1121, idea-416): idle-lane kick. A lane whose live lead (or its Buddy, when the lane has no lead) has sat idle past
// idleMs with NO running workers, NO armed watch, NO open needs-you / permission prompt, but OPEN work, gets ONE steer naming the top item.
// A second idle episode on the same item within escalateMs goes to the Squad Overlord instead (never a second kick). Reuses the watch-sets
// plumbing: listWatches (armed check), findOpenWorkersForLead's worker rule, readLaneLogEntries. All I/O is injected so tests use fake clocks.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveAgentRole, isLiveAgent, loadTeamsRegistry, resolveAgentIdentity, isDigestAgent } from "./identity.mjs";
import { isHubLane } from "./lane-pure.mjs";
import { listWatches } from "./watch-sets.mjs";
import { findOpenWorkersForLead, readLaneLogEntries } from "./lead-handoff.mjs";
import { briefRootFor } from "./brief-path.mjs";
import { listInboxCards } from "./inbox.mjs";
import { appendVsLogEntry } from "./brainstorm.mjs";

export const IDLE_KICK_MIN = 10;
export const IDLE_KICK_ESCALATE_MIN = 30;
export const IDLE_KICK_TICK_MS = 60_000;
const DONE_UNIT = new Set(["done", "merged", "closed", "cancelled", "canceled", "blocked", "archived"]);
const BUSY = new Set(["running", "queued", "initializing", "starting", "working"]);

export const kickText = (item) => `You are idle with open work: ${item}. Pick the next and go (R13); if blocked, log needs-you.`;
export const escalateText = (lane, item, mins) => `Lane ${lane} went idle again on "${item}" within ${mins} min of an idle-kick and has not moved. Unblock it or re-route it.`;

/** Open TASKS.json units (todo/running/ready; done and blocked excluded) -> "unit-id: goal" strings. */
export function openTaskUnits(tasksPath) {
  try {
    if (!existsSync(tasksPath)) return [];
    const j = JSON.parse(readFileSync(tasksPath, "utf8").replace(/^﻿/, ""));
    return (j.units ?? []).filter((u) => !DONE_UNIT.has(String(u.status ?? "todo").toLowerCase())).map((u) => `${u.id}${u.goal ? `: ${String(u.goal).slice(0, 100)}` : ""}`);
  } catch {
    return [];
  }
}

/** Plan blocks in the lane brief not PASS: list lines starting with a block id (K1, T2a ...) that say todo/open/pending/not started/running. */
export function openPlanBlocks(briefText) {
  const out = [];
  for (const line of String(briefText ?? "").split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\**([A-Z]{1,3}\d+[a-z]?)\b/.exec(line);
    if (!m || /\bPASS\b/.test(line) || !/\b(todo|open|pending|not started|queued|running|in progress)\b/i.test(line)) continue;
    out.push(`plan block ${m[1]}`);
  }
  return out;
}

/** An open needs-you: the lane's newest needs-you entry (last 24h) is newer than its newest decision/you answer. */
export function laneHasOpenNeedsYou({ teamId, laneId, baseHome, nowMs = Date.now() }) {
  try {
    const entries = readLaneLogEntries({ teamId, laneId, sinceIso: new Date(nowMs - 24 * 3_600_000).toISOString(), baseHome }).filter((e) => String(e.lane ?? laneId).toLowerCase() === String(laneId).toLowerCase());
    const ts = (types) => Math.max(0, ...entries.filter((e) => types.includes(e.type)).map((e) => Date.parse(e.ts) || 0));
    return ts(["needs-you"]) > ts(["decision", "you"]);
  } catch {
    return false;
  }
}

/** Open work in priority order: TASKS.json units, parked inbox cards, plan blocks not PASS in the brief. */
export function laneOpenWork({ teamId, laneId, rootDir, baseHome }) {
  const root = briefRootFor(teamId, laneId, rootDir);
  const items = openTaskUnits(join(root, "docs", "lanes", laneId, "TASKS.json"));
  try {
    for (const c of listInboxCards({ laneId, status: "parked", baseHome }, rootDir)) items.push(`${c.id} ${String(c.title ?? c.text ?? "").slice(0, 80)}`.trim());
  } catch {}
  const brief = join(root, "docs", "brainstorm", `${laneId}.md`);
  if (existsSync(brief)) items.push(...openPlanBlocks(readFileSync(brief, "utf8")));
  return items;
}

export function createIdleLaneKick({
  rootDir,
  baseHome,
  listAgents,
  freshAgent = async () => null, // id -> latest agent (mid-turn guard right before sending)
  send,
  now = () => Date.now(),
  idleMs = IDLE_KICK_MIN * 60_000,
  escalateMs = IDLE_KICK_ESCALATE_MIN * 60_000,
  teams = () => loadTeamsRegistry(rootDir),
  armedWatch = (id) => listWatches({ owner: id }, { home: baseHome }).length > 0,
  openNeedsYou = (teamId, laneId) => laneHasOpenNeedsYou({ teamId, laneId, baseHome }),
  openWork = (teamId, laneId) => laneOpenWork({ teamId, laneId, rootDir, baseHome }),
  log = ({ teamId, laneId, text }) => appendVsLogEntry({ teamId, laneId, agent: "vibesquad-server", type: "metric", text }),
} = {}) {
  const idleSince = new Map(); // agent id -> ms first seen idle (or its lastProgressAt)
  const episode = new Map(); // lane key -> { kicked, escalated }
  const lastKick = new Map(); // `${laneKey}|${item}` -> ms of the kick
  const keyOf = (t, l) => `${t}/${l}`.toLowerCase();
  const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  async function tick() {
    const t0 = now();
    const agents = ((await listAgents()) ?? []).filter((a) => a && isLiveAgent(a) && !isDigestAgent(a));
    const reg = teams();
    const byLane = new Map();
    for (const a of agents) {
      const id = resolveAgentIdentity(a, { teams: reg, cwd: a.cwd });
      if (id.isOrphan || !id.teamId || !id.laneId) continue;
      const k = keyOf(id.teamId, id.laneId);
      if (!byLane.has(k)) byLane.set(k, { teamId: id.teamId, laneId: id.laneId, agents: [] });
      byLane.get(k).agents.push({ a, role: effectiveAgentRole(a) });
    }
    const liveIds = new Set(agents.map((a) => a.id));
    for (const id of [...idleSince.keys()]) if (!liveIds.has(id)) idleSince.delete(id);
    for (const a of agents) {
      if (String(a.status ?? "").toLowerCase() === "idle") {
        if (!idleSince.has(a.id)) {
          const p = Date.parse(a.lastProgressAt ?? "");
          idleSince.set(a.id, Number.isFinite(p) && p <= t0 ? p : t0);
        }
      } else idleSince.delete(a.id);
    }
    const results = [];
    for (const [k, lane] of byLane) {
      const team = (reg ?? []).find((t) => sameId(t.id, lane.teamId));
      const laneDef = (team?.lanes ?? []).find((l) => sameId(l.id, lane.laneId));
      if (team && laneDef && isHubLane(team, laneDef)) continue;
      const lead = lane.agents.find((x) => x.role === "lead");
      const target = (lead ?? lane.agents.find((x) => x.role === "brainstorm" || x.role === "buddy"))?.a;
      if (!target) continue;
      // A lead or Buddy still turning means the lane is not idle: the episode is over.
      if (lane.agents.some(({ a, role }) => role !== "worker" && BUSY.has(String(a.status ?? "").toLowerCase()))) {
        episode.delete(k);
        continue;
      }
      if (!idleSince.has(target.id)) {
        episode.delete(k);
        continue;
      }
      if (t0 - idleSince.get(target.id) < idleMs) continue;
      const ep = episode.get(k) ?? { kicked: false, escalated: false };
      episode.set(k, ep);
      if (ep.kicked || ep.escalated) continue; // never twice per episode
      // no running workers (lane workers, per findOpenWorkersForLead's rule)
      if (findOpenWorkersForLead(agents.filter((a) => a.id !== target.id), target, lane.teamId, lane.laneId).some((w) => BUSY.has(String(w.status ?? "").toLowerCase()))) continue;
      if (lane.agents.some(({ a }) => armedWatch(a.id))) continue;
      if (lane.agents.some(({ a }) => (a.pendingPermissions?.length ?? 0) > 0 || a.requiresAttention === true)) continue;
      if (openNeedsYou(lane.teamId, lane.laneId)) continue;
      const items = openWork(lane.teamId, lane.laneId);
      if (!items.length) continue;
      const item = items[0];
      const fresh = await freshAgent(target.id);
      if (fresh && String(fresh.status ?? "").toLowerCase() !== "idle") continue; // never kick mid-turn
      const prev = lastKick.get(`${k}|${item}`);
      if (prev != null && t0 - prev <= escalateMs) {
        const ov = agents.find((a) => {
          if (effectiveAgentRole(a) !== "lead") return false;
          const i = resolveAgentIdentity(a, { teams: reg, cwd: a.cwd });
          if (i.isOrphan || !sameId(i.teamId, lane.teamId)) return false;
          const ld = (team?.lanes ?? []).find((l) => sameId(l.id, i.laneId));
          return !!ld && isHubLane(team, ld);
        });
        ep.escalated = true;
        if (ov) await send(ov.id, escalateText(lane.laneId, item, Math.round(escalateMs / 60_000)));
        log({ teamId: lane.teamId, laneId: lane.laneId, text: `idle-escalate lane=${lane.laneId} item=${item}` });
        results.push({ lane: lane.laneId, action: "escalate", item });
        continue;
      }
      ep.kicked = true;
      lastKick.set(`${k}|${item}`, t0);
      await send(target.id, kickText(item));
      log({ teamId: lane.teamId, laneId: lane.laneId, text: `idle-kick lane=${lane.laneId} item=${item}` });
      results.push({ lane: lane.laneId, action: "kick", item });
    }
    return results;
  }
  return { tick };
}

/** Server wiring: one tick a minute against the runner's roster. Returns { stop }. */
export function startIdleLaneKick({ runner, rootDir, baseHome, tickMs = IDLE_KICK_TICK_MS, ...rest } = {}) {
  const kick = createIdleLaneKick({
    rootDir,
    baseHome,
    listAgents: () => runner.listAgents(),
    freshAgent: async (id) => (await runner.fetchAgent(id).catch(() => null))?.agent ?? null,
    send: (id, text) => runner.sendAgentPrompt(id, text),
    ...rest,
  });
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    kick.tick().catch((e) => console.warn(`[vibesquad] idle-lane-kick: ${e?.message ?? e}`)).finally(() => { running = false; });
  }, tickMs);
  t.unref?.();
  return { stop: () => clearInterval(t), tick: kick.tick };
}
