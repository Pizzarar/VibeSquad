// E5 relay pairing links (docs/lanes/android-app/E5_THREAT_MODEL.md §7 item 8). Pure: no I/O, no auth, so both
// auth.mjs (POST /__vibesquad/pair/start builds the link + QR) and the tests can import it without the tunnel.
//
// Shape: `<base>#hostId=<self-certifying id>&pub=<host X25519 pub, base64url>&relay=<wss origin+path>&code=<6 digits>`.
// Everything lives in the FRAGMENT: a browser never sends it to the relay or any server, so a link pasted into the
// wrong place leaks no code to a server log (the client strips it from history on load, remoteRelayTransport.ts
// takePairingFragment). `relay=` is the public endpoint only (publicRelayEndpoint): never userinfo, query or fragment
// of the dial URL (X1 wire L1), so a per-host relay secret in settings.json never rides along in a link.

/** The APK deep link that carries a relay pairing fragment (src/remoteRelayConnect.ts parses it). */
export const RELAY_LINK_BASE = "vibesquad://pair";

const HOST_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const CODE_RE = /^\d{6}$/;

/** The endpoint as it may be shown, logged or put in a link: scheme, host, port and path; userinfo, query and fragment removed (X1 wire L1). */
export function publicRelayEndpoint(endpoint) {
  const u = new URL(endpoint);
  return `${u.origin}${u.pathname}`;
}

/** base64 / base64url -> base64url without padding, or "" unless it decodes to exactly 32 bytes. */
export function relayPubForLink(pub) {
  const s = String(pub ?? "").trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return "";
  const raw = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length !== 32) return "";
  return raw.toString("base64url");
}

/**
 * Builds the link, or returns null when any part is unusable (not a wss:// relay, bad id, bad key, non 6-digit code).
 * The caller decides whether the relay is actually running; this only formats.
 */
export function buildRelayPairingLink({ base = RELAY_LINK_BASE, hostId, pub, relay, code }) {
  const id = String(hostId ?? "").trim();
  const key = relayPubForLink(pub);
  const c = String(code ?? "").trim();
  if (!HOST_ID_RE.test(id) || !key || !CODE_RE.test(c)) return null;
  let endpoint = "";
  try {
    endpoint = /^wss:\/\//i.test(String(relay ?? "")) ? publicRelayEndpoint(String(relay)) : "";
  } catch {
    endpoint = "";
  }
  if (!endpoint.startsWith("wss://")) return null;
  const b = String(base ?? RELAY_LINK_BASE).trim();
  if (!b || b.includes("#")) return null; // one fragment only
  const q = new URLSearchParams({ hostId: id, pub: key, relay: endpoint, code: c });
  return `${b}#${q.toString()}`;
}
