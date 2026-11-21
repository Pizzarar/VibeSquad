#!/usr/bin/env node
// Updater minisign key dry-run (Release Desk): signs a throwaway probe file with the same key path and password
// resolver the release uses (TAURI_SIGNING_PRIVATE_KEY_PASSWORD wins, else Credential Manager
// "vibesquad/updater-key"), then verifies the signature against the pubkey in src-tauri/tauri.conf.json.
// PASS proves both that the password works and that the keypair is unchanged (installed apps keep accepting updates).
// Prints the password SOURCE only, never the value. Publishes nothing; the probe lives in a temp dir that is removed.
//   node scripts/check-updater-key.mjs                 # key: $TAURI_SIGNING_PRIVATE_KEY_PATH or ~/.tauri/vibesquad-updater.key
//   node scripts/check-updater-key.mjs --pubkey <b64>  # verify against another pubkey (tests with a throwaway key)
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signerSignArgs, updaterSigningEnv } from "../server/release.mjs";

const rootDir = resolve(import.meta.dirname, "..");

/** Minisign key id as minisign prints it (little-endian u64, upper-case hex). */
const keyIdHex = (keyId) => Buffer.from(keyId).reverse().toString("hex").toUpperCase();

/** Second line of a base64-wrapped minisign text file (Tauri's pubkey / .sig format), decoded to bytes. */
function minisignPayload(b64, what) {
  const lines = Buffer.from(String(b64).trim(), "base64").toString("utf8").split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[1]) throw new Error(`not a minisign ${what}`);
  return Buffer.from(lines[1].trim(), "base64");
}

/** Verifies a Tauri (base64-wrapped minisign) signature over `data` against a Tauri pubkey. Never throws. */
export function verifyMinisign({ pubkeyB64, sigB64, data }) {
  try {
    const pub = minisignPayload(pubkeyB64, "public key");
    const sig = minisignPayload(sigB64, "signature");
    if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") return { ok: false, reason: "unsupported public key format" };
    if (sig.length !== 74) return { ok: false, reason: "unsupported signature format" };
    const pubKeyId = pub.subarray(2, 10);
    const sigKeyId = sig.subarray(2, 10);
    if (!pubKeyId.equals(sigKeyId)) {
      return { ok: false, reason: `key id mismatch: signed by ${keyIdHex(sigKeyId)}, pubkey is ${keyIdHex(pubKeyId)}`, keyId: keyIdHex(sigKeyId) };
    }
    const alg = sig.subarray(0, 2).toString();
    const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : alg === "Ed" ? Buffer.from(data) : null;
    if (!message) return { ok: false, reason: `unsupported signature algorithm ${JSON.stringify(alg)}` };
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.subarray(10).toString("base64url") }, format: "jwk" });
    const ok = verify(null, message, key, sig.subarray(10));
    return { ok, reason: ok ? "signature verified" : "signature does not verify", keyId: keyIdHex(pubKeyId) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function main(argv) {
  const at = argv.indexOf("--pubkey");
  const pubkeyB64 = at >= 0 ? argv[at + 1] : JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8")).plugins.updater.pubkey;
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), ".tauri", "vibesquad-updater.key");
  if (!existsSync(keyPath)) {
    console.error(`[updater-key] FAIL: no key file at ${keyPath}`);
    return 2;
  }
  const env = updaterSigningEnv(process.env, keyPath);
  const source = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined
    ? `env TAURI_SIGNING_PRIVATE_KEY_PASSWORD${process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ? "" : " (set empty: no password)"}`
    : env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      ? "Credential Manager vibesquad/updater-key"
      : "none (unpassworded key)";
  console.log(`[updater-key] key ${keyPath}; password source: ${source}`);
  const dir = mkdtempSync(join(tmpdir(), "vs-updater-key-"));
  try {
    const probe = join(dir, "probe.txt");
    writeFileSync(probe, `vibesquad updater key probe ${new Date().toISOString()}\n`);
    const tauriCliJs = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
    try {
      // stdin closed: a wrong/missing password fails instead of hanging on a prompt.
      execFileSync(process.execPath, signerSignArgs(tauriCliJs, keyPath, probe), { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(" | ");
      console.error(`[updater-key] FAIL: tauri signer sign failed (wrong or missing password?): ${err}`);
      return 1;
    }
    const result = verifyMinisign({ pubkeyB64, sigB64: readFileSync(`${probe}.sig`, "utf8"), data: readFileSync(probe) });
    console.log(`[updater-key] ${result.ok ? "PASS" : "FAIL"}: ${result.reason}${result.keyId ? ` (key id ${result.keyId})` : ""}`);
    return result.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
