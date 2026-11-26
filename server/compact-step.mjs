// K2 (PLAN_COMPACT_IN_PLACE_1108): the compact-before-handoff step shared by the Buddy watcher (token-watch.mjs) and the lead ladder
// (lead-handoff.mjs). Providers with a working in-place compaction (COMPACT_PROVIDERS): the runner keeps one long-lived child, so a
// `/compact` user turn shrinks the context in place (same id, labels, worktree). Claude takes a focus (`/compact <focus>`); agy (K2b,
// docs/lanes/perfection/K2B.md) gets a bare `/compact` and its ACP adapter synthesizes the `compacted` boundary on that turn's end.
// Anything else -- other providers, busy, already tried, failed, timed out, still over the cap -- returns a non-"ok" outcome and the
// caller runs its existing handoff ladder unchanged. Reuses runner.sendAgentPrompt; no new route.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEAD_COMPACT_FOCUS, leadUsedTokens } from "./lead-handoff.mjs";
import { compactPending } from "./compact-crossing.mjs";
import { vibesquadHome } from "./user-settings.mjs";

export const COMPACTED_AT_LABEL = "vs.compacted-at";
// K2a (docs/lanes/perfection/K2A.md): per-attempt budget from the moment the /compact turn STARTS (queue time excluded). 120s
// timed out 4 compactions that all finished (claude compact durationMs 126-136s); ok compactions ran up to 110s.
export const COMPACT_TIMEOUT_MS = 240_000;
// Longest a /compact may wait in the runner's family queue (turn cap full) before its turn starts.
export const COMPACT_QUEUE_TIMEOUT_MS = 600_000;
// Sends per run: a /compact that rode along with another user message (a wake that won the race, a steer still pending in the
// CLI) ends its turn without a compact boundary; it is re-sent alone once the agent is idle again.
export const COMPACT_MAX_ATTEMPTS = 3;
export const COMPACT_SETTLE_MS = 1_500;

export const BUDDY_COMPACT_FOCUS = "keep Decided / Open / In flight (the brief), the current lane plan, and worker ids";

// An input that carries a /compact line anywhere: also one coalesced behind a queued wake (C3: "<wake>\n\n/compact ...").
const COMPACT_LINE_RE = /(^|\n)\s*\/compact\b/i;
/** Per-turn cost from session-cumulative `turn_done.costUsd`: delta vs the previous turn_done (a drop means the session restarted: take it whole). */
export const costDelta = (cost, base) => Math.round((cost >= base ? cost - base : cost) * 1e6) / 1e6;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * Cost + tokens of the `/compact` turn from the agent's raw runner-log events (the live timeline events carry only seq + type, and the
 * agent snapshot's usage is a per-call overwrite with no cost, so the log is the one place `turn_done.costUsd` (session-cumulative)
 * and `usage` live). Anchors on the last `compacted` event and the last `/compact` input before it; a turn_done between the two
 * (the /compact arrived mid-turn, so that turn ended first) resets the tokens and moves the cost baseline. Real claude /compact emits
 * no usage before `compacted`: the turn's only usage is the adapter's post_tokens one right after it (counted). Returns { costUsd?, tokens } or null without a /compact anchor.
 */
export function compactSpendFromLog(events) {
  let c = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "compacted") { c = i; break; }
  if (c < 0) return null;
  let j = -1;
  for (let i = c - 1; i >= 0; i--) if (events[i]?.type === "input" && COMPACT_LINE_RE.test(String(events[i].text ?? ""))) { j = i; break; }
  if (j < 0) return null;
  let base = 0;
  for (let i = j - 1; i >= 0; i--) if (events[i]?.type === "turn_done" && Number.isFinite(Number(events[i].costUsd))) { base = Number(events[i].costUsd); break; }
  let tokens = 0;
  for (let i = j + 1; i < events.length; i++) {
    const e = events[i];
    if (e?.type === "usage") tokens += num(e.inputTokens) + num(e.outputTokens);
    else if (e?.type === "turn_done") {
      const cost = Number(e.costUsd);
      if (i < c) { tokens = 0; if (Number.isFinite(cost)) base = cost; continue; } // mid-turn /compact: the prior turn ended first
      if (!Number.isFinite(cost)) return { tokens };
      return { costUsd: costDelta(cost, base), tokens };
    }
  }
  return { tokens }; // turn_done not logged yet
}

