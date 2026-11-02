// Block C wrappers: workspace/project CRUD + branch validation. Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";
import type { PaseoWorkspace } from "@getpaseo/client";
import type { CreateSource } from "./workspaceLogic";

export const setWorkspaceTitle = (id: string, title: string | null) => daemonClient.setWorkspaceTitle(id, title);
export const setWorkspacePinned = (id: string, pinned: boolean) => daemonClient.setWorkspacePinned(id, pinned);

/**
 * Creates a standalone workspace. A newer daemon (0.14) only streams an "accepted" creation update with the
 * workspace id to this older client (no final response), so resolve on the first update that carries an id
 * and the caller refreshes the list. Note: the SDK operation itself stays pending on such a daemon and the client
 * may re-observe it after a socket reconnect (harmless: we've already settled).
 */
export async function createStandaloneWorkspace(source: CreateSource, title?: string, timeoutMs = 30000): Promise<{ workspace: PaseoWorkspace | null; workspaceId: string | null }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Create timed out. The workspace may still have appeared: check the list."))), timeoutMs);
    daemonClient
      .createWorkspace({
        source,
        ...(title ? { title } : {}),
        onEvent: (snap) => {
          const e = (snap as { error?: string | null }).error;
          const id = (snap as { workspaceId?: string | null }).workspaceId;
          const w = (snap as { workspace?: PaseoWorkspace | null }).workspace;
          if (e) finish(() => reject(new Error(e)));
          else if (w) finish(() => resolve({ workspace: w, workspaceId: w.id }));
          else if (id) finish(() => resolve({ workspace: null, workspaceId: id }));
        },
      })
      .then((res) => finish(() => (res.error ? reject(new Error(res.error)) : resolve({ workspace: res.workspace, workspaceId: res.workspace?.id ?? null }))))
      .catch((e) => finish(() => reject(e)));
  });
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

/** The daemon silently drops branch requests for folders it doesn't know as a project, so don't wait forever. */
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

export const validateBranch = (cwd: string, branchName: string) => withTimeout(daemonClient.validateBranch({ cwd, branchName }), 6000, "validateBranch");
export async function branchSuggestions(cwd: string, query: string) {
  const res = await withTimeout(daemonClient.getBranchSuggestions({ cwd, query, limit: 8 }), 6000, "getBranchSuggestions");
  return res.error ? [] : res.branches;
}
