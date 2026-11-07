import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ANDROID_KEY_ALIAS, DEFAULT_KEYSTORE_PATH, KS_SECRET } from "../server/build-android.mjs";
import { readCredential } from "../server/secrets.mjs";

const CMDKEY_HINT = `cmdkey /generic:${KS_SECRET.target} /user:vibesquad /pass`;

/** Pulls the SHA-256 line out of `keytool -list -v` output. */
export function parseKeytoolSha256(text) {
  const m = /SHA-?256:\s*([0-9A-Fa-f:]{64,95})/.exec(String(text || ""));
  return m ? m[1].toUpperCase() : null;
}

/** True if anything (file, dir, dangling symlink) occupies the path. */
function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Creates the NEW release keystore. The password is read from Credential Manager only (no env
 * fallback, no prompt) and handed to keytool through the child env (`-storepass:env`), never argv.
 * Refuses to overwrite an existing keystore.
 */
export function rotateAndroidKeystore({
  keystorePath = DEFAULT_KEYSTORE_PATH,
  alias = ANDROID_KEY_ALIAS,
  env = process.env,
  exec = execFileSync,
  exists = pathExists,
  mkdir = mkdirSync,
  read = readCredential,
  log = console.log,
} = {}) {
  if (exists(keystorePath)) {
    throw new Error(`Refusing to overwrite existing keystore ${keystorePath}. Move it away deliberately if you really mean to rotate.`);
  }
  const storePass = read(KS_SECRET.target);
  if (!storePass) {
    throw new Error(`No keystore password in Credential Manager (target "${KS_SECRET.target}"). Store it first, in your own terminal:\n  ${CMDKEY_HINT}`);
  }
  const keytool = env.JAVA_HOME
    ? join(env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool")
    : "keytool";
  const childEnv = { ...env, VS_KS_PASS: storePass };
  mkdir(dirname(keystorePath), { recursive: true });
  exec(keytool, [
    "-genkeypair",
    "-keystore", keystorePath,
    "-alias", alias,
    "-keyalg", "RSA",
    "-keysize", "4096",
    "-validity", "36500",
    "-storepass:env", "VS_KS_PASS",
    "-keypass:env", "VS_KS_PASS",
    "-dname", "CN=VibeSquad, O=VibeSquad, C=US",
  ], { env: childEnv, stdio: "ignore" });
  const listing = exec(keytool, [
    "-list", "-v",
    "-keystore", keystorePath,
    "-alias", alias,
    "-storepass:env", "VS_KS_PASS",
  ], { env: childEnv, encoding: "utf8" });
  const sha256 = parseKeytoolSha256(listing);
  if (!sha256) throw new Error(`Created ${keystorePath} but could not read its SHA-256 from keytool -list output; verify it manually before use.`);
  log(`Created ${keystorePath} (alias "${alias}", RSA 4096).`);
  log(`Cert SHA-256: ${sha256}`);
  log("BACKUP NOW: copy this .jks and ~/.tauri/vibesquad-updater.key to encrypted offline backup (encrypted USB or a password-manager attachment). Losing either strands installed clients.");
  return { keystorePath, alias, sha256 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  try {
    rotateAndroidKeystore();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
