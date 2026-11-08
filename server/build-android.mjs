import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveSecret } from "./secrets.mjs";

const KS_SECRET = { envVar: "VS_KS_PASS", target: "vibesquad/android-keystore", required: true };

const DEFAULT_ANDROID_HOME = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Android", "Sdk");

/** Standard Adoptium JDK / Android Studio JBR home, resolved only when JAVA_HOME isn't set. */
function resolveJavaHome(env = process.env) {
  if (env.JAVA_HOME) return env.JAVA_HOME;
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  const candidates = [];
  const adoptium = join(pf, "Eclipse Adoptium");
  if (existsSync(adoptium)) {
    try {
      const jdks = readdirSync(adoptium).filter((d) => /^jdk-/.test(d)).sort().reverse();
      if (jdks[0]) candidates.push(join(adoptium, jdks[0]));
    } catch {}
  }
  candidates.push(join(pf, "Android", "Android Studio", "jbr"));
  return candidates.find((c) => existsSync(join(c, "bin"))) || "";
}

/**
 * Resolves the Android toolchain environment (SDK / NDK / JDK) and extends PATH so
 * `tauri android build` can find cargo, adb, and java.
 */
export function resolveAndroidEnv(env = process.env) {
  const ANDROID_HOME = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || DEFAULT_ANDROID_HOME;
  let NDK_HOME = env.NDK_HOME || env.ANDROID_NDK_HOME || "";
  if (!NDK_HOME) {
    const ndkDir = join(ANDROID_HOME, "ndk");
    if (existsSync(ndkDir)) {
      try {
        const versions = readdirSync(ndkDir).filter((d) => !d.startsWith(".")).sort();
        if (versions.length) NDK_HOME = join(ndkDir, versions[versions.length - 1]);
      } catch {}
    }
  }
  const JAVA_HOME = resolveJavaHome(env);
  const cargoBin = join(homedir(), ".cargo", "bin");
  const platformTools = join(ANDROID_HOME, "platform-tools");
  const javaBin = JAVA_HOME ? join(JAVA_HOME, "bin") : "";
  const PATH = [env.PATH, cargoBin, platformTools, javaBin].filter(Boolean).join(delimiter);
  return {
    ...env,
    ANDROID_HOME,
    ANDROID_SDK_ROOT: ANDROID_HOME,
    NDK_HOME,
    ANDROID_NDK_HOME: NDK_HOME,
    ...(JAVA_HOME ? { JAVA_HOME } : {}),
    PATH,
  };
}

const ANDROID_DEEP_LINK_FILTER = [
  "            <intent-filter>",
  '                <action android:name="android.intent.action.VIEW" />',
  '                <category android:name="android.intent.category.DEFAULT" />',
  '                <category android:name="android.intent.category.BROWSABLE" />',
  '                <data android:scheme="vibesquad" android:host="pair" />',
  "            </intent-filter>",
].join("\n");

/**
 * Registers the `vibesquad://pair` deep link in a generated AndroidManifest.xml.
 * Idempotent: returns false when the manifest already has the scheme or is missing.
 */
export function ensureAndroidDeepLinkIntentFilter(manifestPath) {
  if (!existsSync(manifestPath)) return false;
  const src = readFileSync(manifestPath, "utf8");
  if (src.includes('android:scheme="vibesquad"')) return false;
  const idx = src.indexOf("</activity>");
  if (idx === -1) return false;
  const out = src.slice(0, idx) + ANDROID_DEEP_LINK_FILTER + "\n" + src.slice(idx);
  writeFileSync(manifestPath, out, "utf8");
  return true;
}

/**
 * Declares the camera permission the QR scanner (getUserMedia) needs; the WebView's permission prompt is handled by
 * Tauri's own chrome client once the app holds it. Without it the scanner fails and manual entry is the fallback.
 * Idempotent: returns false when already declared or the manifest is missing.
 */
export function ensureAndroidCameraPermission(manifestPath) {
  if (!existsSync(manifestPath)) return false;
  const src = readFileSync(manifestPath, "utf8");
  if (src.includes("android.permission.CAMERA")) return false;
  const idx = src.indexOf("<application");
  if (idx === -1) return false;
  const decl = [
    '    <uses-permission android:name="android.permission.CAMERA" />',
    '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
    '',
    '    ',
  ].join("\n");
  writeFileSync(manifestPath, src.slice(0, idx) + decl + src.slice(idx), "utf8");
  return true;
}

