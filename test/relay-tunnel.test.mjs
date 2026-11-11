// E5 outbound E2EE relay: host (server/relay-tunnel.mjs) <-> client (src/remoteRelayTransport.ts) through a fake,
// recording, untrusted relay. No network. Run: node --test --import ./test/setup/hermetic.mjs test/relay-tunnel.test.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  connectRelay as connectRelayStrict,
  newKex,
  RelayAuthError,
  RelayPendingError,
  RelayRekeyError,
  selfCertifyingHostId as tsSelfId,
  takePairingFragment,
  transcriptHash as tsTranscript,
} from "../src/remoteRelayTransport.ts";
import {
  acceptHandshake,
  backoffDelay,
  createInProcessDispatcher,
  createInProcessStreamBridge,
  createRelayHost,
  createSyntheticRequest,
  hostFingerprint,
  isRelayPathAllowed,
  isRelayRequest,
  normalizeRelayTarget,
  selfCertifyingHostId,
  transcriptHash,
  keypairFileStamp,
  loadOrCreateHostKeypair,
  rotateHostKeypair,
  startClientHandshake,
} from "../server/relay-tunnel.mjs";
import { makeRelay } from "./helpers/fake-relay.mjs";

// Tests use free-form host ids; production default is self-certified (X1 M-2). Strict behaviour has its own tests.
const connectRelay = (o) => connectRelayStrict({ requireSelfCertifiedHostId: false, ...o });
const tmp = mkdtempSync(join(tmpdir(), "vs-relay-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const HOST_ID = "host-test-1";
const hostKey = loadOrCreateHostKeypair(join(tmp, "k", "host-keypair.json"));
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, n = 200000) => {
  for (let i = 0; i < n; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error("timed out waiting");
};


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

// ---- Fable design review + Review-Gemini R1 ----------------------------------------------------------------------------

const cids = (relay) => [...relay.clients.keys()];
const hostFire = (relay, obj) => relay.host.fire("message", { data: JSON.stringify(obj) });

describe("H1 in-process dispatch", () => {
  test("synthetic request is a relay principal, never loopback, with no credential headers", () => {
    const req = createSyntheticRequest({ method: "GET", path: "/api/x", headers: { accept: "*/*" }, deviceId: "dev-9" });
    assert.equal(isRelayRequest(req), true);
    assert.equal(req.relayDevice.id, "dev-9");
    assert.throws(() => (req.relayDevice.id = "dev-1"), TypeError, "frozen");
    for (const loop of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]) assert.notEqual(req.socket.remoteAddress, loop);
    assert.notEqual(req.socket.localAddress, "127.0.0.1");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(isRelayRequest({ socket: { remoteAddress: "127.0.0.1" } }), false);
  });

  test("end to end: listener sees relayDevice + canonical url; set-cookie never reaches the client", async () => {
    const seen = [];
    const listener = (req, res) => {
      seen.push({ rd: req.relayDevice, url: req.url, addr: req.socket.remoteAddress });
      res.setHeader("Set-Cookie", "vs_session=abc");
      res.writeHead(200, { "content-type": "text/plain", "Set-Cookie": ["a=b"], "x-keep": "1" });
      res.end("hi");
    };
    const relay = makeRelay();
    const { host } = makeHost(relay, { handleHttp: createInProcessDispatcher(listener) });
    host.start();
    await tick();
    const c = await paired(relay);
    const res = await c.fetch("/api/a%20b?q=1");
    assert.equal(await res.text(), "hi");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("x-keep"), "1");
    assert.deepEqual(seen[0].rd, { id: "dev-1" });
    assert.equal(seen[0].url, "/api/a%20b?q=1");
    assert.equal(seen[0].addr, "relay");
    host.stop();
  });

  test("dispatcher maps a throwing listener to 500 and a hung one to 504", async () => {
    const boom = createInProcessDispatcher(() => Promise.reject(new Error("x")));
    assert.equal((await boom({ method: "GET", path: "/api/x", headers: {}, body: Buffer.alloc(0), deviceId: "d" })).status, 500);
    const hang = createInProcessDispatcher(() => {}, { timeoutMs: 20 });
    assert.equal((await hang({ method: "GET", path: "/api/x", headers: {}, body: Buffer.alloc(0), deviceId: "d" })).status, 504);
  });
});

describe("path normalization (R1 #2)", () => {
  test("validator and consumer see the same canonical string", async () => {
    assert.equal(normalizeRelayTarget("GET", "/api/a%20b?x=%2F").path, "/api/a%20b?x=%2F");
    assert.equal(normalizeRelayTarget("GET", "/api/%41%62").path, "/api/Ab");
    assert.equal(normalizeRelayTarget("GET", "/%5f%5fvibesquad/teams").path, "/__vibesquad/teams");
    for (const bad of ["/api/a%2fb", "/api/%2e", "/api/%2E%2e/x", "/api/a//b", "/%5f%5fvibesquad/first%2drun/x", "/api/%C3%28"])
      assert.equal(normalizeRelayTarget("GET", bad), null, bad);
    const relay = makeRelay();
    const { host, calls } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    await c.fetch("/%5f%5fvibesquad/teams?z=1");
    assert.equal(calls.http[0].path, "/__vibesquad/teams?z=1");
    host.stop();
  });
});

