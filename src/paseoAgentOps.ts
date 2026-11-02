// Agent ops parity with Paseo: hard delete, bulk stop, reload. Wrappers over daemonClient plus
// the pure logic (targets, guards) the UI and tests share. Labels, never titles, decide roles.
import { DEMO, daemonClient, loadArchived, removeLocalAgent } from "./paseo";
import type { OpAgent } from "./paseoAgentOpsLogic.ts";

export { bulkStopTargets, deleteGuard, runningCwds } from "./paseoAgentOpsLogic.ts";
export type { OpAgent, StopCandidate, StopScope } from "./paseoAgentOpsLogic.ts";

export async function hardDeleteAgent(id: string): Promise<void> {
  if (DEMO) return void removeLocalAgent(id);
  await daemonClient.deleteAgent(id);
  removeLocalAgent(id); // moves it to the local archived map; the reload below drops it for good
  void loadArchived();
}

/** Cancels each agent's current run. Returns the ids that failed. */
export async function stopAgents(ids: string[]): Promise<string[]> {
  if (DEMO) return [];
  const res = await Promise.allSettled(ids.map((id) => daemonClient.cancelAgent(id)));
  return ids.filter((_, i) => res[i].status === "rejected");
}

/** `paseo agent reload` is the daemon's refresh_agent_request, exposed as client.refreshAgent. */
export async function reloadAgent(id: string): Promise<void> {
  if (DEMO) return;
  await daemonClient.refreshAgent(id);
}

// ---- pending confirm (rendered by the host in CommandPalette.tsx) ----------------------------

export type OpRequest =
  | { kind: "delete"; agent: OpAgent }
  | { kind: "stop"; title: string; agents: OpAgent[] };

let pending: OpRequest | null = null;
const subs = new Set<() => void>();
export const getOpRequest = () => pending;
export const subscribeOpRequest = (l: () => void) => (subs.add(l), () => void subs.delete(l));
export function requestAgentOp(r: OpRequest | null) {
  pending = r;
  subs.forEach((l) => l());
}
