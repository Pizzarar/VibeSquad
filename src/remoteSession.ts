// Remote boot (PLAN_PASEO_PARITY.md block R2-2): pure logic for running VS's web UI away from the PC,
// talking to the home daemon over Paseo's relay. Mode detection, the stored pairing session, offer-input
// parsing and error mapping. No imports: the browser wiring is src/paseoRemote.ts + src/RemotePair.tsx,
// and node tests pass fakes. R2-4 (hide desktop-only UI) and R2-3 (remote build) hook in via isRemote().

/** Relay pairing offer, as validated by @getpaseo/protocol's parseConnectionOfferFromUrl. */
export type RemoteOffer = {
  v: 2;
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string; useTls?: boolean };
  minimumSecurityMode?: "protected";
};

export type StoredRemoteSession = { v: 1; offer: RemoteOffer; savedAt: string };

type Get = Pick<Storage, "getItem">;
type GetSet = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const REMOTE_SESSION_KEY = "vs.remote.session";
/** Set only by an explicit "remember on this device" opt-in. */
export const REMOTE_PASSWORD_KEY = "vs.remote.password";
/** Without the opt-in the password lives in sessionStorage: gone when the tab closes. */
export const REMOTE_TAB_PASSWORD_KEY = "vs.remote.password.tab";
/** sessionStorage note left for the pairing screen when the paired app hits an auth failure. */
export const REMOTE_AUTH_NOTE_KEY = "vs.remote.authNote";
const REMOTE_FLAG_KEY = "vs.remote"; // same key as remoteTransport.ts (R2-1's test flag)

/** Build-time remote flag. R2-3's vite remote mode sets VITE_VS_REMOTE=1; unset in node and desktop builds. */
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