describe("H2 / R1 #1 host-wide redeem limit", () => {
  test("failures accumulate across sessions and reconnects; 10th burns codes and locks until a fresh mint", async () => {
    const relay = makeRelay();
    let burned = 0;
    const alerts = [];
    const { host, calls, timers } = makeHost(relay, { burnCodes: () => burned++, onNeedsYou: (e) => alerts.push(e) });
    host.start();
    await tick();
    for (let i = 0; i < 2; i++) {
      const c = await connect(relay);
      for (let k = 0; k < 4; k++) await assert.rejects(c.redeem("000000"));
    }
    assert.equal(host.status().redeemFails, 8);
    relay.dropHost();
    timers.at(-1).fn();
    await tick();
    const c3 = await connect(relay);
    await assert.rejects(c3.redeem("1"));
    assert.equal(burned, 0);
    await assert.rejects(c3.redeem("2")); // 10th failure
    assert.equal(burned, 1);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].type, /relay-redeem-flood/);
    assert.equal(host.status().redeemLocked, true);
    const before = calls.redeem.length;
    const c4 = await connect(relay);
    await assert.rejects(c4.redeem("123456"), /locked/); // correct code, but locked: callback never runs
    assert.equal(calls.redeem.length, before);
    host.noteFreshMint();
    assert.equal((await c4.redeem("123456")).deviceId, "dev-1");
    host.stop();
  });

  test("a successful redeem resets the failure count", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await connect(relay);
    await assert.rejects(c.redeem("x"));
    assert.equal(host.status().redeemFails, 1);
    await c.redeem("123456");
    assert.equal(host.status().redeemFails, 0);
    host.stop();
  });
});

describe("M2 revocation re-check on every dispatch", () => {
  test("an out-of-process revoke (store flips, no revoke() call) kills the session on the next request", async () => {
    const revoked = new Set();
    const relay = makeRelay();
    const { host, events } = makeHost(relay, { isRevoked: async (id) => revoked.has(id) });
    host.start();
    await tick();
    const c = await paired(relay);
    assert.equal((await c.fetch("/api/ok")).status, 200);
    revoked.add("dev-1");
    await assert.rejects(c.fetch("/api/ok"));
    assert.equal(host.status().sessions, 0);
    assert.ok(events.some((e) => e.type === "revoked-on-dispatch"));
    host.stop();
  });
});

describe("M4 transcript binding", () => {
  test("version byte and suite are hashed; TS and node agree; fixed vector", async () => {
    const S = Buffer.alloc(32, 1);
    const ec = Buffer.alloc(32, 2);
    const eh = Buffer.alloc(32, 3);
    const v1 = transcriptHash("h", S, ec, eh, 1);
    assert.notEqual(v1.toString("hex"), transcriptHash("h", S, ec, eh, 2).toString("hex"));
    assert.equal(Buffer.from(await tsTranscript("h", S, ec, eh, 1)).toString("hex"), v1.toString("hex"));
    assert.equal(v1.toString("hex"), "974f295e706e84deaaf748b7ed639f7a521b50842aca35726340efdbc21582e9");
  });

  test("self-certifying hostId helper agrees across implementations; client can require it", async () => {
    const id = selfCertifyingHostId(hostKey.publicRaw);
    assert.equal(await tsSelfId(hostKey.publicRaw), id);
    const relay = makeRelay();
    const { host } = makeHost(relay, { hostId: id });
    host.start();
    await tick();
    const ok = await connectRelay({ endpoint: "wss://r", hostId: id, hostPubKey: hostKey.pubB64, WebSocketImpl: relay.Sock, requireSelfCertifiedHostId: true });
    ok.close();
    await assert.rejects(
      connectRelay({ endpoint: "wss://r", hostId: "squatted", hostPubKey: hostKey.pubB64, WebSocketImpl: relay.Sock, requireSelfCertifiedHostId: true }),
      RelayAuthError,
    );
    host.stop();
  });
});

describe("M5 rekey", () => {
  test("record budget: host sends rekey and closes; client sees RelayRekeyError", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay, { maxSessionRecords: 8 });
    host.start();
    await tick();
    const c = await paired(relay);
    let reason;
    c.onclose = (r) => (reason = r);
    for (let i = 0; i < 10 && !reason; i++) await c.fetch("/api/x").catch(() => {});
    assert.ok(reason instanceof RelayRekeyError, String(reason?.message));
    assert.equal(host.status().sessions, 0);
    host.stop();
  });

  test("age budget (24h): next traffic triggers rekey; a fresh connect works again", async () => {
    let t = 1_000_000;
    const relay = makeRelay();
    const { host } = makeHost(relay, { now: () => t });
    host.start();
    await tick();
    const c = await paired(relay);
    let reason;
    c.onclose = (r) => (reason = r);
    t += 25 * 3600 * 1000;
    await c.fetch("/api/x").catch(() => {});
    assert.ok(reason instanceof RelayRekeyError, String(reason?.message));
    const c2 = await connect(relay);
    assert.deepEqual(await c2.authenticate("tok-SECRET-1"), { deviceId: "dev-1" });
    host.stop();
  });
});

