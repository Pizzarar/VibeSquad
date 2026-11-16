// Per-agent open tool calls, folded from the agent's own runner log in log order (UX_REVIEW_R4 R4-1). Pure and import-free:
// the runner's incremental log fold (Runner._fold -> status record), the backend's sync log fold (vs who) and the backend's live
// event path (RunnerBackend.handleLogEvent) all apply the SAME reducer to the SAME ordered events, so every client sees one answer.
//
// `open` is a Map callId -> { since, name, timeoutMs } in insertion (= call) order, so its first entry is the oldest open call.
// A call opens an entry; its result (claude `phase: 'result'`, ACP `phase: 'update'` with a terminal status) closes it. A missed
// result can never outlive the turn: the turn ending (turn_done), an error, a cancel, any status other than `running` (idle,
// parked, queued, starting/resume after a restart, lost), the agent ending (exit) or being archived clears every entry.
// Idempotent per call id (a re-applied call keeps its first `since`), and capped, so a turn that loses results stays bounded.

export const MAX_OPEN_TOOLS = 64;

/** Event types that end every open call: the turn or the agent is over, so no tool of it can still be running. */
const CLEAR_ALL = new Set(["created", "turn_done", "error", "cancel", "exit", "archive", "unarchive", "parked"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

/** The tool's own timeout in ms when the call carries one (claude Bash/PowerShell `input.timeout`), else null. */
export function toolTimeoutMs(e) {
  const t = e?.input?.timeout ?? e?.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

/** Does this event end every open call (see the header)? */
export function clearsOpenTools(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "status") return e.status !== "running";
  return CLEAR_ALL.has(e.type);
}

/**
 * Apply one runner log event to `open`. Returns true when the oldest open call WITH a timestamp (oldestOpenTool) changed (opened,
 * closed, or cleared), which is exactly when the published `openToolSince` / `openToolName` change.
 *
 * Hot path: every fold (the runner's boot pass over every log, vs who, the backend's live path) calls this on EVERY event, ~1.4M at
 * boot on a live home (Bug24). So it allocates nothing, returns before touching `open` for the ~70% of events that are neither tool
 * events nor turn edges, and derives "did the oldest change" from the single entry that moved instead of comparing two full
 * oldestOpenTool() walks: a new call goes LAST (insertion order), so it becomes the oldest only when no older call has a timestamp;
 * a closed call changes the oldest only when it WAS the oldest; a clear changes it only when there was one.
 */
export function applyToolEvent(open, e) {
  if (!e || typeof e !== "object") return false;
  if (e.type !== "tool") {
    if (open.size === 0 || !clearsOpenTools(e)) return false;
    const had = oldestOpenId(open) !== null;
    open.clear();
    return had;
  }
  if (e.id == null) return false;
  const id = String(e.id);
  const done = e.phase === "result" || e.isError === true || TERMINAL.has(String(e.status ?? ""));
  if (done) {
    if (!open.has(id)) return false;
    const wasOldest = oldestOpenId(open) === id;
    open.delete(id);
    return wasOldest;
  }
  if (e.phase !== "call" || open.has(id) || open.size >= MAX_OPEN_TOOLS) return false;
  const since = Number.isFinite(e.ts) ? e.ts : null;
  const becomesOldest = since !== null && oldestOpenId(open) === null;
  open.set(id, { since, name: typeof e.name === "string" && e.name ? e.name : "tool", timeoutMs: toolTimeoutMs(e) });
  return becomesOldest;
}

/**
 * Id of the oldest open call with a timestamp, or null. Allocation-free; stops at the first timestamped entry, so it only walks past
 * timestamp-less calls (rare: every runner-written event carries ts), never more than MAX_OPEN_TOOLS.
 */
function oldestOpenId(open) {
  for (const [id, t] of open) if (Number.isFinite(t.since)) return id;
  return null;
}

/** The oldest open call ({ id, since, name, timeoutMs }) or null. */
export function oldestOpenTool(open) {
  for (const [id, t] of open) if (Number.isFinite(t.since)) return { id, ...t };
  return null;
}
