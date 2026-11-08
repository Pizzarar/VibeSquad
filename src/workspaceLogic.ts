// Pure helpers for the New Agent branch hint and the agent-to-workspace lookup (no daemon imports, node --test friendly).

/** Cheap local git-ref shape check (git check-ref-format subset). Returns an error or null. */
export function branchShapeError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Branch name is empty.";
  if (/\s/.test(n)) return "Branch names can't contain spaces.";
  if (/[~^:?*[\\]/.test(n)) return "Branch names can't contain ~ ^ : ? * [ or a backslash.";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) return "Branch name starts or ends with an illegal character.";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Branch name contains an illegal sequence.";
  if (n.split("/").some((p) => p.startsWith("."))) return "Branch path parts can't start with a dot.";
  return null;
}

export type BranchHint = { tone: "ok" | "warn" | "bad" | "muted"; text: string };

/** What to tell the user about a branch name when creating a NEW branch (the usual New Agent case). */
export function branchHint(name: string, v: { exists: boolean; isRemote: boolean; resolvedRef: string | null; error: string | null } | null): BranchHint | null {
  if (!name.trim()) return null;
  const shape = branchShapeError(name);
  if (shape) return { tone: "bad", text: shape };
  if (!v) return { tone: "muted", text: "checking…" };
  if (v.error) return { tone: "warn", text: v.error };
  if (v.exists) return { tone: "warn", text: `already exists${v.isRemote ? " on the remote" : ""} (${v.resolvedRef ?? name}); the worktree may fail or reuse it` };
  return { tone: "ok", text: "new branch name is free" };
}

export const normDir = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The agent's Paseo workspace: its own workspaceId, else the workspace whose folder holds the agent's cwd
 * (deepest folder wins, so a worktree's workspace beats the repo root's).
 */
export function workspaceIdForAgent(
  agent: { cwd?: string | null; workspaceId?: string | null },
  workspaces: Iterable<[string, { workspaceDirectory?: string | null; directory?: string | null }]>,
): string | null {
  if (agent.workspaceId) return agent.workspaceId;
  const cwd = normDir(agent.cwd ?? "");
  if (!cwd) return null;
  let best: { id: string; len: number } | null = null;
  for (const [id, ws] of workspaces) {
    const dir = normDir(ws.workspaceDirectory ?? ws.directory ?? "");
    if (!dir || (cwd !== dir && !cwd.startsWith(dir + "/"))) continue;
    if (!best || dir.length > best.len) best = { id, len: dir.length };
  }
  return best?.id ?? null;
}
