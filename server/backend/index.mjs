// The single accessor for agent operations. Paseo is the default for every lane; lanes switched to the
// runner (VS_RUNNER_LANES or teams.json `backend: "runner"`) get a RoutingBackend that sends each call to the owner.
import { PaseoBackend } from "./paseo-backend.mjs";
import { RoutingBackend, runnerLanes } from "./lane-routing.mjs";
import { RunnerBackend } from "./runner-backend.mjs";

let sharedRunner;
const runnerBackend = () => (sharedRunner ??= new RunnerBackend());
export const sharedRunnerBackend = runnerBackend;

/** Wraps a DaemonClient (or test fake) as an AgentBackend. Idempotent; null/undefined pass through. */
export function getBackend(client, opts = {}) {
  if (!client || client instanceof PaseoBackend || client instanceof RoutingBackend) return client;
  const paseo = new PaseoBackend(client);
  const lanes = opts.lanes ?? runnerLanes;
  if (!(opts.force || lanes().size)) return paseo; // nothing switched: byte-identical to the pre-Block-3 path
  return new RoutingBackend(paseo, opts.runner ?? runnerBackend(), { lanes });
}

/** Backend with no daemon client, for the CLI shell-outs only. */
export function getCliBackend() {
  return new PaseoBackend(null);
}

export { PaseoBackend, BACKEND_METHODS } from "./paseo-backend.mjs";
export { RunnerBackend, isRunnerId, readRunnerAgentSync, listRunnerAgentsSync } from "./runner-backend.mjs";
export { RoutingBackend, runnerLanes } from "./lane-routing.mjs";
export { hasCustomMockCli, hasCustomOfflineStore, run } from "./paseo-cli.mjs";
