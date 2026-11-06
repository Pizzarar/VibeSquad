// Pure helpers shared by the runner timeline (server/backend/runner-backend.mjs toTimeline), the live stream fold
// (src/timelineFilter.ts mergeLiveItem), the Paseo projected refetch and page joins (src/Timeline.tsx) and the MCP
// last-message reader (server/mcp/tools.mjs), so a thought chunk in the middle of a reply never splits it into two
// assistant messages.
//
// Design: rows never move and seqStart is never touched (it is the React key, the data-tl-seq target, the jump target
// and the paging cursor). Text that follows a thought is absorbed into the assistant message before it, whose seqEnd
// grows; the thought row stays where it is, after the message: [msg(10..12), thought(11)]. Thought rows do not separate
// a reply; a user message, a tool call, an error, a turn boundary (turnEnd / differing turnId) or a differing message
// id does. No function here mutates its input.
//
// Entries look like { item, seqStart, seqEnd, liveSeqs, sourceSeqRanges, segStart, turnId, turnEnd }.

/** Two assistant items are one message unless both carry a message id and the ids differ. */
export function sameMessage(a, b) {
  const x = a?.messageId ?? a?.id;
  const y = b?.messageId ?? b?.id;
  return x == null || y == null || x === y;
}

/** Highest seq an entry covers, or null. */
export function lastSeqOf(e) {
  let hi = e.seqEnd ?? e.seqStart ?? null;
  for (const s of e.liveSeqs ?? []) if (hi == null || s > hi) hi = s;
  return hi;
}

/** Lowest seq an entry covers, or null. */
export function firstSeqOf(e) {
  let lo = e.seqStart ?? e.seqEnd ?? null;
  for (const s of e.liveSeqs ?? []) if (lo == null || s < lo) lo = s;
  return lo;
}

const isThought = (e) => e?.item?.type === "reasoning";

/** `msg` + the thoughts after it + `next` are one reply: no turn boundary, no differing message / turn id. */
function canJoin(msg, thoughts, next) {
  if (msg.turnEnd || thoughts.some((t) => t.turnEnd)) return false;
  if (!sameMessage(msg.item, next.item)) return false;
  let id;
  for (const p of [msg, ...thoughts, next]) {
    if (p.turnId == null) continue;
    if (id != null && id !== p.turnId) return false;
    id = p.turnId;
  }
  return true;
}

/**
 * Index of the assistant message that `next` (an incoming assistant entry) continues, or -1. That is the last
 * non-thought row, provided it is an assistant message of the same turn / message. `entries.length - 1 - index` is the
 * number of thought rows in between (0 for a plain tail extension).
 */
export function joinTarget(entries, next, { strict = false } = {}) {
  let i = entries.length - 1;
  while (i >= 0 && isThought(entries[i])) i--;
  if (i < 0 || entries[i]?.item?.type !== "assistant_message") return -1;
  const trailing = entries.slice(i + 1);
  if (!canJoin(entries[i], trailing, next)) return -1;
  if (strict && !hasSeparatingThought(entries[i], trailing, next)) return -1;
  return i;
}

/**
 * Static lists (a loaded projection or a page join) are authoritative about message boundaries, so two assistant rows
 * only count as one split reply when a thought really sits between them in seq order: after the message's current end
 * and before the next row. Without that, adjacent messages stay separate.
 */
function hasSeparatingThought(msg, thoughts, next) {
  const end = lastSeqOf(msg);
  const nextStart = firstSeqOf(next);
  if (end == null) return false;
  return thoughts.some((t) => {
    const a = firstSeqOf(t);
    const b = lastSeqOf(t);
    return a != null && b != null && a > end && (nextStart == null || b < nextStart);
  });
}

/**
 * Whether a new thought chunk may extend the tail reasoning row. Not when text was absorbed into the message before it
 * since that thought: the next thought is then a new row, so the streaming paths and coalesceReplies agree.
 */
