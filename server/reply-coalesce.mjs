// Pure helper shared by the runner timeline (server/backend/runner-backend.mjs toTimeline), the live stream fold
// (src/timelineFilter.ts mergeLiveItem) and the Paseo projected refetch (src/Timeline.tsx), so a thought chunk in the
// middle of a reply can never split it into two assistant messages. Entries look like { item, seqStart, seqEnd,
// liveSeqs, sourceSeqRanges, segStart }.

const seqsOf = (e) => [...(e.liveSeqs ?? []), ...(e.seqStart != null ? [e.seqStart] : []), ...(e.seqEnd != null ? [e.seqEnd] : [])];
const firstSeq = (e) => { const s = seqsOf(e); return s.length ? Math.min(...s) : null; };
const lastSeq = (e) => { const s = seqsOf(e); return s.length ? Math.max(...s) : null; };

/** Two assistant items are one message unless both carry a message id and the ids differ. */
export function sameMessage(a, b) {
  const x = a?.messageId ?? a?.id;
  const y = b?.messageId ?? b?.id;
  return x == null || y == null || x === y;
}

/** `b` directly follows `a` in seq order (or either side has no seq to compare). */
export function followsDirectly(a, b) {
  const end = lastSeq(a);
  const start = firstSeq(b);
  return end == null || start == null || start === end + 1;
}

/**
 * `msg` (assistant text), `thought` (reasoning) and `next` (assistant text) are consecutive entries. When they are one
 * reply (same message id, no seq gap) return [thought, joined]: the thought moves ahead of the reply and the text is
 * joined raw (AGY chunks are deltas, so no separator). `segStart` marks where the post-thought segment begins, so a
 * snapshot provider's later chunks are judged against that segment only. Returns null when they are not one reply.
 */
export function rejoinReply(msg, thought, next) {
  if (msg?.item?.type !== "assistant_message" || thought?.item?.type !== "reasoning" || next?.item?.type !== "assistant_message") return null;
  if (!sameMessage(msg.item, next.item) || !followsDirectly(msg, thought) || !followsDirectly(thought, next)) return null;
  const prev = String(msg.item.text ?? "");
  const joined = {
    ...msg,
    item: { ...msg.item, text: prev + String(next.item.text ?? "") },
    segStart: prev.length,
    ...(next.seqEnd != null ? { seqEnd: next.seqEnd } : {}),
  };
  if (msg.liveSeqs || next.liveSeqs) joined.liveSeqs = [...(msg.liveSeqs ?? []), ...(thought.liveSeqs ?? []), ...(next.liveSeqs ?? [])];
  if (msg.sourceSeqRanges || next.sourceSeqRanges) joined.sourceSeqRanges = [...(msg.sourceSeqRanges ?? []), ...(next.sourceSeqRanges ?? [])];
  return [thought, joined];
}

/** Re-join every assistant / reasoning / assistant run in a loaded (projected) entry list. */
export function coalesceReplies(entries) {
  const out = [];
  for (const e of entries) {
    const n = out.length;
    const pair = n >= 2 ? rejoinReply(out[n - 2], out[n - 1], e) : null;
    if (pair) out.splice(n - 2, 2, ...pair);
    else out.push(e);
  }
  return out;
}
