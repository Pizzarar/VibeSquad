// E5 client side of the VibeSquad outbound E2EE relay. Protocol + threat model: server/relay-tunnel.mjs header and
// docs/lanes/android-app/E5_THREAT_MODEL.md (§11 is the wiring). The pin store lives in src/remoteSession.ts (saveRelayPin).
// Crypto: WebCrypto (AES-256-GCM, HKDF, SHA-256) plus X25519 from WebCrypto when the runtime has it (Chrome/WebView >= 133,
// Safari >= 17, Firefox >= 130), else audited @noble/curves. Channel keys and counters live only in memory: any socket
// drop means a fresh handshake, never a resume.
// Kept type-erasable so node can import it directly in tests.
import { x25519 } from "@noble/curves/ed25519.js";

const PROTOCOL = "vibesquad-relay-v1";
const SUITE = "Noise_NK_25519_AESGCM_SHA256";
const HS_VERSION = 1;
const DIR_C2H = 1;
const DIR_H2C = 2;
const TAG_LEN = 16;
export const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_WIRE_CHARS = Math.ceil(((MAX_RECORD_BYTES + 8 + TAG_LEN) * 4) / 3) + 512; // raw relay frame, before JSON/base64
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class RelayAuthError extends Error {}
/** The token is waiting for the minting phone's approval (E4b two-step confirm): keep it, retry `authenticate` later. */
export class RelayPendingError extends RelayAuthError {
  constructor() {
    super("waiting for approval on the phone that showed the code");
    this.name = "RelayPendingError";
  }
}
/** The host asked for a fresh handshake (24 h / 2^20 records). Reconnect and re-authenticate. */
export class RelayRekeyError extends Error {
  constructor() {
    super("relay session expired; reconnect");
    this.name = "RelayRekeyError";
  }
}

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is unavailable (insecure context?)");
  return s;
};

export const toB64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const fromB64 = (s: string): Bytes => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---- X25519: WebCrypto when present, @noble/curves otherwise --------------------------------------------------------------

export interface Kex {
  impl: "webcrypto" | "noble";
  pub: Bytes;
  dh(peer: Uint8Array): Promise<Bytes>;
}

/** Fresh ephemeral X25519 key. `forceNoble` is for tests and for runtimes known to mis-implement WebCrypto X25519. */
export async function newKex(forceNoble = false): Promise<Kex> {
  if (!forceNoble) {
    try {
      const eph = (await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
      const pub = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
      return {
        impl: "webcrypto",
        pub,
        async dh(peer) {
          const k = await subtle().importKey("raw", peer as Bytes, { name: "X25519" }, false, []);
          return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: k }, eph.privateKey, 256));
        },
      };
    } catch {
      // no WebCrypto X25519 here: fall through to the pure-JS implementation
    }
  }
  const sk = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(sk) as Bytes;
  return { impl: "noble", pub, dh: async (peer) => x25519.getSharedSecret(sk, peer) as Bytes };
}

// ---- pure crypto pieces (swap these, not the mux) ----------------------------------------------------------------------

export async function transcriptHash(hostId: string, hostPub: Uint8Array, ec: Uint8Array, eh: Uint8Array, version = HS_VERSION): Promise<Bytes> {
  const id = enc.encode(hostId);
  const len = new Uint8Array([id.length >> 8, id.length & 255]);
  return new Uint8Array(
    await subtle().digest("SHA-256", concat(enc.encode(PROTOCOL), enc.encode(SUITE), new Uint8Array([version]), len, id, hostPub, ec, eh)),
  );
}

export async function deriveKeys(dhEs: Uint8Array, dhEe: Uint8Array, h: Uint8Array): Promise<{ c2h: Bytes; h2c: Bytes }> {
  const base = await subtle().importKey("raw", concat(dhEs, dhEe), "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: h as Bytes, info: enc.encode("vs-relay-v1 keys") }, base, 512),
  );
  return { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) };
}

const allZero = (b: Uint8Array) => b.every((x) => x === 0);

export interface Channel {
  seal(plain: Uint8Array): Promise<Bytes>;
  open(frame: Uint8Array): Promise<Bytes>;
}

