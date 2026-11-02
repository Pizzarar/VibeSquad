// Per-install loopback secret (~/.vibesquad/local-token). The server creates it; local clients (vs CLI,
// Paseo plugins, the desktop proxy) read it and send it as `x-vibesquad-token`. Node built-ins only, so a
// client can import this file or copy readLocalToken() as-is.
import { randomBytes } from "node:crypto";
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
  const raced = readLocalToken(file);
  if (raced) return raced;
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
