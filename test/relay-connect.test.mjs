// E5 §7 item 8 client side (docs/lanes/android-app/E5_THREAT_MODEL.md §7 pin-store rule, §11, X1 wire L2;
// unit-and-e5-relay-links): src/remoteRelayConnect.ts. The stored pin always wins over a link, a different key for a
// known host is RelayPinMismatchError, a known host's relay endpoint moves only after the user said yes (default keeps
// it), nothing is written before the pinned handshake + redeem succeeded, and the E4a id + relay id of one PC fold
// into ONE hosts[] entry. Attacker cases are marked "attacker:".
// Run: node --test --import ./test/setup/hermetic.mjs test/relay-connect.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { makeRelay } from "./helpers/fake-relay.mjs";

const tunnel = await import("../server/relay-tunnel.mjs");
const link = await import("../server/relay-link.mjs");
const connectMod = await import("../src/remoteRelayConnect.ts");
const session = await import("../src/remoteSession.ts");
const transport = await import("../src/remoteRelayTransport.ts");
const { parseRelayPairingLink, resolveRelayPin, connectWithRelayLink, relayConnectErrorMessage } = connectMod;
const { readSession, relayPinFor, saveSession, saveRelayPin, foldRelayHost, RelayPinMismatchError, REMOTE_SESSION_KEY } = session;

