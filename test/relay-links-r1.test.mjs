// E5 §7 item 8 relay links, Tier A review R1 regressions (docs/lanes/android-app/E5_RELAY_LINKS_REVIEW_R1.md Gemini
// 0H/2M/3L; X1_E5_RELAY_LINKS_WALK.md 0H/1M/1L/5I). One describe per finding; attacker cases are marked "attacker:".
// Run: node --test --import ./test/setup/hermetic.mjs test/relay-links-r1.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
const tunnel = await import("../server/relay-tunnel.mjs");
const link = await import("../server/relay-link.mjs");
const { connectWithRelayLink, parseRelayPairingLink } = await import("../src/remoteRelayConnect.ts");
const transport = await import("../src/remoteRelayTransport.ts");
const session = await import("../src/remoteSession.ts");
const { redactHref } = await import("../src/diagOverlay.ts");
const { readSession, relayPinFor, saveSession, setSessionHostId, saveRelayPin, foldRelayHost, forgetHost, activeHost, REMOTE_SESSION_KEY } = session;

const dir = mkdtempSync(join(tmpdir(), "vs-relay-r1-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const keyA = tunnel.loadOrCreateHostKeypair(join(dir, "host-a.json"));
const keyB = tunnel.loadOrCreateHostKeypair(join(dir, "host-b.json")); // attacker: an unrelated host with its own key
const ID_A = tunnel.selfCertifyingHostId(keyA.publicRaw);
const ID_B = tunnel.selfCertifyingHostId(keyB.publicRaw);
const PUB_A = keyA.pubB64;
const PUB_B = keyB.pubB64;
const E4A_1 = "Qm9yZWFsaXNIb3N0SWQxMg"; // PC 1's ~/.vibesquad/host-id
const E4A_2 = "c2Vjb25kLWhvc3QtaWQtMDE"; // PC 2's
const FP_1 = "ab".repeat(32);
const FP_2 = "cd".repeat(32);
const ADDR = "192.168.1.20:4180";
const RELAY = "wss://relay.example/ws";
const src = (f) => readFileSync(join(rootDir, f), "utf8");
const linkFor = (hostId, pub, code = "123456") => parseRelayPairingLink(link.buildRelayPairingLink({ hostId, pub, relay: RELAY, code }));

const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};
const snapshot = (store) => store.getItem(REMOTE_SESSION_KEY);

/** A RelayClient double whose /api/auth/status answer the test controls (what the PC behind the channel claims). */
function fakeClient({ status, redeem, authenticate } = {}) {
  const calls = { connect: [], redeem: [], authenticate: [], closed: 0 };
  const client = {
    kex: "webcrypto",
    async redeem(code, label) {
      calls.redeem.push({ code, label });
      return redeem ? redeem(code, label) : { deviceId: "dev-1", token: "tok-1" };
    },
    async authenticate(t) {
      calls.authenticate.push(t);
      return authenticate ? authenticate(t) : { deviceId: "dev-1" };
    },
    async fetch() {
      return new Response(JSON.stringify(status()), { status: 200, headers: { "content-type": "application/json" } });
    },
    async openWebSocket() {
      throw new Error("n/a");
    },
    close() {
      calls.closed++;
    },
    onclose: null,
  };
  return { client, calls, connect: async (o) => (calls.connect.push(o), client) };
}
const honestA = (fp = FP_1, e4a = E4A_1) => () => ({ ok: true, paired: true, hostId: e4a, caFingerprint: { full: fp, short: fp.slice(0, 8) }, relay: { hostId: ID_A, pub: PUB_A } });
const lyingB = (fp = "", e4a = E4A_1) => () => ({ ok: true, paired: true, hostId: e4a, ...(fp ? { caFingerprint: { full: fp } } : {}), relay: { hostId: ID_B, pub: PUB_B } });

describe("Gemini M1: a LAN re-pair at the same address never inherits another PC's relay pin or token", () => {
  test("attacker/DHCP: PC 2 at PC 1's old address (other id + other CA) gets a clean entry; PC 1's relay pin and token are gone", () => {
    const store = fakeStore();
    saveSession(ADDR, store, new Date("2026-11-01T00:00:00Z"), E4A_1, FP_1);
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "", { token: "tok-A" });
    assert.equal(foldRelayHost(ID_A, E4A_1, store, FP_1), true);
    assert.equal(readSession(store).hosts[0].relay.token, "tok-A");
    saveSession(ADDR, store, new Date("2026-11-11T00:00:00Z"), E4A_2, FP_2);
    const h = readSession(store).hosts;
    assert.equal(h.length, 1);
    assert.equal(h[0].hostId, E4A_2);
    assert.equal(h[0].caFp, FP_2);
    assert.equal(h[0].relay, undefined, "no relay pin carried over");
    assert.ok(!snapshot(store).includes("tok-A"), "PC 1's token left the store");
    assert.equal(relayPinFor(ID_A, store), null);
  });

  test("a different CA fingerprint alone (same id: cloned ~/.vibesquad) also drops the pin; the same PC re-pairing keeps it", () => {
    const store = fakeStore();
    saveSession(ADDR, store, new Date(), E4A_1, FP_1);
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "", { token: "tok-A" });
    foldRelayHost(ID_A, E4A_1, store, FP_1);
    saveSession(ADDR, store, new Date(), E4A_1, FP_1); // same PC, new code
    assert.equal(readSession(store).hosts[0].relay.token, "tok-A", "same PC keeps its pin");
    saveSession(ADDR, store, new Date(), E4A_1, FP_2); // same id, other CA: not that PC
    assert.equal(readSession(store).hosts[0].relay, undefined);
    assert.equal(readSession(store).hosts.length, 1);
  });

  test("setSessionHostId: a new id behind a known address drops the old PC's relay pin", () => {
    const store = fakeStore();
    saveSession(ADDR, store, new Date(), E4A_1, FP_1);
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "", { token: "tok-A" });
    foldRelayHost(ID_A, E4A_1, store, FP_1);
    assert.equal(setSessionHostId(ADDR, E4A_2, store), true);
    assert.equal(readSession(store).hosts[0].hostId, E4A_2);
    assert.equal(readSession(store).hosts[0].relay, undefined);
    // Filling in an id that was still empty (v:2 upgrade) keeps everything.
    const store2 = fakeStore();
    saveSession(ADDR, store2, new Date(), "", FP_1);
    assert.equal(setSessionHostId(ADDR, E4A_1, store2), true);
    assert.equal(readSession(store2).hosts[0].caFp, FP_1);
  });
});

