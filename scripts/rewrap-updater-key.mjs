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
// Tauri's / minisign's default scrypt limits, used when the input key carries none (raw unencrypted key).
const DEFAULT_OPSLIMIT = 1048576n, DEFAULT_MEMLIMIT = 33554432n;
const keyIdHex = (keyId) => Buffer.from(keyId).reverse().toString("hex").toUpperCase();

// BLAKE2b (RFC 7693) with a chosen digest length: node:crypto only offers the fixed 64-byte blake2b512, and the
// minisign key checksum is BLAKE2b-256 (a different function, not a truncation). Inputs here are ~74 bytes.
const B2_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const B2_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

/** Unkeyed BLAKE2b with an `outLen`-byte digest (1..64). */
export function blake2b(data, outLen = 64) {
  const input = Buffer.from(data);
  const h = B2_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = Buffer.alloc(128);
    input.copy(block, 0, b * 128, Math.min(input.length, (b + 1) * 128));
    const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
    const last = b === blocks - 1;
    const t = BigInt(last ? input.length : (b + 1) * 128);
    const v = [...h, ...B2_IV];
    v[12] ^= t & M64;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= M64;
    const g = (a, bb, c, d, x, y) => {
      v[a] = (v[a] + v[bb] + x) & M64;
      v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & M64;
      v[bb] = rotr64(v[bb] ^ v[c], 24n);
      v[a] = (v[a] + v[bb] + y) & M64;
      v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & M64;
      v[bb] = rotr64(v[bb] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = B2_SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]);
      g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]);
      g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]);
      g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]);
      g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((w, i) => out.writeBigUInt64LE(w, i * 8));
  return out.subarray(0, outLen);
}

/** Minisign secret key checksum: BLAKE2b-256(sig_alg || keynum || sk). */
export const secretKeyChecksum = (sigAlg, keynum, sk) => blake2b(Buffer.concat([sigAlg, keynum, sk]), 32);

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

/**
 * Decrypts and checks the key: BLAKE2b-256 checksum first (wrong password / corrupt file), then that it is the
 * pubkey's keypair (key id, public half, and the public key derived from the seed). Errors never carry a value.
 */
export function openSecretKey(fileText, password, pubkeyB64) {
  const { box } = parseKeyFile(fileText);
  const plain = xorKeynumSk(box, password);
  if (!secretKeyChecksum(box.subarray(0, 2), plain.subarray(0, 8), plain.subarray(8, 72)).equals(plain.subarray(72, 104))) {
    throw new Error("key checksum mismatch: wrong old password, or a corrupted key file");
  }
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
  // A raw unencrypted key carries 0/0 limits; scrypt params from those would be degenerate (N=2, p=512).
  if (!next.readBigUInt64LE(OPS) || !next.readBigUInt64LE(MEM)) {
    next.writeBigUInt64LE(DEFAULT_OPSLIMIT, OPS);
    next.writeBigUInt64LE(DEFAULT_MEMLIMIT, MEM);
  }
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
