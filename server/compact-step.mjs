// K2 (PLAN_COMPACT_IN_PLACE_1108): the compact-before-handoff step shared by the Buddy watcher (token-watch.mjs) and the lead ladder
// (lead-handoff.mjs). Claude agents only: the runner keeps one long-lived `claude -p` child, so a `/compact <focus>` user turn shrinks the
// context in place (same id, labels, worktree). Anything else -- non-Claude, busy, already tried, failed, timed out, still over the cap --
// returns a non-"ok" outcome and the caller runs its existing handoff ladder unchanged. Reuses runner.sendAgentPrompt; no new route.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEAD_COMPACT_FOCUS, leadUsedTokens } from "./lead-handoff.mjs";
import { vibesquadHome } from "./user-settings.mjs";

export const COMPACTED_AT_LABEL = "vs.compacted-at";
export const COMPACT_TIMEOUT_MS = 120_000;
export const COMPACT_SETTLE_MS = 1_500;

export const BUDDY_COMPACT_FOCUS = "keep Decided / Open / In flight (the brief), the current lane plan, and worker ids";

const COMPACT_INPUT_RE = /^\s*\/compact\b/i;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * Cost + tokens of the `/compact` turn from the agent's raw runner-log events (the live timeline events carry only seq + type, and the
 * agent snapshot's usage is a per-call overwrite with no cost, so the log is the one place `turn_done.costUsd` (session-cumulative)
 * and `usage` live). Anchors on the last `compacted` event and the last `/compact` input before it; a turn_done between the two
 * (the /compact arrived mid-turn, so that turn ended first) resets the tokens and moves the cost baseline. Usage after `compacted`
 * is the adapter's synthetic post_tokens context meter, never spend. Returns { costUsd?, tokens } or null without a /compact anchor.
 */
export function compactSpendFromLog(events) {
  let c = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "compacted") { c = i; break; }
  if (c < 0) return null;
  let j = -1;
  for (let i = c - 1; i >= 0; i--) if (events[i]?.type === "input" && COMPACT_INPUT_RE.test(String(events[i].text ?? ""))) { j = i; break; }
  if (j < 0) return null;
  let base = 0;
  for (let i = j - 1; i >= 0; i--) if (events[i]?.type === "turn_done" && Number.isFinite(Number(events[i].costUsd))) { base = Number(events[i].costUsd); break; }
  let tokens = 0;
  for (let i = j + 1; i < c; i++) {
    const e = events[i];
    if (e?.type === "usage") tokens += num(e.inputTokens) + num(e.outputTokens);
    else if (e?.type === "turn_done") { tokens = 0; if (Number.isFinite(Number(e.costUsd))) base = Number(e.costUsd); }
  }
  for (let i = c + 1; i < events.length; i++) {
    if (events[i]?.type !== "turn_done") continue;
    const cost = Number(events[i].costUsd);
    if (!Number.isFinite(cost)) return { tokens };
    return { costUsd: Math.round((cost >= base ? cost - base : cost) * 1e6) / 1e6, tokens };
  }
  return { tokens }; // turn_done not logged yet
}

/** Default log reader: the tail (last 512KB) of <VIBESQUAD_HOME>/runner/agents/<id>.jsonl as parsed events; [] when unreadable. */
function readAgentLogTail(id) {
  try {
    const file = join(vibesquadHome(), "runner", "agents", `${id}.jsonl`);
    const size = statSync(file).size;
    const from = Math.max(0, size - 512 * 1024);
    const fd = openSync(file, "r");
    let text;
    try { const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from); text = buf.toString("utf8"); } finally { closeSync(fd); }
    const lines = text.split("\n");
    if (from > 0) lines.shift(); // torn first line
    return lines.flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
  } catch { return []; }
}

export function isClaudeAgent(agent) {
  return String(agent?.provider ?? "").toLowerCase() === "claude";
}

/** Idle = not mid-turn. A `/compact` while running would steer into the live turn, so the caller defers or skips. */
export function isIdleForCompact(agent) {
  const s = String(agent?.status ?? "").toLowerCase();
  return s === "idle" || s === "ready" || s === "";
}

/**
 * deps: runner (sendAgentPrompt, updateAgent, fetchAgent, subscribeEvents), log({agent, text, teamId, laneId}) (lane-aware),
 * timeoutMs, settleMs, readEvents(id) (parsed runner-log events; default reads the agent log under VIBESQUAD_HOME). run() never throws; its outcome is one of
 * ok | still-over | failed | timeout | skipped (skipped carries a reason and sends nothing).
 */