/**
 * K2a C1: where the last `/compact` input landed, from the agent's runner log. "steered" = the last status before it read running
 * (a wake opened the turn first: the CLI holds the /compact and, 16 of 20 times, runs it as its own turn right after, with the
 * runner showing idle); "gone" = the process was parked or exited after it (a CLI-held /compact died with it); else "direct".
 * since (ms): anchors on THIS send -- an input logged before it (an earlier attempt's) is never read as this one; an event
 * without a ts is not filtered. A coalesced input ("<wake>\n\n/compact") counts as the send's input.
 */
export function compactLanding(events, { since } = {}) {
  let j = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (since != null && Number.isFinite(Number(e?.ts)) && Number(e.ts) < since) break; // older than this send
    if (e?.type === "input" && COMPACT_LINE_RE.test(String(e.text ?? ""))) { j = i; break; }
  }
  if (j < 0) return "direct";
  for (let i = j + 1; i < events.length; i++) if (events[i]?.type === "parked" || events[i]?.type === "exit") return "gone";
  for (let i = j - 1; i >= 0; i--) if (events[i]?.type === "status") return events[i].status === "running" ? "steered" : "direct";
  return "direct";
}

function parseJsonlLines(text, dropFirst = false) {
  const lines = text.split("\n");
  if (dropFirst) lines.shift(); // torn first line
  return lines.flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}

/** Default log reader: the tail (last maxBytes, default 512KB) of <VIBESQUAD_HOME>/runner/agents/<id>.jsonl as parsed events, oldest first; [] when unreadable. Also brainstorm.mjs's G1 carry scan. */
export function readAgentLogTail(id, maxBytes = 512 * 1024) {
  try {
    const file = join(vibesquadHome(), "runner", "agents", `${id}.jsonl`);
    const size = statSync(file).size;
    const from = Math.max(0, size - maxBytes);
    const fd = openSync(file, "r");
    let text;
    try { const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from); text = buf.toString("utf8"); } finally { closeSync(fd); }
    return parseJsonlLines(text, from > 0);
  } catch { return []; }
}

/**
 * Incremental tail reader for `<VIBESQUAD_HOME>/runner/agents/<id>.jsonl`: skips reading when size/mtime/inode are unchanged,
 * reads and parses only appended bytes when the file grows, and falls back to a full tail read on truncation, rotation, or rewrite.
 */