export async function createChannel(sendRaw: Uint8Array, recvRaw: Uint8Array, sendDir: number, recvDir: number): Promise<Channel> {
  const imp = (k: Uint8Array) => subtle().importKey("raw", k as Bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const [sk, rk] = await Promise.all([imp(sendRaw), imp(recvRaw)]);
  let sendCtr = 0n;
  let recvCtr = 0n;
  const meta = (dir: number, ctr: bigint) => {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, ctr);
    const aad = new Uint8Array(9);
    aad[0] = dir;
    new DataView(aad.buffer).setBigUint64(1, ctr);
    return { iv, aad };
  };
  return {
    async seal(plain) {
      if (plain.length > MAX_RECORD_BYTES) throw new Error("record too large");
      const ctr = sendCtr;
      if (ctr >= 2n ** 53n) throw new Error("relay channel exhausted");
      sendCtr += 1n; // advance before awaiting so concurrent seals never reuse a nonce
      const { iv, aad } = meta(sendDir, ctr);
      const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, sk, plain as Bytes));
      const head = new Uint8Array(8);
      new DataView(head.buffer).setBigUint64(0, ctr);
      return concat(head, ct);
    },
    async open(frame) {
      if (frame.length < 8 + TAG_LEN) throw new RelayAuthError("short record");
      if (frame.length > MAX_RECORD_BYTES + 8 + TAG_LEN) throw new RelayAuthError("record too large");
      const ctr = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0);
      if (ctr !== recvCtr) throw new RelayAuthError("replayed or out-of-order record");
      const { iv, aad } = meta(recvDir, ctr);
      let plain: ArrayBuffer;
      try {
        plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, rk, frame.slice(8) as Bytes);
      } catch {
        throw new RelayAuthError("record failed authentication");
      }
      recvCtr += 1n;
      return new Uint8Array(plain);
    },
  };
}

export async function startHandshake(hostPub: Uint8Array, hostId: string, kex?: Kex) {
  const k = kex ?? (await newKex());
  const ec = k.pub;
  return {
    kex: k,
    msg1: concat(new Uint8Array([HS_VERSION]), ec),
    async finish(msg2: Uint8Array): Promise<Channel> {
      if (msg2.length < 32 + 8 + TAG_LEN) throw new RelayAuthError("bad handshake reply");
      const eh = msg2.slice(0, 32);
      const h = await transcriptHash(hostId, hostPub, ec, eh);
      let es: Bytes;
      let ee: Bytes;
      try {
        es = await k.dh(hostPub);
        ee = await k.dh(eh);
      } catch {
        throw new RelayAuthError("invalid peer key"); // noble throws on low-order/invalid points, WebCrypto may too: one typed error
      }
      if (allZero(es) || allZero(ee)) throw new RelayAuthError("degenerate DH output");
      const keys = await deriveKeys(es, ee, h);
      const channel = await createChannel(keys.c2h, keys.h2c, DIR_C2H, DIR_H2C);
      const ok = dec.decode(await channel.open(msg2.slice(32)));
      if (ok !== "vs-ok") throw new RelayAuthError("host key confirmation failed");
      return channel;
    },
  };
}

