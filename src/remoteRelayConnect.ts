// E5 relay connect path for the phone / remote client (docs/lanes/android-app/E5_THREAT_MODEL.md §7 item 8, §11).
// A relay pairing link (`vibesquad://pair#hostId=&pub=&relay=&code=`, built by server/relay-link.mjs for POST
// /__vibesquad/pair/start) turns into a pinned E2EE session here. The order is the security contract:
//  1. acceptPairingFragment: the link's hostId must be the self-certifying id of its pub (X1 M-2), so a crafted link can
//     only ever name a NEW host.
//  2. The STORED pin for that relay id always wins. A different key for a known host is RelayPinMismatchError, shown to
//     the user, nothing written. The link's key is used only for a host this device has never seen.
//  3. X1 wire L2: a known host's relay endpoint moves only after the user confirmed it (`confirmRepoint`); the default
//     keeps the stored endpoint and still connects with the link's code through it.
//  4. Nothing is persisted until the pinned handshake AND the redeem / authenticate succeeded through the endpoint the
//     session actually used, so a dead or hostile relay leaves the store untouched.
//  5. Fold (E5 §11 residual a): the PC's E4a host id AND CA fingerprint are read over the authenticated channel
//     (/api/auth/status, which also echoes the relay id + key, cross-checked against the pin) and foldRelayHost merges
//     the relay pin into the LAN entry of the SAME PC (id + fingerprint, E4a's samePc rule). Never from the link, and
//     never on the public id alone (R1 M2 / X1 R1 M1).
//  6. E4b pending (X1 R1 L1): a device-minted ticket is kept beside a working token, never over it; it replaces the
//     token only once it authenticates.
import {
  acceptPairingFragment,
  connectRelay,
  RelayAuthError,
  RelayPendingError,
  takePairingFragment,
  type PairingFragment,
  type RelayClient,
  type RelayOptions,
} from "./remoteRelayTransport.ts";
import {
  foldRelayHost,
  normalizeFp,
  normalizeHostId,
  publicRelayEndpoint,
  relayHostFor,
  relayPinFor,
  RelayPinMismatchError,
  sameRelayKey,
  saveRelayPin,
  type StoredRelayPin,
} from "./remoteSession.ts";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The APK deep link that carries a relay pairing fragment (server/relay-link.mjs RELAY_LINK_BASE). */
export const RELAY_LINK_BASE = "vibesquad://pair";

const CODE_RE = /^\d{6}$/;
/** The fragment carries the key unpadded; the pin store and the transport use padded standard base64. */
const padB64 = (k: string): string => k + "=".repeat((4 - (k.length % 4)) % 4);

/**
 * Reads a relay pairing link: the APK deep link `vibesquad://pair#…` or an https URL carrying the same fragment.
 * Null when the text is not one (a LAN link, an address, junk) or the fragment is malformed. Pure: no history, no store.
 */
