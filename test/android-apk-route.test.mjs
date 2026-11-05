// Block A3 (PLAN_ANDROID_APP.md): APK build script, LAN /VibeSquad.apk route & release upload.
// - server/build-android.mjs: resolveAndroidEnv + ensureAndroidDeepLinkIntentFilter (pure logic)
// - server/vibesquad-api.mjs: resolveAndroidApkPath + handleAndroidApk + middleware route
// - wiring: server/serve.mjs, server/auth.mjs, server/release.mjs, package.json
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createVibesquadMiddleware, handleAndroidApk } from "../server/vibesquad-api.mjs";
import { ensureAndroidDeepLinkIntentFilter, resolveAndroidEnv } from "../server/build-android.mjs";

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
    assert.match(src, /path === "\/VibeSquad\.apk" \|\| path === "\/__vibesquad\/android\/VibeSquad\.apk"/);
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
    assert.match(src, /const apkPath = join\(distDesktopDir, "VibeSquad\.apk"\)/);
  });

  test("server/build-android.mjs builds aarch64 without --apk=true, uses arm64 flavor, Windows jniLibs fallback, and apksigner.jar", () => {
    const src = read("server/build-android.mjs");
    assert.match(src, /"--apk", "--target", "aarch64"/);
    assert.doesNotMatch(src, /"--apk", "true"/);
    assert.match(src, /"arm64", "release"/);
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
});
