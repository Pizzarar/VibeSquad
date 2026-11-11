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

/** Headers to add to a request to the local VS server; empty when there is no token (an old server ignores the header). */
export function localTokenHeaders(file = localTokenPath()) {
  const t = readLocalToken(file);
  return t ? { [LOCAL_TOKEN_HEADER]: t } : {};
}

/**
 * Asks a running local server for a single-use login URL (POST /__vibesquad/local-login/nonce with the header
 * token). The URL carries a ~60 s nonce, never the master token, so it is safe on a browser command line.
 */
export async function requestLocalLoginUrl({ port = Number(process.env.VIBESQUAD_PORT || 4180), file = localTokenPath(), timeoutMs = 5000 } = {}) {
  const token = readLocalToken(file);
  if (!token) throw new Error(`no local token at ${file}; start the VibeSquad server once to create it`);
  const res = await fetch(`http://127.0.0.1:${port}/__vibesquad/local-login/nonce`, {
    method: "POST",
    headers: { [LOCAL_TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(timeoutMs),
  });
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
    throw new Error(`no VibeSquad server on 127.0.0.1:${port} (${e?.cause?.code ?? e?.name ?? e}); start it first (or set VIBESQUAD_PORT)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body?.proof !== "string") throw new Error(`the listener on 127.0.0.1:${port} did not prove it is this install's VibeSquad server (${res.status}); the local token was not sent`);
  const want = createHmac("sha256", token).update(`vs-local-proof\0${nonce}\0${port}`).digest();
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(body.proof) ? body.proof : "00", "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error(`the listener on 127.0.0.1:${port} failed the local-token proof; the local token was not sent`);
  return true;
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
