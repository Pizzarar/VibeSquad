// Pure helpers for the plugin-updates preview (parity block P5). No imports; shapes are structural.

export interface UpdatePreviewLike {
  id: string;
  outcome: "error" | "local" | "update" | "current" | "installed-newer";
  proposal?: unknown;
  error?: string;
  links?: string[];
  target?: { kind: string; commit?: string; version?: string };
  current?: { currentRevision?: string };
}

/** Only previews that carry a proposal can be taken. */
export const isTakeable = (p: UpdatePreviewLike): boolean => p.outcome === "update" && p.proposal != null;

export function toggleSelection(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Nothing is pre-ticked (applying an update is the user's call); selection drops ids that are no longer takeable. */
export function pruneSelection(sel: ReadonlySet<string>, previews: readonly UpdatePreviewLike[]): Set<string> {
  const ok = new Set(previews.filter(isTakeable).map((p) => p.id));
  return new Set([...sel].filter((id) => ok.has(id)));
}

export function selectedProposals<T extends UpdatePreviewLike>(previews: readonly T[], sel: ReadonlySet<string>): NonNullable<T["proposal"]>[] {
  return previews.filter((p) => sel.has(p.id) && isTakeable(p)).map((p) => p.proposal as NonNullable<T["proposal"]>);
}

const short = (s?: string) => (s ? s.slice(0, 8) : "?");

export function describeTarget(p: UpdatePreviewLike): string {
  if (!p.target) return "";
  const from = short(p.current?.currentRevision);
  if (p.target.kind === "npm") return `${from} → v${p.target.version ?? "?"}`;
  return `${from} → ${short(p.target.commit)}`;
}

export function outcomeLabel(o: UpdatePreviewLike["outcome"]): { label: string; tone: "ok" | "warn" | "hot" } {
  switch (o) {
    case "update": return { label: "update available", tone: "warn" };
    case "current": return { label: "up to date", tone: "ok" };
    case "installed-newer": return { label: "installed is newer", tone: "ok" };
    case "local": return { label: "local (no source)", tone: "ok" };
    default: return { label: "error", tone: "hot" };
  }
}

/** Detail shown beside a result row: the error and/or the warning (an updated plugin can still carry a warning). */
export function resultNote(r: { error?: string; warning?: string }): string {
  return [r.error, r.warning ? `warning: ${r.warning}` : ""].filter(Boolean).join(" · ");
}

export function summarizeResults(results: readonly { id: string; outcome: "updated" | "error"; error?: string; warning?: string }[]): string {
  const ok = results.filter((r) => r.outcome === "updated").length;
  const bad = results.length - ok;
  return `${ok} updated${bad ? `, ${bad} failed` : ""}`;
}
