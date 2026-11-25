// Block A2d-2 (PLAN_ANDROID_MESHNET.md): PairDeviceModal Android APK download + empty meshnetHost QR fallback.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const modalPath = resolve(import.meta.dirname, "..", "src", "PairDeviceModal.tsx");
const src = readFileSync(modalPath, "utf8");

// Transpile PairDeviceModal.tsx to a temporary .mjs module so we can both render <PairDeviceModal /> and call resolvePairModalUrls.
const dir = mkdtempSync(join(tmpdir(), "vs-pair-modal-apk-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
writeFileSync(
  join(dir, "TeamActions.mjs"),
  `import React from ${JSON.stringify(reactUrl)};\nexport function Modal({ title, children, footer }) { return React.createElement("div", { "data-title": title }, children, footer); }\n`,
);
writeFileSync(
  join(dir, "ui.mjs"),
  `import React from ${JSON.stringify(reactUrl)};\nexport function Ago({ iso }) { return React.createElement("span", null, iso); }\n`,
);
const transpiled = transformSync("PairDeviceModal.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace('"react"', JSON.stringify(reactUrl))
  .replace('"./TeamActions"', '"./TeamActions.mjs"')
  .replace('"./ui"', '"./ui.mjs"')
  // Inline helpers are module-private; expose them from the transpiled copy only (no source change).
  .concat("\nexport { formatDeviceRoleBadge, pairStartInit };\n");
const modFile = join(dir, "PairDeviceModal.mjs");
writeFileSync(modFile, transpiled);
const { PairDeviceModal, resolvePairModalUrls, formatDeviceRoleBadge, pairStartInit } = await import(pathToFileURL(modFile).href);

function renderModal(initialPair) {
  return renderToStaticMarkup(React.createElement(PairDeviceModal, { onClose: () => {}, initialPair }));
}

const basePair = (overrides = {}) => ({
  code: "123456",
  pairUrl: "https://pc.example:4180/pair?code=123456",
  pairIpUrl: "https://100.64.0.10:4180/pair?code=123456",
  lanIp: "192.0.2.10",
  lanPairUrl: "https://192.0.2.10:4180/pair?code=123456",
  lanQrSvg: "<svg id='lan-qr'></svg>",
  lanAndroidApkUrl: "http://192.0.2.10:4180/VibeSquad.apk",
  androidApkHttpUrl: "http://100.64.0.10:4180/VibeSquad.apk",
  androidApkAvailable: true,
  caHttpUrl: "http://100.64.0.10:4180/ca.crt",
  caFingerprint: { full: "aa".repeat(32), short: "aaaa:aaaa" },
  meshnetHost: "pc.example",
  meshnetIp: "100.64.0.10",
  expiresAt: Date.now() + 300_000,
  qrSvg: "<svg id='host-qr'></svg>",
  qrSvgIp: "<svg id='ip-qr'></svg>",
  ...overrides,
});

describe("PairDeviceModal rendered APK download & gating", () => {
  test("renders Download VibeSquad.apk button with LAN URL when androidApkAvailable=true on LAN", () => {
    const html = renderModal(basePair());
    assert.match(html, /data-testid="download-android-apk"/);
    assert.match(html, /href="https:\/\/192\.0\.2\.10:4180\/VibeSquad\.apk"/);
    assert.match(html, /download="VibeSquad\.apk"/);
    assert.match(html, /⬇ Download VibeSquad\.apk \(Android\)/);
    assert.match(html, /Install the app, then scan with the in-app Scan \(not the phone camera\)\./);
    assert.doesNotMatch(html, /paseo|relay|#offer=/i);
  });

  test("renders Meshnet APK URL when lanIp is absent and androidApkAvailable=true", () => {
    const html = renderModal(basePair({ lanIp: null, lanPairUrl: null, lanAndroidApkUrl: null }));
    assert.match(html, /data-testid="download-android-apk"/);
    assert.match(html, /href="https:\/\/100\.64\.0\.10:4180\/VibeSquad\.apk"/);
  });

  test("expands the full CA SHA-256 fingerprint by default (idea-127), no toggle click needed", () => {
    const pair = basePair();
    const html = renderModal(pair);
    assert.ok(html.includes(`<code class="small">${pair.caFingerprint.full}</code>`));
    assert.match(html, />Hide full</);
    assert.doesNotMatch(html, />Full hex</);
  });

  test("hides the APK download card when androidApkAvailable=false", () => {
    const html = renderModal(basePair({ androidApkAvailable: false }));
    assert.doesNotMatch(html, /data-testid="download-android-apk"/);
    assert.doesNotMatch(html, /data-testid="android-apk-card"/);
  });

  test("hides APK link and QR/pairing link when meshnetHost, meshnetIp and lanIp are all empty", () => {
    const emptyPair = basePair({
      lanIp: null,
      lanPairUrl: null,
      lanQrSvg: null,
      lanAndroidApkUrl: null,
      meshnetHost: "",
      meshnetIp: "",
      androidApkHttpUrl: "",
      androidApkAvailable: true,
      pairUrl: "https://:4180/pair?code=123456",
      pairIpUrl: "https://:4180/pair?code=123456",
    });
    const urls = resolvePairModalUrls({ pair: emptyPair, meta: null, networkMode: "meshnet", useIpMode: false });
    assert.equal(urls.apkUrl, "");
    assert.equal(urls.androidApkAvailable, false);
    assert.equal(urls.activePairUrl, "");
    assert.equal(urls.activeQrSvg, "");

    const html = renderModal(emptyPair);
    assert.doesNotMatch(html, /data-testid="download-android-apk"/);
    assert.doesNotMatch(html, /data-testid="active-pair-url"/);
    assert.doesNotMatch(html, /https?:\/\/:4180/);
    assert.match(html, /No LAN or Meshnet address available for pairing\./);
    assert.match(html, /No LAN or Meshnet address detected\./);
  });
});

describe("resolvePairModalUrls — LAN & Meshnet APK URLs and availability", () => {
  test("selects lanAndroidApkUrl in Home LAN mode and androidApkHttpUrl in Meshnet mode (an old server's http:// is upgraded to https, idea-384)", () => {
    const sample = basePair();
    const lan = resolvePairModalUrls({ pair: sample, meta: null, networkMode: "lan", useIpMode: false });
    assert.equal(lan.isLan, true);
    assert.equal(lan.androidApkAvailable, true);
    assert.equal(lan.apkUrl, "https://192.0.2.10:4180/VibeSquad.apk");

    const mesh = resolvePairModalUrls({ pair: sample, meta: null, networkMode: "meshnet", useIpMode: false });
    assert.equal(mesh.isLan, false);
    assert.equal(mesh.androidApkAvailable, true);
    assert.equal(mesh.apkUrl, "https://100.64.0.10:4180/VibeSquad.apk");
  });

  test("falls back to synthesized https://<ip>:<port>/VibeSquad.apk and meta fields when pair is loading", () => {
    const fromMetaLan = resolvePairModalUrls({
      pair: null,
      meta: { lanIp: "192.0.2.20", meshnetIp: "100.64.0.20", port: 4180, androidApkAvailable: true },
      networkMode: "lan",
      useIpMode: false,
    });
    assert.equal(fromMetaLan.androidApkAvailable, true);
    assert.equal(fromMetaLan.apkUrl, "https://192.0.2.20:4180/VibeSquad.apk");

    const fromMetaMesh = resolvePairModalUrls({
      pair: null,
      meta: { lanIp: null, meshnetIp: "100.64.0.20", port: 4180, androidApkAvailable: false },
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(fromMetaMesh.androidApkAvailable, false);
    assert.equal(fromMetaMesh.apkUrl, "https://100.64.0.20:4180/VibeSquad.apk");
  });
});

describe("resolvePairModalUrls — empty meshnetHost QR & URL fallback", () => {
  test("uses meshnetIp when meshnetHost is empty even with default useIpMode=false", () => {
    const pairEmptyHost = basePair({
      lanIp: null,
      meshnetHost: "",
      meshnetIp: "100.64.0.10",
      pairUrl: "https://:4180/pair?code=654321&fp=abcdef0123456789",
      pairIpUrl: "https://100.64.0.10:4180/pair?code=654321&fp=abcdef0123456789",
      qrSvg: "<svg id='broken-empty-host'/>",
      qrSvgIp: "<svg id='scannable-ip-qr'/>",
    });

    const res = resolvePairModalUrls({
      pair: pairEmptyHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });

    assert.equal(res.host, "100.64.0.10");
    assert.equal(res.effectiveIpMode, true);
    assert.equal(res.activePairUrl, "https://100.64.0.10:4180/pair?code=654321&fp=abcdef0123456789");
    assert.doesNotMatch(res.activePairUrl, /^https:\/\/:/);
    assert.equal(res.activeQrSvg, "<svg id='scannable-ip-qr'/>");

    const html = renderModal(pairEmptyHost);
    assert.match(html, /href="https:\/\/100\.64\.0\.10:4180\/pair\?code=654321&amp;fp=abcdef0123456789"/);
    assert.doesNotMatch(html, /https:\/\/:4180/);
  });

  test("repairs https://:<port> in pairUrl even if pairIpUrl is omitted", () => {
    const res = resolvePairModalUrls({
      pair: {
        code: "654321",
        meshnetHost: "",
        meshnetIp: "100.64.0.10",
        pairUrl: "https://:4180/pair?code=654321",
        qrSvg: "<svg id='fallback'/>",
      },
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(res.activePairUrl, "https://100.64.0.10:4180/pair?code=654321");
  });

  test("preserves meshnetHost QR when meshnetHost is set and useIpMode=false, and switches on useIpMode=true", () => {
    const pairWithHost = basePair({
      code: "111222",
      lanIp: null,
      meshnetHost: "pc.example",
      meshnetIp: "100.64.0.10",
      pairUrl: "https://pc.example:4180/pair?code=111222",
      pairIpUrl: "https://100.64.0.10:4180/pair?code=111222",
      qrSvg: "<svg id='host-qr'/>",
      qrSvgIp: "<svg id='ip-qr'/>",
    });

    const hostMode = resolvePairModalUrls({
      pair: pairWithHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(hostMode.host, "pc.example");
    assert.equal(hostMode.effectiveIpMode, false);
    assert.equal(hostMode.activePairUrl, "https://pc.example:4180/pair?code=111222");
    assert.equal(hostMode.activeQrSvg, "<svg id='host-qr'/>");

    const ipMode = resolvePairModalUrls({
      pair: pairWithHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: true,
    });
    assert.equal(ipMode.effectiveIpMode, true);
    assert.equal(ipMode.activePairUrl, "https://100.64.0.10:4180/pair?code=111222");
    assert.equal(ipMode.activeQrSvg, "<svg id='ip-qr'/>");
  });
});

describe("idea-384: rendered dialog links installer/APK over https only and shows each SHA-256", () => {
  test("LAN path: no http:// installer/APK href or text; installer + APK SHA-256 rows in the CA-fingerprint pattern", () => {
    const html = renderModal(
      basePair({
        lanDesktopInstallerUrl: "https://192.0.2.10:4180/VibeSquad-setup.exe",
        lanAndroidApkUrl: "https://192.0.2.10:4180/VibeSquad.apk",
        desktopInstallerSha256: { full: "AB".repeat(32), short: "AB".repeat(8) },
        androidApkSha256: { full: "CD".repeat(32), short: "CD".repeat(8) },
      }),
    );
    assert.doesNotMatch(html, /http:\/\/[^"<\s]*(VibeSquad-setup\.exe|VibeSquad\.apk)/i);
    assert.match(html, /href="https:\/\/192\.0\.2\.10:4180\/VibeSquad-setup\.exe"/);
    assert.match(html, /href="https:\/\/192\.0\.2\.10:4180\/VibeSquad\.apk"/);
    assert.match(html, /data-testid="desktop-installer-sha256"[^>]*>.*?ABABABABABABABAB/s);
    assert.match(html, /data-testid="android-apk-sha256"[^>]*>.*?CDCDCDCDCDCDCDCD/s);
    assert.doesNotMatch(html, /Direct HTTP link/);
  });

  test("an old server's http:// links (and the synthesized fallbacks) still render as https", () => {
    const html = renderModal(basePair({ lanDesktopInstallerUrl: "http://192.0.2.10:4180/VibeSquad-setup.exe" }));
    assert.doesNotMatch(html, /http:\/\/[^"<\s]*(VibeSquad-setup\.exe|VibeSquad\.apk)/i);
    assert.match(html, /data-testid="desktop-installer-sha256"[^>]*>.*?not available yet/s);
    for (const networkMode of ["lan", "meshnet"]) {
      const u = resolvePairModalUrls({ pair: null, meta: { lanIp: "192.0.2.20", meshnetIp: "100.64.0.20", port: 4180, androidApkAvailable: true }, networkMode, useIpMode: false });
      assert.match(u.setupUrl, /^https:\/\//, networkMode);
      assert.match(u.apkUrl, /^https:\/\//, networkMode);
    }
  });
});

describe("U: owner-playtest role in the inline modal copies", () => {
  test("formatDeviceRoleBadge: PLAYTEST for owner-playtest; owner and bug-tester unchanged", () => {
    assert.equal(formatDeviceRoleBadge({ role: "owner-playtest", allowedTeams: null }), "PLAYTEST");
    assert.equal(formatDeviceRoleBadge({ role: "owner" }), null);
    assert.equal(formatDeviceRoleBadge({ role: "bug-tester", allowedTeams: ["efi", "ade"] }), "TESTER · efi, ade");
    assert.equal(formatDeviceRoleBadge({ role: "bug-tester", allowedTeams: [] }), "TESTER");
  });

  test("pairStartInit bodies: owner-playtest {role, allowedTeams:null}; owner and bug-tester unchanged", () => {
    const body = (r, t = []) => JSON.parse(pairStartInit(r, t).body);
    assert.deepEqual(body("owner-playtest", ["efi"]), { role: "owner-playtest", allowedTeams: null });
    assert.deepEqual(body("owner", ["efi"]), { role: "owner" });
    assert.deepEqual(body("bug-tester", ["efi"]), { role: "bug-tester", allowedTeams: ["efi"] });
    assert.equal(pairStartInit("owner-playtest", []).method, "POST");
  });

  test("rendered dialog has the Playtest (Godot addon) role button alongside owner and tester", () => {
    const html = renderModal(basePair());
    assert.match(html, /<button[^>]*data-testid="pair-role-playtest"[^>]*>Playtest \(Godot addon\)<\/button>/);
    assert.match(html, /data-testid="pair-role-owner"[^>]*>Owner \(full access\)</);
    assert.match(html, /data-testid="pair-role-tester"[^>]*>Alpha Tester/);
  });
});
