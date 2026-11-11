// Per-install loopback secret (~/.vibesquad/local-token). The server creates it; local clients (vs CLI,
// Paseo plugins, the desktop proxy) read it and send it as `x-vibesquad-token`. Node built-ins only, so a
// client can import this file or copy readLocalToken() as-is.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
export async function requestLocalLoginUrl({ port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(), fetchImpl = fetch, timeoutMs = 5000 } = {}) {
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
    res = await fetchImpl(`http://127.0.0.1:${port}/__vibesquad/local-proof?c=${nonce}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
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
 * The one way in-repo code sends the master token to the local server (E4b follow-up: X1 E4a L3 for every caller, not
 * just `vs pair`): proveLocalServer() first, then `fetchImpl` of http://127.0.0.1:port + path with the x-vibesquad-token
 * header added to `headers`. A failed proof throws (`proofFailed`) and the token never leaves the process; a listener
 * that cannot be reached throws (`unreachable`) with the same message the proof step uses, so callers need no
 * try/catch of their own. No token on disk throws, unless `tokenOptional` (the MCP callers predate the token and keep
 * sending the bare request; there is no secret to protect then).
 *
 * Deliberately no proof cache. Each token-bearing request is one human-paced action (open, pair, sweep, handoff,
 * Buddy restart), so the extra loopback GET costs about a millisecond and a CLI process makes one such request anyway.
 * The MCP server process lives for hours: a per-process cache would hand the token to a rogue that grabs the port
 * after the real server restarts (threat note P4) on the next handoff. A fresh proof per request keeps that closed.
 */
export async function fetchWithLocalToken(
  path,
  { method = "GET", headers = {}, body, port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(), fetchImpl = fetch, timeoutMs = 5000, proofTimeoutMs = 5000, tokenOptional = false } = {},
) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("fetchWithLocalToken: path must start with /");
  const token = readLocalToken(file);
  if (!token && !tokenOptional) throw new Error(`no local token at ${file}; start the VibeSquad server once to create it`);
  if (token) await proveLocalServer({ port, token, fetchImpl, timeoutMs: proofTimeoutMs });
  try {
    return await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: token ? { ...headers, [LOCAL_TOKEN_HEADER]: token } : { ...headers },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw unreachableError(port, e);
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
