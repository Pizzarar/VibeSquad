// E5 §7 item 8 (docs/lanes/android-app/E5_THREAT_MODEL.md, unit-and-e5-relay-links): the relay pairing link the
// Pair a device dialog hands out. Builder (server/relay-link.mjs), the pair/start offer (auth.mjs relayPairingFor, only
// while the relay wiring reports running on wss://), and the PairDeviceModal card that renders it.
// Run: node --test --import ./test/setup/hermetic.mjs test/relay-pair-link.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-relay-link-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const link = await import("../server/relay-link.mjs");
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const src = (f) => readFileSync(join(rootDir, f), "utf8");
const PUB_RAW = Buffer.alloc(32, 0x41);
const PUB_B64 = PUB_RAW.toString("base64"); // QUFB…QQ==
const PUB_URL = PUB_RAW.toString("base64url");
const HOST_ID = "c29tZS1yZWxheS1ob3N0LWlkLTEyMzQ1Ng"; // 34 url-safe chars (self-certifying ids are 43)

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    end(b) {
      this.body += b ?? "";
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}
/** The desktop app / CLI minting on loopback with the local token: the PC owner. */
const localReq = ({ url = "/__vibesquad/pair/start", method = "POST" } = {}) => ({
  url,
  method,
  headers: { host: "127.0.0.1:4180", "x-vibesquad-token": auth.getLocalToken() },
  socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 },
  on() {},
});

describe("buildRelayPairingLink: everything in the fragment, relay endpoint public form only", () => {
  test("builds vibesquad://pair#hostId=&pub=&relay=&code= with a base64url key and no userinfo / query / fragment in relay=", () => {
    const l = link.buildRelayPairingLink({ hostId: HOST_ID, pub: PUB_B64, relay: "wss://user:s3cret@relay.example:8443/ws?token=RELAYSECRET#frag", code: "123456" });
    assert.equal(l, `vibesquad://pair#hostId=${HOST_ID}&pub=${PUB_URL}&relay=${encodeURIComponent("wss://relay.example:8443/ws")}&code=123456`);
    assert.ok(!l.includes("s3cret") && !l.includes("RELAYSECRET") && !l.includes("frag"), "dial-URL secrets never ride along");
    assert.equal(l.indexOf("#"), "vibesquad://pair".length, "one fragment, nothing before it but the base");
    assert.equal(link.buildRelayPairingLink({ base: "https://app.example/pair", hostId: HOST_ID, pub: PUB_URL, relay: "wss://relay.example/ws", code: "000000" }), `https://app.example/pair#hostId=${HOST_ID}&pub=${PUB_URL}&relay=${encodeURIComponent("wss://relay.example/ws")}&code=000000`);
    assert.equal(link.publicRelayEndpoint("wss://u:p@relay.example/ws?x=1#f"), "wss://relay.example/ws");
    assert.equal(link.relayPubForLink(PUB_B64), PUB_URL);
    assert.equal(link.relayPubForLink(PUB_URL), PUB_URL);
  });

  test("refuses anything unusable: ws:// relay, bad id, wrong key length, non 6-digit code, a base that already has a fragment", () => {
    const ok = { hostId: HOST_ID, pub: PUB_B64, relay: "wss://relay.example/ws", code: "123456" };
    assert.ok(link.buildRelayPairingLink(ok));
    assert.equal(link.buildRelayPairingLink({ ...ok, relay: "ws://relay.example/ws" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, relay: "https://relay.example/ws" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, relay: "" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, hostId: "short" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, hostId: `${HOST_ID}/..` }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, pub: Buffer.alloc(31, 1).toString("base64") }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, pub: "not base64!!" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, code: "12345" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, code: "123-456" }), null);
    assert.equal(link.buildRelayPairingLink({ ...ok, base: "vibesquad://pair#x" }), null);
  });
});

