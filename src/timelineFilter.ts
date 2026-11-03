// Pure helpers for timeline filters, search hits and prompt jumps (no daemon imports, node --test friendly).
export type TimelineFilter = "all" | "text" | "tools" | "errors";
export const TIMELINE_FILTERS: TimelineFilter[] = ["all", "text", "tools", "errors"];

type Ent = { item: any; timestamp?: string; seqStart?: number; seqEnd?: number; sourceSeqRanges?: { startSeq: number; endSeq: number }[]; liveSeqs?: number[] };

const isFailed = (it: any) =>
  it.status === "failed" || it.status === "error" || !!it.error || (it.detail?.exitCode != null && it.detail.exitCode !== 0);

export function matchesFilter(it: any, f: TimelineFilter): boolean {
  if (f === "all") return true;
  if (!it || typeof it !== "object") return false;
  const t = String(it.type ?? "");
  switch (f) {
    case "text":
      return t === "user_message" || t === "assistant_message" || t === "reasoning";
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
  if (last && last.item && last.item.type === type) {
    if (STREAMED.has(type)) {
      const field = type === "reasoning" && last.item.text == null && last.item.summary != null ? "summary" : "text";
      const prev = String(last.item[field] ?? "");
      const add = type === "reasoning" ? reasoningText(item) : String(item.text ?? "");
      const merged = { ...last.item, [field]: prev + add };
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
