// Block A1 (PLAN_ANDROID_MESHNET.md): the APK pairs over the VS-native LAN/Meshnet path (QR + 6-digit code).
// - Pure logic: parsePairInput / toAndroidDeepLink / pairRedeemUrl / session storage (src/remoteSession.ts)
// - UI wiring: src/RemotePairScreen.tsx via src/main.tsx; the relay `#offer=` paths are gone (f9b4095)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  activeHost,
  activeMeshnetHost,
  clearSession,
  fetchHostId,
  foldRelayHost,
  forgetHost,
  isAndroidUserAgent,
  mapRemoteError,
  migrateSession,
  needsPairing,
  normalizeHost,
  normalizeHostId,
  pairRedeemUrl,
  parsePairInput,
  readSession,
  REMOTE_SESSION_KEY,
  RelayPinMismatchError,
  relayPinFor,
  sameRelayKey,
  saveRelayPin,
  samePc,
  saveSession,
  setSessionHostId,
  showHostSwitcher,
  toAndroidDeepLink,
} from "../src/remoteSession.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

describe("parsePairInput", () => {
  test("reads the desktop QR / Copy Pairing Link (LAN, Meshnet host and Meshnet IP)", () => {
    assert.deepEqual(parsePairInput("https://192.168.1.20:4180/pair?code=123456"), { host: "192.168.1.20:4180", code: "123456", fp: "" });
    assert.deepEqual(parsePairInput("https://pc-name.example:4180/pair?code=654321"), { host: "pc-name.example:4180", code: "654321", fp: "" });
    assert.deepEqual(parsePairInput("  https://100.64.0.7:4180/pair?code=000111  "), { host: "100.64.0.7:4180", code: "000111", fp: "" });
  });

  test("reads the vibesquad://pair deep link", () => {
    assert.deepEqual(parsePairInput("vibesquad://pair?host=192.168.1.20%3A4180&code=123456"), { host: "192.168.1.20:4180", code: "123456", fp: "" });
    assert.deepEqual(parsePairInput("vibesquad://pair?host=pc.example"), { host: "pc.example:4180", code: "", fp: "" });
  });

  test("accepts a typed host (default port 4180) and a bare or dashed 6-digit code", () => {
    assert.deepEqual(parsePairInput("192.168.1.20"), { host: "192.168.1.20:4180", code: "", fp: "" });
    assert.deepEqual(parsePairInput("pc.example:4443"), { host: "pc.example:4443", code: "", fp: "" });
    assert.deepEqual(parsePairInput("123456"), { host: "", code: "123456", fp: "" });
    assert.deepEqual(parsePairInput("123-456"), { host: "", code: "123456", fp: "" });
  });

  test("rejects junk, loopback targets and the old relay #offer= links", () => {
    for (const bad of ["", "   ", "hello world", "12345", "https://127.0.0.1:4180/pair?code=123456", "localhost", "ftp://x/y",
      "vibesquad://pair#offer=abc", "vibesquad://pair", "host:99999"]) {
      assert.equal(parsePairInput(bad), null, `parsePairInput(${JSON.stringify(bad)})`);
    }
  });

  test("a link without a usable code still yields the host", () => {
    assert.deepEqual(parsePairInput("https://pc.example:4180/pair?code=nope"), { host: "pc.example:4180", code: "", fp: "" });
  });
});

describe("toAndroidDeepLink / pairRedeemUrl", () => {
  test("the deep link carries the same host and code as the QR and round-trips", () => {
    const qr = "https://192.168.1.20:4180/pair?code=123456";
    const dl = toAndroidDeepLink(qr);
    assert.equal(dl, "vibesquad://pair?host=192.168.1.20%3A4180&code=123456");
    assert.deepEqual(parsePairInput(dl), parsePairInput(qr));
    assert.equal(toAndroidDeepLink("123456"), null);
    assert.equal(toAndroidDeepLink("pc.example"), "vibesquad://pair?host=pc.example%3A4180");
  });

  test("redeem URL is the https /pair?code= the paired-PC browser hits", () => {
    const u = new URL(pairRedeemUrl("192.168.1.20:4180", "123456", "My Phone"));
    assert.equal(u.origin, "https://192.168.1.20:4180");
    assert.equal(u.pathname, "/pair");
    assert.equal(u.searchParams.get("code"), "123456");
    assert.equal(u.searchParams.get("name"), "My Phone");
  });

  test("normalizeHost defaults the port and refuses loopback / bad ports", () => {
    assert.equal(normalizeHost("https://pc.example/pair"), "pc.example:4180");
    assert.equal(normalizeHost("[fd00::1]:4180"), "[fd00::1]:4180");
    assert.equal(normalizeHost("localhost:4180"), null);
    assert.equal(normalizeHost("pc:0"), null);
  });
});

const HOST_ID = "Qm9yZWFsaXNIb3N0SWQxMg"; // 22 url-safe chars, what ~/.vibesquad/host-id looks like
const HOST_ID_2 = "c2Vjb25kLWhvc3QtaWQtMDE";

