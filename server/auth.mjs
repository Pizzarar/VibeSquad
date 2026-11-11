import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { withFileLockSync } from "./file-lock.mjs";
import { getHostId } from "./host-id.mjs";
import { ensureLocalToken, LOCAL_TOKEN_FILE, LOCAL_TOKEN_HEADER, localTokenPath } from "./local-token.mjs";
import { qrSvg } from "./qr.mjs";
import { isRelayRequest } from "./relay-tunnel.mjs";
import { resolveAndroidApkPath } from "./vibesquad-api.mjs";
import { clearConfigWarning, readJsonFileWithBom } from "./user-settings.mjs";

export const DEVICE_COOKIE = "vs_device";
const CODE_TTL_MS = 300_000;
const DEFAULT_MESHNET_IP = "";
const DEFAULT_MESHNET_HOST = "";
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DEFAULT_ROOT_DIR = resolve(import.meta.dirname, "..");

const sha256Hex = (v) => createHash("sha256").update(v).digest("hex");
const vibesquadHome = () => process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
export const tlsDir = () => join(vibesquadHome(), "tls");
const devicesFile = () => join(vibesquadHome(), "devices.json");

// ---- Network config ----

const inCgnat = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

const is192168 = (ip) => { const [a, b] = ip.split(".").map(Number); return a === 192 && b === 168; };

const isPrivateLanIpv4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};

const VIRTUAL_IFACE_RE = /vEthernet|WSL|Hyper-V|Docker|VMware|VirtualBox|NordLynx|Tailscale|ZeroTier|Loopback|TAP|TUN/i;

/** Home/office LAN IPv4: env override, else first physical RFC-1918 interface. */
export function detectLanIp() {
  if (process.env.VIBESQUAD_LAN_IP) return process.env.VIBESQUAD_LAN_IP.trim();
  const ifaces = Object.entries(networkInterfaces());
  const v4 = (list) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);

  const physical = ifaces.filter(([name]) => !VIRTUAL_IFACE_RE.test(name));
  for (const [, list] of physical) {
    const hit = v4(list).find(is192168);
    if (hit) return hit;
  }
  for (const [, list] of physical) {
    const hit = v4(list).find((ip) => !inCgnat(ip) && isPrivateLanIpv4(ip));
    if (hit) return hit;
  }
  for (const [, list] of ifaces) {
    const hit = v4(list).find(is192168);
    if (hit) return hit;
  }
  for (const [, list] of ifaces) {
    const hit = v4(list).find((ip) => !inCgnat(ip) && isPrivateLanIpv4(ip));
    if (hit) return hit;
  }
  return null;
}

/** NordVPN Meshnet IPv4: env override, else the NordLynx interface, else any 100.64.0.0/10 address. */
export function detectMeshnetIp() {
  if (process.env.VIBESQUAD_MESHNET_IP) return process.env.VIBESQUAD_MESHNET_IP;
  const ifaces = Object.entries(networkInterfaces());
  const v4 = (list) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);
  for (const [name, list] of ifaces) if (/NordLynx/i.test(name) && v4(list)[0]) return v4(list)[0];
  for (const [, list] of ifaces) {
    const hit = v4(list).find(inCgnat);
    if (hit) return hit;
  }
  return null;
}

export function netConfig() {
  return {
    port: Number(process.env.VIBESQUAD_PORT || 4180),
    meshnetIp: detectMeshnetIp(),
    meshnetHost: process.env.VIBESQUAD_MESHNET_HOST || DEFAULT_MESHNET_HOST,
    lanIp: detectLanIp(),
  };
}

export function hasDistIndex(rootDir = DEFAULT_ROOT_DIR) {
  if (existsSync(join(rootDir, "dist", "index.html"))) return true;
  if (rootDir.includes(".worktrees")) {
    const fallbackDist = resolve(rootDir, "../..", "dist", "index.html");
    if (existsSync(fallbackDist)) return true;
  }
  return false;
}

/** True when the APK route would serve a file (same lookup as /VibeSquad.apk; called at request time, so the circular import is safe). */
export function isAndroidApkBuilt(rootDir = resolve(import.meta.dirname, "..")) {
  return existsSync(resolveAndroidApkPath(rootDir));
}

export function getAuthStatus(rootDir = DEFAULT_ROOT_DIR) {
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  const distReady = hasDistIndex(rootDir);
  return {
    ok: true,
    hostId: getHostId(),
    port,
    meshnetIp,
    meshnetHost,
    lanIp,
    detectLanIp: lanIp,
    distReady,
    caFingerprint: caFingerprint(),
    lanHttpsUrl: lanIp ? `https://${lanIp}:${port}` : null,
    lanCaUrl: lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    lanDesktopInstallerUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad-setup.exe` : null,
    meshnetHttpsUrl: `https://${meshnetHost}:${port}`,
    caHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/ca.crt` : lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    desktopSetupHttpUrl: meshnetIp
      ? `http://${meshnetIp}:${port}/VibeSquad-setup.exe`
      : lanIp
        ? `http://${lanIp}:${port}/VibeSquad-setup.exe`
        : null,
  };
}

// ---- TLS artifacts (Root CA with Name Constraints + leaf) ----

function opensslBin() {
  const git = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
  return existsSync(git) ? git : "openssl";
}

export function openssl(args, cwd) {
  return execFileSync(opensslBin(), args, { cwd, stdio: "pipe", windowsHide: true }).toString();
}

// Rule 2: only the current Windows user may read the keys. Run before any key is written.
function lockDown(dir) {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) throw new Error("USERNAME is not set; refusing to create TLS keys without restricting the directory");
  execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "pipe", windowsHide: true });
}

// Secrets that live directly in ~/.vibesquad (VAPID private key, device token hashes, push endpoints, daemon password,
// the E5 relay host keypair).
export const HOME_SECRET_FILES = ["local-token", "vapid.json", "push-subs.json", "devices.json", "daemon-password", "host-keypair.json"];

/**
 * Restricts ~/.vibesquad to the current user: icacls on Windows, 0700 dir + 0600 secret files elsewhere.
 * Runs at every startup (not only when LAN/TLS is on). `deps` lets tests stub the platform and fs/exec calls.
 */
export function lockDownVibesquadHome({ home = vibesquadHome(), platform = process.platform, lock = lockDown, chmod = chmodSync, exists = existsSync, mkdir = mkdirSync } = {}) {
  mkdir(home, { recursive: true });
  if (platform === "win32") {
    lock(home);
    return;
  }
  try { chmod(home, 0o700); } catch {}
  for (const name of HOME_SECRET_FILES) {
    const f = join(home, name);
    if (exists(f)) {
      try { chmod(f, 0o600); } catch {}
    }
  }
}

