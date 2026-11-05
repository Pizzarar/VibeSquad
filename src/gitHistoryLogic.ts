// Pure helpers for the Changes panel history / rename / PR-details UI. Dependency-free (node --test).

/** Parse "https://github.com/<owner>/<repo>/pull/<n>" (also gitlab-style /-/merge_requests/n). */
export function parsePrUrl(url: string | null | undefined): { repoOwner: string; repoName: string; number: number } | null {
  if (!url) return null;
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(?:-\/)?(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return m ? { repoOwner: m[1], repoName: m[2], number: Number(m[3]) } : null;
}

/** Local pre-check mirroring git's ref-name rules. Returns an error message, or null when OK. */
export function branchNameError(name: string, current?: string | null): string | null {
  const n = name.trim();
  if (!n) return "Enter a branch name";
  if (current && n === current) return "Same as the current branch";
  if (/\s/.test(n)) return "No spaces allowed";
  if (/[~^:?*\[\\\x00-\x1f\x7f]/.test(n)) return "Contains an illegal character";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) return "Invalid start or end";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Invalid sequence";
  if (n.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) return "Invalid path segment";
  return null;
}

/** Compact relative time from an ISO string. */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

/** One-letter badge for a commit file status. */
export function commitFileBadge(status?: string): "A" | "D" | "R" | "M" {
  return status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";
}

/** Class suffix for the badge (maps onto the existing new/del/mod colours). */
export function commitFileBadgeClass(status?: string): "new" | "del" | "mod" {
  return status === "added" ? "new" : status === "deleted" ? "del" : "mod";
}

/** Trim long text for display. */
export function clip(s: string | null | undefined, max = 600): string {
  const v = s ?? "";
  return v.length > max ? v.slice(0, max) + "…" : v;
}
