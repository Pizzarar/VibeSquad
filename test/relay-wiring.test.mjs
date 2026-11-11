// E5 wiring (unit-and-end-e5-wire, docs/lanes/android-app/E5_THREAT_MODEL.md §11): the relay core plugged into the
// real auth.mjs + API middleware. A relayed device goes through the same authenticate / owner-proof / agent-header gates
// as a LAN device, is never loopback or the local owner, is cut the moment it is revoked (UI, CLI, out-of-process
// edit, cascade), and the host key can be rotated under a running host. No network: in-memory fake relay.
// Run: node --test --import ./test/setup/hermetic.mjs test/relay-wiring.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-e5-wire-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const wiring = await import("../server/relay-wiring.mjs");
const tunnel = await import("../server/relay-tunnel.mjs");
const settingsMod = await import("../server/user-settings.mjs");
const { guardHandler } = await import("../server/safe-handler.mjs");
const { connectRelay, RelayAuthError, RelayPendingError } = await import("../src/remoteRelayTransport.ts");
const { makeRelay } = await import("./helpers/fake-relay.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const devicesFile = join(home, "devices.json");
const keyFile = join(home, "host-keypair.json");
const VS = join(rootDir, "cli", "vs.mjs");
const quiet = { log() {}, warn() {} };
const needsYou = [];
const middleware = api.createVibesquadMiddleware(rootDir);
// The same listener serve.mjs hands the relay: the full middleware, guarded; anything it does not route is a 404.
const listener = guardHandler((req, res) =>
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end("not found");
  }),
);
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, n = 20000) => {
  for (let i = 0; i < n; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error("timed out waiting");
};

function startWiring(relay, over = {}) {
  const w = wiring.createRelayWiring({
    endpoint: "wss://relay.example/ws",
    requestListener: listener,
    keypairFile: keyFile,
    keyPollMs: 0, // tests call checkKeyFile() themselves
    log: quiet,
    onNeedsYou: (e) => needsYou.push(e),
    hostOptions: { WebSocketImpl: relay.Sock, rand: () => 0.5, ...over },
  });
  w.start();
  return w;
}
const connect = (relay, w, pub = w.pub, hostId = w.hostId) => connectRelay({ endpoint: "wss://relay.example/ws", hostId, hostPubKey: pub, WebSocketImpl: relay.Sock });
const jsonPost = (c, path, body) => c.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const cli = (...args) => spawnSync(process.execPath, [VS, ...args], { env: { ...process.env, VIBESQUAD_HOME: home }, encoding: "utf8" });

describe("E5 wiring: pairing and principal", () => {
  test("a PC-minted code redeemed inside the channel pairs the device; relayed requests run as that device and never as the PC", async () => {
    const relay = makeRelay();
    const w = startWiring(relay);
    api.setRelayStatus(() => w.status());
    await tick();
    assert.equal(w.hostId, tunnel.selfCertifyingHostId(Buffer.from(w.pub, "base64")), "self-certifying host id by default");
    const c = await connect(relay, w);
    const r = await c.redeem(auth.createPairCode(), "Work PC");
    assert.equal(r.pending, undefined);
    const dev = auth.listDevices().find((d) => d.id === r.deviceId);
    assert.equal(dev?.name, "Work PC");
    assert.equal(dev.mintedByDeviceId, null, "PC-minted");
    assert.ok(!readFileSync(devicesFile, "utf8").includes(r.token), "only the hash is on disk");

    const devices = await (await c.fetch("/__vibesquad/devices")).json();
    assert.ok(devices.devices.find((d) => d.id === r.deviceId && d.current === true), "gated read works for the paired relay device and names it as current");
    const st = await (await c.fetch("/api/auth/status")).json();
    assert.equal(st.paired, true);
    assert.equal(st.relay.hostId, w.hostId, "Host pill sees the relay status");
    assert.equal(st.relay.connected, true);
    assert.equal("priv" in st.relay, false);

    // The PC-only routes refuse the relay principal: the local proof is loopback-only (reaches the handler, 403) and the
    // login nonce never reaches the server at all (RELAY_DENIED_PREFIXES, 403 from the tunnel).
    assert.equal((await c.fetch(`/__vibesquad/local-proof?c=${"0".repeat(32)}`)).status, 403);
    assert.equal((await c.fetch("/__vibesquad/local-login/nonce", { method: "POST" })).status, 403);
    assert.equal((await c.fetch("/__vibesquad/local-login?t=abc")).status, 403);

    // Minting over the relay is a DEVICE mint (E4b approval required), not the PC owner's mint.
    const ps = await jsonPost(c, "/__vibesquad/pair/start", {});
    assert.equal(ps.status, 200, await ps.text());
    assert.equal(auth.liveCodeCountForTest(r.deviceId), 1, "code is minted by the relay device");
    assert.equal(auth.liveCodeCountForTest(null), 0, "not a PC code");
    const head = await c.fetch("/api/auth/status");
    assert.equal(head.headers.get("set-cookie"), null, "no cookie ever crosses the relay");
    c.close();
    w.stop();
    api.setRelayStatus(null);
  });

  test("attacker: a relayed request cannot claim loopback or local-owner trust, whatever socket or headers it fakes", async () => {
    const victim = auth.redeemPairCode({ rawCode: auth.createPairCode(), ip: "100.64.0.9", name: "Victim phone" });
    assert.equal(victim.state, "paired");
    const other = auth.redeemPairCode({ rawCode: auth.createPairCode(), ip: "100.64.0.10", name: "Other phone" });
    const fake = (deviceId) => {
      const req = tunnel.createSyntheticRequest({ method: "POST", path: "/__vibesquad/pair/start", headers: { cookie: `vs_device=${victim.token}`, "x-vibesquad-token": auth.getLocalToken(), "user-agent": "node" }, deviceId });
      req.headers.host = "127.0.0.1:4180";
      req.socket.localAddress = "127.0.0.1";
      req.socket.remoteAddress = "127.0.0.1";
      return req;
    };
    const req = fake("not-a-device");
    assert.equal(auth.isLocal(req), false);
    assert.equal(auth.isLocalBrowserSafe(req), false);
    assert.equal(auth.isLocalOwner(req), false);
    assert.equal(auth.hasLocalToken(req), false, "the real local token header is ignored on a relayed request");
    assert.equal(auth.hasLocalTokenHeader(req), false);
    assert.equal(auth.authenticate(req), null, "the victim's cookie is ignored: the channel identity is unknown");
    assert.equal(auth.ownerProof(req), false);
    // With a real channel identity, that identity wins over any cookie the frame smuggled in.
    assert.equal(auth.authenticate(fake(other.deviceId))?.id, other.deviceId);
    // Through the middleware: unpaired (401), never the loopback branch (403 "forbidden") and never a 200.
    const dispatch = tunnel.createInProcessDispatcher(listener);
    const r1 = await dispatch({ method: "GET", path: "/__vibesquad/devices", headers: { cookie: `vs_device=${victim.token}`, "x-vibesquad-token": auth.getLocalToken() }, body: Buffer.alloc(0), deviceId: "not-a-device" });
    assert.equal(r1.status, 401, r1.body.toString());
    assert.match(r1.body.toString(), /unpaired/);
    const r2 = await dispatch({ method: "POST", path: "/__vibesquad/pair/start", headers: { "x-vibesquad-token": auth.getLocalToken() }, body: Buffer.alloc(0), deviceId: other.deviceId });
    assert.equal(r2.status, 200, r2.body.toString());
    assert.equal(auth.liveCodeCountForTest(other.deviceId), 1, "a device mint, approval required, despite the local token header");
    assert.equal(auth.liveCodeCountForTest(null), 0);
    auth.revokeDevice(victim.deviceId);
    auth.revokeDevice(other.deviceId);
  });
});

describe("E5 wiring: revocation", () => {
  test("a revoked device is cut over the relay: UI/CLI revoke closes its sessions at once, an out-of-process edit cuts it on the next request, cascade follows mintedByDeviceId", async () => {
    const relay = makeRelay();
    const w = startWiring(relay);
    await tick();
    const a = await connect(relay, w);
    const ra = await a.redeem(auth.createPairCode(), "Phone A");
    // A mints for B and C over the relay (device-minted: pending until A approves, also over the relay).
    const approveOn = async (minter, name) => {
      const mint = await (await jsonPost(minter, "/__vibesquad/pair/start", {})).json();
      const c = await connect(relay, w);
      const rc = await c.redeem(mint.code, name);
      assert.equal(rc.pending, true, "device-minted code waits for approval");
      await assert.rejects(c.authenticate(rc.token), RelayPendingError);
      assert.equal(auth.listDevices().some((d) => d.name === name), false, "nothing on disk while pending");
      const pend = await (await minter.fetch("/__vibesquad/pair/pending")).json();
      const ticket = pend.pending.find((x) => x.name === name);
      assert.ok(ticket, "the minter sees the ticket over the relay");
      assert.equal((await jsonPost(minter, "/__vibesquad/pair/approve", { pendingId: ticket.pendingId, approve: true })).status, 200);
      const auth2 = await c.authenticate(rc.token);
      assert.equal((await c.fetch("/api/auth/status")).status, 200);
      const dev = auth.listDevices().find((d) => d.id === auth2.deviceId);
      assert.equal(dev.mintedByDeviceId, ra.deviceId);
      return { client: c, token: rc.token, deviceId: auth2.deviceId };
    };
    const b = await approveOn(a, "Work PC B");
    const cc = await approveOn(a, "Tablet C");
    assert.equal(w.status().sessions, 3);

    // Out-of-process revoke of B (`vs devices revoke` in another process): the cheap stamp check sees the edit on the
    // next relayed request, the device is dropped and its session closed before any handler runs.
    const list = JSON.parse(readFileSync(devicesFile, "utf8"));
    list.devices = list.devices.filter((d) => d.id !== b.deviceId);
    writeFileSync(devicesFile, JSON.stringify(list, null, 2));
    let bClosed = null;
    b.client.onclose = (e) => (bClosed = e);
    await assert.rejects(b.client.fetch("/api/auth/status"));
    assert.ok(bClosed, "B's session is gone");
    assert.equal(w.status().sessions, 2);

    // UI/CLI revoke of A cascades to C (mintedByDeviceId) and closes both sessions with no request in flight.
    let aClosed = null;
    let cClosed = null;
    a.onclose = (e) => (aClosed = e);
    cc.client.onclose = (e) => (cClosed = e);
    const removed = auth.revokeDevice(ra.deviceId);
    assert.deepEqual(new Set(removed), new Set([ra.deviceId, cc.deviceId]));
    await until(() => aClosed && cClosed);
    assert.equal(w.status().sessions, 0);
    // Neither token works again, on a fresh session.
    const again = await connect(relay, w);
    await assert.rejects(again.authenticate(ra.token), /token rejected/);
    await assert.rejects(again.authenticate(cc.token), /token rejected/);
    await assert.rejects(again.authenticate(b.token), /token rejected/);
    again.close();
    w.stop();
  });

  test("an unreadable devices.json fails closed for relay sessions too", async () => {
    const relay = makeRelay();
    const w = startWiring(relay);
    await tick();
    const c = await connect(relay, w);
    await c.redeem(auth.createPairCode(), "Phone");
    assert.equal((await c.fetch("/api/auth/status")).status, 200);
    const good = readFileSync(devicesFile, "utf8");
    writeFileSync(devicesFile, "{ not json");
    await assert.rejects(c.fetch("/api/auth/status"), "revoked-on-dispatch: unreadable list means inactive");
    writeFileSync(devicesFile, good);
    assert.ok(auth.listDevices().length >= 1, "the list is back once readable");
    auth.revokeAllDevices();
    w.stop();
  });
});

describe("E5 wiring: host key rotation", () => {
  test("vs host-key rotate: the running host drops every session and re-dials under the new id; old pins fail; devices are revoked unless --keep-devices", async () => {
    const relay = makeRelay();
    const w = startWiring(relay);
    await tick();
    const oldId = w.hostId;
    const oldPub = w.pub;
    const c = await connect(relay, w);
    await c.redeem(auth.createPairCode(), "Phone");
    let closed = null;
    c.onclose = (e) => (closed = e);
    const r1 = cli("host-key", "rotate", "--keep-devices");
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /Host key rotated/);
    assert.match(r1.stdout, /kept/);
    assert.ok(!r1.stdout.includes('"priv"') && !/priv/i.test(r1.stdout), "never the private half");
    assert.equal(auth.listDevices().length, 1, "--keep-devices kept the pairing");
    assert.equal(w.checkKeyFile(), true, "the poll notices the new file");
    await until(() => closed !== null);
    assert.notEqual(w.hostId, oldId);
    assert.notEqual(w.pub, oldPub);
    await until(() => relay.hostConnects === 2);
    await assert.rejects(connect(relay, w, oldPub, oldId), RelayAuthError, "a client pinned to the old key fails its handshake");
    const c2 = await connect(relay, w);
    const r = await c2.redeem(auth.createPairCode(), "Phone 2");
    assert.ok(r.deviceId);
    assert.equal((await c2.fetch("/api/auth/status")).status, 200);
    let closed2 = null;
    c2.onclose = (e) => (closed2 = e);

    const r2 = cli("host-key", "rotate");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /Revoked 2 paired devices/);
    assert.equal(auth.listDevices().length, 0, "every device must pair again");
    await until(() => closed2 !== null); // the reload after the CLI's write dropped the device, which closed its session
    assert.equal(w.checkKeyFile(), true);
    const r3 = cli("host-key", "show", "--json");
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(JSON.parse(r3.stdout).hostId, w.hostId);
    assert.equal(w.checkKeyFile(), false, "unchanged file: no restart");
    w.stop();
  });
});

