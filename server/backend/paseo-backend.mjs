// PaseoBackend: the Paseo implementation of the AgentBackend seam (docs/PLAN_OWN_DAEMON.md Block 1).
// Every method delegates to the wrapped DaemonClient with the same arguments, return value and errors.
// Methods are getters that resolve at access time and are `undefined` when the client lacks them, so the
// callers' `typeof backend.x === "function"` guards and `backend.x?.()` calls behave exactly as they did
// against the raw client (including the fake clients in tests).
import { runPaseoCli } from "./paseo-cli.mjs";

/** Every DaemonClient method the server and CLI call. */
export const BACKEND_METHODS = [
  "connect",
  "close",
  "createAgent",
  "fetchAgent",
  "fetchAgents",
  "listAgents",
  "getAgent",
  "sendAgentPrompt",
  "fetchAgentTimeline",
  "getAgentTimeline",
  "cancelAgent",
  "archiveAgent",
  "updateAgent",
  "refreshAgent",
  "detachAgent",
  "deleteHeartbeat",
  "subscribe",
  "subscribeConnectionStatus",
  "waitForFinish",
];

export class PaseoBackend {
  constructor(client) {
    Object.defineProperty(this, "client", { value: client });
  }

  /** `paseo <args>` stdout or null (cli/vs.mjs runPaseo). */
  runCli(paseoHome, args, timeoutMs) {
    return runPaseoCli(paseoHome, args, timeoutMs);
  }
}

for (const name of BACKEND_METHODS) {
  Object.defineProperty(PaseoBackend.prototype, name, {
    configurable: true,
    get() {
      const client = this.client;
      return typeof client?.[name] === "function" ? (...args) => client[name](...args) : undefined;
    },
  });
}