export function createAgentLogTailReader(id, maxBytes = 512 * 1024) {
  let initialized = false;
  let lastSize = 0;
  let lastMtimeMs = -1;
  let lastIno = null;
  let committedOffset = 0;
  let committedEvents = [];
  let cachedEvents = [];

  return function read() {
    try {
      const file = join(vibesquadHome(), "runner", "agents", `${id}.jsonl`);
      const st = statSync(file);
      if (initialized && st.size === lastSize && st.mtimeMs === lastMtimeMs && st.ino === lastIno) {
        return cachedEvents;
      }
      const rotated = initialized && (
        st.ino !== lastIno
        || st.size < lastSize
        || (st.size === lastSize && st.mtimeMs !== lastMtimeMs)
        || st.size - committedOffset > maxBytes
      );
      let from;
      let dropFirst = false;
      if (!initialized || rotated) {
        committedEvents = [];
        from = Math.max(0, st.size - maxBytes);
        dropFirst = from > 0;
      } else {
        from = committedOffset;
      }
      const len = Math.max(0, st.size - from);
      let buf = Buffer.alloc(0);
      if (len > 0) {
        const fd = openSync(file, "r");
        try {
          buf = Buffer.alloc(len);
          const n = readSync(fd, buf, 0, len, from);
          if (n < len) buf = buf.subarray(0, n);
        } finally {
          closeSync(fd);
        }
      }
      const lastNl = buf.lastIndexOf(0x0a);
      let trailing = [];
      if (lastNl >= 0) {
        const parsed = parseJsonlLines(buf.subarray(0, lastNl + 1).toString("utf8"), dropFirst);
        if (parsed.length) committedEvents.push(...parsed);
        committedOffset = from + lastNl + 1;
        if (lastNl + 1 < buf.length) {
          trailing = parseJsonlLines(buf.subarray(lastNl + 1).toString("utf8"), false);
        }
      } else {
        committedOffset = from;
        if (buf.length > 0) trailing = parseJsonlLines(buf.toString("utf8"), dropFirst);
      }
      initialized = true;
      lastSize = from + buf.length;
      lastMtimeMs = st.mtimeMs;
      lastIno = st.ino;
      cachedEvents = trailing.length ? [...committedEvents, ...trailing] : committedEvents;
      return cachedEvents;
    } catch {
      initialized = false;
      lastSize = 0;
      lastMtimeMs = -1;
      lastIno = null;
      committedOffset = 0;
      committedEvents = [];
      cachedEvents = [];
      return [];
    }
  };
}

export function isClaudeAgent(agent) {
  return String(agent?.provider ?? "").toLowerCase() === "claude";
}

/**
 * K2b: providers whose /compact compacts in place AND ends in a `compacted` boundary the step can wait on. opencode compacts and
 * marks it too (the adapter emits the boundary), but runs no lead or Buddy and its meter stays stale until the next turn: not enabled.
 * Value: whether `/compact` takes a focus argument (agy's is unverified, and its adapter only trusts a bare `/compact`).
 */
export const COMPACT_PROVIDERS = Object.freeze({ claude: { focus: true }, "antigravity-cli": { focus: false } });
const PROVIDER_ALIASES = { agy: "antigravity-cli", antigravity: "antigravity-cli" };
const compactProvider = (agent) => {
  const p = String(agent?.provider ?? "").toLowerCase();
  return COMPACT_PROVIDERS[PROVIDER_ALIASES[p] ?? p] ?? null;
};
/** True when the agent's provider has a working /compact (the callers' crossing trackers only arm for these). */
export function canCompact(agent) {
  return !!compactProvider(agent);
}
/** The /compact line for this agent: with the focus where the provider takes one. */
export function compactCommand(agent, focus) {
  return compactProvider(agent)?.focus ? `/compact ${focus ?? ""}`.trim() : "/compact";
}

/** Idle = not mid-turn. A `/compact` while running would steer into the live turn, so the caller defers or skips. */
export function isIdleForCompact(agent) {
  const s = String(agent?.status ?? "").toLowerCase();
  return s === "idle" || s === "ready" || s === "";
}

/** Busy for a /compact: mid-turn, or a turn waiting in the runner's family queue (snapshot `queued`). */
const busyForCompact = (agent) => !isIdleForCompact(agent) || !!agent?.queued;