describe("E5 wiring: opt-in and the T8 lock", () => {
  test("off by default: no relay.endpoint, or a non-wss one, starts nothing; only a hand-edited wss endpoint does; HTTP settings patches never add one", () => {
    assert.equal(wiring.startRelayFromSettings({ requestListener: listener, settings: {} }), null);
    assert.equal(wiring.startRelayFromSettings({ requestListener: listener, settings: { relay: { endpoint: "ws://relay.example/ws" } } }), null);
    assert.equal(wiring.startRelayFromSettings({ requestListener: listener, settings: { relay: { endpoint: "https://relay.example" } } }), null);
    const file = join(home, "settings.json");
    writeFileSync(file, JSON.stringify({ userName: "me", relay: { endpoint: "wss://relay.example/ws" } }));
    assert.deepEqual(settingsMod.loadUserSettings().relay, { endpoint: "wss://relay.example/ws" });
    settingsMod.saveUserSettings({ userName: "me2", relay: { endpoint: "wss://evil.example" } });
    assert.deepEqual(settingsMod.loadUserSettings().relay, { endpoint: "wss://relay.example/ws" }, "a patch never changes the relay");
    rmSync(file);
    settingsMod.saveUserSettings({ relay: { endpoint: "wss://evil.example" } });
    assert.equal(settingsMod.loadUserSettings().relay, undefined, "a patch never adds one");
    const relay = makeRelay();
    const w = wiring.startRelayFromSettings({ requestListener: listener, settings: { relay: { endpoint: "wss://relay.example/ws" } }, keypairFile: keyFile, keyPollMs: 0, log: quiet, hostOptions: { WebSocketImpl: relay.Sock } });
    assert.ok(w);
    assert.equal(w.status().running, true);
    assert.equal(w.status().endpoint, "wss://relay.example/ws");
    w.stop();
    assert.throws(() => wiring.createRelayWiring({ endpoint: "wss://relay.example", requestListener: null }), /request listener/);
  });

  test("T8: the host-wide redeem limit burns every pairing code and raises needs-you; the next mint lifts the lock", async () => {
    const relay = makeRelay();
    const w = startWiring(relay, { redeemFailLimit: 3 });
    await tick();
    auth.createPairCode();
    assert.equal(auth.liveCodeCountForTest(null), 1);
    const c = await connect(relay, w);
    for (let i = 0; i < 3; i++) await assert.rejects(c.redeem("000000"), /code rejected|locked/);
    assert.equal(w.status().redeemLocked, true);
    assert.equal(auth.liveCodeCountForTest(null), 0, "every live code was burned");
    assert.ok(needsYou.some((e) => e.type === "relay-redeem-flood"), "owner is told");
    await assert.rejects(c.redeem("000001"), /locked/);
    auth.createPairCode();
    assert.equal(w.status().redeemLocked, false, "a fresh mint lifts the lock");
    c.close();
    w.stop();
  });
});

