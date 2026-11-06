// Pure helpers shared by the runner timeline (server/backend/runner-backend.mjs toTimeline), the live stream fold
// (src/timelineFilter.ts mergeLiveItem), the Paseo projected refetch (src/Timeline.tsx) and the MCP last-message
// reader (server/mcp/tools.mjs), so a thought chunk in the middle of a reply can never split it into two assistant
// messages.
//
// Entries look like { item, seqStart, seqEnd, liveSeqs, sourceSeqRanges, segStart, turnId, turnEnd, fromSeq, toSeq }.
//
// Design (keeps entries sorted by seqStart, non-decreasing, so seq lookup and before-cursor paging never duplicate or
// drop a row): the joined reply keeps its true span [first.seqStart, last.seqEnd]; the thoughts that sat inside it move
// ahead of it and take seqStart = seqEnd = joined.seqStart (a tie, which paging treats as one atomic group). Their true
// seq range survives in fromSeq/toSeq and sourceSeqRanges, so gap checks and redelivery de-dup still see it.

/** [lo, hi] of every seq an entry covers, or null when it carries none (nothing to verify a join against). */
function spanOf(e) {
  let lo = e.fromSeq ?? e.seqStart ?? null;
  let hi = e.toSeq ?? e.seqEnd ?? null;
  if (e.fromSeq == null && e.toSeq == null) {
    for (const s of e.liveSeqs ?? []) {
      if (lo == null || s < lo) lo = s;
      if (hi == null || s > hi) hi = s;
    }
  }
  if (lo == null && hi == null) return null;
  return [lo ?? hi, hi ?? lo];
}

/** Two assistant items are one message unless both carry a message id and the ids differ. */
export function sameMessage(a, b) {
  const x = a?.messageId ?? a?.id;
  const y = b?.messageId ?? b?.id;
  return x == null || y == null || x === y;
}

/** The pieces' seq spans, sorted, leave no hole (overlap is fine: the joined reply's span covers its thoughts). */
function hasNoGap(parts) {
  const spans = [];
  for (const p of parts) {
    const s = spanOf(p);
    if (!s) return false; // no seq to verify against: never join silently
    spans.push(s);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] > spans[i - 1][1] + 1) return false;
  return true;
}

/** Join blockers beyond seq: a turn boundary marker on msg/thoughts, or turn ids that differ. */
function sameTurn(parts) {
  let id;
  for (const p of parts) {
    if (p.turnId != null) {
      if (id != null && id !== p.turnId) return false;
      id = p.turnId;
    }
  }
  return true;
}

/**
 * `msg` (assistant text), the `thoughts` after it (reasoning rows) and `next` (assistant text) are consecutive entries.
 * When they are one reply return [...movedThoughts, joined], else null. Text joins raw (AGY chunks are deltas);
 * `segStart` marks where the post-thought segment begins, so a snapshot provider's later chunks are judged against that
 * segment only.
 */
export function rejoinRun(msg, thoughts, next) {
  if (msg?.item?.type !== "assistant_message" || next?.item?.type !== "assistant_message" || !thoughts.length) return null;
  if (thoughts.some((t) => t?.item?.type !== "reasoning")) return null;
  if (msg.turnEnd || thoughts.some((t) => t.turnEnd)) return null;
  if (!sameMessage(msg.item, next.item)) return null;
  const parts = [msg, ...thoughts, next];
  if (!sameTurn(parts) || !hasNoGap(parts)) return null;

  const prev = String(msg.item.text ?? "");
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of [msg, next]) {
    const s = spanOf(p);
    lo = Math.min(lo, s[0]);
    hi = Math.max(hi, s[1]);
  }
  const joined = {
    ...msg,
    item: { ...msg.item, text: prev + String(next.item.text ?? "") },
    segStart: prev.length,
    seqStart: msg.seqStart ?? lo,
    seqEnd: Math.max(msg.seqEnd ?? hi, next.seqEnd ?? hi, hi),
    ...(next.turnId != null ? { turnId: next.turnId } : {}),
    ...(next.turnEnd ? { turnEnd: true } : {}),
  };
  const withLive = parts.some((p) => p.liveSeqs);
  if (withLive) joined.liveSeqs = parts.flatMap((p) => p.liveSeqs ?? []);
  if (parts.some((p) => p.sourceSeqRanges)) joined.sourceSeqRanges = parts.flatMap((p) => p.sourceSeqRanges ?? []);
  // Pin the moved thoughts at the reply's start; their real range stays in fromSeq/toSeq + sourceSeqRanges.
  const at = joined.seqStart;
  const moved = thoughts.map((t) => {
    const s = spanOf(t);
    return {
      ...t,
      seqStart: at,
      seqEnd: at,
      fromSeq: s[0],
      toSeq: s[1],
      sourceSeqRanges: t.sourceSeqRanges ?? [{ startSeq: s[0], endSeq: s[1] }],
    };
  });
  return [...moved, joined];
}

/** If `next` rejoins the reply that ends `entries` (assistant, then thoughts), the index to replace from and the replacement. */
export function rejoinTail(entries, next) {
  const n = entries.length;
  let k = 0;
  while (n - 1 - k >= 0 && entries[n - 1 - k]?.item?.type === "reasoning") k++;
  if (!k || n - 1 - k < 0) return null;
  const from = n - 1 - k;
  const items = rejoinRun(entries[from], entries.slice(from + 1), next);
  return items ? { from, items } : null;
}

/** Re-join every assistant / reasoning / assistant run in a loaded (projected) entry list. */
export function coalesceReplies(entries) {
  const out = [];
  for (const e of entries) {
    const hit = e?.item?.type === "assistant_message" ? rejoinTail(out, e) : null;
    if (hit) out.splice(hit.from, out.length - hit.from, ...hit.items);
    else out.push(e);
  }
  return out;
}

/**
 * Prepend an older page to a loaded list, rejoining a reply that was cut by the page boundary (including runs of
 * several thoughts). Only the boundary is re-scanned, so paging stays linear.
 */
export function joinPages(older, newer) {
  const j = newer.findIndex((e) => e?.item?.type === "assistant_message");
  if (j < 0) return [...older, ...newer];
  let t = older.length;
  while (t > 0 && older[t - 1]?.item?.type === "reasoning") t--;
  const start = Math.max(0, t - 1);
  return [...older.slice(0, start), ...coalesceReplies([...older.slice(start), ...newer.slice(0, j + 1)]), ...newer.slice(j + 1)];
}

/** Mark the tail entry as the end of a turn, so nothing from the next turn rejoins it. */
export function markTurnBoundary(entries) {
  const last = entries[entries.length - 1];
  if (!last || last.turnEnd) return entries;
  return [...entries.slice(0, -1), { ...last, turnEnd: true }];
}
