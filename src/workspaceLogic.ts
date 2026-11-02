// Pure helpers for the Workspaces view and the New Agent branch hint (no daemon imports, node --test friendly).

export type CreateMode = "local" | "branch-off" | "checkout";

export type CreateSource =
  | { kind: "directory"; path: string }
  | { kind: "worktree"; cwd: string; action: "branch-off" | "checkout"; refName?: string; baseBranch?: string; branchName?: string };

/** Empty/whitespace title means "reset to the derived name" (null on the wire). */
export const normalizeTitle = (raw: string): string | null => raw.trim() || null;

/** Pinned first (most recently pinned on top), the rest keep their order. */
export function pinnedFirst<T>(rows: T[], pinnedAt: (r: T) => string | null | undefined): T[] {
  const key = (r: T) => {
    const t = Date.parse(pinnedAt(r) ?? "");
    return Number.isFinite(t) ? t : null;
  };
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => (a.k !== null && b.k !== null ? b.k - a.k : a.k !== null ? -1 : b.k !== null ? 1 : a.i - b.i))
    .map((x) => x.r);
}

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

/** Maps the create dialog fields to a daemon source, or an error string. */
export function buildCreateSource(
  mode: CreateMode,
  f: { path: string; cwd: string; branch: string; base: string },
): { source: CreateSource } | { error: string } {
  if (mode === "local") {
    if (!f.path.trim()) return { error: "Folder path is required." };
    return { source: { kind: "directory", path: f.path.trim() } };
  }
  if (!f.cwd.trim()) return { error: "Pick a project (repo root) first." };
  const b = f.branch.trim();
  const shape = branchShapeError(b);
  if (shape) return { error: shape };
  if (mode === "checkout") return { source: { kind: "worktree", cwd: f.cwd.trim(), action: "checkout", refName: b } };
  return {
    source: { kind: "worktree", cwd: f.cwd.trim(), action: "branch-off", branchName: b, ...(f.base.trim() ? { baseBranch: f.base.trim(), refName: f.base.trim() } : {}) },
  };
}

/** Text for the project-delete confirm. Honest about the unknown: the API doc says nothing about disk. */
export function projectDeleteWarning(name: string, workspaceCount: number): string {
  const ws = workspaceCount === 1 ? "1 workspace" : `${workspaceCount} workspaces`;
  return `Remove project "${name}" from Paseo? This drops the project and its ${ws} from Paseo's list. VibeSquad does not delete any folders itself; whether Paseo cleans up worktree folders on disk isn't specified by its API, so archive workspaces first if you want them removed.`;
}

export const setupLabel = (status: string | null | undefined): string =>
  status === "running" ? "setup running" : status === "completed" ? "setup done" : status === "failed" ? "setup failed" : status === "blocked" ? "setup blocked" : "no setup run";

/**
 * Local overlay for workspaces the daemon's first page / push doesn't reflect yet.
 * `created` = a workspace missing from the store (just created); `patch` = pending edits (rename/pin).
 */
export type OverlayEntry<W> = { created?: W; patch: Partial<W> };

/** Store first, then pending patches for ids still in the overlay; created entries only fill gaps. */
export function mergeOverlay<W extends { id: string }>(stored: Map<string, W>, overlay: Map<string, OverlayEntry<W>>): Map<string, W> {
  if (overlay.size === 0) return stored;
  const out = new Map(stored);
  for (const [id, e] of overlay) {
    const base = stored.get(id) ?? e.created;
    if (base) out.set(id, { ...base, ...e.patch });
  }
  return out;
}

/** Drop entries the store has caught up with (every patched field equal). `name` is derived, so it isn't compared. */
export function pruneOverlay<W extends { id: string }>(stored: Map<string, W>, overlay: Map<string, OverlayEntry<W>>): Map<string, OverlayEntry<W>> {
  let next: Map<string, OverlayEntry<W>> | null = null;
  for (const [id, e] of overlay) {
    const s = stored.get(id);
    if (!s) continue;
    const caughtUp = (Object.keys(e.patch) as (keyof W)[]).every((k) => k === "name" || (s[k] ?? null) === (e.patch[k] ?? null));
    if (caughtUp) (next ??= new Map(overlay)).delete(id);
  }
  return next ?? overlay;
}

export function dropFromOverlay<W>(overlay: Map<string, OverlayEntry<W>>, ids: string[]): Map<string, OverlayEntry<W>> {
  if (!ids.some((i) => overlay.has(i))) return overlay;
  const next = new Map(overlay);
  for (const i of ids) next.delete(i);
  return next;
}

export const normDir = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

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
