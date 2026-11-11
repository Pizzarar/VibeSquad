// Remote boot (Android APK, PLAN_ANDROID_MESHNET.md block A1): pure logic for the remote build, which pairs with
// a PC over VS-native LAN/Meshnet (the 6-digit code / QR that PairDeviceModal shows). The server redeems
// `https://<host>:<port>/pair?code=…` and sets the vs_device cookie, exactly as for the paired-PC browser; the
// app then opens the server's own UI. No imports: the screen is src/RemotePairScreen.tsx and node tests use fakes.

/**
 * The E5 relay pin of a stored host (E5_THREAT_MODEL.md §7 pin-store rule). `hostId` is the PC's self-certifying relay
 * id (base64url SHA-256 of `pubKey`), which differs from the E4a host id: one PC, two ids, ONE hosts[] entry once the
 * two are folded (foldRelayHost). `pubKey` is write-once per relay id. `token` is the per-device bearer token the PC
 * minted inside the E2EE channel (stored like the Meshnet cookie is, on this device only; revoked on the PC).
 */
export type StoredRelayPin = { hostId: string; endpoint: string; pubKey: string; token?: string };

/**
 * One paired PC (PLAN_ANDROID_END_STATE.md E4a). `hostId` is the PC's ~/.vibesquad/host-id as /api/auth/status
 * reports it, or "" until the phone has heard it (a v:2 session knew no host id; a relay-only entry carries its relay
 * id here until the fold learns the E4a id). `meshnetHost` is the `host:port` this device pairs over LAN/Meshnet;
 * `relay` is the E5 outbound relay pin. The device cookie itself lives in the WebView, and the CA pin lives in the
 * native trust store keyed by meshnetHost.
 */
export type StoredRemoteHost = {
  hostId: string;
  /** The PC's VS CA SHA-256 (lowercase hex) this device pinned at pairing, or "" (plain browser: the OS trust store holds it). */
  caFp?: string;
  label: string;
  meshnetHost?: string;
  relay?: StoredRelayPin;
  savedAt: string;
};

/** The stored pairings: every PC this device paired with, and which one it opens. One host today; the switcher UI waits for a second. */
export type StoredRemoteSession = { v: 3; activeHostId: string; hosts: StoredRemoteHost[] };

/** What a v:2 session (one LAN/Meshnet host, no host id) looked like; still read, never written. */
type StoredRemoteSessionV2 = { v: 2; host: string; savedAt: string };

/**
 * What a QR, deep link or typed input resolves to. `code` is empty for a host-only input, `host` for a code-only one.
 * `fp` is the PC's VS CA SHA-256 (lowercase hex, 16-64 chars; a prefix is only accepted from a person reading it off
 * the PC) or "" when the input carried none.
 */
export type PairTarget = { host: string; code: string; fp: string };

type Get = Pick<Storage, "getItem">;
type GetSet = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const REMOTE_SESSION_KEY = "vs.remote.session";
/** Port the server listens on when an address is typed without one (same default as the desktop app). */
export const DEFAULT_PAIR_PORT = 4180;
export const DEEP_LINK_SCHEME = "vibesquad";

/** Build-time remote flag. The vite remote mode sets VITE_VS_REMOTE=1; unset in node and desktop builds. */
const BUILD_REMOTE: boolean = (() => {
  try {
    return import.meta.env?.VITE_VS_REMOTE === "1";
  } catch {
    return false;
  }
})();

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  return safe(() => ((globalThis as any)[kind] as Storage | undefined) ?? null, null);
}

