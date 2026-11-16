// Per-agent "oldest open tool call" HINT from timeline events (UX_REVIEW R3-2). R4-1: the runner backend now reports the authoritative
// openToolSince / openToolName / openToolTimeoutMs on the agent payload, and attentionItems.openToolOf() prefers those; this store is only
// the fallback for agents whose payload has no such field (older server, other backends). useTimeline calls noteOpenTools() as entries
// change; agents whose timeline was never loaded this session have no data here.
// Import-free so node tests can drive it.

const OPEN_STATUSES = new Set(["running", "in_progress", "pending"]);
const oldestOpenStart = new Map<string, number>();

/** Record (or clear) the oldest open tool_call start for `agentId` from its timeline entries. */
export function noteOpenTools(agentId: string, entries: ReadonlyArray<{ item?: any; timestamp?: string }>): void {
  let oldest: number | null = null;
  for (const e of entries) {
    const it = e?.item;
    if (it?.type !== "tool_call" || !OPEN_STATUSES.has(String(it.status))) continue;
    const t = Date.parse(e.timestamp ?? "");
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (oldest === null) oldestOpenStart.delete(agentId);
  else oldestOpenStart.set(agentId, oldest);
}

/** Age in seconds of the oldest open tool call for the agent, or null when none is known to be in flight. */
export function openToolSeconds(agentId: string, now: number): number | null {
  const start = oldestOpenStart.get(agentId);
  return start === undefined ? null : Math.max(0, Math.floor((now - start) / 1000));
}

/** Callback for attentionItems / needsYouCount / stalledCount. */
export const toolRunningSecondsAt = (now: number) => (a: { id: string }): number | null => openToolSeconds(a.id, now);

export function clearOpenTools(): void {
  oldestOpenStart.clear();
}