describe("Gemini M2 / X1 M1: the fold needs the E4a identity (id AND CA fingerprint), never the public id alone, in either pairing order", () => {
  test("attacker P1/P1b: host B claiming PC 1's public id over its own channel does not take over PC 1's entry; PC 1's own link folds normally afterwards", async () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), E4A_1, FP_1);
    const b = fakeClient({ status: lyingB() });
    const r = await connectWithRelayLink(linkFor(ID_B, PUB_B), { store, connect: b.connect });
    assert.equal(r.hostId, E4A_1, "reported, but");
    let hosts = readSession(store).hosts;
    assert.equal(hosts.length, 2, "B stays its own entry");
    const pc1 = hosts.find((h) => h.meshnetHost === "100.64.0.7:4180");
    assert.equal(pc1.relay, undefined, "PC 1 did not receive B's pin");
    assert.equal(pc1.caFp, FP_1);
    // B claiming PC 1's id AND a fingerprint that is not PC 1's: still no.
    const b2 = fakeClient({ status: lyingB(FP_2) });
    await connectWithRelayLink(linkFor(ID_B, PUB_B, "222222"), { store, connect: b2.connect });
    assert.equal(readSession(store).hosts.find((h) => h.meshnetHost)?.relay, undefined);
    assert.equal(readSession(store).hosts.length, 2);
    // P1b: PC 1's own link (id + its real fingerprint over its pinned channel) folds into PC 1's entry.
    const a = fakeClient({ status: honestA() });
    await connectWithRelayLink(linkFor(ID_A, PUB_A, "333333"), { store, connect: a.connect });
    hosts = readSession(store).hosts;
    assert.equal(hosts.length, 2, "PC 1 (folded) + B");
    const folded = hosts.find((h) => h.meshnetHost === "100.64.0.7:4180");
    assert.equal(folded.relay.hostId, ID_A);
    assert.equal(folded.relay.token, "tok-1");
    assert.equal(folded.caFp, FP_1);
    assert.equal(readSession(store).activeHostId, E4A_1);
  });

  test("cloned ~/.vibesquad: two LAN PCs with one id and different CA pins; the relay pin folds only into the one whose fingerprint the channel reports", async () => {
    const store = fakeStore();
    saveSession("home.example:4180", store, new Date("2026-11-01T00:00:00Z"), E4A_1, FP_1);
    saveSession("clone.example:4180", store, new Date("2026-11-02T00:00:00Z"), E4A_1, FP_2);
    assert.equal(readSession(store).hosts.length, 2);
    const a = fakeClient({ status: honestA(FP_1) });
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: a.connect });
    const hosts = readSession(store).hosts;
    assert.equal(hosts.length, 2);
    assert.equal(hosts.find((h) => h.meshnetHost === "home.example:4180").relay?.hostId, ID_A);
    assert.equal(hosts.find((h) => h.meshnetHost === "clone.example:4180").relay, undefined);
  });

  test("Relay first, LAN second: the relay-only entry learns id + fingerprint over the channel, and the later LAN pairing folds into it (one entry)", async () => {
    const store = fakeStore();
    const a = fakeClient({ status: honestA() });
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: a.connect });
    let h = readSession(store).hosts;
    assert.equal(h.length, 1);
    assert.equal(h[0].hostId, E4A_1);
    assert.equal(h[0].caFp, FP_1, "fingerprint learned over the authenticated channel");
    assert.equal(h[0].meshnetHost, undefined);
    saveSession("100.64.0.7:4180", store, new Date(), E4A_1, FP_1); // the LAN pairing proves the same identity over TLS
    h = readSession(store).hosts;
    assert.equal(h.length, 1, "folded, not duplicated");
    assert.equal(h[0].meshnetHost, "100.64.0.7:4180");
    assert.equal(h[0].relay.hostId, ID_A);
    assert.equal(h[0].relay.token, "tok-1");
    assert.equal(session.showHostSwitcher(readSession(store)), false);
    // A LAN pairing with the same id but another fingerprint is another PC: two entries, the relay pin stays where it was.
    const store2 = fakeStore();
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store: store2, connect: fakeClient({ status: honestA() }).connect });
    saveSession("100.64.0.7:4180", store2, new Date(), E4A_1, FP_2);
    assert.equal(readSession(store2).hosts.length, 2);
    assert.equal(readSession(store2).hosts.find((x) => x.meshnetHost).relay, undefined);
  });

  test("a PC that reports no CA fingerprint (old server) never folds into a LAN entry; a relay-only entry still learns the id", async () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), E4A_1, FP_1);
    const a = fakeClient({ status: () => ({ hostId: E4A_1, relay: { hostId: ID_A, pub: PUB_A } }) });
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: a.connect });
    const h = readSession(store).hosts;
    assert.equal(h.length, 2);
    assert.equal(h.find((x) => !x.meshnetHost).hostId, E4A_1);
    assert.equal(h.find((x) => x.meshnetHost).relay, undefined);
  });

  test("attacker P4: a LAN host whose reported id equals PC 1's relay id never receives PC 1's pin or token", async () => {
    const store = fakeStore();
    saveSession("100.64.0.9:4180", store, new Date(), ID_A, FP_2); // the LAN host reported ID_A (43 chars, a valid id shape)
    const before = snapshot(store);
    assert.equal(relayPinFor(ID_A, store), null, "no pin is read off a LAN entry by its id");
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "", { token: "tok-A" });
    const h = readSession(store).hosts;
    assert.equal(h.length, 2, "the pin went to its own relay-only entry");
    assert.equal(h.find((x) => x.meshnetHost).relay, undefined);
    assert.ok(before !== snapshot(store));
    const a = fakeClient({ status: honestA(FP_1) });
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: a.connect });
    assert.equal(readSession(store).hosts.find((x) => x.meshnetHost).relay, undefined, "still nothing on the LAN entry");
  });

  test("X1 I4: foldRelayHost on an entry without a pin writes nothing; LAN-proven entries never change identity over the relay", () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), E4A_1, FP_1);
    const before = snapshot(store);
    assert.equal(foldRelayHost(E4A_1, E4A_2, store, FP_2), false);
    assert.equal(snapshot(store), before);
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store);
    assert.equal(foldRelayHost(ID_A, E4A_1, store, FP_1), true);
    assert.equal(foldRelayHost(ID_A, E4A_2, store, FP_2), false, "a folded LAN entry keeps its identity");
    assert.equal(readSession(store).hosts[0].hostId, E4A_1);
  });
});

