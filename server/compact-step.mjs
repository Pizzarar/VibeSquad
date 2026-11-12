// K2 (PLAN_COMPACT_IN_PLACE_1108): the compact-before-handoff step shared by the Buddy watcher (token-watch.mjs) and the lead ladder
// (lead-handoff.mjs). Claude agents only: the runner keeps one long-lived `claude -p` child, so a `/compact <focus>` user turn shrinks the
// context in place (same id, labels, worktree). Anything else -- non-Claude, busy, already tried, failed, timed out, still over the cap --
// returns a non-"ok" outcome and the caller runs its existing handoff ladder unchanged. Reuses runner.sendAgentPrompt; no new route.
import { LEAD_COMPACT_FOCUS, leadUsedTokens } from "./lead-handoff.mjs";

export const COMPACTED_AT_LABEL = "vs.compacted-at";
export const COMPACT_TIMEOUT_MS = 120_000;
export const COMPACT_SETTLE_MS = 1_500;

export const BUDDY_COMPACT_FOCUS = "keep Decided / Open / In flight (the brief), the current lane plan, and worker ids";

/** Cumulative cost / in+out tokens off a runner agent snapshot (usage or lastUsage); null when the snapshot carries none. */
export function agentSpend(agent) {
  const u = agent?.usage ?? agent?.lastUsage ?? {};
  const cost = Number(u.costUsd);
  const tok = Number(u.inputTokens ?? 0) + Number(u.outputTokens ?? 0);
  return { costUsd: Number.isFinite(cost) ? cost : null, tokens: Number.isFinite(tok) && (u.inputTokens != null || u.outputTokens != null) ? tok : null };
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
 * timeoutMs, settleMs. run() never throws; its outcome is one of
 * ok | still-over | failed | timeout | skipped (skipped carries a reason and sends nothing).
 */
export function createCompactor({ runner, log = () => {}, timeoutMs = COMPACT_TIMEOUT_MS, settleMs = COMPACT_SETTLE_MS } = {}) {
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
    let spend = null;
    for (;;) {
      const fresh = (await runner.fetchAgent(id).catch(() => null))?.agent;
      if (fresh) { used = leadUsedTokens(fresh); spend = agentSpend(fresh); }
      if (used < before || Date.now() - t0 >= settleMs) return { used, spend };
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function run(agent, { focus, cap, kind = "agent", teamId, laneId } = {}) {
    const id = agent?.id;
    if (!id || !isClaudeAgent(agent)) return { outcome: "skipped", reason: "non-claude" };
    const labels = agent.labels ?? {};
    if (labels[COMPACTED_AT_LABEL] || tried.has(id)) return { outcome: "skipped", reason: "already-compacted" };
    if (!isIdleForCompact(agent)) return { outcome: "skipped", reason: "busy" };

    const before = leadUsedTokens(agent);
    const spendBefore = agentSpend(agent);
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
    const { used: after, spend } = await usedNow(id, before);
    // cost/tokens of the /compact turn = growth of the cumulative usage totals across it (clamped: a fresh process resets them)
    const delta = (b, a) => (b != null && a != null ? Math.max(0, Math.round((a - b) * 1e6) / 1e6) : undefined);
    const costUsd = delta(spendBefore.costUsd, spend?.costUsd), tokens = delta(spendBefore.tokens, spend?.tokens);
    if (Number.isFinite(cap) && after >= cap) return finish("still-over", { after, costUsd, tokens });
    return finish("ok", { after, costUsd, tokens });
  }

  return { run, tried };
}

export { LEAD_COMPACT_FOCUS };
