import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verifyMinisign } from "../scripts/check-updater-key.mjs";
import { openSecretKey, pickScryptParams, rewrapSecretKey } from "../scripts/rewrap-updater-key.mjs";

// All keys here are throwaway test doubles generated in-process; nothing reads ~/.tauri or Credential Manager.
const wrap = (comment, bytes) => Buffer.from(`untrusted comment: ${comment}\n${bytes.toString("base64")}\n`).toString("base64");

function throwawayKey({ kdf = "\0\0" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const keyId = randomBytes(8);
  const ops = Buffer.alloc(8), mem = Buffer.alloc(8);
  ops.writeBigUInt64LE(1048576n);
  mem.writeBigUInt64LE(33554432n);
  const box = Buffer.concat([Buffer.from("Ed" + kdf + "B2", "latin1"), randomBytes(32), ops, mem, keyId, seed, pk, randomBytes(32)]);
  return {
    privateKey,
    keyFileText: wrap("rsign encrypted secret key", box),
    pubkeyB64: wrap("minisign public key", Buffer.concat([Buffer.from("Ed"), keyId, pk])),
    keyId,
  };
}

function minisignSig(privateKey, keyId, data, alg = "ED") {
  const msg = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  return wrap("signature", Buffer.concat([Buffer.from(alg), keyId, sign(null, msg, privateKey)]));
}

describe("rewrap-updater-key", () => {
  test("libsodium scrypt params for the minisign defaults", () => {
    assert.deepEqual(pickScryptParams(1048576, 33554432), { N: 32768, r: 8, p: 1 });
  });

  test("same keypair under a new password; old password and other pubkeys refused; empty new password refused", () => {
    const k = throwawayKey();
    const { text, keyId } = rewrapSecretKey({ keyFileText: k.keyFileText, oldPassword: "", newPassword: "new-pw", pubkeyB64: k.pubkeyB64 });
    assert.equal(keyId, Buffer.from(k.keyId).reverse().toString("hex").toUpperCase());
    assert.equal(openSecretKey(text, "new-pw", k.pubkeyB64).keyId, keyId);
    assert.throws(() => openSecretKey(text, "", k.pubkeyB64), /does not open/);
    assert.throws(() => openSecretKey(text, "new-pw", throwawayKey().pubkeyB64), /does not open/);
    assert.throws(() => rewrapSecretKey({ keyFileText: text, oldPassword: "wrong", newPassword: "x", pubkeyB64: k.pubkeyB64 }), /does not open/);
    assert.throws(() => rewrapSecretKey({ keyFileText: k.keyFileText, newPassword: "", pubkeyB64: k.pubkeyB64 }), /empty/);
    // chained re-wrap keeps the keypair; the error text never echoes a password
    const again = rewrapSecretKey({ keyFileText: text, oldPassword: "new-pw", newPassword: "third-pw", pubkeyB64: k.pubkeyB64 });
    assert.equal(openSecretKey(again.text, "third-pw", k.pubkeyB64).keyId, keyId);
    assert.throws(() => openSecretKey(again.text, "new-pw", k.pubkeyB64), (e) => !/new-pw|third-pw/.test(e.message));
  });
});

describe("check-updater-key verifyMinisign", () => {
  test("prehashed and legacy signatures verify; tampered data and foreign key ids fail", () => {
    const k = throwawayKey();
    const data = Buffer.from("probe");
    assert.equal(verifyMinisign({ pubkeyB64: k.pubkeyB64, sigB64: minisignSig(k.privateKey, k.keyId, data), data }).ok, true);
    assert.equal(verifyMinisign({ pubkeyB64: k.pubkeyB64, sigB64: minisignSig(k.privateKey, k.keyId, data, "Ed"), data }).ok, true);
    assert.equal(verifyMinisign({ pubkeyB64: k.pubkeyB64, sigB64: minisignSig(k.privateKey, k.keyId, data), data: Buffer.from("other") }).ok, false);
    const other = throwawayKey();
    const r = verifyMinisign({ pubkeyB64: other.pubkeyB64, sigB64: minisignSig(k.privateKey, k.keyId, data), data });
    assert.equal(r.ok, false);
    assert.match(r.reason, /key id mismatch/);
    assert.equal(verifyMinisign({ pubkeyB64: "garbage", sigB64: "garbage", data }).ok, false);
  });
});

describe("oracle: tauri signer accepts a re-wrapped throwaway key", () => {
  let tauriCliJs = null;
  try {
    tauriCliJs = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  } catch {}
  test("generate (no password) -> rewrap -> tauri signer sign with the new password -> verifies against the ORIGINAL pubkey", { skip: !tauriCliJs && "@tauri-apps/cli not installed", timeout: 120000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-rewrap-"));
    try {
      const keyPath = join(dir, "throwaway.key");
      const childEnv = (extra) => {
        const env = { ...process.env, ...extra };
        delete env.TAURI_SIGNING_PRIVATE_KEY;
        delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
        return env;
      };
      execFileSync(process.execPath, [tauriCliJs, "signer", "generate", "--ci", "-w", keyPath], { env: childEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }), stdio: "ignore" });
      const pubkeyB64 = readFileSync(`${keyPath}.pub`, "utf8");
      const { text } = rewrapSecretKey({ keyFileText: readFileSync(keyPath, "utf8"), oldPassword: "", newPassword: "oracle-pw", pubkeyB64 });
      writeFileSync(`${keyPath}.pw`, text);
      const probe = join(dir, "probe.txt");
      writeFileSync(probe, "probe");
      // password via env only (never argv); stdin closed so a bad key fails instead of prompting
      execFileSync(process.execPath, [tauriCliJs, "signer", "sign", "-f", `${keyPath}.pw`, probe], {
        env: childEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "oracle-pw" }),
        stdio: ["ignore", "ignore", "ignore"],
      });
      assert.ok(existsSync(`${probe}.sig`));
      const r = verifyMinisign({ pubkeyB64, sigB64: readFileSync(`${probe}.sig`, "utf8"), data: readFileSync(probe) });
      assert.equal(r.ok, true, r.reason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
