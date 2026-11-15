// Pure helpers for Normal-mode tool-call rows (UX_REVIEW 2.7). Everything is derived from fields the timeline
// already carries; absent duration / diff data is omitted, never invented.
import { isFailedTool } from "./toolRuns.ts";

export const TOOL_OUTPUT_FOLD_LINES = 12;

export type ToolKind = "shell" | "edit" | "read" | "search" | "web" | "agent" | "other";

export function toolKind(it: any, d: any = it?.detail ?? {}): ToolKind {
  const name = String(it?.name ?? "").toLowerCase();
  if (d?.type === "shell" || name === "bash" || name === "powershell" || name === "run_command") return "shell";
  if (d?.type === "sub_agent" || name === "task" || name === "agent") return "agent";
  if (/(^|_)(edit|write|multiedit|notebookedit|apply_patch|patch)/.test(name) || d?.unifiedDiff || d?.diff || d?.oldString != null || d?.newString != null) return "edit";
  if (/read|view|cat/.test(name)) return "read";
  if (/grep|glob|search|find|ls$/.test(name)) return "search";
  if (/web|fetch|http/.test(name) || d?.url) return "web";
  return "other";
}

export function toolTarget(it: any, d: any = it?.detail ?? {}): string {
  const raw = d.type === "shell" ? d.command : d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "";
  return typeof raw === "string" ? raw : "";
}

/** +/- line counts: from a unified diff when present, else old/new strings. null when neither exists. */
export function diffStats(d: any): { add: number; del: number } | null {
  const diff = d?.unifiedDiff ?? d?.diff;
  if (typeof diff === "string" && diff) {
    let add = 0;
    let del = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return { add, del };
  }
  if (typeof d?.newString === "string" || typeof d?.oldString === "string") {
    const n = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);
    return { add: n(d.newString), del: n(d.oldString) };
  }
  return null;
}

/** Duration in ms from fields the item may carry; null when unknown. */
export function toolDurationMs(it: any, d: any = it?.detail ?? {}): number | null {
  for (const v of [it?.durationMs, d?.durationMs, d?.elapsedMs]) if (typeof v === "number" && v >= 0 && isFinite(v)) return v;
  const a = Date.parse(it?.startedAt ?? d?.startedAt ?? "");
  const b = Date.parse(it?.completedAt ?? d?.completedAt ?? it?.finishedAt ?? "");
  if (isFinite(a) && isFinite(b) && b >= a) return b - a;
  return null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** `N tools · M edits (+X −Y) · K failed · Ts`; segments with no data are omitted. */
export function summarizeTools(items: any[]): string {
  const parts = [`${items.length} ${items.length === 1 ? "tool" : "tools"}`];
  let edits = 0, add = 0, del = 0, failed = 0, ms = 0, anyMs = false;
  for (const it of items) {
    const d = it?.detail ?? {};
    if (isFailedTool(it, d)) failed++;
    if (toolKind(it, d) === "edit") {
      edits++;
      const s = diffStats(d);
      if (s) { add += s.add; del += s.del; }
    }
    const t = toolDurationMs(it, d);
    if (t != null) { ms += t; anyMs = true; }
  }
  if (edits) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}${add || del ? ` (+${add} −${del})` : ""}`);
  if (failed) parts.push(`${failed} failed`);
  if (anyMs) parts.push(formatDuration(ms));
  return parts.join(" · ");
}

/** Fold long output at `limit` lines. */
export function foldLines(text: string, limit = TOOL_OUTPUT_FOLD_LINES): { head: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { head: text, hidden: 0 };
  return { head: lines.slice(0, limit).join("\n"), hidden: lines.length - limit };
}
