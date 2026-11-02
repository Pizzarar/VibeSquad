// Pure helpers for timeline filters, search hits and prompt jumps (no daemon imports, node --test friendly).
export type TimelineFilter = "all" | "text" | "tools" | "errors";
export const TIMELINE_FILTERS: TimelineFilter[] = ["all", "text", "tools", "errors"];

type Ent = { item: any; timestamp?: string; seqStart?: number };

const isFailed = (it: any) =>
  it.status === "failed" || it.status === "error" || !!it.error || (it.detail?.exitCode != null && it.detail.exitCode !== 0);

export function matchesFilter(it: any, f: TimelineFilter): boolean {
  if (f === "all") return true;
  if (!it || typeof it !== "object") return false;
  const t = String(it.type ?? "");
  switch (f) {
    case "text":
      return t === "user_message" || t === "assistant_message";
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
