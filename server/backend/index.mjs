// The single accessor for agent operations. Block 3 adds RunnerBackend and a per-lane switch here.
import { PaseoBackend } from "./paseo-backend.mjs";

/** Wraps a DaemonClient (or test fake) as an AgentBackend. Idempotent; null/undefined pass through. */
export function getBackend(client) {
  if (!client || client instanceof PaseoBackend) return client;
  return new PaseoBackend(client);
}

/** Backend with no daemon client, for the CLI shell-outs only. */
export function getCliBackend() {
  return new PaseoBackend(null);
}

export { PaseoBackend, BACKEND_METHODS } from "./paseo-backend.mjs";
export { hasCustomMockCli, hasCustomOfflineStore, run } from "./paseo-cli.mjs";
