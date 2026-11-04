// Block A2 (PLAN_ANDROID_APP.md): Android deep-link QR pairing + clipboard paste UX.
// - Pure logic: normalizeOfferInput / toAndroidDeepLink / isAndroidUserAgent (src/remoteSession.ts)
// - Server: getPaseoPairOffer deepLinkUrl + qrSvg (server/paseo-control.mjs)
// - UI wiring: PairDeviceModal.tsx (QR / deep-link copy / APK download) + RemotePair.tsx (deep-link + clipboard paste)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { isAndroidUserAgent, normalizeOfferInput, toAndroidDeepLink } from "../src/remoteSession.ts";
import { getPaseoPairOffer } from "../server/paseo-control.mjs";

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

describe("getPaseoPairOffer (deep-link QR pairing)", () => {
  test("returns deepLinkUrl and an <svg> qrSvg when the offer url contains #offer=", async () => {
    const pairUrl = `https://app.paseo.sh/#offer=${TOKEN}`;
    const res = await getPaseoPairOffer({
      cliRunner: async () => ({
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
        data: { relayEnabled: true, url: pairUrl, qr: "\u001b[32m█▀▀▀\u001b[0m" },
      }),
    });

    assert.equal(res.ok, true);
    assert.equal(res.relayEnabled, true);
    assert.equal(res.url, pairUrl);
    assert.equal(res.deepLinkUrl, `vibesquad://pair#offer=${TOKEN}`);
    assert.equal(typeof res.qrSvg, "string");
    assert.match(res.qrSvg, /<svg/, "qrSvg must be an SVG string");
    assert.equal(res.qr, "█▀▀▀", "ANSI escape codes are stripped from the text QR");
  });

  test("returns null deepLinkUrl and qrSvg when the url has no #offer=", async () => {
    const res = await getPaseoPairOffer({
      cliRunner: async () => ({
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
        data: { relayEnabled: false, url: "https://app.paseo.sh/", qr: "" },
      }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.deepLinkUrl, null);
    assert.equal(res.qrSvg, null);
  });

  test("keeps url null when the CLI omits it", async () => {
    const res = await getPaseoPairOffer({
      cliRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "", data: { relayEnabled: true } }),
    });
    assert.equal(res.url, null);
    assert.equal(res.deepLinkUrl, null);
    assert.equal(res.qrSvg, null);
  });
});

describe("UI wiring (source inspection)", () => {
  test("PairDeviceModal.tsx renders the scannable QR, deep-link copy, and APK download", () => {
    const src = read("src/PairDeviceModal.tsx");
    assert.match(src, /data-testid="paseo-offer-qr"/);
    assert.match(src, /dangerouslySetInnerHTML=\{\{ __html: paseoOffer\.qrSvg \}\}/);
    assert.match(src, /Scan with your Android phone to open the VibeSquad APK and pair over Paseo Relay/);
    assert.match(src, /data-testid="copy-android-deep-link"/);
    assert.match(src, /"vibesquad:\/\/pair#offer=" \+ paseoOffer\.url!\.split\("#offer="\)\[1\]/);
    assert.match(src, /data-testid="download-android-apk"/);
    assert.match(src, /download="VibeSquad\.apk"/);
    assert.match(src, /lanAndroidApkUrl\?: string \| null;/);
    assert.match(src, /deepLinkUrl\?: string \| null;/);
    assert.match(src, /qrSvg\?: string \| null;/);
  });

  test("RemotePair.tsx wires deep-link prefill, clipboard paste, and hides local daemon on Android", () => {
    const src = read("src/RemotePair.tsx");
    assert.match(src, /plugin:deep-link\|get_current/);
    assert.match(src, /"vibesquad:deep-link"/);
    assert.match(src, /data-testid="remote-pair-paste"/);
    assert.match(src, /navigator\.clipboard\.readText\(\)/);
    assert.match(src, /Clipboard access was denied\. Long-press the text box to paste\./);
    assert.match(src, /!isAndroidUserAgent\(\)/);
    assert.match(src, /isAndroidUserAgent, isLocalHost, normalizeOfferInput/);
  });

  test("server/paseo-control.mjs imports qrSvg and builds the deep link", () => {
    const src = read("server/paseo-control.mjs");
    assert.match(src, /import \{ qrSvg \} from "\.\/qr\.mjs"/);
    assert.match(src, /const deepLinkUrl = offerFragment \? `vibesquad:\/\/pair\$\{offerFragment\}` : null/);
    assert.match(src, /qrSvg: offerQrSvg/);
  });
});
