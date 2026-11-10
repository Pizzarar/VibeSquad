// E5 outbound E2EE relay: host (server/relay-tunnel.mjs) <-> client (src/remoteRelayTransport.ts) through a fake,
// recording, untrusted relay. No network. Run: node --test --import ./test/setup/hermetic.mjs test/relay-tunnel.test.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { connectRelay, RelayAuthError } from "../src/remoteRelayTransport.ts";
import {
  acceptHandshake,
  backoffDelay,
  createRelayHost,
  hostFingerprint,
  isRelayPathAllowed,
  loadOrCreateHostKeypair,
  startClientHandshake,
} from "../server/relay-tunnel.mjs";

const tmp = mkdtempSync(join(tmpdir(), "vs-relay-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const HOST_ID = "host-test-1";
const hostKey = loadOrCreateHostKeypair(join(tmp, "k", "host-keypair.json"));
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, n = 200) => {
  for (let i = 0; i < n; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error("timed out waiting");
};

/** In-memory untrusted relay. `Sock` is used as the WebSocket implementation for both host and clients. */
function makeRelay() {
  const relay = { frames: [], host: null, clients: new Map(), hostConnects: 0, mutate: null, nextCid: 1 };
  class Sock {
    constructor(url) {
      const q = new URL(url).searchParams;
      this.role = q.get("role");
      this.readyState = 0;
      this.l = {};
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.role === "host") {
          relay.host = this;
          relay.hostConnects++;
        } else {
          this.cid = `c${relay.nextCid++}`;
          relay.clients.set(this.cid, this);
          relay.host?.fire("message", { data: JSON.stringify({ t: "open", cid: this.cid }) });
        }
        this.fire("open", {});
      });
    }
    addEventListener(t, fn) {
      (this.l[t] ||= []).push(fn);
    }
    fire(t, ev) {
      for (const fn of this.l[t] ?? []) fn(ev);
    }
    send(data) {
      let dir = this.role === "host" ? "h2c" : "c2h";
      let raw = String(data);
      relay.frames.push({ dir, raw });
      if (relay.mutate) {
        raw = relay.mutate(dir, raw, this.cid);
        if (raw == null) return;
      }
      const f = JSON.parse(raw);
      queueMicrotask(() => {
        if (dir === "c2h") relay.host?.fire("message", { data: JSON.stringify({ ...f, cid: this.cid }) });
        else relay.clients.get(f.cid)?.fire("message", { data: JSON.stringify(f.t === "close" ? { t: "close" } : { t: "msg", b: f.b }) });
        if (dir === "h2c" && f.t === "close") relay.clients.get(f.cid)?.fire("close", {});
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.role === "host") {
        if (relay.host === this) relay.host = null;
        this.fire("close", {});
      } else {
        relay.clients.delete(this.cid);
        relay.host?.fire("message", { data: JSON.stringify({ t: "close", cid: this.cid }) });
        this.fire("close", {});
      }
    }
  }
  relay.Sock = Sock;
  relay.dropHost = () => relay.host?.close();
  return relay;
}

function makeHost(relay, over = {}) {
  const calls = { http: [], redeem: [] };
  const timers = [];
  const events = [];
  const host = createRelayHost({
    endpoint: "wss://relay.example/",
    hostId: HOST_ID,
    hostKey,
    WebSocketImpl: relay.Sock,
    setTimeoutFn: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeoutFn: () => {},
    rand: () => 0.5,
    onEvent: (e) => events.push(e),
    redeem: async ({ code, label }) => (calls.redeem.push({ code, label }), code === "123456" ? { deviceId: "dev-1", token: "tok-SECRET-1" } : null),
    authenticate: async (t) => (t === "tok-SECRET-1" ? { deviceId: "dev-1" } : null),
    handleHttp: async (req) => (calls.http.push(req), { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(`echo:${req.method}:${req.path}:${req.body}`) }),
    openWs: async ({ send }) => ({ message: (d) => send(`ws-echo:${d}`, false), close() {} }),
    ...over,
  });
  return { host, calls, timers, events };
}
const connect = (relay, pub = hostKey.pubB64) =>
  connectRelay({ endpoint: "wss://relay.example", hostId: HOST_ID, hostPubKey: pub, WebSocketImpl: relay.Sock });
async function paired(relay) {
  const c = await connect(relay);
  await c.redeem("123456", "Pixel");
  return c;
}