describe("relayPairingFor / pair/start: a relay offer only while the wiring reports running on wss://", () => {
  after(() => auth.setRelayStatusProvider(null));

  test("no provider, not running, non-wss endpoint, or a throwing provider: no offer", () => {
    auth.setRelayStatusProvider(null);
    assert.equal(auth.relayPairingFor("123456"), null);
    auth.setRelayStatusProvider(() => ({ endpoint: "wss://relay.example/ws", hostId: HOST_ID, pub: PUB_B64, running: false, connected: false }));
    assert.equal(auth.relayPairingFor("123456"), null, "configured but stopped");
    auth.setRelayStatusProvider(() => ({ endpoint: "ws://relay.example/ws", hostId: HOST_ID, pub: PUB_B64, running: true, connected: true }));
    assert.equal(auth.relayPairingFor("123456"), null, "never a clear-text relay");
    auth.setRelayStatusProvider(() => {
      throw new Error("boom");
    });
    assert.equal(auth.relayPairingFor("123456"), null);
    auth.setRelayStatusProvider(() => ({ endpoint: "wss://relay.example/ws", hostId: HOST_ID, pub: "bad", running: true, connected: true }));
    assert.equal(auth.relayPairingFor("123456"), null, "unusable key: no link rather than a broken one");
  });

  test("running on wss://: the offer carries the public endpoint, relay id, connected flag and the link; never the dial URL's secrets", () => {
    auth.setRelayStatusProvider(() => ({ endpoint: "wss://u:s3cret@relay.example/ws?token=RELAYSECRET", hostId: HOST_ID, pub: PUB_B64, fingerprint: "ab:cd", running: true, connected: false, sessions: 0 }));
    const o = auth.relayPairingFor("654321");
    assert.deepEqual(o, { endpoint: "wss://relay.example/ws", hostId: HOST_ID, connected: false, link: `vibesquad://pair#hostId=${HOST_ID}&pub=${PUB_URL}&relay=${encodeURIComponent("wss://relay.example/ws")}&code=654321` });
    assert.ok(!JSON.stringify(o).includes("s3cret") && !JSON.stringify(o).includes("RELAYSECRET"));
  });

  test("POST /__vibesquad/pair/start as the PC owner: relay null by default; with a running relay the minted code's link + QR are in the response", async () => {
    auth.setRelayStatusProvider(null);
    let res = fakeRes();
    await auth.handlePairStart(localReq(), res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().relay, null, "relay off by default: no offer");

    // The same registration serve.mjs uses for the Host pill (vibesquad-api setRelayStatus) feeds pair/start.
    api.setRelayStatus(() => ({ endpoint: "wss://relay.example/ws", hostId: HOST_ID, pub: PUB_B64, running: true, connected: true }));
    res = fakeRes();
    await auth.handlePairStart(localReq(), res);
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json();
    assert.equal(data.relay.hostId, HOST_ID);
    assert.equal(data.relay.endpoint, "wss://relay.example/ws");
    assert.equal(data.relay.connected, true);
    assert.equal(data.relay.link, `vibesquad://pair#hostId=${HOST_ID}&pub=${PUB_URL}&relay=${encodeURIComponent("wss://relay.example/ws")}&code=${data.code}`, "the link carries the code pair/start minted");
    assert.match(data.relay.qrSvg, /^<svg/);
    assert.equal("priv" in data.relay, false);
    api.setRelayStatus(null);
    res = fakeRes();
    await auth.handlePairStart(localReq(), res);
    assert.equal(res.json().relay, null, "unregistering turns the offer off again");
  });

  test("nothing over HTTP can set relay settings or the status provider", () => {
    const apiSrc = src("server/vibesquad-api.mjs");
    assert.equal((apiSrc.match(/setRelayStatusProvider\(/g) ?? []).length, 1, "called once, from setRelayStatus (serve.mjs), never from a route");
    assert.match(src("server/user-settings.mjs"), /relay/, "relay settings live in user-settings.mjs");
    assert.ok(!/^import /m.test(src("server/relay-link.mjs")), "the link module is pure: no imports, no I/O");
  });
});

describe("PairDeviceModal: the relay card renders only with a relay offer, every class has a CSS rule", () => {
  const modalSrc = src("src/PairDeviceModal.tsx");
  const dir = mkdtempSync(join(tmpdir(), "vs-relay-link-modal-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const reactUrl = import.meta.resolve("react");
  writeFileSync(join(dir, "TeamActions.mjs"), `import React from ${JSON.stringify(reactUrl)};\nexport function Modal({ title, children, footer }) { return React.createElement("div", { "data-title": title }, children, footer); }\n`);
  writeFileSync(join(dir, "ui.mjs"), `import React from ${JSON.stringify(reactUrl)};\nexport function Ago({ iso }) { return React.createElement("span", null, iso); }\n`);
  const transpiled = transformSync("PairDeviceModal.tsx", modalSrc, { lang: "tsx", jsx: { runtime: "classic" } })
    .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
    .replace('"react"', JSON.stringify(reactUrl))
    .replace('"./TeamActions"', '"./TeamActions.mjs"')
    .replace('"./ui"', '"./ui.mjs"');
  writeFileSync(join(dir, "PairDeviceModal.mjs"), transpiled);
  const basePair = {
    code: "123456",
    pairUrl: "https://100.64.0.7:4180/pair?code=123456",
    pairIpUrl: "https://100.64.0.7:4180/pair?code=123456",
    caHttpUrl: "http://100.64.0.7:4180/ca.crt",
    caFingerprint: { full: "AB".repeat(32), short: "AB:CD" },
    meshnetHost: "",
    meshnetIp: "100.64.0.7",
    expiresAt: Date.now() + 300_000,
    qrSvg: "<svg/>",
    qrSvgIp: "<svg/>",
  };
  const render = async (relay) => {
    const { PairDeviceModal } = await import(pathToFileURL(join(dir, "PairDeviceModal.mjs")).href);
    return renderToStaticMarkup(React.createElement(PairDeviceModal, { onClose() {}, initialPair: { ...basePair, relay } }));
  };

  test("with an offer: card, state, endpoint, link text and QR; without: none of it", async () => {
    const RELAY_LINK = `vibesquad://pair#hostId=${HOST_ID}&pub=${PUB_URL}&relay=wss%3A%2F%2Frelay.example%2Fws&code=123456`;
    const html = await render({ endpoint: "wss://relay.example/ws", hostId: HOST_ID, connected: true, link: RELAY_LINK, qrSvg: '<svg data-relay-qr="1"></svg>' });
    assert.match(html, /data-testid="relay-pair-card"/);
    assert.match(html, /relay connected/);
    assert.match(html, /via wss:\/\/relay\.example\/ws/);
    assert.ok(html.includes("data-relay-qr"), "relay QR rendered");
    assert.ok(html.includes(RELAY_LINK.replace(/&/g, "&amp;")), "the link text is shown for copying");
    const off = await render({ endpoint: "wss://relay.example/ws", hostId: HOST_ID, connected: false, link: RELAY_LINK, qrSvg: "<svg/>" });
    assert.match(off, /relay not connected yet/);
    const none = await render(null);
    assert.doesNotMatch(none, /relay-pair-card|Copy Relay Link/);
    const missing = await render(undefined);
    assert.doesNotMatch(missing, /relay-pair-card/);
  });

  test("every new className in the modal card and the phone relay confirm has a CSS rule; no owner name in the code", () => {
    const css = src("src/styles.css");
    const screen = src("src/RemotePairScreen.tsx");
    const classes = new Set();
    for (const s of [modalSrc, screen]) for (const m of s.matchAll(/\b(pair-relay-[a-z-]+|remote-pair-relay(?:-[a-z]+)*)\b/g)) classes.add(m[1]);
    assert.ok(classes.size >= 8, `found relay classes: ${[...classes].join(" ")}`);
    for (const c of classes) assert.ok(new RegExp(`\\.${c}[\\s{.,:]`).test(css), `CSS rule for .${c}`);
    assert.ok(/\.pair-relay-state\.off/.test(css));
    for (const f of ["src/PairDeviceModal.tsx", "src/RemotePairScreen.tsx", "src/remoteRelayConnect.ts", "server/relay-link.mjs", "test/relay-pair-link.test.mjs", "test/relay-connect.test.mjs"]) {
      assert.doesNotMatch(src(f), new RegExp("\\b" + ["A", "ub"].join("") + "\\b", "i"), `${f} names no owner`); // assembled so this file never matches itself
    }
  });
});