/**
 * Removes edge-to-edge rendering from a generated MainActivity.kt so Android fits the
 * WebView inside the system status/navigation bars natively (no overlap with the clock/battery).
 * Idempotent: returns false when the file already lacks enableEdgeToEdge or is missing.
 */
export function ensureAndroidSystemBarFit(mainActivityPath) {
  if (!existsSync(mainActivityPath)) return false;
  const src = readFileSync(mainActivityPath, "utf8");
  if (!src.includes("enableEdgeToEdge")) return false;
  const out = src
    .replace(/[ \t]*import\s+androidx\.activity\.enableEdgeToEdge[^\r\n]*\r?\n/g, "")
    .replace(/[ \t]*enableEdgeToEdge\(\)[^\r\n]*\r?\n/g, "");
  if (out === src) return false;
  writeFileSync(mainActivityPath, out, "utf8");
  return true;
}

/** Where `scripts/rotate-android-keystore.mjs` creates the release keystore (outside the repo). */
export const SIGNING_DIR = join(homedir(), ".vibesquad", "signing");
export const DEFAULT_KEYSTORE_PATH = join(SIGNING_DIR, "vibesquad-android.jks");
export const ANDROID_KEY_ALIAS = "vibesquad";
export { KS_SECRET };

/**
 * Cert pin: public data (a SHA-256 fingerprint), committed to the repo like the updater pubkey so
 * a pin change is a reviewed diff and can't be reset silently on one machine. Missing pin = build
 * FAILS unless `pinFirst` (--pin-first) is given, which writes it and asks you to commit it.
 * VS_ANDROID_CERT_PIN_FILE or `pinPath` overrides the location (tests).
 */
export const DEFAULT_PIN_PATH = resolve(import.meta.dirname, "..", "src-tauri", "android-cert.sha256");

/**
 * Resolves the release keystore + signing env. Never creates a keystore: a missing one is a
 * hard error pointing at the rotate script (the password comes from env/Credential Manager only).
 */
export function ensureAndroidKeystore({
  keystorePath = DEFAULT_KEYSTORE_PATH,
  alias = ANDROID_KEY_ALIAS,
  env = process.env,
  resolve: resolveKsSecret = resolveSecret,
} = {}) {
  if (!existsSync(keystorePath)) {
    throw new Error(`Android keystore not found at ${keystorePath}: run node scripts/rotate-android-keystore.mjs`);
  }
  const storePass = resolveKsSecret(KS_SECRET, { env });
  const secretEnv = { ...env, VS_KS_PASS: storePass };
  return { keystorePath, secretEnv, alias };
}

/**
 * Extracts the signer SHA-256 from `apksigner verify --print-certs` output, as lowercase hex.
 * Fails closed (null) unless there is exactly one signer digest and it is 64 hex chars.
 */
