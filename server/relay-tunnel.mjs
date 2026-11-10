// E5 host side of the VibeSquad outbound E2EE relay (docs/lanes/android-app/E5_THREAT_MODEL.md).
// The Home PC dials OUT to a dumb relay; clients (phone / Project PC browser) dial the same relay. The relay only
// routes opaque frames. Every byte that matters is inside a Noise_NK-style channel pinned to this host's X25519 key.
// UNWIRED: nothing imports this yet (serve.mjs / auth.mjs wiring is a later unit). All I/O is injected.
//
// Relay framing (JSON text frames; b = base64):
//   host <-> relay : {t:"open",cid} | {t:"msg",cid,b} | {t:"close",cid}   (relay assigns cid per client socket)
//   client <-> relay: {t:"msg",b} | {t:"close"}
// Handshake (client knows host static pubkey S out of band; relay never does anything but forward):
//   msg1 = 0x01 || e_c(32)                       client ephemeral
//   msg2 = e_h(32) || record(h2c, ctr 0, "vs-ok") host ephemeral + key confirmation (proves it holds S's private key)
//   h    = SHA256("vibesquad-relay-v1" || len(hostId) || hostId || S || e_c || e_h)
//   keys = HKDF-SHA256(ikm = DH(e_c,S) || DH(e_c,e_h), salt = h, info = "vs-relay-v1 keys", 64) -> c2h[0..32), h2c[32..64)
// Records: ctr(8, BE) || AES-256-GCM(key_dir, nonce = 0x00000000||ctr, aad = dir||ctr, plaintext) ; receiver requires
// ctr === expected, so replay, reorder and drop-then-continue all fail closed.
// AES-GCM (not ChaCha20-Poly1305) because WebCrypto, which the Android WebView / browser client must use, has no ChaCha.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROTOCOL = "vibesquad-relay-v1";
export const HS_VERSION = 0x01;
const DIR_C2H = 1;
const DIR_H2C = 2;
const TAG_LEN = 16;
export const MAX_RECORD_BYTES = 1024 * 1024; // one decrypted frame (request bodies must fit in one)
const BODY_CHUNK = 192 * 1024;
const MAX_CTR = 2n ** 53n;

// ---- host keypair ---------------------------------------------------------------------------------------------

export function defaultKeypairPath() {
  return join(process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "host-keypair.json");
}

const pubFromRaw = (raw) =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });

function toHostKey(jwk) {
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: jwk.pub, d: jwk.priv }, format: "jwk" });
  const publicRaw = Buffer.from(jwk.pub, "base64url");
  if (publicRaw.length !== 32) throw new Error("host keypair: bad public key length");
  return { privateKey, publicRaw, pubB64: publicRaw.toString("base64") };
}

/** Loads ~/.vibesquad/host-keypair.json or creates it. Creation is atomic: a 0600 temp file is hard-linked into place
 * (link fails with EEXIST if another process won the race, then we read the winner), so there is never a partial file. */
export function loadOrCreateHostKeypair(file = defaultKeypairPath()) {
  const read = () => toHostKey(JSON.parse(readFileSync(file, "utf8")));
  try {
    return read();
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  const body = JSON.stringify({ v: 1, alg: "x25519", pub: jwk.x, priv: jwk.d });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600); // no-op on Windows; the user profile ACL is the boundary there
  } catch {}
  try {
    linkSync(tmp, file);
  } catch (e) {
    if (e?.code === "EEXIST") return read();
    renameSync(tmp, file); // filesystem without hard links: best effort
    return read();
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  return read();
}

/** Short human-comparable fingerprint of a host public key (base64 or Buffer): first 16 hex of SHA-256, grouped. */
export function hostFingerprint(pub) {
  const raw = typeof pub === "string" ? Buffer.from(pub, "base64") : Buffer.from(pub);
  return createHash("sha256").update(raw).digest("hex").slice(0, 16).replace(/(.{4})(?=.)/g, "$1-");
}

// ---- records / handshake ----------------------------------------------------------------------------------------

function nonceFor(ctr) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(ctr, 4);
  return n;
}
function aadFor(dir, ctr) {
  const a = Buffer.alloc(9);
  a[0] = dir;
  a.writeBigUInt64BE(ctr, 1);
  return a;
}