export function isLocalHost(hostname: string): boolean {
  const h = (hostname ?? "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "tauri.localhost" || h.endsWith(".localhost");
}

/** True when this page is the remote (APK) build. Stable for the page's lifetime. Desktop/local: false. */
export function isRemote(): boolean {
  return BUILD_REMOTE;
}

const HOST_RE = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

/** `host` or `host:port` -> `host:port` (port defaults to 4180); null when it isn't a plausible remote address. */
export function normalizeHost(input: string): string | null {
  const t = (input ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!t || !HOST_RE.test(t)) return null;
  const portAt = t.lastIndexOf(":");
  const hasPort = portAt > 0 && !t.endsWith("]") && /^\d+$/.test(t.slice(portAt + 1));
  const name = hasPort ? t.slice(0, portAt) : t;
  const port = hasPort ? Number(t.slice(portAt + 1)) : DEFAULT_PAIR_PORT;
  if (!(port >= 1 && port <= 65535) || /^\d+$/.test(name) || isLocalHost(name)) return null;
  return `${name}:${port}`;
}

/** `123456` / `123-456` / `123 456` -> `123456`; null otherwise. */
export function normalizeCode(input: string): string | null {
  const t = (input ?? "").trim();
  return /^\d{3}[-\s]?\d{3}$/.test(t) ? t.replace(/[-\s]/g, "") : null;
}

/**
 * `AB:CD:…` / `abcd…` -> lowercase hex; null unless 16-64 hex digits (8 bytes is the shortest prefix the PC's pairing
 * dialog shows, and the shortest we accept when a person types it).
 */
export function normalizeFp(input: string): string | null {
  const t = (input ?? "").trim().replace(/[:\s-]/g, "").toLowerCase();
  return /^[0-9a-f]{16,64}$/.test(t) ? t : null;
}

/**
 * Reads a pairing target out of whatever the user scanned, pasted or typed:
 *  - the desktop QR / "Copy Pairing Link": `https://<host>:<port>/pair?code=123456`
 *  - the app deep link: `vibesquad://pair?host=<host>:<port>&code=123456`
 *  - `<host>[:port]` alone (code empty), or a bare 6-digit code (host empty).
 * Returns null when nothing usable is in there.
 */
export function parsePairInput(input: string): PairTarget | null {
  const t = (input ?? "").trim();
  if (!t) return null;
  const code = normalizeCode(t);
  if (code) return { host: "", code, fp: "" };
  const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? safe(() => new URL(t), null) : null;
  if (u && /^https?:$/.test(u.protocol)) {
    const host = normalizeHost(u.host);
    return host ? { host, code: normalizeCode(u.searchParams.get("code") ?? "") ?? "", fp: normalizeFp(u.searchParams.get("fp") ?? "") ?? "" } : null;
  }
  if (u && u.protocol === `${DEEP_LINK_SCHEME}:`) {
    const host = normalizeHost(u.searchParams.get("host") ?? "");
    return host ? { host, code: normalizeCode(u.searchParams.get("code") ?? "") ?? "", fp: normalizeFp(u.searchParams.get("fp") ?? "") ?? "" } : null;
  }
  if (u) return null;
  const host = normalizeHost(t);
  return host ? { host, code: "", fp: "" } : null;
}

/** The deep link (`vibesquad://pair?host=…&code=…`) equivalent of a pairing QR / link; null when it has no host. */
export function toAndroidDeepLink(input: string): string | null {
  const p = parsePairInput(input);
  if (!p?.host) return null;
  const q = new URLSearchParams({ host: p.host, ...(p.code ? { code: p.code } : {}), ...(p.fp ? { fp: p.fp } : {}) });
  return `${DEEP_LINK_SCHEME}://pair?${q.toString()}`;
}

/** The server URL that redeems a code: GET sets the vs_device cookie and redirects to `/`. */
export function pairRedeemUrl(host: string, code: string, deviceName = "VibeSquad Android", appOrigin = ""): string {
  const q = new URLSearchParams({ code, name: deviceName, ...(appOrigin ? { vs_app: appOrigin } : {}) });
  return `https://${host}/pair?${q.toString()}`;
}

/**
 * The URL of the server's own UI for a stored host. `appOrigin` (the WebView's own origin) lets the server send the
 * user back to the pair screen (`#unpaired`) when this device is no longer paired, instead of a dead 401 page.
 */
export function serverUrl(host: string, appOrigin = ""): string {
  // Via /__vibesquad/enter: the app→PC navigation is cross-site, so the Strict vs_device cookie is withheld on it; the
  // PC's same-site hop to "/" carries it (server/auth.mjs handleEnter).
  return appOrigin ? `https://${host}/__vibesquad/enter?${new URLSearchParams({ vs_app: appOrigin }).toString()}` : `https://${host}/`;
}

/** What the server's redirect back to the app (`<app origin>/#paired|#unpaired|#failed`) says. */
export type PairReturn = "paired" | "unpaired" | "failed";
export function parsePairReturn(hash: string): PairReturn | null {
  const m = /^#(paired|unpaired|failed)$/.exec(hash ?? "");
  return m ? (m[1] as PairReturn) : null;
}

/** A pairing the user confirmed and sent to the server, not yet proven: becomes the session on `#paired` only. */
export const REMOTE_PENDING_KEY = "vs.remote.pending";
const PENDING_MAX_AGE_MS = 10 * 60_000;

export function savePending(host: string, local: GetSet | null = browserStorage("localStorage"), now = new Date()): void {
  const h = normalizeHost(host);
  if (!local || !h) throw new Error("remote: not a valid server address");
  local.setItem(REMOTE_PENDING_KEY, JSON.stringify({ host: h, at: now.getTime() }));
}

/** The host of a fresh pending pairing, or null. */
export function readPending(local: Get | null = browserStorage("localStorage"), now = new Date()): string | null {
  const s = safe(() => JSON.parse(local?.getItem(REMOTE_PENDING_KEY) ?? "null"), null);
  if (!s || typeof s.host !== "string" || typeof s.at !== "number" || now.getTime() - s.at > PENDING_MAX_AGE_MS) return null;
  return normalizeHost(s.host);
}

export function clearPending(local: GetSet | null = browserStorage("localStorage")): void {
  safe(() => local?.removeItem(REMOTE_PENDING_KEY), undefined);
}

const HOST_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** A host id as the server reports it, or "" (unknown / malformed). Never trusted for anything but keying saved hosts. */
export function normalizeHostId(input: unknown): string {
  const t = typeof input === "string" ? input.trim() : "";
  return HOST_ID_RE.test(t) ? t : "";
}

function validHost(h: unknown): StoredRemoteHost | null {
  const x = h as Partial<StoredRemoteHost> | null;
  if (!x || typeof x !== "object" || typeof x.savedAt !== "string") return null;
  const meshnetHost = typeof x.meshnetHost === "string" ? normalizeHost(x.meshnetHost) : null;
  const hostId = normalizeHostId(x.hostId);
  const r = x.relay as Partial<StoredRelayPin> | null | undefined;
  const relayId = normalizeHostId(r?.hostId) || hostId; // entries written before the fold keyed the pin by the entry id
  const relay: StoredRelayPin | null =
    r && typeof r === "object" && typeof r.endpoint === "string" && typeof r.pubKey === "string" && /^wss:\/\//i.test(r.endpoint) && r.pubKey && relayId
      ? { hostId: relayId, endpoint: r.endpoint, pubKey: r.pubKey, ...(typeof r.token === "string" && r.token ? { token: r.token } : {}) }
      : null;
  if (!meshnetHost && !relay) return null; // no way to reach it
  const caFp = normalizeFp(typeof x.caFp === "string" ? x.caFp : "") ?? "";
  const label = typeof x.label === "string" && x.label.trim() ? x.label.trim().slice(0, 60) : meshnetHost || relay!.endpoint;
  return { hostId, ...(caFp ? { caFp } : {}), label, ...(meshnetHost ? { meshnetHost } : {}), ...(relay ? { relay } : {}), savedAt: x.savedAt };
}

/**
 * Two saved entries are the same PC only when the host id AND the pinned CA fingerprint match. The id alone is public
 * (any unpaired caller can read it from /api/auth/status) and a cloned ~/.vibesquad gives two PCs one id, so it must
 * never evict another saved host by itself.
 */
export function samePc(a: { hostId: string; caFp?: string }, b: { hostId: string; caFp?: string }): boolean {
  return Boolean(a.hostId) && a.hostId === b.hostId && Boolean(a.caFp) && a.caFp === b.caFp;
}

/**
 * Validates a parsed session value, upgrading a v:2 one losslessly (host -> meshnetHost + label, hostId "" until the
 * PC reports it; the CA pin is keyed by the same host string, so it stays valid). Null for junk or an old relay offer.
 */
export function migrateSession(s: unknown): StoredRemoteSession | null {
  const v = s as { v?: unknown } | null;
  if (!v || typeof v !== "object") return null;
  if (v.v === 2) {
    const old = v as Partial<StoredRemoteSessionV2>;
    if (typeof old.host !== "string" || typeof old.savedAt !== "string") return null;
    const h = normalizeHost(old.host);
    return h ? { v: 3, activeHostId: "", hosts: [{ hostId: "", label: h, meshnetHost: h, savedAt: old.savedAt }] } : null;
  }
  if (v.v !== 3) return null;
  const raw = v as Partial<StoredRemoteSession>;
  const hosts = (Array.isArray(raw.hosts) ? raw.hosts : []).map(validHost).filter((h): h is StoredRemoteHost => Boolean(h));
  if (!hosts.length) return null;
  const want = normalizeHostId(raw.activeHostId);
  const active = (want && hosts.find((h) => h.hostId === want)) || hosts[0];
  return { v: 3, activeHostId: active.hostId, hosts };
}

/** The host this device opens: the one `activeHostId` names, else the first (only) one. */
export function activeHost(s: StoredRemoteSession | null): StoredRemoteHost | null {
  if (!s?.hosts.length) return null;
  return (s.activeHostId && s.hosts.find((h) => h.hostId === s.activeHostId)) || s.hosts[0];
}

/** The LAN/Meshnet `host:port` of the active host, or "" (relay-only hosts wait for E5). */
export function activeMeshnetHost(s: StoredRemoteSession | null): string {
  return activeHost(s)?.meshnetHost ?? "";
}

/** UI rule (E4): no host-switcher chrome while there is at most one saved host. */
export function showHostSwitcher(s: StoredRemoteSession | null): boolean {
  return (s?.hosts.length ?? 0) > 1;
}

/** The stored pairings, or null when missing or malformed (an old relay-offer session is not trusted). v:2 is upgraded on read. */
export function readSession(storage: Get | null = browserStorage("localStorage")): StoredRemoteSession | null {
  if (!storage) return null;
  const raw = safe(() => storage.getItem(REMOTE_SESSION_KEY), null);
  if (!raw) return null;
  return migrateSession(safe(() => JSON.parse(raw), null));
}

function writeSession(local: GetSet, s: StoredRemoteSession): void {
  local.setItem(REMOTE_SESSION_KEY, JSON.stringify(s satisfies StoredRemoteSession));
}

/**
 * Remembers `host` as the active pairing. Pass `hostId` when /api/auth/status already reported it and `caFp` (the
 * pinned CA fingerprint) when the device pinned one. An entry for the same address, or for the same PC (host id AND
 * CA fingerprint), is updated in place, so re-pairing never duplicates a host; the id alone never folds anything.
 */
export function saveSession(host: string, local: GetSet | null = browserStorage("localStorage"), now = new Date(), hostId: unknown = "", caFp: unknown = ""): void {
  if (!local) throw new Error("remote: this browser has no localStorage");
  const h = normalizeHost(host);
  if (!h) throw new Error("remote: not a valid server address");
  const id = normalizeHostId(hostId);
  const fp = normalizeFp(typeof caFp === "string" ? caFp : "") ?? "";
  const prev = readSession(local);
  const me = { hostId: id, caFp: fp };
  const same = prev?.hosts.find((x) => x.meshnetHost === h) ?? prev?.hosts.find((x) => samePc(x, me));
  const hosts = prev?.hosts.filter((x) => x !== same && x.meshnetHost !== h && !samePc(x, me)) ?? [];
  const entry: StoredRemoteHost = {
    ...same,
    hostId: id || same?.hostId || "",
    label: same?.label && same.label !== same.meshnetHost ? same.label : h,
    meshnetHost: h,
    savedAt: now.toISOString(),
  };
  if (fp) entry.caFp = fp;
  else if (id && same?.hostId && same.hostId !== id) delete entry.caFp; // a new PC behind the same address: the old pin is not its pin
  writeSession(local, { v: 3, activeHostId: entry.hostId, hosts: [entry, ...hosts] });
}

/**
 * Fills in the host id once the PC reported it (/api/auth/status `hostId`) for the host at `host`. Returns true when
 * the stored session changed. A different id for an already-known host means the PC's ~/.vibesquad was reset: the
 * entry follows the PC (the CA pin and device cookie are checked separately, so nothing is trusted on the id alone).
 * Another entry is folded into this one only when it is the same PC: same id AND same pinned CA fingerprint.
 */
export function setSessionHostId(host: string, hostId: unknown, local: GetSet | null = browserStorage("localStorage")): boolean {
  const id = normalizeHostId(hostId);
  const h = normalizeHost(host);
  const s = local ? readSession(local) : null;
  if (!local || !s || !id || !h) return false;
  const i = s.hosts.findIndex((x) => x.meshnetHost === h);
  if (i < 0 || s.hosts[i].hostId === id) return false;
  const wasActive = activeHost(s) === s.hosts[i];
  const merged: StoredRemoteHost = { ...s.hosts[i], hostId: id };
  const hosts = s.hosts.filter((x, j) => j === i || !samePc(x, merged));
  hosts[hosts.indexOf(s.hosts[i])] = merged;
  writeSession(local, { v: 3, activeHostId: wasActive ? id : s.activeHostId, hosts });
  return true;
}

/**
 * Best-effort: asks `host` for its id (GET /api/auth/status answers unpaired callers with `hostId`). Resolves "" on any
 * failure (offline, CORS in a plain browser, old server) and never throws; the id is only a key, never a credential.
 */
export async function fetchHostId(host: string, fetchImpl: typeof fetch | null = typeof fetch === "function" ? fetch : null, timeoutMs = 2000): Promise<string> {
  const h = normalizeHost(host);
  if (!h || !fetchImpl) return "";
  try {
    const res = await fetchImpl(`https://${h}/api/auth/status`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    return normalizeHostId((await res.json())?.hostId);
  } catch {
    return "";
  }
}

/** Forget one PC (the server still lists the device until it is revoked there). The next saved host becomes active. */
export function forgetHost(host: string, local: GetSet | null = browserStorage("localStorage")): void {
  const h = normalizeHost(host);
  const s = local ? readSession(local) : null;
  if (!local || !s) return;
  const hosts = s.hosts.filter((x) => x.meshnetHost !== h);
  if (!hosts.length) return clearSession(local);
  const active = hosts.find((x) => x.hostId === s.activeHostId) ?? hosts[0];
  writeSession(local, { v: 3, activeHostId: active.hostId, hosts });
}

// ---- E5 relay pin store (docs/lanes/android-app/E5_THREAT_MODEL.md §7 "Pin-store rule") ----
// The pin (relay host id -> host X25519 public key) is the trust anchor of the E2EE relay. It arrives out of band in a
// pairing link and is stored once; a later link can never replace it. remoteRelayConnect.ts connects with the STORED
// key for that exact relay id, so a token is never sent to a host whose key differs from the one it was issued under.
// X1 wire L2: the relay ENDPOINT of a known host is not replaced by a link either, unless the user confirmed the move
// (`repoint: true`); the key is public, so a crafted link could otherwise silently route the phone through a relay the
// attacker runs (metadata, denial of service; never plaintext or tokens).

/** A pairing link named a host this device already knows under a different key. Shown to the user; never a silent re-pair. */
export class RelayPinMismatchError extends Error {
  constructor(hostId: string) {
    super(`this device already trusts a different key for host ${hostId}; the link was ignored. Forget the host first if the PC really changed its key.`);
    this.name = "RelayPinMismatchError";
  }
}

const b64Std = (s: string) => s.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
const b64Pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4); // stored padded, the form the transport consumes
const b64Len = (s: string): number => safe(() => atob(b64Std(s) + "=".repeat((4 - (b64Std(s).length % 4)) % 4)).length, 0);
/** Two base64 / base64url encodings of the same 32 bytes compare equal. */
export const sameRelayKey = (a: string, b: string): boolean => b64Std(a) === b64Std(b);

/** The endpoint as the link builder and the pin store compare it: origin + path, never userinfo, query or fragment. "" when not wss://. */
export function publicRelayEndpoint(endpoint: unknown): string {
  const t = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!/^wss:\/\//i.test(t)) return "";
  return safe(() => {
    const u = new URL(t);
    return u.protocol === "wss:" ? `${u.origin}${u.pathname}` : "";
  }, "");
}

/**
 * The hosts[] entry that owns relay id `relayId`: by its pin first, else the entry keyed by that id (an unfolded
 * relay-only entry, or a LAN entry whose pin arrives under its own id). Safe: a link's id is self-certifying
 * (acceptPairingFragment), so no link can name an E4a id it does not hold the key for.
 */
function relayEntryIndex(hosts: StoredRemoteHost[], relayId: string): number {
  const byPin = hosts.findIndex((h) => h.relay?.hostId === relayId);
  return byPin >= 0 ? byPin : hosts.findIndex((h) => h.hostId === relayId);
}

/** The stored relay pin for relay id `hostId`, or null. The connect path reads this and never the link's key. */
export function relayPinFor(hostId: unknown, local: Get | null = browserStorage("localStorage")): StoredRelayPin | null {
  const id = normalizeHostId(hostId);
  const s = readSession(local);
  if (!id || !s) return null;
  const i = relayEntryIndex(s.hosts, id);
  return i >= 0 ? (s.hosts[i].relay ?? null) : null;
}

/** The entry a relay id belongs to (for its label in dialogs), or null. */
export function relayHostFor(hostId: unknown, local: Get | null = browserStorage("localStorage")): StoredRemoteHost | null {
  const id = normalizeHostId(hostId);
  const s = readSession(local);
  if (!id || !s) return null;
  const i = relayEntryIndex(s.hosts, id);
  return i >= 0 ? s.hosts[i] : null;
}

export type SaveRelayPinOptions = {
  /** X1 wire L2: move a KNOWN host to the link's endpoint. Only after the user confirmed; default keeps the stored endpoint. */
  repoint?: boolean;
  /** A string replaces the stored device token for this relay, null removes it, undefined keeps it. */
  token?: string | null;
};

/**
 * Pin-store rule 1 + X1 L2: a link may ADD a relay host; for a host whose stored key is the same it changes nothing
 * unless `repoint` is set (the user confirmed the endpoint move); it never changes the key of a host that already has
 * one (RelayPinMismatchError, store untouched). Run acceptPairingFragment (remoteRelayTransport.ts) on the link first:
 * with self-certifying ids a crafted link can only name a NEW host. Returns the pin as stored.
 */
export function saveRelayPin(
  hostId: unknown,
  relay: { endpoint: string; pubKey: string },
  local: GetSet | null = browserStorage("localStorage"),
  now = new Date(),
  label = "",
  opts: SaveRelayPinOptions = {},
): StoredRelayPin {
  if (!local) throw new Error("remote: this browser has no localStorage");
  const id = normalizeHostId(hostId);
  if (!id) throw new Error("remote: not a valid host id");
  const endpoint = typeof relay?.endpoint === "string" ? relay.endpoint.trim() : "";
  if (!/^wss:\/\//i.test(endpoint)) throw new Error("remote: relay endpoint must be wss://");
  const pubKey = typeof relay?.pubKey === "string" ? b64Pad(b64Std(relay.pubKey)) : "";
  if (b64Len(pubKey) !== 32) throw new Error("remote: not a valid host key");
  const prev = readSession(local);
  const hosts = prev?.hosts.slice() ?? [];
  const i = relayEntryIndex(hosts, id);
  const token = typeof opts.token === "string" && opts.token ? { token: opts.token } : {};
  if (i >= 0) {
    const cur = hosts[i].relay;
    if (cur && !sameRelayKey(cur.pubKey, pubKey)) throw new RelayPinMismatchError(id);
    const pin: StoredRelayPin = cur ? { ...cur, hostId: id, endpoint: opts.repoint ? endpoint : cur.endpoint, ...token } : { hostId: id, endpoint, pubKey, ...token };
    if (opts.token === null) delete pin.token;
    hosts[i] = { ...hosts[i], relay: pin, savedAt: now.toISOString() };
    writeSession(local, { v: 3, activeHostId: prev?.activeHostId || hosts[i].hostId, hosts });
    return pin;
  }
  const pin: StoredRelayPin = { hostId: id, endpoint, pubKey, ...token };
  const entry: StoredRemoteHost = { hostId: id, label: (label || "").trim().slice(0, 60) || safe(() => new URL(endpoint).host, endpoint), relay: pin, savedAt: now.toISOString() };
  writeSession(local, { v: 3, activeHostId: id, hosts: [entry, ...hosts] });
  return pin;
}

/**
 * Folds the E4a host id and the E5 relay id of ONE PC into one hosts[] entry (E5_THREAT_MODEL.md §11 residual (a)).
 * Call it only with an `e4aHostId` the PC reported over the pinned AND authenticated relay channel for `relayId`
 * (/api/auth/status through the relay): never from a link, which is unauthenticated. Rules:
 *  - a LAN entry with that E4a id and no relay pin (or the same key) takes the relay pin; the relay-only entry goes;
 *  - a LAN entry whose relay pin has a DIFFERENT key keeps it (the PC rotated its key, or this is not that PC): no
 *    fold, both entries stay, false is returned, so nothing the channel said ever moves an existing pin;
 *  - a relay-only entry still keyed by its relay id learns the E4a id (the entry follows the PC, the pin stays).
 * Returns true when the store changed.
 */
export function foldRelayHost(relayId: unknown, e4aHostId: unknown, local: GetSet | null = browserStorage("localStorage")): boolean {
  const rid = normalizeHostId(relayId);
  const hid = normalizeHostId(e4aHostId);
  const s = local ? readSession(local) : null;
  if (!local || !s || !rid || !hid) return false;
  const ri = relayEntryIndex(s.hosts, rid);
  if (ri < 0) return false;
  const relayEntry = s.hosts[ri];
  const pin: StoredRelayPin = { ...relayEntry.relay!, hostId: rid };
  const li = s.hosts.findIndex((h, j) => j !== ri && h.hostId === hid);
  if (li < 0) {
    if (relayEntry.hostId === hid && relayEntry.relay?.hostId === rid) return false;
    const hosts = s.hosts.slice();
    hosts[ri] = { ...relayEntry, hostId: hid, relay: pin };
    writeSession(local, { v: 3, activeHostId: s.activeHostId === relayEntry.hostId ? hid : s.activeHostId, hosts });
    return true;
  }
  const lan = s.hosts[li];
  if (lan.relay && !sameRelayKey(lan.relay.pubKey, pin.pubKey)) return false;
  const relayHostLabel = safe(() => new URL(pin.endpoint).host, "");
  const merged: StoredRemoteHost = {
    ...lan,
    relay: pin,
    // Keep a label a person chose; a generated one (address or relay host) gives way to the other side's chosen one.
    label: lan.label !== lan.meshnetHost ? lan.label : relayEntry.label !== relayHostLabel ? relayEntry.label : lan.label,
    savedAt: relayEntry.savedAt > lan.savedAt ? relayEntry.savedAt : lan.savedAt,
  };
  const hosts = s.hosts.filter((_, j) => j !== ri && j !== li);
  hosts.splice(Math.min(ri, li), 0, merged);
  const wasActive = s.activeHostId === relayEntry.hostId || s.activeHostId === lan.hostId;
  writeSession(local, { v: 3, activeHostId: wasActive ? merged.hostId : s.activeHostId, hosts });
  return true;
}

/** Forget every pairing on this device (the server still lists the device until it is revoked on the PC). */
export function clearSession(local: GetSet | null = browserStorage("localStorage")): void {
  safe(() => local?.removeItem(REMOTE_SESSION_KEY), undefined);
}

/** Remote and not yet paired: the pairing screen shows instead of the app. */
export function needsPairing(remote: boolean, local: Get | null = browserStorage("localStorage")): boolean {
  return remote && !readSession(local);
}

/** True when `ua` is an Android browser / WebView user-agent string (defaults to `navigator.userAgent`). */
export function isAndroidUserAgent(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  return /Android/i.test(ua || "");
}

export type RemoteErrorKind = "bad-input" | "unreachable" | "timeout" | "unknown";
export type RemoteError = { kind: RemoteErrorKind; message: string };

const MESSAGES: Record<RemoteErrorKind | "certChanged", string> = {
  certChanged: "This PC's certificate changed. Scan a new QR on the PC to pair again.",
  "bad-input": "Enter the server address and the 6-digit code from Pair a device on your PC, or scan its QR code.",
  unreachable:
    "Couldn't reach your PC. Check this phone is on the same Wi-Fi (Home LAN) or on NordVPN Meshnet, that VibeSquad is running there, and that the CA fingerprint matches the one on your PC.",
  timeout: "Timed out waiting for your PC. Check the address and your connection, then try again.",
  unknown: "Something went wrong connecting to your PC.",
};

export function remoteError(kind: RemoteErrorKind, message = MESSAGES[kind]): RemoteError {
  return { kind, message };
}

/** Maps whatever a reachability probe threw to a user-facing error. */
export function mapRemoteError(err: unknown): RemoteError {
  const e = err as { name?: string; message?: string } | null;
  const msg = String((e && typeof e === "object" ? e.message : err) ?? "");
  // The PC's CA was regenerated (its address changed), so the pinned CA no longer validates the PC's certificate.
  if (/trust anchor|certification path|SSLHandshake|CERT_/i.test(msg)) return remoteError("unknown", MESSAGES.certChanged);
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out|SocketTimeout/i.test(msg)) return remoteError("timeout");
  if (/failed to fetch|network|load failed|ECONN|ENOTFOUND|failed to connect to|unable to resolve host|certificate|ssl|tls/i.test(msg)) return remoteError("unreachable");
  return remoteError("unknown", msg ? `${MESSAGES.unknown} (${msg})` : MESSAGES.unknown);
}
