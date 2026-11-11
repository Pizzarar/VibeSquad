// Per-install loopback secret (~/.vibesquad/local-token). The server creates it; local clients (vs CLI,
// Paseo plugins, the desktop proxy) read it and send it as `x-vibesquad-token`. Node built-ins only, so a
// client can import this file or copy readLocalToken() as-is.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_TOKEN_HEADER = "x-vibesquad-token";
export const LOCAL_TOKEN_FILE = "local-token";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export const localTokenPath = (home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad")) => join(home, LOCAL_TOKEN_FILE);

/** The token, or null when the file is missing or malformed (server not started yet). */
export function readLocalToken(file = localTokenPath()) {
  try {
    const t = readFileSync(file, "utf8").trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Headers to add to a request to the local VS server; empty when there is no token (an old server ignores the header).
 * For out-of-repo clients that copy this file. In-repo callers (cli/, server/) go through fetchWithLocalToken() instead,
 * so the listener proves it holds the token before the header goes out (test/sec-prove-local.test.mjs pins this).
 */
export function localTokenHeaders(file = localTokenPath()) {
  const t = readLocalToken(file);
  return t ? { [LOCAL_TOKEN_HEADER]: t } : {};
}

/**
 * Asks a running local server for a single-use login URL (POST /__vibesquad/local-login/nonce with the header
 * token). The URL carries a ~60 s nonce, never the master token, so it is safe on a browser command line.
 */
export async function requestLocalLoginUrl({ port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(), fetchImpl, timeoutMs = 5000 } = {}) {
  const res = await fetchWithLocalToken("/__vibesquad/local-login/nonce", { method: "POST", port, file, fetchImpl, timeoutMs });
  if (!res.ok) throw new Error(`VibeSquad server on port ${port} refused a login nonce (${res.status}); is it running this version?`);
  const { path } = await res.json();
  if (typeof path !== "string" || !path.startsWith("/__vibesquad/local-login?t=")) throw new Error("unexpected nonce response");
  return `http://localhost:${port}${path}`;
}

/**
 * X1 E4a L3: before a CLI sends the master token to 127.0.0.1:port, make whatever listens there prove it already holds
 * the token. Sends a fresh 128-bit nonce to GET /__vibesquad/local-proof?c=, expects HMAC-SHA256(token, "vs-local-proof"
 * \0 nonce \0 port) back; the port in the MAC is the server's accepted-socket port, so a rogue listener on this port can't
 * relay the challenge to a real server elsewhere. Resolves true on a valid proof; throws with a plain reason otherwise.
 */
export async function proveLocalServer({ port = Number(process.env.VIBESQUAD_PORT || 4180), token, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!token) throw new Error("no local token to verify against");
  const nonce = randomBytes(16).toString("hex");
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/__vibesquad/local-proof?c=${nonce}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw unreachableError(port, e);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body?.proof !== "string") throw proofError(`the listener on 127.0.0.1:${port} did not prove it is this install's VibeSquad server (${res.status}); the local token was not sent`);
  const want = createHmac("sha256", token).update(`vs-local-proof\0${nonce}\0${port}`).digest();
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(body.proof) ? body.proof : "00", "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw proofError(`the listener on 127.0.0.1:${port} failed the local-token proof; the local token was not sent`);
  return true;
}

/** Nothing answered (or the socket broke): `unreachable` lets a caller fall back to an in-process path. */
const unreachableError = (port, e) =>
  Object.assign(new Error(`no VibeSquad server on 127.0.0.1:${port} (${e?.cause?.code ?? e?.name ?? e}); start it first (or set VIBESQUAD_PORT)`), { unreachable: true });
/** Something answered but is not this install's server: `proofFailed` must never be mistaken for "server down". */
const proofError = (message) => Object.assign(new Error(message), { proofFailed: true });

/**
 * X1 prove-local L1: a fetch-shaped client that owns exactly one TCP connection for its lifetime. The proof and the
 * token request both ride it, so the proof means "this socket", not "whatever bound this port a millisecond ago": an
 * established loopback socket cannot be taken over by a later bind. If the proven socket is gone when the token request
 * is queued (the listener closed it), the agent refuses to dial again and the request fails `proofFailed` before any
 * header is written. node:http only (no undici dependency); never follows a redirect, so a 3xx cannot forward the header.
 * Responses expose the subset the callers use: ok, status, headers, json(), text(). close() drops the socket.
 */
export function singleConnectionClient(port, host = "127.0.0.1") {
  let dialed = false;
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  agent.createConnection = (options, cb) => {
    if (dialed) {
      cb(proofError(`the proven connection to ${host}:${port} closed before the request; the local token was not sent`));
      return undefined;
    }
    dialed = true;
    return createConnection({ ...options, host, port });
  };
  const fetchLike = (url, { method = "GET", headers = {}, body, signal } = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      if (u.hostname !== host || Number(u.port) !== port) return reject(new Error(`singleConnectionClient: ${url} is not ${host}:${port}`));
      const req = httpRequest({ host, port, path: u.pathname + u.search, method, headers, agent, signal }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { fetch: fetchLike, close: () => agent.destroy(), get dialed() { return dialed; } };
}

/**
 * The one way in-repo code sends the master token to the local server (E4b follow-up: X1 E4a L3 for every caller, not
 * just `vs pair`): proveLocalServer() first, then http://127.0.0.1:port + path with the x-vibesquad-token header added
 * to `headers`, both on one TCP connection (singleConnectionClient, L1). A failed proof throws (`proofFailed`) and the
 * token never leaves the process; a listener that cannot be reached throws (`unreachable`) with the same message the
 * proof step uses, so callers need no try/catch of their own. No token on disk throws, unless `tokenOptional` (the MCP
 * callers predate the token and keep sending the bare request; there is no secret to protect then). `fetchImpl` is a
 * test seam only: with one injected, the two requests are plain calls to it and no socket binding is possible.
 * `redirect: "error"` on both requests: Node's fetch would otherwise follow a 3xx and forward the header.
 *
 * Deliberately no proof cache. Each token-bearing request is one human-paced action (open, pair, sweep, handoff,
 * Buddy restart), so the extra loopback GET costs about a millisecond and a CLI process makes one such request anyway.
 * The MCP server process lives for hours: a per-process cache would hand the token to a rogue that grabs the port
 * after the real server restarts (threat note P4) on the next handoff. A fresh proof per request keeps that closed.
 */
export async function fetchWithLocalToken(
  path,
  { method = "GET", headers = {}, body, port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(), fetchImpl, timeoutMs = 5000, proofTimeoutMs = 5000, tokenOptional = false } = {},
) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("fetchWithLocalToken: path must start with /");
  const token = readLocalToken(file);
  if (!token && !tokenOptional) throw new Error(`no local token at ${file}; start the VibeSquad server once to create it`);
  const client = fetchImpl ? null : singleConnectionClient(port);
  const doFetch = fetchImpl ?? client.fetch;
  try {
    if (token) await proveLocalServer({ port, token, fetchImpl: doFetch, timeoutMs: proofTimeoutMs });
    try {
      return await doFetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: token ? { ...headers, [LOCAL_TOKEN_HEADER]: token } : { ...headers },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e?.proofFailed) throw e;
      throw unreachableError(port, e);
    }
  } finally {
    client?.close();
  }
}

/** Reads the token, creating it (32 random bytes, hex, mode 0o600) when missing or malformed. */
export function ensureLocalToken(file = localTokenPath()) {
  const existing = readLocalToken(file);
  if (existing) return existing;
  mkdirSync(join(file, ".."), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    // Exclusive create: two servers starting at once agree on whichever file landed first.
    writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
  }
  // Another process just created it and may still be writing: give it ~100 ms before calling it malformed.
  for (let i = 0; i < 5; i++) {
    const raced = readLocalToken(file);
    if (raced) return raced;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  // A malformed file: replace it whole.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return token;
}
