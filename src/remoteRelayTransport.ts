// E5 client side of the VibeSquad outbound E2EE relay. Protocol + threat model: server/relay-tunnel.mjs header and
// docs/lanes/android-app/E5_THREAT_MODEL.md. UNWIRED: nothing imports this yet.
// Uses WebCrypto only (no deps). X25519 in WebCrypto needs Chrome/WebView >= 133, Safari >= 17, Firefox >= 130; when it
// is missing, connectRelay() rejects with RelayUnsupportedError instead of falling back to hand-rolled curve math.
// Kept dependency-free and type-erasable so node can import it directly in tests.

const PROTOCOL = "vibesquad-relay-v1";
const HS_VERSION = 1;
const DIR_C2H = 1;
const DIR_H2C = 2;
const TAG_LEN = 16;

export class RelayUnsupportedError extends Error {
  constructor(msg = "This browser/WebView lacks WebCrypto X25519; use Meshnet or update the system WebView.") {
    super(msg);
    this.name = "RelayUnsupportedError";
  }
}
export class RelayAuthError extends Error {}

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new RelayUnsupportedError("WebCrypto is unavailable (insecure context?)");
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

/** Probes X25519 + AES-GCM + HKDF support. */
export async function supportsRelayCrypto(): Promise<boolean> {
  try {
    await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

// ---- pure crypto pieces (swap these, not the mux) ----------------------------------------------------------------------

export async function transcriptHash(hostId: string, hostPub: Uint8Array, ec: Uint8Array, eh: Uint8Array): Promise<Bytes> {
  const id = enc.encode(hostId);
  const len = new Uint8Array([id.length >> 8, id.length & 255]);
  return new Uint8Array(await subtle().digest("SHA-256", concat(enc.encode(PROTOCOL), len, id, hostPub, ec, eh)));
}

async function dh(priv: CryptoKey, pubRaw: Uint8Array): Promise<Bytes> {
  const pub = await subtle().importKey("raw", pubRaw as Bytes, { name: "X25519" }, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: pub }, priv, 256));
  if (bits.every((b) => b === 0)) throw new RelayAuthError("degenerate DH output");
  return bits;
}

export async function deriveKeys(dhEs: Uint8Array, dhEe: Uint8Array, h: Uint8Array): Promise<{ c2h: Bytes; h2c: Bytes }> {
  const base = await subtle().importKey("raw", concat(dhEs, dhEe), "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: h as Bytes, info: enc.encode("vs-relay-v1 keys") }, base, 512),
  );
  return { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) };
}

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

export async function startHandshake(hostPub: Uint8Array, hostId: string) {
  const eph = (await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const ec = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  return {
    msg1: concat(new Uint8Array([HS_VERSION]), ec),
    async finish(msg2: Uint8Array): Promise<Channel> {
      if (msg2.length < 32 + 8 + TAG_LEN) throw new RelayAuthError("bad handshake reply");
      const eh = msg2.slice(0, 32);
      const h = await transcriptHash(hostId, hostPub, ec, eh);
      const keys = await deriveKeys(await dh(eph.privateKey, hostPub), await dh(eph.privateKey, eh), h);
      const channel = await createChannel(keys.c2h, keys.h2c, DIR_C2H, DIR_H2C);
      const ok = dec.decode(await channel.open(msg2.slice(32)));
      if (ok !== "vs-ok") throw new RelayAuthError("host key confirmation failed");
      return channel;
    },
  };
}

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
  redeem(code: string, label?: string): Promise<{ deviceId: string; token: string }>;
  authenticate(token: string): Promise<{ deviceId: string }>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string): Promise<RelayWebSocket>;
  close(): void;
  onclose: (() => void) | null;
}

type Frame = Record<string, unknown> & { t: string; id?: string };