/**
 * deps: runner (sendAgentPrompt, updateAgent, fetchAgent, subscribeEvents), log({agent, text, teamId, laneId}) (lane-aware),
 * timeoutMs (per attempt, from turn start), queueTimeoutMs (while the /compact waits in the runner queue), maxAttempts, settleMs,
 * idlePollMs, lateBoundaryMs (how long a steered /compact's late boundary is awaited before a re-send; default timeoutMs),
 * readEvents(id) (parsed runner-log events; default reads the agent log under VIBESQUAD_HOME), pending (Set of agent ids with a run in
 * flight; default the shared compactPending, read by lead-handoff evaluateLead). run() never throws; its outcome is one of
 * ok | still-over | failed | timeout | skipped (skipped carries a reason and sends nothing). Non-ok outcomes carry a reason, also on
 * the metric line (reason=, attempts=; K2a).
 *
 * K2a causes this guards (docs/lanes/perfection/K2A.md):
 *  - C1 steer: a stale "idle" snapshot (or a wake that won the race) put /compact INTO a live turn. The runner's status NOW decides
 *    (busy -> skipped, the next idle re-evaluates). A turn that ends without a compact boundary is retried alone; when the runner
 *    log shows the /compact was steered into a running turn, the CLI's late boundary is awaited first (no second /compact).
 *  - C2 park-while-queued: a queued /compact's agent is parked to free a slot; the runner backend reads that park as a turn end.
 *    A turn end before the /compact's own turn started is ignored, and the attempt clock starts at turn start.
 *  - C3/C4 merge: /compact folded into a queued input or batched with a steer still pending in the CLI -> plain text, no boundary.
 *    Same retry: once the agent is idle again its queue is drained, so the re-sent /compact runs alone.
 *  - C5 slow: compactions of 126-136s: per-attempt timeout 240s (from turn start).
 */