describe("M3 eviction + R1 #8 limits", () => {
  test("when full, the oldest UNAUTHENTICATED session is evicted; authenticated ones are never evicted", async () => {
    const relay = makeRelay();
    const { host, events } = makeHost(relay, { maxSessions: 2 });
    host.start();
    await tick();
    const owner = await paired(relay); // authenticated
    const idle = await connect(relay); // unauthenticated
    let idleClosed = false;
    idle.onclose = () => (idleClosed = true);
    const fresh = await connect(relay); // full: evicts idle
    await until(() => idleClosed);
    assert.ok(events.some((e) => e.type === "evicted-unauthenticated"));
    assert.deepEqual(await fresh.authenticate("tok-SECRET-1"), { deviceId: "dev-1" });
    assert.equal(host.status().sessions, 2);
    // both slots are authenticated now: a newcomer is refused, nobody is evicted
    hostFire(relay, { t: "open", cid: "zz" });
    assert.equal(host.status().sessions, 2);
    assert.equal((await owner.fetch("/api/ok")).status, 200);
    host.stop();
  });

  test("authTimeoutMs closes a session that never authenticates", async () => {
    const relay = makeRelay();
    const { host, timers } = makeHost(relay, { authTimeoutMs: 1234 });
    host.start();
    await tick();
    const c = await connect(relay);
    let closed = false;
    c.onclose = () => (closed = true);
    const t = timers.find((x) => x.ms === 1234);
    assert.ok(t);
    t.fn();
    await until(() => closed);
    assert.equal(host.status().sessions, 0);
    host.stop();
  });

  test("429 over maxHttpPerSession completes cleanly (no hang, no leak)", async () => {
    const relay = makeRelay();
    let release;
    const gate = new Promise((r) => (release = r));
    const { host } = makeHost(relay, { maxHttpPerSession: 1, handleHttp: async () => (await gate, { status: 200, body: "ok" }) });
    host.start();
    await tick();
    const c = await paired(relay);
    const first = c.fetch("/api/slow");
    await tick();
    const second = await c.fetch("/api/second");
    assert.equal(second.status, 429);
    release();
    assert.equal(await (await first).text(), "ok");
    host.stop();
  });

  test("a throwing handler yields a finished 502", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay, {
      handleHttp: async () => {
        throw new Error("boom");
      },
    });
    host.start();
    await tick();
    const c = await paired(relay);
    assert.equal((await c.fetch("/api/x")).status, 502);
    host.stop();
  });
});

describe("size caps + leaks (R1 #3-#7)", () => {
  test("host drops an oversize relay frame before parsing it", async () => {
    const relay = makeRelay();
    const { host, events } = makeHost(relay);
    host.start();
    await tick();
    relay.host.fire("message", { data: "x".repeat(2_000_000) });
    assert.ok(events.some((e) => e.type === "oversize-frame"));
    host.stop();
  });

  test("client caps response bytes and kills the session on an oversize frame", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay, { handleHttp: async () => ({ status: 200, body: Buffer.alloc(300_000, 1) }) });
    host.start();
    await tick();
    const c = await connectRelay({ endpoint: "wss://r", hostId: HOST_ID, hostPubKey: hostKey.pubB64, WebSocketImpl: relay.Sock, maxResponseBytes: 100_000 });
    await c.redeem("123456");
    await assert.rejects(c.fetch("/api/big"), /too large/);
    const c2 = await connect(relay);
    let reason;
    c2.onclose = (r) => (reason = r);
    relay.clients.get(cids(relay).at(-1)).fire("message", { data: "x".repeat(2_000_000) });
    assert.match(String(reason?.message), /oversize/);
    host.stop();
  });

  test("connect timeout closes the socket instead of leaking it", async () => {
    let closes = 0;
    class Never {
      readyState = 0;
      addEventListener() {}
      send() {}
      close() {
        closes++;
      }
    }
    await assert.rejects(connectRelay({ endpoint: "wss://r", hostId: HOST_ID, hostPubKey: hostKey.pubB64, WebSocketImpl: Never, timeoutMs: 20 }), /timed out/);
    assert.ok(closes >= 1);
  });

  test("a throwing WebSocket constructor emits connect-error and schedules a retry", () => {
    class Boom {
      constructor() {
        throw new Error("no net");
      }
    }
    const { host, events, timers } = makeHost(makeRelay(), { WebSocketImpl: Boom });
    host.start();
    assert.ok(events.some((e) => e.type === "connect-error"));
    assert.equal(timers.at(-1).ms, 1000);
    host.stop();
  });
});