export async function connectRelay(opts: RelayOptions): Promise<RelayClient> {
  if (!(await supportsRelayCrypto())) throw new RelayUnsupportedError();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const Ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as SockCtor);
  const u = new URL(opts.endpoint);
  if (!u.pathname.endsWith("/ws")) u.pathname = `${u.pathname.replace(/\/$/, "")}/ws`;
  u.searchParams.set("hostId", opts.hostId);
  u.searchParams.set("role", "client");
  const hostPub = fromB64(opts.hostPubKey);
  if (hostPub.length !== 32) throw new RelayAuthError("bad pinned host key");

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
  const pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: unknown) => void }>();
  const streams = new Map<string, (f: Frame) => void>(); // http body + ws events by request id
  const client: RelayClient = { onclose: null } as RelayClient;

  const shutdown = (err?: unknown) => {
    if (closed) return;
    closed = true;
    fail(err ?? new Error("relay closed"));
    for (const p of pending.values()) p.reject(err ?? new Error("relay closed"));
    pending.clear();
    for (const s of streams.values()) s({ t: "ws-close", code: 1006 });
    streams.clear();
    try {
      sock.close();
    } catch {}
    client.onclose?.();
  };
  const sendRaw = (b: Uint8Array) => sock.send(JSON.stringify({ t: "msg", b: toB64(b) }));
  const sendFrame = async (f: Frame) => {
    if (!channel || closed) throw new Error("relay not connected");
    sendRaw(await channel.seal(enc.encode(JSON.stringify(f))));
  };
  let nextId = 0;
  const rpc = (f: Omit<Frame, "id">, expect: string): Promise<Frame> => {
    const id = String(++nextId);
    return new Promise<Frame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendFrame({ ...f, id } as Frame).catch(reject);
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
    const id = f.id ?? "";
    if (f.t === "redeem-res" || f.t === "auth-res" || f.t === "ws-open-res") {
      const p = pending.get(id);
      pending.delete(id);
      p?.resolve(f);
    } else if (f.t === "http-res") {
      const p = pending.get(id);
      pending.delete(id);
      p?.resolve(f);
    } else streams.get(id)?.(f);
  }

  sock.addEventListener("message", (ev) => {
    let b: Uint8Array | null = null;
    try {
      const m = JSON.parse(String(ev.data)) as { t?: string; b?: string };
      if (m.t === "close") return shutdown(new Error("relay closed the session (host offline?)"));
      if (m.t === "msg" && typeof m.b === "string") b = fromB64(m.b);
    } catch {}
    if (!b) return;
    const bytes = b;
    chain = chain.then(() => onRecord(bytes)).catch((e) => shutdown(e)); // any failure kills the session
  });
  sock.addEventListener("close", () => shutdown());
  sock.addEventListener("error", () => shutdown(new Error("relay socket error")));

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
  hs = await startHandshake(hostPub, opts.hostId);
  sendRaw(hs.msg1);
  const hsTimer = setTimeout(() => shutdown(new RelayAuthError("host did not answer the handshake")), timeoutMs);
  try {
    await handshake;
  } finally {
    clearTimeout(hsTimer);
  }

  client.redeem = async (code, label = "") => {
    const r = await rpc({ t: "redeem", code, label }, "redeem-res");
    if (!r.ok) throw new RelayAuthError("code rejected");
    return { deviceId: String(r.deviceId), token: String(r.token) };
  };
  client.authenticate = async (token) => {
    const r = await rpc({ t: "auth", token }, "auth-res");
    if (!r.ok) throw new RelayAuthError("token rejected");
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
    let done!: () => void;
    let abort!: (e: unknown) => void;
    const finished = new Promise<void>((r, j) => ((done = r), (abort = j)));
    finished.catch(() => {}); // awaited later; don't surface as unhandled if the head request fails first
    streams.set(id, (f) => {
      if (f.t === "ws-close") abort(new Error("relay closed mid-response"));
      else if (f.t === "http-body") {
        if (f.b) chunks.push(fromB64(String(f.b)));
        if (f.fin) done();
      }
    });
    const head = await new Promise<Frame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendFrame({ t: "http", id, method, path: url.pathname + url.search, headers, ...(body ? { b: toB64(body) } : {}) }).catch(reject);
    });
    const status = Number(head.status);
    if (head.fin) done();
    await finished;
    streams.delete(id);
    const noBody = status === 204 || status === 304 || method === "HEAD";
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
      sendFrame({ t: "ws-open", id, path }).catch(reject);
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
