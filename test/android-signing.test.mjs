import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkCertPin, parseSignerSha256, signAndVerifyApk } from "../server/build-android.mjs";
import { parseKeytoolSha256, rotateAndroidKeystore } from "../scripts/rotate-android-keystore.mjs";

const SECRET = "s3cr3t-Pa55-xyz";
const FP = "ab".repeat(32);
const FP2 = "cd".repeat(32);
const certs = (fp) => `Signer #1 certificate DN: CN=VibeSquad\nSigner #1 certificate SHA-256 digest: ${fp}\n`;
const tmp = () => mkdtempSync(join(tmpdir(), "vs-sign-"));

function rotate(over = {}) {
  const calls = [];
  const logs = [];
  const dir = tmp();
  const keystorePath = join(dir, "sub", "k.jks");
  const run = () =>
    rotateAndroidKeystore({
      keystorePath,
      env: {},
      read: () => SECRET,
      mkdir: () => {},
      exists: () => false,
      log: (m) => logs.push(m),
      exec: (cmd, args, opts) => (calls.push({ cmd, args, opts }), "SHA256: " + "AA:".repeat(31) + "AA"),
      ...over,
    });
  return { run, calls, logs, keystorePath };
}

describe("rotate-android-keystore", () => {
  test("password only in child env, never argv or logs; RSA 4096", () => {
    const t = rotate();
    t.run();
    assert.equal(t.calls.length, 2);
    for (const c of t.calls) {
      assert.ok(!c.args.some((a) => a.includes(SECRET)));
      assert.equal(c.opts.env.VS_KS_PASS, SECRET);
      assert.ok(c.args.includes("-storepass:env"));
    }
    assert.ok(t.calls[0].args.includes("4096"));
    assert.ok(!t.logs.join("\n").includes(SECRET));
  });
  test("refuses to overwrite an existing .jks without touching keytool", () => {
    const t = rotate({ exists: () => true });
    assert.throws(t.run, /Refusing to overwrite/);
    assert.equal(t.calls.length, 0);
  });
  test("missing credential fails with the cmdkey hint", () => {
    const t = rotate({ read: () => null });
    assert.throws(t.run, /cmdkey \/generic:vibesquad\/android-keystore \/user:vibesquad \/pass/);
    assert.equal(t.calls.length, 0);
  });
  test("prints SHA-256 and the backup reminder", () => {
    const t = rotate();
    const r = t.run();
    assert.match(r.sha256, /^(AA:){31}AA$/);
    const out = t.logs.join("\n");
    assert.match(out, /Cert SHA-256: (AA:){31}AA/);
    assert.match(out, /BACKUP NOW/);
    assert.match(out, /vibesquad-updater\.key/);
  });
  test("parseKeytoolSha256", () => {
    assert.equal(parseKeytoolSha256("x\n\t SHA256: ab:cd:" + "00:".repeat(29) + "ff"), "AB:CD:" + "00:".repeat(29) + "FF");
    assert.equal(parseKeytoolSha256("nothing"), null);
  });
  test("rotate source has no env password fallback or default", () => {
    const src = readFileSync(new URL("../scripts/rotate-android-keystore.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(src, /resolveSecret|process\.env\.VS_KS_PASS|env\.VS_KS_PASS|"pass:"/);
  });
});

describe("build-android cert pin", () => {
  test("parseSignerSha256 normalises colons and case", () => {
    assert.equal(parseSignerSha256(certs(FP.toUpperCase())), FP);
    assert.equal(parseSignerSha256("no digest"), null);
  });
  test("first run writes the pin and says so", () => {
    const pinPath = join(tmp(), "d", "pin");
    const logs = [];
    const r = checkCertPin(FP, { pinPath, log: (m) => logs.push(m) });
    assert.equal(r.created, true);
    assert.equal(readFileSync(pinPath, "utf8").trim(), FP);
    assert.match(logs.join(" "), /first release/);
  });
  test("matching pin passes", () => {
    const pinPath = join(tmp(), "pin");
    writeFileSync(pinPath, FP + "\n");
    assert.equal(checkCertPin(FP, { pinPath, log: () => {} }).created, false);
  });
  test("mismatch throws with both fingerprints and leaves the pin", () => {
    const pinPath = join(tmp(), "pin");
    writeFileSync(pinPath, FP);
    assert.throws(() => checkCertPin(FP2, { pinPath, log: () => {} }), (e) => e.message.includes(FP) && e.message.includes(FP2));
    assert.equal(readFileSync(pinPath, "utf8"), FP);
  });
  test("signAndVerifyApk returns the fingerprint, no password in argv or logs; mismatch fails", () => {
    const pinPath = join(tmp(), "pin");
    const logs = [];
    const calls = [];
    const base = {
      javaExe: "java", apksignerJar: "a.jar", keystorePath: "k", alias: "al", inputApk: "in.apk", outApk: "out.apk", cwd: ".",
      secretEnv: { VS_KS_PASS: SECRET }, pinPath, log: (m) => logs.push(m),
    };
    const r = signAndVerifyApk({ ...base, exec: (c, a, o) => (calls.push(a), certs(FP)) });
    assert.equal(r.certSha256, FP);
    assert.ok(existsSync(pinPath));
    assert.ok(!JSON.stringify(calls).includes(SECRET) && !logs.join("\n").includes(SECRET));
    assert.throws(() => signAndVerifyApk({ ...base, exec: () => certs(FP2) }), /mismatch/);
  });
});

describe("no hardcoded keystore password", () => {
  test("sources carry no password literal or default", () => {
    for (const f of ["../server/build-android.mjs", "../scripts/rotate-android-keystore.mjs"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.doesNotMatch(src, /vibesquad-android["'`]|storePass\s*=\s*["'`]|-storepass["'`],\s*["'`](?!VS_KS)/);
      assert.doesNotMatch(src, /["'`]pass:/);
    }
  });
});