const dir = mkdtempSync(join(tmpdir(), "vs-relay-connect-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const keyA = tunnel.loadOrCreateHostKeypair(join(dir, "host-a.json"));
const keyB = tunnel.loadOrCreateHostKeypair(join(dir, "host-b.json")); // attacker: a second, unrelated host key
const ID_A = tunnel.selfCertifyingHostId(keyA.publicRaw);
const ID_B = tunnel.selfCertifyingHostId(keyB.publicRaw);
const PUB_A = keyA.pubB64;
const PUB_B = keyB.pubB64;
const E4A_ID = "Qm9yZWFsaXNIb3N0SWQxMg"; // the PC's ~/.vibesquad/host-id (22 url-safe chars)
const RELAY_1 = "wss://relay-one.example/ws";
const RELAY_2 = "wss://relay-two.example/ws";
const mkLink = (o = {}) => link.buildRelayPairingLink({ hostId: ID_A, pub: PUB_A, relay: RELAY_1, code: "123456", ...o });

const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};
const snapshot = (store) => store.getItem(REMOTE_SESSION_KEY);

/** A RelayClient double: records what the connect path asked for and what it sent. */
function fakeClient({ redeem, authenticate, status } = {}) {
  const calls = { connect: [], redeem: [], authenticate: [], fetch: [], closed: 0 };
  const client = {
    kex: "webcrypto",
    async redeem(code, label) {
      calls.redeem.push({ code, label });
      if (redeem) return redeem(code, label);
      return { deviceId: "dev-1", token: "tok-1" };
    },
    async authenticate(token) {
      calls.authenticate.push(token);
      if (authenticate) return authenticate(token);
      return { deviceId: "dev-1" };
    },
    async fetch(path) {
      calls.fetch.push(String(path));
      const body = status ? status() : { ok: true, paired: true, hostId: E4A_ID, relay: { hostId: ID_A, pub: PUB_A } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    async openWebSocket() {
      throw new Error("not in this test");
    },
    close() {
      calls.closed++;
    },
    onclose: null,
  };
  const connect = async (opts) => {
    calls.connect.push(opts);
    return client;
  };
  return { client, calls, connect };
}

describe("parseRelayPairingLink", () => {
  test("reads the APK deep link and an https link carrying the fragment; the pub comes out as base64", () => {
    const f = parseRelayPairingLink(mkLink());
    assert.ok(f);
    assert.equal(f.hostId, ID_A);
    assert.equal(f.relay, RELAY_1);
    assert.equal(f.code, "123456");
    assert.equal(Buffer.from(f.pub, "base64").toString("base64"), PUB_A);
    assert.ok(parseRelayPairingLink(mkLink({ base: "https://app.example/pair" })));
    assert.ok(parseRelayPairingLink(mkLink({ base: "https://app.example/pair?x=1" })));
    assert.equal(parseRelayPairingLink(`  ${mkLink()}  `)?.hostId, ID_A, "whitespace tolerated");
  });

  test("rejects LAN links, addresses, codes, junk, a clear-text relay and a bad key", () => {
    assert.equal(parseRelayPairingLink("https://100.64.0.7:4180/pair?code=123456"), null);
    assert.equal(parseRelayPairingLink("vibesquad://pair?host=pc.example:4180&code=123456"), null);
    assert.equal(parseRelayPairingLink("pc.example:4180"), null);
    assert.equal(parseRelayPairingLink("123456"), null);
    assert.equal(parseRelayPairingLink(""), null);
    assert.equal(parseRelayPairingLink(`vibesquad://pair#hostId=${ID_A}&pub=${keyA.publicRaw.toString("base64url")}&relay=ws%3A%2F%2Frelay.example%2Fws&code=123456`), null);
    assert.equal(parseRelayPairingLink(`vibesquad://pair#hostId=${ID_A}&pub=c2hvcnQ&relay=wss%3A%2F%2Frelay.example%2Fws&code=123456`), null);
    assert.equal(parseRelayPairingLink(`http://app.example/pair#hostId=${ID_A}&pub=${keyA.publicRaw.toString("base64url")}&relay=wss%3A%2F%2Fr%2Fws`), null, "a web link must be https");
  });
});

describe("resolveRelayPin: stored pin wins, mismatch is an error, endpoint moves need a yes (X1 wire L2)", () => {
  test("new host: the link's pin, nothing written", async () => {
    const store = fakeStore();
    const d = await resolveRelayPin(parseRelayPairingLink(mkLink()), { store });
    assert.deepEqual(d, { pin: { hostId: ID_A, endpoint: RELAY_1, pubKey: Buffer.from(PUB_A, "base64").toString("base64") }, known: false, repointed: false, label: "relay-one.example" });
    assert.equal(snapshot(store), null, "resolve never writes");
  });

  test("attacker: a link whose hostId is not the self-certifying id of its pub is refused before anything else", async () => {
    const store = fakeStore();
    const f = parseRelayPairingLink(link.buildRelayPairingLink({ hostId: ID_A, pub: PUB_B, relay: RELAY_1, code: "123456" }));
    await assert.rejects(resolveRelayPin(f, { store }), transport.RelayAuthError);
    assert.equal(snapshot(store), null);
  });

  test("attacker: a known host with a different key is RelayPinMismatchError; the confirm is never asked and the store is byte-identical", async () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY_1, pubKey: PUB_A }, store, new Date("2026-11-11T00:00:00Z"), "Home PC", { token: "tok-1" });
    const before = snapshot(store);
    // The attacker cannot forge ID_A's key, so the only way to name a KNOWN id with another key is a tampered store or a
    // rotated host; either way the stored key wins and the user is told.
    const f = { hostId: ID_A, pub: Buffer.from(PUB_B, "base64").toString("base64"), relay: "wss://evil.example/ws", code: "123456" };
    let asked = 0;
    await assert.rejects(
      resolveRelayPin({ ...f, pub: Buffer.from(PUB_A, "base64").toString("base64"), hostId: ID_A }, { store, confirmRepoint: () => (asked++, true) }).then(async () => {
        // same key path: fine. Now the mismatch path with the stored key swapped behind the id:
        store.setItem(REMOTE_SESSION_KEY, before.replace(Buffer.from(PUB_A, "base64").toString("base64"), Buffer.from(PUB_B, "base64").toString("base64")));
        asked = 0;
        await resolveRelayPin({ ...f, pub: Buffer.from(PUB_A, "base64").toString("base64") }, { store, confirmRepoint: () => (asked++, true) });
      }),
      RelayPinMismatchError,
    );
    assert.equal(asked, 0, "no endpoint question for a key mismatch");
    assert.match(relayConnectErrorMessage(new RelayPinMismatchError(ID_A)), /already trusts a different key/);
  });

  test("known host, same key, same endpoint: the stored pin (with its token) is used as is", async () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY_1, pubKey: PUB_A }, store, new Date(), "Home PC", { token: "tok-1" });
    const d = await resolveRelayPin(parseRelayPairingLink(mkLink({ relay: "wss://user:pw@relay-one.example/ws?x=1" })), { store, confirmRepoint: () => assert.fail("not asked") });
    assert.equal(d.known, true);
    assert.equal(d.repointed, false);
    assert.equal(d.label, "Home PC");
    assert.deepEqual(d.pin, relayPinFor(ID_A, store));
    assert.equal(d.pin.token, "tok-1");
  });

  test("attacker: a same-key link with another relay endpoint: without a confirm the stored endpoint stays; the user's yes moves it (not yet written)", async () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY_1, pubKey: PUB_A }, store, new Date(), "Home PC", { token: "tok-1" });
    const before = snapshot(store);
    const f = parseRelayPairingLink(mkLink({ relay: "wss://evil.example/ws" }));
    let d = await resolveRelayPin(f, { store });
    assert.equal(d.pin.endpoint, RELAY_1, "no confirm callback: keep");
    assert.equal(d.repointed, false);
    const asked = [];
    d = await resolveRelayPin(f, { store, confirmRepoint: (q) => (asked.push(q), false) });
    assert.deepEqual(asked, [{ label: "Home PC", from: RELAY_1, to: "wss://evil.example/ws" }]);
    assert.equal(d.pin.endpoint, RELAY_1, "the user said no: keep");
    d = await resolveRelayPin(f, { store, confirmRepoint: async () => true });
    assert.equal(d.pin.endpoint, "wss://evil.example/ws", "the user said yes");
    assert.equal(d.repointed, true);
    assert.equal(d.pin.token, "tok-1", "same pin, same token");
    assert.equal(snapshot(store), before, "resolve never writes; the move persists only after the session succeeded through it");
  });
});

