import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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
 * Creates (or reuses) the persistent Android release keystore used to sign the APK.
 */
export function ensureAndroidKeystore({
  keystorePath = join(homedir(), ".tauri", "vibesquad-android.keystore"),
  storePass = "vibesquad-android",
  alias = "vibesquad",
  env = process.env,
  exec = execFileSync,
} = {}) {
  if (!existsSync(keystorePath)) {
    mkdirSync(dirname(keystorePath), { recursive: true });
    const keytool = env.JAVA_HOME
      ? join(env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool")
      : "keytool";
    exec(keytool, [
      "-genkeypair",
      "-v",
      "-keystore",
      keystorePath,
      "-alias",
      alias,
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "10000",
      "-storepass",
      storePass,
      "-keypass",
      storePass,
      "-dname",
      "CN=VibeSquad, O=VibeSquad, C=US",
    ]);
  }
  return { keystorePath, storePass, alias };
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
} = {}) {
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

  // Step 3: register the vibesquad://pair deep link.
  const manifest = join(rootDir, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  ensureAndroidDeepLinkIntentFilter(manifest);

  // Step 4: build the release APK.
  console.log("[build:android] 3/6 Building release APK (tauri android build --apk)...");
  const builtSo = join(rootDir, "src-tauri", "target", "aarch64-linux-android", "release", "libvibesquad_desktop_lib.so");
  try {
    runNode([tauriCliJs, "android", "build", "--apk", "--target", "aarch64", "--ci", "--config", "src-tauri/tauri.android.conf.json"]);
  } catch (err) {
    if (process.platform !== "win32" || !existsSync(builtSo)) throw err;
    console.log("[build:android] Windows symlink fallback: copying libvibesquad_desktop_lib.so into jniLibs/arm64-v8a and running Gradle assembleArm64Release...");
    const jniDir = join(genAndroidDir, "app", "src", "main", "jniLibs", "arm64-v8a");
    mkdirSync(jniDir, { recursive: true });
    copyFileSync(builtSo, join(jniDir, "libvibesquad_desktop_lib.so"));
    run("cmd.exe", ["/d", "/s", "/c", ".\\gradlew.bat assembleArm64Release -x rustBuildArm64Release"], { cwd: genAndroidDir });
  }

  // Step 5: locate the built APK (prefer universal, then aarch64).
  console.log("[build:android] 4/6 Locating built APK...");
  const apkOutDir = join(rootDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  const apk = findApk(join(apkOutDir, "universal", "release")) || findApk(join(apkOutDir, "arm64", "release")) || findApk(join(apkOutDir, "aarch64", "release"));
  if (!apk) throw new Error(`No built APK found under ${apkOutDir}`);

  // Step 6: sign (if unsigned) and stage into dist-desktop/VibeSquad.apk.
  const distDesktopDir = join(rootDir, "dist-desktop");
  mkdirSync(distDesktopDir, { recursive: true });
  const destApk = join(distDesktopDir, "VibeSquad.apk");
  if (apk.endsWith("-unsigned.apk")) {
    console.log("[build:android] 5/6 Signing APK...");
    const { keystorePath, storePass, alias } = ensureAndroidKeystore({ env: androidEnv, exec });
    const latest = latestBuildTools(androidEnv.ANDROID_HOME);
    if (!latest) throw new Error(`Android build-tools not found under ${join(androidEnv.ANDROID_HOME, "build-tools")}`);
    const javaExe = androidEnv.JAVA_HOME
      ? join(androidEnv.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : "java";
    const apksignerJar = join(androidEnv.ANDROID_HOME, "build-tools", latest, "lib", "apksigner.jar");
    run(javaExe, ["-jar", apksignerJar, "sign", "--ks", keystorePath, "--ks-key-alias", alias, "--ks-pass", "pass:" + storePass, "--key-pass", "pass:" + storePass, "--out", destApk, apk]);
  } else {
    copyFileSync(apk, destApk);
  }
  console.log(`[build:android] 6/6 Staged ${destApk}`);
  return { apkPath: destApk };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  buildAndroidApk();
}