/** One direction pair of AEAD state. open() throws on tamper, replay, reorder or a skipped counter. */
export function createChannel(sendKey, recvKey, sendDir, recvDir) {
  let sendCtr = 0n;
  let recvCtr = 0n;
  return {
    seal(plain) {
      const ctr = sendCtr;
      if (ctr >= MAX_CTR) throw new Error("relay channel exhausted");
      const c = createCipheriv("aes-256-gcm", sendKey, nonceFor(ctr), { authTagLength: TAG_LEN });
      c.setAAD(aadFor(sendDir, ctr));
      const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      sendCtr += 1n;
      const head = Buffer.alloc(8);
      head.writeBigUInt64BE(ctr);
      return Buffer.concat([head, ct]);
    },
    open(frame) {
      if (!Buffer.isBuffer(frame) || frame.length < 8 + TAG_LEN) throw new Error("short record");
      if (frame.length > MAX_RECORD_BYTES + 8 + TAG_LEN) throw new Error("record too large");
      const ctr = frame.readBigUInt64BE(0);
      if (ctr !== recvCtr) throw new Error("replayed or out-of-order record");
      const d = createDecipheriv("aes-256-gcm", recvKey, nonceFor(ctr), { authTagLength: TAG_LEN });
      d.setAAD(aadFor(recvDir, ctr));
      d.setAuthTag(frame.subarray(frame.length - TAG_LEN));
      const plain = Buffer.concat([d.update(frame.subarray(8, frame.length - TAG_LEN)), d.final()]);
      recvCtr += 1n;
      return plain;
    },
  };
}

