// K1 (PLAN_INBOX_TOP3_1121, idea-416): idle-lane kick. A lane whose live lead (or its Buddy, when the lane has no lead) has sat idle past
// idleMs with NO running workers, NO armed watch, NO open needs-you / permission prompt, but OPEN work, gets ONE steer naming the top item.
// A second idle episode on the same item within escalateMs goes to the Squad Overlord instead; at most 1 kick + 1 escalation per item. Reuses the watch-sets
// plumbing: listWatches (armed check), findOpenWorkersForLead's worker rule, readLaneLogEntries. All I/O is injected so tests use fake clocks.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { effectiveAgentRole, isLiveAgent, loadTeamsRegistry, resolveAgentIdentity, isDigestAgent } from "./identity.mjs";
import { isHubLane } from "./lane-pure.mjs";
import { watchesPath } from "./watch-sets.mjs";
import { findOpenWorkersForLead } from "./lead-handoff.mjs";
import { briefRootFor } from "./brief-path.mjs";
import { getInboxPath } from "./inbox.mjs";
import { appendVsLogEntry } from "./brainstorm.mjs";

export const IDLE_KICK_MIN = 10;
export const IDLE_KICK_ESCALATE_MIN = 30;
export const IDLE_KICK_TICK_MS = 60_000;
// Allowlist: a unit is open work only in a live state. done/superseded/dropped/blocked/deferred/anything unknown is not.
const OPEN_UNIT = new Set(["todo", "running", "ready", "open", "pending", "queued", "in-progress", "in_progress", "inprogress"]);
export const IDLE_KICK_WORK_TTL_MS = 5 * 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
const NEEDS_YOU_MAX_AGE_MS = 7 * 24 * 3_600_000;
const BUSY = new Set(["running", "queued", "initializing", "starting", "working"]);

export const kickText = (item) => `You are idle with open work: ${item}. Pick the next and go (R13); if blocked, log needs-you.`;
export const escalateText = (lane, item, mins) => `Lane ${lane} went idle again on "${item}" within ${mins} min of an idle-kick and has not moved. Unblock it or re-route it.`;

/** Open TASKS.json units (todo/running/ready; done and blocked excluded) -> "unit-id: goal" strings. */
async function readJsonAsync(file, fallback) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

/** Open TASKS.json units (live states only) -> "unit-id: goal" strings. Async: never blocks the server loop. */
export async function openTaskUnits(tasksPath) {
  const j = await readJsonAsync(tasksPath, {});
  return (j.units ?? []).filter((u) => OPEN_UNIT.has(String(u.status ?? "todo").toLowerCase())).map((u) => `${u.id}${u.goal ? `: ${String(u.goal).slice(0, 100)}` : ""}`);
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

/** Tail of one file (last LOG_TAIL_BYTES), async. */
async function tailText(file) {
  try {
    const t = await readFile(file, "utf8");
    return t.length > LOG_TAIL_BYTES ? t.slice(-LOG_TAIL_BYTES) : t;
  } catch {
    return "";
  }
}

const homeOf = (baseHome) => baseHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
const seg = (x) => String(x ?? "").replace(/[^A-Za-z0-9._-]/g, "_");

/** Open needs-you: a lane agent carries the needs-you label, or the lane log (tail, last 7d) has a needs-you newer than its newest decision/you. */
export async function laneHasOpenNeedsYou({ teamId, laneId, baseHome, agents = [], nowMs = Date.now() }) {
  if (agents.some((a) => a?.labels?.["needs-you"])) return true;
  const text = await tailText(join(homeOf(baseHome), "logs", `${seg(teamId)}--${seg(laneId)}.jsonl`));
  let need = 0, answer = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      const ts = Date.parse(e.ts) || 0;
      if (e.type === "needs-you" && nowMs - ts <= NEEDS_YOU_MAX_AGE_MS) need = Math.max(need, ts);
      else if (e.type === "decision" || e.type === "you") answer = Math.max(answer, ts);
    } catch {}
  }
  return need > answer;
}

/** Owners with an armed (open) watch set, one async read of watches.json. */
export async function armedWatchOwners(baseHome) {
  const doc = await readJsonAsync(watchesPath({ home: baseHome }), { sets: [] });
  return new Set((doc.sets ?? []).filter((s) => !s.firedAt && !s.cancelledAt).map((s) => s.owner));
}

/** Open work in priority order: TASKS.json live units, then plan blocks not PASS in the brief.
 * Inbox cards are triage items, not lane work, EXCEPT a plain new card (status "parked", no parkedAt marker)
 * and an "accepted" card (Review L1: accepted is actionable), which still count. An explicitly parked card
 * (triage --park stamps parkedAt) and archived/handed-off/rejected cards are skipped (idea-481). */
