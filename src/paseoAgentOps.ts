// Agent ops parity with Paseo: hard delete, bulk stop, reload. Runner-backed wrappers plus
// the pure logic (targets, guards) the UI and tests share. Labels, never titles, decide roles.
import { archiveAgent, getPaseoState, loadArchived, removeLocalAgent, stopAgent } from "./paseo";
import { runnerReloadTimeline } from "./runnerBridge";
import { DEMO } from "./demoFlag";
import { closeTab } from "./panes";
import type { OpAgent } from "./paseoAgentOpsLogic.ts";

export { bulkStopTargets, deleteGuard, runningCwds } from "./paseoAgentOpsLogic.ts";
export type { OpAgent, StopCandidate, StopScope } from "./paseoAgentOpsLogic.ts";

export async function hardDeleteAgent(id: string): Promise<void> {
  if (!DEMO) await archiveAgent(id); // the runner has no hard-delete route: archive is as far as it goes
  removeLocalAgent(id); // archives locally; evict that entry right away (same tick, before React re-reads state)
  getPaseoState().archivedAgents.delete(id);
  closeTab(id);
  if (!DEMO) void loadArchived();
}

/** Cancels each agent's current run. Returns the ids that failed. */
export async function stopAgents(ids: string[]): Promise<string[]> {
  if (DEMO) return [];
  const res = await Promise.allSettled(ids.map((id) => stopAgent(id)));
  return ids.filter((_, i) => res[i].status === "rejected");
}

/** Reload = every mounted timeline for the agent refetches (the runner has no session-refresh route). */
export async function reloadAgent(id: string): Promise<void> {
  if (DEMO) return;
  runnerReloadTimeline(id);
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