export function canExtendThought(entries) {
  const last = entries[entries.length - 1];
  if (!isThought(last) || last.turnEnd) return false;
  let i = entries.length - 2;
  while (i >= 0 && isThought(entries[i])) i--;
  const msg = entries[i];
  if (msg?.item?.type !== "assistant_message") return true;
  const m = lastSeqOf(msg);
  const t = lastSeqOf(last);
  return m == null || t == null || m <= t;
}

/**
 * New target with `next`'s text absorbed. `trailing` is the thought rows between them.
 *  - plain (default): `next.text` is whole new text, joined raw (AGY chunks are deltas, projections are whole rows).
 *  - snapshot: live providers may resend cumulative text; judge that against the current segment only (`segStart`), the
 *    text since the last thought. A thought newer than the message starts a fresh segment.
 * `segStart` ends up where the latest segment begins, so later snapshots never overwrite earlier segments.
 */
export function joinInto(target, next, { trailing = [], snapshot = false } = {}) {
  const prev = String(target.item.text ?? "");
  const add = String(next.item.text ?? "");
  const own = next.segStart ?? 0; // `next` may itself be a coalesced row (joinPages)
  const tLast = lastSeqOf(target);
  const newSegment = trailing.length > 0 && trailing.some((t) => { const s = lastSeqOf(t); return s != null && tLast != null && s > tLast; });
  let text;
  let segStart = target.segStart;
  if (!snapshot || newSegment) {
    text = prev + add;
    if (newSegment) segStart = prev.length + own; // only a thought-separated piece starts a new segment
  } else {
    const seg = target.segStart ?? 0;
    const head = prev.slice(0, seg);
    const segPrev = prev.slice(seg);
    text = head + (add.length > segPrev.length && add.startsWith(segPrev) ? add : segPrev + add);
  }
  const out = { ...target, item: { ...target.item, text } };
  if (segStart != null) out.segStart = segStart;
  const hi = lastSeqOf(next);
  if (hi != null) out.seqEnd = Math.max(target.seqEnd ?? hi, hi);
  if (next.liveSeqs) out.liveSeqs = [...(target.liveSeqs ?? []), ...next.liveSeqs];
  if (next.sourceSeqRanges) out.sourceSeqRanges = [...(target.sourceSeqRanges ?? []), ...next.sourceSeqRanges];
  if (next.turnId != null) out.turnId = next.turnId;
  if (next.turnEnd) out.turnEnd = true;
  return out;
}

/** Re-join every assistant / thought / assistant run in a loaded (projected) entry list. Plain adjacent texts are left alone. */
export function coalesceReplies(entries) {
  const out = [];
  for (const e of entries) {
    const i = e?.item?.type === "assistant_message" ? joinTarget(out, e, { strict: true }) : -1;
    if (i >= 0) out[i] = joinInto(out[i], e, { trailing: out.slice(i + 1) });
    else out.push(e);
  }
  return out;
}

/**
 * Prepend an older page to a loaded list, rejoining a reply cut by the page boundary (any number of thoughts either
 * side of it). Only the boundary is looked at, so paging stays linear.
 */
export function joinPages(older, newer) {
  let j = 0;
  while (j < newer.length && isThought(newer[j])) j++;
  const first = newer[j];
  if (first?.item?.type !== "assistant_message") return [...older, ...newer];
  const lead = newer.slice(0, j);
  let t = older.length;
  while (t > 0 && isThought(older[t - 1])) t--;
  const at = t - 1;
  const trailing = [...older.slice(t), ...lead];
  if (at < 0 || older[at].item?.type !== "assistant_message" || !canJoin(older[at], trailing, first) || !hasSeparatingThought(older[at], trailing, first)) return [...older, ...newer];
  return [...older.slice(0, at), joinInto(older[at], first, { trailing }), ...trailing, ...newer.slice(j + 1)];
}

/** Mark the tail entry as the end of a turn, so nothing from the next turn rejoins it. */
export function markTurnBoundary(entries) {
  const last = entries[entries.length - 1];
  if (!last || last.turnEnd) return entries;
  return [...entries.slice(0, -1), { ...last, turnEnd: true }];
}
