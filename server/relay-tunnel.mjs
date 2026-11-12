// E5 host side of the VibeSquad outbound E2EE relay (docs/lanes/android-app/E5_THREAT_MODEL.md).
// The Home PC dials OUT to a dumb relay; clients (phone / Project PC browser) dial the same relay. The relay only
// routes opaque frames. Every byte that matters is inside a Noise_NK-style channel pinned to this host's X25519 key.
// Wired by server/relay-wiring.mjs (serve.mjs starts it when ~/.vibesquad/settings.json has relay.endpoint; off by
// default). All I/O is injected: this module never reads devices.json or touches a socket of its own.
//
// Relay framing (JSON text frames; b = base64):
//   host <-> relay : {t:"open",cid} | {t:"msg",cid,b} | {t:"close",cid}   (relay assigns cid per client socket)
//   client <-> relay: {t:"msg",b} | {t:"close"}
// Handshake (client knows host static pubkey S out of band; relay never does anything but forward):
//   msg1 = 0x01 || e_c(32)                       client ephemeral
//   msg2 = e_h(32) || record(h2c, ctr 0, "vs-ok") host ephemeral + key confirmation (proves it holds S's private key)
//   h    = SHA256("vibesquad-relay-v1" || "Noise_NK_25519_AESGCM_SHA256" || version || len(hostId) || hostId || S || e_c || e_h)
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
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";

export const PROTOCOL = "vibesquad-relay-v1";
const SUITE = "Noise_NK_25519_AESGCM_SHA256"; // hashed into the transcript with the version byte (design review M4)
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
  try {
    chmodSync(dirname(file), 0o700); // mkdir's mode does not tighten an existing directory
  } catch {}
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
    // no hard links (EPERM on some filesystems): create exclusively; never replace a key another process just made
    try {
      const fd2 = openSync(file, "wx", 0o600);
      try {
        writeSync(fd2, body);
      } finally {
        closeSync(fd2);
      }
    } catch (e2) {
      if (e2?.code !== "EEXIST") throw e2;
    }
    return read();
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  return read();
}

/**
 * `vs host-key rotate` (threat model T11 / §7 item 3): a fresh keypair replaces the file atomically (new key written
 * exclusively to a temp path, then renamed over the old one), so there is never a moment without a key and a server
 * that reads mid-rotation sees either the old or the new key, never a partial file. Every client pinned to the old key
 * fails its next handshake and needs a new pairing link; the caller decides what to do with devices.json (the CLI
 * revokes every device unless told otherwise, since a leaked host key may have been used to phish tokens).
 * Returns the new key. Never logs or returns the private half.
 */
