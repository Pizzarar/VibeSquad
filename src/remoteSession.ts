// Remote boot (Android APK, PLAN_ANDROID_MESHNET.md block A1): pure logic for the remote build, which pairs with
// a PC over VS-native LAN/Meshnet (the 6-digit code / QR that PairDeviceModal shows). The server redeems
// `https://<host>:<port>/pair?code=…` and sets the vs_device cookie, exactly as for the paired-PC browser; the
// app then opens the server's own UI. No imports: the screen is src/RemotePairScreen.tsx and node tests use fakes.

/** The stored pairing: which server this device paired with. The device cookie itself lives in the WebView. */
export type StoredRemoteSession = { v: 2; host: string; savedAt: string };

/** What a QR, deep link or typed input resolves to. `code` is empty for a host-only input, `host` for a code-only one. */
export type PairTarget = { host: string; code: string };

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
  if (code) return { host: "", code };
  const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? safe(() => new URL(t), null) : null;
  if (u && /^https?:$/.test(u.protocol)) {
    const host = normalizeHost(u.host);
    return host ? { host, code: normalizeCode(u.searchParams.get("code") ?? "") ?? "" } : null;
  }
  if (u && u.protocol === `${DEEP_LINK_SCHEME}:`) {
    const host = normalizeHost(u.searchParams.get("host") ?? "");
    return host ? { host, code: normalizeCode(u.searchParams.get("code") ?? "") ?? "" } : null;
  }
  if (u) return null;
  const host = normalizeHost(t);
  return host ? { host, code: "" } : null;
}

/** The deep link (`vibesquad://pair?host=…&code=…`) equivalent of a pairing QR / link; null when it has no host. */
export function toAndroidDeepLink(input: string): string | null {
  const p = parsePairInput(input);
  if (!p?.host) return null;
  const q = new URLSearchParams({ host: p.host, ...(p.code ? { code: p.code } : {}) });
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
  return `https://${host}/${appOrigin ? `?${new URLSearchParams({ vs_app: appOrigin }).toString()}` : ""}`;
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

/** The stored pairing, or null when missing or malformed (an old relay-offer session is not trusted). */
export function readSession(storage: Get | null = browserStorage("localStorage")): StoredRemoteSession | null {
  if (!storage) return null;
  const raw = safe(() => storage.getItem(REMOTE_SESSION_KEY), null);
  if (!raw) return null;
  const s = safe(() => JSON.parse(raw), null);
  if (!s || s.v !== 2 || typeof s.host !== "string" || typeof s.savedAt !== "string" || !normalizeHost(s.host)) return null;
  return { v: 2, host: s.host, savedAt: s.savedAt };
}

export function saveSession(host: string, local: GetSet | null = browserStorage("localStorage"), now = new Date()): void {
  if (!local) throw new Error("remote: this browser has no localStorage");
  const h = normalizeHost(host);
  if (!h) throw new Error("remote: not a valid server address");
  local.setItem(REMOTE_SESSION_KEY, JSON.stringify({ v: 2, host: h, savedAt: now.toISOString() } satisfies StoredRemoteSession));
}

/** Forget this device's pairing (the server still lists the device until it is revoked on the PC). */
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

const MESSAGES: Record<RemoteErrorKind, string> = {
  "bad-input": "Enter the server address and the 6-digit code from Pair a device on your PC, or scan its QR code.",
  unreachable:
    "Couldn't reach your PC. Check this phone is on the same Wi-Fi (Home LAN) or on NordVPN Meshnet, that VibeSquad is running there, and that you installed its CA certificate.",
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
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out/i.test(msg)) return remoteError("timeout");
  if (/failed to fetch|network|load failed|ECONN|ENOTFOUND|certificate|ssl|tls/i.test(msg)) return remoteError("unreachable");
  return remoteError("unknown", msg ? `${MESSAGES.unknown} (${msg})` : MESSAGES.unknown);
}