export function parseRelayPairingLink(text: string): PairingFragment | null {
  const t = (text ?? "").trim();
  const at = t.indexOf("#");
  if (at < 0) return null;
  const head = t.slice(0, at);
  if (!/^(vibesquad:\/\/pair\/?|https:\/\/[^\s#?]+(\?[^\s#]*)?)$/i.test(head)) return null;
  return takePairingFragment({ location: { hash: t.slice(at), pathname: "", search: "" } });
}

export type RelayPinDecision = {
  /** The pin the session must use: the stored one for a known host (endpoint moved only when `repointed`), the link's for a new one. */
  pin: StoredRelayPin;
  known: boolean;
  repointed: boolean;
  label: string;
};

export type ResolveRelayPinOptions = {
  store?: Store | null;
  /** X1 wire L2: asked before a known host's relay endpoint moves. Default answer: no (keep the stored endpoint). */
  confirmRepoint?: (q: { label: string; from: string; to: string }) => boolean | Promise<boolean>;
};

const storeOf = (o: { store?: Store | null }): Store | null => (o.store === undefined ? ((globalThis as any).localStorage as Store | undefined) ?? null : o.store);

/**
 * Applies the pin-store rules to a link WITHOUT writing anything: stored key wins, mismatch throws, endpoint move needs
 * the user's yes. The caller persists (saveRelayPin with `repoint: decision.repointed`) once the session succeeded.
 */
export async function resolveRelayPin(f: PairingFragment, opts: ResolveRelayPinOptions = {}): Promise<RelayPinDecision> {
  await acceptPairingFragment(f);
  const endpoint = publicRelayEndpoint(f.relay);
  if (!endpoint) throw new RelayAuthError("relay endpoint must be wss://");
  const store = storeOf(opts);
  const stored = relayPinFor(f.hostId, store);
  if (!stored) {
    return { pin: { hostId: f.hostId, endpoint, pubKey: padB64(f.pub) }, known: false, repointed: false, label: new URL(endpoint).host };
  }
  if (!sameRelayKey(stored.pubKey, f.pub)) throw new RelayPinMismatchError(f.hostId);
  const label = relayHostFor(f.hostId, store)?.label || f.hostId;
  if (publicRelayEndpoint(stored.endpoint) === endpoint) return { pin: stored, known: true, repointed: false, label };
  const yes = opts.confirmRepoint ? (await opts.confirmRepoint({ label, from: publicRelayEndpoint(stored.endpoint) || stored.endpoint, to: endpoint })) === true : false;
  return { pin: yes ? { ...stored, endpoint } : stored, known: true, repointed: yes, label };
}

export type RelayConnectResult = {
  /** Open, authenticated (unless `pending`) session over the pinned channel. The caller owns it. */
  client: RelayClient;
  relayId: string;
  /** The PC's E4a host id as it reported it over the channel, or "" (pending session, old server, or the status call failed). */
  hostId: string;
  deviceId: string;
  /** E4b: a device-minted code; the token is stored and waits for the minting device's Approve. */
  pending: boolean;
  label: string;
  repointed: boolean;
};

export type ConnectWithRelayLinkOptions = ResolveRelayPinOptions & {
  connect?: (o: RelayOptions) => Promise<RelayClient>;
  deviceName?: string;
  now?: Date;
};

/**
 * Link -> pinned session -> stored pin + token -> folded hosts[] entry. Throws (and closes the socket) on any failure
 * before anything is written: RelayPinMismatchError, RelayAuthError (bad link, rejected code / token), transport errors.
 * RelayPendingError is NOT thrown: a pending redeem returns `pending: true` with the ticket stored.
 */
export async function connectWithRelayLink(f: PairingFragment, opts: ConnectWithRelayLinkOptions = {}): Promise<RelayConnectResult> {
  const d = await resolveRelayPin(f, opts);
  const store = storeOf(opts);
  const connect = opts.connect ?? connectRelay;
  const client = await connect({ endpoint: d.pin.endpoint, hostId: f.hostId, hostPubKey: d.pin.pubKey });
  try {
    const code = f.code && CODE_RE.test(f.code) ? f.code : "";
    let deviceId = "";
    let pending = false;
    let token = d.pin.token ?? ""; // the working token stays unless something better authenticated
    let pendingToken = d.pin.pendingToken ?? "";
    const auth = async (t: string): Promise<"ok" | "pending"> => {
      try {
        deviceId = (await client.authenticate(t)).deviceId;
        return "ok";
      } catch (e) {
        if (e instanceof RelayPendingError) return "pending";
        throw e;
      }
    };
    if (code) {
      const r = await client.redeem(code, opts.deviceName ?? "VibeSquad Android");
      deviceId = r.deviceId;
      if (r.pending === true) {
        // X1 R1 L1: a device-minted code never downgrades a phone that already holds a working token; the ticket waits beside it.
        pending = true;
        pendingToken = r.token;
      } else {
        token = r.token;
        pendingToken = "";
      }
    } else if (token || pendingToken) {
      // No code in the link: reconnect with what this device already holds for that pin (rule 2: same key, same id).
      // The working token first; a pending ticket only if there is no working token or it was revoked meanwhile.
      let state: "ok" | "pending" | "revoked" = "revoked";
      if (token) {
        try {
          state = await auth(token);
        } catch (e) {
          if (!(e instanceof RelayAuthError) || !pendingToken) throw e;
          state = "revoked";
        }
      }
      if (state === "pending") pending = true; // a stored token that is itself still a ticket (legacy store)
      if (state === "revoked" && pendingToken) {
        const r = await auth(pendingToken);
        if (r === "ok") {
          token = pendingToken; // approved since: the ticket becomes the token
          pendingToken = "";
        } else {
          pending = true;
          if (state === "revoked") token = "";
        }
      }
    } else {
      throw new RelayAuthError("this link has no pairing code and this device is not paired with that PC yet");
    }
    // The handshake proved the key, the PC accepted this device: now the pin (and the endpoint it was proven through) persist.
    if (!store) throw new Error("remote: this browser has no localStorage");
    saveRelayPin(f.hostId, { endpoint: d.pin.endpoint, pubKey: d.pin.pubKey }, store, opts.now ?? new Date(), d.known ? "" : d.label, {
      repoint: d.repointed,
      token: token || null,
      pendingToken: pendingToken || null,
    });
    let hostId = "";
    if (!pending) {
      try {
        const st = (await (await client.fetch("/api/auth/status")).json()) as {
          hostId?: unknown;
          caFingerprint?: { full?: unknown } | null;
          relay?: { hostId?: unknown; pub?: unknown } | null;
        } | null;
        const e4a = normalizeHostId(st?.hostId);
        const caFp = normalizeFp(typeof st?.caFingerprint?.full === "string" ? st.caFingerprint.full : "") ?? "";
        const self = st?.relay;
        // Only the PC behind this pinned, authenticated channel can say which E4a identity it has; it must also claim this
        // very pin. The fold itself needs id AND CA fingerprint to match a LAN entry (samePc), never the public id alone.
        if (e4a && self && self.hostId === f.hostId && typeof self.pub === "string" && sameRelayKey(self.pub, d.pin.pubKey)) {
          foldRelayHost(f.hostId, e4a, store, caFp);
          hostId = e4a;
        }
      } catch {
        /* the fold is a convenience; the pairing stands */
      }
    }
    return { client, relayId: f.hostId, hostId, deviceId, pending, label: d.label, repointed: d.repointed };
  } catch (e) {
    client.close();
    throw e;
  }
}

/** Plain words for whatever the relay path threw. */
export function relayConnectErrorMessage(err: unknown): string {
  if (err instanceof RelayPinMismatchError) return `This phone already trusts a different key for that PC, so the link was ignored. If the PC really changed its relay key, forget the PC here first, then use a new link.`;
  if (err instanceof RelayPendingError) return "The PC is waiting for the device that made this code to approve it.";
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  if (err instanceof RelayAuthError) return /code/i.test(msg) ? `The PC refused this pairing code (${msg}). Make a new code on the PC and try again.` : `The relay pairing was refused: ${msg}.`;
  if (/timed? ?out/i.test(msg)) return "Timed out waiting for the relay. Check your connection and that the PC is online, then try again.";
  return msg ? `Couldn't connect through the relay (${msg}).` : "Couldn't connect through the relay.";
}
