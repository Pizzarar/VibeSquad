// Block A2d-2 (PLAN_ANDROID_MESHNET.md): PairDeviceModal Android APK download + empty meshnetHost QR fallback.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import { transformSync } from "rolldown/utils";

const modalPath = resolve(import.meta.dirname, "..", "src", "PairDeviceModal.tsx");
const src = readFileSync(modalPath, "utf8");

// Transpile PairDeviceModal.tsx to a temporary .mjs module (stubbing child UI imports) so we can call resolvePairModalUrls directly.
const dir = mkdtempSync(join(tmpdir(), "vs-pair-modal-apk-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "TeamActions.mjs"), "export function Modal() { return null; }\n");
writeFileSync(join(dir, "ui.mjs"), "export function Ago() { return null; }\n");
const transpiled = transformSync("PairDeviceModal.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace('"react"', JSON.stringify(import.meta.resolve("react")))
  .replace('"./TeamActions"', '"./TeamActions.mjs"')
  .replace('"./ui"', '"./ui.mjs"');
const modFile = join(dir, "PairDeviceModal.mjs");
writeFileSync(modFile, transpiled);
const { resolvePairModalUrls } = await import(pathToFileURL(modFile).href);

describe("PairDeviceModal.tsx APK download markup & gating", () => {
  test("restores the Download VibeSquad.apk (Android) button with data-testid='download-android-apk'", () => {
    assert.match(src, /data-testid="download-android-apk"/);
    assert.match(src, /download="VibeSquad\.apk"/);
    assert.match(src, /⬇ Download VibeSquad\.apk \(Android\)/);
  });

  test("shows the APK download card only when androidApkAvailable is truthy", () => {
    assert.match(src, /\{androidApkAvailable && \(\s*<div className="preview"/);
    assert.match(src, /href=\{apkUrl\}/);
  });

  test("includes the short instruction to install and scan with in-app Scan (not the phone camera), with no Paseo/relay wording", () => {
    assert.match(src, /Install the app, then scan with the in-app Scan \(not the phone camera\)\./);
    assert.doesNotMatch(src, /paseo|relay|#offer=/i);
  });
});

describe("resolvePairModalUrls — LAN & Meshnet APK URLs and availability", () => {
  const samplePair = {
    code: "123456",
    lanIp: "192.168.1.135",
    meshnetHost: "my-pc.nord",
    meshnetIp: "100.83.196.251",
    lanAndroidApkUrl: "http://192.168.1.135:4180/VibeSquad.apk",
    androidApkHttpUrl: "http://100.83.196.251:4180/VibeSquad.apk",
    androidApkAvailable: true,
    lanPairUrl: "https://192.168.1.135:4180/pair?code=123456",
    lanQrSvg: "<svg id='lan'/>",
    pairUrl: "https://my-pc.nord:4180/pair?code=123456",
    pairIpUrl: "https://100.83.196.251:4180/pair?code=123456",
    qrSvg: "<svg id='host'/>",
    qrSvgIp: "<svg id='ip'/>",
  };

  test("selects lanAndroidApkUrl in Home LAN mode and androidApkHttpUrl in Meshnet mode", () => {
    const lan = resolvePairModalUrls({ pair: samplePair, meta: null, networkMode: "lan", useIpMode: false });
    assert.equal(lan.isLan, true);
    assert.equal(lan.androidApkAvailable, true);
    assert.equal(lan.apkUrl, "http://192.168.1.135:4180/VibeSquad.apk");

    const mesh = resolvePairModalUrls({ pair: samplePair, meta: null, networkMode: "meshnet", useIpMode: false });
    assert.equal(mesh.isLan, false);
    assert.equal(mesh.androidApkAvailable, true);
    assert.equal(mesh.apkUrl, "http://100.83.196.251:4180/VibeSquad.apk");
  });

  test("falls back to synthesized http://<ip>:<port>/VibeSquad.apk and meta fields when pair is loading", () => {
    const fromMetaLan = resolvePairModalUrls({
      pair: null,
      meta: { lanIp: "192.168.1.50", meshnetIp: "100.64.1.2", port: 4180, androidApkAvailable: true },
      networkMode: "lan",
      useIpMode: false,
    });
    assert.equal(fromMetaLan.androidApkAvailable, true);
    assert.equal(fromMetaLan.apkUrl, "http://192.168.1.50:4180/VibeSquad.apk");

    const fromMetaMesh = resolvePairModalUrls({
      pair: null,
      meta: { lanIp: null, meshnetIp: "100.64.1.2", port: 4180, androidApkAvailable: false },
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(fromMetaMesh.androidApkAvailable, false);
    assert.equal(fromMetaMesh.apkUrl, "http://100.64.1.2:4180/VibeSquad.apk");
  });
});

describe("resolvePairModalUrls — empty meshnetHost QR & URL fallback", () => {
  test("uses meshnetIp when meshnetHost is empty even with default useIpMode=false", () => {
    const pairEmptyHost = {
      code: "654321",
      lanIp: null,
      meshnetHost: "",
      meshnetIp: "100.83.196.251",
      pairUrl: "https://:4180/pair?code=654321&fp=abcdef0123456789",
      pairIpUrl: "https://100.83.196.251:4180/pair?code=654321&fp=abcdef0123456789",
      qrSvg: "<svg id='broken-empty-host'/>",
      qrSvgIp: "<svg id='scannable-ip-qr'/>",
    };

    const res = resolvePairModalUrls({
      pair: pairEmptyHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });

    assert.equal(res.host, "100.83.196.251");
    assert.equal(res.effectiveIpMode, true);
    assert.equal(res.activePairUrl, "https://100.83.196.251:4180/pair?code=654321&fp=abcdef0123456789");
    assert.doesNotMatch(res.activePairUrl, /^https:\/\/:/);
    assert.equal(res.activeQrSvg, "<svg id='scannable-ip-qr'/>");
  });

  test("repairs https://:<port> in pairUrl even if pairIpUrl is omitted", () => {
    const res = resolvePairModalUrls({
      pair: {
        code: "654321",
        meshnetHost: "",
        meshnetIp: "100.83.196.251",
        pairUrl: "https://:4180/pair?code=654321",
        qrSvg: "<svg id='fallback'/>",
      },
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(res.activePairUrl, "https://100.83.196.251:4180/pair?code=654321");
  });

  test("preserves meshnetHost QR when meshnetHost is set and useIpMode=false, and switches on useIpMode=true", () => {
    const pairWithHost = {
      code: "111222",
      lanIp: null,
      meshnetHost: "pc.nord",
      meshnetIp: "100.83.196.251",
      pairUrl: "https://pc.nord:4180/pair?code=111222",
      pairIpUrl: "https://100.83.196.251:4180/pair?code=111222",
      qrSvg: "<svg id='host-qr'/>",
      qrSvgIp: "<svg id='ip-qr'/>",
    };

    const hostMode = resolvePairModalUrls({
      pair: pairWithHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: false,
    });
    assert.equal(hostMode.host, "pc.nord");
    assert.equal(hostMode.effectiveIpMode, false);
    assert.equal(hostMode.activePairUrl, "https://pc.nord:4180/pair?code=111222");
    assert.equal(hostMode.activeQrSvg, "<svg id='host-qr'/>");

    const ipMode = resolvePairModalUrls({
      pair: pairWithHost,
      meta: null,
      networkMode: "meshnet",
      useIpMode: true,
    });
    assert.equal(ipMode.effectiveIpMode, true);
    assert.equal(ipMode.activePairUrl, "https://100.83.196.251:4180/pair?code=111222");
    assert.equal(ipMode.activeQrSvg, "<svg id='ip-qr'/>");
  });
});