export function createCompactor({
  runner,
  log = () => {},
  timeoutMs = COMPACT_TIMEOUT_MS,
  queueTimeoutMs = COMPACT_QUEUE_TIMEOUT_MS,
  maxAttempts = COMPACT_MAX_ATTEMPTS,
  settleMs = COMPACT_SETTLE_MS,
  idlePollMs = 1_000,
  lateBoundaryMs = timeoutMs,
  readEvents = readAgentLogTail,
  pending = compactPending,
} = {}) {
  const tried = new Set(); // agent ids: one compaction per agent, even before the label write lands or across a replay
  const overCap = (agent, hardCap) => Number.isFinite(hardCap) && !!agent && leadUsedTokens(agent) >= hardCap;
  /** K2c: the raw meter passed the hard cap (the forced handoff wins): the stop carries the reading that tripped it. */
  const capStop = (agent) => ({ stop: "hard-cap", raw: leadUsedTokens(agent) });

  /** The runner's view now (a usage upsert can lag a turn that already started); null when unreadable. */
  async function freshAgent(id) {
    if (typeof runner.fetchAgent !== "function") return null;
    return (await runner.fetchAgent(id).catch(() => null))?.agent ?? null;
  }

  /** One subscription for the whole run (no compacted event is lost between attempts). next(ms) -> signal | "tick". */
  function watchAgent(id) {
    const signals = [];
    let wake = null;
    const off = runner.subscribeEvents((ev) => {
      if (ev?.agentId !== id) return;
      let s = null;
      if (ev.kind === "timeline" && ev.type === "compacted") s = "compacted";
      else if (ev.kind === "turn_started") s = "started";
      else if (ev.kind === "turn_ended") s = ev.outcome?.kind === "failed" || ev.outcome?.kind === "cancelled" ? "failed" : "ended";
      if (!s) return;
      signals.push(s);
      wake?.();
    });
    let cancelled = false;
    const next = (ms) => {
      if (signals.length) return Promise.resolve(signals.shift());
      if (cancelled) return Promise.resolve("cancelled");
      return new Promise((resolve) => {
        const t = setTimeout(() => { wake = null; resolve("tick"); }, Math.max(0, ms));
        // not unref'd: a pending compaction (bounded by its deadlines) keeps the process alive like the sends it waits on
        wake = () => { clearTimeout(t); wake = null; resolve(signals.length ? signals.shift() : "cancelled"); };
      });
    };
    // Drops turn signals seen so far (a wake turn that ran between attempts is not the next attempt's turn); true when a boundary is among them.
    const drain = () => {
      const hit = signals.includes("compacted");
      signals.length = 0;
      return hit;
    };
    return { next, drain, off: () => { cancelled = true; wake?.(); off(); } };
  }

  /**
   * Waits for this attempt's outcome: compacted | no-boundary | turn-failed | turn-timeout | queue-timeout, or { stop: "hard-cap", raw }
   * once the turn has started and the fresh raw meter reaches hardCap (polled every idlePollMs; a running turn can grow it).
   */
  async function awaitAttempt(w, queued, id, hardCap) {
    let started = !queued; // a direct delivery opened (or steered into) a turn at send time
    let deadline = Date.now() + (started ? timeoutMs : queueTimeoutMs);
    const poll = Number.isFinite(hardCap);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return started ? "turn-timeout" : "queue-timeout";
      const s = await w.next(started && poll ? Math.min(left, idlePollMs) : left);
      if (s === "compacted") return "compacted";
      if (s === "cancelled") return "turn-failed";
      if (s === "tick") {
        if (started && poll) {
          const now = await freshAgent(id);
          if (overCap(now, hardCap)) return capStop(now);
        }
        continue;
      }
      if (s === "started") {
        if (!started) { started = true; deadline = Date.now() + timeoutMs; }
        continue;
      }
      if (!started) continue; // C2: the park of a queued agent reads as a turn end; the /compact has not run yet
      return s === "failed" ? "turn-failed" : "no-boundary";
    }
  }

  const landing = async (id, since, read = readEvents) => {
    try { return compactLanding(await read(id), { since }); } catch { return "direct"; } // unreadable log: re-send as before
  };

  /**
   * C1 late boundary: a /compact steered into a live turn is usually run by the CLI as its own turn after that turn's result,
   * while the runner shows idle. Re-sending at once would compact twice (and skew the adapter's turn count), so wait for that
   * boundary first: "compacted", or "none" at the deadline / once the process is parked or exits (the held /compact died).
   */
  async function awaitLate(w, id, since, hardCap, read) {
    const deadline = Date.now() + lateBoundaryMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return "none";
      const s = await w.next(Math.min(left, idlePollMs));
      if (s === "compacted") return "compacted";
      if (s === "cancelled") return "none";
      if (s !== "tick") continue;
      if ((await landing(id, since, read)) === "gone") return "none";
      if (Number.isFinite(hardCap)) {
        const now = await freshAgent(id);
        if (overCap(now, hardCap)) return capStop(now);
      }
    }
  }

  /** After a no-boundary turn: waits until the runner shows the agent idle with nothing queued (or a late boundary lands). */
  async function awaitIdle(w, id, hardCap) {
    if (typeof runner.fetchAgent !== "function") return "idle"; // no status source: the turn end is all there is (as the gate)
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = await freshAgent(id);
      if (overCap(now, hardCap)) return capStop(now); // K2c: the raw meter passed the hard cap meanwhile: the forced handoff wins
      if (now && !busyForCompact(now)) return "idle";
      const left = deadline - Date.now();
      if (left <= 0) return "busy";
      const s = await w.next(Math.min(left, idlePollMs));
      if (s === "compacted") return "compacted";
      if (s === "cancelled") return "busy";
    }
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

  /**
   * opts: focus, cap (soft: still-over at or above it), kind, teamId, laneId, plus (K2c) armed: the caller's crossing tracker is
   * the loop guard, so the once-per-life guards (vs.compacted-at label, `tried`) are not checked; labels: the label PATCH written
   * with vs.compacted-at (default: the agent's labels, pre-K2c); hardCap: the raw meter at which a pending retry stops
   * (reason=hard-cap) so the caller's forced handoff is not held behind the compaction.
   */
  async function run(agent, opts = {}) {
    const id = agent?.id;
    if (!id || !canCompact(agent)) return { outcome: "skipped", reason: "no-compact" };
    if (pending.has(id)) return { outcome: "skipped", reason: "busy" }; // a run for this agent is already in flight
    pending.add(id);
    try {
      return await runOnce(agent, opts);
    } finally {
      pending.delete(id);
    }
  }

  async function runOnce(agent, { focus, cap, kind = "agent", teamId, laneId, armed = false, labels: patch, hardCap } = {}) {
    const id = agent.id;
    const labels = agent.labels ?? {};
    if (!armed && (labels[COMPACTED_AT_LABEL] || tried.has(id))) return { outcome: "skipped", reason: "already-compacted" };
    if (busyForCompact(agent)) return { outcome: "skipped", reason: "busy" };
    // C1: the snapshot that triggered this can be stale (the turn a wake started is already running): the runner decides.
    const now = await freshAgent(id);
    if (now && busyForCompact(now)) return { outcome: "skipped", reason: "busy" };

    const before = leadUsedTokens(agent);
    tried.add(id);
    const startedAt = Date.now();
    let attempts = 0;
    const finish = (outcome, extra = {}) => {
      const { costUsd, tokens, ...rest } = extra;
      const res = { outcome, before, attempts, ...rest, ...(costUsd != null ? { costUsd } : {}), ...(tokens != null ? { tokens } : {}) };
      try {
        // Field order is parsed by providers-catalog readCompactStepEvents: new fields (reason, attempts) go after tokens.
        log({
          agent: id,
          teamId,
          laneId,
          text: `compact-step ${kind} agent=${id} outcome=${outcome} before=${before} after=${extra.after ?? "?"} cap=${cap ?? "?"} ms=${Date.now() - startedAt}${extra.costUsd != null ? ` costUsd=${extra.costUsd}` : ""}${extra.tokens != null ? ` tokens=${extra.tokens}` : ""}${extra.reason ? ` reason=${extra.reason}` : ""} attempts=${attempts}${outcome === "ok" ? "" : " -> falling through to handoff"}`,
        });
      } catch { /* logging never blocks the ladder */ }
      return res;
    };
    try {
      await runner.updateAgent(id, { labels: { ...(patch ?? labels), [COMPACTED_AT_LABEL]: new Date().toISOString() } });
    } catch {
      return finish("failed", { reason: "label-write" }); // without the label a replay could loop: do not compact
    }

    const text = compactCommand(agent, focus);
    const w = watchAgent(id);
    let got;
    let capRaw; // the raw meter reading that stopped the run at the hard cap (no refetch: a later read can be stale or missing)
    const capped = (r) => { if (r?.stop !== "hard-cap") return false; capRaw = r.raw; got = "hard-cap"; return true; };
    try {
      for (;;) {
        if (w.drain()) { got = "compacted"; break; }
        attempts++;
        let sent;
        const sentAt = Date.now();
        try {
          sent = await runner.sendAgentPrompt(id, text);
        } catch {
          return finish("failed", { reason: "send" });
        }
        got = await awaitAttempt(w, sent?.queued === true, id, hardCap);
        if (capped(got)) break;
        if (got !== "no-boundary") break;
        // C1/C3/C4: the /compact rode along with another message. A steered one first gets its late boundary window (C1), also
        // on the last attempt: the CLI can still run the held /compact, and the caller's handoff must not overlap it.
        const readForLate = readEvents === readAgentLogTail ? createAgentLogTailReader(id) : readEvents;
        if ((await landing(id, sentAt, readForLate)) === "steered") {
          const late = await awaitLate(w, id, sentAt, hardCap, readForLate);
          if (late === "compacted") { got = "compacted"; break; }
          if (capped(late)) break;
        }
        if (attempts >= maxAttempts) break;
        // Then it is re-sent alone once the agent is idle again (a boundary that lands meanwhile is the success it looks like).
        const idle = await awaitIdle(w, id, hardCap);
        if (idle === "compacted") { got = "compacted"; break; }
        if (capped(idle)) break;
        if (idle !== "idle") { got = "no-boundary"; break; }
      }
    } finally {
      w.off();
    }
    if (got === "turn-timeout") return finish("timeout", { reason: "turn" });
    if (got === "queue-timeout") return finish("timeout", { reason: "queue" });
    if (got === "hard-cap") return finish("failed", { reason: "hard-cap", rawUsed: capRaw });
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
