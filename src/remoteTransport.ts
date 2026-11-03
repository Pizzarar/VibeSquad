// Remote mode fetch shim (PLAN_PASEO_PARITY.md block R2-1). When the UI runs away from the PC, same-origin
// /__vibesquad/* and /api/* calls go through the `vibesquad` plugin's vs.http RPC over the Paseo daemon
// connection instead of HTTP. Everything else passes through. Never installed in normal mode.
// The allowlist lives server-side (plugin/server/remote-proxy-rules.ts); this file only routes.
// No imports: main.tsx passes the daemonClient-backed invoke, and node tests pass a fake.

export type VsHttpRequest = { method: string; path: string; body?: string };
export type VsHttpResponse = { status: number; headers: Record<string, string>; body: string };
export type VsHttpInvoke = (input: VsHttpRequest) => Promise<unknown>;

export const REMOTE_FLAG_KEY = "vs.remote";
export const MAX_REMOTE_REQ_BODY_BYTES = 256 * 1024;

const STATUS_TAIL = /\[(\d{3})\](?:\s+\w+=\S+)*\s*$/;

/** Plain-English message for a vs.http rejection: strips Paseo's DaemonRpcError wrapping, keeps `[status]`. */
export function formatRemoteRpcError(err: unknown): string {
  const raw = String((err && typeof err === "object" ? (err as { message?: unknown }).message : err) ?? "");
  const msg = raw.replace(/^\s*DaemonRpcError:\s*/, "").replace(/^Request failed:\s*/, "");
  const m = STATUS_TAIL.exec(msg);
  const status = m ? m[1] : "";
  if (/vs\.http:\s*(?:[A-Z]+\s+)?not available remotely/i.test(msg)) {
    return `Starting Buddies and handoffs only works on the host PC [${status || "403"}]`;
  }
  return msg.replace(/(\s+(?:requestType|code)=\S+)+\s*$/, "").trim();
}

export function errorToRemoteResponse(err: unknown): Response | null {
  const raw = String((err && typeof err === "object" ? (err as { message?: unknown }).message : err) ?? "");
  if (!raw) return null;
  const m = STATUS_TAIL.exec(raw);
  const status = m ? Number(m[1]) : /vs\.http:\s*remote access is off/i.test(raw) ? 403 : 0;
  if (status >= 400 && status <= 599) {
    return new Response(JSON.stringify({ ok: false, error: formatRemoteRpcError(err) }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

/** Remote mode flag. A later boot block will set it; for now `?remote=1` or localStorage `vs.remote=1`. */
export function isRemoteMode(loc: { search: string } = location, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (new URLSearchParams(loc.search).get("remote") === "1") return true;
  try {
    return storage?.getItem(REMOTE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The origin-relative path to proxy, or null when the request must pass through untouched. */
export function proxiedPath(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (!u.pathname.startsWith("/__vibesquad/") && !u.pathname.startsWith("/api/")) return null;
  return u.pathname + u.search;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function toResponse(out: unknown): Response {
  const r = out as VsHttpResponse;
  if (!r || typeof r.status !== "number" || typeof r.body !== "string") throw new TypeError("remote: bad vs.http response");
  const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
  return new Response(NULL_BODY_STATUS.has(status) ? null : r.body, { status, headers: r.headers ?? {} });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Wraps `target.fetch`. Returns an uninstall function that restores the original. */
export function installRemoteTransport(invoke: VsHttpInvoke, target: { fetch: typeof fetch; location: { origin: string } } = window): () => void {
  const original = target.fetch;
  const bound = original.bind(target);
  const shim: typeof fetch = async (input, init) => {
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? (input as Request).url : String(input);
    const path = proxiedPath(url, target.location.origin);
    if (path === null) return bound(input, init);
    const signal = init?.signal ?? (isReq ? (input as Request).signal : undefined);
    if (signal?.aborted) throw abortError();
    const method = (init?.method ?? (isReq ? (input as Request).method : "GET")).toUpperCase();
    let body: string | undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string") throw new TypeError("remote mode: only string request bodies are supported");
      body = init.body;
    } else if (isReq && method !== "GET" && method !== "HEAD") {
      body = await (input as Request).text();
    }
    if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_REMOTE_REQ_BODY_BYTES) {
      return new Response(
        JSON.stringify({ ok: false, error: "PayloadTooLarge: request body exceeds 256 KiB limit" }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    }
    let out: unknown;
    try {
      const call = invoke({ method, path, ...(body !== undefined && body !== "" ? { body } : {}) });
      out = signal
        ? await Promise.race([
            call,
            new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
          ])
        : await call;
    } catch (err) {
      if (signal?.aborted || (err as any)?.name === "AbortError") throw err;
      const mapped = errorToRemoteResponse(err);
      if (mapped) return mapped;
      throw err;
    }
    return toResponse(out);
  };
  target.fetch = shim;
  return () => {
    if (target.fetch === shim) target.fetch = original;
  };
}