export function transcriptHash(hostId, hostPub, ec, eh) {
  const id = Buffer.from(String(hostId), "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(id.length);
  return createHash("sha256").update(PROTOCOL).update(len).update(id).update(hostPub).update(ec).update(eh).digest();
}

function dhChecked(privateKey, publicKey) {
  const s = diffieHellman({ privateKey, publicKey });
  if (s.every((b) => b === 0)) throw new Error("degenerate DH output");
  return s;
}

export function deriveKeys(dhEs, dhEe, h) {
  const okm = Buffer.from(hkdfSync("sha256", Buffer.concat([dhEs, dhEe]), h, "vs-relay-v1 keys", 64));
  return { c2h: okm.subarray(0, 32), h2c: okm.subarray(32, 64) };
}

/** Host side of the handshake. Returns the reply frame to send and the established host-side channel. */
export function acceptHandshake(msg1, { hostKey, hostId }) {
  if (!Buffer.isBuffer(msg1) || msg1.length !== 33 || msg1[0] !== HS_VERSION) throw new Error("bad handshake");
  const ec = msg1.subarray(1);
  const ecPub = pubFromRaw(ec);
  const eph = generateKeyPairSync("x25519");
  const eh = Buffer.from(eph.publicKey.export({ format: "jwk" }).x, "base64url");
  const h = transcriptHash(hostId, hostKey.publicRaw, ec, eh);
  const keys = deriveKeys(dhChecked(hostKey.privateKey, ecPub), dhChecked(eph.privateKey, ecPub), h);
  const channel = createChannel(keys.h2c, keys.c2h, DIR_H2C, DIR_C2H);
  return { reply: Buffer.concat([eh, channel.seal(Buffer.from("vs-ok"))]), channel };
}

/** Reference client handshake with node:crypto (tests + tooling). The browser client is src/remoteRelayTransport.ts. */
export function startClientHandshake(hostPubRaw, hostId) {
  const eph = generateKeyPairSync("x25519");
  const ec = Buffer.from(eph.publicKey.export({ format: "jwk" }).x, "base64url");
  const msg1 = Buffer.concat([Buffer.from([HS_VERSION]), ec]);
  return {
    msg1,
    finish(msg2) {
      if (!Buffer.isBuffer(msg2) || msg2.length < 32 + 8 + TAG_LEN) throw new Error("bad handshake reply");
      const eh = msg2.subarray(0, 32);
      const ehPub = pubFromRaw(eh);
      const S = pubFromRaw(hostPubRaw);
      const h = transcriptHash(hostId, hostPubRaw, ec, eh);
      const keys = deriveKeys(dhChecked(eph.privateKey, S), dhChecked(eph.privateKey, ehPub), h);
      const channel = createChannel(keys.c2h, keys.h2c, DIR_C2H, DIR_H2C);
      if (channel.open(msg2.subarray(32)).toString() !== "vs-ok") throw new Error("host key confirmation failed");
      return channel;
    },
  };
}

// ---- reconnect backoff --------------------------------------------------------------------------------------------

/** Exponential backoff with +/- jitter: base*2^attempt capped at max, then scaled by (1 +/- jitter). attempt starts at 0. */
export function backoffDelay(attempt, { base = 1000, max = 60_000, jitter = 0.3, rand = Math.random } = {}) {
  const raw = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.max(0, Math.round(raw * (1 + (rand() * 2 - 1) * jitter)));
}

// ---- S4/R2 allowlist ------------------------------------------------------------------------------------------------
// No shared constant exists: server/vibesquad-api.mjs isGatedRead() is a loopback read-only gate, not a remote
// allowlist, and importing it would drag the whole API module in. This is the relay's own pure, default-deny filter.

export const RELAY_ALLOWED_ROOTS = ["/__vibesquad/", "/api/"];
export const RELAY_DENIED_PREFIXES = [
  "/__vibesquad/first-run", // machine setup state / installers
  "/__vibesquad/local-image", // arbitrary local file contents
  "/__vibesquad/pair/redeem", // codes are redeemed inside the encrypted channel only
  "/__vibesquad/enter", // cookie-hop for the direct (non-relay) transport
];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** True only for a well-formed same-origin path under an allowed root and not under a denied prefix. */
export function isRelayPathAllowed(method, target) {
  if (!METHODS.has(String(method).toUpperCase())) return false;
  if (typeof target !== "string" || target.length > 4096 || !target.startsWith("/") || target.startsWith("//")) return false;
  if (/[\u0000-\u001f\u007f\\#]/.test(target)) return false;
  const pathname = target.split("?")[0];
  const segs = pathname.split("/").slice(1);
  const decoded = [];
  for (const s of segs) {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      return false;
    }
    if (d === "." || d === ".." || /[/\\\u0000]/.test(d)) return false;
    if (d !== s && /%[0-9a-f]{2}/i.test(d)) return false; // double-encoding
    decoded.push(d);
  }
  const norm = `/${decoded.join("/")}`.toLowerCase();
  // norm is the DECODED, lowercased path, so /%5f%5fvibesquad/first-run can't dodge the deny list. Plain startsWith
  // also catches siblings like /first-run-status.
  if (RELAY_DENIED_PREFIXES.some((p) => norm.startsWith(p))) return false;
  return norm === "/ws" || RELAY_ALLOWED_ROOTS.some((r) => norm.startsWith(r));
}

const FORWARD_HEADERS = new Set(["content-type", "accept", "if-none-match", "if-modified-since", "range"]);
const pickHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
    if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
};

// ---- the tunnel -------------------------------------------------------------------------------------------------------

/**
 * createRelayHost({ endpoint, hostId, hostKey, redeem, authenticate, handleHttp, openWs, ... })
 *   redeem({ code, label }) -> { deviceId, token } | null        (wiring calls auth.mjs; this module never writes devices.json)
 *   authenticate(token)     -> { deviceId } | null
 *   handleHttp({ method, path, headers, body: Buffer, deviceId }) -> { status, headers?, body? }   (loopback handler)
 *   openWs({ path, deviceId, send(data, binary), close(code?) }) -> { message(data, binary), close() } | null
 * Injected for tests: WebSocketImpl, setTimeoutFn/clearTimeoutFn, rand, onEvent.
 */
export function createRelayHost(opts) {
  const {
    endpoint,
    hostId,
    hostKey,
    redeem,
    authenticate,
    handleHttp,
    openWs,
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    rand = Math.random,
    onEvent = () => {},
    backoff = {},
    maxSessions = 32,
    authTimeoutMs = 30_000,
    maxRedeemAttempts = 5,
    maxHttpPerSession = 16,
    maxWsPerSession = 8,
  } = opts;
  let sock = null;
  let attempt = 0;
  let timer = null;
  let stopped = true;
  const sessions = new Map(); // cid -> session

  const url = () => {
    const u = new URL(endpoint);
    if (!u.pathname.endsWith("/ws")) u.pathname = `${u.pathname.replace(/\/$/, "")}/ws`;
    u.searchParams.set("hostId", hostId);
    u.searchParams.set("role", "host");
    return u.toString();
  };
  const relaySend = (obj) => {
    try {
      if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
    } catch {}
  };

  function closeSession(cid, notifyRelay = true) {
    const s = sessions.get(cid);
    if (!s) return;
    sessions.delete(cid);
    if (s.authTimer) clearTimeoutFn(s.authTimer);
    for (const w of s.ws.values()) {
      try {
        w.close();
      } catch {}
    }
    s.ws.clear();
    s.dead = true;
    if (notifyRelay) relaySend({ t: "close", cid });
  }

  function send(s, obj) {
    if (s.dead || !s.channel) return;
    try {
      relaySend({ t: "msg", cid: s.cid, b: s.channel.seal(Buffer.from(JSON.stringify(obj))).toString("base64") });
    } catch {
      closeSession(s.cid);
    }
  }

  async function dispatch(s, m) {
    const id = typeof m.id === "string" ? m.id.slice(0, 64) : "";
    if (m.t === "redeem") {
      if (s.deviceId) return send(s, { t: "redeem-res", id, ok: false });
      if (++s.redeems > maxRedeemAttempts) return closeSession(s.cid);
      const r = await redeem({ code: String(m.code ?? ""), label: typeof m.label === "string" ? m.label.slice(0, 80) : "" });
      if (s.dead) return;
      if (!r?.token || !r.deviceId) return send(s, { t: "redeem-res", id, ok: false });
      s.deviceId = String(r.deviceId);
      if (s.authTimer) clearTimeoutFn(s.authTimer);
      return send(s, { t: "redeem-res", id, ok: true, deviceId: s.deviceId, token: r.token });
    }
    if (m.t === "auth") {
      if (s.deviceId) return send(s, { t: "auth-res", id, ok: false });
      if (++s.redeems > maxRedeemAttempts) return closeSession(s.cid);
      const r = await authenticate(String(m.token ?? ""));
      if (s.dead) return;
      if (!r?.deviceId) return send(s, { t: "auth-res", id, ok: false });
      s.deviceId = String(r.deviceId);
      if (s.authTimer) clearTimeoutFn(s.authTimer);
      return send(s, { t: "auth-res", id, ok: true, deviceId: s.deviceId });
    }
    if (!s.deviceId) return closeSession(s.cid); // anything else before redeem/auth is a protocol violation
    if (m.t === "http") {
      if (s.http >= maxHttpPerSession) return send(s, { t: "http-res", id, status: 429, headers: {} });
      const method = String(m.method ?? "GET").toUpperCase();
      if (!isRelayPathAllowed(method, m.path)) {
        onEvent({ type: "denied", deviceId: s.deviceId, method, path: String(m.path).slice(0, 200) });
        return send(s, { t: "http-res", id, status: 403, headers: {}, fin: true });
      }
      s.http++;
      try {
        const body = m.b ? Buffer.from(String(m.b), "base64") : Buffer.alloc(0);
        const r = await handleHttp({ method, path: m.path, headers: pickHeaders(m.headers), body, deviceId: s.deviceId });
        if (s.dead) return;
        const buf = r?.body == null ? Buffer.alloc(0) : Buffer.from(r.body);
        send(s, { t: "http-res", id, status: r?.status ?? 500, headers: r?.headers ?? {} });
        for (let o = 0; o < buf.length; o += BODY_CHUNK) {
          send(s, { t: "http-body", id, b: buf.subarray(o, o + BODY_CHUNK).toString("base64") });
        }
        send(s, { t: "http-body", id, b: "", fin: true });
      } catch {
        send(s, { t: "http-res", id, status: 502, headers: {}, fin: true });
      } finally {
        s.http--;
      }
      return;
    }
    if (m.t === "ws-open") {
      if (s.ws.size >= maxWsPerSession || s.ws.has(id) || !id || !isRelayPathAllowed("GET", m.path)) {
        return send(s, { t: "ws-open-res", id, ok: false });
      }
      const handle = await openWs({
        path: m.path,
        deviceId: s.deviceId,
        send: (data, binary) =>
          send(s, { t: "ws-data", id, bin: Boolean(binary), data: binary ? Buffer.from(data).toString("base64") : String(data) }),
        close: (code) => {
          if (s.ws.delete(id)) send(s, { t: "ws-close", id, code: code ?? 1000 });
        },
      });
      if (s.dead) return void handle?.close();
      if (!handle) return send(s, { t: "ws-open-res", id, ok: false });
      s.ws.set(id, handle);
      return send(s, { t: "ws-open-res", id, ok: true });
    }
    if (m.t === "ws-data") {
      const h = s.ws.get(id);
      if (h) h.message(m.bin ? Buffer.from(String(m.data), "base64") : String(m.data), Boolean(m.bin));
      return;
    }
    if (m.t === "ws-close") {
      const h = s.ws.get(id);
      if (h && s.ws.delete(id)) h.close();
    }
  }

  function onRelayMessage(raw) {
    let f;
    try {
      f = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    const cid = typeof f?.cid === "string" ? f.cid.slice(0, 64) : "";
    if (!cid) return;
    if (f.t === "close") return closeSession(cid, false);
    if (f.t === "open") {
      if (sessions.has(cid)) return;
      if (sessions.size >= maxSessions) return relaySend({ t: "close", cid });
      const s = { cid, channel: null, deviceId: null, redeems: 0, http: 0, ws: new Map(), dead: false, authTimer: null };
      s.authTimer = setTimeoutFn(() => closeSession(cid), authTimeoutMs);
      sessions.set(cid, s);
      return;
    }
    if (f.t !== "msg") return;
    const s = sessions.get(cid);
    if (!s || typeof f.b !== "string") return;
    let bytes;
    try {
      bytes = Buffer.from(f.b, "base64");
      if (!s.channel) {
        const { reply, channel } = acceptHandshake(bytes, { hostKey, hostId });
        s.channel = channel;
        return relaySend({ t: "msg", cid, b: reply.toString("base64") });
      }
      const m = JSON.parse(s.channel.open(bytes).toString("utf8"));
      if (!m || typeof m !== "object") throw new Error("bad frame");
      dispatch(s, m).catch(() => closeSession(cid));
    } catch (e) {
      onEvent({ type: "session-error", cid, deviceId: s.deviceId, reason: String(e?.message ?? e) });
      closeSession(cid);
    }
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(url());
    } catch {
      return schedule();
    }
    sock = ws;
    ws.addEventListener("open", () => {
      if (sock !== ws) return;
      attempt = 0;
      onEvent({ type: "connected" });
    });
    ws.addEventListener("message", (ev) => {
      if (sock === ws) onRelayMessage(ev.data);
    });
    const down = () => {
      if (sock !== ws) return;
      sock = null;
      for (const cid of [...sessions.keys()]) closeSession(cid, false);
      onEvent({ type: "disconnected" });
      schedule();
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {}
      down();
    });
  }
  function schedule() {
    if (stopped || timer) return;
    const delay = backoffDelay(attempt++, { ...backoff, rand });
    onEvent({ type: "reconnect-scheduled", delay, attempt });
    timer = setTimeoutFn(() => {
      timer = null;
      connect();
    }, delay);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
      timer = null;
      for (const cid of [...sessions.keys()]) closeSession(cid, false);
      const s = sock;
      sock = null;
      try {
        s?.close();
      } catch {}
    },
    /** Immediately closes every relay session authenticated as deviceId. Returns how many were closed. */
    revoke(deviceId) {
      let n = 0;
      for (const s of [...sessions.values()]) {
        if (s.deviceId === deviceId) {
          closeSession(s.cid);
          n++;
        }
      }
      return n;
    },
    revokeAll() {
      const n = sessions.size;
      for (const cid of [...sessions.keys()]) closeSession(cid);
      return n;
    },
    status: () => ({ connected: sock?.readyState === 1, sessions: sessions.size, attempt }),
  };
}