describe("stored pairing session (v:3, E4a)", () => {
  test("save / read / clear and needsPairing", () => {
    const s = fakeStore();
    assert.equal(readSession(s), null);
    assert.equal(needsPairing(true, s), true);
    assert.equal(needsPairing(false, s), false);
    saveSession("pc.example", s, new Date("2026-11-07T00:00:00Z"));
    assert.deepEqual(readSession(s), {
      v: 3,
      activeHostId: "",
      hosts: [{ hostId: "", label: "pc.example:4180", meshnetHost: "pc.example:4180", savedAt: "2026-11-07T00:00:00.000Z" }],
    });
    assert.equal(JSON.parse(s.getItem("vs.remote.session")).v, 3, "written as v:3");
    assert.equal(activeMeshnetHost(readSession(s)), "pc.example:4180");
    assert.equal(needsPairing(true, s), false);
    clearSession(s);
    assert.equal(needsPairing(true, s), true);
  });

  test("a v:2 session upgrades losslessly on read (same host string, so the CA pin and serverUrl still apply)", () => {
    const s = fakeStore({ "vs.remote.session": JSON.stringify({ v: 2, host: "pc.example:4180", savedAt: "2026-11-07T00:00:00.000Z" }) });
    const up = readSession(s);
    assert.deepEqual(up, {
      v: 3,
      activeHostId: "",
      hosts: [{ hostId: "", label: "pc.example:4180", meshnetHost: "pc.example:4180", savedAt: "2026-11-07T00:00:00.000Z" }],
    });
    assert.equal(activeMeshnetHost(up), "pc.example:4180");
    assert.equal(needsPairing(true, s), false);
    assert.equal(showHostSwitcher(up), false);
    // Not persisted by a read alone; the next saveSession/setSessionHostId writes v:3.
    assert.equal(JSON.parse(s.getItem("vs.remote.session")).v, 2);
    assert.equal(setSessionHostId("pc.example:4180", HOST_ID, s), true);
    assert.equal(JSON.parse(s.getItem("vs.remote.session")).v, 3);
    assert.deepEqual(readSession(s), {
      v: 3,
      activeHostId: HOST_ID,
      hosts: [{ hostId: HOST_ID, label: "pc.example:4180", meshnetHost: "pc.example:4180", savedAt: "2026-11-07T00:00:00.000Z" }],
    });
    assert.equal(setSessionHostId("pc.example:4180", HOST_ID, s), false, "no-op when already known");
    assert.equal(setSessionHostId("pc.example:4180", "junk id", s), false, "a malformed id is ignored");
    assert.equal(setSessionHostId("other.example:4180", HOST_ID, s), false, "unknown host is ignored");
  });

  test("saveSession with a known hostId + CA pin keys the entry by them; re-pairing never duplicates a host", () => {
    const FP = "c".repeat(64);
    const s = fakeStore();
    saveSession("pc.example", s, new Date("2026-11-07T00:00:00Z"), HOST_ID, FP);
    saveSession("pc.example:4180", s, new Date("2026-11-08T00:00:00Z"), HOST_ID, FP);
    let r = readSession(s);
    assert.equal(r.hosts.length, 1);
    assert.equal(r.activeHostId, HOST_ID);
    assert.equal(r.hosts[0].savedAt, "2026-11-08T00:00:00.000Z");
    // The same PC (same id AND same pin) reached by a new address (Meshnet name changed): the entry follows it.
    saveSession("100.64.0.7", s, new Date("2026-11-09T00:00:00Z"), HOST_ID, FP);
    r = readSession(s);
    assert.equal(r.hosts.length, 1);
    assert.equal(r.hosts[0].meshnetHost, "100.64.0.7:4180");
    // The same address, a reset PC (new host id): still one entry, now under the new id.
    saveSession("100.64.0.7", s, new Date("2026-11-10T00:00:00Z"), HOST_ID_2);
    r = readSession(s);
    assert.equal(r.hosts.length, 1);
    assert.equal(r.hosts[0].hostId, HOST_ID_2);
    assert.equal(r.activeHostId, HOST_ID_2);
    assert.equal(showHostSwitcher(r), false, "no switcher UI with one host");
  });

  test("a second host (E5 later) becomes active; the switcher rule flips only then; forgetHost keeps the rest", () => {
    const s = fakeStore();
    saveSession("pc.example", s, new Date("2026-11-07T00:00:00Z"), HOST_ID);
    saveSession("work.example", s, new Date("2026-11-08T00:00:00Z"), HOST_ID_2);
    const r = readSession(s);
    assert.equal(r.hosts.length, 2);
    assert.equal(r.activeHostId, HOST_ID_2);
    assert.equal(activeHost(r).meshnetHost, "work.example:4180");
    assert.equal(showHostSwitcher(r), true);
    forgetHost("work.example:4180", s);
    const after = readSession(s);
    assert.deepEqual(after.hosts.map((h) => h.hostId), [HOST_ID]);
    assert.equal(after.activeHostId, HOST_ID);
    assert.equal(showHostSwitcher(after), false);
    forgetHost("pc.example:4180", s);
    assert.equal(readSession(s), null, "forgetting the last host clears the session");
  });

  test("migrateSession validates v:3 shapes and keeps relay-only hosts for E5", () => {
    assert.equal(migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [] }), null, "no hosts");
    assert.equal(migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [{ hostId: HOST_ID, label: "x", savedAt: "t" }] }), null, "unreachable host (no meshnetHost, no relay)");
    const relayOnly = migrateSession({ v: 3, activeHostId: "nope", hosts: [{ hostId: HOST_ID, label: "Home", relay: { endpoint: "wss://r.example/ws", pubKey: "k" }, savedAt: "t" }] });
    assert.deepEqual(relayOnly, { v: 3, activeHostId: HOST_ID, hosts: [{ hostId: HOST_ID, label: "Home", relay: { hostId: HOST_ID, endpoint: "wss://r.example/ws", pubKey: "k" }, savedAt: "t" }] }, "a pre-fold pin is keyed by the entry id");
    const folded = migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [{ hostId: HOST_ID, label: "Home", meshnetHost: "pc.example:4180", relay: { hostId: HOST_ID_2, endpoint: "wss://r.example/ws", pubKey: "k", token: "tok" }, savedAt: "t" }] });
    assert.deepEqual(folded.hosts[0].relay, { hostId: HOST_ID_2, endpoint: "wss://r.example/ws", pubKey: "k", token: "tok" }, "relay id and token survive a read");
    assert.equal(migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [{ hostId: HOST_ID, label: "Home", relay: { endpoint: "ws://r.example/ws", pubKey: "k" }, savedAt: "t" }] }), null, "a clear-text relay pin is not a way to reach a host");
    assert.equal(activeMeshnetHost(relayOnly), "", "no LAN/Meshnet address for a relay-only host");
    const bad = migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [{ hostId: "bad id", label: "", meshnetHost: "pc.example", savedAt: "t" }, "junk"] });
    assert.deepEqual(bad, { v: 3, activeHostId: "", hosts: [{ hostId: "", label: "pc.example:4180", meshnetHost: "pc.example:4180", savedAt: "t" }] });
    assert.equal(normalizeHostId(HOST_ID), HOST_ID);
    assert.equal(normalizeHostId(" " + HOST_ID + "\n"), HOST_ID);
    assert.equal(normalizeHostId("short"), "");
    assert.equal(normalizeHostId("has/slash".padEnd(22, "a")), "");
  });

  test("fetchHostId asks /api/auth/status, trusts only a well-formed id, and never throws", async () => {
    const calls = [];
    const ok = async (url, init) => {
      calls.push([url, init?.cache]);
      return { ok: true, json: async () => ({ ok: true, paired: false, hostId: HOST_ID }) };
    };
    assert.equal(await fetchHostId("pc.example", ok), HOST_ID);
    assert.deepEqual(calls, [["https://pc.example:4180/api/auth/status", "no-store"]]);
    assert.equal(await fetchHostId("pc.example", async () => ({ ok: true, json: async () => ({ hostId: "x" }) })), "");
    assert.equal(await fetchHostId("pc.example", async () => ({ ok: false, json: async () => ({ hostId: HOST_ID }) })), "");
    assert.equal(await fetchHostId("pc.example", async () => { throw new Error("TypeError: Failed to fetch"); }), "");
    assert.equal(await fetchHostId("pc.example", null), "");
    assert.equal(await fetchHostId("localhost", ok), "", "never asks a local address");
  });

  test("an old relay-offer session or junk is not trusted", () => {
    const old = { v: 1, offer: { v: 2, serverId: "srv", daemonPublicKeyB64: "k", relay: { endpoint: "r" } }, savedAt: "x" };
    assert.equal(readSession(fakeStore({ "vs.remote.session": JSON.stringify(old) })), null);
    assert.equal(readSession(fakeStore({ "vs.remote.session": "{" })), null);
    assert.equal(readSession(fakeStore({ "vs.remote.session": JSON.stringify({ v: 2, host: "localhost", savedAt: "x" }) })), null);
    assert.throws(() => saveSession("localhost", fakeStore()));
  });

  test("RemotePairScreen reads the active host, fills the host id, and has no switcher chrome", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /activeMeshnetHost\(session\)/);
    assert.match(src, /saveSession\(hostN, undefined, undefined, await fetchHostId\(hostN\), pinnedFp\)/);
    assert.match(src, /setSessionHostId\(saved\.host, await fetchHostId\(saved\.host\)\)/);
    assert.match(src, /forgetHost\(saved\.host\)/);
    assert.doesNotMatch(src, /showHostSwitcher|host-switcher/, "no switcher UI while hosts.length <= 1 (none exists yet at all)");
    const types = read("src/agentTypes.ts");
    assert.match(types, /hostId\?: string/);
  });
});

