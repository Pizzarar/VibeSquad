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

const SYSTEM_DIRS = ["windows", "program files", "program files (x86)", "programdata", "system volume information", "etc", "var", "proc", "sys", "dev", "bin", "sbin", "usr", "boot", "lib", "root"];

/** Why `raw` must not be registered as a workspace (it would match every agent below it), or null when it's fine. */
export function unsafeWorkspaceCwdReason(raw: string): string | null {
  const p = raw.trim();
  if (!p) return "No folder to add as a workspace.";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return "Folder path contains invalid characters.";
  if (/^(\\\\|\/\/)/.test(p)) return "Network (UNC) paths can't be added as a workspace.";
  const norm = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!/^(?:[a-zA-Z]:(?:\/|$)|\/)/.test(norm) && norm !== "") return "Folder path must be an absolute local path.";
  const segs = norm.split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) return "Folder path can't contain '.' or '..' segments.";
  const lower = segs.map((s) => s.toLowerCase());
  const drive = /^[a-z]:$/.test(lower[0] ?? "");
  const rest = drive ? lower.slice(1) : lower;
  if (rest.length < 1) return "A drive or filesystem root can't be added as a workspace.";
  if (SYSTEM_DIRS.includes(rest[0])) return "System folders can't be added as a workspace.";
  if ((rest[0] === "users" || rest[0] === "home") && rest.length <= 2) return "Your home folder is too broad to register as a workspace; add a project subfolder instead.";
  return null;
}
