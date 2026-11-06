// Pure helpers for timeline filters, search hits and prompt jumps (no daemon imports, node --test friendly).
export type TimelineFilter = "all" | "text" | "tools" | "errors";
export const TIMELINE_FILTERS: TimelineFilter[] = ["all", "text", "tools", "errors"];

type Ent = { item: any; timestamp?: string; seqStart?: number; seqEnd?: number; sourceSeqRanges?: { startSeq: number; endSeq: number }[]; liveSeqs?: number[]; segStart?: number };

const isFailed = (it: any) =>
  it.status === "failed" || it.status === "error" || !!it.error || (it.detail?.exitCode != null && it.detail.exitCode !== 0);

export function matchesFilter(it: any, f: TimelineFilter): boolean {
  if (f === "all") return true;
  if (!it || typeof it !== "object") return false;
  const t = String(it.type ?? "");
  switch (f) {
    case "text":
      return t === "user_message" || t === "assistant_message" || t === "reasoning" || t === "provider_switch";
    case "tools":
      return t === "tool_call";
    case "errors":
      return t === "error" || (t === "tool_call" && isFailed(it));
  }
}

export function filterEntries<T extends Ent>(entries: T[], f: TimelineFilter): T[] {
  return f === "all" ? entries : entries.filter((e) => matchesFilter(e.item, f));
}

export type SearchLocation = { seq: number; role: "user" | "assistant"; count?: number };

/** Search hits sorted ascending by seq, de-duplicated. */
export function sortedHits(locations: SearchLocation[]): SearchLocation[] {
  const seen = new Set<number>();
  return [...locations].filter((l) => !seen.has(l.seq) && !!seen.add(l.seq)).sort((a, b) => a.seq - b.seq);
}

/** Index of the entry a seq falls in: the last entry whose seqStart <= seq. -1 when none is loaded. */
export function entryIndexForSeq(entries: Ent[], seq: number): number {
  let idx = -1;
  for (let i = 0; i < entries.length; i++) {
    const s = entries[i].seqStart;
    if (typeof s === "number" && s <= seq) idx = i;
    else if (typeof s === "number" && s > seq) break;
  }
  return idx;
}

/** Wrap-around step through a list of length n; returns -1 for an empty list. */
export function stepIndex(cur: number, dir: 1 | -1, n: number): number {
  if (n <= 0) return -1;
  if (cur < 0) return dir === 1 ? 0 : n - 1;
  return (cur + dir + n) % n;
}

/** Prompt to jump to relative to the first prompt visible at/after `seq` (prev < seq < next). */
export function adjacentPrompt<P extends { seq: number }>(prompts: P[], seq: number, dir: 1 | -1): P | null {
  const sorted = [...prompts].sort((a, b) => a.seq - b.seq);
  if (dir === 1) return sorted.find((p) => p.seq > seq) ?? null;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].seq < seq) return sorted[i];
  return null;
}

const entryText = (it: any): string =>
  typeof it?.text === "string" ? it.text : typeof it?.message === "string" ? it.message : "";

/** Client-side stand-in for the daemon search (demo mode): user/assistant messages only. */
export function localSearch(entries: Ent[], query: string): SearchLocation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchLocation[] = [];
  entries.forEach((e, i) => {
    const t = e.item?.type;
    if (t !== "user_message" && t !== "assistant_message") return;
    const hay = entryText(e.item).toLowerCase();
    let count = 0;
    for (let p = hay.indexOf(q); p !== -1; p = hay.indexOf(q, p + q.length)) count++;
    if (count) out.push({ seq: e.seqStart ?? i, role: t === "user_message" ? "user" : "assistant", count });
  });
  return out;
}

export function localPrompts(entries: Ent[]): Array<{ seq: number; timestamp: string; preview: string }> {
  const out: Array<{ seq: number; timestamp: string; preview: string }> = [];
  entries.forEach((e, i) => {
    if (e.item?.type === "user_message") out.push({ seq: e.seqStart ?? i, timestamp: e.timestamp ?? "", preview: entryText(e.item).slice(0, 120) });
  });
  return out;
}

// ---- live stream merging (optimistic entries until the authoritative refetch lands) ----

/** Thought text across provider shapes (antigravity-cli puts it in summary/thinking/detail). */
export function reasoningText(it: any): string {
  return String(it?.text ?? it?.summary ?? it?.thinking ?? it?.detail?.text ?? "");
}

const STREAMED = new Set(["assistant_message", "reasoning"]);

/**
 * Fold one live `timeline` stream item into the loaded entries. Streamed text/reasoning chunks extend the
 * tail entry of the same type, a tool_call with the same callId replaces its row, anything else appends.
 * The debounced projected refetch replaces the whole list, so optimistic rows never linger or duplicate.
 */
const coversSeq = (e: Ent, seq: number) =>
  e.liveSeqs?.includes(seq) ||
  (e.sourceSeqRanges ? e.sourceSeqRanges.some((r) => seq >= r.startSeq && seq <= r.endSeq) : e.seqStart != null && seq >= e.seqStart && seq <= (e.seqEnd ?? e.seqStart));