describe("connectWithRelayLink: pinned connect, persist after success, one hosts[] entry per PC", () => {
  test("new host: connects with the link's pin, redeems the code, then stores pin + token; the E4a id learned over the channel keys the entry", async () => {
    const store = fakeStore();
    const { calls, connect } = fakeClient();
    const r = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store, connect, deviceName: "Pixel", now: new Date("2026-11-11T00:00:00Z") });
    assert.deepEqual(calls.connect, [{ endpoint: RELAY_1, hostId: ID_A, hostPubKey: Buffer.from(PUB_A, "base64").toString("base64") }]);
    assert.deepEqual(calls.redeem, [{ code: "123456", label: "Pixel" }]);
    assert.deepEqual(calls.authenticate, [], "a non-pending redeem authenticates the session itself");
    assert.deepEqual(calls.fetch, ["/api/auth/status"]);
    assert.equal(r.pending, false);
    assert.equal(r.deviceId, "dev-1");
    assert.equal(r.hostId, E4A_ID);
    assert.equal(r.relayId, ID_A);
    assert.equal(calls.closed, 0, "the caller owns the session");
    const s = readSession(store);
    assert.equal(s.hosts.length, 1);
    assert.equal(s.hosts[0].hostId, E4A_ID, "entry keyed by the PC's E4a id after the fold");
    assert.deepEqual(s.hosts[0].relay, { hostId: ID_A, endpoint: RELAY_1, pubKey: Buffer.from(PUB_A, "base64").toString("base64"), token: "tok-1" });
    assert.equal(s.activeHostId, E4A_ID);
    assert.deepEqual(relayPinFor(ID_A, store), s.hosts[0].relay, "the pin is found by its relay id");
  });

  test("dedupe: a PC paired over LAN first gets the relay pin folded into ITS entry (address, CA pin, label kept), never a second entry", async () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date("2026-11-01T00:00:00Z"), E4A_ID, "ab".repeat(32));
    const { connect } = fakeClient();
    const r = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store, connect });
    assert.equal(r.hostId, E4A_ID);
    const s = readSession(store);
    assert.equal(s.hosts.length, 1, "one entry per PC");
    assert.equal(s.hosts[0].hostId, E4A_ID);
    assert.equal(s.hosts[0].meshnetHost, "100.64.0.7:4180");
    assert.equal(s.hosts[0].caFp, "ab".repeat(32));
    assert.equal(s.hosts[0].relay.hostId, ID_A);
    assert.equal(s.hosts[0].relay.token, "tok-1");
    assert.equal(s.activeHostId, E4A_ID);
    // A second link for the same PC (new code) reuses the same entry: still one.
    const again = fakeClient({ redeem: async () => ({ deviceId: "dev-1", token: "tok-2" }) });
    await connectWithRelayLink(parseRelayPairingLink(mkLink({ code: "654321" })), { store, connect: again.connect });
    assert.equal(again.calls.connect[0].hostPubKey, Buffer.from(PUB_A, "base64").toString("base64"), "stored key used");
    assert.equal(readSession(store).hosts.length, 1);
    assert.equal(readSession(store).hosts[0].relay.token, "tok-2", "fresh token replaces the old one");
    // A code-less link (just the pin) reconnects with the stored token instead of redeeming.
    const back = fakeClient();
    const f = parseRelayPairingLink(mkLink());
    f.code = null;
    const r3 = await connectWithRelayLink(f, { store, connect: back.connect });
    assert.deepEqual(back.calls.redeem, []);
    assert.deepEqual(back.calls.authenticate, ["tok-2"], "the stored token, sent only after the handshake against the stored key");
    assert.equal(r3.deviceId, "dev-1");
    assert.equal(readSession(store).hosts.length, 1);
  });

  test("attacker: the fold trusts only what the pinned, authenticated PC says about itself; a status naming another relay id or key folds nothing", async () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), E4A_ID, "ab".repeat(32));
    const lying = fakeClient({ status: () => ({ hostId: E4A_ID, relay: { hostId: ID_B, pub: PUB_B } }) });
    const r = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store, connect: lying.connect });
    assert.equal(r.hostId, "", "no fold");
    const s = readSession(store);
    assert.equal(s.hosts.length, 2, "the relay pairing is kept as its own entry, the LAN entry is untouched");
    assert.equal(s.hosts.find((h) => h.hostId === E4A_ID).relay, undefined);
    assert.equal(s.hosts.find((h) => h.hostId === ID_A).relay.hostId, ID_A);
    // A LAN entry that already holds a DIFFERENT relay key for that E4a id (rotated host, or not that PC) keeps it: no fold either.
    const store2 = fakeStore();
    saveSession("100.64.0.7:4180", store2, new Date(), E4A_ID, "ab".repeat(32));
    saveRelayPin(ID_B, { endpoint: RELAY_2, pubKey: PUB_B }, store2);
    assert.equal(foldRelayHost(ID_B, E4A_ID, store2), true, "the old relay pin folds in");
    const r2 = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store: store2, connect: fakeClient().connect });
    assert.equal(r2.hostId, E4A_ID, "the id the PC reported is passed on, but");
    const s2 = readSession(store2);
    assert.equal(s2.hosts.length, 2);
    assert.equal(s2.hosts.find((h) => h.hostId === E4A_ID).relay.hostId, ID_B, "the existing pin never moves");
    assert.equal(relayPinFor(ID_A, store2).pubKey, Buffer.from(PUB_A, "base64").toString("base64"));
  });

  test("the repoint confirm (X1 wire L2): no -> session through the stored endpoint, store keeps it; yes -> the new endpoint persists only after the session succeeded through it", async () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY_1, pubKey: PUB_A }, store, new Date(), "Home PC", { token: "tok-1" });
    const f = parseRelayPairingLink(mkLink({ relay: RELAY_2, code: "222222" }));
    const no = fakeClient();
    let r = await connectWithRelayLink(f, { store, connect: no.connect, confirmRepoint: () => false });
    assert.equal(no.calls.connect[0].endpoint, RELAY_1, "declined: the stored relay carries the session");
    assert.equal(r.repointed, false);
    assert.equal(relayPinFor(ID_A, store).endpoint, RELAY_1);
    const yesButDead = fakeClient({ redeem: async () => { throw new transport.RelayAuthError("code rejected"); } });
    const before = snapshot(store);
    await assert.rejects(connectWithRelayLink(f, { store, connect: yesButDead.connect, confirmRepoint: () => true }), transport.RelayAuthError);
    assert.equal(yesButDead.calls.connect[0].endpoint, RELAY_2);
    assert.equal(yesButDead.calls.closed, 1, "socket closed on failure");
    assert.equal(snapshot(store), before, "a failed session through the new relay writes nothing: the old endpoint stays");
    const yes = fakeClient({ redeem: async () => ({ deviceId: "dev-1", token: "tok-3" }) });
    r = await connectWithRelayLink(f, { store, connect: yes.connect, confirmRepoint: () => true });
    assert.equal(r.repointed, true);
    assert.equal(relayPinFor(ID_A, store).endpoint, RELAY_2, "moved after success");
    assert.equal(relayPinFor(ID_A, store).token, "tok-3");
    assert.equal(readSession(store).hosts.length, 1);
  });

  test("E4b pending: the ticket is stored, the session stays unauthenticated, no status call, no fold", async () => {
    const store = fakeStore();
    const c = fakeClient({ redeem: async () => ({ deviceId: "pending-1", token: "ticket-1", pending: true }) });
    const r = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store, connect: c.connect });
    assert.equal(r.pending, true);
    assert.deepEqual(c.calls.fetch, []);
    assert.equal(relayPinFor(ID_A, store).token, "ticket-1");
    assert.equal(readSession(store).hosts[0].hostId, ID_A, "still keyed by the relay id until approved");
    // Reconnecting before approval: authenticate throws RelayPendingError, which the connect path reports as pending.
    const later = fakeClient({ authenticate: async () => { throw new transport.RelayPendingError("pending"); } });
    const f = parseRelayPairingLink(mkLink());
    f.code = null;
    const r2 = await connectWithRelayLink(f, { store, connect: later.connect });
    assert.equal(r2.pending, true);
    assert.match(relayConnectErrorMessage(new transport.RelayPendingError("x")), /approve/i);
  });

  test("a bad link, a missing store or no code + no token: nothing connects or persists", async () => {
    const store = fakeStore();
    const c = fakeClient();
    const f = parseRelayPairingLink(mkLink());
    f.code = null;
    await assert.rejects(connectWithRelayLink(f, { store, connect: c.connect }), /not paired with that PC yet/);
    assert.equal(c.calls.closed, 1);
    assert.equal(snapshot(store), null);
    await assert.rejects(connectWithRelayLink(parseRelayPairingLink(mkLink()), { store: null, connect: c.connect }), /localStorage/);
    assert.equal(snapshot(store), null);
  });

  test("end to end over the fake relay: real handshake pinned to the stored key, redeem inside the channel, status over the channel folds the entry", async () => {
    const relay = makeRelay();
    const http = [];
    const host = tunnel.createRelayHost({
      endpoint: RELAY_1,
      hostId: ID_A,
      hostKey: keyA,
      WebSocketImpl: relay.Sock,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      rand: () => 0.5,
      redeem: async ({ code, label }) => (code === "123456" ? { deviceId: "dev-e2e", token: `tok-e2e-${label}` } : null),
      authenticate: async (t) => (t.startsWith("tok-e2e-") ? { deviceId: "dev-e2e" } : null),
      handleHttp: async (req) => (http.push(req), { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ ok: true, paired: true, hostId: E4A_ID, relay: { hostId: ID_A, pub: PUB_A } })) }),
      openWs: async () => null,
    });
    host.start();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), E4A_ID, "ab".repeat(32));
    const connect = (o) => transport.connectRelay({ ...o, WebSocketImpl: relay.Sock });
    const r = await connectWithRelayLink(parseRelayPairingLink(mkLink()), { store, connect, deviceName: "Pixel" });
    assert.equal(r.deviceId, "dev-e2e");
    assert.equal(r.hostId, E4A_ID);
    assert.equal(http[0].path, "/api/auth/status");
    assert.equal(http[0].deviceId, "dev-e2e", "the status call ran as the paired device");
    const s = readSession(store);
    assert.equal(s.hosts.length, 1);
    assert.equal(s.hosts[0].relay.token, "tok-e2e-Pixel");
    assert.ok(!relay.frames.some((f) => f.raw.includes("123456") || f.raw.includes("tok-e2e")), "the relay saw neither the code nor the token in clear");
    r.client.close();

    // attacker: the same PC id with the attacker's key cannot even be expressed (self-certifying); a store that somehow
    // holds another key for ID_A refuses the handshake against the real host (the stored key is what the client pins).
    const store2 = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY_1, pubKey: PUB_B }, store2);
    await assert.rejects(connectWithRelayLink(parseRelayPairingLink(mkLink()), { store: store2, connect }), RelayPinMismatchError);
    host.stop();
  });
});
