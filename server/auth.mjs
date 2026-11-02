import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { ensureLocalToken, LOCAL_TOKEN_FILE, LOCAL_TOKEN_HEADER, localTokenPath } from "./local-token.mjs";
import { qrSvg } from "./qr.mjs";
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

export function getAuthStatus(rootDir = DEFAULT_ROOT_DIR) {
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  const distReady = hasDistIndex(rootDir);
  return {
    ok: true,
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

// Secrets that live directly in ~/.vibesquad (VAPID private key, device token hashes, push endpoints).
const HOME_SECRET_FILES = ["vapid.json", "devices.json", "push-subs.json", LOCAL_TOKEN_FILE];

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

export function caCrtPem() {
  const file = join(tlsDir(), "ca.crt");
  if (!existsSync(file)) try { getTls(); } catch {}
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

let devices; // [{ id, name, createdAt, lastSeenAt, tokenHash }]
let lastPersist = 0;

function loadDevices() {
  if (devices) return devices;
  const { value } = readJsonFileWithBom(devicesFile(), { fallback: { devices: [] }, label: "devices.json" });
  devices = Array.isArray(value?.devices) ? value.devices : [];
  return devices;
}

function saveDevices() {
  mkdirSync(vibesquadHome(), { recursive: true });
  const tmp = devicesFile() + ".tmp";
  writeFileSync(tmp, JSON.stringify({ devices: loadDevices() }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, devicesFile());
  clearConfigWarning(devicesFile());
  lastPersist = Date.now();
}

const publicDevice = (d, currentId) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d.id === currentId });

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The paired, non-revoked device behind this request's vs_device cookie, or null. */
export function authenticate(req) {
  const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (!token) return null;
  const hash = Buffer.from(sha256Hex(token), "hex");
  const dev = loadDevices().find((d) => {
    const want = Buffer.from(String(d.tokenHash ?? ""), "hex");
    return want.length === hash.length && timingSafeEqual(want, hash);
  });
  if (!dev) return null;
  const now = Date.now();
  dev.lastSeenAt = new Date(now).toISOString();
  if (now - lastPersist > 60_000) saveDevices();
  return dev;
}

// The loopback listener is the PC itself, but not only its owner (other apps, other Windows users):
// owner access there needs the local token (header) or the vs_local cookie the launcher sets.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLocal = (req) => LOOPBACK.has(req.socket.localAddress ?? "");

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
  if (!isLocal(req)) return false;
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

/** True when the request carries the local token header or the vs_local cookie. Says nothing about the listener. */
export function hasLocalToken(req) {
  const token = getLocalToken();
  const header = req.headers[LOCAL_TOKEN_HEADER];
  if (typeof header === "string" && sameSecret(header.trim(), token)) return true;
  const cookie = parseCookies(req.headers.cookie)[LOCAL_COOKIE];
  return Boolean(cookie) && sameSecret(cookie, localCookieValue(token));
}

/** Owner on loopback: the existing Host/Origin checks plus the local token. */
export const isLocalOwner = (req) => isLocalBrowserSafe(req) && hasLocalToken(req);

/** True only for the x-vibesquad-token header (never the cookie): the nonce endpoint is for CLI/launcher callers. */
export function hasLocalTokenHeader(req) {
  const header = req.headers[LOCAL_TOKEN_HEADER];
  return typeof header === "string" && sameSecret(header.trim(), getLocalToken());
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

// ---- Live /ws sockets per device, so revocation cuts them immediately ----

const wsByDevice = new Map(); // deviceId -> Set<socket>

export function trackSocket(deviceId, socket) {
  let set = wsByDevice.get(deviceId);
  if (!set) wsByDevice.set(deviceId, (set = new Set()));
  set.add(socket);
  socket.once("close", () => {
    set.delete(socket);
    if (!set.size) wsByDevice.delete(deviceId);
  });
}

export function revokeDevice(id) {
  const list = loadDevices();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  saveDevices();
  for (const s of wsByDevice.get(id) ?? []) s.destroy();
  wsByDevice.delete(id);
  return true;
}

// ---- One-time pairing codes ----

const codes = new Map(); // code -> expiresAt
const PAIR_WINDOW_MS = 60_000;
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

export function createPairCode(ttlMs = CODE_TTL_MS) {
  sweepCodes();
  let code = String(randomInt(100_000, 1_000_000));
  while (codes.has(code)) code = String(randomInt(100_000, 1_000_000));
  codes.set(code, Date.now() + ttlMs);
  return code;
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

function sweepCodes() {
  const now = Date.now();
  for (const [c, exp] of codes) if (exp <= now) codes.delete(c);
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

function sendHtml(res, code, title, message) {
  res.statusCode = code;
  res.setHeader("content-type", "text/html; charset=utf-8");
  setNoFraming(res);
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end(htmlPage(title, message));
}

export function htmlPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070710;color:#eef2ff;font-family:"JetBrains Mono",Consolas,monospace}
.card{max-width:480px;margin:16px;padding:22px;background:#111326;border:1px solid #ff2a85;box-shadow:0 0 24px #ff2a8530}
h1{margin:0 0 10px;font-size:18px;color:#ff2a85;letter-spacing:1px;text-transform:uppercase}p{margin:0;line-height:1.5;color:#828ba8}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export const UNPAIRED_MESSAGE = "Unpaired device — open VibeSquad on your PC, click Pair a device, install the CA certificate if needed, and scan the QR code.";

/** 401 for an unpaired Meshnet/LAN request: JSON for API/JSON clients, neon-noir HTML for browser navigation. */
export function sendUnpaired(req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/__vibesquad/") || String(req.headers.accept ?? "").includes("application/json")) return sendJson(res, 401, { error: "unpaired device" });
  sendHtml(res, 401, "Unpaired device", UNPAIRED_MESSAGE);
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

export async function handlePairStart(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  if (!isLocalBrowserSafe(req) && !authenticate(req)) {
    return sendJson(res, 403, { error: "pairing can only be started from the PC" });
  }
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  if (!meshnetIp && !lanIp) {
    return sendJson(res, 503, { error: "no LAN or Meshnet IP detected (check Wi-Fi/Ethernet or NordVPN Meshnet)" });
  }
  const effectiveMeshnetIp = meshnetIp || DEFAULT_MESHNET_IP;
  getTls();
  const code = createPairCode();
  const expiresAt = codes.get(code);
  const pairUrl = `https://${meshnetHost}:${port}/pair?code=${code}`;
  const pairIpUrl = `https://${effectiveMeshnetIp}:${port}/pair?code=${code}`;
  const lanPairUrl = lanIp ? `https://${lanIp}:${port}/pair?code=${code}` : null;
  sendJson(res, 200, {
    code,
    pairUrl,
    pairIpUrl,
    lanIp,
    lanHttpsUrl: lanIp ? `https://${lanIp}:${port}` : null,
    lanCaUrl: lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    lanDesktopInstallerUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad-setup.exe` : null,
    lanPairUrl,
    lanQrSvg: lanPairUrl ? await qrSvg(lanPairUrl) : null,
    caHttpUrl: `http://${effectiveMeshnetIp}:${port}/ca.crt`,
    desktopSetupHttpUrl: `http://${effectiveMeshnetIp}:${port}/VibeSquad-setup.exe`,
    caFingerprint: caFingerprint(),
    meshnetHost,
    meshnetIp: effectiveMeshnetIp,
    expiresAt,
    qrSvg: await qrSvg(pairUrl),
    qrSvgIp: await qrSvg(pairIpUrl),
  });
}

export function handlePairRedeem(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
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
  const code = /^\d{3}[-\s]?\d{3}$/.test(rawCode) ? rawCode.replace(/[-\s]/g, "") : rawCode;
  const exp = codes.get(code) ?? codes.get(rawCode);
  codes.delete(code); // one-shot, even when expired
  codes.delete(rawCode);
  if (!exp || exp <= Date.now()) {
    recordPairFailure(ip);
    return sendHtml(res, 401, "Pairing failed", "This pairing code is invalid, already used, or expired. Generate a new QR code on your PC.");
  }
  pairFailuresByIp.delete(ip);
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const name = (q.get("name") || deviceNameFromUa(String(req.headers["user-agent"] ?? ""))).slice(0, 40);
  loadDevices().push({ id: randomUUID(), name, createdAt: now, lastSeenAt: now, tokenHash: sha256Hex(token) });
  saveDevices();
  res.statusCode = 302;
  res.setHeader("set-cookie", `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`);
  res.setHeader("location", "/");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.end();
}

export function handleDevices(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const { port, meshnetIp, meshnetHost, lanIp } = netConfig();
  const current = authenticate(req)?.id;
  sendJson(res, 200, {
    devices: loadDevices().map((d) => publicDevice(d, current)),
    caFingerprint: caFingerprint(),
    meshnetHost,
    meshnetIp,
    lanIp,
    port,
    caHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/ca.crt` : null,
    desktopSetupHttpUrl: meshnetIp ? `http://${meshnetIp}:${port}/VibeSquad-setup.exe` : null,
    lanHttpsUrl: lanIp ? `https://${lanIp}:${port}` : null,
    lanCaUrl: lanIp ? `http://${lanIp}:${port}/ca.crt` : null,
    lanDesktopInstallerUrl: lanIp ? `http://${lanIp}:${port}/VibeSquad-setup.exe` : null,
  });
}

export async function handleRevoke(req, res, readBody) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const { id } = await readBody(req);
    if (typeof id !== "string") return sendJson(res, 400, { error: "id required" });
    if (!revokeDevice(id)) return sendJson(res, 404, { error: "no such device" });
    const current = authenticate(req)?.id;
    sendJson(res, 200, { ok: true, devices: loadDevices().map((d) => publicDevice(d, current)) });
  } catch (e) {
    sendJson(res, 400, { error: String(e) });
  }
}
