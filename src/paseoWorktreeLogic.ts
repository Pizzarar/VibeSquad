// Pure helpers for the Paseo worktree manager (no daemon imports, node --test friendly).
import { branchShapeError } from "./workspaceLogic.ts";

export type WorktreeEntry = { worktreePath: string; createdAt: string; branchName?: string | null; head?: string | null };
export type WtAgent = { id: string; title?: string | null; cwd?: string | null; status?: string | null; archivedAt?: string | null };
export type WtWorkspace = { id: string; workspaceDirectory?: string | null; gitRuntime?: { isDirty?: boolean | null } | null };

export const normPath = (p: string | null | undefined) => String(p ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

/** True when `child` is `dir` or sits under it (case-insensitive, either slash). */
export function isInside(child: string | null | undefined, dir: string | null | undefined): boolean {
  const c = normPath(child);
  const d = normPath(dir);
  return !!d && !!c && (c === d || c.startsWith(d + "/"));
}

/** Newest first; undated rows last, then by path. */
export function sortWorktrees<T extends WorktreeEntry>(rows: T[]): T[] {
  const t = (r: T) => {
    const n = Date.parse(r.createdAt);
    return Number.isFinite(n) ? n : -Infinity;
  };
  return [...rows].sort((a, b) => t(b) - t(a) || a.worktreePath.localeCompare(b.worktreePath));
}

/** Slug becomes the worktree folder and branch name: one branch-safe path segment. */
export function worktreeSlugError(slug: string): string | null {
  const s = slug.trim();
  if (!s) return "Slug is empty.";
  if (/[\\/]/.test(s)) return "Slug is one folder name: no slashes.";
  if (s.length > 64) return "Slug is too long (64 characters max).";
  return branchShapeError(s);
}

/** Base ref is optional (daemon picks the default branch); when given it must be ref-shaped. */
export function baseRefError(ref: string): string | null {
  return ref.trim() ? branchShapeError(ref) : null;
}

/** Same policy as agent archive: running agents must be stopped first. Returns a refusal or null. */
export function archiveGuard(worktreePath: string, agents: WtAgent[]): string | null {
  const running = agents.filter((a) => !a.archivedAt && a.status === "running" && isInside(a.cwd, worktreePath));
  if (!running.length) return null;
  const names = running.slice(0, 3).map((a) => a.title || a.id.slice(0, 8)).join(", ");
  const more = running.length > 3 ? ` +${running.length - 3}` : "";
  return `${running.length} running agent${running.length > 1 ? "s" : ""} inside (${names}${more}). Stop ${running.length > 1 ? "them" : "it"} first.`;
}

/** Click-time guard for the destructive path: reads the agent list when called, never a render-time snapshot. */
export const archiveGuardNow = (worktreePath: string, readAgents: () => WtAgent[]): string | null => archiveGuard(worktreePath, readAgents());

/** Live (non-archived, non-closed) agents whose cwd is inside the worktree. */
export const linkedAgents = <A extends WtAgent>(worktreePath: string, agents: A[]): A[] =>
  agents.filter((a) => !a.archivedAt && a.status !== "closed" && isInside(a.cwd, worktreePath));

/** The workspace record pointing exactly at the worktree folder, if Paseo has one. */
export const linkedWorkspace = <W extends WtWorkspace>(worktreePath: string, workspaces: W[]): W | null =>
  workspaces.find((w) => !!w.workspaceDirectory && normPath(w.workspaceDirectory) === normPath(worktreePath)) ?? null;
