// Pure helpers for ensureWorkspace (no daemon imports, node --test friendly).
import { normDir, workspaceIdForAgent } from "./workspaceLogic.ts";

type WsLike = { workspaceDirectory?: string | null; directory?: string | null };

/** Dedupe key for a folder: same normalisation as workspaceIdForAgent (slashes, trailing slash, case). */
export const workspaceKey = (cwd: string): string => normDir(cwd.trim());

/** Existing workspace id covering `cwd` (deepest folder wins), or null. */
export const findWorkspaceForCwd = (cwd: string, workspaces: Iterable<[string, WsLike]>): string | null =>
  workspaceIdForAgent({ cwd }, workspaces);

/** Concurrent calls with the same key share one promise; the entry is dropped once it settles. */
export function createInflight<T>() {
  const map = new Map<string, Promise<T>>();
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const hit = map.get(key);
      if (hit) return hit;
      const p = fn().finally(() => map.delete(key));
      map.set(key, p);
      return p;
    },
    size: () => map.size,
  };
}