/** base64url(SHA-256(host public key)): the self-certifying hostId (design review M1). */
export async function selfCertifyingHostId(pub: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", pub as Bytes));
  return toB64(d).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- pairing link fragment (design review H3) ----------------------------------------------------------------------------
// The browser client is served from a static origin that is a TRUSTED party (it sees the code, the pin and all plaintext).
// First thing on load: read the #fragment into memory and strip it from the URL/history so it is never re-shared,
// bookmarked or leaked via Referer. Import this module before anything else in the entry point.

export interface PairingFragment {
  hostId: string;
  pub: string;
  relay: string;
  code: string | null;
}
interface WindowLike {
  location?: { hash: string; pathname: string; search: string };
  history?: { replaceState(state: unknown, title: string, url?: string): void };
}

export function takePairingFragment(w: WindowLike = globalThis as WindowLike): PairingFragment | null {
  const loc = w.location;
  if (!loc?.hash || loc.hash.length < 2) return null;
  const p = new URLSearchParams(loc.hash.slice(1));
  if (!p.has("pub") && !p.has("hostId")) return null; // not ours: leave other fragments alone
  w.history?.replaceState(null, "", loc.pathname + loc.search);
  const hostId = p.get("hostId") ?? "";
  const pub = p.get("pub") ?? "";
  const relay = p.get("relay") ?? "";
  let pubOk = false;
  try {
    pubOk = fromB64(pub.replace(/-/g, "+").replace(/_/g, "/")).length === 32;
  } catch {}
  if (!hostId || !pubOk || !/^wss:\/\//i.test(relay)) return null;
  return { hostId, pub: pub.replace(/-/g, "+").replace(/_/g, "/"), relay, code: p.get("code") };
}

/**
 * Pairing-link consumer check (X1 M-2): the link's hostId must be the self-certifying id of its pub, so an attacker's
 * link can only name a NEW host (with no stored pin/token), never repoint a known hostId at the attacker's key.
 * Wiring contract (threat model §7): never overwrite a stored pin from a link; never send a stored token to a host whose pin differs.
 */
export async function acceptPairingFragment(f: PairingFragment): Promise<PairingFragment> {
  if ((await selfCertifyingHostId(fromB64(f.pub))) !== f.hostId) throw new RelayAuthError("pairing link hostId does not match its key");
  return f;
}

/** Captured at module load, before any other app code can read location.hash. null outside a browser or without a pairing link. */
export const pairingFragment: PairingFragment | null = takePairingFragment();

// ---- transport -----------------------------------------------------------------------------------------------------------

interface SockLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
}
type SockCtor = new (url: string) => SockLike;

export interface RelayOptions {
  /** wss://relay.example/ (a trailing /ws is added if missing) */
  endpoint: string;
  hostId: string;
  /** Host X25519 public key, base64 (the `pub` in the pairing link). Pinned. */
  hostPubKey: string;
  WebSocketImpl?: SockCtor;
  timeoutMs?: number;
  /** Skip WebCrypto X25519 even when present. */
  forceNoble?: boolean;
  maxResponseBytes?: number;
  /** hostId must equal base64url(SHA-256(hostPubKey)). DEFAULT ON (X1 M-2); pass false only in tests. */
  requireSelfCertifiedHostId?: boolean;
}

export interface RelayWebSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | Bytes }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface RelayClient {
  kex: "webcrypto" | "noble";
  /** `pending` = device-minted code (E4b): keep the token, the session is NOT authenticated until `authenticate` succeeds. */
  redeem(code: string, label?: string): Promise<{ deviceId: string; token: string; pending?: boolean }>;
  /** Throws RelayPendingError while the token still waits for approval, RelayAuthError when it is rejected/revoked. */
  authenticate(token: string): Promise<{ deviceId: string }>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string): Promise<RelayWebSocket>;
  close(): void;
  onclose: ((reason?: unknown) => void) | null;
}

type Frame = Record<string, unknown> & { t: string; id?: string };