export function createCompactor({ runner, log = () => {}, timeoutMs = COMPACT_TIMEOUT_MS, settleMs = COMPACT_SETTLE_MS, readEvents = readAgentLogTail } = {}) {
  const tried = new Set(); // agent ids: one compaction per agent, even before the label write lands or across a replay

  function wait(id, { signal }) {
    return new Promise((resolve) => {
      let off = () => {};
      let timer;
      const done = (v) => { clearTimeout(timer); off(); resolve(v); };
      off = runner.subscribeEvents((ev) => {
        if (ev?.agentId !== id) return;
        if (ev.kind === "timeline" && ev.type === "compacted") done("compacted");
        else if (ev.kind === "turn_ended") done(ev.outcome?.kind === "failed" || ev.outcome?.kind === "cancelled" ? "failed" : "no-boundary");
      });
      timer = setTimeout(() => done("timeout"), timeoutMs);
      timer.unref?.();
      signal.cancel = () => done("failed");
    });
  }

  async function usedNow(id, before) {
    const t0 = Date.now();
    let used = before;
    for (;;) {
      const fresh = (await runner.fetchAgent(id).catch(() => null))?.agent;
      if (fresh) used = leadUsedTokens(fresh);
      if (used < before || Date.now() - t0 >= settleMs) return used;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** The /compact turn's spend off the log; waits up to settleMs for its turn_done to land (compacted fires just before it). */
  async function spendOf(id) {
    const t0 = Date.now();
    for (;;) {
      let r = null;
      try { r = compactSpendFromLog(await readEvents(id)); } catch { /* unreadable log: no spend figure */ }
      if (r?.costUsd !== undefined || Date.now() - t0 >= settleMs) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  async function run(agent, { focus, cap, kind = "agent", teamId, laneId } = {}) {
    const id = agent?.id;
    if (!id || !isClaudeAgent(agent)) return { outcome: "skipped", reason: "non-claude" };
    const labels = agent.labels ?? {};
    if (labels[COMPACTED_AT_LABEL] || tried.has(id)) return { outcome: "skipped", reason: "already-compacted" };
    if (!isIdleForCompact(agent)) return { outcome: "skipped", reason: "busy" };

    const before = leadUsedTokens(agent);
    tried.add(id);
    const startedAt = Date.now();
    const finish = (outcome, extra = {}) => {
      const { costUsd, tokens, ...rest } = extra;
      const res = { outcome, before, ...rest, ...(costUsd != null ? { costUsd } : {}), ...(tokens != null ? { tokens } : {}) };
      try {
        log({
          agent: id,
          teamId,
          laneId,
          text: `compact-step ${kind} agent=${id} outcome=${outcome} before=${before} after=${extra.after ?? "?"} cap=${cap ?? "?"} ms=${Date.now() - startedAt}${extra.costUsd != null ? ` costUsd=${extra.costUsd}` : ""}${extra.tokens != null ? ` tokens=${extra.tokens}` : ""}${outcome === "ok" ? "" : " -> falling through to handoff"}`,
        });
      } catch { /* logging never blocks the ladder */ }
      return res;
    };
    try {
      await runner.updateAgent(id, { labels: { ...labels, [COMPACTED_AT_LABEL]: new Date().toISOString() } });
    } catch {
      return finish("failed", { reason: "label-write" }); // without the label a replay could loop: do not compact
    }

    const signal = {};
    const waiting = wait(id, { signal });
    try {
      await runner.sendAgentPrompt(id, `/compact ${focus ?? ""}`.trim());
    } catch {
      signal.cancel?.();
      await waiting;
      return finish("failed", { reason: "send" });
    }
    const got = await waiting;
    if (got === "timeout") return finish("timeout");
    if (got !== "compacted") return finish("failed", { reason: got });
    const after = await usedNow(id, before);
    const spend = await spendOf(id);
    const costUsd = spend?.costUsd, tokens = spend ? spend.tokens : undefined;
    if (Number.isFinite(cap) && after >= cap) return finish("still-over", { after, costUsd, tokens });
    return finish("ok", { after, costUsd, tokens });
  }

  return { run, tried };
}

export { LEAD_COMPACT_FOCUS };