export function hasOfferFragment(hash: string): boolean {
  return /(^|[#&])offer=/.test(hash);
}

export function isLocalHost(hostname: string): boolean {
  const h = (hostname ?? "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "tauri.localhost" || h.endsWith(".localhost");
}

export type RemoteEnv = { search: string; hash: string; storage: Get | null; buildFlag: boolean; hostname?: string; localServerId?: string };

declare const __PASEO_SERVER_ID__: string | undefined;
/** This build's own daemon serverId (vite define); empty in remote builds and node. */
const BUILD_SERVER_ID: string = (() => {
  try {
    return typeof __PASEO_SERVER_ID__ === "string" ? __PASEO_SERVER_ID__ : "";
  } catch {
    return "";
  }
})();

/** Decodes the base64url `offer=` payload in a URL hash; null when missing, malformed or not an offer. */
export function offerFromHash(hash: string): RemoteOffer | null {
  const m = /(?:^|[#&])offer=([^&]+)/.exec(hash ?? "");
  if (!m) return null;
  return safe(() => {
    let b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const g = globalThis as any;
    const json =
      typeof g.atob === "function"
        ? new TextDecoder().decode(Uint8Array.from(g.atob(b64), (c: string) => c.charCodeAt(0)))
        : g.Buffer.from(b64, "base64").toString("utf8");
    const o = JSON.parse(json);
    return isOffer(o) ? o : null;
  }, null);
}

/** Removes `remote` and `pw` from the query and any `#offer=` from the hash; other params survive. */
export function stripRemoteFromUrl(loc: { pathname?: string; search: string; hash?: string }): string {
  const q = new URLSearchParams(loc.search ?? "");
  q.delete("remote");
  q.delete("pw");
  const qs = q.toString();
  const hash = hasOfferFragment(loc.hash ?? "")
    ? (loc.hash ?? "")
        .replace(/^#/, "")
        .split("&")
        .filter((x) => !x.startsWith("offer="))
        .join("&")
    : (loc.hash ?? "").replace(/^#/, "");
  return (loc.pathname ?? "/") + (qs ? `?${qs}` : "") + (hash ? `#${hash}` : "");
}

/** Removes only `pw` from the query, leaving `?remote=1` and any `#offer=` fragment intact for RemotePair. */
export function stripPwFromUrl(loc: { pathname?: string; search: string; hash?: string }): string {
  const q = new URLSearchParams(loc.search ?? "");
  q.delete("pw");
  const qs = q.toString();
  const hash = (loc.hash ?? "").replace(/^#/, "");
  return (loc.pathname ?? "/") + (qs ? `?${qs}` : "") + (hash ? `#${hash}` : "");
}

/**
 * Consumes a one-shot `?pw=<urlencoded>` password placed in the URL by /__desktop/setup alongside a `#offer=…`
 * pairing link. A non-empty password is saved to this tab's password storage (via saveSession when the fragment
 * is a valid offer, else directly to the tab key), then `pw` is stripped from the address bar — keeping
 * `?remote=1` and `#offer=…` so RemotePair can still complete pairing (and readPassword() pre-fills the field).
 */
export function consumeUrlOfferSession(
  loc: { pathname?: string; search: string; hash?: string },
  local: GetSet | null = browserStorage("localStorage"),
  tab: GetSet | null = browserStorage("sessionStorage"),
): void {
  const pw = new URLSearchParams(loc.search ?? "").get("pw");
  if (!pw) return;
  const target = offerFromHash(loc.hash ?? "");
  if (target) {
    try {
      saveSession(target, pw, false, local, tab);
    } catch {
      safe(() => tab?.setItem(REMOTE_TAB_PASSWORD_KEY, pw), undefined);
    }
  } else {
    safe(() => tab?.setItem(REMOTE_TAB_PASSWORD_KEY, pw), undefined);
  }
  safe(() => (globalThis as any).history.replaceState(null, "", stripPwFromUrl(loc)), undefined);
}

/**
 * Pure core of isRemote(): build flag, `?remote=1`, or (on non-local origins) `#offer=`, a stored session, or R2-1's flag.
 * On a local origin `?remote=1` only counts when it targets another PC: a bare one, or one whose offer is this PC's own daemon, is local.
 */
export function detectRemote(env: RemoteEnv): boolean {
  if (env.buildFlag) return true;
  const flagged = new URLSearchParams(env.search).get("remote") === "1";
  if (env.hostname && isLocalHost(env.hostname)) {
    if (!flagged) return false;
    const target = offerFromHash(env.hash) ?? readSession(env.storage)?.offer ?? null;
    if (!target) return false;
    const localId = (env.localServerId ?? BUILD_SERVER_ID).trim();
    return !(localId && target.serverId === localId);
  }
  if (flagged) return true;
  if (hasOfferFragment(env.hash)) return true;
  const s = env.storage;
  if (!s) return false;
  return safe(() => s.getItem(REMOTE_FLAG_KEY) === "1" || !!s.getItem(REMOTE_SESSION_KEY), false);
}

let remoteCached: boolean | null = null;
/** True when this page is the remote (relay) UI. Stable for the page's lifetime. Desktop/local: false. */
export function isRemote(): boolean {
  if (remoteCached === null) {
    const loc = (globalThis as any).location as Location | undefined;
    remoteCached = detectRemote({
      hostname: loc?.hostname ?? "",
      search: loc?.search ?? "",
      hash: loc?.hash ?? "",
      storage: browserStorage("localStorage"),
      buildFlag: BUILD_REMOTE,
    });
    if (remoteCached === true && loc) {
      const search = loc.search ?? "";
      if (new URLSearchParams(search).has("pw") || hasOfferFragment(loc.hash ?? "")) {
        consumeUrlOfferSession(loc, browserStorage("localStorage"), browserStorage("sessionStorage"));
      }
    }
    if (
      remoteCached === false &&
      loc &&
      isLocalHost(loc.hostname ?? "") &&
      new URLSearchParams(loc.search ?? "").get("remote") === "1"
    ) {
      safe(() => (globalThis as any).history.replaceState(null, "", stripRemoteFromUrl(loc)), undefined);
    }
  }
  return remoteCached;
}

function isOffer(o: any): o is RemoteOffer {
  return (
    !!o &&
    typeof o === "object" &&
    o.v === 2 &&
    typeof o.serverId === "string" &&
    o.serverId.length > 0 &&
    typeof o.daemonPublicKeyB64 === "string" &&
    o.daemonPublicKeyB64.length > 0 &&
    !!o.relay &&
    typeof o.relay.endpoint === "string" &&
    o.relay.endpoint.length > 0 &&
    (o.relay.useTls === undefined || typeof o.relay.useTls === "boolean") &&
    (o.minimumSecurityMode === undefined || o.minimumSecurityMode === "protected")
  );
}

/** The stored pairing session, or null when missing or malformed (a malformed one is not trusted). */
export function readSession(storage: Get | null = browserStorage("localStorage")): StoredRemoteSession | null {
  if (!storage) return null;
  const raw = safe(() => storage.getItem(REMOTE_SESSION_KEY), null);
  if (!raw) return null;
  const s = safe(() => JSON.parse(raw), null);
  if (!s || s.v !== 1 || !isOffer(s.offer) || typeof s.savedAt !== "string") return null;
  return { v: 1, offer: s.offer, savedAt: s.savedAt };
}

export function sessionFor(offer: RemoteOffer, now = new Date()): StoredRemoteSession {
  const o: RemoteOffer = {
    v: 2,
    serverId: offer.serverId,
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
    relay: { endpoint: offer.relay.endpoint, ...(offer.relay.useTls !== undefined ? { useTls: offer.relay.useTls } : {}) },
    ...(offer.minimumSecurityMode ? { minimumSecurityMode: offer.minimumSecurityMode } : {}),
  };
  return { v: 1, offer: o, savedAt: now.toISOString() };
}

/**
 * Saves the offer (always) and the password: in localStorage only when `remember`, else in sessionStorage
 * for this tab. An empty password clears both. Not remembering also wipes an earlier remembered one.
 */
export function saveSession(
  offer: RemoteOffer,
  password: string,
  remember: boolean,
  local: GetSet | null = browserStorage("localStorage"),
  tab: GetSet | null = browserStorage("sessionStorage"),
): void {
  if (!local) throw new Error("remote: this browser has no localStorage");
  local.setItem(REMOTE_SESSION_KEY, JSON.stringify(sessionFor(offer)));
  safe(() => local.removeItem(REMOTE_PASSWORD_KEY), undefined);
  safe(() => tab?.removeItem(REMOTE_TAB_PASSWORD_KEY), undefined);
  if (!password) return;
  if (remember) local.setItem(REMOTE_PASSWORD_KEY, password);
  else tab?.setItem(REMOTE_TAB_PASSWORD_KEY, password);
}

/** Remembered password first, then this tab's. Empty string when none. */
export function readPassword(local: Get | null = browserStorage("localStorage"), tab: Get | null = browserStorage("sessionStorage")): string {
  return safe(() => local?.getItem(REMOTE_PASSWORD_KEY), null) || safe(() => tab?.getItem(REMOTE_TAB_PASSWORD_KEY), null) || "";
}

export function isPasswordRemembered(local: Get | null = browserStorage("localStorage")): boolean {
  return !!safe(() => local?.getItem(REMOTE_PASSWORD_KEY), null);
}

/** Forget this device: offer + both passwords. */
export function clearSession(local: GetSet | null = browserStorage("localStorage"), tab: GetSet | null = browserStorage("sessionStorage")): void {
  for (const k of [REMOTE_SESSION_KEY, REMOTE_PASSWORD_KEY]) safe(() => local?.removeItem(k), undefined);
  safe(() => tab?.removeItem(REMOTE_TAB_PASSWORD_KEY), undefined);
}

/** Drops a stale password after an auth failure (the offer stays) and leaves a note for the pairing screen. */
export function noteAuthFailure(kind: RemoteErrorKind, local: GetSet | null = browserStorage("localStorage"), tab: GetSet | null = browserStorage("sessionStorage")): void {
  safe(() => local?.removeItem(REMOTE_PASSWORD_KEY), undefined);
  safe(() => tab?.removeItem(REMOTE_TAB_PASSWORD_KEY), undefined);
  safe(() => tab?.setItem(REMOTE_AUTH_NOTE_KEY, kind), undefined);
}

/** The note noteAuthFailure left, without clearing it. */
export function peekAuthNote(tab: Get | null = browserStorage("sessionStorage")): RemoteErrorKind | null {
  const v = safe(() => tab?.getItem(REMOTE_AUTH_NOTE_KEY), null);
  return v === "password-required" || v === "wrong-password" ? v : null;
}

/** Remote and not ready to boot the app: no stored pairing, a new #offer= link opened, or an auth failure to fix. */
export function needsPairing(remote: boolean, hash: string, local: Get | null = browserStorage("localStorage"), tab: Get | null = browserStorage("sessionStorage")): boolean {
  return remote && (!readSession(local) || hasOfferFragment(hash) || peekAuthNote(tab) !== null);
}

/** Reads and clears the note noteAuthFailure left. */
export function takeAuthNote(tab: GetSet | null = browserStorage("sessionStorage")): RemoteErrorKind | null {
  const v = peekAuthNote(tab);
  safe(() => tab?.removeItem(REMOTE_AUTH_NOTE_KEY), undefined);
  return v;
}

/** Picks the offer link out of pasted text: a full link, `#offer=…`, or bare `offer=…`. */
export function normalizeOfferInput(input: string): string | null {
  const t = (input ?? "").trim();
  if (!t) return null;
  const i = t.indexOf("#offer=");
  if (i !== -1) return t.slice(i);
  const m = /(?:^|[?&\s])offer=(\S+)/.exec(t);
  return m ? `#offer=${m[1]}` : null;
}

/**
 * Builds the Android deep link (`vibesquad://pair#offer=…`) for a pairing offer.
 * Accepts a full `https://…/#offer=…` or `vibesquad://pair…` link, or bare `#offer=…` / `offer=…` text.
 * Returns null when no offer token is present.
 */
export function toAndroidDeepLink(offerUrlOrInput: string): string | null {
  const normalized = normalizeOfferInput(offerUrlOrInput);
  if (!normalized) return null;
  return `vibesquad://pair${normalized}`;
}

/** True when `ua` is an Android browser / WebView user-agent string (defaults to `navigator.userAgent`). */
export function isAndroidUserAgent(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  return /Android/i.test(ua || "");
}

export type OfferParse = { ok: true; offer: RemoteOffer } | { ok: false; error: RemoteError };

/** Wraps parseConnectionOfferFromUrl (injected so this file stays import-free). Never throws. */
export function parseOfferInput(input: string, parse: (url: string) => unknown): OfferParse {
  const link = normalizeOfferInput(input);
  if (!link) return { ok: false, error: remoteError("bad-link", "That doesn't look like a pairing link (no #offer= part).") };
  let offer: unknown;
  try {
    offer = parse(link);
  } catch (e) {
    safe(() => console.warn("remote: pairing link rejected:", (e as Error)?.message ?? e), undefined);
    return { ok: false, error: remoteError("bad-link", "The pairing link is damaged or from an unsupported Paseo version.") };
  }
  if (!isOffer(offer)) return { ok: false, error: remoteError("bad-link", "The pairing link is damaged or from an unsupported Paseo version.") };
  return { ok: true, offer };
}

/** Relay connection parts. useTls defaults on for port 443 / the hosted relay, like Paseo's own client. */
export function relayParts(offer: RemoteOffer): { endpoint: string; useTls: boolean; serverId: string } {
  const ep = offer.relay.endpoint;
  const useTls = offer.relay.useTls ?? (/:443$/.test(ep) || /(^|\.)paseo\.sh(:\d+)?$/.test(ep));
  return { endpoint: ep, useTls, serverId: offer.serverId };
}

export type RemoteErrorKind = "bad-link" | "relay-unreachable" | "password-required" | "wrong-password" | "remote-off" | "timeout" | "unknown";
export type RemoteError = { kind: RemoteErrorKind; message: string };

const MESSAGES: Record<RemoteErrorKind, string> = {
  "bad-link": "That pairing link isn't valid.",
  "relay-unreachable": "Couldn't reach your PC through the relay. Check this device's connection and that the Paseo daemon is running at home with relay on.",
  "password-required": "Your daemon needs a password. Enter it and connect again.",
  "wrong-password": "Wrong daemon password.",
  "remote-off": 'Connected, but VibeSquad remote access is off on the PC. Set "remote": { "enabled": true } in ~/.vibesquad/settings.json there.',
  timeout: "Timed out waiting for your PC. The daemon may be offline or the relay slow; try again.",
  unknown: "Something went wrong connecting to your PC.",
};

export function remoteError(kind: RemoteErrorKind, message = MESSAGES[kind]): RemoteError {
  return { kind, message };
}

/** Maps whatever a relay connect / vs.http probe threw to a user-facing error. */
export function mapRemoteError(err: unknown): RemoteError {
  const e = err as { name?: string; reason?: string; message?: string; code?: string } | null;
  const reason = e && typeof e === "object" ? e.reason : undefined;
  const msg = String((e && typeof e === "object" ? e.message : err) ?? "");
  if (reason === "password_required" || /password required/i.test(msg)) return remoteError("password-required");
  if (reason === "incorrect_password" || /incorrect password/i.test(msg)) return remoteError("wrong-password");
  if (/remote access is off/i.test(msg)) return remoteError("remote-off");
  if (e?.name === "TimeoutError" || /timed? ?out/i.test(msg)) return remoteError("timeout");
  if (/plugin.*(not found|unknown|not installed)|unknown plugin|no such (plugin|rpc)/i.test(msg)) {
    return remoteError("unknown", "Connected, but the VibeSquad plugin isn't loaded in the daemon on your PC.");
  }
  if (/websocket|transport|disconnect|closed|network|ECONN|ENOTFOUND|failed to fetch|security|handshake|relay/i.test(msg)) {
    return remoteError("relay-unreachable");
  }
  return remoteError("unknown", msg ? `${MESSAGES.unknown} (${msg})` : MESSAGES.unknown);
}
