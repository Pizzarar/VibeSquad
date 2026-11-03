// Remote boot (PLAN_PASEO_PARITY.md block R2-2). main.tsx imports this FIRST: several app modules fetch
// /api/teams, /__vibesquad/profiles and /__vibesquad/settings while they load, before main.tsx's body
// runs, so the vs.http fetch shim must already be in place. Calls wait until main.tsx binds the relay
// client and it is connected. Local boot and the pairing screen: nothing is installed.

import { installRemoteTransport, type VsHttpInvoke } from "./remoteTransport.ts";
import { clearSession, isLocalHost, isRemote, needsPairing, offerFromHash, readSession, stripRemoteFromUrl } from "./remoteSession.ts";

type RemoteConnState = { status: string; reason?: string; nextRetryAt?: string };

type RemoteRpcClient = {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getConnectionState(): RemoteConnState;
  subscribeConnectionStatus(listener: (s: RemoteConnState) => void): () => void;
};

const CONNECT_WAIT_MS = 30_000;

let bind: (c: RemoteRpcClient) => void = () => {};
const bound = new Promise<RemoteRpcClient>((resolve) => (bind = resolve));

function terminalDisconnectError(s: RemoteConnState): Error | null {
  if (s.status === "disposed" || (s.status === "disconnected" && !s.nextRetryAt)) {
    return new Error(`Relay disconnected: ${s.reason || s.status}`);
  }
  return null;
}

/** Resolves once `client` is connected; rejects on terminal disconnect/dispose or after `ms`. */
export function whenConnected(client: RemoteRpcClient, ms = CONNECT_WAIT_MS): Promise<void> {
  const init = client.getConnectionState();
  if (init.status === "connected") return Promise.resolve();
  const initErr = terminalDisconnectError(init);
  if (initErr) return Promise.reject(initErr);
  return new Promise((resolve, reject) => {
    let done = false;
    let off = () => {};
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      off();
      fn();
    };
    const t = setTimeout(() => finish(() => reject(new Error("remote: timed out waiting for the relay connection"))), ms);
    off = client.subscribeConnectionStatus((s) => {
      if (s.status === "connected") return finish(resolve);
      const err = terminalDisconnectError(s);
      if (err) finish(() => reject(err));
    });
    if (done) off();
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

// Fallback when the build had no baked-in serverId: ask the local server who it is. If the "remote" target is
// this very PC, forget the pairing and reload as a plain local window. Uses native fetch, captured before the shim.
if (typeof window !== "undefined" && isRemote() && isLocalHost(location.hostname)) {
  const nativeFetch = window.fetch.bind(window);
  const target = offerFromHash(location.hash) ?? readSession()?.offer ?? null;
  if (target) {
    void nativeFetch("/__vibesquad/paseo/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.serverId === "string" && j.serverId === target.serverId) {
          clearSession();
          history.replaceState(null, "", stripRemoteFromUrl(location));
          location.reload();
        }
      })
      .catch(() => {});
  }
}

if (remoteShimInstalled) installRemoteTransport(remoteInvoke(bound));