describe("noble X25519 fallback", () => {
  test("noble and WebCrypto agree on DH, and a noble-only client talks to the node host", async () => {
    const a = await newKex(true);
    const b = await newKex(false);
    assert.equal(a.impl, "noble");
    assert.equal(b.impl, "webcrypto");
    assert.deepEqual(Buffer.from(await a.dh(b.pub)), Buffer.from(await b.dh(a.pub)));
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await connectRelay({ endpoint: "wss://r", hostId: HOST_ID, hostPubKey: hostKey.pubB64, WebSocketImpl: relay.Sock, forceNoble: true });
    assert.equal(c.kex, "noble");
    await c.redeem("123456");
    assert.equal((await c.fetch("/api/hello")).status, 200);
    host.stop();
  });

  test("a runtime without WebCrypto X25519 falls back automatically", async () => {
    const subtle = globalThis.crypto.subtle;
    const orig = subtle.generateKey.bind(subtle);
    subtle.generateKey = async (alg, ...rest) => {
      if (alg?.name === "X25519") throw new Error("NotSupportedError");
      return orig(alg, ...rest);
    };
    try {
      assert.equal((await newKex()).impl, "noble");
    } finally {
      delete subtle.generateKey;
    }
    assert.equal((await newKex()).impl, "webcrypto");
  });
});

describe("low-order peer key", () => {
  test("both X25519 backends reject a low-order host ephemeral with RelayAuthError", async () => {
    const { startHandshake } = await import("../src/remoteRelayTransport.ts");
    const junk = Buffer.alloc(32 + 8 + 16 + 5, 9);
    for (const forceNoble of [true, false]) {
      for (const point of [Buffer.alloc(32, 0), Buffer.concat([Buffer.from([1]), Buffer.alloc(31, 0)])]) {
        const hs = await startHandshake(hostKey.publicRaw, HOST_ID, await newKex(forceNoble));
        await assert.rejects(hs.finish(Buffer.concat([point, junk.subarray(32)])), RelayAuthError, `${forceNoble ? "noble" : "webcrypto"} ${point.toString("hex").slice(0, 4)}`);
      }
    }
  });
});

describe("H3 pairing fragment", () => {
  const link = () => `#hostId=h1&pub=${encodeURIComponent(hostKey.pubB64)}&relay=${encodeURIComponent("wss://relay.example")}&code=123456`;
  const win = (hash) => {
    const w = { location: { hash, pathname: "/pair", search: "?a=1" }, history: { calls: [], replaceState: (...a) => w.history.calls.push(a) } };
    return w;
  };

  test("reads hostId/pub/relay/code into memory and strips the fragment immediately", () => {
    const w = win(link());
    const f = takePairingFragment(w);
    assert.deepEqual(f, { hostId: "h1", pub: hostKey.pubB64, relay: "wss://relay.example", code: "123456" });
    assert.deepEqual(w.history.calls, [[null, "", "/pair?a=1"]]);
  });

  test("strips even a malformed pairing link but returns null; ignores unrelated fragments; rejects ws:// relays", () => {
    const bad = win("#hostId=h1&pub=AAAA&relay=wss%3A%2F%2Fr");
    assert.equal(takePairingFragment(bad), null);
    assert.equal(bad.history.calls.length, 1);
    const other = win("#section-2");
    assert.equal(takePairingFragment(other), null);
    assert.equal(other.history.calls.length, 0);
    const plain = win(link().replace("wss%3A", "ws%3A"));
    assert.equal(takePairingFragment(plain), null);
    assert.equal(takePairingFragment({}), null);
  });
});

// ---- X1 walk fix round (H-1, M-1..M-3, L-1..L-6) -----------------------------------------------------------------------

/** Talks the wire protocol by hand (node reference client) so tests can send exact frame sequences. */
async function rawSession(relay, cid) {
  const inbox = [];
  relay.clients.set(cid, { fire: (t, ev) => t === "message" && inbox.push(JSON.parse(ev.data)) });
  hostFire(relay, { t: "open", cid });
  const hs = startClientHandshake(hostKey.publicRaw, HOST_ID);
  hostFire(relay, { t: "msg", cid, b: hs.msg1.toString("base64") });
  await until(() => inbox.length);
  const ch = hs.finish(Buffer.from(inbox.shift().b, "base64"));
  return {
    send: (o) => hostFire(relay, { t: "msg", cid, b: ch.seal(Buffer.from(JSON.stringify(o))).toString("base64") }),
    recv: async () => {
      await until(() => inbox.length);
      const f = inbox.shift();
      return f.t === "close" ? f : JSON.parse(ch.open(Buffer.from(f.b, "base64")));
    },
    inbox,
  };
}

