// K2c (docs/PLAN_PER_K2_1124.md): compaction is the default context path for leads and Buddies, once per threshold CROSSING
// (it was once per agent life: 65 of 70 long former-lead runs compacted once, then handed off later anyway; EXP7b).
//
// A crossing is the soft meter going over a stage threshold. Each stage gets one compaction attempt per crossing, before that
// stage's handoff step (lead: the 150k nudge and the 250k packet stage; Buddy: its restart cap). The attempt re-arms when the
// meter is back under min(REARM_RATIO x the lowest stage, (1 - REARM_MIN_DROP) x the stage tried) (90% / 75%): a compaction
// that lands just under the cap (150k -> 130k) does not re-arm and burn the life cap at the next turns (hysteresis). After COMPACT_LIFE_CAP attempts in one agent life the agent hands off instead (summaries of summaries
// degrade). The caller falls through to its unchanged handoff on a failed / still-over attempt, and that crossing is not tried
// again (loop guard). The raw-meter hard cap is the caller's, never delayed by this.
//
// Labels (they survive a server restart; the runner merges label patches key by key, runner/fold-index.mjs):
//   vs.compacted-at   ISO of the last attempt. compact-step writes it; its once-guard (refuse while set) applies to unarmed runs
//                     only: the callers here pass `armed: true`, so this tracker (not the label) decides whether to attempt.
//   vs.compact-stage  the stage threshold (tokens) the last attempt (or life-cap hand-off) was for; "" once re-armed. Persisted
//                     for a life cap too, so a server restart does not log the same crossing's compact-life-cap line again.
//   vs.compact-count  attempts in this life. Written with vs.compacted-at in compact-step's one label write; a busy skip writes
//                     nothing and does not count.
// Every write here is a PATCH (only the keys it changes): a stale snapshot spread back could lower vs.compact-count.
// A pre-K2c agent with only vs.compacted-at reads as one attempt at the lowest stage.

export const COMPACTED_AT = "vs.compacted-at"; // = compact-step COMPACTED_AT_LABEL (not imported: compact-step imports lead-handoff)
export const COMPACT_STAGE_LABEL = "vs.compact-stage";
export const COMPACT_COUNT_LABEL = "vs.compact-count";
export const COMPACT_LIFE_CAP = 5;
export const COMPACT_REARM_RATIO = 0.9;
export const COMPACT_REARM_MIN_DROP = 0.25; // re-arm only once the meter is 25% of the tried stage under it

/** Shared across coordinators (token-watch's and the HTTP route's): agent ids with a compaction in flight (compact-step run()). */
export const compactPending = new Set();

/** compact-step outcomes that leave no attempt behind: busy (retry at the next idle, K2a) and no-compact (provider without one, K2b). */
export function compactNotAttempted(res) {
  return res?.outcome === "skipped" && (res.reason === "busy" || res.reason === "no-compact");
}

/**
 * K2b: no turn will ever come to compact in (errored / closed / lost / exited). compact-step reports any non-idle status as busy,
 * so without this check the caller would defer every time; the meter of a dead agent does not grow, so the hard cap never fires either.
 * The lead path skips compaction for these and runs its pre-K2 ladder. A deny-list, not an idle/running allow-list: a lead
 * that is queued / starting must still defer (falling through could write the 250k packet and rule out compaction for that crossing).
 */
const DEAD_FOR_COMPACT = new Set(["error", "errored", "closed", "lost", "exited"]);
export function isDeadForCompact(agent) {
  return Boolean(agent?.lost) || DEAD_FOR_COMPACT.has(String(agent?.status ?? "").trim().toLowerCase());
}

/** K2b: the agent's meter is the ACP adapter's post-compact estimate (runner-backend usageFields), not a real reading. */
export function isCompactEstimate(agent) {
  return agent?.lastUsage?.compactEstimate === true;
}

/** True for a busy skip: the caller defers to the next idle evaluation (no handoff step, no stamp). */
export function compactBusy(res) {
  return res?.outcome === "skipped" && res.reason === "busy";
}

/** Metric line for a crossing past the life cap. Not "compact-step ..." on purpose: providers-catalog counts those as attempts. */
export function lifeCapMetric({ kind, id, count, cap, used }) {
  return `compact-life-cap ${kind} agent=${id} count=${count} cap=${cap} before=${used} reason=life-cap -> falling through to handoff`;
}

/**
 * Per-agent crossing state: labels, plus an in-process mirror that covers a snapshot older than the last label write.
 * decide(agent, used, stages) -> one of
 *   { action: "none", count }                    nothing to compact (under every stage, or this stage was tried)
 *   { action: "rearm", labels, count }           back under the hysteresis line: write the `labels` patch (attempt cleared)
 *   { action: "compact", cap, count, labels }    attempt now; `labels` is the patch compact-step writes with vs.compacted-at
 *   { action: "life-cap", cap, count, labels }   armed, but the life cap is spent: write the `labels` patch, hand off (logs once)
 * stages: ascending soft thresholds. After the attempt: record(id, cap, count) (also for a life-cap, so it logs once);
 * after a rearm write: rearm(id, count).
 */
export function createCrossingTracker({ lifeCap = COMPACT_LIFE_CAP, rearmRatio = COMPACT_REARM_RATIO, rearmMinDrop = COMPACT_REARM_MIN_DROP } = {}) {
  const mem = new Map(); // id -> { stage, count }

  function state(agent, stages) {
    const labels = agent?.labels ?? {};
    let stage = Number(labels[COMPACT_STAGE_LABEL]) || 0;
    let count = Number(labels[COMPACT_COUNT_LABEL]) || 0;
    if (labels[COMPACTED_AT] && !stage) stage = stages[0]; // pre-K2c: the one compaction was at the lowest stage
    if (labels[COMPACTED_AT] && !count) count = 1;
    const m = mem.get(agent?.id);
    if (m) {
      stage = m.stage;
      count = Math.max(count, m.count);
    }
    return { stage, count };
  }

  /** The meter must be under BOTH lines to re-arm: rearmRatio x the lowest stage, and (1 - rearmMinDrop) x the stage tried. */
  const rearmLine = (stage, stages) => Math.min(stages[0] * rearmRatio, stage * (1 - rearmMinDrop));

  function decide(agent, used, stages) {
    const st = state(agent, stages);
    // K2b: only a real meter reading re-arms. The ACP adapter's post-compact estimate (the summary size) would re-arm before the
    // next turn's reading shows whether the compaction shrank the session; a failed one would then burn the life cap.
    if (st.stage > 0 && !isCompactEstimate(agent) && used < rearmLine(st.stage, stages)) {
      return { action: "rearm", count: st.count, labels: { [COMPACTED_AT]: "", [COMPACT_STAGE_LABEL]: "" } };
    }
    let cap = 0;
    for (const s of stages) if (used >= s) cap = Math.max(cap, s);
    if (!cap || st.stage >= cap) return { action: "none", count: st.count };
    if (st.count >= lifeCap) return { action: "life-cap", cap, count: st.count, labels: { [COMPACT_STAGE_LABEL]: String(cap) } };
    const count = st.count + 1;
    return { action: "compact", cap, count, labels: { [COMPACT_STAGE_LABEL]: String(cap), [COMPACT_COUNT_LABEL]: String(count) } };
  }

  return {
    decide,
    record: (id, cap, count) => mem.set(id, { stage: cap, count }),
    rearm: (id, count) => mem.set(id, { stage: 0, count }),
    state,
  };
}