// ---- X1 wire walk fix round (X1_E5_WIRE_WALK.md M1 / L1) ----
describe("X1 wire M1: out-of-process revoke and the unreadable-file fail-close reach relay sessions with no request in flight", () => {
  /** The real middleware plus one long-lived SSE route (what the runner / terminal streams are), authenticated the same way. */
  const streamListener = guardHandler((req, res) => {
    if (!String(req.url).startsWith("/api/stream")) return listener(req, res);
    if (!auth.authenticate(req)) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const t = setInterval(() => res.write(`data: ${++n}\n\n`), 20);
    res.on("close", () => clearInterval(t));
  });
  const startStreamWiring = (relay) =>
    wiring.createRelayWiring({ endpoint: "wss://relay.example/ws", requestListener: streamListener, keypairFile: keyFile, keyPollMs: 0, log: quiet, onNeedsYou: () => {}, hostOptions: { WebSocketImpl: relay.Sock, rand: () => 0.5 } }).start();
  /** Real-time wait (the devices.json watch is a real 1 s interval). Resolves with the elapsed ms. */
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
    return Date.now() - t0;
  };
  const openStream = async (c) => {
    const ws = await c.openWebSocket("/api/stream");
    const st = { events: 0, closed: null };
    ws.onmessage = () => st.events++;
    ws.onclose = (ev) => (st.closed = ev.code);
    await waitFor(() => st.events >= 2);
    return st;
  };

  test("an authenticated relay session is registered like a LAN socket; it is released when the session ends normally", async () => {
    const relay = makeRelay();
    const w = startStreamWiring(relay);
    await tick();
    const c = await connect(relay, w);
    const { deviceId } = await c.redeem(auth.createPairCode(), "Phone");
    assert.equal(auth.hasDeviceSockets(deviceId), true, "tracked on authentication, before any request");
    c.close();
    await waitFor(() => !auth.hasDeviceSockets(deviceId));
    assert.equal(w.status().sessions, 0);
    auth.revokeDevice(deviceId);
    w.stop();
  });

  test("attacker: stolen phone, `vs devices revoke` in another process; its open stream and idle session are cut by the watch within ~1.5 s, no request needed", async () => {
    const relay = makeRelay();
    const w = startStreamWiring(relay);
    await tick();
    const a = await connect(relay, w);
    const ra = await a.redeem(auth.createPairCode(), "Stolen phone");
    const idle = await connect(relay, w);
    await idle.authenticate(ra.token);
    let idleClosed = null;
    idle.onclose = (e) => (idleClosed = e);
    const st = await openStream(a);
    assert.equal(w.status().sessions, 2);
    // Out of process: rewrite devices.json without the device, no request from anyone afterwards.
    const list = JSON.parse(readFileSync(devicesFile, "utf8"));
    list.devices = list.devices.filter((d) => d.id !== ra.deviceId);
    writeFileSync(devicesFile, JSON.stringify(list, null, 2));
    const ms = await waitFor(() => st.closed !== null && idleClosed !== null);
    assert.ok(ms < 2500, `cut within ${ms} ms`);
    const after = st.events;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(st.events, after, "no event flows after the cut");
    assert.equal(w.status().sessions, 0);
    assert.equal(auth.hasDeviceSockets(ra.deviceId), false);
    const again = await connect(relay, w);
    await assert.rejects(again.authenticate(ra.token), /token rejected/);
    again.close();
    w.stop();
  });

  test("an unreadable devices.json fails closed for an open relay stream with no request in flight (E4a R2 L2 parity)", async () => {
    const relay = makeRelay();
    const w = startStreamWiring(relay);
    await tick();
    const c = await connect(relay, w);
    const { deviceId } = await c.redeem(auth.createPairCode(), "Phone");
    const st = await openStream(c);
    const good = readFileSync(devicesFile, "utf8");
    writeFileSync(devicesFile, "{ not json");
    const ms = await waitFor(() => st.closed !== null);
    assert.ok(ms < 2500, `cut within ${ms} ms`);
    assert.equal(w.status().sessions, 0);
    writeFileSync(devicesFile, good);
    assert.ok(auth.listDevices().some((d) => d.id === deviceId), "the device is back once the file is readable; it just re-authenticates");
    auth.revokeDevice(deviceId);
    w.stop();
  });
});