export async function laneOpenWork({ teamId, laneId, rootDir, baseHome }) {
  const root = briefRootFor(teamId, laneId, rootDir);
  const items = await openTaskUnits(join(root, "docs", "lanes", laneId, "TASKS.json"));
  const inbox = await readJsonAsync(getInboxPath(baseHome), []);
  const cards = Array.isArray(inbox) ? inbox : Array.isArray(inbox?.cards) ? inbox.cards : [];
  const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  for (const c of cards) {
    // idea-481: an explicitly parked card (triage --park stamps parkedAt) waits for triage; and any non-parked
    // status except "accepted" (archived/handed-off/rejected) is not open lane work. A plain new card (status
    // "parked", no marker) and an accepted card still count.
    if (c.parkedAt) continue;
    if (c.status && c.status !== "parked" && c.status !== "accepted") continue;
    if (!sameId(c.laneId, laneId) || !sameId(c.teamId, teamId)) continue;
    items.push(`${c.id} ${String(c.title ?? c.text ?? "").slice(0, 80)}`.trim());
  }
  try {
    items.push(...openPlanBlocks(await readFile(join(root, "docs", "brainstorm", `${laneId}.md`), "utf8")));
  } catch {}
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
  armedOwners = () => armedWatchOwners(baseHome), // async: ONE read of watches.json per tick
  openNeedsYou = (teamId, laneId, agents) => laneHasOpenNeedsYou({ teamId, laneId, baseHome, agents, nowMs: now() }),
  openWork = (teamId, laneId) => laneOpenWork({ teamId, laneId, rootDir, baseHome }),
  workTtlMs = IDLE_KICK_WORK_TTL_MS,
  log = ({ teamId, laneId, text }) => appendVsLogEntry({ teamId, laneId, agent: "vibesquad-server", type: "metric", text }),
} = {}) {
  const idleSince = new Map(); // agent id -> ms first seen idle (or its lastProgressAt)
  const episode = new Map(); // lane key -> { acted } (one action per idle episode)
  const itemState = new Map(); // `${laneKey}|${item}` -> { at, escalated }: at most 1 kick + 1 escalation per item until the item changes
  const workCache = new Map(); // lane key -> { at, items } (TASKS/inbox/brief reads cached for workTtlMs)
  let regCache = { at: -Infinity, reg: [] };
  const keyOf = (t, l) => `${t}/${l}`.toLowerCase();
  const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  async function tick() {
    const t0 = now();
    const agents = ((await listAgents()) ?? []).filter((a) => a && isLiveAgent(a) && !isDigestAgent(a));
    if (t0 - regCache.at > workTtlMs) regCache = { at: t0, reg: teams() };
    const reg = regCache.reg;
    let owners = null;
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
      const ep = episode.get(k) ?? { acted: false };
      episode.set(k, ep);
      if (ep.acted) continue; // never twice per episode
      // no running workers (lane workers, per findOpenWorkersForLead's rule)
      if (findOpenWorkersForLead(agents.filter((a) => a.id !== target.id), target, lane.teamId, lane.laneId).some((w) => BUSY.has(String(w.status ?? "").toLowerCase()))) continue;
      if (lane.agents.some(({ a }) => (a.pendingPermissions?.length ?? 0) > 0 || a.requiresAttention === true)) continue;
      owners ??= await armedOwners();
      if (lane.agents.some(({ a }) => owners.has(a.id))) continue;
      if (await openNeedsYou(lane.teamId, lane.laneId, lane.agents.map((x) => x.a))) continue;
      let wc = workCache.get(k);
      if (!wc || t0 - wc.at > workTtlMs) workCache.set(k, (wc = { at: t0, items: await openWork(lane.teamId, lane.laneId) }));
      if (!wc.items.length) continue;
      const item = wc.items[0];
      for (const key of [...itemState.keys()]) if (key.startsWith(`${k}|`) && key !== `${k}|${item}`) itemState.delete(key); // item changed: reset
      const fresh = await freshAgent(target.id);
      if (fresh && String(fresh.status ?? "").toLowerCase() !== "idle") continue; // never kick mid-turn
      const st = itemState.get(`${k}|${item}`);
      if (st) {
        if (st.escalated || t0 - st.at > escalateMs) continue; // 1 kick + 1 escalation per item; no re-kick
        ep.acted = true;
        st.escalated = true;
        const ov = agents.find((a) => {
          if (effectiveAgentRole(a) !== "lead") return false;
          const i = resolveAgentIdentity(a, { teams: reg, cwd: a.cwd });
          if (i.isOrphan || !sameId(i.teamId, lane.teamId)) return false;
          const ld = (team?.lanes ?? []).find((l) => sameId(l.id, i.laneId));
          return !!ld && isHubLane(team, ld);
        });
        if (ov) await send(ov.id, escalateText(lane.laneId, item, Math.round(escalateMs / 60_000)));
        log({ teamId: lane.teamId, laneId: lane.laneId, text: `idle-escalate lane=${lane.laneId} item=${item}` });
        results.push({ lane: lane.laneId, action: "escalate", item });
        continue;
      }
      ep.acted = true;
      itemState.set(`${k}|${item}`, { at: t0, escalated: false });
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
