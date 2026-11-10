// Stable per-install host identity (PLAN_ANDROID_END_STATE.md E4a): ~/.vibesquad/host-id, created once and never
// rotated by the app. Phones key their saved hosts by it (src/remoteSession.ts v:3), and it rides along on
// /api/auth/status and the /__vibesquad/teams envelope. It is an identifier, not a secret: the unpaired status
// route hands it out, so nothing may treat knowing it as proof of anything. Node built-ins only.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOST_ID_FILE = "host-id";
// 16 random bytes, base64url: 22 chars, no padding. Older/foreign files up to 64 url-safe chars are accepted as-is.
const HOST_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

export const hostIdPath = (home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad")) => join(home, HOST_ID_FILE);

const cache = new Map(); // file -> id (keyed so a test that moves VIBESQUAD_HOME gets that home's id)

/** The id in `file`, or null when it is missing or malformed. */
export function readHostId(file = hostIdPath()) {
  try {
    const t = readFileSync(file, "utf8").trim();
    return HOST_ID_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

export const mintHostId = () => randomBytes(16).toString("base64url");

/**
 * Reads the host id, creating it on first use. Creation is atomic: an exclusive create (`wx`) means two servers
 * starting at once both end up with whichever id landed first; a malformed file is replaced via tmp + rename.
 */
export function ensureHostId(file = hostIdPath()) {
  const existing = readHostId(file);
  if (existing) return existing;
  mkdirSync(join(file, ".."), { recursive: true });
  const id = mintHostId();
  try {
    writeFileSync(file, id + "\n", { encoding: "utf8", mode: 0o644, flag: "wx" });
    return id;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
  }
  const raced = readHostId(file);
  if (raced) return raced;
  // Exists but malformed (truncated write, hand edit): replace it atomically.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, id + "\n", { encoding: "utf8", mode: 0o644 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return readHostId(file) ?? id;
}

/** The cached host id for the current VIBESQUAD_HOME (created on first call). */
export function getHostId(file = hostIdPath()) {
  let id = cache.get(file);
  if (!id) cache.set(file, (id = ensureHostId(file)));
  return id;
}

export function resetHostIdForTest() {
  cache.clear();
}
