// Pure rules for the vs.http remote proxy (PLAN_PASEO_PARITY.md block R2-1): path normalisation,
// allowlist, method filter, size caps, rate limits and response redaction. No imports, so node --test
// can load it directly.
//
// Deny by default. A path must normalise cleanly AND be listed in REMOTE_ALLOW; REMOTE_BLOCKED is checked
// first and wins even if someone later adds an overlapping ALLOW entry.
//
// GET-ONLY UNTIL SECURITY S4 (hub lane: sanitizeBody on every handler + cwd validation). The R2-1 security
// cross-review showed the write handlers let a link-holder spawn auto-mode agents in a chosen cwd
// (inbox/open-topic, lead-handoff), inject DI keys (baseHome, profilesPath) on the inbox handlers, write
// persistent prompt injection into briefs (brainstorm-summary POST) and mass-archive agents.
// Once S4 lands, reopen by copying entries from REMOTE_WRITES_AFTER_S4 into REMOTE_ALLOW, each with a
// per-endpoint body-key allowlist:
//   allowed body keys: cardId, agentId, laneId, teamId, text
//   never allowed:     cwd, provider, model, profile, profilesPath, baseHome, labels, title,
//                      pendingPrompt, summaryUpdate (also skipDaemon, daemonClient, forceNew)
// /__vibesquad/handoff POST stays closed for good: it blocks the VS server event loop for up to 60 s
// (execFileSync), and the proxy timeout can't cancel it.

export const REMOTE_MAX_BODY_BYTES = 512 * 1024; // request and response bodies; relay frames allow 32 MiB
export const REMOTE_TIMEOUT_MS = 10_000;
export const REMOTE_MAX_PATH_CHARS = 2048;
export const REMOTE_MAX_IN_FLIGHT = 4;
export const REMOTE_WINDOW_MS = 60_000;
export const REMOTE_BUDGET_PER_MIN = { read: 120, write: 20 } as const;
export const REMOTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];
export type AllowMap = Readonly<Record<string, readonly RemoteMethod[]>>;

const READ: readonly RemoteMethod[] = ["GET"];

/** Exact pathnames the remote UI may reach, with the methods allowed on each. All GET until S4. */
export const REMOTE_ALLOW: AllowMap = {
  "/api/health": READ,
  "/__vibesquad/health": READ,
  "/api/auth/status": READ,
  "/__vibesquad/auth/status": READ,
  "/api/teams": READ,
  "/__vibesquad/teams": READ,
  "/__vibesquad/settings": READ, // `remote` is dropped from the response
  "/__vibesquad/log": READ,
  "/__vibesquad/vs-log": READ,
  "/__vibesquad/handoff": READ, // "does the packet exist?" (path redacted)
  "/__vibesquad/brainstorm-summary": READ,
  "/__vibesquad/inbox": READ,
  "/__vibesquad/profiles": READ,
  "/__vibesquad/profiles/diff": READ,
  "/__vibesquad/workspace-package-scripts": READ,
  "/__vibesquad/paseo/status": READ,
  "/__vibesquad/paseo/providers": READ,
  "/__vibesquad/paseo/usage": READ, // `refresh` is stripped from the query
  "/__vibesquad/paseo/plugins": READ,
};

