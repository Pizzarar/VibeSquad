#!/usr/bin/env node
// Re-encrypts the Tauri updater minisign secret key under a new password WITHOUT changing the keypair, so the
// pubkey in src-tauri/tauri.conf.json (and every installed app) keeps accepting updates. `tauri signer` has no
// change-password command, and `minisign -C` cannot read Tauri's base64-wrapped key file.
//
// Old password: env VS_UPDATER_KEY_OLD_PASSWORD (default "": the current key was generated without one).
// New password: the release resolver (env TAURI_SIGNING_PRIVATE_KEY_PASSWORD wins, else Credential Manager
// "vibesquad/updater-key"), so the key is encrypted with exactly what the desk will later read. Store it first.
// Refuses unless the decrypted key matches the tauri.conf.json pubkey (key id AND Ed25519 public key).
// Writes a NEW file (default <key>.pw, never overwrites), re-decrypts it as a self-check, prints only the key id.
//   node scripts/rewrap-updater-key.mjs [--key <path>] [--out <path>] [--pubkey <b64>]
import { createPrivateKey, createPublicKey, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUpdaterKeyPassword } from "../server/secrets.mjs";

const rootDir = resolve(import.meta.dirname, "..");
// Minisign secret key box: sig_alg(2) kdf_alg(2) chk_alg(2) salt(32) opslimit(8 LE) memlimit(8 LE) keynum_sk(104).
const SALT = 6, OPS = 38, MEM = 46, KEYNUM_SK = 54, BOX_LEN = 158, KEYNUM_SK_LEN = 104;
const keyIdHex = (keyId) => Buffer.from(keyId).reverse().toString("hex").toUpperCase();

/** libsodium crypto_pwhash_scryptsalsa208sha256 pickparams (what minisign and the Rust minisign crate use). */
export function pickScryptParams(opslimit, memlimit) {
  const ops = Math.max(opslimit, 32768);
  const r = 8;
  const nLog2For = (maxN) => {
    let n = 1;
    while (n < 63 && 2 ** n <= maxN / 2) n += 1;
    return n;
  };
  if (ops < memlimit / 32) return { N: 2 ** nLog2For(Math.floor(ops / (r * 4))), r, p: 1 };
  const nLog2 = nLog2For(Math.floor(memlimit / (r * 128)));
  const maxrp = Math.min(Math.floor(Math.floor(ops / 4) / 2 ** nLog2), 0x3fffffff);
  return { N: 2 ** nLog2, r, p: Math.floor(maxrp / r) };
}

function keystream(box, password) {
  const { N, r, p } = pickScryptParams(Number(box.readBigUInt64LE(OPS)), Number(box.readBigUInt64LE(MEM)));
  return scryptSync(Buffer.from(password, "utf8"), box.subarray(SALT, SALT + 32), KEYNUM_SK_LEN, { N, r, p, maxmem: 256 * N * r + 2 ** 20 });
}

function xorKeynumSk(box, password) {
  const kdf = box.subarray(2, 4).toString("latin1");
  const sealed = box.subarray(KEYNUM_SK, KEYNUM_SK + KEYNUM_SK_LEN);
  if (kdf === "\0\0") return Buffer.from(sealed);
  if (kdf !== "Sc") throw new Error(`unsupported key KDF ${JSON.stringify(kdf)}`);
  const stream = keystream(box, password);
  return Buffer.from(sealed.map((b, i) => b ^ stream[i]));
}

/** Parses a Tauri key file (base64 of the minisign secret key text). */
function parseKeyFile(fileText) {
  const inner = Buffer.from(String(fileText).trim(), "base64").toString("utf8");
  const lines = inner.split("\n");
  const box = lines[1] ? Buffer.from(lines[1].trim(), "base64") : Buffer.alloc(0);
  if (!lines[0].startsWith("untrusted comment:") || box.length !== BOX_LEN || box.subarray(0, 2).toString() !== "Ed" || box.subarray(4, 6).toString() !== "B2") {
    throw new Error("not a Tauri/minisign secret key file");
  }
  return { inner, line: lines[1], box };
}

function parsePubkey(pubkeyB64) {
  const lines = Buffer.from(String(pubkeyB64).trim(), "base64").toString("utf8").split(/\r?\n/);
  const pub = Buffer.from(String(lines[1] || "").trim(), "base64");
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign public key");
  return { keyId: pub.subarray(2, 10), pk: pub.subarray(10) };
}

/** Ed25519 public key derived from a 32-byte seed. */
function publicFromSeed(seed) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return Buffer.from(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x, "base64url");
}

/** Decrypts and checks the key against the pubkey; throws a value-free error on a wrong password or other key. */
export function openSecretKey(fileText, password, pubkeyB64) {
  const { box } = parseKeyFile(fileText);
  const plain = xorKeynumSk(box, password);
  const { keyId, pk } = parsePubkey(pubkeyB64);
  const seed = plain.subarray(8, 40);
  const ok = plain.subarray(0, 8).equals(keyId) && plain.subarray(40, 72).equals(pk) && publicFromSeed(seed).equals(pk);
  if (!ok) throw new Error(`key does not open to pubkey ${keyIdHex(keyId)}: wrong old password, or a different keypair`);
  return { plain, keyId: keyIdHex(keyId) };
}

/** Same keypair, new password: fresh salt, same KDF limits. Returns the new key file text (Tauri format). */
export function rewrapSecretKey({ keyFileText, oldPassword = "", newPassword, pubkeyB64, salt = randomBytes(32) }) {
  if (!newPassword) throw new Error("new password is empty: store it first (see owner steps)");
  const { plain, keyId } = openSecretKey(keyFileText, oldPassword, pubkeyB64);
  const { inner, line, box } = parseKeyFile(keyFileText);
  const next = Buffer.from(box);
  next.write("Sc", 2, "latin1");
  salt.copy(next, SALT);
  const stream = keystream(next, newPassword);
  Buffer.from(plain.map((b, i) => b ^ stream[i])).copy(next, KEYNUM_SK);
  const text = Buffer.from(inner.replace(line, next.toString("base64")), "utf8").toString("base64");
  openSecretKey(text, newPassword, pubkeyB64); // self-check before anyone writes it
  return { text, keyId };
}

function main(argv) {
  const arg = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined);
  const keyPath = arg("--key") || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), ".tauri", "vibesquad-updater.key");
  const outPath = arg("--out") || `${keyPath}.pw`;
  const pubkeyB64 = arg("--pubkey") || JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8")).plugins.updater.pubkey;
  if (!existsSync(keyPath)) return fail(`no key file at ${keyPath}`);
  if (existsSync(outPath)) return fail(`${outPath} already exists; move it away first (never overwritten)`);
  try {
    const { text, keyId } = rewrapSecretKey({
      keyFileText: readFileSync(keyPath, "utf8"),
      oldPassword: process.env.VS_UPDATER_KEY_OLD_PASSWORD || "",
      newPassword: resolveUpdaterKeyPassword(),
      pubkeyB64,
    });
    writeFileSync(outPath, text, { flag: "wx", mode: 0o600 });
    console.log(`[rewrap] OK: wrote ${outPath}; same keypair, key id ${keyId} (matches ${arg("--pubkey") ? "--pubkey" : "the tauri.conf.json pubkey"}); now password-protected`);
    return 0;
  } catch (e) {
    return fail(e.message);
  }
}

function fail(msg) {
  console.error(`[rewrap] FAIL: ${msg}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