export async function connectRelay(opts: RelayOptions): Promise<RelayClient> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const Ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as SockCtor);
  const u = new URL(opts.endpoint);
  if (u.protocol !== "wss:") throw new RelayAuthError("relay endpoint must be wss://"); // X1 L-4: never leak hostId/timing in clear
  if (!u.pathname.endsWith("/ws")) u.pathname = `${u.pathname.replace(/\/$/, "")}/ws`;
  u.searchParams.set("hostId", opts.hostId);
  u.searchParams.set("role", "client");
  const hostPub = fromB64(opts.hostPubKey);
  if (hostPub.length !== 32) throw new RelayAuthError("bad pinned host key");
  if (opts.requireSelfCertifiedHostId !== false && (await selfCertifyingHostId(hostPub)) !== opts.hostId) {
    throw new RelayAuthError("hostId does not match the pinned host key");
  }
  const kex = await newKex(opts.forceNoble);

  const sock = new Ctor(u.toString());
  let channel: Channel | null = null;
  let hs: Awaited<ReturnType<typeof startHandshake>> | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve(); // records must be opened strictly in arrival order
  let ready!: (c: void) => void;
  let fail!: (e: unknown) => void;
  const handshake = new Promise<void>((res, rej) => {
    ready = res;
    fail = rej;
  });
  handshake.catch(() => {}); // rejection is surfaced to connectRelay's await below
  const pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: unknown) => void }>();
  const streams = new Map<string, (f: Frame) => void>(); // http body + ws events by request id
  const client = { onclose: null, kex: kex.impl } as unknown as RelayClient;

  const shutdown = (err?: unknown) => {
    if (closed) return;
    closed = true;
    const reason = err ?? new Error("relay closed");
    fail(reason);
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
    for (const s of [...streams.values()]) s({ t: "ws-close", code: 1006 });
    streams.clear();
    try {
      sock.close();
    } catch {}
    client.onclose?.(reason);
  };
  const sendRaw = (b: Uint8Array) => sock.send(JSON.stringify({ t: "msg", b: toB64(b) }));
  // seal + send in ONE queued step: WebCrypto encrypt completion order is unspecified, so without this a slow ctr 0 and a
  // fast ctr 1 reach the wire reversed and the host (rightly) kills the session (X1 M-1). Wire order == counter order.
  let sendChain: Promise<void> = Promise.resolve();
  const sendFrame = (f: Frame): Promise<void> => {
    const step = sendChain.then(async () => {
      if (!channel || closed) throw new Error("relay not connected");
      sendRaw(await channel.seal(enc.encode(JSON.stringify(f))));
    });
    sendChain = step.catch(() => {});
    return step;
  };
  // Sends a request frame; on failure drops the id from pending/streams so nothing leaks.
  const sendTracked = (f: Frame, id: string, reject: (e: unknown) => void) =>
    sendFrame(f).catch((e) => {
      pending.delete(id);
      streams.delete(id);
      reject(e);
    });
  let nextId = 0;
  const rpc = (f: Omit<Frame, "id">, expect: string): Promise<Frame> => {
    const id = String(++nextId);
    return new Promise<Frame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void sendTracked({ ...f, id } as Frame, id, reject);
    }).then((r) => {
      if (r.t !== expect) throw new Error(`unexpected ${r.t}`);
      return r;
    });
  };

  async function onRecord(bytes: Uint8Array) {
    if (!channel) {
      channel = await hs!.finish(bytes);
      return ready();
    }
    const f = JSON.parse(dec.decode(await channel.open(bytes))) as Frame;
    if (f.t === "rekey") return shutdown(new RelayRekeyError());
    const id = f.id ?? "";
    if (f.t === "redeem-res" || f.t === "auth-res" || f.t === "ws-open-res" || f.t === "http-res") {
      const p = pending.get(id);
      pending.delete(id);
      p?.resolve(f);
    } else streams.get(id)?.(f);
  }

  sock.addEventListener("message", (ev) => {
    const raw = ev.data;
    if (typeof raw !== "string" || raw.length > MAX_WIRE_CHARS) return shutdown(new Error("oversize or non-text relay frame")); // before JSON/base64
    let b: Uint8Array | null = null;
    try {
      const m = JSON.parse(raw) as { t?: string; b?: string };
      if (m.t === "close") {
        chain = chain.then(() => shutdown(new Error("relay closed the session (host offline?)"))); // after in-flight records, so a final rekey frame is still read
        return;
      }
      if (m.t === "msg" && typeof m.b === "string") b = fromB64(m.b);
    } catch {}
    if (!b) return;
    const bytes = b;
    chain = chain.then(() => onRecord(bytes)).catch((e) => shutdown(e)); // any failure kills the session
  });
  sock.addEventListener("close", () => void (chain = chain.then(() => shutdown()))); // after in-flight records
  sock.addEventListener("error", () => shutdown(new Error("relay socket error")));

  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("relay connect timed out")), timeoutMs);
      sock.addEventListener("open", () => {
        clearTimeout(t);
        res();
      });
      sock.addEventListener("error", () => {
        clearTimeout(t);
        rej(new Error("relay unreachable"));
      });
    });
    hs = await startHandshake(hostPub, opts.hostId, kex);
    sendRaw(hs.msg1);
    const hsTimer = setTimeout(() => shutdown(new RelayAuthError("host did not answer the handshake")), timeoutMs);
    try {
      await handshake;
    } finally {
      clearTimeout(hsTimer);
    }
  } catch (e) {
    shutdown(e); // closes the socket on connect timeout / handshake failure
    throw e;
  }

  client.redeem = async (code, label = "") => {
    const r = await rpc({ t: "redeem", code, label }, "redeem-res");
    if (!r.ok) throw new RelayAuthError(r.locked ? "pairing locked; mint a new code" : "code rejected");
    return { deviceId: String(r.deviceId), token: String(r.token), ...(r.pending === true ? { pending: true } : {}) };
  };
  client.authenticate = async (token) => {
    const r = await rpc({ t: "auth", token }, "auth-res");
    if (!r.ok) throw r.pending === true ? new RelayPendingError() : new RelayAuthError("token rejected");
    return { deviceId: String(r.deviceId) };
  };
  client.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, "http://relay.invalid");
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    const body = init.body == null ? null : new Uint8Array(await new Response(init.body).arrayBuffer());
    const id = String(++nextId);
    const chunks: Bytes[] = [];
    let total = 0;
    let done!: () => void;
    let abort!: (e: unknown) => void;
    const finished = new Promise<void>((r, j) => ((done = r), (abort = j)));
    finished.catch(() => {}); // awaited later; don't surface as unhandled if the head request fails first
    streams.set(id, (f) => {
      if (f.t === "ws-close") abort(new Error("relay closed mid-response"));
      else if (f.t === "http-body") {
        if (f.b) {
          const c = fromB64(String(f.b));
          total += c.length;
          if (total > maxResponseBytes) {
            streams.delete(id);
            return abort(new Error("relay response too large"));
          }
          chunks.push(c);
        }
        if (f.fin) done();
      }
    });
    const head = await new Promise<Frame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void sendTracked({ t: "http", id, method, path: url.pathname + url.search, headers, ...(body ? { b: toB64(body) } : {}) }, id, reject);
    });
    const status = Number(head.status);
    if (head.fin) done();
    try {
      await finished;
    } finally {
      streams.delete(id);
    }
    const noBody = status === 204 || status === 304 || method === "HEAD" || head.fin === true;
    return new Response(noBody ? null : concat(...chunks), { status, headers: (head.headers ?? {}) as Record<string, string> });
  };
  client.openWebSocket = async (path) => {
    const id = String(++nextId);
    const ws: RelayWebSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      send(data) {
        const bin = typeof data !== "string";
        sendFrame({ t: "ws-data", id, bin, data: bin ? toB64(data as Uint8Array) : data }).catch(() => ws.close());
      },
      close() {
        if (ws.readyState === 3) return;
        ws.readyState = 3;
        streams.delete(id);
        sendFrame({ t: "ws-close", id }).catch(() => {});
        ws.onclose?.({ code: 1000 });
      },
    };
    streams.set(id, (f) => {
      if (f.t === "ws-data") ws.onmessage?.({ data: f.bin ? fromB64(String(f.data)) : String(f.data) });
      else if (f.t === "ws-close" && ws.readyState !== 3) {
        ws.readyState = 3;
        streams.delete(id);
        ws.onclose?.({ code: Number(f.code ?? 1006) });
      }
    });
    const r = await new Promise<Frame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void sendTracked({ t: "ws-open", id, path }, id, reject);
    });
    if (!r.ok) {
      streams.delete(id);
      throw new Error("ws denied");
    }
    ws.readyState = 1;
    ws.onopen?.();
    return ws;
  };
  client.close = () => shutdown(new Error("closed"));
  return client;
}

/** Drop-in `fetch` for same-origin app code once a relay client is connected. */
export const createRelayFetch = (c: RelayClient): typeof fetch => (input, init) => c.fetch(input as string, init);
