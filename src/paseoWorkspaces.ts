// Block C wrappers: workspace/project CRUD + branch validation. Kept out of paseo.ts on purpose.
import { daemonClient, getPaseoState } from "./paseo";
import { createInflight, findWorkspaceForCwd, workspaceKey } from "./ensureWorkspaceLogic";
import type { PaseoWorkspace } from "@getpaseo/client";
import type { CreateSource } from "./workspaceLogic";

/** Safety net: the daemon silently drops branch requests for folders it doesn't know as a project, so don't wait forever. */
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

export const setWorkspaceTitle = (id: string, title: string | null) => daemonClient.setWorkspaceTitle(id, title);
export const setWorkspacePinned = (id: string, pinned: boolean) => daemonClient.setWorkspacePinned(id, pinned);

/**
 * Creates a standalone workspace. Paseo 0.14 sends the final response (0.13 clients only saw the "accepted" update).
 * Our timeout only stops waiting: createWorkspace takes no AbortSignal in 0.14, so the SDK's own waiter outlives it.
 */
export async function createStandaloneWorkspace(source: CreateSource, title?: string, timeoutMs = 30000): Promise<{ workspace: PaseoWorkspace | null; workspaceId: string | null }> {
  const res = await withTimeout(daemonClient.createWorkspace({ source, ...(title ? { title } : {}) }), timeoutMs, "Create").catch((e: Error) => {
    throw e.message === "Create timed out" ? new Error("Create timed out. The workspace may still have appeared: check the list.") : e;
  });
  if (res.error) throw new Error(res.error);
  return { workspace: res.workspace, workspaceId: res.workspace?.id ?? null };
}

export const inspectWorkspaceRecovery = (id: string) => daemonClient.inspectWorkspaceRecovery(id);
export const restoreWorkspace = (id: string) => daemonClient.restoreWorkspace(id);

export async function runWorkspaceSetup(id: string) {
  const res = await daemonClient.runWorkspaceSetup(id);
  if (res.error) throw new Error(res.error);
  return res;
}
export const fetchWorkspaceSetupStatus = (id: string) => daemonClient.fetchWorkspaceSetupStatus(id);

export async function listProjects() {
  return (await daemonClient.listProjects()).projects;
}
export async function openProject(cwd: string) {
  const res = await daemonClient.openProject(cwd);
  if (res.error) throw new Error(res.error);
  return res.workspace;
}
export const renameProject = (id: string, name: string | null) => daemonClient.renameProject(id, name);
export const removeProject = (id: string) => daemonClient.removeProject(id);

export const validateBranch = (cwd: string, branchName: string) => withTimeout(daemonClient.validateBranch({ cwd, branchName }), 6000, "validateBranch");
export async function branchSuggestions(cwd: string, query: string) {
  const res = await withTimeout(daemonClient.getBranchSuggestions({ cwd, query, limit: 8 }), 6000, "getBranchSuggestions");
  return res.error ? [] : res.branches;
}

const ENSURE_TIMEOUT_MS = 15000;
const ensureInflight = createInflight<{ workspaceId: string; created: boolean }>();

/**
 * Makes sure the daemon has a workspace covering `cwd` (Changes, terminals and scripts hang without one).
 * Resolves against the live workspace list first; otherwise registers the folder as a local workspace.
 * Concurrent calls for the same folder share one request; a later call finds the new workspace and returns created: false.
 */
export function ensureWorkspace(cwd: string): Promise<{ workspaceId: string; created: boolean }> {
  const dir = cwd.trim();
  if (!dir) return Promise.reject(new Error("No folder to add as a workspace."));
  return ensureInflight.run(workspaceKey(dir), async () => {
    const known = findWorkspaceForCwd(dir, getPaseoState().workspaces);
    if (known) return { workspaceId: known, created: false };
    const { workspaceId } = await createStandaloneWorkspace({ kind: "directory", path: dir }, undefined, ENSURE_TIMEOUT_MS).catch((e: Error) => {
      throw new Error(/timed out/i.test(e.message) ? `Paseo didn't register ${dir} within 15s. Check that the daemon is running and the folder exists, then retry.` : `Couldn't add ${dir} as a workspace: ${e.message}`);
    });
    if (!workspaceId) throw new Error(`Paseo didn't return a workspace for ${dir}.`);
    return { workspaceId, created: true };
  });
}
