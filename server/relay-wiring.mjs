// E5 wiring (docs/lanes/android-app/E5_THREAT_MODEL.md §7 and §11): plugs server/relay-tunnel.mjs into the live server.
// Everything a relayed device can do goes through the SAME request listener as a LAN request, in-process, as a
// `req.relayDevice` principal (auth.mjs: never loopback, never the local owner, cookies/tokens ignored). The tunnel
// itself never reads devices.json: every credential decision below is an auth.mjs call.
// Off by default: serve.mjs starts this only when ~/.vibesquad/settings.json has relay.endpoint = "wss://…".
import {
  burnAllPairCodes,
  deviceActive,
  deviceForToken,
  onDeviceDropped,
  onPairCodeMinted,
  PAIR_AUDIT_LANE,
  PAIR_AUDIT_TEAM,
  redeemPairCode,
  trackSocket,
} from "./auth.mjs";
import {
  createInProcessDispatcher,
  createInProcessStreamBridge,
  createRelayHost,
  defaultKeypairPath,
  hostFingerprint,
  keypairFileStamp,
  loadOrCreateHostKeypair,
  selfCertifyingHostId,
} from "./relay-tunnel.mjs";
import { publicRelayEndpoint } from "./relay-link.mjs";
import { loadUserSettings, normalizeRelaySettings } from "./user-settings.mjs";
import { EventEmitter } from "node:events";

const KEY_POLL_MS = 10_000;
// Logged tunnel events. `reconnect-scheduled` only on the first failed dial (one line when the relay goes away, not one per
// backoff cycle); `denied` logs the path without its query (a relayed `/pair?code=` attempt must not print a live code).
const LOGGED_EVENTS = new Set(["connected", "connect-error", "reconnect-scheduled", "revoked-on-dispatch", "denied", "evicted-unauthenticated", "backpressure-overflow", "session-error", "rekey", "ws-open-error"]);

/** Security events for the owner (T8 flood lock): a `needs-you` line in the vs log, like the E4b pair audit. Best effort. */
function defaultNeedsYou(event) {
  const text = String(event?.message ?? event?.type ?? "relay security event").slice(0, 400);
  return import("./brainstorm.mjs")
    .then(({ appendVsLogEntry }) => appendVsLogEntry({ teamId: PAIR_AUDIT_TEAM, laneId: PAIR_AUDIT_LANE, agent: "vibesquad-server", type: "needs-you", text, refs: [] }))
    .catch((e) => console.error(`[vibesquad] relay audit log failed: ${e?.message ?? e}`));
}

/**
 * createRelayWiring({ endpoint, requestListener }) -> { start, stop, status, revoke, hostId, pub, fingerprint, endpoint }
 *   requestListener(req, res): the server's full request handler (serve.mjs `handle`, guarded). Relayed HTTP runs through
 *   createInProcessDispatcher; relayed `ws-open` streams an in-process GET (SSE) through createInProcessStreamBridge.
 *   keypairFile: ~/.vibesquad/host-keypair.json (in HOME_SECRET_FILES). The file is polled (stat + content hash) every
 *   `keyPollMs`: `vs host-key rotate` replaces it atomically, and the running host then drops every session, re-dials
 *   the relay under the new self-certifying hostId and never answers for the old key again, without a server restart.
 *   log / onNeedsYou / now / timers are injectable for tests; `hostOptions` is passed through to createRelayHost.
 */
