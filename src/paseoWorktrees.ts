// Block P1 wrappers: Paseo-owned worktree list / create / archive. Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";
import type { PaseoWorkspace } from "@getpaseo/client";
import { sortWorktrees, type WorktreeEntry } from "./paseoWorktreeLogic";

/** Timebox daemon calls: a hang is reported as an error, never waited out silently. */
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

/** Paseo worktrees of the repo containing `repoRoot`, newest first. */
export async function listPaseoWorktrees(repoRoot: string, timeoutMs = 10000): Promise<WorktreeEntry[]> {
  const res = await withTimeout(daemonClient.getPaseoWorktreeList({ repoRoot }), timeoutMs, "Worktree list");
  if (res.error) throw new Error(res.error.message);
  return sortWorktrees(res.worktrees ?? []);
}

/**
 * Branches a new Paseo worktree off `baseRef` (daemon default branch when empty).
 * Our timeout only stops waiting: the daemon may still finish, so the caller reloads the list either way.
 */
export async function createPaseoWorktree(
  cwd: string,
  slug: string,
  baseRef: string,
  projectId?: string,
  timeoutMs = 60000,
): Promise<{ workspace: PaseoWorkspace | null; setupSkippedReason: string | null }> {
  const res = await withTimeout(
    daemonClient.createPaseoWorktree({
      cwd,
      worktreeSlug: slug.trim(),
      action: "branch-off",
      ...(baseRef.trim() ? { refName: baseRef.trim() } : {}),
      ...(projectId ? { projectId } : {}),
    }),
    timeoutMs,
    "Create worktree",
  );
  if (res.error) throw new Error(res.error);
  return { workspace: (res.workspace as PaseoWorkspace | null) ?? null, setupSkippedReason: res.setupSkippedReason ?? null };
}

/** Archives a worktree (scope "worktree": the daemon removes its workspace records and agents with it). */
export async function archivePaseoWorktree(worktreePath: string, repoRoot: string, timeoutMs = 30000): Promise<{ removedAgents: string[] }> {
  const res = await withTimeout(daemonClient.archivePaseoWorktree({ worktreePath, repoRoot, scope: "worktree" }), timeoutMs, "Archive worktree");
  if (!res.success || res.error) throw new Error(res.error?.message ?? "Archive failed");
  return { removedAgents: res.removedAgents ?? [] };
}
