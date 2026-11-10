// Block A3 (PLAN_ANDROID_APP.md): APK build script, LAN /VibeSquad.apk route & release upload.
// - server/build-android.mjs: resolveAndroidEnv + ensureAndroidDeepLinkIntentFilter (pure logic)
// - server/vibesquad-api.mjs: resolveAndroidApkPath + handleAndroidApk + middleware route
// - wiring: server/serve.mjs, server/auth.mjs, server/release.mjs, package.json
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createVibesquadMiddleware, handleAndroidApk, resolveAndroidApkPath } from "../server/vibesquad-api.mjs";
import { syncRuntimeDir } from "../server/sync-runtime.mjs";
import { isAndroidApkBuilt } from "../server/auth.mjs";
import { buildAndroidApk, writeApkSidecar, signSideloadApk, ensureAndroidDeepLinkIntentFilter, ensureAndroidSystemBarFit, resolveAndroidEnv } from "../server/build-android.mjs";
import { buildLatestJson, syncVersionFiles } from "../server/release.mjs";
import { checkGithubAndroidRelease, parseGithubReleaseVersion } from "../src/userName.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const APK_BYTES = Buffer.from("PK\x03\x04vibesquad-apk-body");

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "vs-android-route-"));
}

function writeApk(root) {
  const dir = join(root, "dist-desktop");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "VibeSquad.apk");
  writeFileSync(file, APK_BYTES);
  return file;
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

describe("handleAndroidApk", () => {
  test("returns 404 when dist-desktop/VibeSquad.apk is missing", async () => {
    const root = tmpRoot();
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`);
      assert.equal(r.status, 404);
      const body = await r.json();
      assert.equal(body.error, "Android APK not built yet (run npm run build:android)");
    });
  });

  test("returns 200 with APK content-type, disposition, and exact body bytes", async () => {
    const root = tmpRoot();
    writeApk(root);
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "application/vnd.android.package-archive");
      assert.equal(r.headers.get("content-disposition"), 'attachment; filename="VibeSquad.apk"');
      assert.equal(r.headers.get("content-length"), String(APK_BYTES.length));
      assert.equal(r.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
      const buf = Buffer.from(await r.arrayBuffer());
      assert.deepEqual(buf, APK_BYTES);
    });
  });

  test("returns 200 with empty body on HEAD", async () => {
    const root = tmpRoot();
    writeApk(root);
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`, { method: "HEAD" });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-length"), String(APK_BYTES.length));
      assert.equal(await r.text(), "");
    });
  });

  test("returns 405 on POST", async () => {
    const root = tmpRoot();
    writeApk(root);
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`, { method: "POST" });
      assert.equal(r.status, 405);
    });
  });
});

describe("createVibesquadMiddleware APK route", () => {
  test("returns 404 when dist-desktop/VibeSquad.apk is missing", async () => {
    const root = tmpRoot();
    const mw = createVibesquadMiddleware(root);
    await withServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`);
      assert.equal(r.status, 404);
    });
  });

  test("serves the APK at /VibeSquad.apk and /__vibesquad/android/VibeSquad.apk", async () => {
    const root = tmpRoot();
    writeApk(root);
    const mw = createVibesquadMiddleware(root);
    await withServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }), async (base) => {
      for (const path of ["/VibeSquad.apk", "/__vibesquad/android/VibeSquad.apk"]) {
        const r = await fetch(`${base}${path}`);
        assert.equal(r.status, 200, path);
        assert.equal(r.headers.get("content-type"), "application/vnd.android.package-archive");
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), APK_BYTES);
      }
    });
  });
});