describe("X1 wire L1: the relay endpoint is never shown or logged with userinfo, query or fragment", () => {
  test("status() and the wiring's endpoint carry origin + path only; the host still dials the configured URL", async () => {
    assert.equal(wiring.publicRelayEndpoint("wss://user:s3cret@relay.example:8443/ws?token=RELAYSECRET#frag"), "wss://relay.example:8443/ws");
    assert.equal(wiring.publicRelayEndpoint("wss://relay.example"), "wss://relay.example/");
    const relay = makeRelay();
    const dialed = [];
    class Spy extends relay.Sock {
      constructor(url) {
        super(url);
        dialed.push(url);
      }
    }
    const w = wiring.createRelayWiring({ endpoint: "wss://user:s3cret@relay.example/ws?token=RELAYSECRET#frag", requestListener: listener, keypairFile: keyFile, keyPollMs: 0, log: quiet, onNeedsYou: () => {}, hostOptions: { WebSocketImpl: Spy, rand: () => 0.5 } }).start();
    api.setRelayStatus(() => w.status());
    await tick();
    assert.equal(w.endpoint, "wss://relay.example/ws");
    assert.equal(w.status().endpoint, "wss://relay.example/ws");
    assert.ok(!/s3cret|RELAYSECRET|frag/.test(JSON.stringify(w.status())), "nothing secret in status()");
    assert.match(dialed[0], /^wss:\/\/user:s3cret@relay\.example\/ws\?token=RELAYSECRET&hostId=/, "the dial URL keeps what the relay may need");
    const c = await connectRelay({ endpoint: "wss://relay.example/ws", hostId: w.hostId, hostPubKey: w.pub, WebSocketImpl: relay.Sock });
    const { deviceId } = await c.redeem(auth.createPairCode(), "Phone");
    const body = await (await c.fetch("/api/auth/status")).text();
    assert.ok(!/s3cret|RELAYSECRET/.test(body), "nothing secret on /api/auth/status");
    assert.equal(JSON.parse(body).relay.endpoint, "wss://relay.example/ws");
    c.close();
    auth.revokeDevice(deviceId);
    api.setRelayStatus(null);
    w.stop();
  });
});