describe("Gemini L1 / X1 I1: the boot diagnostic never records a relay pairing fragment", () => {
  test("redactHref drops the whole fragment whatever the parameter order, and still redacts query secrets", () => {
    assert.equal(redactHref(`https://app.example/pair#code=123456&hostId=${ID_A}&pub=x&relay=wss`), "https://app.example/pair#…");
    assert.equal(redactHref(`https://app.example/pair?x=1#hostId=${ID_A}&code=123456`), "https://app.example/pair?x=1#…");
    assert.equal(redactHref("https://pc.example:4180/pair?code=123456&fp=abcd&name=Pixel"), "https://pc.example:4180/pair?code=…&fp=…&name=Pixel");
    assert.equal(redactHref("https://pc.example:4180/"), "https://pc.example:4180/");
    assert.match(src("src/diagOverlay.ts"), /diagStep\(`boot \$\{redactHref\(win\.location\.href\)\}`\)/);
    assert.doesNotMatch(src("src/diagOverlay.ts"), /location\.href\.replace/, "no raw href path left");
  });
});

describe("Gemini L2: a relay-only pairing can be forgotten", () => {
  test("forgetHost removes by relay id or host id; the pair screen offers Forget for a relay-only active host", () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "Home PC", { token: "tok-A" });
    saveSession("100.64.0.9:4180", store, new Date(), E4A_2, FP_2);
    assert.equal(readSession(store).hosts.length, 2);
    forgetHost(ID_A, store);
    assert.equal(readSession(store).hosts.length, 1);
    assert.equal(relayPinFor(ID_A, store), null);
    assert.ok(!snapshot(store).includes("tok-A"));
    forgetHost(E4A_2, store);
    assert.equal(readSession(store), null, "the last host gone clears the session");
    // A folded entry goes by any of its names.
    saveSession("100.64.0.7:4180", store, new Date(), E4A_1, FP_1);
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store);
    foldRelayHost(ID_A, E4A_1, store, FP_1);
    forgetHost(ID_A, store);
    assert.equal(readSession(store), null);
    const screen = src("src/RemotePairScreen.tsx");
    assert.match(screen, /data-testid="forget-relay-pc"/);
    assert.match(screen, /forgetHost\(relayOnly\.relay\?\.hostId \|\| relayOnly\.hostId\)/);
    const s2 = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, s2, new Date(), "Home PC");
    assert.equal(activeHost(readSession(s2)).label, "Home PC", "what the button names");
  });
});