describe("host keypair", () => {
  test("created once, reloaded identically, 0600 where supported", () => {
    const f = join(tmp, "kp", "host-keypair.json");
    const a = loadOrCreateHostKeypair(f);
    const b = loadOrCreateHostKeypair(f);
    assert.equal(a.pubB64, b.pubB64);
    assert.equal(Buffer.from(a.pubB64, "base64").length, 32);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).alg, "x25519");
    if (process.platform !== "win32") assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.match(hostFingerprint(a.pubB64), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});

describe("handshake + channel", () => {
  test("node reference client and TS client both round-trip with the host", async () => {
    const hs = startClientHandshake(hostKey.publicRaw, HOST_ID);
    const { reply, channel: hostCh } = acceptHandshake(hs.msg1, { hostKey, hostId: HOST_ID });
    const clientCh = hs.finish(reply);
    assert.equal(hostCh.open(clientCh.seal(Buffer.from("ping"))).toString(), "ping");
    assert.equal(clientCh.open(hostCh.seal(Buffer.from("pong"))).toString(), "pong");
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay); // TS WebCrypto client <-> node host
    assert.equal((await c.fetch("/api/hello")).status, 200);
    c.close();
    host.stop();
  });

  test("wrong pinned host key fails before anything is sent", async () => {
    const relay = makeRelay();
    const { host, calls } = makeHost(relay);
    host.start();
    await tick();
    const other = Buffer.from(generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
    await assert.rejects(connect(relay, other), RelayAuthError);
    assert.equal(calls.redeem.length, 0);
    const hs = startClientHandshake(Buffer.from(other, "base64"), HOST_ID);
    assert.throws(() => hs.finish(acceptHandshake(hs.msg1, { hostKey, hostId: HOST_ID }).reply));
    host.stop();
  });

  test("hostId is bound into the transcript", () => {
    const hs = startClientHandshake(hostKey.publicRaw, "other-host");
    assert.throws(() => hs.finish(acceptHandshake(hs.msg1, { hostKey, hostId: HOST_ID }).reply));
  });

  test("tampered ciphertext and replayed/reordered records are rejected", () => {
    const hs = startClientHandshake(hostKey.publicRaw, HOST_ID);
    const { reply, channel: h } = acceptHandshake(hs.msg1, { hostKey, hostId: HOST_ID });
    const c = hs.finish(reply);
    const r0 = c.seal(Buffer.from("one"));
    const r1 = c.seal(Buffer.from("two"));
    const bad = Buffer.from(r0);
    bad[bad.length - 1] ^= 1;
    assert.throws(() => h.open(bad), /Unsupported state|auth/i);
    assert.equal(h.open(r0).toString(), "one");
    assert.throws(() => h.open(r0), /replayed/);
    assert.throws(() => h.open(Buffer.concat([r1.subarray(0, 8), Buffer.alloc(40)])), Error);
    assert.equal(h.open(r1).toString(), "two");
    const r3 = (c.seal(Buffer.from("skip")), c.seal(Buffer.from("three")));
    assert.throws(() => h.open(r3), /out-of-order/);
  });

  test("tampering on the wire kills the session (relay sees close)", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    relay.mutate = (dir, raw) => {
      if (dir !== "c2h") return raw;
      const f = JSON.parse(raw);
      const b = Buffer.from(f.b, "base64");
      b[b.length - 1] ^= 0xff;
      return JSON.stringify({ ...f, b: b.toString("base64") });
    };
    const before = relay.frames.length;
    await assert.rejects(c.fetch("/api/x"));
    assert.ok(relay.frames.slice(before).some((f) => f.dir === "h2c" && JSON.parse(f.raw).t === "close"));
    assert.equal(host.status().sessions, 0);
    host.stop();
  });

  test("a replayed client frame closes the session", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    await c.fetch("/api/a");
    const last = [...relay.frames].reverse().find((f) => f.dir === "c2h");
    relay.host.fire("message", { data: JSON.stringify({ ...JSON.parse(last.raw), cid: "c1" }) });
    await until(() => host.status().sessions === 0);
    host.stop();
  });
});

describe("allowlist", () => {
  test("pure function: allows app roots, denies the rest", () => {
    for (const p of ["/api/teams", "/__vibesquad/teams?x=1", "/ws", "/__vibesquad/inbox"]) assert.equal(isRelayPathAllowed("GET", p), true, p);
    for (const p of [
      "/__vibesquad/first-run/status",
      "/__vibesquad/first-run",
      "/__vibesquad/local-image?path=C:/x.png",
      "/__vibesquad/pair/redeem",
      "/%5f%5fvibesquad/first-run/x",
      "/__VIBESQUAD/FIRST-RUN/x",
      "/api/../etc/passwd",
      "/api/%2e%2e/x",
      "/api/a%2fb",
      "/api/%252e%252e/x",
      "//evil.example/api",
      "/api\\x",
      "http://evil/api",
      "/etc/passwd",
      "/",
      "/wsx",
      "/api/x\n",
    ])
      assert.equal(isRelayPathAllowed("GET", p), false, p);
    assert.equal(isRelayPathAllowed("TRACE", "/api/x"), false);
  });

  test("denied path through the tunnel returns 403 and never reaches the handler", async () => {
    const relay = makeRelay();
    const { host, calls } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    assert.equal((await c.fetch("/__vibesquad/first-run/status")).status, 403);
    assert.equal((await c.fetch("/__vibesquad/local-image?path=x")).status, 403);
    assert.equal(calls.http.length, 0);
    host.stop();
  });
});