/** Creates (or reuses) ~/.vibesquad/tls/{ca,server}.{key,crt}. Rotates the CA if its name constraints lack private LAN ranges or host/ip. */
export function ensureTls(cfg = netConfig()) {
  const { meshnetIp = detectMeshnetIp(), meshnetHost = DEFAULT_MESHNET_HOST, lanIp = detectLanIp() } = cfg ?? {};
  const dir = tlsDir();
  lockDownVibesquadHome();
  mkdirSync(dir, { recursive: true });
  lockDown(dir);
  const okHost = meshnetHost && HOST_RE.test(meshnetHost) ? meshnetHost : "";
  const okMeshIp = meshnetIp && IPV4_RE.test(meshnetIp) ? meshnetIp : "";
  const okLanIp = lanIp && IPV4_RE.test(lanIp) ? lanIp : "";
  if ((meshnetHost && !okHost) || (meshnetIp && !okMeshIp) || (lanIp && !okLanIp)) {
    throw new Error("refusing to generate TLS certificates: meshnetHost/meshnetIp/lanIp contain invalid characters");
  }
  const f = (n) => join(dir, n);
  const metaFile = f("meta.json");
  let meta = readJsonFileWithBom(metaFile, { fallback: {}, label: "tls/meta.json" }).value ?? {};

  let caText = "";
  if (existsSync(f("ca.crt"))) {
    try {
      caText = openssl(["x509", "-in", f("ca.crt"), "-noout", "-text"]);
    } catch {}
  }
  const caHasLanConstraints = !caText.includes("10.0.0.0") && !caText.includes("172.16.0.0");

  let leafText = "";
  if (existsSync(f("server.crt"))) {
    try {
      leafText = openssl(["x509", "-in", f("server.crt"), "-noout", "-text"]);
    } catch {}
  }
  const leafHasLanIp = !lanIp || leafText.includes(lanIp);

  const wantCa = { host: meshnetHost, ip: meshnetIp ?? "", lanIp: lanIp ?? "", v: 4 };
  const caOk =
    existsSync(f("ca.crt")) &&
    existsSync(f("ca.key")) &&
    caHasLanConstraints &&
    meta.ca?.host === wantCa.host &&
    meta.ca?.ip === wantCa.ip &&
    meta.ca?.lanIp === wantCa.lanIp &&
    meta.ca?.v === wantCa.v;

  if (!caOk) {
    for (const old of ["ca.key", "ca.crt", "server.key", "server.crt", "server.csr", "ca.srl"]) {
      try {
        rmSync(f(old), { force: true });
      } catch {}
    }
    const permitted = ["permitted;DNS:localhost", "permitted;IP:127.0.0.1/255.255.255.255"];
    if (okHost) permitted.push(`permitted;DNS:${okHost}`);
    for (const ip of new Set([okMeshIp, okLanIp])) if (ip) permitted.push(`permitted;IP:${ip}/255.255.255.255`);
    writeFileSync(
      f("ca.cnf"),
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        "CN = VibeSquad Local CA",
        "[v3_ca]",
        "basicConstraints = critical, CA:TRUE, pathlen:0",
        "keyUsage = critical, keyCertSign, cRLSign",
        "subjectKeyIdentifier = hash",
        `nameConstraints = critical, ${permitted.join(", ")}`,
        "",
      ].join("\n"),
    );
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", f("ca.key")]);
    if (process.platform !== "win32") chmodSync(f("ca.key"), 0o600);
    openssl([
      "req",
      "-x509",
      "-new",
      "-key",
      f("ca.key"),
      "-sha256",
      "-days",
      "3650",
      "-config",
      f("ca.cnf"),
      "-extensions",
      "v3_ca",
      "-out",
      f("ca.crt"),
    ]);
    meta = { ca: wantCa };
    // A new CA invalidates the old leaf.
    meta.leaf = null;
  }

  const wantLeaf = { host: meshnetHost, ip: meshnetIp ?? "", lanIp: lanIp ?? "" };
  const leafOk =
    existsSync(f("server.crt")) &&
    existsSync(f("server.key")) &&
    leafHasLanIp &&
    meta.leaf?.host === wantLeaf.host &&
    meta.leaf?.ip === wantLeaf.ip &&
    meta.leaf?.lanIp === wantLeaf.lanIp;

  if (!leafOk) {
    const san = ["DNS:localhost"];
    if (okHost) san.unshift(`DNS:${okHost}`);
    if (meshnetIp) san.push(`IP:${meshnetIp}`);
    if (lanIp && lanIp !== meshnetIp) san.push(`IP:${lanIp}`);
    san.push("IP:127.0.0.1");
    writeFileSync(
      f("leaf.cnf"),
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        `CN = ${okHost || "localhost"}`,
        "[v3_leaf]",
        "basicConstraints = critical, CA:FALSE",
        "keyUsage = critical, digitalSignature, keyEncipherment",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = ${san.join(", ")}`,
        "",
      ].join("\n"),
    );
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", f("server.key")]);
    if (process.platform !== "win32") chmodSync(f("server.key"), 0o600);
    openssl(["req", "-new", "-key", f("server.key"), "-config", f("leaf.cnf"), "-out", f("server.csr")]);
    openssl([
      "x509",
      "-req",
      "-in",
      f("server.csr"),
      "-CA",
      f("ca.crt"),
      "-CAkey",
      f("ca.key"),
      "-CAcreateserial",
      "-days",
      "825",
      "-sha256",
      "-extfile",
      f("leaf.cnf"),
      "-extensions",
      "v3_leaf",
      "-out",
      f("server.crt"),
    ]);
    meta.leaf = wantLeaf;
  }
  writeFileSync(metaFile, JSON.stringify(meta));
  lockDown(dir);
  tlsCache = { key: readFileSync(f("server.key")), cert: readFileSync(f("server.crt")), ca: readFileSync(f("ca.crt")) };
  return tlsCache;
}

let tlsCache;
export function getTls() {
  const cfg = netConfig();
  tlsCache ??= ensureTls(cfg);
  return tlsCache;
}

// Read-only: never creates the CA. Unauthenticated GETs (/ca.crt, auth/status, devices) reach this, so CA creation
// stays with getTls(): LAN/meshnet startup and POST /__vibesquad/pair/start.
export function caCrtPem() {
  const file = join(tlsDir(), "ca.crt");
  return existsSync(file) ? readFileSync(file) : null;
}

/** Rule 4: SHA-256 of the CA's DER bytes, as XX:XX:... plus an 8-pair short form. */
export function caFingerprint() {
  const pem = caCrtPem();
  if (!pem) return { full: null, short: null };
  const hex = sha256Hex(new X509Certificate(pem).raw).toUpperCase();
  const pairs = hex.match(/../g);
  return { full: pairs.join(":"), short: pairs.slice(0, 8).join(":") };
}

// ---- Devices ----

let devices; // [{ id, name, createdAt, lastSeenAt, tokenHash, mintedByDeviceId }]: in-memory mirror of devices.json
let lastPersist = 0;
// X1 E4a R2 L1: request-path callers (last-seen persist, pair redeem/approve, UI revoke) wait at most this long for
// <devices.json>.lock, so a stalled CLI holder can't freeze the event loop for the CLI's own 5 s budget.
const REQUEST_LOCK_MS = 200;
// devices.json is also written by other processes (`vs devices revoke` over SSH, E4a). Two rules keep that safe:
//  1. One locked writer: every change goes through mutateDevices(), which re-reads the file under <devices.json>.lock
//     (server/file-lock.mjs, the same primitive the CLI uses through this module), edits, and writes atomically. A
//     revoke and a pairing can't undo each other.
//  2. The mirror is trusted only while the file's path + mtime + size match what was last read or written; a changed
//     stamp reloads before any read, and the sockets of devices that vanished are destroyed. A file that exists but
//     can't be read or parsed is never treated as "no devices": reads fail closed and nothing is written over it.
let devicesStamp = null;
let devicesReadError = null; // Error from the last failed read, or null

function devicesFileStamp() {
  const file = devicesFile();
  const st = statSync(file, { throwIfNoEntry: false });
  return st ? `${file}|${st.mtimeMs}|${st.size}` : `${file}|missing`;
}

/** The list on disk; throws when the file exists but is unreadable or malformed (a missing file is an empty list). */
function readDevicesFromDisk() {
  const r = readJsonFileWithBom(devicesFile(), { fallback: { devices: [] }, label: "devices.json" });
  if (!r.ok && r.exists) throw new Error(`devices.json unreadable: ${r.error}`);
  return Array.isArray(r.value?.devices) ? r.value.devices : [];
}

// ---- Live sockets per device: every authenticated request registers its socket (keep-alive, SSE streams), so a
// revoke, from the UI or from another process, destroys the streams instead of waiting for the phone's TCP to drop.
const wsByDevice = new Map(); // deviceId -> Set<socket>
const DEVICE_WATCH_MS = 1000;
let deviceWatch = null;
const deviceDroppedListeners = new Set(); // E5: the relay host closes that device's sessions at once (relay-wiring.mjs)

/**
 * Called with a device id every time this process learns the device is gone: UI/CLI revoke (cascade members included),
 * an out-of-process edit of devices.json, or an unreadable file (fail closed). The E5 relay registers `relayHost.revoke`.
 * Returns an unsubscribe function. Listener errors are swallowed: a revoke must never fail because a hook did.
 */
export function onDeviceDropped(fn) {
  deviceDroppedListeners.add(fn);
  return () => deviceDroppedListeners.delete(fn);
}

function dropDeviceSockets(id) {
  for (const s of wsByDevice.get(id) ?? []) s.destroy();
  wsByDevice.delete(id);
  for (const fn of deviceDroppedListeners) {
    try {
      fn(id);
    } catch {}
  }
}

/** While any device socket is open, re-check devices.json every second so an external revoke cuts streams without a request. */
function ensureDeviceWatch() {
  if (deviceWatch) return;
  deviceWatch = setInterval(() => {
    if (!wsByDevice.size) {
      clearInterval(deviceWatch);
      deviceWatch = null;
      return;
    }
    loadDevices(); // reloads on an external change and drops the sockets of devices that are gone
  }, DEVICE_WATCH_MS);
  deviceWatch.unref?.();
}

export function trackSocket(deviceId, socket) {
  if (typeof socket?.once !== "function" || typeof socket?.destroy !== "function") return;
  let set = wsByDevice.get(deviceId);
  if (!set) wsByDevice.set(deviceId, (set = new Set()));
  if (set.has(socket)) return; // keep-alive: many requests, one close listener
  set.add(socket);
  socket.once("close", () => {
    set.delete(socket);
    if (!set.size) wsByDevice.delete(deviceId);
  });
  ensureDeviceWatch();
}

/** True while a device still has a registered socket (tests). */
export function hasDeviceSockets(id) {
  return (wsByDevice.get(id)?.size ?? 0) > 0;
}

function adoptDevices(fresh, stamp) {
  if (devices) {
    // The file changed under us (another process): anything it dropped is revoked here too, live sockets included.
    const keep = new Set(fresh.map((d) => d.id));
    for (const d of devices) {
      if (keep.has(d.id)) continue;
      dropDeviceSockets(d.id);
      discardPendingMintedBy(d.id); // Gemini E4b L2: an out-of-process revoke (vs devices) kills the minter's tickets too
    }
  }
  devices = fresh;
  devicesStamp = stamp;
  devicesReadError = null;
}

/** The current list, re-read when another process changed the file. Null when the file can't be read (callers fail closed). */
function loadDevices() {
  const stamp = devicesFileStamp();
  if (devices && stamp === devicesStamp) return devices;
  let fresh;
  try {
    fresh = readDevicesFromDisk();
  } catch (e) {
    devicesReadError = e;
    // X1 E4a R2 L2: fail closed for live streams too. New requests are already refused; an open SSE/keep-alive socket of
    // a device that the unreadable rewrite may have revoked must not keep flowing. Clients reconnect once it's readable.
    for (const id of [...wsByDevice.keys()]) dropDeviceSockets(id);
    return null; // stamp not advanced: the next call tries the disk again
  }
  adoptDevices(fresh, stamp);
  return devices;
}

function writeDevicesFile(list, lock = null) {
  mkdirSync(vibesquadHome(), { recursive: true });
  const tmp = `${devicesFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ devices: list }, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    lock?.assertOwned(); // X1 E4a R2 L4: a holder reaped as stale must not rename over a newer writer's file
    renameSync(tmp, devicesFile());
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  clearConfigWarning(devicesFile());
}

/**
 * The only writer of devices.json. Under <devices.json>.lock the list is re-read from disk, `mutate(list)` edits it in
 * place (its return value is passed back), and the result is written atomically. Throws, writing nothing, when the
 * file exists but can't be read, or when the lock can't be taken (5 s for the CLI; request paths pass REQUEST_LOCK_MS).
 */
function mutateDevices(mutate, { timeoutMs } = {}) {
  const lockOpts = timeoutMs === undefined ? {} : { timeoutMs };
  return withFileLockSync(devicesFile(), (lock) => {
    const list = readDevicesFromDisk();
    const out = mutate(list);
    writeDevicesFile(list, lock);
    adoptDevices(list, devicesFileStamp());
    lastPersist = Date.now();
    return out;
  }, lockOpts);
}

/** Writes the in-memory lastSeenAt times onto the file (every 60 s; never resurrects a device another process removed). */
function persistLastSeen() {
  const mem = devices;
  if (!mem) return;
  mutateDevices(
    (list) => {
      for (const d of list) {
        const m = mem.find((x) => x.id === d.id);
        if (m?.lastSeenAt && String(m.lastSeenAt) > String(d.lastSeenAt ?? "")) d.lastSeenAt = m.lastSeenAt;
      }
    },
    { timeoutMs: REQUEST_LOCK_MS },
  );
}

/** Drops the in-memory device list so the next read comes from disk (tests that swap VIBESQUAD_HOME). */
export function resetDevicesForTest() {
  devices = undefined;
  devicesStamp = null;
  devicesReadError = null;
  lastPersist = 0;
  for (const id of [...wsByDevice.keys()]) dropDeviceSockets(id);
  pendingDevices.clear();
}

const publicDevice = (d, currentId) => ({
  id: d.id,
  name: d.name,
  createdAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
  mintedByDeviceId: typeof d.mintedByDeviceId === "string" ? d.mintedByDeviceId : null,
  current: d.id === currentId,
});

/** Ids of `id` plus every device it minted, recursively (E4b cascade). Pure; cycles and self-references terminate. */
export function cascadeIds(list, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of list) {
      if (!out.has(d.id) && typeof d.mintedByDeviceId === "string" && out.has(d.mintedByDeviceId)) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return [...out];
}

/** The paired devices without their token hashes (what `vs devices list` and GET /__vibesquad/devices show). Throws when devices.json is unreadable. */
export function listDevices() {
  const list = loadDevices();
  if (!list) throw devicesReadError ?? new Error("devices.json unreadable");
  return list.map((d) => publicDevice(d, null));
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The paired device whose token hash matches `tokenHash` (constant-time), or null (also when the list can't be read). */
function deviceByTokenHash(tokenHash) {
  const hash = Buffer.from(tokenHash, "hex");
  const list = loadDevices();
  if (!list) return null; // devices.json unreadable: fail closed rather than trust a stale or empty list
  return (
    list.find((d) => {
      const want = Buffer.from(String(d.tokenHash ?? ""), "hex");
      return want.length === hash.length && timingSafeEqual(want, hash);
    }) ?? null
  );
}

/**
 * E5 relay `authenticate(token)` callback: the device behind a bearer token presented INSIDE the E2EE channel.
 * `{ deviceId }` for a paired device, `{ pending: true }` for a token still waiting for the minter's approval (E4b; it
 * opens nothing until then), null otherwise. Never a cookie, never a socket: the relay session carries the result.
 */
export function deviceForToken(token) {
  if (typeof token !== "string" || !token) return null;
  const dev = deviceByTokenHash(sha256Hex(token));
  if (dev) return { deviceId: dev.id };
  return pendingForToken(token) ? { pending: true } : null;
}

/**
 * E5 relay `isRevoked` callback, re-checked on every relayed dispatch: true only while `id` is in devices.json right now.
 * Cheap by construction: loadDevices() is one statSync (path + mtime + size) unless another process changed the file.
 * An unreadable file counts as inactive (fail closed), like every other read.
 */
export function deviceActive(id) {
  const list = loadDevices();
  return Boolean(list?.some((d) => d.id === id));
}

/**
 * The paired, non-revoked device behind this request, or null. Two kinds of request:
 *  - LAN / loopback: the vs_device cookie, hashed and matched in constant time.
 *  - E5 relay (req.relayDevice, set only by the in-process dispatcher after the device authenticated inside the E2EE
 *    channel): the device id itself, looked up in devices.json again so a revoke lands on the very next request. Any
 *    cookie or token header such a request carries is ignored: the channel identity is the only credential.
 */
export function authenticate(req) {
  if (isRelayRequest(req)) return authenticateRelayDevice(req);
  const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (!token) return null;
  // X1-E4b L4: a cookie-authenticated write must also prove it came from this site (Origin / Sec-Fetch-Site), not rest on
  // SameSite=Strict alone. Refused before the hash lookup: no devices.json read, no last-seen, no tracked socket.
  const refused = cookieWriteRefusal(req);
  if (refused) {
    req[ORIGIN_REFUSED] = refused;
    return null;
  }
  const dev = deviceByTokenHash(sha256Hex(token));
  if (!dev) return null;
  const now = Date.now();
  dev.lastSeenAt = new Date(now).toISOString();
  if (now - lastPersist > 60_000) {
    try {
      persistLastSeen();
    } catch {
      lastPersist = now; // locked or unreadable: try again in a minute, never block a request on it
    }
  }
  // Register this connection so a revoke (UI, or `vs devices revoke` in another process) cuts its streams too.
  trackSocket(dev.id, req.socket);
  return dev;
}

function authenticateRelayDevice(req) {
  const id = String(req.relayDevice.id);
  const list = loadDevices();
  const dev = list?.find((d) => d.id === id) ?? null; // unreadable list: fail closed, like the cookie path
  if (!dev) return null;
  const now = Date.now();
  dev.lastSeenAt = new Date(now).toISOString();
  if (now - lastPersist > 60_000) {
    try {
      persistLastSeen();
    } catch {
      lastPersist = now;
    }
  }
  return dev; // no trackSocket: the relay host closes the device's sessions through onDeviceDropped
}

// The loopback listener is the PC itself, but not only its owner (other apps, other Windows users):
// owner access there needs the local token (header) or the vs_local cookie the launcher sets.
// A relayed request (req.relayDevice) is never local, whatever its synthetic socket or headers say (E5 H1).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLocal = (req) => !isRelayRequest(req) && LOOPBACK.has(req.socket.localAddress ?? "");

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

export const isLoopbackOrigin = (origin) => LOOPBACK_ORIGIN_RE.test(origin ?? "") || TAURI_ORIGINS.has(origin ?? "");

const isBrowserRequest = (h) => /^Mozilla\//.test(String(h["user-agent"] ?? "")) || h["sec-fetch-site"] !== undefined;

/**
 * Loopback-only calls also refuse foreign Host/Origin headers (DNS-rebinding / cross-site posts).
 * Browsers always send Origin on POST and Sec-Fetch-Site on every request; plain CLI/test clients send neither.
 */
export function isLocalBrowserSafe(req) {
  if (isRelayRequest(req) || !isLocal(req)) return false;
  if (req.socket.remoteAddress && !LOOPBACK.has(req.socket.remoteAddress)) return false;
  const h = req.headers;
  if (!LOOPBACK_HOST_RE.test(h.host ?? "")) return false;
  const origin = h.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return false;
  const site = h["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method ?? "") && isBrowserRequest(h) && origin === undefined) return false;
  return true;
}

// ---- X1-E4b L4: same-origin proof for cookie-authenticated writes (both listeners, one chokepoint: authenticate) ----
// vs_device is Secure; SameSite=Strict, so a browser withholds it from cross-site requests; this is the second layer for
// the day that fails (a WebView or browser quirk, a same-site sibling origin, a leaked cookie replayed from a page).
// Decision table for a non-GET/HEAD/OPTIONS request carrying vs_device:
//   Origin present      -> must equal this listener's own origin (scheme://Host); "null" or any other value is refused.
//   Origin absent       -> Sec-Fetch-Site absent, "none" or "same-origin" passes; "cross-site" / "same-site" is refused.
// Missing BOTH headers is allowed on purpose: every browser (and the Android WebView, which is Chromium) sends Origin on
// every POST/PUT/PATCH/DELETE, so a cross-site page cannot produce that shape. The clients that do produce it are not
// browsers: the desktop proxy forwarding to a remote host (src-tauri main.rs strips Origin/Referer and passes the
// webview's Sec-Fetch-Site through, which an older WebKit may omit altogether), curl-style tooling and the test suite.
// Failing closed there would break the desktop app on a remote host without stopping any browser attack.
// Relayed requests (req.relayDevice) never reach this: authenticate() answers them from the channel identity first.
// Token-header and agent-header callers are not cookie auth and are not checked here (isLocalBrowserSafe covers loopback).
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ORIGIN_REFUSED = Symbol("vibesquad.origin-refused");
export const CROSS_SITE_ERROR = "cross-site request refused: Origin / Sec-Fetch-Site do not match this host";

const singleHeader = (h, name) => {
  const v = h?.[name];
  return v === undefined ? undefined : String(Array.isArray(v) ? v.join(", ") : v).trim();
};

/** `scheme://host` as a browser on this listener puts it in Origin (lower-cased), or null without a Host header. */
export function ownOrigin(req) {
  const host = singleHeader(req.headers, "host")?.toLowerCase();
  if (!host) return null;
  return `${req.socket?.encrypted ? "https" : "http"}://${host}`;
}

/**
 * Why a state-changing request must NOT be authenticated by its vs_device cookie, or null when it may be. Safe methods
 * (GET/HEAD/OPTIONS) always pass: reads are not CSRF targets and the SSE/WebSocket upgrades are GETs. See the table above.
 */
export function cookieWriteRefusal(req) {
  if (SAFE_METHODS.has(String(req.method ?? "GET").toUpperCase())) return null;
  const h = req.headers ?? {};
  const origin = singleHeader(h, "origin");
  if (origin !== undefined) {
    const own = ownOrigin(req);
    if (own && origin.toLowerCase() === own) return null;
    return `Origin ${origin || "(empty)"} is not this host${own ? ` (${own})` : ""}`;
  }
  const site = singleHeader(h, "sec-fetch-site");
  if (site === undefined || site === "none" || site === "same-origin") return null;
  return `Sec-Fetch-Site ${site} without an Origin`;
}

/** The refusal authenticate() recorded for this request (a cookie write that failed the same-origin proof), or null. */
export const originRefusal = (req) => req?.[ORIGIN_REFUSED] ?? null;

/** 403 with a plain error for a refused cookie write: JSON on API paths / JSON callers, text otherwise. Never HTML. */
export function sendCrossSiteRefused(req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/__vibesquad/") || path.startsWith("/api/") || String(req.headers.accept ?? "").includes("application/json")) {
    return sendJson(res, 403, { error: CROSS_SITE_ERROR });
  }
  res.statusCode = 403;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(CROSS_SITE_ERROR);
}

// ---- Local token (owner trust on loopback) ----

export const LOCAL_COOKIE = "vs_local";
const localTokenCache = new Map(); // token file -> token (keyed so a test that moves VIBESQUAD_HOME gets that home's token)

/** The per-install token, created on first use (server start calls this after locking the home dir). */
export function getLocalToken() {
  const file = localTokenPath();
  let token = localTokenCache.get(file);
  if (!token) localTokenCache.set(file, (token = ensureLocalToken(file)));
  return token;
}

export function resetLocalTokenForTest() {
  localTokenCache.clear();
}

// The cookie carries a value derived from the token, so a leaked cookie isn't the header secret too.
const localCookieValue = (token) => sha256Hex(`vs_local-cookie:${token}`);

const sameSecret = (got, want) => {
  const a = Buffer.from(String(got ?? ""), "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** True when the request carries the local token header or the vs_local cookie. Says nothing about the listener. Never for a relayed request. */
export function hasLocalToken(req) {
  if (isRelayRequest(req)) return false; // E5 L2: the channel identity is the only credential a relayed request has
  const token = getLocalToken();
  const header = req.headers[LOCAL_TOKEN_HEADER] ?? req.headers["x-vs-token"];
  if (typeof header === "string" && sameSecret(header.trim(), token)) return true;
  const cookie = parseCookies(req.headers.cookie)[LOCAL_COOKIE];
  return Boolean(cookie) && sameSecret(cookie, localCookieValue(token));
}

/** Owner on loopback: the existing Host/Origin checks plus the local token. */
export const isLocalOwner = (req) => isLocalBrowserSafe(req) && hasLocalToken(req);

/** True only for the x-vibesquad-token header (never the cookie): the nonce endpoint is for CLI/launcher callers. */
export function hasLocalTokenHeader(req) {
  if (isRelayRequest(req)) return false;
  const header = req.headers[LOCAL_TOKEN_HEADER] ?? req.headers["x-vs-token"];
  return typeof header === "string" && sameSecret(header.trim(), getLocalToken());
}

// ---- Caller kinds (X1c, docs/PLAN_X1_IDENTITY.md) ----
// Every /__vibesquad request has exactly one caller:
//   owner   = a paired device (vs_device cookie) or the loopback local token (x-vibesquad-token header / vs_local cookie),
//   agent   = x-vs-agent-id + x-vs-agent-token, verified against runner memory with GET /verify-agent (never the env, never a
//             claimed id). The record carries role/lane/team/profile/digest/digestFor/status/overlord; the token stays on the
//             caller as a non-enumerable field (so the VS server can forward the call as that agent) and is never serialised.
//   unknown = neither (read-only). An empty id is never the owner.
// A request that names an agent is never the owner, whatever else it carries: a wrong/missing token is a refusal
// ({ kind: "denied", status: 403 }); a runner that cannot answer is a refusal too (503), never a fallback to owner.
export const AGENT_ID_HEADER = "x-vs-agent-id";
export const AGENT_TOKEN_HEADER = "x-vs-agent-token";
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CALLER_PROMISE = Symbol("vibesquad.caller.promise");
const CALLER_VALUE = Symbol("vibesquad.caller");

const headerValue = (req, name) => {
  const v = req.headers?.[name];
  return String(Array.isArray(v) ? v[0] : v ?? "").trim();
};

/** True when the request names an agent (a non-empty x-vs-agent-id). Such a request is never the owner. */
export const hasAgentHeaders = (req) => headerValue(req, AGENT_ID_HEADER) !== "";

/** Owner proof: a paired device cookie, or the loopback local token (header or vs_local cookie). Never for an agent request. */
export function ownerProof(req) {
  if (hasAgentHeaders(req)) return false;
  return Boolean(authenticate(req)) || isLocalOwner(req);
}

async function defaultVerifyAgent(caller) {
  const { sharedRunnerBackend } = await import("./backend/index.mjs"); // lazy: auth.mjs stays light for the pair/TLS callers
  return sharedRunnerBackend().verifyAgent(caller);
}

const denied = (status, error) => ({ kind: "denied", status, error });

async function resolveCaller(req, verifyAgent) {
  const id = headerValue(req, AGENT_ID_HEADER);
  if (!id) return ownerProof(req) ? { kind: "owner" } : { kind: "unknown" };
  const token = headerValue(req, AGENT_TOKEN_HEADER);
  const bad = "agent token invalid (x-vs-agent-id does not match x-vs-agent-token, or the agent is gone/retired)";
  if (!AGENT_ID_RE.test(id) || !token) return denied(403, bad);
  let who = null;
  try {
    who = await verifyAgent({ id, token });
  } catch (e) {
    if (e?.status === 403) return denied(403, bad);
    return denied(503, `could not verify the agent caller: ${e?.message ?? e}`);
  }
  if (!who || typeof who !== "object" || who.id !== id) return denied(403, bad);
  const caller = { kind: "agent", ...who, id };
  Object.defineProperty(caller, "token", { value: token, enumerable: false });
  return caller;
}

/**
 * The caller of `req`, resolved once per request (later calls return the same record). `verifyAgent({ id, token })` is the
 * runner lookup (RunnerBackend.verifyAgent: GET /verify-agent as that agent; throws a 403 RunnerHttpError on mismatch).
 */
export function callerFromRequest(req, { verifyAgent = defaultVerifyAgent } = {}) {
  if (req[CALLER_PROMISE]) return req[CALLER_PROMISE];
  const p = resolveCaller(req, verifyAgent).then((c) => {
    req[CALLER_VALUE] = c;
    return c;
  });
  req[CALLER_PROMISE] = p;
  return p;
}

/** The already-resolved caller of `req` (set by callerFromRequest / the middleware), or null before resolution. */
export const callerOf = (req) => req?.[CALLER_VALUE] ?? null;

/** Synchronous resolution for a request without agent headers (owner | unknown); cached like callerFromRequest. */
export function resolveNonAgentCaller(req) {
  if (req[CALLER_VALUE]) return req[CALLER_VALUE];
  const c = ownerProof(req) ? { kind: "owner" } : { kind: "unknown" };
  req[CALLER_VALUE] = c;
  req[CALLER_PROMISE] = Promise.resolve(c);
  return c;
}

// Single-use login nonces: the URL a launcher puts on a command line never carries the master token.
const LOGIN_NONCE_TTL_MS = 60_000;
const loginNonces = new Map(); // nonce -> expiresAt

/** A fresh 128-bit nonce for /__vibesquad/local-login?t=, valid once for ~60 s. In memory, so mint it in the server process. */
export function mintLocalLoginNonce(ttlMs = LOGIN_NONCE_TTL_MS) {
  const now = Date.now();
  for (const [n, exp] of loginNonces) if (exp <= now) loginNonces.delete(n);
  const nonce = randomBytes(16).toString("hex");
  loginNonces.set(nonce, now + ttlMs);
  return nonce;
}

function consumeLocalLoginNonce(raw) {
  const nonce = String(raw ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  const exp = loginNonces.get(nonce);
  loginNonces.delete(nonce);
  return exp !== undefined && exp > Date.now();
}

export function resetLocalLoginNoncesForTest() {
  loginNonces.clear();
}

export const READ_ONLY_ERROR = "read-only: this loopback request has no VibeSquad local token. Open VibeSquad from its launcher or desktop app (or run `vs open`), or send the x-vibesquad-token header from ~/.vibesquad/local-token.";

/**
 * GET /__vibesquad/local-login?t=<nonce>: launcher-only bootstrap. Sets the vs_local session cookie and redirects
 * to /. Loopback only; t must be an unused, unexpired nonce (never the master token), else 403 and no cookie.
 */
export function handleLocalLogin(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  res.setHeader("referrer-policy", "no-referrer");
  if (!isLocalBrowserSafe(req)) return sendJson(res, 403, { error: "local login is only available on the PC itself" });
  const t = new URL(req.url ?? "/", "http://x").searchParams.get("t");
  if (!consumeLocalLoginNonce(t)) return sendHtml(res, 403, "Local login failed", "That link is not valid, already used, or expired. Open VibeSquad from its launcher or desktop app, or run <code>vs open</code>.");
  res.statusCode = 302;
  // Session cookie (no Max-Age): a fresh launcher run unlocks the next browser session.
  res.setHeader("set-cookie", `${LOCAL_COOKIE}=${localCookieValue(getLocalToken())}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader("location", "/");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end();
}

/** POST /__vibesquad/local-login/nonce with the x-vibesquad-token header: { nonce, path, expiresInMs } for `vs open`. */
export function handleLocalLoginNonce(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  if (!isLocalBrowserSafe(req) || !hasLocalTokenHeader(req)) return sendJson(res, 403, { error: "the x-vibesquad-token header is required" });
  const nonce = mintLocalLoginNonce();
  sendJson(res, 200, { nonce, path: `/__vibesquad/local-login?t=${nonce}`, expiresInMs: LOGIN_NONCE_TTL_MS });
}

/** Host header values this server answers to; anything else is not echoed into redirects. */
export function isAllowedHostHeader(host) {
  const { meshnetHost, meshnetIp, lanIp } = netConfig();
  const name = String(host ?? "").replace(/:\d+$/, "");
  if (!name || !HOST_RE.test(name)) return false;
  return [meshnetHost, meshnetIp, lanIp, "localhost", "127.0.0.1"].filter(Boolean).includes(name);
}

function deviceNameFromUa(ua = "") {
  if (/VibeSquad-Desktop/i.test(ua)) {
    const os = /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Desktop";
    return `${os} · VibeSquad App`;
  }
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}`;
}

// ---- Revocation (cuts live sockets immediately; E4b cascades over mintedByDeviceId) ----

/**
 * Revokes `id` and, recursively, every device it minted (E4b MUST 3), in one locked read-modify-write so a concurrent
 * CLI write can't interleave halfway through the cascade. Returns the removed ids (empty when `id` is unknown).
 * The CLI keeps the lock's 5 s default; HTTP handlers pass { timeoutMs: REQUEST_LOCK_MS }.
 */
export function revokeDevice(id, { timeoutMs } = {}) {
  const removed = mutateDevices(
    (list) => {
      if (!list.some((d) => d.id === id)) return [];
      const gone = new Set(cascadeIds(list, id));
      for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i].id)) list.splice(i, 1);
      return [...gone];
    },
    { timeoutMs },
  );
  for (const rid of removed) {
    dropDeviceSockets(rid);
    discardPendingMintedBy(rid); // tickets the revoked device minted die with it
  }
  return removed;
}

/** Revokes every paired device (`vs devices revoke --all`, lost-phone fallback). Returns how many were dropped. */
export function revokeAllDevices() {
  const ids = mutateDevices((list) => {
    const was = list.map((d) => d.id);
    list.length = 0;
    return was;
  });
  for (const id of ids) dropDeviceSockets(id);
  pendingDevices.clear();
  return ids.length;
}

// ---- One-time pairing codes ----

const codes = new Map(); // code -> { expiresAt, mintedBy } (mintedBy: paired device id that minted it, null = PC / CLI)
const PAIR_WINDOW_MS = 60_000;

// ---- E4b two-step confirm: devices redeemed from a phone-minted code wait here, never in devices.json ----
// A pending ticket holds the new device's token hash in memory only. authenticate() reads devices.json, so the token
// authenticates nothing (HTTP, SSE, relay, CLI list) until the minting device approves it, which appends the device
// with mintedByDeviceId under the lock. Deny, the TTL, a server restart, or revoking the minter all discard it.
export const PENDING_TTL_MS = 60_000;
const pendingDevices = new Map(); // pendingId -> { id, tokenHash, name, ip, mintedBy, createdAt, expiresAt }

function sweepPending(now = Date.now()) {
  for (const [pid, p] of pendingDevices) if (p.expiresAt <= now) pendingDevices.delete(pid);
}

function discardPendingMintedBy(deviceId) {
  for (const [pid, p] of pendingDevices) if (p.mintedBy === deviceId) pendingDevices.delete(pid);
}

/** The pending ticket behind a vs_device cookie value, or null (constant-time hash compare, like authenticate). */
function pendingForToken(token) {
  if (!token) return null;
  sweepPending();
  const hash = Buffer.from(sha256Hex(token), "hex");
  for (const p of pendingDevices.values()) {
    const want = Buffer.from(p.tokenHash, "hex");
    if (want.length === hash.length && timingSafeEqual(want, hash)) return p;
  }
  return null;
}

const publicPending = (p, now = Date.now()) => ({ pendingId: p.id, name: p.name, ip: p.ip, createdAt: p.createdAt, expiresInMs: Math.max(0, p.expiresAt - now) });

/** Pending tickets minted by `deviceId` (what the minting phone's sheet shows). */
export function listPendingMintedBy(deviceId) {
  sweepPending();
  return [...pendingDevices.values()].filter((p) => p.mintedBy === deviceId).map((p) => publicPending(p));
}

/** Tests: how many tickets are waiting. */
export function pendingCountForTest() {
  sweepPending();
  return pendingDevices.size;
}

/** Tests: age every waiting ticket past its TTL. */
export function expirePendingForTest() {
  for (const p of pendingDevices.values()) p.expiresAt = 0;
}
const PAIR_MAX_ATTEMPTS = 5;
// Bad codes lock out only the IP that sent them (other IPs' live codes stay valid): 1 min, doubling up to 1 h.
const PAIR_MAX_FAILURES = 5;
const PAIR_LOCK_BASE_MS = 60_000;
const PAIR_LOCK_MAX_MS = 60 * 60_000;
const PAIR_FAILURE_FORGET_MS = 60 * 60_000;
const pairAttempts = new Map(); // ip -> timestamps
const pairFailuresByIp = new Map(); // ip -> { count, lastAt, lockedUntil }

export function resetPairRateLimitForTest() {
  pairAttempts.clear();
  pairFailuresByIp.clear();
  codes.clear();
}

function prunePairState(now) {
  for (const [ip, ts] of pairAttempts) if (!ts.some((t) => now - t < PAIR_WINDOW_MS)) pairAttempts.delete(ip);
  for (const [ip, f] of pairFailuresByIp) if (f.lockedUntil <= now && now - f.lastAt > PAIR_FAILURE_FORGET_MS) pairFailuresByIp.delete(ip);
}

function pairLockRemainingMs(ip, now = Date.now()) {
  const f = pairFailuresByIp.get(ip);
  return f && f.lockedUntil > now ? f.lockedUntil - now : 0;
}

function recordPairFailure(ip, now = Date.now()) {
  const f = pairFailuresByIp.get(ip) ?? { count: 0, lastAt: 0, lockedUntil: 0 };
  f.count += 1;
  f.lastAt = now;
  if (f.count >= PAIR_MAX_FAILURES) {
    f.lockedUntil = now + Math.min(PAIR_LOCK_MAX_MS, PAIR_LOCK_BASE_MS * 2 ** (f.count - PAIR_MAX_FAILURES));
  }
  pairFailuresByIp.set(ip, f);
}

/**
 * A fresh one-shot code. `mintedBy` = the paired device that asked for it (E4b: its redeem lands in pending-approval).
 * X1 E4b L2 / plan guard 2: one active unredeemed code per minter. Minting again *replaces* the minter's previous live
 * code (the sheet's "New code" button; the old QR is dead at once), so a device can't stack codes for a LAN guesser.
 * The PC / CLI (mintedBy null) is one minter too: `vs pair` and the desktop dialog share a single live code.
 */
export function createPairCode(ttlMs = CODE_TTL_MS, mintedBy = null) {
  sweepCodes();
  const minter = typeof mintedBy === "string" ? mintedBy : null;
  for (const [c, v] of codes) if (v.mintedBy === minter) codes.delete(c);
  let code = String(randomInt(100_000, 1_000_000));
  while (codes.has(code)) code = String(randomInt(100_000, 1_000_000));
  codes.set(code, { expiresAt: Date.now() + ttlMs, mintedBy: minter });
  for (const fn of pairCodeMintedListeners) {
    try {
      fn();
    } catch {}
  }
  return code;
}

const pairCodeMintedListeners = new Set(); // E5: relayHost.noteFreshMint() lifts the host-wide redeem lock (threat model T8)

/** Runs after every new pairing code exists (PC, CLI or device minted). Returns an unsubscribe function. */
export function onPairCodeMinted(fn) {
  pairCodeMintedListeners.add(fn);
  return () => pairCodeMintedListeners.delete(fn);
}

/** E5 relay `burnCodes` callback (T8): the host-wide failed-redeem limit invalidates every outstanding code at once. */
export function burnAllPairCodes() {
  const n = codes.size;
  codes.clear();
  return n;
}

/** Tests: live (unredeemed, unexpired) codes for a minter (null = PC / CLI). */
export function liveCodeCountForTest(mintedBy = null) {
  sweepCodes();
  return [...codes.values()].filter((v) => v.mintedBy === mintedBy).length;
}

function pairRateLimited(ip) {
  const now = Date.now();
  prunePairState(now);
  const recent = (pairAttempts.get(ip) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
  recent.push(now);
  pairAttempts.set(ip, recent);
  return recent.length > PAIR_MAX_ATTEMPTS;
}

/** Invalidates a pair code, e.g. one that arrived over plain HTTP and may have been seen on the LAN. */
export function discardPairCode(rawCode) {
  const raw = String(rawCode ?? "").trim();
  codes.delete(raw);
  codes.delete(raw.replace(/[-\s]/g, ""));
}

/**
 * Plain-HTTP /pair: burns the code under the same per-IP limits as /pair redeem, so a LAN host can't sweep the
 * code space over HTTP to wipe the real one. A miss counts as a failure; a locked or throttled IP burns nothing.
 */
export function discardPlainHttpPairCode(rawCode, ip) {
  const raw = String(rawCode ?? "").trim();
  if (!raw) return false; // no code: nothing to burn, and no rate-limit attempt used up
  const key = String(ip ?? "unknown").replace(/^::ffff:/, "");
  if (pairLockRemainingMs(key) > 0 || pairRateLimited(key)) return false;
  const existed = codes.has(raw) || codes.has(raw.replace(/[-\s]/g, ""));
  discardPairCode(raw);
  if (!existed) recordPairFailure(key);
  return existed;
}

function sweepCodes() {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt <= now) codes.delete(c);
}

// ---- HTTP handlers ----

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(JSON.stringify(data));
}

/** Anti-clickjacking for HTML responses: X-Frame-Options plus CSP frame-ancestors, merged into any CSP already set. */
export function setNoFraming(res) {
  res.setHeader("x-frame-options", "DENY");
  const prev = String(res.getHeader?.("content-security-policy") ?? "").trim().replace(/;\s*$/, "");
  res.setHeader("content-security-policy", !prev ? "frame-ancestors 'none'" : /(^|;)\s*frame-ancestors\b/i.test(prev) ? prev : `${prev}; frame-ancestors 'none'`);
}

/** The APK passes its own WebView origin as `vs_app` so server pages can send the user back; only Tauri origins count. */
function appOrigin(req) {
  const o = new URL(req.url ?? "/", "http://x").searchParams.get("vs_app") ?? "";
  return TAURI_ORIGINS.has(o) ? o : null;
}

function sendHtml(res, code, title, message, back = null, extra = "") {
  res.statusCode = code;
  res.setHeader("content-type", "text/html; charset=utf-8");
  setNoFraming(res);
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(htmlPage(title, message, back, extra));
}

/**
 * Recovery actions for the APK on PC-served failure pages. The WebView never completes a navigation from this https origin
 * back to http://tauri.localhost, so these pages carry no link to it: a vibesquad://pair deep link (host only, no token)
 * reopens the app's pair screen, and Back (history) returns to the app screen that offers Forget. Browsers get nothing.
 */
function apkRecoveryHtml(req) {
  if (!appOrigin(req)) return "";
  const host = String(req.headers?.host ?? "");
  const link = /^[a-z0-9.:\[\]-]{1,255}$/i.test(host) ? `vibesquad://pair?host=${encodeURIComponent(host)}` : "vibesquad://pair";
  return `<p><a href="${link}" style="color:#ff2a85">Pair again</a></p><p><a href="#" onclick="history.back();return false" style="color:#ff2a85">Back to the app (use Forget this PC there)</a></p>`;
}

/** `back` = { href, label, auto }: a link to the APK's pair screen (auto also redirects there at once). */
export function htmlPage(title, message, back = null, extra = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${back?.auto ? `<meta http-equiv="refresh" content="0;url=${back.href}">` : ""}
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070710;color:#eef2ff;font-family:"JetBrains Mono",Consolas,monospace}
.card{max-width:480px;margin:16px;padding:22px;background:#111326;border:1px solid #ff2a85;box-shadow:0 0 24px #ff2a8530}
h1{margin:0 0 10px;font-size:18px;color:#ff2a85;letter-spacing:1px;text-transform:uppercase}p{margin:0;line-height:1.5;color:#828ba8}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p>${back ? `<p><a href="${back.href}" style="color:#ff2a85">${back.label}</a></p>` : ""}${extra}</div></body></html>`;
}

export const UNPAIRED_MESSAGE = "Unpaired device — open VibeSquad on your PC, click Pair a device, install the CA certificate if needed, and scan the QR code.";

/** 401 for an unpaired Meshnet/LAN request: JSON for API/JSON clients, neon-noir HTML for browser navigation. */
export function sendUnpaired(req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/__vibesquad/") || String(req.headers.accept ?? "").includes("application/json")) return sendJson(res, 401, { error: "unpaired device" });
  sendHtml(res, 401, "Unpaired device", UNPAIRED_MESSAGE, null, apkRecoveryHtml(req));
}

/**
 * Unauthenticated same-site hop for the APK. vs_device is SameSite=Strict, and the app (http://tauri.localhost) opens the
 * PC with a cross-site top-level navigation, which withholds it. This page only bounces to "/" (a fixed target, no token,
 * no open redirect); that second navigation is initiated by a page on this site, so Strict cookies are sent.
 */
export function handleEnter(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const app = appOrigin(req);
  // Always a fixed same-site "/" (also after pairing). Returning to the app origin from here was the post-pair dead end:
  // the WebView never completed the https-PC -> http://tauri.localhost navigation, leaving this page stuck on "Continue".
  const href = app ? `/?${new URLSearchParams({ vs_app: app }).toString()}` : "/";
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  setNoFraming(res);
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  const safe = href.replace(/&/g, "&amp;");
  if (req.method === "HEAD") return res.end();
  // Styled on purpose: the old bare page was a white screen with one "Continue" link whenever the automatic hop did not fire.
  // If this page is still showing after 2.5s the script prints what it can see, so a screenshot of it is a trace.
  const target = JSON.stringify(href).replace(/</g, "\u003c");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VibeSquad</title><meta http-equiv="refresh" content="0;url=${safe}">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070710;color:#eef2ff;font-family:"JetBrains Mono",Consolas,monospace}
.c{max-width:480px;margin:16px;padding:22px;background:#111326;border:1px solid #ff2a85}p{margin:0 0 10px;color:#828ba8}a{color:#ff2a85}#d{white-space:pre-wrap;font-size:12px;color:#828ba8}</style></head>
<body><div class="c"><p>Opening VibeSquad…</p><p><a id="go" href="${safe}">Continue</a></p><div id="d"></div></div>
<script>try{location.replace(${target})}catch(e){document.getElementById("d").textContent="redirect threw: "+e}
setTimeout(function(){document.getElementById("d").textContent="Redirect did not leave this page (hop to "+${target}+") | cookies enabled: "+navigator.cookieEnabled+" | UA: "+navigator.userAgent+" | ref: "+document.referrer}, 2500)</script></body></html>`);
}

export function handleCaCrt(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const pem = caCrtPem();
  if (!pem) return sendJson(res, 404, { error: "no CA yet" });
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-x509-ca-cert");
  res.setHeader("content-disposition", 'attachment; filename="vibesquad-ca.crt"');
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(req.method === "HEAD" ? undefined : pem);
}

/** `&fp=<64 hex>` for pairing links (the CA fingerprint without colons), or "" when there is no CA yet. */
export function pairFpQuery() {
  const full = caFingerprint().full;
  return full ? `&fp=${full.replace(/:/g, "").toLowerCase()}` : "";
}

export async function handlePairStart(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  // Hub5 MUST / X1 M3: the handler gates itself, not only the router. A loopback caller needs the local token (header or
  // vs_local cookie); a token-less loopback process, browser or not, can't mint. A paired device may mint (E4b), but its
  // code lands in pending-approval (mintedBy) instead of granting access on redeem.
  // X1 E4b L5: the PC owner (local token) is the stronger principal and can edit devices.json directly, so its mints never
  // need a second tap, even when the same browser also carries a vs_device cookie. Only remote paired devices mint
  // approval-required codes.
  const localOwner = !hasAgentHeaders(req) && isLocalOwner(req); // an agent (x-vs-agent-id) is never the owner (ownerProof)
  const minter = localOwner || hasAgentHeaders(req) ? null : authenticate(req);
  if (!localOwner && !minter) {
    return sendJson(res, 403, { error: "pairing can only be started from the PC (local token) or an already paired device" });
  }
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  if (!meshnetIp && !lanIp) {
    return sendJson(res, 503, { error: "no LAN or Meshnet IP detected (check Wi-Fi/Ethernet or NordVPN Meshnet)" });
  }
  const effectiveMeshnetIp = meshnetIp || DEFAULT_MESHNET_IP;
  getTls();
  const code = createPairCode(CODE_TTL_MS, minter?.id ?? null);
  const expiresAt = codes.get(code).expiresAt;
  // `fp` (CA SHA-256, hex) lets the Android app pin this PC's VS CA at pairing (see src-tauri/android/VsTrust.kt).
  const fpQuery = pairFpQuery();
  const pairHost = meshnetHost || effectiveMeshnetIp || lanIp;
  const pairUrl = `https://${pairHost}:${port}/pair?code=${code}${fpQuery}`;
  const pairIpUrl = `https://${effectiveMeshnetIp || lanIp}:${port}/pair?code=${code}${fpQuery}`;
  const lanPairUrl = lanIp ? `https://${lanIp}:${port}/pair?code=${code}${fpQuery}` : null;
  sendJson(res, 200, {
    code,
    pairUrl,
    pairIpUrl,
    lanIp,
    lanHttpsUrl: lanIp ? `https://${lanIp}:${port}` : null,
    lanCaUrl: lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    lanDesktopInstallerUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad-setup.exe` : null,
    lanAndroidApkUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad.apk` : null,
    lanPairUrl,
    lanQrSvg: lanPairUrl ? await qrSvg(lanPairUrl) : null,
    caHttpUrl: `http://${effectiveMeshnetIp}:${port}/ca.crt`,
    desktopSetupHttpUrl: `http://${effectiveMeshnetIp}:${port}/VibeSquad-setup.exe`,
    androidApkHttpUrl: `http://${effectiveMeshnetIp}:${port}/VibeSquad.apk`,
    androidApkAvailable: isAndroidApkBuilt(),
    caFingerprint: caFingerprint(),
    meshnetHost,
    meshnetIp: effectiveMeshnetIp,
    expiresAt,
    // E4b: a device-minted code needs the minting device's Approve tap after redeem (the sheet polls /pair/pending).
    requiresApproval: Boolean(minter),
    mintedByDeviceId: minter?.id ?? null,
    qrSvg: await qrSvg(pairUrl),
    qrSvgIp: await qrSvg(pairIpUrl),
  });
}

export function handlePairRedeem(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  // X1 E4b L1: a device that is already paired keeps its live cookie. A device-minted link opened on the owner's phone
  // must not downgrade that phone to a pending token (and then make it a child of whoever minted). Spend nothing.
  if (parseCookies(req.headers.cookie)[DEVICE_COOKIE] && authenticate(req)) {
    const app = appOrigin(req);
    const href = app ? `/__vibesquad/enter?${new URLSearchParams({ vs_app: app }).toString()}` : "/__vibesquad/enter";
    return sendHtml(res, 200, "Already paired", "This device is already paired with this PC, so the pairing code was left untouched for the device it was meant for.", { href, label: "Open VibeSquad" });
  }
  const ip = String(req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const lockedMs = pairLockRemainingMs(ip);
  if (lockedMs > 0 || pairRateLimited(ip)) {
    const retrySecs = Math.max(60, Math.ceil(lockedMs / 1000));
    res.statusCode = 429;
    res.setHeader("retry-after", String(retrySecs));
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end(lockedMs > 0 ? `Too many failed pairing attempts. Try again in ${Math.ceil(retrySecs / 60)} min.` : "Too many pairing attempts. Try again in a minute.");
  }
  const q = new URL(req.url, "http://x").searchParams;
  const rawCode = (q.get("code") ?? "").trim();
  if (!rawCode) {
    return sendHtml(res, 400, "No pairing code", "Scan the QR code on your PC (it opens an https:// link with the code).");
  }
  const name = (q.get("name") || deviceNameFromUa(String(req.headers["user-agent"] ?? ""))).slice(0, 40);
  const r = redeemPairCode({ rawCode, ip, name });
  if (r.state === "invalid") {
    return sendHtml(res, 401, "Pairing failed", "This pairing code is invalid, already used, or expired. Generate a new QR code on your PC.", null, apkRecoveryHtml(req));
  }
  if (r.state === "busy") {
    // devices.json locked or unreadable: the code is spent, nothing was written, and no cookie goes out.
    return sendHtml(res, 503, "Pairing failed", "The PC could not record this device (its device list is locked or unreadable). Generate a new code and try again.");
  }
  const app = appOrigin(req);
  const enterHref = app ? `/__vibesquad/enter?${new URLSearchParams({ vs_app: app }).toString()}` : "/__vibesquad/enter";
  const token = r.token;
  res.setHeader("set-cookie", `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`);
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  if (r.state === "pending") {
    // E4b two-step confirm: the cookie's token is not in devices.json yet, so it opens nothing. This page polls the public
    // /pair/status (same-site fetch, so the Strict cookie is sent) and hops to /enter only once the minting device approved.
    return sendHtml(res, 200, "Waiting for approval", `Approve this device on the phone that showed the code (<b>${escapeHtml(r.mintedByName)}</b>) within ${Math.round(PENDING_TTL_MS / 1000)} s.`, null, waitingScript(enterHref) + apkRecoveryHtml(req));
  }
  res.statusCode = 302;
  // Not a direct redirect: the scan is a cross-site navigation, and a redirect chain started cross-site keeps Strict cookies
  // from being sent. Land on the same-site /__vibesquad/enter page (a 200, which ends the chain); its client-side hop to "/"
  // is same-site and carries vs_device. The APK saves its session before leaving (RemotePairScreen), not on a return trip.
  res.setHeader("location", enterHref);
  res.end();
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Inline poller for the waiting page: every 2 s ask /pair/status; "approved" hops to `href`, anything else stops. */
function waitingScript(href) {
  const target = JSON.stringify(href).replace(/</g, "\\u003c");
  return `<p id="vs-wait-state">Waiting…</p><script>(function(){var el=document.getElementById("vs-wait-state");var t=setInterval(function(){fetch("/pair/status",{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j.state==="approved"){clearInterval(t);el.textContent="Approved. Opening…";location.replace(${target});}else if(j.state!=="pending"){clearInterval(t);el.textContent=j.state==="denied"?"Denied on the phone. Ask for a new code.":"The approval window closed. Ask for a new code.";}}).catch(function(){});},2000);})()</script>`;
}

/**
 * Spends `rawCode` and either records the device (PC/CLI-minted: state "paired", devices.json written) or parks it as a
 * pending ticket (device-minted: state "pending", nothing written until the minter approves). Shared by the HTTP /pair
 * route and, later, the E5 relay redeem. `token` is the value the new device must present as vs_device.
 * States: paired | pending | invalid (bad/used/expired code; a failure is recorded for `ip`) | busy (lock/unreadable).
 */
export function redeemPairCode({ rawCode, ip = "unknown", name = "Device" }) {
  const code = /^\d{3}[-\s]?\d{3}$/.test(rawCode) ? rawCode.replace(/[-\s]/g, "") : rawCode;
  const entry = codes.get(code) ?? codes.get(rawCode);
  codes.delete(code); // one-shot, even when expired
  codes.delete(rawCode);
  if (!entry || entry.expiresAt <= Date.now()) {
    recordPairFailure(ip);
    return { state: "invalid" };
  }
  pairFailuresByIp.delete(ip);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const id = randomUUID();
  if (entry.mintedBy) {
    // The minter must still be paired right now; a revoked minter's codes are dead (fail closed on an unreadable list).
    const list = loadDevices();
    const minter = list?.find((d) => d.id === entry.mintedBy);
    if (!minter) return { state: "invalid" };
    sweepPending(nowMs);
    pendingDevices.set(id, { id, tokenHash, name, ip, mintedBy: minter.id, createdAt: now, expiresAt: nowMs + PENDING_TTL_MS });
    return { state: "pending", token, pendingId: id, mintedByDeviceId: minter.id, mintedByName: minter.name };
  }
  try {
    mutateDevices((list) => list.push({ id, name, createdAt: now, lastSeenAt: now, tokenHash, mintedByDeviceId: null }), { timeoutMs: REQUEST_LOCK_MS });
  } catch {
    return { state: "busy" };
  }
  return { state: "paired", token, deviceId: id };
}

/**
 * GET /pair/status: public (both listeners), cookie-scoped. Tells the waiting page whether its vs_device token is still
 * pending, now approved (in devices.json), or gone (denied / expired / minter revoked). Reveals nothing else.
 */
const deniedTokenHashes = new Set(); // token hashes the minter denied, so the waiting page can say so (bounded; cleared past 64)
export function handlePairStatus(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (!token) return sendJson(res, 200, { state: "gone" });
  if (pendingForToken(token)) return sendJson(res, 200, { state: "pending" });
  if (authenticate(req)) return sendJson(res, 200, { state: "approved" });
  return sendJson(res, 200, { state: deniedTokenHashes.has(sha256Hex(token)) ? "denied" : "gone" });
}

/** GET /__vibesquad/pair/pending: tickets waiting on *this* paired device's Approve (the minter only). */
export function handlePairPending(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const dev = hasAgentHeaders(req) ? null : authenticate(req); // an agent (x-vs-agent-id) is never the owner (ownerProof)
  if (!dev) return sendJson(res, 403, { error: "only a paired device sees the approvals it minted" });
  sendJson(res, 200, { pending: listPendingMintedBy(dev.id), ttlMs: PENDING_TTL_MS });
}

/**
 * POST /__vibesquad/pair/approve { pendingId, approve: true|false } (E4b MUST 2). Only the device that minted the code
 * may decide. Approve appends the device with mintedByDeviceId under the lock (re-checking the minter is still on disk);
 * deny discards the ticket. A ticket past its TTL is gone either way.
 */
export async function handlePairApprove(req, res, readBody) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  const dev = hasAgentHeaders(req) ? null : authenticate(req); // an agent (x-vs-agent-id) is never the owner (ownerProof)
  if (!dev) return sendJson(res, 403, { error: "only the paired device that minted the code can approve it" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "bad request body" });
  }
  const pendingId = typeof body?.pendingId === "string" ? body.pendingId : "";
  sweepPending();
  const p = pendingDevices.get(pendingId);
  if (!p) return sendJson(res, 404, { error: "no such pending device (expired or already decided)" });
  if (p.mintedBy !== dev.id) return sendJson(res, 403, { error: "only the device that minted this code can decide it" });
  if (body?.approve !== true) {
    pendingDevices.delete(pendingId);
    if (deniedTokenHashes.size > 64) deniedTokenHashes.clear();
    deniedTokenHashes.add(p.tokenHash);
    await auditPairDecision({ approved: false, pending: p, minter: dev });
    return sendJson(res, 200, { ok: true, approved: false, pending: listPendingMintedBy(dev.id) });
  }
  // Gemini E4b L1: the ticket is removed only once the device is on disk (or the minter is gone), so a 200 ms lock
  // timeout (503, retryable) leaves the ticket for the phone's retry instead of turning it into a 404 / "gone".
  try {
    mutateDevices(
      (list) => {
        if (!list.some((d) => d.id === dev.id)) throw new Error("minter is no longer paired");
        list.push({ id: p.id, name: p.name, createdAt: p.createdAt, lastSeenAt: p.createdAt, tokenHash: p.tokenHash, mintedByDeviceId: dev.id });
      },
      { timeoutMs: REQUEST_LOCK_MS },
    );
  } catch (e) {
    if (/no longer paired/.test(String(e?.message))) {
      pendingDevices.delete(pendingId);
      return sendJson(res, 403, { error: "this device is no longer paired" });
    }
    return sendJson(res, 503, { error: "device list busy or unreadable; retry", retryable: true });
  }
  pendingDevices.delete(pendingId);
  await auditPairDecision({ approved: true, pending: p, minter: dev });
  sendJson(res, 200, { ok: true, approved: true, device: publicDevice({ ...p, mintedByDeviceId: dev.id }, dev.id), pending: listPendingMintedBy(dev.id) });
}

export const PAIR_AUDIT_TEAM = "vibesquad";
export const PAIR_AUDIT_LANE = "security";

/**
 * X1 E4b L3 / plan guard 2: every decision on a phone-minted device is written to the vs log (team log + the `security`
 * lane log under ~/.vibesquad/logs), where all paired devices see it. An approval is a `needs-you` entry (the owner should
 * know a new device exists); a denial is a `metric`. Names, IP and ids only: never a token, hash or code. Best effort:
 * the device is already recorded, so a log write failure must not fail the approval.
 */
function auditPairDecision({ approved, pending, minter }) {
  const text = approved
    ? `Security: new device "${pending.name}" (${pending.ip}) was approved by "${minter.name}". Not you? Revoke it: vs devices revoke ${pending.id.slice(0, 8)} (cascades over devices it pairs).`
    : `Security: pairing of "${pending.name}" (${pending.ip}) was denied by "${minter.name}".`;
  const refs = [`device:${pending.id}`, `mintedBy:${minter.id}`];
  return import("./brainstorm.mjs")
    .then(({ appendVsLogEntry }) => appendVsLogEntry({ teamId: PAIR_AUDIT_TEAM, laneId: PAIR_AUDIT_LANE, agent: "vibesquad-server", type: approved ? "needs-you" : "metric", text, refs }))
    .catch((e) => console.error(`[vibesquad] pair audit log failed: ${e?.message ?? e}`));
}

// ---- Loopback server proof (X1 E4a L3): the server proves it holds the local token before a CLI sends it ----

export const LOCAL_PROOF_PREFIX = "vs-local-proof";
const NONCE_RE = /^[0-9a-f]{32}$/;

/** HMAC-SHA256(localToken, prefix \0 nonce \0 port). Pure, shared with the CLI-side verifier in local-token.mjs. */
export function localProof(token, nonce, port) {
  return createHmac("sha256", token).update(`${LOCAL_PROOF_PREFIX}\0${nonce}\0${port}`).digest("hex");
}

/**
 * GET /__vibesquad/local-proof?c=<32 hex>: public on loopback. Binding the accepted socket's local port stops a rogue
 * listener on one port from relaying the challenge to a real server on another. HMAC is a PRF, so the oracle leaks nothing.
 */
export function handleLocalProof(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  if (!isLocalBrowserSafe(req)) return sendJson(res, 403, { error: "loopback only" });
  const c = String(new URL(req.url ?? "/", "http://x").searchParams.get("c") ?? "");
  if (!NONCE_RE.test(c)) return sendJson(res, 400, { error: "c must be 32 hex chars" });
  const port = Number(req.socket?.localPort ?? 0);
  sendJson(res, 200, { proof: localProof(getLocalToken(), c, port), port });
}

export function handleDevices(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  // X1 E4a M3: the inventory (ids, names, last-seen, LAN/Meshnet IPs) needs the local token or a paired cookie, here and
  // in the router (isGatedRead), so a token-less local process can't read it.
  const list = loadDevices();
  if (!list) return sendJson(res, 503, { error: "devices.json is unreadable on the PC" }); // fail closed first (X1 M2); says nothing else
  if (!ownerProof(req)) return sendJson(res, 403, { error: READ_ONLY_ERROR, readOnly: true }); // paired cookie or loopback token, never an agent
  const current = authenticate(req)?.id;
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  sendJson(res, 200, {
    devices: list.map((d) => publicDevice(d, current)),
    caFingerprint: caFingerprint(),
    meshnetHost,
    meshnetIp,
    lanIp,
    port,
    caHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/ca.crt` : null,
    desktopSetupHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/VibeSquad-setup.exe` : null,
    androidApkHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/VibeSquad.apk` : null,
    lanHttpsUrl: lanIp ? `https://${lanIp}:${port}` : null,
    lanCaUrl: lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    lanDesktopInstallerUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad-setup.exe` : null,
    lanAndroidApkUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad.apk` : null,
    androidApkAvailable: isAndroidApkBuilt(),
  });
}

export async function handleRevoke(req, res, readBody) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  if (!ownerProof(req)) return sendJson(res, 403, { error: READ_ONLY_ERROR, readOnly: true }); // paired cookie or loopback token, never an agent
  let id;
  try {
    ({ id } = await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad request body" });
  }
  if (typeof id !== "string") return sendJson(res, 400, { error: "id required" });
  let removed;
  try {
    removed = revokeDevice(id, { timeoutMs: REQUEST_LOCK_MS });
  } catch {
    // X1 E4a R2 L3: a lock timeout or unreadable file is a retryable 503, never the lock path or holder pid.
    return sendJson(res, 503, { error: "device list busy or unreadable; retry", retryable: true });
  }
  if (!removed.length) return sendJson(res, 404, { error: "no such device" });
  const current = authenticate(req)?.id;
  sendJson(res, 200, { ok: true, removed, devices: (loadDevices() ?? []).map((d) => publicDevice(d, current)) });
}
