// Paseo is optional after the runner cutover. This keeps the browser's two transports straight (the Paseo websocket and the
// VS runner event stream) without importing the DOM/React-bound store, so the state machine is unit-testable with stubs.
import type { RunnerStatus } from "./runnerBridge";

export type ConnPatch = { conn: "connecting" | "connected" | "disconnected"; status: "connecting" | "connected" | "disconnected" | "error"; error?: string; authFailureReason?: null };

export type PaseoLinkDeps = {
  /** The module-singleton DaemonClient. Only setReconnectEnabled is used: close() is terminal ("disposed"). */
  daemonClient: { setReconnectEnabled?: (enabled: boolean) => void };
  getRunnerStatus: () => RunnerStatus | null;
  fetchRunnerStatus: () => Promise<RunnerStatus | null>;
  isRemote: () => boolean;
  getConn: () => string;
  setConn: (patch: ConnPatch) => void;
  /** Evict Paseo-hosted agents (everything but rn-) from the store. */
  dropPaseoAgents: () => void;
  /** Run the store's connect() again (a parked Paseo became reachable). */
  reconnect: () => void;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

export const PASEO_UNAVAILABLE_MESSAGE = "Paseo is not running. Start it in Settings (Start Paseo with VibeSquad) or move this lane to the runner.";

export function createPaseoLink(deps: PaseoLinkDeps) {
  const retryMs = deps.retryMs ?? 20_000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let runnerConn = false;
  let paseoConn = false;
  let parked = false;
  let retryPending = false;

  /** The runner side is "on" once its status says so, even before its stream opens (a cold runner start takes seconds). */
  const runnerOn = (): boolean => runnerConn || !!deps.getRunnerStatus()?.enabled;

  // Pause, never dispose: DaemonClient.close() is terminal, so a later Paseo start could never reconnect. Reconnect is
  // switched off (which also cancels the client's pending retry timer) and back on when the status poll sees Paseo again.
  function park(): void {
    if (deps.isRemote()) return;
    parked = true;
    paseoConn = false;
    deps.daemonClient.setReconnectEnabled?.(false);
    deps.dropPaseoAgents();
    if (retryPending) return;
    retryPending = true;
    const tick = () => {
      void deps.fetchRunnerStatus().then((s) => {
        if (s?.paseo?.reachable) {
          retryPending = false;
          parked = false;
          deps.daemonClient.setReconnectEnabled?.(true);
          deps.reconnect();
        } else setTimer(tick, retryMs);
      });
    };
    setTimer(tick, retryMs);
  }

  /**
   * Before connecting to Paseo: false (and parked) when the runner is the default and no daemon is reachable right now, so
   * there is no doomed /ws attempt even with startPaseoWithVibeSquad on. A parked link re-reads the status first.
   */
  async function shouldConnectPaseo(): Promise<boolean> {
    if (deps.isRemote()) return true;
    const rs = parked ? await deps.fetchRunnerStatus() : deps.getRunnerStatus();
    if (rs?.enabled && rs.defaultBackend === "runner" && !rs.paseo?.reachable) {
      park();
      return false;
    }
    parked = false;
    deps.daemonClient.setReconnectEnabled?.(true);
    return true;
  }

  /** The runner event stream opened (true) or failed (false). */
  function onRunnerConnection(up: boolean): void {
    runnerConn = up;
    if (up && deps.getConn() !== "connected") deps.setConn({ conn: "connected", status: "connected", error: undefined, authFailureReason: null });
    else if (!up && !paseoConn && deps.getConn() !== "disconnected") deps.setConn({ conn: "disconnected", status: "disconnected" });
  }

  /** Throws PASEO_UNAVAILABLE for a spawn that must go to Paseo while Paseo is not connected (instead of hanging on /ws). */
  function assertCanSpawnOnPaseo(): void {
    if (deps.getRunnerStatus()?.enabled && !paseoConn) throw Object.assign(new Error(PASEO_UNAVAILABLE_MESSAGE), { code: "PASEO_UNAVAILABLE" });
  }

  return {
    park,
    shouldConnectPaseo,
    onRunnerConnection,
    assertCanSpawnOnPaseo,
    runnerOn,
    setPaseoConn(v: boolean) {
      paseoConn = v;
    },
    get paseoConn() {
      return paseoConn;
    },
    get runnerConn() {
      return runnerConn;
    },
    get parked() {
      return parked;
    },
  };
}