describe("redeem, auth, mux, revoke", () => {
  test("code redeem inside the channel returns a token; bad code is refused; handler never sees credentials headers", async () => {
    const relay = makeRelay();
    const { host, calls } = makeHost(relay);
    host.start();
    await tick();
    const c = await connect(relay);
    await assert.rejects(c.redeem("000000"), RelayAuthError);
    const r = await c.redeem("123456", "Pixel 9");
    assert.deepEqual(r, { deviceId: "dev-1", token: "tok-SECRET-1" });
    assert.equal(calls.redeem.at(-1).label, "Pixel 9");
    const res = await c.fetch("/api/echo?q=1", { method: "POST", body: "hello", headers: { "content-type": "text/plain", cookie: "x=1", authorization: "Bearer evil" } });
    assert.equal(await res.text(), "echo:POST:/api/echo?q=1:hello");
    assert.deepEqual(Object.keys(calls.http[0].headers), ["content-type"]);
    assert.equal(calls.http[0].deviceId, "dev-1");
    host.stop();
  });

  test("token auth works on a fresh session; bad token refused; http before auth closes the session", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await connect(relay);
    assert.deepEqual(await c.authenticate("tok-SECRET-1"), { deviceId: "dev-1" });
    const bad = await connect(relay);
    await assert.rejects(bad.authenticate("nope"), RelayAuthError);
    const anon = await connect(relay);
    await assert.rejects(anon.fetch("/api/x"));
    host.stop();
  });

  test("redeem attempts are capped per session", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay, { maxRedeemAttempts: 2 });
    host.start();
    await tick();
    const c = await connect(relay);
    await assert.rejects(c.redeem("1"));
    await assert.rejects(c.redeem("2"));
    await assert.rejects(c.redeem("123456")); // third attempt: session closed
    host.stop();
  });

  test("websocket frames are multiplexed both ways; large bodies are chunked", async () => {
    const relay = makeRelay();
    const big = Buffer.alloc(500_000, 7);
    const { host } = makeHost(relay, { handleHttp: async () => ({ status: 200, body: big }) });
    host.start();
    await tick();
    const c = await paired(relay);
    const ws = await c.openWebSocket("/ws");
    const got = new Promise((r) => (ws.onmessage = (e) => r(e.data)));
    ws.send("hi");
    assert.equal(await got, "ws-echo:hi");
    await assert.rejects(c.openWebSocket("/__vibesquad/first-run/ws"));
    const res = await c.fetch("/api/big");
    assert.equal(Buffer.from(await res.arrayBuffer()).compare(big), 0);
    host.stop();
  });

  test("revoke(deviceId) closes that device's sessions immediately", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    const other = await connect(relay); // unauthenticated: must survive
    let closed = false;
    c.onclose = () => (closed = true);
    assert.equal(host.revoke("dev-1"), 1);
    await until(() => closed);
    await assert.rejects(c.fetch("/api/x"));
    assert.equal(host.status().sessions, 1);
    assert.equal(host.revoke("nobody"), 0);
    other.close();
    host.stop();
  });
});

describe("reconnect", () => {
  test("backoff doubles, caps, jitters", () => {
    const mid = { rand: () => 0.5 };
    assert.deepEqual([0, 1, 2, 3].map((a) => backoffDelay(a, mid)), [1000, 2000, 4000, 8000]);
    assert.equal(backoffDelay(20, mid), 60_000);
    assert.equal(backoffDelay(0, { rand: () => 0 }), 700);
    assert.equal(backoffDelay(0, { rand: () => 1 }), 1300);
  });

  test("host redials after the relay drops, attempt resets once connected", async () => {
    const relay = makeRelay();
    const { host, timers, events } = makeHost(relay);
    host.start();
    await tick();
    assert.equal(relay.hostConnects, 1);
    relay.dropHost();
    assert.equal(timers.at(-1).ms, 1000);
    assert.equal(host.status().attempt, 1);
    timers.at(-1).fn();
    await tick();
    assert.equal(relay.hostConnects, 2);
    assert.equal(host.status().attempt, 0);
    relay.dropHost();
    relay.dropHost();
    assert.equal(timers.filter((t) => t.ms === 1000).length, 2);
    assert.ok(events.some((e) => e.type === "reconnect-scheduled"));
    host.stop();
    timers.at(-1).fn();
    await tick();
    assert.equal(relay.hostConnects, 2, "stop() prevents redial");
  });
});

describe("untrusted relay", () => {
  test("every recorded frame is opaque: no path, body, code or token appears", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await connect(relay);
    await c.redeem("123456", "Pixel-LABEL");
    await c.fetch("/api/PLAINPATH-MARKER", { method: "POST", body: "PLAINBODY-MARKER" });
    const ws = await c.openWebSocket("/ws");
    ws.send("PLAINWS-MARKER");
    await tick();
    const wire = relay.frames.map((f) => f.raw).join("\n");
    assert.ok(relay.frames.length > 8);
    for (const needle of ["PLAINPATH", "PLAINBODY", "PLAINWS", "tok-SECRET", "123456", "Pixel-LABEL", "redeem", "echo:"]) {
      assert.ok(!wire.includes(needle), `leaked ${needle}`);
      assert.ok(!Buffer.from(wire.split("\n").map((l) => (JSON.parse(l).b ? Buffer.from(JSON.parse(l).b, "base64").toString("latin1") : "")).join(""), "latin1").includes(needle), `leaked ${needle} (decoded)`);
    }
    host.stop();
  });
});