export function parseSignerSha256(text) {
  const all = [...String(text || "").matchAll(/certificate SHA-256 digest:[ \t]*([^\r\n]*)/g)];
  if (all.length !== 1) return null;
  const hex = all[0][1].trim().replace(/:/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Compares the signer fingerprint to the committed pin. A mismatch or malformed pin throws; a
 * missing pin throws unless `pinFirst`, which writes it and tells the caller to commit it.
 */
export function checkCertPin(fingerprint, { pinPath = process.env.VS_ANDROID_CERT_PIN_FILE || DEFAULT_PIN_PATH, pinFirst = false, log = console.log } = {}) {
  if (!existsSync(pinPath)) {
    if (!pinFirst) {
      throw new Error(`No Android cert pin at ${pinPath}. First release: re-run with --pin-first to pin signer SHA-256 ${fingerprint}, then commit the file.`);
    }
    mkdirSync(dirname(pinPath), { recursive: true });
    writeFileSync(pinPath, fingerprint + "\n", "utf8");
    log(`[build:android] Pinned signer SHA-256 ${fingerprint}: commit ${pinPath}`);
    return { pinned: true, created: true };
  }
  const expected = readFileSync(pinPath, "utf8").trim().replace(/:/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Android cert pin ${pinPath} is malformed (want one 64-hex SHA-256 line)`);
  if (expected !== fingerprint) {
    throw new Error(`Android signing cert mismatch: pinned ${expected} (${pinPath}) but the APK is signed by ${fingerprint}`);
  }
  log(`[build:android] Signer cert SHA-256 matches pin (${fingerprint}).`);
  return { pinned: true, created: false };
}

/** `apksigner verify --print-certs` (no keystore password in its env) + pin check. Returns the signer SHA-256. */
export function verifyApkCert({ javaExe, apksignerJar, apk, cwd, env = process.env, exec = execFileSync, pinPath, pinFirst, log = console.log }) {
  const { VS_KS_PASS: _omit, ...plainEnv } = env;
  const out = exec(javaExe, ["-jar", apksignerJar, "verify", "--print-certs", apk], { cwd, env: plainEnv, encoding: "utf8" });
  if (out) log(String(out).trimEnd());
  const certSha256 = parseSignerSha256(out);
  if (!certSha256) throw new Error("Could not read exactly one valid signer certificate SHA-256 from apksigner verify --print-certs output");
  checkCertPin(certSha256, { pinPath, pinFirst, log });
  return { certSha256 };
}

/** Signs with apksigner (password via env only), then verifies and pins. Returns the signer SHA-256. */
export function signAndVerifyApk({ javaExe, apksignerJar, keystorePath, alias, secretEnv, inputApk, outApk, cwd, exec = execFileSync, pinPath, pinFirst, log = console.log }) {
  exec(
    javaExe,
    ["-jar", apksignerJar, "sign", "--ks", keystorePath, "--ks-key-alias", alias, "--ks-pass", "env:VS_KS_PASS", "--key-pass", "env:VS_KS_PASS", "--out", outApk, inputApk],
    { cwd, env: secretEnv, stdio: "inherit" },
  );
  return verifyApkCert({ javaExe, apksignerJar, apk: outApk, cwd, env: secretEnv, exec, pinPath, pinFirst, log });
}

function findApk(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".apk"));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}

function latestBuildTools(androidHome) {
  const buildToolsDir = join(androidHome, "build-tools");
  if (!existsSync(buildToolsDir)) return "";
  try {
    const versions = readdirSync(buildToolsDir).filter((d) => !d.startsWith(".")).sort();
    return versions[versions.length - 1] || "";
  } catch {
    return "";
  }
}

/**
 * Builds the Android APK: remote frontend → `tauri android init` (if needed) → deep-link intent-filter
 * → `tauri android build --apk` → sign (if unsigned) → copy to `dist-desktop/VibeSquad.apk`.
 */
export function buildAndroidApk({
  rootDir = resolve(import.meta.dirname, ".."),
  env = process.env,
  exec = execFileSync,
  pinFirst = false,
  debug = false,
  unsigned = false,
} = {}) {
  if (debug && unsigned) throw new Error("--debug and --unsigned cannot be combined");
  const require = createRequire(import.meta.url);
  const tauriCliJs = require.resolve("@tauri-apps/cli/tauri.js");
  const androidEnv = resolveAndroidEnv(env);
  const run = (cmd, args, opts = {}) => exec(cmd, args, { cwd: rootDir, env: androidEnv, stdio: "inherit", ...opts });
  const runNode = (args, opts = {}) => exec(process.execPath, args, { cwd: rootDir, env: androidEnv, stdio: "inherit", ...opts });

  // Step 1: lean remote frontend bundle (VITE_VS_REMOTE=1).
  console.log("[build:android] 1/6 Building remote frontend (npm run build:remote)...");
  run(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build:remote"] : ["run", "build:remote"]);

  // Step 2: initialize the Android project if it doesn't exist yet.
  const genAndroidDir = join(rootDir, "src-tauri", "gen", "android");
  if (!existsSync(genAndroidDir)) {
    console.log("[build:android] 2/6 Initializing Android project (tauri android init)...");
    runNode([tauriCliJs, "android", "init", "--ci", "--config", "src-tauri/tauri.android.conf.json"]);
  } else {
    console.log("[build:android] 2/6 Android project already initialized.");
  }

  // Step 3: register the vibesquad://pair deep link and fit the WebView inside the system bars.
  const manifest = join(rootDir, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  ensureAndroidDeepLinkIntentFilter(manifest);
  ensureAndroidCameraPermission(manifest);
  ensureAndroidSystemBarFit(join(rootDir, "src-tauri", "gen", "android", "app", "src", "main", "java", "com", "vibesquad", "desktop", "MainActivity.kt"));

  // Step 4: build the release APK.
  console.log(`[build:android] 3/6 Building ${debug ? "debug" : "release"} APK (tauri android build --apk${debug ? " --debug" : ""})...`);
  const builtSo = join(rootDir, "src-tauri", "target", "aarch64-linux-android", debug ? "debug" : "release", "libvibesquad_desktop_lib.so");
  try {
    runNode([tauriCliJs, "android", "build", "--apk", "--target", "aarch64", "--ci", "--config", "src-tauri/tauri.android.conf.json", ...(debug ? ["--debug"] : [])]);
  } catch (err) {
    if (process.platform !== "win32" || !existsSync(builtSo)) throw err;
    console.log(`[build:android] Windows symlink fallback: copying libvibesquad_desktop_lib.so into jniLibs/arm64-v8a and running Gradle (${debug ? "debug" : "release"})...`);
    const jniDir = join(genAndroidDir, "app", "src", "main", "jniLibs", "arm64-v8a");
    mkdirSync(jniDir, { recursive: true });
    copyFileSync(builtSo, join(jniDir, "libvibesquad_desktop_lib.so"));
    const task = debug ? "assembleArm64Debug -x rustBuildArm64Debug" : "assembleArm64Release -x rustBuildArm64Release";
    run("cmd.exe", ["/d", "/s", "/c", `.\\gradlew.bat ${task}`], { cwd: genAndroidDir });
  }

  // Step 5: locate the built APK (prefer universal, then aarch64).
  console.log("[build:android] 4/6 Locating built APK...");
  const apkOutDir = join(rootDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  const apk = debug
    ? findApk(join(apkOutDir, "universal", "debug")) || findApk(join(apkOutDir, "arm64", "debug")) || findApk(join(apkOutDir, "aarch64", "debug"))
    : findApk(join(apkOutDir, "universal", "release")) || findApk(join(apkOutDir, "arm64", "release")) || findApk(join(apkOutDir, "aarch64", "release"));
  if (!apk) throw new Error(`No built APK found under ${apkOutDir}`);

  // Step 6: sign (if unsigned) and stage into dist-desktop/VibeSquad.apk.
  const distDesktopDir = join(rootDir, "dist-desktop");
  mkdirSync(distDesktopDir, { recursive: true });
  const destApk = join(distDesktopDir, "VibeSquad.apk");
  const latest = latestBuildTools(androidEnv.ANDROID_HOME);
  if (!latest) throw new Error(`Android build-tools not found under ${join(androidEnv.ANDROID_HOME, "build-tools")}`);
  const javaExe = androidEnv.JAVA_HOME
    ? join(androidEnv.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const apksignerJar = join(androidEnv.ANDROID_HOME, "build-tools", latest, "lib", "apksigner.jar");
  let certSha256;
  if (debug || unsigned) {
    // Sideload test builds: Gradle debug-signed (--debug) or raw unsigned (--unsigned, install needs apksigner). No release pin/keystore; never publishable.
    console.log(`[build:android] 5/6 ${debug ? "Debug build (Gradle debug keystore)" : "Unsigned build"}: skipping release signing and cert pin.`);
    copyFileSync(apk, destApk);
  } else if (apk.endsWith("-unsigned.apk")) {
    console.log("[build:android] 5/6 Signing APK...");
    const { keystorePath, secretEnv, alias } = ensureAndroidKeystore({ env: androidEnv });
    ({ certSha256 } = signAndVerifyApk({ javaExe, apksignerJar, keystorePath, alias, secretEnv, inputApk: apk, outApk: destApk, cwd: rootDir, exec, pinFirst }));
  } else {
    // Already signed (e.g. by Gradle): still must verify and match the pin before it ships.
    console.log("[build:android] 5/6 Verifying pre-signed APK...");
    copyFileSync(apk, destApk);
    ({ certSha256 } = verifyApkCert({ javaExe, apksignerJar, apk: destApk, cwd: rootDir, env: androidEnv, exec, pinFirst }));
  }
  console.log(`[build:android] 6/6 Staged ${destApk}`);
  return { apkPath: destApk, certSha256 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  buildAndroidApk({ pinFirst: process.argv.includes("--pin-first"), debug: process.argv.includes("--debug"), unsigned: process.argv.includes("--unsigned") });
}
