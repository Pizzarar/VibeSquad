import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verifyMinisign } from "../scripts/check-updater-key.mjs";
import { blake2b, openSecretKey, pickScryptParams, rewrapSecretKey, secretKeyChecksum } from "../scripts/rewrap-updater-key.mjs";

// All keys here are throwaway test doubles generated in-process; nothing reads ~/.tauri or Credential Manager.
const wrap = (comment, bytes) => Buffer.from(`untrusted comment: ${comment}\n${bytes.toString("base64")}\n`).toString("base64");

// A raw UNENCRYPTED minisign key: kdf "\0\0", zero salt, zero opslimit/memlimit (as `minisign -W` writes it).
function throwawayKey({ corruptChecksum = false } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const keyId = randomBytes(8);
  const sk = Buffer.concat([seed, pk]);
  const chk = secretKeyChecksum(Buffer.from("Ed"), keyId, sk);
  if (corruptChecksum) chk[0] ^= 1;
  const box = Buffer.concat([Buffer.from("Ed\0\0B2", "latin1"), Buffer.alloc(32), Buffer.alloc(8), Buffer.alloc(8), keyId, sk, chk]);
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

  test("BLAKE2b: RFC 7693 'abc' vector, BLAKE2b-256 empty vector, matches node blake2b512 across block sizes", () => {
    assert.equal(
      blake2b(Buffer.from("abc"), 64).toString("hex"),
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    assert.equal(blake2b(Buffer.alloc(0), 32).toString("hex"), "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    for (const n of [0, 1, 74, 127, 128, 129, 256, 300]) {
      const d = randomBytes(n);
      assert.deepEqual(blake2b(d, 64), createHash("blake2b512").update(d).digest(), `len ${n}`);
    }
  });

  test("unencrypted key with 0/0 limits re-wraps under Tauri's scrypt limits, not degenerate ones", () => {
    const k = throwawayKey();
    const { text } = rewrapSecretKey({ keyFileText: k.keyFileText, newPassword: "new-pw", pubkeyB64: k.pubkeyB64 });
    const box = Buffer.from(Buffer.from(text, "base64").toString("utf8").split("\n")[1], "base64");
    assert.equal(box.subarray(2, 4).toString("latin1"), "Sc");
    assert.equal(box.readBigUInt64LE(38), 1048576n);
    assert.equal(box.readBigUInt64LE(46), 33554432n);
    assert.notDeepEqual(box.subarray(6, 38), Buffer.alloc(32));
  });

  test("a BLAKE2b-256 checksum mismatch is refused", () => {
    const k = throwawayKey({ corruptChecksum: true });
    assert.throws(() => openSecretKey(k.keyFileText, "", k.pubkeyB64), /checksum mismatch/);
    assert.throws(() => rewrapSecretKey({ keyFileText: k.keyFileText, newPassword: "x", pubkeyB64: k.pubkeyB64 }), /checksum mismatch/);
  });

  test("same keypair under a new password; old password and other pubkeys refused; empty new password refused", () => {
    const k = throwawayKey();
    const { text, keyId } = rewrapSecretKey({ keyFileText: k.keyFileText, oldPassword: "", newPassword: "new-pw", pubkeyB64: k.pubkeyB64 });
    assert.equal(keyId, Buffer.from(k.keyId).reverse().toString("hex").toUpperCase());
    assert.equal(openSecretKey(text, "new-pw", k.pubkeyB64).keyId, keyId);
    assert.throws(() => openSecretKey(text, "", k.pubkeyB64), /checksum mismatch/);
    assert.throws(() => openSecretKey(text, "new-pw", throwawayKey().pubkeyB64), /does not open/);
    assert.throws(() => rewrapSecretKey({ keyFileText: text, oldPassword: "wrong", newPassword: "x", pubkeyB64: k.pubkeyB64 }), /checksum mismatch/);
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
      // our BLAKE2b-256 checksum agrees with the one the Rust minisign crate wrote
      assert.match(openSecretKey(readFileSync(keyPath, "utf8"), "", pubkeyB64).keyId, /^[0-9A-F]{16}$/);
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
