// Block A2 (PLAN_ANDROID_APP.md): Android deep-link QR pairing + clipboard paste UX.
// - Pure logic: normalizeOfferInput / toAndroidDeepLink / isAndroidUserAgent (src/remoteSession.ts)
// - Server: getPaseoPairOffer deepLinkUrl + qrSvg (server/paseo-control.mjs)
// - UI wiring: PairDeviceModal.tsx (QR / deep-link copy / APK download) + RemotePair.tsx (deep-link + clipboard paste)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { isAndroidUserAgent, normalizeOfferInput, toAndroidDeepLink } from "../src/remoteSession.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const TOKEN = "eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl90ZXN0In0";

describe("normalizeOfferInput + toAndroidDeepLink", () => {
  test("extracts #offer= from an https app.paseo.sh link", () => {
    const input = `https://app.paseo.sh/#offer=${TOKEN}`;
    assert.equal(normalizeOfferInput(input), `#offer=${TOKEN}`);
    assert.equal(toAndroidDeepLink(input), `vibesquad://pair#offer=${TOKEN}`);
  });

  test("handles an existing vibesquad://pair#offer= deep link unchanged", () => {
    const input = `vibesquad://pair#offer=${TOKEN}`;
    assert.equal(normalizeOfferInput(input), `#offer=${TOKEN}`);
    assert.equal(toAndroidDeepLink(input), `vibesquad://pair#offer=${TOKEN}`);
  });

  test("normalizes a vibesquad://pair?offer= query form to the #offer= fragment", () => {
    const input = `vibesquad://pair?offer=${TOKEN}`;
    assert.equal(normalizeOfferInput(input), `#offer=${TOKEN}`);
    assert.equal(toAndroidDeepLink(input), `vibesquad://pair#offer=${TOKEN}`);
  });

  test("accepts a bare offer= token and a bare #offer= fragment", () => {
    assert.equal(normalizeOfferInput(`offer=${TOKEN}`), `#offer=${TOKEN}`);
    assert.equal(toAndroidDeepLink(`#offer=${TOKEN}`), `vibesquad://pair#offer=${TOKEN}`);
  });

  test("returns null for strings without an offer token", () => {
    for (const bad of ["", "   ", "https://app.paseo.sh/", "vibesquad://pair", "hello world", "offer=", "offer=   "]) {
      assert.equal(normalizeOfferInput(bad), null, `normalizeOfferInput(${JSON.stringify(bad)})`);
      assert.equal(toAndroidDeepLink(bad), null, `toAndroidDeepLink(${JSON.stringify(bad)})`);
    }
  });

  test("is symmetric with normalizeOfferInput (always yields vibesquad://pair + normalized)", () => {
    const link = `https://app.paseo.sh/#offer=${TOKEN}&x=1`;
    const normalized = normalizeOfferInput(link);
    assert.equal(toAndroidDeepLink(link), `vibesquad://pair${normalized}`);
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
    assert.match(src, /\.pin-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*300px\),\s*1fr\)\);/);
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
