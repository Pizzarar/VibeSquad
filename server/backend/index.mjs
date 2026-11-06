// The single accessor for agent operations. Every lane defaults to the runner (cutover); a RoutingBackend sends each call to
// the owner (rn- ids = runner, other ids = Paseo). Lanes pinned with teams.json `backend: "paseo"` / VS_PASEO_LANES create on Paseo.
import { PaseoBackend } from "./paseo-backend.mjs";
import { RoutingBackend, paseoDaemonAlive, paseoExpected, runnerLanes } from "./lane-routing.mjs";
import { RunnerBackend } from "./runner-backend.mjs";

let sharedRunner;
const runnerBackend = () => (sharedRunner ??= new RunnerBackend());
export const sharedRunnerBackend = runnerBackend;

/** Wraps a DaemonClient (or test fake) as an AgentBackend. Idempotent; null/undefined pass through. */
export function getBackend(client, opts = {}) {
  if (!client || client instanceof PaseoBackend || client instanceof RoutingBackend) return client;
  const paseo = new PaseoBackend(client);
  const lanes = opts.lanes ?? runnerLanes;
  if (!(opts.force || lanes().size)) return paseo;
  return new RoutingBackend(paseo, opts.runner ?? runnerBackend(), { lanes, paseoAlive: opts.paseoAlive === undefined ? paseoDaemonAlive : opts.paseoAlive });
}

/** Backend with no daemon client, for the CLI shell-outs only. */
export function getCliBackend() {
  return new PaseoBackend(null);
}

export { PaseoBackend, BACKEND_METHODS } from "./paseo-backend.mjs";
export { RunnerBackend, isRunnerId, readRunnerAgentSync, listRunnerAgentsSync } from "./runner-backend.mjs";
export { RoutingBackend, RunnerLaneSet, runnerLanes, paseoDaemonAlive, paseoExpected } from "./lane-routing.mjs";
export { hasCustomMockCli, hasCustomOfflineStore, run } from "./paseo-cli.mjs";