describe("relay pairing is gone", () => {
  test("no #offer= code paths left in the web sources", () => {
    for (const f of ["src/remoteSession.ts", "src/main.tsx", "src/RemotePairScreen.tsx", "src/App.tsx", "src/DiagnosticsModal.tsx"]) {
      assert.doesNotMatch(read(f), /#offer=|offerFromHash|normalizeOfferInput|hasOfferFragment/, f);
    }
  });

  test("the remote build boots the pair screen, not the local client, and the deep link is configured", () => {
    const main = read("src/main.tsx");
    assert.match(main, /remote \? <RemotePairScreen \/>/);
    assert.match(main, /!remote\) \{\s*start\(\)/);
    const conf = JSON.parse(read("src-tauri/tauri.android.conf.json"));
    assert.deepEqual(conf.plugins["deep-link"].mobile[0].scheme, ["vibesquad"]);
  });
});

describe("isAndroidUserAgent", () => {
  test("detects Android browsers and WebViews", () => {
    assert.equal(
      isAndroidUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"),
      true,
    );
    assert.equal(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 wv"), true);
  });

  test("rejects desktop and non-Android user agents", () => {
    assert.equal(isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"), false);
    assert.equal(isAndroidUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), false);
    assert.equal(isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"), false);
    assert.equal(isAndroidUserAgent(""), false);
    assert.equal(isAndroidUserAgent(), false);
  });
});

describe("Block A4: PinGrid / .pin-tile mobile wrapping & overflow CSS", () => {
  const css = () => read("src/styles.css");

  test(".pin-grid-wrap constrains width so the grid can shrink on narrow viewports", () => {
    const src = css();
    assert.match(src, /\.pin-grid-wrap\s*\{[^}]*margin:\s*0\s+0\s+18px;/);
    assert.match(src, /\.pin-grid-wrap\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-grid-wrap\s*\{[^}]*max-width:\s*100%;/);
  });

  test(".pin-grid uses minmax(min(100%, 300px), 1fr) and a bounded width", () => {
    const src = css();
    assert.match(src, /\.pin-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*18rem\),\s*1fr\)\);/);
    assert.match(src, /\.pin-grid\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-grid\s*\{[^}]*max-width:\s*100%;/);
  });

  test(".pin-tile clips overflow and never exceeds its grid cell", () => {
    const src = css();
    assert.match(src, /\.pin-tile\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-tile\s*\{[^}]*max-width:\s*100%;/);
    assert.match(src, /\.pin-tile\s*\{[^}]*overflow:\s*hidden;/);
  });

  test(".pin-tile-head wraps and shrinks its children cleanly", () => {
    const src = css();
    assert.match(src, /\.pin-tile-head\s*\{[^}]*flex-wrap:\s*wrap;/);
    assert.match(src, /\.pin-tile-head\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-tile-head\s*\{[^}]*max-width:\s*100%;/);
  });

  test(".pin-tile-lines is bounded so its content never overflows the tile", () => {
    const src = css();
    assert.match(src, /\.pin-tile-lines\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-tile-lines\s*\{[^}]*max-width:\s*100%;/);
  });

  test(".pin-line wraps and clamps to two lines instead of truncating", () => {
    const src = css();
    assert.match(src, /\.pin-line\s*\{[^}]*white-space:\s*normal;/);
    assert.match(src, /\.pin-line\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    assert.match(src, /\.pin-line\s*\{[^}]*word-break:\s*break-word;/);
    assert.match(src, /\.pin-line\s*\{[^}]*display:\s*-webkit-box;/);
    assert.match(src, /\.pin-line\s*\{[^}]*\-webkit-line-clamp:\s*2;/);
    assert.match(src, /\.pin-line\s*\{[^}]*\-webkit-box-orient:\s*vertical;/);
  });

  test(".pin-reply stays bounded so the input and Send button never clip", () => {
    const src = css();
    assert.match(src, /\.pin-reply\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-reply\s*\{[^}]*max-width:\s*100%;/);
  });
});

describe("Block A5: Phone UI pass (status bar fit, Lead page wrap, right sidebar overflow)", () => {
  const css = () => read("src/styles.css");

  test("index.html sets viewport-fit=cover", () => {
    assert.match(read("index.html"), /viewport-fit=cover/);
  });

  test("DrawerHeader uses flexWrap wrap on brainstorm-ctx-main/actions (no nowrap)", () => {
    const src = read("src/DrawerHeader.tsx");
    assert.match(src, /className="brainstorm-ctx-main" style=\{\{ flexWrap: "wrap"/);
    assert.match(src, /className="brainstorm-ctx-actions" style=\{\{ flexWrap: "wrap"/);
    assert.doesNotMatch(src, /brainstorm-ctx-(?:main|actions)" style=\{\{ flexWrap: "nowrap"/);
  });

  test("safe-area insets: .remote-pair, mobile .app padding, .focus-rail, .mobile-bottom-bar", () => {
    const src = css();
    assert.match(src, /\.remote-pair\s*\{[^}]*padding-top:\s*max\(16px,\s*env\(safe-area-inset-top,\s*0px\)\)/);
    assert.match(src, /\.remote-pair\s*\{[^}]*padding-bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
    assert.match(src, /padding-top:\s*env\(safe-area-inset-top,\s*0px\);/);
    assert.match(src, /padding-bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom,\s*0px\)\);/);
    assert.match(src, /\.app\.sheet-open > \.focus-rail\s*\{[^}]*top:\s*env\(safe-area-inset-top,\s*0px\);/);
    assert.match(src, /\.app\.sheet-open > \.focus-rail\s*\{[^}]*bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom,\s*0px\)\);/);
    assert.match(src, /\.mobile-bottom-bar\s*\{[^}]*height:\s*calc\(56px \+ env\(safe-area-inset-bottom,\s*0px\)\);/);
    assert.match(src, /\.mobile-bottom-bar\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\);/);
  });

  test(".meter.meter-ladder / .meter-readout wrap on narrow Lead cards", () => {
    const src = css();
    assert.match(src, /\.meter\.meter-ladder\s*\{[^}]*flex-wrap:\s*wrap;/);
    assert.match(src, /\.meter\.meter-ladder\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.meter\.meter-ladder\s*\{[^}]*max-width:\s*100%;/);
    assert.match(src, /\.meter\.meter-ladder \.meter-track\s*\{[^}]*flex:\s*1 1 80px;/);
    assert.match(src, /\.meter\.meter-ladder \.meter-track\s*\{[^}]*min-width:\s*60px;/);
    assert.match(src, /\.meter\.meter-ladder \.meter-readout\s*\{[^}]*white-space:\s*normal;/);
    assert.match(src, /\.meter\.meter-ladder \.meter-readout\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    assert.match(src, /\.meter\.meter-ladder \.meter-readout\s*\{[^}]*word-break:\s*break-word;/);
  });

  test("mobile .pin-focus-bar / .drawer-head-compact wrap instead of clipping", () => {
    const src = css();
    assert.match(src, /\.pin-focus-bar\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*44px;[^}]*flex-wrap:\s*wrap;/);
    assert.match(src, /\.pin-focus-bar\s*\{[^}]*padding:\s*4px 8px;/);
    assert.match(src, /\.pin-focus-bar\s*\{[^}]*row-gap:\s*4px;/);
    assert.match(src, /\.pin-focus-bar\s*\{[^}]*overflow:\s*visible;/);
    assert.match(src, /\.drawer-head-compact\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*36px;[^}]*flex-wrap:\s*wrap;/);
    assert.match(src, /\.drawer-head-compact\s*\{[^}]*overflow:\s*visible;/);
  });

  test(".lint-bar / .successor-bar / .drawer-head / .drawer-id / .drawer-role-line / .drawer-meta-line / .drawer-model-input are width-bounded", () => {
    const src = css();
    const block = src.match(/\.lint-bar,\s*\.successor-bar,[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(block.length > 0, "width-bounds rule block found");
    for (const sel of [".drawer-head", ".drawer-id", ".drawer-role-line", ".drawer-meta-line"]) {
      assert.match(block, new RegExp(sel.replace(/\./g, "\\.") + ","), `${sel} in width-bounds block`);
    }
    assert.match(block, /\.drawer-model-input\s*\{/);
    assert.match(block, /min-width:\s*0;\s*max-width:\s*100%;/);
  });

  test(".successor-bar .btn / .btn.successor wrap instead of clipping", () => {
    const src = css();
    const block = src.match(/\.successor-bar \.btn,\s*\.btn\.successor\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(block.length > 0, "successor btn wrap block found");
    assert.match(block, /white-space:\s*normal;\s*max-width:\s*100%;/);
  });

  test(".pin-team-row .pin-row-name truncates cleanly", () => {
    const src = css();
    assert.match(src, /\.pin-team-row \.pin-row-name\s*\{[^}]*flex:\s*1;/);
    assert.match(src, /\.pin-team-row \.pin-row-name\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.pin-team-row \.pin-row-name\s*\{[^}]*overflow:\s*hidden;/);
    assert.match(src, /\.pin-team-row \.pin-row-name\s*\{[^}]*text-overflow:\s*ellipsis;/);
    assert.match(src, /\.pin-team-row \.pin-row-name\s*\{[^}]*white-space:\s*nowrap;/);
  });

  test(".pin-rail-active-buddy / .pin-rail-active-inspector / .pin-rail-buddy-tools stay bounded", () => {
    const src = css();
    const block = src.match(/\.pin-rail-active-buddy,\s*\.pin-rail-active-inspector,[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(block.length > 0, "pin-rail overflow block found");
    assert.match(block, /\.pin-rail-buddy-tools\s*\{/);
    assert.match(block, /min-width:\s*0;\s*max-width:\s*100%;\s*overflow:\s*hidden;/);
  });

  test(".right-dock-tabs / .right-dock-tab scroll and stay compact", () => {
    const src = css();
    assert.match(src, /\.right-dock-tabs\s*\{[^}]*overflow-x:\s*auto;/);
    assert.match(src, /\.right-dock-tabs\s*\{[^}]*scrollbar-width:\s*none;/);
    assert.match(src, /\.right-dock-tabs\s*\{[^}]*min-width:\s*0;/);
    assert.match(src, /\.right-dock-tabs\s*\{[^}]*max-width:\s*100%;/);
    assert.match(src, /\.right-dock-tab\s*\{[^}]*flex:\s*0 0 auto;/);
    assert.match(src, /\.right-dock-tab\s*\{[^}]*padding:\s*7px 9px;/);
  });

  test("mobile .drawer-shell / .right-dock stack instead of crushing", () => {
    const src = css();
    assert.match(src, /\.drawer-shell\s*\{[^}]*flex-direction:\s*column;/);
    assert.match(src, /\.right-dock\s*\{[^}]*width:\s*100% !important;/);
    assert.match(src, /\.right-dock\s*\{[^}]*max-width:\s*100% !important;/);
    assert.match(src, /\.right-dock\s*\{[^}]*min-width:\s*0 !important;/);
    assert.match(src, /\.right-dock\s*\{[^}]*max-height:\s*55%;/);
    assert.match(src, /\.right-dock\s*\{[^}]*border-left:\s*0;/);
    assert.match(src, /\.right-dock\s*\{[^}]*border-top:\s*1px solid var\(--cyan\);/);
    assert.match(src, /\.right-dock-resize-handle\s*\{[^}]*display:\s*none;/);
  });
});

describe("pairing is proven before it is saved (review fixes)", () => {
  test("a pending pairing is not a session, and expires", async () => {
    const { savePending, readPending, clearPending, parsePairReturn, serverUrl } = await import("../src/remoteSession.ts");
    const s = fakeStore();
    savePending("pc.example", s, new Date("2026-11-07T00:00:00Z"));
    assert.equal(readSession(s), null);
    assert.equal(needsPairing(true, s), true);
    assert.equal(readPending(s, new Date("2026-11-07T00:05:00Z")), "pc.example:4180");
    assert.equal(readPending(s, new Date("2026-11-07T00:11:00Z")), null);
    clearPending(s);
    assert.equal(readPending(s, new Date("2026-11-07T00:00:01Z")), null);
    assert.equal(parsePairReturn("#paired"), "paired");
    assert.equal(parsePairReturn("#unpaired"), "unpaired");
    assert.equal(parsePairReturn("#paired=evil.example"), null);
    assert.match(pairRedeemUrl("pc.example:4180", "123456", "x", "http://tauri.localhost"), /vs_app=http%3A%2F%2Ftauri\.localhost/);
    assert.equal(serverUrl("pc.example:4180"), "https://pc.example:4180/");
  });

  test("screen saves the host only on an explicit Pair press (the PC opens its own UI, no trip back), deep links never auto-pair, reachability is not trust", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /saveSession\(hostN, undefined, undefined, await fetchHostId\(hostN\), pinnedFp\);[\s\S]*?location\.href = pairRedeemUrl/);
    assert.doesNotMatch(src, /apply\([^)]*\)[^\n]*\bpairWith\b|autoPair/);
    assert.match(src, /data-testid="pair-confirm"/);
    assert.match(src, /data-testid="forget-pc"/);
  });

  test("PC-served failure pages never link to the app origin; they carry a deep link + Back", () => {
    const src = read("server/auth.mjs");
    assert.doesNotMatch(src, /\$\{app\}\/#(paired|unpaired|failed)/);
    assert.match(src, /vibesquad:\/\/pair\?host=/);
    assert.match(src, /TAURI_ORIGINS\.has\(o\)/);
  });
});

describe("APK entry survives SameSite=Strict (vs_device is withheld on a cross-site navigation)", () => {
  test("the app opens the PC through the same-site /__vibesquad/enter hop", async () => {
    const { serverUrl } = await import("../src/remoteSession.ts");
    assert.equal(serverUrl("pc.example:4180", "http://tauri.localhost"), "https://pc.example:4180/__vibesquad/enter?vs_app=http%3A%2F%2Ftauri.localhost");
  });

  test("handleEnter is a fixed same-site bounce to '/', no token, no open redirect, cookie stays Strict", async () => {
    const { handleEnter } = await import("../server/auth.mjs");
    const run = (url, method = "GET") => {
      const headers = {};
      const res = { statusCode: 0, body: "", setHeader: (k, v) => void (headers[k.toLowerCase()] = v), getHeader: (k) => headers[k.toLowerCase()], end(b) { this.body = b ?? ""; } };
      handleEnter({ url, method, headers: {} }, res);
      return { res, headers };
    };
    const ok = run("/__vibesquad/enter?vs_app=http%3A%2F%2Ftauri.localhost");
    assert.equal(ok.res.statusCode, 200);
    assert.equal(ok.headers.location, undefined, "a 3xx would keep the cross-site chain; the hop must be a client navigation");
    assert.equal(ok.headers["set-cookie"], undefined);
    assert.match(ok.res.body, /location\.replace\("\/\?vs_app=http%3A%2F%2Ftauri\.localhost"\)/);
    const evil = run("/__vibesquad/enter?vs_app=https%3A%2F%2Fevil.example&next=https://evil.example");
    assert.match(evil.res.body, /location\.replace\("\/"\)/);
    assert.doesNotMatch(evil.res.body, /evil/);
    assert.equal(run("/__vibesquad/enter", "POST").res.statusCode, 405);
    const auth = read("server/auth.mjs");
    assert.match(auth, /\$\{DEVICE_COOKIE\}=\$\{token\}; HttpOnly; Secure; SameSite=Strict/);
    const serve = read("server/serve.mjs");
    assert.ok(serve.indexOf('"/__vibesquad/enter"') < serve.indexOf("sendUnpaired(req, res)"), "enter must be served before the auth gate");
  });
});

describe("mapRemoteError (B4, B7)", () => {
  test("TLS pin failures say the certificate changed", () => {
    for (const m of ["Trust anchor for certification path not found.", "javax.net.ssl.SSLHandshakeException: x", "net::ERR_CERT_AUTHORITY_INVALID", "CERT_AUTHORITY_INVALID"]) {
      assert.equal(mapRemoteError(new Error(m)).message, "This PC's certificate changed. Scan a new QR on the PC to pair again.");
    }
  });
  test("JVM connect / DNS / timeout messages are plain language", () => {
    assert.equal(mapRemoteError(new Error("failed to connect to /192.0.2.1 (port 4180) after 5000ms")).kind, "unreachable");
    assert.equal(mapRemoteError(new Error("Unable to resolve host \"pc.example\"")).kind, "unreachable");
    assert.equal(mapRemoteError(new Error("java.net.SocketTimeoutException: Read timed out")).kind, "timeout");
    assert.equal(mapRemoteError(new Error("SocketTimeout")).kind, "timeout");
    assert.equal(mapRemoteError(new Error("connect timeout")).kind, "timeout");
    assert.equal(mapRemoteError(new Error("boom")).kind, "unknown");
  });
});

describe("X1 R1 L2: saved hosts fold on hostId + pinned CA fingerprint, never on the public id alone", () => {
  const FP_A = "a".repeat(64);
  const FP_B = "b".repeat(64);

  test("same hostId, different CA pin: two PCs stay saved (a cloned ~/.vibesquad or a spoofed id evicts nothing)", () => {
    const s = fakeStore();
    saveSession("home.example", s, new Date("2026-11-07T00:00:00Z"), HOST_ID, FP_A);
    saveSession("clone.example", s, new Date("2026-11-08T00:00:00Z"), HOST_ID, FP_B);
    const r = readSession(s);
    assert.deepEqual(r.hosts.map((h) => [h.meshnetHost, h.hostId, h.caFp]), [
      ["clone.example:4180", HOST_ID, FP_B],
      ["home.example:4180", HOST_ID, FP_A],
    ]);
    assert.equal(samePc(r.hosts[0], r.hosts[1]), false);
    assert.equal(samePc({ hostId: HOST_ID }, { hostId: HOST_ID }), false, "no pin on either side: not provably the same PC");
    assert.equal(samePc({ hostId: HOST_ID, caFp: FP_A }, { hostId: HOST_ID, caFp: FP_A }), true);
  });

  test("same hostId and same CA pin reached by a new address: one entry, following the PC", () => {
    const s = fakeStore();
    saveSession("home.example", s, new Date("2026-11-07T00:00:00Z"), HOST_ID, FP_A);
    saveSession("100.64.0.7", s, new Date("2026-11-08T00:00:00Z"), HOST_ID, FP_A);
    const r = readSession(s);
    assert.equal(r.hosts.length, 1);
    assert.equal(r.hosts[0].meshnetHost, "100.64.0.7:4180");
    assert.equal(r.hosts[0].caFp, FP_A);
  });

  test("setSessionHostId folds another entry only when its CA pin matches too", () => {
    const s = fakeStore();
    saveSession("home.example", s, new Date("2026-11-07T00:00:00Z"), HOST_ID, FP_A);
    saveSession("other.example", s, new Date("2026-11-08T00:00:00Z"), "", FP_B); // id unknown yet, different pin
    assert.equal(setSessionHostId("other.example:4180", HOST_ID, s), true);
    let r = readSession(s);
    assert.equal(r.hosts.length, 2, "a different pin is a different PC even with the same reported id");
    const s2 = fakeStore();
    saveSession("home.example", s2, new Date("2026-11-07T00:00:00Z"), HOST_ID, FP_A);
    saveSession("alias.example", s2, new Date("2026-11-08T00:00:00Z"), "", FP_A); // same pin, id arrives later
    assert.equal(setSessionHostId("alias.example:4180", HOST_ID, s2), true);
    r = readSession(s2);
    assert.deepEqual(r.hosts.map((h) => h.meshnetHost), ["alias.example:4180"], "same PC (id + pin): folded");
    assert.equal(r.activeHostId, HOST_ID);
  });

  test("a v:2 upgrade has no pin; a bad caFp is dropped on read; the pair screen passes the pinned fingerprint", () => {
    const s = fakeStore({ "vs.remote.session": JSON.stringify({ v: 2, host: "pc.example:4180", savedAt: "t" }) });
    assert.equal(readSession(s).hosts[0].caFp, undefined);
    const bad = migrateSession({ v: 3, activeHostId: HOST_ID, hosts: [{ hostId: HOST_ID, caFp: "zz", label: "x", meshnetHost: "pc.example", savedAt: "t" }] });
    assert.equal(bad.hosts[0].caFp, undefined);
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /pinnedFp = \(await t\.pin\(hostN, fpN!\)\) \|\| pinnedFp/);
  });
});

describe("E5 pin store: a pairing link never replaces a stored host key (threat model §7 pin-store rule)", () => {
  const KEY_A = Buffer.alloc(32, 0x41).toString("base64"); // 32 x "A"
  const KEY_B = Buffer.alloc(32, 0x42).toString("base64"); // 32 x "B"
  const KEY_A_URL = KEY_A.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const RELAY_ID = "c29tZS1yZWxheS1ob3N0LWlkLTEyMzQ1Ng"; // any url-safe 22-64 char id (self-certifying ids are 43 chars)

  test("a new host is added with its pin and becomes active; the same key refreshes the relay endpoint ONLY with repoint (X1 wire L2)", () => {
    const store = fakeStore();
    saveRelayPin(RELAY_ID, { endpoint: "wss://relay-one.example/ws", pubKey: KEY_A }, store, new Date("2026-11-11T00:00:00Z"));
    assert.deepEqual(relayPinFor(RELAY_ID, store), { hostId: RELAY_ID, endpoint: "wss://relay-one.example/ws", pubKey: KEY_A });
    assert.equal(readSession(store).activeHostId, RELAY_ID);
    assert.equal(readSession(store).hosts[0].label, "relay-one.example");
    const before = store.getItem(REMOTE_SESSION_KEY);
    saveRelayPin(RELAY_ID, { endpoint: "wss://relay-two.example/ws", pubKey: KEY_A_URL }, store, new Date("2026-11-11T00:00:00Z")); // base64url spelling of the same key, new endpoint, no confirm
    assert.equal(store.getItem(REMOTE_SESSION_KEY), before, "a same-key link does not move the endpoint by itself");
    saveRelayPin(RELAY_ID, { endpoint: "wss://relay-two.example/ws", pubKey: KEY_A_URL }, store, new Date(), "", { repoint: true }); // the user said yes
    assert.deepEqual(relayPinFor(RELAY_ID, store), { hostId: RELAY_ID, endpoint: "wss://relay-two.example/ws", pubKey: KEY_A }, "endpoint moved, key untouched");
    assert.equal(readSession(store).hosts.length, 1);
  });

  test("attacker: a link naming a known host with a different key throws RelayPinMismatchError and changes nothing", () => {
    const store = fakeStore();
    saveRelayPin(RELAY_ID, { endpoint: "wss://relay-one.example/ws", pubKey: KEY_A }, store);
    const before = store.getItem(REMOTE_SESSION_KEY);
    assert.throws(() => saveRelayPin(RELAY_ID, { endpoint: "wss://evil.example/ws", pubKey: KEY_B }, store), RelayPinMismatchError);
    assert.equal(store.getItem(REMOTE_SESSION_KEY), before, "store byte-identical");
    assert.deepEqual(relayPinFor(RELAY_ID, store), { hostId: RELAY_ID, endpoint: "wss://relay-one.example/ws", pubKey: KEY_A });
  });

  test("a LAN-paired host gets its relay pin added in place (CA pin and address kept); junk links are refused", () => {
    const store = fakeStore();
    saveSession("100.64.0.7:4180", store, new Date(), HOST_ID, "ab".repeat(32));
    saveRelayPin(RELAY_ID, { endpoint: "wss://relay.example", pubKey: KEY_B }, store);
    foldRelayHost(RELAY_ID, HOST_ID, store, "ab".repeat(32));
    const h = readSession(store).hosts;
    assert.equal(h.length, 1);
    assert.equal(h[0].meshnetHost, "100.64.0.7:4180");
    assert.equal(h[0].caFp, "ab".repeat(32));
    assert.deepEqual(h[0].relay, { hostId: RELAY_ID, endpoint: "wss://relay.example", pubKey: KEY_B });
    assert.throws(() => saveRelayPin(HOST_ID, { endpoint: "ws://relay.example", pubKey: KEY_B }, store), /wss:/);
    assert.throws(() => saveRelayPin(HOST_ID, { endpoint: "wss://relay.example", pubKey: "c2hvcnQ=" }, store), /host key/);
    assert.throws(() => saveRelayPin("bad id", { endpoint: "wss://relay.example", pubKey: KEY_B }, store), /host id/);
    assert.equal(relayPinFor("nope", store), null);
    assert.ok(sameRelayKey(KEY_A, KEY_A_URL) && !sameRelayKey(KEY_A, KEY_B));
  });
});
