// Block C wrappers: workspace/project CRUD + branch validation. Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";
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

/** Creates a standalone workspace. Paseo 0.14 sends the final response (0.13 clients only saw the "accepted" update). */
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
