// Pure logic for the Subagents list: merge the daemon's list with ids scraped from
// sub_agent tool calls, sort, label. Dependency-free so node --test can load it.

export interface SubagentRow {
  id: string;
  title: string;
  status: string; // running | completed | failed | canceled | "" when unknown (scraped only)
  updatedAt: string;
  fromApi: boolean;
}

export interface ApiSubagent {
  id: string;
  title?: string | null;
  description?: string | null;
  subtitle?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  toolCallId?: string | null;
}

export interface ScrapedSubagent {
  id: string;
  title?: string;
  status?: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  canceled: "canceled",
};

export function subagentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABEL[status] ?? status;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function subagentTitle(a: ApiSubagent): string {
  const t = a.title?.trim() || a.description?.trim() || a.subtitle?.trim() || "";
  return t ? clip(t, 120) : `sub-agent ${a.id.slice(0, 8)}`;
}

// API rows win over scraped rows with the same id (or the same toolCallId); scraped-only
// rows are kept so a sub-agent shows up before the daemon list catches up.
export function mergeSubagents(api: ApiSubagent[] | null | undefined, scraped: ScrapedSubagent[] = []): SubagentRow[] {
  const rows = new Map<string, SubagentRow>();
  const byToolCall = new Set<string>();
  for (const a of api ?? []) {
    if (!a?.id) continue;
    rows.set(a.id, {
      id: a.id,
      title: subagentTitle(a),
      status: a.status ?? "",
      updatedAt: a.updatedAt ?? a.createdAt ?? "",
      fromApi: true,
    });
    if (a.toolCallId) byToolCall.add(a.toolCallId);
  }
  for (const s of scraped) {
    if (!s?.id || rows.has(s.id) || byToolCall.has(s.id)) continue;
    rows.set(s.id, {
      id: s.id,
      title: s.title ? clip(s.title, 120) : `sub-agent ${s.id.slice(0, 8)}`,
      status: s.status === "running" || s.status === "failed" || s.status === "completed" ? s.status : "",
      updatedAt: "",
      fromApi: false,
    });
  }
  return sortSubagents([...rows.values()]);
}

// Running first, then newest update first, then title for a stable order.
export function sortSubagents(rows: SubagentRow[]): SubagentRow[] {
  return [...rows].sort((a, b) => {
    const ar = a.status === "running" ? 0 : 1;
    const br = b.status === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

function subIdOf(it: any, d: any): string {
  return String(d.subAgentId ?? d.agentId ?? it.callId ?? "");
}

// Changes whenever a sub_agent tool call appears or its status changes -> refetch trigger.
export function subagentSignature(entries: any[], isSubAgent: (it: any, d: any) => boolean): string {
  const parts: string[] = [];
  for (const e of entries ?? []) {
    const it = e?.item;
    if (!it || it.type !== "tool_call") continue;
    const d = it.detail ?? {};
    if (!isSubAgent(it, d)) continue;
    parts.push(`${subIdOf(it, d)}:${it.status ?? ""}`);
  }
  return parts.join("|");
}

export function scrapedSubagents(entries: any[], isSubAgent: (it: any, d: any) => boolean): ScrapedSubagent[] {
  const out: ScrapedSubagent[] = [];
  for (const e of entries ?? []) {
    const it = e?.item;
    if (!it || it.type !== "tool_call") continue;
    const d = it.detail ?? {};
    if (!isSubAgent(it, d)) continue;
    const id = subIdOf(it, d);
    if (!id) continue;
    out.push({ id, title: d.description ?? undefined, status: it.status });
  }
  return out;
}