describe("X1 H-1 guesses are counted when issued", () => {
  const asyncRedeem = (log, gate) => async ({ code }) => {
    log.push(code);
    await (gate ?? new Promise((r) => setImmediate(r)));
    return null;
  };

  test("redeem-then-close per session cannot skip the counter: 50 sessions burn at the limit", async () => {
    const relay = makeRelay();
    const log = [];
    let burned = 0;
    const { host } = makeHost(relay, { redeem: asyncRedeem(log), burnCodes: () => burned++ });
    host.start();
    await tick();
    for (let i = 0; i < 50; i++) {
      const c = await connect(relay);
      const before = log.length;
      void c.redeem("000000").catch(() => {});
      await until(() => log.length > before || host.status().redeemLocked);
      c.close(); // closes while redeem() is still in flight
    }
    await until(() => host.status().redeemLocked);
    assert.equal(burned, 1);
    assert.ok(log.length <= 10, `redeem() reached ${log.length} times`);
    host.stop();
  });

  test("32 sessions x 5 guesses in a burst: at most the limit reaches redeem(), then burn + lock", async () => {
    const relay = makeRelay();
    const log = [];
    let burned = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const { host } = makeHost(relay, { redeem: asyncRedeem(log, gate), burnCodes: () => burned++ });
    host.start();
    await tick();
    const clients = [];
    for (let i = 0; i < 32; i++) clients.push(await connect(relay));
    const attempts = clients.map((c) => c.redeem("000000").catch(() => {}));
    for (const c of clients) for (let k = 0; k < 4; k++) void c.redeem("1").catch(() => {});
    await until(() => log.length >= 10);
    await tick();
    await tick();
    release();
    await Promise.all(attempts);
    await until(() => host.status().redeemLocked);
    assert.equal(log.length, 10);
    assert.equal(burned, 1);
    host.stop();
  });

  test("a successful redeem does not erase guesses that are still in flight", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await connect(relay);
    await c.redeem("123456");
    assert.equal(host.status().redeemFails, 0);
    host.stop();
  });

  test("auth failures are counted before the await too", async () => {
    const relay = makeRelay();
    let release;
    const gate = new Promise((r) => (release = r));
    const seen = [];
    const { host } = makeHost(relay, { authFailLimit: 3, authenticate: async (t) => (seen.push(t), await gate, null) });
    host.start();
    await tick();
    const cs = [];
    for (let i = 0; i < 6; i++) cs.push(await connect(relay));
    const results = cs.map((c) => c.authenticate("t").catch(() => {}));
    await until(() => seen.length >= 3);
    await tick();
    await tick();
    release();
    await Promise.all(results);
    assert.equal(seen.length, 3, "only authFailLimit lookups were issued");
    host.stop();
  });
});

describe("X1 M-1 client send order", () => {
  test("a slow encrypt on ctr 0 cannot let ctr 1 overtake it", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    const subtle = globalThis.crypto.subtle;
    const orig = subtle.encrypt.bind(subtle);
    let first = true;
    subtle.encrypt = async (...a) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 15));
      }
      return orig(...a);
    };
    try {
      const [a, b] = await Promise.all([c.fetch("/api/one"), c.fetch("/api/two")]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(host.status().sessions, 1, "host did not kill the session on out-of-order ctr");
    } finally {
      delete subtle.encrypt;
    }
    host.stop();
  });
});

describe("X1 M-2 pin rules", () => {
  test("self-certified hostId is the default; links must carry the id of their key", async () => {
    const { acceptPairingFragment } = await import("../src/remoteRelayTransport.ts");
    const relay = makeRelay();
    await assert.rejects(
      connectRelayStrict({ endpoint: "wss://r", hostId: "squatted", hostPubKey: hostKey.pubB64, WebSocketImpl: relay.Sock }),
      RelayAuthError,
    );
    const frag = { hostId: selfCertifyingHostId(hostKey.publicRaw), pub: hostKey.pubB64, relay: "wss://r", code: null };
    assert.equal(await acceptPairingFragment(frag), frag);
    await assert.rejects(acceptPairingFragment({ ...frag, hostId: "victim-host-id" }), RelayAuthError);
  });
});

describe("X1 M-3 ws-open slots and ordering", () => {
  test("caps and duplicate ids are enforced before the await; handles are not leaked", async () => {
    const relay = makeRelay();
    let release;
    const gate = new Promise((r) => (release = r));
    const opened = [];
    const { host } = makeHost(relay, {
      maxWsPerSession: 2,
      openWs: async ({ path }) => {
        await gate;
        const h = { got: [], closed: false, message(d) { h.got.push(d); }, close() { h.closed = true; } };
        opened.push(h);
        return h;
      },
    });
    host.start();
    await tick();
    const r = await rawSession(relay, "raw1");
    r.send({ t: "redeem", id: "r", code: "123456" });
    assert.equal((await r.recv()).ok, true);
    r.send({ t: "ws-open", id: "a", path: "/ws" });
    r.send({ t: "ws-open", id: "a", path: "/ws" }); // duplicate id
    r.send({ t: "ws-open", id: "b", path: "/ws" });
    r.send({ t: "ws-open", id: "c", path: "/ws" }); // over the cap of 2
    const early = [await r.recv(), await r.recv()];
    assert.deepEqual(early.map((f) => [f.id, f.ok]), [["a", false], ["c", false]]);
    release();
    const late = [await r.recv(), await r.recv()];
    assert.deepEqual(late.map((f) => f.ok), [true, true]);
    assert.equal(opened.length, 2, "openWs ran once per accepted id");
    host.stop();
  });

  test("frames reach the ws handler in order even when isRevoked does async work", async () => {
    const relay = makeRelay();
    let n = 0;
    const got = [];
    const { host } = makeHost(relay, {
      isRevoked: async () => {
        await new Promise((r) => setTimeout(r, n++ % 2 === 0 ? 8 : 0)); // alternate slow/fast lookups
        return false;
      },
      openWs: async () => ({ message: (d) => got.push(d), close() {} }),
    });
    host.start();
    await tick();
    const r = await rawSession(relay, "raw2");
    r.send({ t: "redeem", id: "r", code: "123456" });
    await r.recv();
    r.send({ t: "ws-open", id: "w", path: "/ws" });
    assert.equal((await r.recv()).ok, true);
    for (const d of ["1", "2", "3", "4", "5"]) r.send({ t: "ws-data", id: "w", data: d });
    await until(() => got.length === 5);
    assert.deepEqual(got, ["1", "2", "3", "4", "5"]);
    host.stop();
  });
});