describe("Gemini L3 / X1 L1 (P2): a pending device-minted code never replaces a working relay token", () => {
  test("attacker: a link with a pending code on a paired phone keeps GOOD-TOKEN; the ticket waits beside it and only an approved ticket is promoted", async () => {
    const store = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store, new Date(), "Home PC", { token: "GOOD-TOKEN" });
    const minted = fakeClient({ status: honestA(), redeem: async () => ({ deviceId: "pending-1", token: "PENDING-TICKET", pending: true }) });
    const r = await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: minted.connect });
    assert.equal(r.pending, true);
    let pin = relayPinFor(ID_A, store);
    assert.equal(pin.token, "GOOD-TOKEN", "the working token is untouched");
    assert.equal(pin.pendingToken, "PENDING-TICKET");
    // Code-less reconnect: the working token is used first; the ticket is not even tried while it works.
    const back = fakeClient({ status: honestA() });
    const f = linkFor(ID_A, PUB_A);
    f.code = null;
    const r2 = await connectWithRelayLink(f, { store, connect: back.connect });
    assert.equal(r2.pending, false);
    assert.deepEqual(back.calls.authenticate, ["GOOD-TOKEN"]);
    assert.equal(relayPinFor(ID_A, store).pendingToken, "PENDING-TICKET", "still parked");
    // The working token was revoked on the PC meanwhile and the ticket got approved: the ticket becomes the token.
    const revoked = fakeClient({
      status: honestA(),
      authenticate: async (t) => {
        if (t === "GOOD-TOKEN") throw new transport.RelayAuthError("revoked");
        return { deviceId: "dev-2" };
      },
    });
    const r3 = await connectWithRelayLink(f, { store, connect: revoked.connect });
    assert.equal(r3.deviceId, "dev-2");
    assert.deepEqual(revoked.calls.authenticate, ["GOOD-TOKEN", "PENDING-TICKET"]);
    pin = relayPinFor(ID_A, store);
    assert.equal(pin.token, "PENDING-TICKET");
    assert.equal(pin.pendingToken, undefined);
    // A still-pending ticket after a revoked token: no token at all, pending reported, nothing invented.
    const store2 = fakeStore();
    saveRelayPin(ID_A, { endpoint: RELAY, pubKey: PUB_A }, store2, new Date(), "Home PC", { token: "OLD", pendingToken: "WAIT" });
    const both = fakeClient({
      status: honestA(),
      authenticate: async (t) => {
        if (t === "OLD") throw new transport.RelayAuthError("revoked");
        throw new transport.RelayPendingError("pending");
      },
    });
    const r4 = await connectWithRelayLink(f, { store: store2, connect: both.connect });
    assert.equal(r4.pending, true);
    assert.deepEqual(relayPinFor(ID_A, store2), { hostId: ID_A, endpoint: RELAY, pubKey: Buffer.from(PUB_A, "base64").toString("base64"), pendingToken: "WAIT" });
  });

  test("a new host with a pending code stores the ticket as pendingToken only; a plain redeem replaces both", async () => {
    const store = fakeStore();
    const minted = fakeClient({ status: honestA(), redeem: async () => ({ deviceId: "pending-1", token: "TICKET", pending: true }) });
    await connectWithRelayLink(linkFor(ID_A, PUB_A), { store, connect: minted.connect });
    assert.deepEqual(relayPinFor(ID_A, store), { hostId: ID_A, endpoint: RELAY, pubKey: Buffer.from(PUB_A, "base64").toString("base64"), pendingToken: "TICKET" });
    const plain = fakeClient({ status: honestA(), redeem: async () => ({ deviceId: "dev-9", token: "REAL" }) });
    await connectWithRelayLink(linkFor(ID_A, PUB_A, "999999"), { store, connect: plain.connect });
    assert.deepEqual(relayPinFor(ID_A, store), { hostId: ID_A, endpoint: RELAY, pubKey: Buffer.from(PUB_A, "base64").toString("base64"), token: "REAL" });
    assert.equal(readSession(store).hosts.length, 1);
  });
});
