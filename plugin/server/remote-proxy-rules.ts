// Pure rules for the vs.http remote proxy (PLAN_PASEO_PARITY.md block R2-1): path normalisation,
// allowlist, method filter and size caps. No imports, so node --test can load it directly.
//
// Deny by default. A path must normalise cleanly AND be listed in ALLOW below; BLOCKED is checked first
// and wins even if someone later adds an overlapping ALLOW entry.

export const REMOTE_MAX_BODY_BYTES = 512 * 1024; // request and response bodies; relay frames allow 32 MiB
export const REMOTE_TIMEOUT_MS = 10_000;
export const REMOTE_MAX_PATH_CHARS = 2048;
export const REMOTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

const READ: readonly RemoteMethod[] = ["GET"];
const ANY: readonly RemoteMethod[] = REMOTE_METHODS;

/** Exact pathnames the remote UI may reach, with the methods allowed on each. */
export const REMOTE_ALLOW: Readonly<Record<string, readonly RemoteMethod[]>> = {
  "/api/health": READ,
  "/__vibesquad/health": READ,
  "/api/auth/status": READ,
  "/__vibesquad/auth/status": READ,
  "/api/teams": ANY,
  "/__vibesquad/teams": ANY,
  // GET only: POST can flip lanEnabled (LAN exposure) and push events.
  "/__vibesquad/settings": READ,
  "/__vibesquad/log": ANY,
  "/__vibesquad/vs-log": ANY,
  "/__vibesquad/handoff": ANY,
  "/__vibesquad/brainstorm-summary": ANY,
  "/__vibesquad/brainstorm-restart": ANY,
  "/__vibesquad/lead-handoff": ANY,
  "/__vibesquad/lead-handoff/confirm": ANY,
  "/__vibesquad/inbox": ANY,
  "/__vibesquad/inbox/triage": ANY,
  "/__vibesquad/inbox/open-topic": ANY,
  "/__vibesquad/inbox/park-topic": ANY,
  "/__vibesquad/inbox/handoff-topic": ANY,
  "/__vibesquad/profiles": READ,
  "/__vibesquad/profiles/diff": READ,
  "/__vibesquad/workspace-package-scripts": READ,
  "/__vibesquad/paseo/status": READ,
  "/__vibesquad/paseo/providers": READ,
  "/__vibesquad/paseo/providers/models": READ,
  "/__vibesquad/paseo/providers/diagnostic": READ,
  "/__vibesquad/paseo/usage": READ,
  // GET only: POST installs/enables plugins and patches daemon config.
  "/__vibesquad/paseo/plugins": READ,
  "/__vibesquad/paseo/surface": READ,
};

/** Never proxied, whatever ALLOW says. Entries ending in "*" are prefixes. */
export const REMOTE_BLOCKED: readonly string[] = [
  "/__vibesquad/first-run*",
  "/__vibesquad/paseo/daemon*",
  "/__vibesquad/paseo/raw*",
  "/__vibesquad/paseo/pair*", // returns the relay pairing offer, i.e. the secret
  "/__vibesquad/paseo/hub*", // connects the daemon to an external hub origin
  "/__vibesquad/pair*",
  "/pair*",
  "/__vibesquad/push*",
  "/__vibesquad/devices*",
  "/__vibesquad/local-image*",
  "/__vibesquad/local-login*",
  "/__vibesquad/remove-team-worktrees*",
  "/__vibesquad/desktop*",
  "/__vibesquad/attach*", // copies arbitrary local files into a workspace
  "/__vibesquad/profiles/import*",
  "/VibeSquad-setup.exe",
  "/ca.crt",
];

export type ProxyDecision =
  | { ok: true; method: RemoteMethod; pathname: string; search: string }
  | { ok: false; code: "method" | "path" | "blocked" | "not-allowed"; error: string };

const PATH_CHARS = /^\/[A-Za-z0-9/_.-]*$/;
const QUERY_CHARS = /^[A-Za-z0-9_.~!$&'()*+,;=:@/?%-]*$/;

export function isBlockedPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return REMOTE_BLOCKED.some((b) => {
    const rule = b.toLowerCase();
    return rule.endsWith("*") ? p.startsWith(rule.slice(0, -1)) : p === rule;
  });
}

/**
 * Splits and checks a caller-supplied path. Rejects absolute or scheme-relative URLs, backslashes,
 * any percent-encoding in the pathname (so no encoded traversal), dot segments, empty segments and
 * control characters. The query string is kept verbatim but limited to URL-safe characters.
 */
export function normalizeProxyPath(raw: unknown): { ok: true; pathname: string; search: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw) return { ok: false, error: "path must be a non-empty string" };
  if (raw.length > REMOTE_MAX_PATH_CHARS) return { ok: false, error: "path too long" };
  if (raw[0] !== "/" || raw.startsWith("//")) return { ok: false, error: "path must be origin-relative" };
  if (raw.includes("#")) return { ok: false, error: "fragments are not allowed" };
  const q = raw.indexOf("?");
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  if (!PATH_CHARS.test(pathname)) return { ok: false, error: "path has disallowed characters" };
  const segs = pathname.split("/").slice(1);
  if (segs.some((s, i) => s === "." || s === ".." || (s === "" && i !== segs.length - 1))) {
    return { ok: false, error: "path traversal is not allowed" };
  }
  if (!QUERY_CHARS.test(query)) return { ok: false, error: "query has disallowed characters" };
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) return { ok: false, error: "query has bad percent-encoding" };
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return { ok: true, pathname: trimmed, search: query ? `?${query}` : "" };
}

/** Full decision for one request: method filter, normalisation, blocklist, allowlist. */
export function decideProxyRequest(method: unknown, path: unknown): ProxyDecision {
  const m = typeof method === "string" ? method.toUpperCase() : "";
  if (!(REMOTE_METHODS as readonly string[]).includes(m)) {
    return { ok: false, code: "method", error: `method not allowed: ${String(method)}` };
  }
  const norm = normalizeProxyPath(path);
  if (!norm.ok) return { ok: false, code: "path", error: norm.error };
  if (isBlockedPath(norm.pathname)) return { ok: false, code: "blocked", error: `blocked remotely: ${norm.pathname}` };
  const allowed = Object.hasOwn(REMOTE_ALLOW, norm.pathname) ? REMOTE_ALLOW[norm.pathname] : undefined;
  if (!allowed) return { ok: false, code: "not-allowed", error: `not available remotely: ${norm.pathname}` };
  if (!allowed.includes(m as RemoteMethod)) {
    return { ok: false, code: "method", error: `${m} not available remotely on ${norm.pathname}` };
  }
  return { ok: true, method: m as RemoteMethod, pathname: norm.pathname, search: norm.search };
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Response headers passed back to the browser. Everything else (set-cookie, location, ...) is dropped. */
export const REMOTE_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"] as const;

export function isTextContentType(ct: string | null | undefined): boolean {
  if (!ct) return true; // empty bodies (204, 405 res.end()) carry no type
  const t = ct.split(";")[0].trim().toLowerCase();
  return t.startsWith("text/") || t === "application/json" || t.endsWith("+json");
}
