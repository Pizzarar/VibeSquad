// Pure helpers for folding consecutive successful tool_call entries into a single compact run (PLAN_CHAT_ROOM C1).
// Only finished-OK tool calls (completed/done/success/no status, non-failed, non-sub-agent) are eligible to fold;
// any running, in-progress, pending, awaiting-permission, waiting, or queued call stays visible and breaks the run.

export type ToolEntry = { item?: any; timestamp?: string; seqStart?: number };

export type ToolRunGroup<E extends ToolEntry = ToolEntry> =
  | { kind: "entry"; entry: E; index: number }
  | {
      kind: "run";
      entries: E[];
      startIndex: number;
      count: number;
      names: string[];
      truncatedNames: string;
      label: string;
    };

const FINISHED_OK_STATUSES = new Set(["completed", "done", "success", ""]);

export function isFailedTool(it: any, d: any = it?.detail ?? {}): boolean {
  return Boolean(
    it && (it.status === "failed" || it.status === "error" || !!it.error || (d?.exitCode != null && d.exitCode !== 0)),
  );
}

export function isSubAgentTool(it: any, d: any = it?.detail ?? {}): boolean {
  return Boolean(it && (d?.type === "sub_agent" || it.name === "Task" || !!(d?.subAgentId || d?.agentId || it.subagentId)));
}

/** Whitelist of finished-OK states: completed, done, success, or no status. */
export function isFinishedOkStatus(status: unknown): boolean {
  if (status == null) return true;
  return typeof status === "string" && FINISHED_OK_STATUSES.has(status.trim());
}

/** Any non-finished-OK, non-failed status (running, in_progress, pending, awaiting_permission, waiting, queued, etc.). */
export function isRunningTool(it: any): boolean {
  if (!it || typeof it !== "object") return false;
  if (isFailedTool(it, it.detail ?? {})) return false;
  return !isFinishedOkStatus(it.status);
}

export function isFoldableToolEntry(e: ToolEntry | null | undefined): boolean {
  const it = e?.item;
  if (!it || typeof it !== "object" || it.type !== "tool_call") return false;
  const d = it.detail ?? {};
  if (isSubAgentTool(it, d) || isFailedTool(it, d) || !isFinishedOkStatus(it.status)) return false;
  return true;
}

export function uniqueToolNames(entries: ToolEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const raw = typeof e?.item?.name === "string" ? e.item.name.trim() : "";
    const name = raw || "tool";
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function formatToolNames(names: string[], maxNames = 3): string {
  if (names.length === 0) return "";
  if (names.length <= maxNames) return names.join(", ");
  return `${names.slice(0, maxNames).join(", ")}…`;
}

export function formatToolRunLabel(count: number, names: string[], maxNames = 3): string {
  const truncated = formatToolNames(names, maxNames);
  return truncated ? `${count} tool calls · ${truncated}` : `${count} tool calls`;
}

export function toolRunToggleKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

export function toolEntryRunKey(e: ToolEntry, fallbackIndex: number): string {
  if (e?.seqStart != null) return `seq:${e.seqStart}`;
  if (e?.item?.callId != null && e.item.callId !== "") return `call:${e.item.callId}`;
  return `idx:${fallbackIndex}`;
}

export function isRunExpanded(
  run: { entries: ToolEntry[]; startIndex: number },
  expandedKeys: ReadonlySet<string>,
): boolean {
  return run.entries.some((e, k) => expandedKeys.has(toolEntryRunKey(e, run.startIndex + k)));
}

export function toggleRunExpanded(
  run: { entries: ToolEntry[]; startIndex: number },
  expandedKeys: ReadonlySet<string>,
  force?: boolean,
): Set<string> {
  const next = new Set(expandedKeys);
  const expand = force ?? !isRunExpanded(run, expandedKeys);
  for (let k = 0; k < run.entries.length; k++) {
    const key = toolEntryRunKey(run.entries[k], run.startIndex + k);
    if (expand) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function groupToolRuns<E extends ToolEntry>(
  entries: E[],
  collapseToolCalls = true,
  maxNames = 3,
): ToolRunGroup<E>[] {
  if (!collapseToolCalls) {
    return entries.map((entry, index) => ({ kind: "entry", entry, index }));
  }
  const out: ToolRunGroup<E>[] = [];
  let i = 0;
  while (i < entries.length) {
    if (!isFoldableToolEntry(entries[i])) {
      out.push({ kind: "entry", entry: entries[i], index: i });
      i++;
      continue;
    }
    const startIndex = i;
    const run: E[] = [];
    while (i < entries.length && isFoldableToolEntry(entries[i])) {
      run.push(entries[i]);
      i++;
    }
    if (run.length === 1) {
      out.push({ kind: "entry", entry: run[0], index: startIndex });
    } else {
      const names = uniqueToolNames(run);
      const truncatedNames = formatToolNames(names, maxNames);
      const label = formatToolRunLabel(run.length, names, maxNames);
      out.push({
        kind: "run",
        entries: run,
        startIndex,
        count: run.length,
        names,
        truncatedNames,
        label,
      });
    }
  }
  return out;
}
