// Pure helpers for Batch H (session lifecycle): fork, export, schedules, closed-tab stack.
// No React, DOM or daemon imports, so node --test can load this file directly.

type EntryLike = { item?: any; timestamp?: string; seqStart?: number };

/** Demo fallback: drop everything after the rewound message (the message itself stays unless edited resend). */
export function truncateAfter<T extends EntryLike>(entries: T[], e: EntryLike): T[] {
  const i = entries.findIndex((x) => x === e || (e.seqStart !== undefined && x.seqStart === e.seqStart));
  return i < 0 ? entries : entries.slice(0, i + 1);
}

const roleOf = (it: any): string | null =>
  it?.type === "user_message" ? "User" : it?.type === "assistant_message" ? "Assistant" : null;

export function transcriptToMarkdown(title: string, entries: EntryLike[]): string {
  const out = [`# ${title || "Transcript"}`, ""];
  for (const e of entries) {
    const it = e.item;
    const role = roleOf(it);
    if (role && typeof it.text === "string") {
      out.push(`## ${role}${e.timestamp ? ` · ${e.timestamp}` : ""}`, "", it.text, "");
    } else if (it?.type === "tool_call") {
      out.push(`> tool: ${it.name ?? it.detail?.name ?? "call"}`, "");
    }
  }
  return out.join("\n");
}

export function transcriptToJson(agentId: string, title: string, entries: EntryLike[]): string {
  return JSON.stringify({ agentId, title, exportedEntries: entries.length, entries }, null, 2);
}

export function exportFileName(title: string, ext: "md" | "json"): string {
  const slug = (title || "transcript").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug || "transcript"}.${ext}`;
}

/** Fallback fork prompt when the daemon has no fork-context endpoint: a short summary of the recent turns. */
export function forkSummaryPrompt(title: string, entries: EntryLike[], max = 6): string {
  const turns = entries
    .filter((e) => roleOf(e.item) && typeof e.item.text === "string")
    .slice(-max)
    .map((e) => `${roleOf(e.item)}: ${e.item.text.slice(0, 400)}`);
  return `Forked from "${title}". Recent context:\n\n${turns.join("\n\n")}\n\nContinue from here.`;
}

export const forkTitle = (title: string) => (/^⑂ /.test(title) ? title : `⑂ ${title}`);

// ---- schedules ------------------------------------------------------------------------

export type ScheduleAction = "pause" | "resume" | "run";
export function scheduleActionsFor(status: string): ScheduleAction[] {
  if (status === "paused") return ["resume", "run"];
  if (status === "active") return ["pause", "run"];
  return [];
}
export function nextScheduleStatus(status: string, action: ScheduleAction): string {
  if (action === "pause" && status === "active") return "paused";
  if (action === "resume" && status === "paused") return "active";
  return status;
}

// ---- closed-tab stack -----------------------------------------------------------------

export const CLOSED_TABS_MAX = 20;
export function pushClosed(stack: string[], id: string): string[] {
  return [...stack.filter((x) => x !== id), id].slice(-CLOSED_TABS_MAX);
}
export function popClosed(stack: string[], isOpen: (id: string) => boolean): { id: string | null; rest: string[] } {
  const rest = [...stack];
  while (rest.length) {
    const id = rest.pop()!;
    if (!isOpen(id)) return { id, rest };
  }
  return { id: null, rest };
}