describe("X1 lows", () => {
  test("L-1: host seal refuses >1 MiB; an oversize ws message closes only that stream (1009)", async () => {
    const hs = startClientHandshake(hostKey.publicRaw, HOST_ID);
    const { channel } = acceptHandshake(hs.msg1, { hostKey, hostId: HOST_ID });
    assert.throws(() => channel.seal(Buffer.alloc(1024 * 1024 + 1)), RangeError);
    const relay = makeRelay();
    let wsSend;
    const { host } = makeHost(relay, { openWs: async ({ send }) => ((wsSend = send), { message() {}, close() {} }) });
    host.start();
    await tick();
    const c = await paired(relay);
    const ws = await c.openWebSocket("/ws");
    let code;
    ws.onclose = (e) => (code = e.code);
    wsSend("x".repeat(2 * 1024 * 1024), false);
    await until(() => code !== undefined);
    assert.equal(code, 1009);
    assert.equal((await c.fetch("/api/still-alive")).status, 200);
    assert.equal(host.status().sessions, 1);
    host.stop();
  });

  test("L-2: synthetic res.headersSent flips once bytes are written", () => {
    const listenerSeen = [];
    const done = createInProcessDispatcher((req, res) => {
      listenerSeen.push(res.headersSent);
      res.write("a");
      listenerSeen.push(res.headersSent);
      res.end();
    });
    return done({ method: "GET", path: "/api/x", headers: {}, body: Buffer.alloc(0), deviceId: "d" }).then(() => {
      assert.deepEqual(listenerSeen, [false, true]);
    });
  });

  test("L-3: over-long code/token are rejected without reaching the callbacks", async () => {
    const relay = makeRelay();
    const seen = [];
    const { host } = makeHost(relay, {
      redeem: async (a) => (seen.push(["redeem", a.code]), null),
      authenticate: async (t) => (seen.push(["auth", t]), null),
    });
    host.start();
    await tick();
    const c = await connect(relay);
    await assert.rejects(c.redeem("1".repeat(17)));
    await assert.rejects(c.authenticate("t".repeat(129)));
    assert.deepEqual(seen, []);
    assert.equal(host.status().redeemFails, 1, "the bad code still counted as a guess");
    host.stop();
  });

  test("L-4: connectRelay refuses ws:// endpoints", async () => {
    await assert.rejects(connectRelay({ endpoint: "ws://relay.example", hostId: HOST_ID, hostPubKey: hostKey.pubB64, WebSocketImpl: makeRelay().Sock }), /wss/);
  });

  test("L-5: keypair loading never replaces an existing key", () => {
    const f = join(tmp, "race", "host-keypair.json");
    const a = loadOrCreateHostKeypair(f);
    const b = loadOrCreateHostKeypair(f);
    assert.equal(a.pubB64, b.pubB64);
  });

  test("L-6: synthetic requests carry a fixed sentinel host header", () => {
    const req = createSyntheticRequest({ method: "GET", path: "/api/x", deviceId: "d" });
    assert.equal(req.headers.host, "relay.invalid");
    assert.equal(req.headers.cookie, undefined);
  });
});

// ---- X1 R2 walk fix round (queue backpressure, openWs errors, oversize head) ---------------------------------------------

