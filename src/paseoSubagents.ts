import { daemonClient, DEMO } from "./paseo";
import type { ApiSubagent } from "./paseoSubagentsLogic";

const TIMEOUT_MS = 8000;

// Returns null when the provider cannot list subagents (unsupported / daemon error / timeout)
// so callers hide the list quietly; [] means "supported, none yet".
export async function listSubagents(agentId: string): Promise<ApiSubagent[] | null> {
  if (DEMO) return [];
  try {
    const r: any = await daemonClient.listProviderSubagents(agentId, { timeout: TIMEOUT_MS });
    if (r?.error) return null;
    return (r?.subagents ?? []) as ApiSubagent[];
  } catch {
    return null;
  }
}
