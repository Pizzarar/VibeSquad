// Remote boot (PLAN_PASEO_PARITY.md block R2-2). main.tsx imports this FIRST: several app modules fetch
// /api/teams, /__vibesquad/profiles and /__vibesquad/settings while they load, before main.tsx's body
// runs, so the vs.http fetch shim must already be in place. Calls wait until main.tsx binds the relay
// client and it is connected. Local boot and the pairing screen: nothing is installed.

import { installRemoteTransport, type VsHttpInvoke } from "./remoteTransport.ts";
import { isRemote, needsPairing } from "./remoteSession.ts";

type RemoteRpcClient = {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getConnectionState(): { status: string };
  subscribeConnectionStatus(listener: (s: { status: string }) => void): () => void;
};

const CONNECT_WAIT_MS = 30_000;

let bind: (c: RemoteRpcClient) => void = () => {};
const bound = new Promise<RemoteRpcClient>((resolve) => (bind = resolve));

/** Resolves once `client` is connected; rejects after `ms` (the shim's caller sees a failed fetch). */
export function whenConnected(client: RemoteRpcClient, ms = CONNECT_WAIT_MS): Promise<void> {
  if (client.getConnectionState().status === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (off(), reject(new Error("remote: timed out waiting for the relay connection"))), ms);
    const off = client.subscribeConnectionStatus((s) => {
      if (s.status !== "connected") return;
      clearTimeout(t);
      off();
      resolve();
    });
  });
}

export function remoteInvoke(clientP: Promise<RemoteRpcClient>, ms = CONNECT_WAIT_MS): VsHttpInvoke {
  return async (input) => {
    const client = await clientP;
    await whenConnected(client, ms);
    return client.invokePluginRpc("vibesquad", "vs.http", input);
  };
}

/** Hands the relay DaemonClient to the shim installed below. No-op on local boot. */
export function bindRemoteClient(client: RemoteRpcClient): void {
  bind(client);
}

export const remoteShimInstalled = isRemote() && !needsPairing(true, location.hash);
if (remoteShimInstalled) installRemoteTransport(remoteInvoke(bound));