describe("X1 R2 backpressure before decrypt", () => {
  test("PoC E: frames behind a slow redeem are not queued; the session is closed after one in-flight frame pre-auth", async () => {
    const relay = makeRelay();
    let release;
    const gate = new Promise((r) => (release = r));
    const seen = [];
    const { host, events } = makeHost(relay, { redeem: async ({ code }) => (seen.push(code), await gate, null) });
    host.start();
    await tick();
    const r = await rawSession(relay, "e1");
    r.send({ t: "redeem", id: "1", code: "000001" });
    await until(() => seen.length === 1);
    for (let i = 0; i < 150; i++) r.send({ t: "redeem", id: String(i + 2), code: "x".repeat(900_000) }); // would be ~130 MiB if queued
    await until(() => host.status().sessions === 0);
    assert.ok(events.some((e) => e.type === "backpressure-overflow"));
    assert.equal(seen.length, 1);
    release();
    await tick();
    assert.equal(host.status().sessions, 0);
    host.stop();
  });

  test("post-auth budget: more queued frames than maxPendingFrames closes the session", async () => {
    const relay = makeRelay();
    let release;
    const gate = new Promise((r) => (release = r));
    const { host, events } = makeHost(relay, { maxPendingFrames: 3, isRevoked: async () => (await gate, false) });
    host.start();
    await tick();
    const r = await rawSession(relay, "e2");
    r.send({ t: "redeem", id: "r", code: "123456" });
    assert.equal((await r.recv()).ok, true);
    for (let i = 0; i < 6; i++) r.send({ t: "http", id: `h${i}`, method: "GET", path: "/api/x" });
    await until(() => host.status().sessions === 0);
    assert.ok(events.some((e) => e.type === "backpressure-overflow"));
    release();
    host.stop();
  });

  test("a normal burst within the budget still completes", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay);
    host.start();
    await tick();
    const c = await paired(relay);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => c.fetch(`/api/b${i}`)));
    assert.deepEqual(res.map((x) => x.status), Array(10).fill(200));
    host.stop();
  });
});

describe("X1 R2 lows", () => {
  test("openWs errors emit an event and answer ok:false for that stream only", async () => {
    const relay = makeRelay();
    const { host, events } = makeHost(relay, {
      openWs: async () => {
        throw new Error("upstream exploded");
      },
    });
    host.start();
    await tick();
    const c = await paired(relay);
    await assert.rejects(c.openWebSocket("/ws"), /ws denied/);
    const ev = events.find((e) => e.type === "ws-open-error");
    assert.ok(ev);
    assert.match(ev.reason, /upstream exploded/);
    assert.equal((await c.fetch("/api/alive")).status, 200);
    host.stop();
  });

  test("an oversize response head becomes one finished 502; no body chunks follow", async () => {
    const relay = makeRelay();
    const { host } = makeHost(relay, {
      handleHttp: async () => ({ status: 200, headers: { "x-big": "y".repeat(2 * 1024 * 1024) }, body: Buffer.alloc(400_000, 1) }),
    });
    host.start();
    await tick();
    const r = await rawSession(relay, "e3");
    r.send({ t: "redeem", id: "r", code: "123456" });
    await r.recv();
    r.send({ t: "http", id: "h", method: "GET", path: "/api/big-head" });
    const head = await r.recv();
    assert.equal(head.status, 502);
    assert.equal(head.fin, true);
    for (let i = 0; i < 50; i++) await tick();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.inbox.length, 0, "no http-body frames after the 502");
    host.stop();
  });
});

// ---- E5 wiring hooks that live in the core (unit-and-end-e5-wire): key rotation, the SSE stream bridge, E4b pending ----
describe("E5 wiring: host key rotation", () => {
  test("rotateHostKeypair replaces the file atomically with a different key; the stamp changes; the old key is gone", () => {
    const file = join(tmp, "rot", "host-keypair.json");
    const before = loadOrCreateHostKeypair(file);
    const stampBefore = keypairFileStamp(file);
    const next = rotateHostKeypair(file);
    assert.notEqual(next.pubB64, before.pubB64, "a fresh key");
    assert.equal(loadOrCreateHostKeypair(file).pubB64, next.pubB64, "the file now holds the new key");
    assert.notEqual(keypairFileStamp(file), stampBefore, "a running host can notice the rotation by stat alone");
    assert.notEqual(selfCertifyingHostId(next.publicRaw), selfCertifyingHostId(before.publicRaw), "new self-certifying host id");
    const oldPubUrl = before.pubB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.ok(!readFileSync(file, "utf8").includes(oldPubUrl), "old public key not in the file");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(keypairFileStamp(join(tmp, "rot", "missing.json")).endsWith("|missing"), true);
    assert.deepEqual(readdirSync(join(tmp, "rot")), ["host-keypair.json"], "no leftover temp files next to the key");
  });

  test("a client pinned to the old key fails the handshake against a host that rotated; the new key works", async () => {
    const file = join(tmp, "rot2", "host-keypair.json");
    const oldKey = loadOrCreateHostKeypair(file);
    const newKey = rotateHostKeypair(file);
    const relay = makeRelay();
    const { host } = makeHost(relay, { hostKey: newKey });
    host.start();
    await tick();
    await assert.rejects(connect(relay, oldKey.pubB64), RelayAuthError);
    const c = await connect(relay, newKey.pubB64);
    await c.redeem("123456");
    assert.equal((await c.fetch("/api/x")).status, 200);
    host.stop();
  });
});

