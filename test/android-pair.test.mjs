// Block A1 (PLAN_ANDROID_MESHNET.md): the APK pairs over the VS-native LAN/Meshnet path (QR + 6-digit code).
// - Pure logic: parsePairInput / toAndroidDeepLink / pairRedeemUrl / session storage (src/remoteSession.ts)
// - UI wiring: src/RemotePairScreen.tsx via src/main.tsx; the relay `#offer=` paths are gone (f9b4095)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  clearSession,
  isAndroidUserAgent,
  needsPairing,
  normalizeHost,
  pairRedeemUrl,
  parsePairInput,
  readSession,
  saveSession,
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

describe("stored pairing session", () => {
  test("save / read / clear and needsPairing", () => {
    const s = fakeStore();
    assert.equal(readSession(s), null);
    assert.equal(needsPairing(true, s), true);
    assert.equal(needsPairing(false, s), false);
    saveSession("pc.example", s, new Date("2026-11-07T00:00:00Z"));
    assert.deepEqual(readSession(s), { v: 2, host: "pc.example:4180", savedAt: "2026-11-07T00:00:00.000Z" });
    assert.equal(needsPairing(true, s), false);
    clearSession(s);
    assert.equal(needsPairing(true, s), true);
  });

  test("an old relay-offer session or junk is not trusted", () => {
    const old = { v: 1, offer: { v: 2, serverId: "srv", daemonPublicKeyB64: "k", relay: { endpoint: "r" } }, savedAt: "x" };
    assert.equal(readSession(fakeStore({ "vs.remote.session": JSON.stringify(old) })), null);
    assert.equal(readSession(fakeStore({ "vs.remote.session": "{" })), null);
    assert.throws(() => saveSession("localhost", fakeStore()));
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

  test("screen saves only a pending record, deep links never auto-pair, reachability is not trust", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.doesNotMatch(src, /saveSession\(hostN\)/);
    assert.match(src, /savePending\(hostN\)/);
    assert.doesNotMatch(src, /apply\([^)]*\)[^\n]*\bpairWith\b|autoPair/);
    assert.match(src, /data-testid="pair-confirm"/);
    assert.match(src, /data-testid="forget-pc"/);
  });

  test("the server sends the APK back to its own origin: #paired / #unpaired / #failed", () => {
    const src = read("server/auth.mjs");
    assert.match(src, /\$\{app\}\/#unpaired/);
    assert.match(src, /\$\{app\}\/#failed/);
    assert.match(src, /app && paired \? `\$\{app\}\/#paired`/);
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