/** Two assistant items are one message unless both carry a message id and the ids differ. */
const sameMessage = (a: any, b: any) => {
  const x = a.messageId ?? a.id;
  const y = b.messageId ?? b.id;
  return x == null || y == null || x === y;
};
/** True when `seq` directly follows the entry's last known seq (or either side has no seq to compare). */
const contiguous = (e: Ent, seq?: number) => {
  if (seq == null) return true;
  const known = [...(e.liveSeqs ?? []), ...(e.seqEnd != null ? [e.seqEnd] : [])];
  return known.length === 0 || seq === Math.max(...known) + 1;
};

/**
 * `seq` is the canonical row number of the stream event: a seq already folded into (or loaded in) an entry is
 * ignored, so redelivered events can't append their text twice. Chunk text is treated as a delta (each seq is one
 * canonical row and the projection concatenates rows via "assistant_merge"/"reasoning_merge").
 */
export function mergeLiveItem<T extends Ent>(entries: T[], item: any, timestamp?: string, seq?: number): T[] {
  if (!item || typeof item !== "object") return entries;
  if (seq != null && entries.some((e) => coversSeq(e, seq))) return entries;
  const type = String(item.type ?? "");
  const last = entries[entries.length - 1];
  // A thought chunk landing mid-reply must not split the message: text right after a trailing reasoning row rejoins the
  // assistant message before it (same message id if the provider gives one, no seq gap) and the thought moves ahead of
  // the reply. Raw concat, no separator: AGY output chunks are deltas. `segStart` marks where the post-thought segment
  // begins so snapshot-vs-delta is judged against that segment alone.
  const prevMsg = entries[entries.length - 2];
  if (type === "assistant_message" && last?.item?.type === "reasoning" && prevMsg?.item?.type === "assistant_message" && sameMessage(prevMsg.item, item) && contiguous(last, seq)) {
    const prev = String(prevMsg.item.text ?? "");
    const joined = { ...prevMsg, item: { ...prevMsg.item, text: prev + String(item.text ?? "") }, segStart: prev.length, liveSeqs: seq != null ? [...(prevMsg.liveSeqs ?? []), ...(last.liveSeqs ?? []), seq] : prevMsg.liveSeqs };
    return [...entries.slice(0, -2), last, joined] as T[];
  }
  if (last && last.item && last.item.type === type) {
    if (STREAMED.has(type)) {
      const field = type === "reasoning" && last.item.text == null && last.item.summary != null ? "summary" : "text";
      const prev = String(last.item[field] ?? "");
      const add = type === "reasoning" ? reasoningText(item) : String(item.text ?? "");
      // Snapshot providers resend the whole text; delta providers send only the new part. A strictly longer text
      // that extends the tail is a snapshot (replace), everything else is a delta (append). The message id can't
      // tell them apart: claude deltas reuse one messageId (claude/agent.js:943). After a rejoined thought only the
      // current segment (from segStart) takes part in that comparison.
      const seg = type === "assistant_message" ? last.segStart ?? 0 : 0;
      const head = prev.slice(0, seg);
      const segPrev = prev.slice(seg);
      const text = head + (add.length > segPrev.length && add.startsWith(segPrev) ? add : segPrev + add);
      const merged = { ...last.item, [field]: text };
      return [...entries.slice(0, -1), { ...last, item: merged, liveSeqs: seq != null ? [...(last.liveSeqs ?? []), seq] : last.liveSeqs }];
    }
  }
  if (type === "tool_call" && item.callId != null) {
    for (let i = entries.length - 1; i >= 0 && i >= entries.length - 20; i--) {
      const x = entries[i].item;
      if (x && x.type === "tool_call" && x.callId === item.callId) {
        const next = entries.slice();
        next[i] = { ...entries[i], liveSeqs: seq != null ? [...(entries[i].liveSeqs ?? []), seq] : entries[i].liveSeqs, item: { ...x, ...item, detail: { ...(x.detail ?? {}), ...(item.detail ?? {}) } } };
        return next;
      }
    }
  }
  return [...entries, { item, timestamp, liveSeqs: seq != null ? [seq] : undefined } as T];
}

/** Index of the most recent reasoning entry, or -1. */
export function latestReasoningIndex(entries: Ent[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].item?.type === "reasoning") return i;
  return -1;
}

/** Highest canonical seq covered by the loaded entries (null when none carry a seq). */
export function maxEntrySeq(entries: Ent[]): number | null {
  let max: number | null = null;
  const bump = (n: number | undefined) => {
    if (n != null && (max === null || n > max)) max = n;
  };
  for (const e of entries) {
    bump(e.seqEnd ?? e.seqStart);
    e.liveSeqs?.forEach(bump);
    e.sourceSeqRanges?.forEach((r) => bump(r.endSeq));
  }
  return max;
}

/**
 * Whether a live stream event needs a healing refetch. Live events already fold into the entries
 * (mergeLiveItem), so the per-event refetch only guards against lost events:
 *  - "gap": seq jumped past lastSeq+1, rows are missing, refetch soon.
 *  - "unverified": no seq or no baseline to compare, refetch once the stream goes quiet.
 *  - "none": contiguous or redelivered, nothing to heal.
 */
export function syncNeeded(lastSeq: number | null, seq: number | undefined): "none" | "gap" | "unverified" {
  if (seq == null || lastSeq == null) return "unverified";
  return seq > lastSeq + 1 ? "gap" : "none";
}
