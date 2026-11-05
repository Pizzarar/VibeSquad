// Remote boot (PLAN_PASEO_PARITY.md block R2-2): builds the DaemonClient over Paseo's relay, end-to-end
// encrypted to the daemon key from the pairing offer, instead of the same-origin /ws socket. paseo.ts
// takes remoteDaemonClient() when it isn't null; RemotePair.tsx uses probeRemote() before saving a pairing.

import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { isRemote, mapRemoteError, needsPairing, noteAuthFailure, readPassword, readSession, relayParts, remoteError, type RemoteError, type RemoteOffer } from "./remoteSession";

function relayConfig(offer: RemoteOffer, password: string, clientId = "vibesquad-remote") {
  const { endpoint, useTls, serverId } = relayParts(offer);
  return {
    url: buildRelayWebSocketUrl({ endpoint, useTls, serverId, role: "client", version: 2 }),
    clientId,
    clientType: "browser" as const,
    appVersion: "0.0.1",
    ...(password ? { password } : {}),
    e2ee: {
      enabled: true,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      ...(offer.minimumSecurityMode ? { minimumMode: offer.minimumSecurityMode } : {}),
    },
  };
}

/**
 * The relay client for a paired remote page, or null (local boot, or remote but not paired yet).
 * On an auth failure it drops the stale password and reloads, so main.tsx shows the pairing screen.
 */
export function remoteDaemonClient(): DaemonClient | null {
  if (needsRemotePairing()) return null;
  const session = isRemote() ? readSession() : null;
  if (!session) return null;
  const client = new DaemonClient({
    ...relayConfig(session.offer, readPassword()),
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15000 },
  });
  client.subscribeConnectionStatus((s) => {
    if (s.status !== "disconnected") return;
    const err = mapRemoteError(s.reason ?? "");
    if (err.kind !== "password-required" && err.kind !== "wrong-password") return;
    noteAuthFailure(err.kind);
    void client.close().finally(() => location.reload());
  });
  return client;
}

/** True when this page is remote but not ready (see needsPairing): main.tsx boots RemotePair. */
export function needsRemotePairing(): boolean {
  return needsPairing(isRemote(), location.hash);
}

const PROBE_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * One-shot check before a pairing is saved: connect over the relay (handshake + password), then one
 * read through vs.http so a refused gate (remote.enabled off) shows here, not as a blank app.
 */
export async function probeRemote(offer: RemoteOffer, password: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<RemoteError | null> {
  let client: DaemonClient;
  try {
    client = new DaemonClient({ ...relayConfig(offer, password, "vibesquad-remote-probe"), reconnect: { enabled: false }, connectTimeoutMs: Math.min(timeoutMs, 15_000) });
  } catch (e) {
    return remoteError("bad-link", `The pairing link can't be used: ${(e as Error)?.message ?? e}`);
  }
  try {
    await withTimeout(client.connect(), timeoutMs);
    const out = (await withTimeout(client.invokePluginRpc("vibesquad", "vs.http", { method: "GET", path: "/api/teams" }), timeoutMs)) as {
      status?: number;
    };
    if (!out || typeof out.status !== "number") return remoteError("unknown", "Connected, but the VibeSquad plugin gave an unexpected reply.");
    if (out.status >= 500) return remoteError("unknown", `Connected, but the VibeSquad server on your PC answered ${out.status}. Is VibeSquad running?`);
    return null;
  } catch (e) {
    return mapRemoteError(e);
  } finally {
    void client.close().catch(() => {});
  }
}