export function createRelayWiring({
  endpoint,
  requestListener,
  keypairFile = defaultKeypairPath(),
  keyPollMs = KEY_POLL_MS,
  log = console,
  onNeedsYou = defaultNeedsYou,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  hostOptions = {},
} = {}) {
  const cfg = normalizeRelaySettings({ endpoint });
  if (!cfg) throw new Error("relay endpoint must be a wss:// URL");
  const publicEndpoint = publicRelayEndpoint(cfg.endpoint); // X1 wire L1: never userinfo / query / fragment in status or logs
  if (typeof requestListener !== "function") throw new Error("relay wiring needs the server request listener");

  const shims = new Map(); // cid -> socket shim registered with auth.mjs trackSocket (X1 wire M1)
  const handleHttp = createInProcessDispatcher(requestListener);
  const openWs = createInProcessStreamBridge(requestListener);
  const callbacks = {
    // Same code path as GET /pair on the LAN: one-shot code, per-minter replacement, E4b pending for device-minted codes.
    // `ip` is a label only (the relay hides client IPs; the host-wide limit in the tunnel is the brute-force guard).
    redeem: async ({ code, label }) => {
      const r = await redeemPairCode({ rawCode: code, ip: "relay", name: (label || "Relay device").slice(0, 40) });
      if (r.state === "paired") return { deviceId: r.deviceId, token: r.token };
      if (r.state === "pending") return { deviceId: r.pendingId, token: r.token, pending: true };
      return null;
    },
    authenticate: (token) => deviceForToken(token),
    isRevoked: (deviceId) => !deviceActive(deviceId), // one statSync per dispatch unless devices.json changed
    handleHttp,
    openWs,
    burnCodes: () => burnAllPairCodes(),
    // X1 wire M1: an authenticated relay session is registered with auth.mjs exactly like a LAN socket, through a
    // socket-shaped shim, so the existing 1 s devices.json watch (out-of-process `vs devices revoke`, external edits)
    // and the unreadable-file fail-close reach relay streams too, with no request in flight and no new mechanism.
    // destroy() = what auth.mjs does to a revoked device's sockets; "close" = the session ended for any reason.
    onAuthenticated: (deviceId, cid) => {
      const shim = new EventEmitter();
      shim.destroyed = false;
      shim.destroy = () => {
        if (shim.destroyed) return;
        shim.destroyed = true;
        host.revoke(deviceId);
      };
      shims.set(cid, shim);
      trackSocket(deviceId, shim);
    },
    onSessionClosed: (cid) => {
      const shim = shims.get(cid);
      if (!shim) return;
      shims.delete(cid);
      shim.destroyed = true;
      shim.emit("close");
    },
    onNeedsYou: (e) => {
      try {
        log.warn?.(`[vibesquad] relay: ${e?.message ?? e?.type}`);
      } catch {}
      try {
        void onNeedsYou(e);
      } catch {}
    },
    onEvent: (e) => {
      if (!LOGGED_EVENTS.has(e?.type)) return;
      if (e.type === "reconnect-scheduled" && e.attempt !== 1) return;
      const extra = Object.entries(e)
        .filter(([k]) => k !== "type")
        .map(([k, v]) => `${k}=${(k === "path" ? String(v).split("?")[0] : String(v)).slice(0, 120)}`)
        .join(" ");
      try {
        log.log?.(`[vibesquad] relay ${e.type}${extra ? " " + extra : ""}`);
      } catch {}
    },
  };

  let key = loadOrCreateHostKeypair(keypairFile);
  let stamp = keypairFileStamp(keypairFile);
  let host = null;
  let running = false;
  let poll = null;
  let unsubDrop = null;
  let unsubMint = null;

  const build = () => createRelayHost({ endpoint: cfg.endpoint, hostId: selfCertifyingHostId(key.publicRaw), hostKey: key, ...callbacks, ...hostOptions });
  host = build();

  function adoptKey(next) {
    const old = host;
    key = next;
    host = build();
    try {
      old.revokeAll(); // tells the relay to close every session: a client pinned to the old key must re-pair
      old.stop();
    } catch {}
    if (running) host.start();
    log.warn?.(`[vibesquad] relay: host key rotated; new host id ${api.hostId} (key ${api.fingerprint}). Every relay-paired client needs a new pairing link.`);
  }

  function checkKeyFile() {
    const now = keypairFileStamp(keypairFile);
    if (now === stamp) return false;
    stamp = now;
    let next;
    try {
      next = loadOrCreateHostKeypair(keypairFile); // a deleted file gets a fresh key: deletion is rotation too
      stamp = keypairFileStamp(keypairFile);
    } catch (e) {
      log.warn?.(`[vibesquad] relay: host keypair unreadable after a change (${e?.message ?? e}); keeping the loaded key`);
      return false;
    }
    if (next.pubB64 === key.pubB64) return false;
    adoptKey(next);
    return true;
  }

  const api = {
    /** Display form: origin + path only. The dial URL (with any userinfo/query a hosted relay may need) stays private. */
    endpoint: publicEndpoint,
    get hostId() {
      return selfCertifyingHostId(key.publicRaw);
    },
    get pub() {
      return key.pubB64;
    },
    get fingerprint() {
      return hostFingerprint(key.publicRaw);
    },
    start() {
      if (running) return api;
      running = true;
      unsubDrop = onDeviceDropped((id) => host.revoke(id)); // UI/CLI revoke, cascade, external devices.json edit, unreadable file
      unsubMint = onPairCodeMinted(() => host.noteFreshMint()); // lifts the T8 lock once the owner minted again
      host.start();
      if (keyPollMs > 0) {
        poll = setIntervalFn(checkKeyFile, keyPollMs);
        poll?.unref?.();
      }
      return api;
    },
    stop() {
      if (!running) return;
      running = false;
      if (poll) clearIntervalFn(poll);
      poll = null;
      unsubDrop?.();
      unsubMint?.();
      unsubDrop = unsubMint = null;
      host.stop();
    },
    /** For the Host pill / vs CLI: public identity and tunnel health, never key material. */
    status: () => ({ endpoint: publicEndpoint, hostId: api.hostId, pub: api.pub, fingerprint: api.fingerprint, running, ...host.status() }),
    revoke: (id) => host.revoke(id),
    /** Tests / `vs host-key rotate` without waiting for the poll: re-reads the key file now. True when the key changed. */
    checkKeyFile,
  };
  return api;
}

export { publicRelayEndpoint }; // lives in relay-link.mjs so auth.mjs (pair/start links) can share it without importing the tunnel

/** serve.mjs: the running wiring when settings.json has relay.endpoint, else null (the relay stays off by default). */
export function startRelayFromSettings({ requestListener, settings = loadUserSettings(), ...rest } = {}) {
  const relay = normalizeRelaySettings(settings?.relay);
  if (!relay) return null;
  return createRelayWiring({ endpoint: relay.endpoint, requestListener, ...rest }).start();
}