describe("E5 wiring: in-process stream bridge (openWs for a server without WebSockets)", () => {
  /** A request listener with an SSE route, a never-ending route and an error route; records what it saw. */
  function sseListener(seen) {
    return (req, res) => {
      seen.push({ url: req.url, method: req.method, relayDevice: req.relayDevice?.id, local: req.socket.localAddress });
      if (req.url.startsWith("/api/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: a\ndata: 1\n\n");
        let n = 1;
        const t = setInterval(() => {
          n++;
          res.write(`data: ${n}\n\n`);
          if (n === 3) {
            clearInterval(t);
            res.end();
          }
        }, 2);
        res.on("close", () => {
          clearInterval(t);
          seen.push({ closed: req.url });
        });
        return;
      }
      if (req.url.startsWith("/api/forever")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: open\n\n");
        res.on("close", () => seen.push({ closed: req.url }));
        return;
      }
      res.setHeader("set-cookie", "vs_local=leak");
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unpaired device"}');
    };
  }

  test("every chunk the handler writes arrives in order as ws-data; the handler ending closes the stream with 1000", async () => {
    const seen = [];
    const relay = makeRelay();
    const { host } = makeHost(relay, { openWs: createInProcessStreamBridge(sseListener(seen)) });
    host.start();
    await tick();
    const c = await paired(relay);
    const ws = await c.openWebSocket("/api/events?x=1");
    const got = [];
    let closeCode = null;
    ws.onmessage = (ev) => got.push(ev.data);
    ws.onclose = (ev) => (closeCode = ev.code);
    await until(() => closeCode !== null, 20000);
    assert.deepEqual(got, ["event: a\ndata: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
    assert.equal(closeCode, 1000);
    assert.equal(seen[0].relayDevice, "dev-1", "the stream runs as the relay principal");
    assert.equal(seen[0].local, "relay", "never a loopback socket");
    assert.equal(seen[0].url, "/api/events?x=1");
    host.stop();
  });

  test("the client closing, or a revoke closing the session, destroys the in-process request so the handler's close listener runs", async () => {
    const seen = [];
    const relay = makeRelay();
    const { host } = makeHost(relay, { openWs: createInProcessStreamBridge(sseListener(seen)) });
    host.start();
    await tick();
    const c = await paired(relay);
    const ws = await c.openWebSocket("/api/forever");
    const got = [];
    ws.onmessage = (ev) => got.push(ev.data);
    await until(() => got.length === 1);
    ws.close();
    await until(() => seen.some((s) => s.closed === "/api/forever"));
    const ws2 = await c.openWebSocket("/api/forever");
    let closed2 = null;
    ws2.onclose = (ev) => (closed2 = ev.code);
    await until(() => seen.filter((s) => s.url === "/api/forever").length === 2);
    host.revoke("dev-1");
    await until(() => seen.filter((s) => s.closed === "/api/forever").length === 2);
    await until(() => closed2 !== null);
    host.stop();
  });

  test("a non-2xx answer closes the stream with 4000+status and never sends its body", async () => {
    const seen = [];
    const relay = makeRelay();
    const { host } = makeHost(relay, { openWs: createInProcessStreamBridge(sseListener(seen)) });
    host.start();
    await tick();
    const c = await paired(relay);
    const ws = await c.openWebSocket("/api/denied");
    const got = [];
    let closeCode = null;
    ws.onmessage = (ev) => got.push(ev.data);
    ws.onclose = (ev) => (closeCode = ev.code);
    await until(() => closeCode !== null);
    assert.equal(closeCode, 4401);
    assert.deepEqual(got, []);
    host.stop();
  });
});

describe("E5 wiring: E4b pending redeem inside the channel", () => {
  test("a device-minted code answers pending without authenticating the session; polling with the pending token costs no attempt; approval then authenticates", async () => {
    const relay = makeRelay();
    let approved = false;
    const { host, calls } = makeHost(relay, {
      redeem: async ({ code }) => (code === "222222" ? { deviceId: "pend-1", token: "tok-PENDING", pending: true } : null),
      authenticate: async (t) => (t === "tok-PENDING" ? (approved ? { deviceId: "dev-9" } : { pending: true }) : null),
      authFailLimit: 2,
    });
    host.start();
    await tick();
    const c = await connect(relay);
    const r = await c.redeem("222222", "Work PC");
    assert.deepEqual(r, { deviceId: "pend-1", token: "tok-PENDING", pending: true });
    let closedReason = null;
    c.onclose = (e) => (closedReason = e);
    await assert.rejects(c.fetch("/api/x")); // not authenticated: a request is a protocol violation, session closed
    assert.ok(closedReason);
    const c2 = await connect(relay);
    for (let i = 0; i < 6; i++) await assert.rejects(c2.authenticate("tok-PENDING"), RelayPendingError);
    assert.equal(host.status().sessions, 1, "polling never closed the session (per-session cap is 5)");
    approved = true;
    assert.deepEqual(await c2.authenticate("tok-PENDING"), { deviceId: "dev-9" });
    assert.equal((await c2.fetch("/api/after")).status, 200);
    assert.equal(calls.http.at(-1).deviceId, "dev-9");
    const c3 = await connect(relay);
    await assert.rejects(c3.authenticate("tok-WRONG"), /token rejected/);
    await assert.rejects(c3.authenticate("tok-WRONG"), /token rejected/);
    await assert.rejects(c3.authenticate("tok-PENDING"), /token rejected/); // host-wide throttle (authFailLimit 2) now applies
    host.stop();
  });
});
