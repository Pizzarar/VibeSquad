// The single accessor for agent operations. The runner is the only backend; `getBackend` passes an injected client (tests'
// fakes) straight through and `sharedRunnerBackend()` is the production one.
import { RunnerBackend } from "./runner-backend.mjs";

let sharedRunner;
export const sharedRunnerBackend = () => (sharedRunner ??= new RunnerBackend());

/** The agent backend for `client`: null/undefined stay as they are (a caller that skipped the backend), anything else is used as given. */
export function getBackend(client) {
  return client;
}

export { RunnerBackend, isRunnerId, readRunnerAgentSync, listRunnerAgentsSync, listRunnerAgents } from "./runner-backend.mjs";