/** NOT ACTIVE. The methods each endpoint gets back once S4 sanitises bodies (see the header comment). */
export const REMOTE_WRITES_AFTER_S4: AllowMap = {
  "/api/teams": ["POST", "PUT"],
  "/__vibesquad/teams": ["POST", "PUT"],
  "/__vibesquad/log": ["POST"],
  "/__vibesquad/vs-log": ["POST"],
  "/__vibesquad/brainstorm-summary": ["POST", "PUT"],
  "/__vibesquad/brainstorm-restart": ["POST"],
  "/__vibesquad/lead-handoff": ["POST"],
  "/__vibesquad/lead-handoff/confirm": ["POST"],
  "/__vibesquad/inbox": ["POST"],
  "/__vibesquad/inbox/triage": ["POST"],
  "/__vibesquad/inbox/open-topic": ["POST"],
  "/__vibesquad/inbox/park-topic": ["POST"],
  "/__vibesquad/inbox/handoff-topic": ["POST"],
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
  "/__vibesquad/files*", // workspace file names (S3 gated read)
  "/__vibesquad/search*", // workspace file contents (S3 gated read)
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

/** Query params dropped remotely: `refresh=1` on usage forces provider API calls (an S3 gated read). */
const STRIP_QUERY: Readonly<Record<string, readonly string[]>> = { "/__vibesquad/paseo/usage": ["refresh"] };

function stripQuery(pathname: string, search: string): string {
  const drop = Object.hasOwn(STRIP_QUERY, pathname) ? STRIP_QUERY[pathname] : undefined;
  if (!drop || !search) return search;
  const kept = search
    .slice(1)
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const key = pair.split("=")[0];
      let name = key;
      try {
        name = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {}
      return !drop.includes(name);
    });
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Full decision for one request: method filter, normalisation, blocklist, allowlist, query strip.
 * `allow` is injectable so the write plumbing stays tested while REMOTE_ALLOW is GET-only.
 */
export function decideProxyRequest(method: unknown, path: unknown, allow: AllowMap = REMOTE_ALLOW): ProxyDecision {
  const m = typeof method === "string" ? method.toUpperCase() : "";
  if (!(REMOTE_METHODS as readonly string[]).includes(m)) {
    return { ok: false, code: "method", error: `method not allowed: ${String(method)}` };
  }
  const norm = normalizeProxyPath(path);
  if (!norm.ok) return { ok: false, code: "path", error: norm.error };
  if (isBlockedPath(norm.pathname)) return { ok: false, code: "blocked", error: `blocked remotely: ${norm.pathname}` };
  const allowed = Object.hasOwn(allow, norm.pathname) ? allow[norm.pathname] : undefined;
  if (!allowed) return { ok: false, code: "not-allowed", error: `not available remotely: ${norm.pathname}` };
  if (!allowed.includes(m as RemoteMethod)) {
    return { ok: false, code: "method", error: `${m} not available remotely on ${norm.pathname}` };
  }
  return { ok: true, method: m as RemoteMethod, pathname: norm.pathname, search: stripQuery(norm.pathname, norm.search) };
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

// ---- rate limits ------------------------------------------------------------------------------------

export type RateKind = "read" | "write";
export type RateLimiter = {
  acquire(kind: RateKind): { ok: true; release: () => void } | { ok: false; error: string };
};

/** At most `maxInFlight` concurrent requests, plus a rolling per-minute budget per kind (read/write). */
export function createRateLimiter(
  opts: { maxInFlight?: number; budget?: Record<RateKind, number>; windowMs?: number; now?: () => number } = {},
): RateLimiter {
  const maxInFlight = opts.maxInFlight ?? REMOTE_MAX_IN_FLIGHT;
  const budget = opts.budget ?? REMOTE_BUDGET_PER_MIN;
  const windowMs = opts.windowMs ?? REMOTE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const stamps: Record<RateKind, number[]> = { read: [], write: [] };
  let inFlight = 0;
  return {
    acquire(kind) {
      const t = now();
      const list = stamps[kind];
      while (list.length && list[0] <= t - windowMs) list.shift();
      if (inFlight >= maxInFlight) return { ok: false, error: `too many requests in flight (max ${maxInFlight})` };
      if (list.length >= budget[kind]) {
        const wait = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
        return { ok: false, error: `rate limited: ${budget[kind]} ${kind}s per minute, retry in ${wait} s` };
      }
      list.push(t);
      inFlight++;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (!released) inFlight--;
          released = true;
        },
      };
    },
  };
}

// ---- response redaction -----------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the owner's home directory (backslash, JSON-escaped backslash and forward-slash forms, any
 * case), then the bare username, with "~". The needles hold no quotes, so JSON bodies stay valid.
 */
export function redactBody(body: string, homeDir: string, userName: string): string {
  let out = body;
  // Keep a leading "" for POSIX homes ("/home/x") so the root separator is part of the needle.
  const parts = homeDir.replace(/[\\/]+$/, "").split(/[\\/]+/);
  if (parts.filter(Boolean).length >= 2) {
    // Longest form first: JSON-escaped "C:\\Users\\x" before raw "C:\Users\x".
    for (const sep of ["\\\\", "\\", "/"]) {
      out = out.replace(new RegExp(escapeRe(parts.join(sep)), "gi"), "~");
    }
  }
  const user = userName.trim();
  if (user.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(user)}(?![A-Za-z0-9_])`, "gi"), "~");
  return out;
}

/** Drops `remote` (the proxy gate) from GET /__vibesquad/settings responses. */
export function scrubSettingsBody(pathname: string, body: string): string {
  if (pathname !== "/__vibesquad/settings") return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "remote" in parsed) {
      delete parsed.remote;
      return JSON.stringify(parsed);
    }
  } catch {}
  return body;
}