describe("ensureAndroidDeepLinkIntentFilter", () => {
  test("injects the vibesquad scheme + host and is idempotent", () => {
    const root = tmpRoot();
    const manifest = join(root, "AndroidManifest.xml");
    writeFileSync(manifest, '<manifest>\n<application>\n<activity android:name=".MainActivity">\n</activity>\n</application>\n</manifest>\n');

    assert.equal(ensureAndroidDeepLinkIntentFilter(manifest), true);
    const once = readFileSync(manifest, "utf8");
    assert.match(once, /android:scheme="vibesquad"/);
    assert.match(once, /android:host="pair"/);
    assert.match(once, /android.intent.action.VIEW/);

    // Idempotent: no second write.
    assert.equal(ensureAndroidDeepLinkIntentFilter(manifest), false);
    assert.equal(readFileSync(manifest, "utf8"), once);
  });

  test("returns false when the manifest does not exist", () => {
    assert.equal(ensureAndroidDeepLinkIntentFilter(join(tmpRoot(), "missing.xml")), false);
  });
});

describe("ensureAndroidSystemBarFit", () => {
  const MAIN_ACTIVITY_KT = `package com.vibesquad.desktop

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;

  test("strips the edge-to-edge import and call from a realistic MainActivity.kt", () => {
    const root = tmpRoot();
    const kt = join(root, "MainActivity.kt");
    writeFileSync(kt, MAIN_ACTIVITY_KT);

    assert.equal(ensureAndroidSystemBarFit(kt), true);
    const once = readFileSync(kt, "utf8");
    assert.doesNotMatch(once, /import\s+androidx\.activity\.enableEdgeToEdge/);
    assert.doesNotMatch(once, /enableEdgeToEdge\(\)/);
    assert.match(once, /class MainActivity : TauriActivity\(\)/);
    assert.match(once, /super\.onCreate\(savedInstanceState\)/);
  });

  test("is idempotent (second call returns false and leaves the file unchanged)", () => {
    const root = tmpRoot();
    const kt = join(root, "MainActivity.kt");
    writeFileSync(kt, MAIN_ACTIVITY_KT);

    assert.equal(ensureAndroidSystemBarFit(kt), true);
    const once = readFileSync(kt, "utf8");
    assert.equal(ensureAndroidSystemBarFit(kt), false);
    assert.equal(readFileSync(kt, "utf8"), once);
  });

  test("returns false when the file does not exist", () => {
    assert.equal(ensureAndroidSystemBarFit(join(tmpRoot(), "missing.kt")), false);
  });
});

describe("resolveAndroidEnv", () => {
  test("sets ANDROID_HOME and NDK_HOME (and their SDK_ROOT aliases)", () => {
    const env = resolveAndroidEnv({ ANDROID_HOME: "/opt/android-sdk", NDK_HOME: "/opt/android-ndk" });
    assert.equal(env.ANDROID_HOME, "/opt/android-sdk");
    assert.equal(env.ANDROID_SDK_ROOT, "/opt/android-sdk");
    assert.equal(env.NDK_HOME, "/opt/android-ndk");
    assert.equal(env.ANDROID_NDK_HOME, "/opt/android-ndk");
  });

  test("discovers the highest sorted NDK version under ANDROID_HOME/ndk", () => {
    const sdk = tmpRoot();
    mkdirSync(join(sdk, "ndk", "25.2.9519653"), { recursive: true });
    mkdirSync(join(sdk, "ndk", "26.0.10792818"), { recursive: true });
    const env = resolveAndroidEnv({ ANDROID_HOME: sdk });
    assert.equal(env.NDK_HOME, join(sdk, "ndk", "26.0.10792818"));
    assert.equal(env.ANDROID_NDK_HOME, env.NDK_HOME);
  });

  test("keeps JAVA_HOME and extends PATH with cargo, platform-tools, and java bin", () => {
    const sdk = tmpRoot();
    const env = resolveAndroidEnv({ ANDROID_HOME: sdk, JAVA_HOME: "/opt/jdk" });
    assert.equal(env.JAVA_HOME, "/opt/jdk");
    assert.ok(env.PATH.includes(join(sdk, "platform-tools")), "PATH includes platform-tools");
    assert.ok(env.PATH.includes(join("/opt/jdk", "bin")), "PATH includes java bin");
  });
});

describe("wiring (source inspection)", () => {
  test("server/serve.mjs serves /VibeSquad.apk with the APK MIME type", () => {
    const src = read("server/serve.mjs");
    assert.match(src, /handleAndroidApk/);
    assert.match(src, /import \{[^}]*handleAndroidApk[^}]*\} from "\.\/vibesquad-api\.mjs"/s);
    assert.match(src, /"\.apk": "application\/vnd\.android\.package-archive"/);
    assert.match(src, /isAndroidApkPath\(path\)/);
  });

  test("server/auth.mjs exposes lanAndroidApkUrl / androidApkHttpUrl / androidApkAvailable", () => {
    const src = read("server/auth.mjs");
    assert.match(src, /function isAndroidApkBuilt/);
    assert.match(src, /lanAndroidApkUrl/);
    assert.match(src, /androidApkHttpUrl/);
    assert.match(src, /androidApkAvailable/);
  });

  test("server/release.mjs supports --with-android and uploads the APK asset", () => {
    const src = read("server/release.mjs");
    assert.match(src, /--with-android/);
    assert.match(src, /out\.withAndroid = true/);
    assert.match(src, /build-android\.mjs/);
    assert.match(src, /selectApk/);
    assert.match(src, /"VibeSquad\.apk"/);
  });

  function stageApkRoot(name) {
    const root = mkdtempSync(join(tmpdir(), "vs-apk-"));
    const sdk = join(root, "sdk");
    mkdirSync(join(sdk, "build-tools", "1.0.0"), { recursive: true });
    const apkDir = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, name), "apk-bytes");
    mkdirSync(join(root, "dist-desktop"), { recursive: true });
    writeFileSync(join(root, "dist-desktop", "android-build.json"), "{}");
    return { root, sdk };
  }
  const quiet = (fn) => {
    const origLog = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = origLog; }
  };
  const SIGNER = "certificate SHA-256 digest: " + "ab".repeat(32);

  test("buildAndroidApk: --debug/--sideload conflict with --unsigned; --unsigned stages raw and drops android-build.json", () => {
    assert.throws(() => buildAndroidApk({ debug: true, unsigned: true }), /cannot be combined/);
    assert.throws(() => buildAndroidApk({ sideload: true, unsigned: true }), /cannot be combined/);
    const { root, sdk } = stageApkRoot("app-universal-test.apk");
    const calls = [];
    quiet(() => buildAndroidApk({ rootDir: root, env: { ...process.env, ANDROID_HOME: sdk }, exec: (cmd, args) => { calls.push([cmd, ...args]); }, unsigned: true }));
    assert.equal(readFileSync(join(root, "dist-desktop", "VibeSquad.apk"), "utf8"), "apk-bytes");
    assert.equal(existsSync(join(root, "dist-desktop", "android-build.json")), false);
    assert.equal(calls.some((c) => c.includes("sign") || c.includes("verify")), false);
  });

  test("buildAndroidApk: --debug/--sideload builds the release variant (no --debug) and signs with the Android debug keystore via apksigner", () => {
    for (const flag of ["debug", "sideload"]) {
      const { root, sdk } = stageApkRoot("app-universal-release-unsigned.apk");
      const home = mkdtempSync(join(tmpdir(), "vs-home-"));
      mkdirSync(join(home, ".android"), { recursive: true });
      writeFileSync(join(home, ".android", "debug.keystore"), "ks");
      const calls = [];
      const exec = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes("verify")) return SIGNER;
        if (args.includes("sign")) writeFileSync(args[args.indexOf("--out") + 1], "signed");
      };
      const out = quiet(() => buildAndroidApk({ rootDir: root, env: { ...process.env, ANDROID_HOME: sdk }, exec, [flag]: true, debugKeystorePath: join(home, ".android", "debug.keystore") }));
      assert.equal(out.certSha256, "ab".repeat(32));
      const tauri = calls.find((c) => c.includes("android") && c.includes("build"));
      assert.ok(tauri && !tauri.includes("--debug"), "sideload must build the compact release variant");
      const sign = calls.find((c) => c.includes("sign"));
      assert.ok(sign.includes(join(home, ".android", "debug.keystore")));
      assert.equal(sign[sign.indexOf("--ks-key-alias") + 1], "androiddebugkey");
      assert.equal(sign[sign.indexOf("--ks-pass") + 1], "env:VS_DEBUG_KS_PASS");
      assert.equal(sign[sign.indexOf("--key-pass") + 1], "env:VS_DEBUG_KS_PASS");
      assert.equal(calls.some((c) => c.includes("keytool") || c.some((a) => /keytool/.test(String(a)))), false);
      assert.equal(readFileSync(join(root, "dist-desktop", "VibeSquad.apk"), "utf8"), "signed");
      assert.equal(existsSync(join(root, "dist-desktop", "android-build.json")), false);
    }
  });

  test("signSideloadApk: missing ~/.android/debug.keystore is a clear error and never creates one", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "vs-nks-")), "debug.keystore");
    const calls = [];
    assert.throws(() => signSideloadApk({ javaExe: "java", apksignerJar: "a.jar", inputApk: "in.apk", outApk: "out.apk", exec: (...a) => calls.push(a), keystorePath: missing }), /debug keystore not found.*Gradle/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(missing), false);
  });

  test("buildAndroidApk: release path (no flag) still signs with the release keystore + pin, not the debug keystore", () => {
    const src = read("server/build-android.mjs");
    assert.match(src, /ensureAndroidKeystore\(\{ env: androidEnv \}\)/);
    assert.match(src, /signAndVerifyApk\(\{ javaExe, apksignerJar, keystorePath, alias, secretEnv/);
    assert.doesNotMatch(src, /keytool/);
    const body = src.slice(src.indexOf("} else if (apk.endsWith"));
    assert.doesNotMatch(body.slice(0, body.indexOf("6/6")), /signSideloadApk|DEBUG_KEYSTORE/);
  });

  test("server/build-android.mjs builds aarch64 without --apk=true, uses arm64 flavor, Windows jniLibs fallback, and apksigner.jar", () => {
    const src = read("server/build-android.mjs");
    assert.match(src, /"--apk", "--target", "aarch64"/);
    assert.doesNotMatch(src, /"--apk", "true"/);
    assert.match(src, /findBuiltApk(rootDir)/);
    assert.match(src, /findBuiltApk(rootDir)/);
    assert.match(src, /jniLibs/);
    assert.match(src, /arm64-v8a/);
    assert.match(src, /assembleArm64Release/);
    assert.match(src, /gradlew\.bat/);
    assert.match(src, /apksigner\.jar/);
    assert.match(src, /"-jar", apksignerJar/);
  });

  test("package.json wires npm run build:android", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.scripts["build:android"], "node server/build-android.mjs");
  });

  test("vite.config.ts defines __VS_APP_VERSION__ from package.json", () => {
    const src = read("vite.config.ts");
    assert.match(src, /__VS_APP_VERSION__:\s*JSON\.stringify\(pkg\.version\s*\|\|\s*"0\.2\.0"\)/);
  });

  test("src/DiagnosticsModal.tsx checks isAndroidUserAgent() in checkForUpdates", () => {
    const src = read("src/DiagnosticsModal.tsx");
    assert.match(src, /isAndroidUserAgent/);
    assert.match(src, /if\s*\(isAndroidUserAgent\(\)\)\s*\{\s*await\s+loadUpdaterStatus\(\);\s*return\s+true;\s*\}/);
  });

  test("src/App.tsx allows isAndroidUserAgent() on the update banner with Download Update and download APK?", () => {
    const src = read("src/App.tsx");
    assert.match(src, /!isRemote\(\)\s*\|\|\s*isAndroidUserAgent\(\)/);
    assert.match(src, /download APK\?/);
    assert.match(src, /Download Update/);
  });
});

describe("Block A6: release version sync & Android GitHub Release updater", () => {
  test("syncVersionFiles syncs src-tauri/tauri.android.conf.json alongside package.json, tauri.conf.json, and Cargo.toml", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src-tauri"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vibesquad", version: "0.2.0" }, null, 2));
    writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.2.0" }, null, 2));
    writeFileSync(join(root, "src-tauri", "tauri.android.conf.json"), JSON.stringify({ version: "0.2.0" }, null, 2));
    writeFileSync(join(root, "src-tauri", "Cargo.toml"), '[package]\nname = "vibesquad"\nversion = "0.2.0"\n');

    syncVersionFiles(root, "0.3.1-beta.2");

    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.3.1-beta.2");
    assert.equal(JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version, "0.3.1-beta.2");
    assert.equal(JSON.parse(readFileSync(join(root, "src-tauri", "tauri.android.conf.json"), "utf8")).version, "0.3.1-beta.2");
    assert.match(readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8"), /version = "0\.3\.1-beta\.2"/);
  });

  test("buildLatestJson includes platforms['android-aarch64'].url for stable and beta", () => {
    const stableManifest = buildLatestJson({ version: "0.2.3", channel: "stable", signature: "sig123", repo: "Pizzarar/VibeSquad" });
    assert.equal(
      stableManifest.platforms["android-aarch64"]?.url,
      "https://github.com/Pizzarar/VibeSquad/releases/download/v0.2.3/VibeSquad.apk",
    );

    const betaManifest = buildLatestJson({ version: "0.2.4-beta.1", channel: "beta", signature: "sig456", repo: "Pizzarar/VibeSquad" });
    assert.equal(
      betaManifest.platforms["android-aarch64"]?.url,
      "https://github.com/Pizzarar/VibeSquad/releases/download/beta/VibeSquad.apk",
    );
  });

  test("parseGithubReleaseVersion extracts version and downloadUrl for stable and rolling beta", () => {
    const stableParsed = parseGithubReleaseVersion(
      {
        tag_name: "v0.3.0",
        name: "VibeSquad v0.3.0",
        assets: [{ name: "VibeSquad.apk", browser_download_url: "https://cdn.example.com/v0.3.0/VibeSquad.apk" }],
      },
      "stable",
    );
    assert.equal(stableParsed.version, "0.3.0");
    assert.equal(stableParsed.downloadUrl, "https://cdn.example.com/v0.3.0/VibeSquad.apk");

    const betaParsed = parseGithubReleaseVersion(
      {
        tag_name: "beta",
        name: "VibeSquad Beta (0.3.0-beta.2)",
        assets: [],
      },
      "beta",
    );
    assert.equal(betaParsed.version, "0.3.0-beta.2");
    assert.equal(betaParsed.downloadUrl, "https://github.com/Pizzarar/VibeSquad/releases/download/beta/VibeSquad.apk");
  });

  test("checkGithubAndroidRelease detects updates, no-op when current, and falls back when beta tag 404s", async () => {
    // 1. Stable update available
    const stableRes = await checkGithubAndroidRelease("0.2.2", "stable", async (url) => {
      assert.equal(url, "https://api.github.com/repos/Pizzarar/VibeSquad/releases/latest");
      return {
        ok: true,
        json: async () => ({
          tag_name: "v0.3.0",
          assets: [{ name: "VibeSquad.apk", browser_download_url: "https://github.com/Pizzarar/VibeSquad/releases/download/v0.3.0/VibeSquad.apk" }],
        }),
      };
    });
    assert.deepEqual(stableRes, {
      updateAvailable: true,
      availableVersion: "0.3.0",
      downloadUrl: "https://github.com/Pizzarar/VibeSquad/releases/download/v0.3.0/VibeSquad.apk",
    });

    // 2. Beta update available from rolling beta tag
    const betaRes = await checkGithubAndroidRelease("0.3.0-beta.1", "beta", async (url) => {
      assert.equal(url, "https://api.github.com/repos/Pizzarar/VibeSquad/releases/tags/beta");
      return {
        ok: true,
        json: async () => ({
          tag_name: "beta",
          name: "VibeSquad Beta (0.3.0-beta.2)",
          assets: [],
        }),
      };
    });
    assert.deepEqual(betaRes, {
      updateAvailable: true,
      availableVersion: "0.3.0-beta.2",
      downloadUrl: "https://github.com/Pizzarar/VibeSquad/releases/download/beta/VibeSquad.apk",
    });

    // 3. No update available when already on latest
    const currentRes = await checkGithubAndroidRelease("0.3.0", "stable", async () => ({
      ok: true,
      json: async () => ({ tag_name: "v0.3.0", assets: [] }),
    }));
    assert.deepEqual(currentRes, {
      updateAvailable: false,
      availableVersion: "",
      downloadUrl: "",
    });

    // 4. Beta tag 404 falls back to /releases/latest
    const calls = [];
    const fallbackRes = await checkGithubAndroidRelease("0.2.0", "beta", async (url) => {
      calls.push(url);
      if (String(url).endsWith("/tags/beta")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ tag_name: "v0.2.5", assets: [] }),
      };
    });
    assert.deepEqual(calls, [
      "https://api.github.com/repos/Pizzarar/VibeSquad/releases/tags/beta",
      "https://api.github.com/repos/Pizzarar/VibeSquad/releases/latest",
    ]);
    assert.deepEqual(fallbackRes, {
      updateAvailable: true,
      availableVersion: "0.2.5",
      downloadUrl: "https://github.com/Pizzarar/VibeSquad/releases/download/v0.2.5/VibeSquad.apk",
    });
  });
});

describe("ensureAndroidCameraPermission", () => {
  test("declares CAMERA once and is idempotent", async () => {
    const { ensureAndroidCameraPermission } = await import("../server/build-android.mjs");
    const root = tmpRoot();
    const manifest = join(root, "AndroidManifest.xml");
    writeFileSync(manifest, "<manifest>\n    <application>\n    </application>\n</manifest>\n");
    assert.equal(ensureAndroidCameraPermission(manifest), true);
    const once = readFileSync(manifest, "utf8");
    assert.match(once, /<uses-permission android:name="android.permission.CAMERA" \/>[\s\S]*<application>/);
    assert.equal(ensureAndroidCameraPermission(manifest), false);
    assert.equal(readFileSync(manifest, "utf8"), once);
    assert.equal(ensureAndroidCameraPermission(join(root, "missing.xml")), false);
  });
});

describe("APK route is case-insensitive", () => {
  test("/vibesquad.apk and /__vibesquad/android/vibesquad.apk serve the APK via mux, dev middleware and serve.mjs", async () => {
    const { isAndroidApkPath } = await import("../server/vibesquad-api.mjs");
    for (const p of ["/VibeSquad.apk", "/vibesquad.apk", "/VIBESQUAD.APK", "/__vibesquad/android/VibeSquad.apk", "/__vibesquad/android/vibesquad.apk"]) assert.ok(isAndroidApkPath(p), p);
    for (const p of ["/vibesquad.apk/x", "/x/vibesquad.apk", "/vibesquad.apks", "/__vibesquad/android/../vibesquad.apk"]) assert.ok(!isAndroidApkPath(p), p);
    const root = tmpRoot();
    writeApk(root);
    const mw = createVibesquadMiddleware(root);
    await withServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }), async (base) => {
      for (const p of ["/vibesquad.apk", "/__vibesquad/android/vibesquad.apk"]) {
        const r = await fetch(base + p);
        assert.equal(r.status, 200, p);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), APK_BYTES);
      }
    });
    const serve = read("server/serve.mjs");
    assert.equal((serve.match(/isAndroidApkPath\(path\)/g) ?? []).length, 2, "both mesh handlers use the case-insensitive check");
  });
});

describe("APK sha256 sidecar / runtime sync (B2, B11)", () => {
  const APK_SHA = createHash("sha256").update(APK_BYTES).digest("hex");

  test("handleAndroidApk sends x-vibesquad-apk-sha256 from a fresh sidecar (GET and HEAD)", async () => {
    const root = tmpRoot();
    writeApkSidecar(writeApk(root));
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      for (const method of ["GET", "HEAD"]) {
        const r = await fetch(`${base}/VibeSquad.apk`, { method });
        assert.equal(r.headers.get("x-vibesquad-apk-sha256"), APK_SHA);
      }
    });
  });

  test("no sidecar: header omitted on the request path, then served from a background stream hash", async () => {
    const root = tmpRoot();
    writeApk(root);
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const first = await fetch(`${base}/VibeSquad.apk`, { method: "HEAD" });
      assert.equal(first.headers.get("x-vibesquad-apk-sha256"), null);
      let got = null;
      for (let i = 0; i < 50 && !got; i++) {
        await new Promise((ok) => setTimeout(ok, 20));
        got = (await fetch(`${base}/VibeSquad.apk`, { method: "HEAD" })).headers.get("x-vibesquad-apk-sha256");
      }
      assert.equal(got, APK_SHA);
    });
  });

  test("a sidecar older than the APK is ignored (header never lies about the served bytes)", async () => {
    const root = tmpRoot();
    const file = writeApk(root);
    writeFileSync(`${file}.sha256`, `${"0".repeat(64)}
`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${file}.sha256`, past, past);
    await withServer((req, res) => handleAndroidApk(req, res, root), async (base) => {
      const r = await fetch(`${base}/VibeSquad.apk`, { method: "HEAD" });
      assert.notEqual(r.headers.get("x-vibesquad-apk-sha256"), "0".repeat(64));
    });
  });

  test("resolveAndroidApkPath dev fallback finds arm64 and aarch64 release outputs", () => {
    for (const abi of ["arm64", "aarch64"]) {
      const root = tmpRoot();
      const dir = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", abi, "release");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.apk"), "a");
      assert.equal(resolveAndroidApkPath(root), join(dir, "x.apk"));
    }
  });

  test("writeApkSidecar writes <apk>.sha256 matching the file", () => {
    const root = tmpRoot();
    const file = writeApk(root);
    assert.equal(writeApkSidecar(file), APK_SHA);
    assert.equal(readFileSync(`${file}.sha256`, "utf8").trim(), APK_SHA);
  });

  test("buildAndroidApk stages the sidecar and removes a stale one when staging fails", () => {
    const sidecarCase = (name) => {
      const root = mkdtempSync(join(tmpdir(), "vs-apk-"));
      const sdk = join(root, "sdk");
      mkdirSync(join(sdk, "build-tools", "1.0.0"), { recursive: true });
      if (name) {
        const apkDir = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release");
        mkdirSync(apkDir, { recursive: true });
        writeFileSync(join(apkDir, name), "apk-bytes");
      }
      mkdirSync(join(root, "dist-desktop"), { recursive: true });
      writeFileSync(join(root, "dist-desktop", "VibeSquad.apk.sha256"), "stale");
      return { root, sdk };
    };
    const log = console.log;
    console.log = () => {};
    try {
      const ok = sidecarCase("app-universal-test.apk");
      buildAndroidApk({ rootDir: ok.root, env: { ...process.env, ANDROID_HOME: ok.sdk }, exec: () => {}, unsigned: true });
      assert.equal(readFileSync(join(ok.root, "dist-desktop", "VibeSquad.apk.sha256"), "utf8").trim(), createHash("sha256").update("apk-bytes").digest("hex"));
      const bad = sidecarCase(null);
      assert.throws(() => buildAndroidApk({ rootDir: bad.root, env: { ...process.env, ANDROID_HOME: bad.sdk }, exec: () => {}, unsigned: true }));
    } finally {
      console.log = log;
    }
  });

  test("syncRuntimeDir copies the staged APK + sidecar into runtime/dist-desktop, and tolerates their absence", () => {
    const lad = mkdtempSync(join(tmpdir(), "vs-sync-lad-"));
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = lad;
    const runtime = join(lad, "VibeSquad", "runtime");
    mkdirSync(runtime, { recursive: true });
    try {
      const empty = tmpRoot();
      assert.equal(syncRuntimeDir(empty).synced, true);
      assert.equal(existsSync(join(runtime, "dist-desktop", "VibeSquad.apk")), false);
      const repo = tmpRoot();
      const file = writeApk(repo);
      writeApkSidecar(file);
      syncRuntimeDir(repo);
      assert.deepEqual(readFileSync(join(runtime, "dist-desktop", "VibeSquad.apk")), APK_BYTES);
      assert.equal(readFileSync(join(runtime, "dist-desktop", "VibeSquad.apk.sha256"), "utf8").trim(), APK_SHA);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
    }
  });

  test("syncRuntimeDir does not copy without a sidecar or with a mismatched one, and keeps the live pair", () => {
    const lad = mkdtempSync(join(tmpdir(), "vs-sync-lad-"));
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = lad;
    const live = join(lad, "VibeSquad", "runtime", "dist-desktop");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "VibeSquad.apk"), "live-old");
    try {
      const repo = tmpRoot();
      const file = writeApk(repo);
      syncRuntimeDir(repo); // no sidecar
      assert.equal(readFileSync(join(live, "VibeSquad.apk"), "utf8"), "live-old");
      writeFileSync(`${file}.sha256`, `${"0".repeat(64)}
`); // mismatched
      syncRuntimeDir(repo);
      assert.equal(readFileSync(join(live, "VibeSquad.apk"), "utf8"), "live-old");
      assert.equal(existsSync(join(live, "VibeSquad.apk.sha256")), false);
      writeApkSidecar(file); // now valid
      syncRuntimeDir(repo);
      assert.deepEqual(readFileSync(join(live, "VibeSquad.apk")), APK_BYTES);
      assert.deepEqual(readdirSync(live).sort(), ["VibeSquad.apk", "VibeSquad.apk.sha256"]);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
    }
  });

  test("buildAndroidApk: a failed cert verify leaves no staged apk or sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "vs-apk-"));
    const sdk = join(root, "sdk");
    mkdirSync(join(sdk, "build-tools", "1.0.0"), { recursive: true });
    const apkDir = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "app-signed.apk"), "apk-bytes");
    const log = console.log;
    console.log = () => {};
    try {
      assert.throws(() => buildAndroidApk({ rootDir: root, env: { ...process.env, ANDROID_HOME: sdk }, exec: () => { throw new Error("verify failed"); } }), /verify failed/);
    } finally {
      console.log = log;
    }
    assert.equal(existsSync(join(root, "dist-desktop", "VibeSquad.apk")), false);
    assert.equal(existsSync(join(root, "dist-desktop", "VibeSquad.apk.sha256")), false);
  });

  test("isAndroidApkBuilt agrees with the route lookup; no ../.. fallback", () => {
    const root = tmpRoot();
    assert.equal(isAndroidApkBuilt(root), false);
    const outer = tmpRoot();
    writeApk(outer);
    const nested = join(outer, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveAndroidApkPath(nested), join(nested, "dist-desktop", "VibeSquad.apk"));
    assert.equal(isAndroidApkBuilt(nested), false);
    const fallbackRoot = tmpRoot();
    const apkDir = join(fallbackRoot, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "x.apk"), "a");
    assert.equal(isAndroidApkBuilt(fallbackRoot), true);
  });
});