export function rotateHostKeypair(file = defaultKeypairPath()) {
  const tmp = `${file}.rotate.${process.pid}.${randomBytes(4).toString("hex")}`;
  const next = loadOrCreateHostKeypair(tmp); // exclusive create + 0600, same directory
  try {
    renameSync(tmp, file); // replaces an existing file on both POSIX and Windows
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  try {
    chmodSync(file, 0o600);
  } catch {}
  return next;
}

/**
 * Identity of the keypair file so a running host can notice a rotation: path + mtime + size + the first 16 hex of a
 * SHA-256 of the bytes. The content hash is what catches a rotation inside one mtime tick (~15.6ms on Windows; key
 * size never changes). In-memory comparison only: never log or return this stamp (the hash covers the private key).
 */
export function keypairFileStamp(file = defaultKeypairPath()) {
  let st, bytes;
  try {
    st = statSync(file, { throwIfNoEntry: false });
    if (!st) return `${file}|missing`;
    bytes = readFileSync(file);
  } catch (e) {
    if (e?.code === "ENOENT") return `${file}|missing`;
    // Mid-rename/locked: never throw from the poller; a distinct stamp makes it try one load (keeps the old key on failure) and then stay quiet until the file reads again.
    return `${file}|unreadable`;
  }
  return `${file}|${st.mtimeMs}|${st.size}|${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
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
      if (plain.length > MAX_RECORD_BYTES) throw new RangeError("record too large");
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

export function transcriptHash(hostId, hostPub, ec, eh, version = HS_VERSION) {
  const id = Buffer.from(String(hostId), "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(id.length);
  return createHash("sha256")
    .update(PROTOCOL)
    .update(SUITE)
    .update(Buffer.from([version]))
    .update(len)
    .update(id)
    .update(hostPub)
    .update(ec)
    .update(eh)
    .digest();
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

// ---- S4/R2 allowlist + path normalization ---------------------------------------------------------------------------
// No shared constant exists: server/vibesquad-api.mjs isGatedRead() is a loopback read-only gate, not a remote
// allowlist, and importing it would drag the whole API module in. This is the relay's own pure, default-deny filter.

export const RELAY_ALLOWED_ROOTS = ["/__vibesquad/", "/api/"];
export const RELAY_DENIED_PREFIXES = [
  "/__vibesquad/first-run", // machine setup state / installers
  "/__vibesquad/local-image", // arbitrary local file contents
  "/__vibesquad/pair/redeem", // codes are redeemed inside the encrypted channel only
  "/__vibesquad/enter", // cookie-hop for the direct (non-relay) transport
  "/__vibesquad/local-login", // loopback bootstrap (+ /nonce): defense in depth, relayed callers are never local
];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Canonicalizes a request target ONCE and judges that canonical form. Returns { pathname, query, path } or null.
 * Each segment is decoded, rejected if it is a dot segment / contains a slash, backslash or control char / is
 * double-encoded, then re-encoded with encodeURIComponent. `path` is what must be forwarded: the validator and the
 * consumer (handleHttp / openWs / the in-process dispatcher) therefore see the same string, never the raw input.
 */
export function normalizeRelayTarget(method, target) {
  if (!METHODS.has(String(method).toUpperCase())) return null;
  if (typeof target !== "string" || target.length > 4096 || !target.startsWith("/") || target.startsWith("//")) return null;
  if (/[\u0000-\u001f\u007f\\#]/.test(target)) return null;
  const qi = target.indexOf("?");
  const rawPath = qi < 0 ? target : target.slice(0, qi);
  const query = qi < 0 ? "" : target.slice(qi);
  const segs = rawPath.split("/").slice(1);
  const decoded = [];
  const encoded = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      return null;
    }
    if (d === "." || d === ".." || /[/\\\u0000-\u001f\u007f]/.test(d)) return null;
    if (d === "" && i < segs.length - 1) return null; // //
    if (d !== s && /%[0-9a-f]{2}/i.test(d)) return null; // double-encoding
    decoded.push(d);
    encoded.push(encodeURIComponent(d));
  }
  const norm = `/${decoded.join("/")}`.toLowerCase();
  if (RELAY_DENIED_PREFIXES.some((p) => norm.startsWith(p))) return null; // also catches siblings like /first-run-status
  if (!(norm === "/ws" || RELAY_ALLOWED_ROOTS.some((r) => norm.startsWith(r)))) return null;
  const pathname = `/${encoded.join("/")}`;
  return { pathname, query, path: pathname + query };
}

/** True only for a well-formed same-origin path under an allowed root and not under a denied prefix. */
export const isRelayPathAllowed = (method, target) => normalizeRelayTarget(method, target) !== null;

const FORWARD_HEADERS = new Set(["content-type", "accept", "if-none-match", "if-modified-since", "range"]);
const pickHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
    if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
};
const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2"]);
const cleanResponseHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
    const key = k.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(key) || v == null) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
};

// ---- in-process dispatch (design review H1) ---------------------------------------------------------------------------
// NEVER proxy relayed traffic through a real loopback fetch: auth.mjs isLocalBrowserSafe() would treat the relayed
// device as the PC itself. The wiring layer calls the server's request listener in-process with a synthetic request
// that carries req.relayDevice and a NON-loopback socket address; auth must treat any request with relayDevice as
// remote (isRelayRequest below) and authenticate() must honor relayDevice instead of cookies/tokens.

export const isRelayRequest = (req) => Boolean(req?.relayDevice?.id);

/** An IncomingMessage-shaped Readable. headers hold only the filtered client headers; no cookie/authorization/host. */
export function createSyntheticRequest({ method, path, headers = {}, body = Buffer.alloc(0), deviceId }) {
  const req = Readable.from(body.length ? [body] : []);
  const socket = { remoteAddress: "relay", localAddress: "relay", remotePort: 0, encrypted: true, destroyed: false, destroy() {}, on() {} };
  Object.assign(req, {
    method,
    url: path,
    headers: { ...headers, host: "relay.invalid" }, // obviously synthetic; routers that build URLs from it keep working
    httpVersion: "1.1",
    socket,
    connection: socket,
    relayDevice: Object.freeze({ id: String(deviceId) }),
  });
  return req;
}

/** A ServerResponse-shaped Writable that records status/headers/body. set-cookie never survives. */
export function createSyntheticResponse() {
  const chunks = [];
  const headers = new Map();
  let total = 0;
  const res = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length;
      res.bytesWritten = total;
      if (total > res.maxBodyBytes) return cb(new Error("response too large"));
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  Object.assign(res, {
    statusCode: 200,
    maxBodyBytes: 32 * 1024 * 1024,
    bytesWritten: 0,
    setHeader(k, v) {
      headers.set(String(k).toLowerCase(), v);
      return res;
    },
    getHeader: (k) => headers.get(String(k).toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    hasHeader: (k) => headers.has(String(k).toLowerCase()),
    removeHeader: (k) => void headers.delete(String(k).toLowerCase()),
    flushHeaders() {},
    writeHead(status, a, b) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(typeof a === "object" && a ? a : (b ?? {}))) headers.set(k.toLowerCase(), v);
      return res;
    },
    result: () => ({ status: res.statusCode, headers: cleanResponseHeaders(Object.fromEntries(headers)), body: Buffer.concat(chunks) }),
  });
  Object.defineProperty(res, "headersSent", { get: () => res.writableLength > 0 || res.writableEnded || res.writableFinished || res.bytesWritten > 0, enumerable: true });
  return res;
}

/** Adapts a node (req, res) request listener into the tunnel's handleHttp, fully in-process. */
export function createInProcessDispatcher(requestListener, { timeoutMs = 60_000, maxBodyBytes } = {}) {
  return ({ method, path, headers, body, deviceId }) =>
    new Promise((resolve) => {
      const req = createSyntheticRequest({ method, path, headers, body, deviceId });
      const res = createSyntheticResponse();
      if (maxBodyBytes) res.maxBodyBytes = maxBodyBytes;
      let done = false;
      let timer = null;
      const finish = (status) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(status ? { status, headers: {}, body: Buffer.alloc(0) } : res.result());
      };
      timer = setTimeout(() => finish(504), timeoutMs);
      res.on("finish", () => finish());
      res.on("error", () => finish(502));
      Promise.resolve(requestListener(req, res)).catch(() => finish(500));
    });
}

const TEXT_TYPE_RE = /^(text\/|application\/(json|javascript|x-ndjson))/i;

/**
 * The `openWs` bridge for a server that has no WebSocket endpoint (the app streams over SSE): a relayed `ws-open` on
 * `path` runs an in-process GET through the same request listener (same relayDevice principal, same auth gates) and
 * forwards every response chunk as a `ws-data` frame while the handler keeps writing, which is what `/…/events` SSE
 * routes need (the buffering dispatcher above would hold them until its timeout). A non-2xx answer closes the stream
 * with code 4000 + status and sends no body; the handler finishing closes it with 1000; the client closing (or a revoke
 * closing the session) destroys the synthetic request/response so the handler's own close listeners run.
 * The request starts on the next macrotask, after the host has answered `ws-open-res`, so no chunk overtakes the open.
 */
export function createInProcessStreamBridge(requestListener, { maxBodyBytes } = {}) {
  return ({ path, deviceId, send, close }) =>
    new Promise((resolve) => {
      let ended = false;
      let text = true;
      const req = createSyntheticRequest({ method: "GET", path, headers: { accept: "text/event-stream, */*" }, deviceId });
      let total = 0;
      const limit = maxBodyBytes ?? 32 * 1024 * 1024;
      const finish = (code) => {
        if (ended) return;
        ended = true;
        try {
          close(code);
        } catch {}
        try {
          req.destroy();
        } catch {}
        try {
          res.destroy();
        } catch {}
      };
      const res = new Writable({
        write(chunk, _enc, cb) {
          if (ended) return cb();
          const buf = Buffer.from(chunk);
          total += buf.length;
          if (total > limit) {
            finish(1009);
            return cb();
          }
          if (res.statusCode < 200 || res.statusCode >= 300) return cb(); // body of an error answer never reaches the client
          if (text) send(buf.toString("utf8"), false);
          else send(buf, true);
          cb();
        },
        final(cb) {
          finish(res.statusCode >= 200 && res.statusCode < 300 ? 1000 : 4000 + Math.min(res.statusCode, 999));
          cb();
        },
      });
      const headers = new Map();
      const noteType = () => {
        const ct = String(headers.get("content-type") ?? "");
        text = ct === "" || TEXT_TYPE_RE.test(ct);
      };
      Object.assign(res, {
        statusCode: 200,
        setHeader(k, v) {
          headers.set(String(k).toLowerCase(), v);
          noteType();
          return res;
        },
        getHeader: (k) => headers.get(String(k).toLowerCase()),
        getHeaders: () => Object.fromEntries(headers),
        hasHeader: (k) => headers.has(String(k).toLowerCase()),
        removeHeader: (k) => void headers.delete(String(k).toLowerCase()),
        flushHeaders() {},
        writeHead(status, a, b) {
          res.statusCode = status;
          for (const [k, v] of Object.entries(typeof a === "object" && a ? a : (b ?? {}))) headers.set(k.toLowerCase(), v);
          noteType();
          return res;
        },
      });
      Object.defineProperty(res, "headersSent", { get: () => total > 0 || res.writableEnded || res.writableFinished, enumerable: true });
      res.on("error", () => finish(1011));
      // Gemini wire R1 #1: finish() is the one teardown path (it destroys req too). A handler that ends or destroys res
      // directly, without going through final(), still lands here, so req emits "close" and req-only cleanup (e.g.
      // terminals-api.mjs req.on("close")) runs instead of leaking until the session dies. finish() is idempotent.
      res.on("close", () => finish(1000));
      const handle = {
        message() {}, // one-way: the app never sends over its event streams
        close() {
          finish(1000);
        },
      };
      resolve(handle);
      setImmediate(() => {
        if (ended) return;
        Promise.resolve()
          .then(() => requestListener(req, res))
          .catch(() => finish(1011));
      });
    });
}

// ---- the tunnel -------------------------------------------------------------------------------------------------------

const MAX_WIRE_CHARS = Math.ceil(((MAX_RECORD_BYTES + 8 + TAG_LEN) * 4) / 3) + 512; // raw relay frame, before JSON/base64
const rawSize = (raw) => (typeof raw === "string" ? raw.length : (raw?.byteLength ?? raw?.length ?? Infinity));

/**
 * createRelayHost({ endpoint, hostId, hostKey, redeem, authenticate, handleHttp, openWs, ... })
 *   redeem({ code, label }) -> { deviceId, token } | null        (wiring calls auth.mjs; this module never writes devices.json)
 *   authenticate(token)     -> { deviceId } | null
 *   isRevoked(deviceId)     -> boolean | Promise<boolean>        (re-checked on EVERY post-auth dispatch; CLI revokes run out of process)
 *   handleHttp({ method, path, headers, body: Buffer, deviceId }) -> { status, headers?, body? }   path is canonical; see createInProcessDispatcher
 *   openWs({ path, deviceId, send(data, binary), close(code?) }) -> { message(data, binary), close() } | null
 *   burnCodes()             -> void   (H2: invalidate every outstanding pairing code)
 *   onNeedsYou(event)       -> void   (H2/R1#1: security event for the owner)
 *   onAuthenticated(deviceId, cid) -> void   (X1 wire M1: a session became that device; the wiring registers it with auth.mjs trackSocket)
 *   onSessionClosed(cid, deviceId) -> void   (X1 wire M1: that session is gone, whatever closed it)
 * Injected for tests: WebSocketImpl, setTimeoutFn/clearTimeoutFn, rand, now, onEvent.
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
    isRevoked = () => false,
    burnCodes = () => {},
    onNeedsYou = () => {},
    onAuthenticated = () => {},
    onSessionClosed = () => {},
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    rand = Math.random,
    now = Date.now,
    onEvent = () => {},
    backoff = {},
    maxSessions = 32,
    authTimeoutMs = 30_000,
    maxRedeemAttempts = 5, // per session
    redeemFailLimit = 10, // host-wide, across sessions and reconnects (H2)
    authFailLimit = 100, // host-wide per authFailWindowMs
    authFailWindowMs = 60_000,
    maxHttpPerSession = 16,
    maxWsPerSession = 8,
    maxPendingFrames = 16, // post-auth frames queued behind a slow dispatch; pre-auth is always 1
    maxSessionMs = 24 * 60 * 60 * 1000, // rekey (M5)
    maxSessionRecords = 2 ** 20,
  } = opts;
  let sock = null;
  let attempt = 0;
  let timer = null;
  let stopped = true;
  let redeemFails = 0;
  let redeemInflight = 0;
  let redeemLocked = false; // set when the global limit burns the codes; cleared by noteFreshMint()
  let authFails = [];
  const sessions = new Map(); // cid -> session, insertion order = age

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
    if (s.deviceId) {
      try {
        onSessionClosed(cid, s.deviceId);
      } catch {}
    }
  }

  function sealSend(s, obj) {
    const plain = Buffer.from(JSON.stringify(obj));
    if (plain.length > MAX_RECORD_BYTES) throw new RangeError("record too large");
    relaySend({ t: "msg", cid: s.cid, b: s.channel.seal(plain).toString("base64") });
    s.records++;
  }
  function send(s, obj) {
    if (s.dead || !s.channel) return;
    try {
      if (s.records >= maxSessionRecords || now() - s.createdAt > maxSessionMs) {
        onEvent({ type: "rekey", cid: s.cid, deviceId: s.deviceId });
        sealSend(s, { t: "rekey" }); // one last record tells the client to re-handshake + re-authenticate
        return closeSession(s.cid);
      }
      sealSend(s, obj);
    } catch (e) {
      // X1 L-1: an oversize record must not take the whole session down. Fail just that stream.
      if (e instanceof RangeError && obj.t === "ws-data") {
        onEvent({ type: "oversize-record", cid: s.cid, id: obj.id });
        const h = s.ws.get(obj.id);
        if (s.ws.delete(obj.id)) {
          try {
            h?.close();
          } catch {}
          return send(s, { t: "ws-close", id: obj.id, code: 1009 });
        }
        return;
      }
      if (e instanceof RangeError && obj.t === "http-res") {
        s.skipBody.add(obj.id); // the 502 already finished this stream: runHttp must not stream the body after it
        return send(s, { t: "http-res", id: obj.id, status: 502, headers: {}, fin: true });
      }
      closeSession(s.cid);
    }
  }

  const needsYou = (event) => {
    try {
      onNeedsYou(event);
    } catch {}
  };
  // H2 / X1 H-1: a guess is counted when it is ISSUED (synchronously, before the await on redeem()), never when the
  // callback returns, so closing the session mid-flight or bursting frames before any callback resolves cannot skip it.
  function lockRedeem() {
    if (redeemLocked) return;
    redeemLocked = true;
    try {
      burnCodes();
    } catch {}
    needsYou({ type: "relay-redeem-flood", message: `Relay: ${redeemFailLimit} failed pairing attempts. All pending codes were burned; mint a new code.` });
  }
  function authThrottled() {
    const t = now();
    authFails = authFails.filter((x) => t - x < authFailWindowMs);
    return authFails.length >= authFailLimit;
  }
  const validCode = (c) => typeof c === "string" && c.length > 0 && c.length <= 16;
  const validToken = (t) => typeof t === "string" && t.length > 0 && t.length <= 128;

  async function runHttp(s, id, m, target) {
    s.http++;
    let headSent = false;
    try {
      const body = m.b ? Buffer.from(String(m.b), "base64") : Buffer.alloc(0);
      const r = await handleHttp({ method: String(m.method ?? "GET").toUpperCase(), path: target.path, headers: pickHeaders(m.headers), body, deviceId: s.deviceId });
      if (s.dead) return;
      const buf = r?.body == null ? Buffer.alloc(0) : Buffer.from(r.body);
      send(s, { t: "http-res", id, status: r?.status ?? 500, headers: cleanResponseHeaders(r?.headers) });
      headSent = true;
      if (s.skipBody.delete(id)) return; // head was oversize and already answered with a finished 502
      for (let o = 0; o < buf.length; o += BODY_CHUNK) {
        send(s, { t: "http-body", id, b: buf.subarray(o, o + BODY_CHUNK).toString("base64") });
      }
      send(s, { t: "http-body", id, b: "", fin: true });
    } catch {
      send(s, headSent ? { t: "http-body", id, b: "", fin: true } : { t: "http-res", id, status: 502, headers: {}, fin: true });
    } finally {
      s.http--;
    }
  }

  async function runWsOpen(s, id, target, pending) {
    let handle = null;
    try {
      handle = await openWs({
        path: target.path,
        deviceId: s.deviceId,
        send: (data, binary) => send(s, { t: "ws-data", id, bin: Boolean(binary), data: binary ? Buffer.from(data).toString("base64") : String(data) }),
        close: (code) => {
          if (s.ws.delete(id)) send(s, { t: "ws-close", id, code: code ?? 1000 });
        },
      });
    } catch (e) {
      onEvent({ type: "ws-open-error", cid: s.cid, deviceId: s.deviceId, reason: String(e?.message ?? e).slice(0, 200) });
      handle = null; // falls through to ok:false + stream cleanup below
    }
    const stillMine = s.ws.get(id) === pending;
    if (s.dead || !stillMine || !handle) {
      if (stillMine) s.ws.delete(id);
      try {
        handle?.close();
      } catch {}
      if (!s.dead) send(s, { t: "ws-open-res", id, ok: false });
      return;
    }
    s.ws.set(id, handle);
    send(s, { t: "ws-open-res", id, ok: true });
  }

  // Frames of one session are dispatched strictly in order (see s.queue). Long-running work (handleHttp / openWs) is
  // started, not awaited, so one slow request never blocks the session; slots are reserved synchronously (X1 M-3).
  async function dispatch(s, m) {
    const id = typeof m.id === "string" ? m.id.slice(0, 64) : "";
    if (m.t === "redeem") {
      if (s.deviceId) return send(s, { t: "redeem-res", id, ok: false });
      if (++s.redeems > maxRedeemAttempts) return closeSession(s.cid);
      if (redeemLocked) return send(s, { t: "redeem-res", id, ok: false, locked: true }); // never reaches redeem()
      if (redeemFails >= redeemFailLimit) {
        lockRedeem();
        return send(s, { t: "redeem-res", id, ok: false, locked: true });
      }
      redeemFails++; // counted now, synchronously
      redeemInflight++;
      let r = null;
      try {
        if (validCode(m.code)) r = await redeem({ code: m.code, label: typeof m.label === "string" ? m.label.slice(0, 80) : "" });
      } catch {}
      redeemInflight--;
      const ok = Boolean(r?.token && r.deviceId);
      if (ok) redeemFails = redeemInflight; // this guess was right: only other guesses still in flight stay counted
      else if (redeemFails >= redeemFailLimit) lockRedeem();
      if (s.dead) return;
      if (!ok) return send(s, { t: "redeem-res", id, ok: false });
      if (r.pending) {
        // E4b two-step confirm: a device-minted code yields a token that is not in devices.json until the minting phone
        // approves it. The code was valid (not a guess), but the session stays UNauthenticated: the client keeps the
        // token and authenticates once approved (an `auth` with a still-pending token answers pending, see below).
        return send(s, { t: "redeem-res", id, ok: true, pending: true, deviceId: String(r.deviceId), token: r.token });
      }
      s.deviceId = String(r.deviceId);
      if (s.authTimer) clearTimeoutFn(s.authTimer);
      try {
        onAuthenticated(s.deviceId, s.cid);
      } catch {}
      return send(s, { t: "redeem-res", id, ok: true, deviceId: s.deviceId, token: r.token });
    }
    if (m.t === "auth") {
      if (s.deviceId) return send(s, { t: "auth-res", id, ok: false });
      if (++s.redeems > maxRedeemAttempts) return closeSession(s.cid);
      if (authThrottled()) return send(s, { t: "auth-res", id, ok: false });
      const stamp = now();
      authFails.push(stamp); // counted before the await
      let r = null;
      try {
        if (validToken(m.token)) r = await authenticate(m.token);
      } catch {}
      if (r?.deviceId || r?.pending) {
        const i = authFails.indexOf(stamp);
        if (i >= 0) authFails.splice(i, 1);
      }
      if (s.dead) return;
      if (r?.pending && !r.deviceId) {
        // A host-minted token still waiting for the minter's approval (E4b): not a guess, so it costs no attempt; the
        // session stays unauthenticated and the 30 s auth timer still bounds a polling client.
        s.redeems--;
        return send(s, { t: "auth-res", id, ok: false, pending: true });
      }
      if (!r?.deviceId) return send(s, { t: "auth-res", id, ok: false });
      s.deviceId = String(r.deviceId);
      if (s.authTimer) clearTimeoutFn(s.authTimer);
      try {
        onAuthenticated(s.deviceId, s.cid);
      } catch {}
      return send(s, { t: "auth-res", id, ok: true, deviceId: s.deviceId });
    }
    if (!s.deviceId) return closeSession(s.cid); // anything else before redeem/auth is a protocol violation
    if (await isRevoked(s.deviceId)) {
      onEvent({ type: "revoked-on-dispatch", deviceId: s.deviceId });
      return closeSession(s.cid);
    }
    if (s.dead) return;
    if (m.t === "http") {
      if (s.http >= maxHttpPerSession) return send(s, { t: "http-res", id, status: 429, headers: {}, fin: true });
      const method = String(m.method ?? "GET").toUpperCase();
      const target = normalizeRelayTarget(method, m.path);
      if (!target) {
        onEvent({ type: "denied", deviceId: s.deviceId, method, path: String(m.path).slice(0, 200) });
        return send(s, { t: "http-res", id, status: 403, headers: {}, fin: true });
      }
      void runHttp(s, id, m, target);
      return;
    }
    if (m.t === "ws-open") {
      const target = normalizeRelayTarget("GET", m.path);
      if (s.ws.size >= maxWsPerSession || !id || s.ws.has(id) || !target) return send(s, { t: "ws-open-res", id, ok: false });
      const pending = { message() {}, close() {}, pending: true };
      s.ws.set(id, pending); // reserved synchronously: caps and duplicate ids are enforced before any await
      void runWsOpen(s, id, target, pending);
      return;
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
    if (rawSize(raw) > MAX_WIRE_CHARS) return onEvent({ type: "oversize-frame" }); // before JSON.parse / base64
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
      if (sessions.size >= maxSessions) {
        // M3: a flood of half-open sessions must not lock the owner out. Evict the oldest unauthenticated one.
        const victim = [...sessions.values()].find((x) => !x.deviceId);
        if (!victim) return relaySend({ t: "close", cid });
        onEvent({ type: "evicted-unauthenticated", cid: victim.cid });
        closeSession(victim.cid);
      }
      const s = { cid, channel: null, deviceId: null, redeems: 0, http: 0, ws: new Map(), dead: false, authTimer: null, createdAt: now(), records: 0, queue: Promise.resolve(), pending: 0, skipBody: new Set() };
      s.authTimer = setTimeoutFn(() => closeSession(cid), authTimeoutMs);
      sessions.set(cid, s);
      return;
    }
    if (f.t !== "msg") return;
    const s = sessions.get(cid);
    if (!s || typeof f.b !== "string") return;
    try {
      // Backpressure BEFORE decrypting: a frame that is decrypted, parsed and queued behind a slow callback costs memory
      // (up to ~1 MiB each). Pre-auth a session may have exactly one frame in flight; post-auth a small budget.
      if (s.channel && s.pending >= (s.deviceId ? maxPendingFrames : 1)) {
        onEvent({ type: "backpressure-overflow", cid, deviceId: s.deviceId });
        return closeSession(cid);
      }
      const bytes = Buffer.from(f.b, "base64");
      if (!s.channel) {
        const { reply, channel } = acceptHandshake(bytes, { hostKey, hostId });
        s.channel = channel;
        return relaySend({ t: "msg", cid, b: reply.toString("base64") });
      }
      const m = JSON.parse(s.channel.open(bytes).toString("utf8"));
      s.records++;
      if (!m || typeof m !== "object") throw new Error("bad frame");
      s.pending++;
      s.queue = s.queue
        .then(() => dispatch(s, m))
        .catch(() => closeSession(cid))
        .finally(() => s.pending--); // strictly ordered per session
    } catch (e) {
      onEvent({ type: "session-error", cid, deviceId: s.deviceId, reason: String(e?.message ?? e) });
      closeSession(cid);
    }
  }

  // down() is the single teardown path for a relay socket (close and error both land here; the guard makes it idempotent).
  function down(ws) {
    if (sock !== ws) return;
    sock = null;
    try {
      ws.close();
    } catch {}
    for (const cid of [...sessions.keys()]) closeSession(cid, false);
    onEvent({ type: "disconnected" });
    schedule();
  }
  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(url());
    } catch (e) {
      onEvent({ type: "connect-error", reason: String(e?.message ?? e) });
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
    ws.addEventListener("close", () => down(ws));
    ws.addEventListener("error", () => down(ws));
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
    /** Call after a fresh pairing code is minted: lifts the redeem lock set by the global failure limit. */
    noteFreshMint() {
      redeemLocked = false;
      redeemFails = 0;
    },
    status: () => ({ connected: sock?.readyState === 1, sessions: sessions.size, attempt, redeemFails, redeemLocked }),
  };
}

/** Self-certifying host id (design review M1): base64url(SHA-256(host public key)). Clients may require hostId === this. */
export const selfCertifyingHostId = (pub) => createHash("sha256").update(typeof pub === "string" ? Buffer.from(pub, "base64") : pub).digest("base64url");
