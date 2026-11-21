import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { detachUpdaterKeyPassword, readCredential, resolveSecret, resolveUpdaterKeyPassword, updaterKeyChildEnvs, withoutUpdaterKeyPassword, withSecretEnv } from "../server/secrets.mjs";
import { ensureAndroidKeystore, signAndVerifyApk } from "../server/build-android.mjs";

const SECRET = "s3cr3t-VALUE-xyz";

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const mkTmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };

describe("resolveSecret", () => {
  test("env wins over the credential store", () => {
    let called = false;
    const v = resolveSecret({ envVar: "X", target: "t" }, { env: { X: "fromenv" }, read: () => ((called = true), "store") });
    assert.equal(v, "fromenv");
    assert.equal(called, false);
  });
  test("falls back to the store, then null", () => {
    assert.equal(resolveSecret({ envVar: "X", target: "t" }, { env: {}, read: (t) => (t === "t" ? "store" : null) }), "store");
    assert.equal(resolveSecret({ envVar: "X", target: "t" }, { env: { X: "" }, read: () => null }), null);
  });
  test("required error names target + cmdkey, never a value", () => {
    assert.throws(
      () => resolveSecret({ envVar: "X", target: "my/target", required: true }, { env: { Y: SECRET }, read: () => null }),
      (e) => /my\/target/.test(e.message) && /cmdkey/.test(e.message) && !e.message.includes(SECRET),
    );
  });
  test("withSecretEnv resolves and omits missing optionals", () => {
    const out = withSecretEnv({ A: "1" }, { P: { envVar: "P", target: "t" }, Q: { envVar: "Q", target: "u" } }, { env: { P: "pv" }, read: () => null });
    assert.deepEqual(out, { A: "1", P: "pv" });
  });
});

describe("readCredential", () => {
  test("passes target via env, not argv; returns stdout", () => {
    let seen;
    const v = readCredential("a/b;$(evil)", { platform: "win32", exec: (cmd, args, opts) => ((seen = { cmd, args, opts }), SECRET) });
    assert.equal(v, SECRET);
    assert.equal(seen.opts.env.VS_CRED_TARGET, "a/b;$(evil)");
    assert.ok(!seen.args.some((a) => a.includes("a/b;$(evil)")));
    assert.ok(seen.args.includes("-NoProfile"));
  });
  test("null on non-windows, error, or empty", () => {
    assert.equal(readCredential("t", { platform: "linux", exec: () => SECRET }), null);
    assert.equal(readCredential("t", { platform: "win32", exec: () => { throw new Error("x"); } }), null);
    assert.equal(readCredential("t", { platform: "win32", exec: () => "" }), null);
  });
});

function mkKs() { const p = join(mkTmp("vs-ks-"), "k.jks"); writeFileSync(p, "x"); return p; }

describe("build-android keystore secrets", () => {
  test("keystore env carries the secret; missing keystore fails pointing at rotate script", () => {
    const dir = mkTmp("vs-ks-");
    const keystorePath = join(dir, "x.jks");
    assert.throws(() => ensureAndroidKeystore({ keystorePath, env: { VS_KS_PASS: SECRET } }), /rotate-android-keystore.mjs/);
    writeFileSync(keystorePath, "x");
    const r = ensureAndroidKeystore({ keystorePath, env: { VS_KS_PASS: SECRET } });
    assert.equal(r.secretEnv.VS_KS_PASS, SECRET);
    assert.ok(!JSON.stringify({ keystorePath: r.keystorePath, alias: r.alias }).includes(SECRET));
  });
  test("apksigner sign gets VS_KS_PASS in env only, then verify --print-certs runs", () => {
    const calls = [];
    const dir = mkTmp("vs-pin-");
    signAndVerifyApk({
      javaExe: "java", apksignerJar: "a.jar", keystorePath: "k", alias: "al", inputApk: "in.apk", outApk: "out.apk", cwd: ".",
      secretEnv: { VS_KS_PASS: SECRET }, pinPath: join(dir, "pin"), pinFirst: true, log: () => {},
      exec: (cmd, args, opts) => (calls.push({ cmd, args, opts }), "Signer #1 certificate SHA-256 digest: " + "ab".repeat(32)),
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("sign"));
    assert.equal(calls[0].opts.env.VS_KS_PASS, SECRET);
    assert.ok(calls.every((c) => !c.args.some((a) => a.includes(SECRET))));
    assert.deepEqual(calls[1].args.slice(2), ["verify", "--print-certs", "out.apk"]);
  });
  test("missing secret throws without a value", () => {
    assert.throws(
      () => ensureAndroidKeystore({ keystorePath: mkKs(), env: {}, resolve: () => resolveSecret({ envVar: "VS_KS_PASS", target: "vibesquad/android-keystore", required: true }, { env: {}, read: () => null }) }),
      /vibesquad\/android-keystore/,
    );
  });
  test("build-android source has no pass: form or hardcoded default", () => {
    const src = require_src();
    assert.doesNotMatch(src, /"pass:"|vibesquad-android"/);
    assert.match(src, /env:VS_KS_PASS/);
  });
});

import { readFileSync, writeFileSync } from "node:fs";
function require_src() { return readFileSync(new URL("../server/build-android.mjs", import.meta.url), "utf8"); }

describe("updater key password spec", () => {
  const PW = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
  test("a set-but-empty env var means no password: the store is not read", () => {
    let reads = 0;
    const read = () => (reads++, "store-pw");
    assert.equal(resolveUpdaterKeyPassword({ env: { [PW]: "" }, read }), "");
    assert.equal(reads, 0);
    assert.equal(resolveUpdaterKeyPassword({ env: {}, read }), "store-pw");
    assert.equal(reads, 1);
    // other specs keep the old semantics: empty env falls through to the store
    assert.equal(resolveSecret({ envVar: "X", target: "t" }, { env: { X: "" }, read: () => "store" }), "store");
  });

  test("detachUpdaterKeyPassword removes the password from the live env and returns a full snapshot", () => {
    const live = { PATH: "p", [PW]: "inherited-pw" };
    const snap = detachUpdaterKeyPassword(live);
    assert.equal(PW in live, false);
    assert.equal(snap[PW], "inherited-pw");
    assert.equal(snap.PATH, "p");
    assert.equal(PW in detachUpdaterKeyPassword({ PATH: "p" }), false);
  });

  test("password stripping is case-insensitive (Windows env names): every variant goes, input copy untouched", () => {
    const variants = { [PW]: "a", tauri_signing_private_key_password: "b", Tauri_Signing_Private_Key_Password: "c" };
    const hasAny = (env) => Object.keys(env).filter((k) => k.toUpperCase() === PW);
    const base = { PATH: "p", ...variants };
    const plain = withoutUpdaterKeyPassword(base);
    assert.deepEqual(hasAny(plain), []);
    assert.equal(plain.PATH, "p");
    assert.deepEqual(hasAny(base).sort(), Object.keys(variants).sort()); // input not mutated
    const live = { PATH: "p", ...variants };
    const snap = detachUpdaterKeyPassword(live);
    assert.deepEqual(hasAny(live), []);
    assert.deepEqual(hasAny(snap).sort(), Object.keys(variants).sort());
    // look-alikes that are not the password survive
    assert.equal(withoutUpdaterKeyPassword({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD_X: "1" }).TAURI_SIGNING_PRIVATE_KEY_PASSWORD_X, "1");
    // child envs: plain has no variant; tauri/signer carry exactly the canonical name
    const { plain: p2, tauri, signer } = updaterKeyChildEnvs({ PATH: "p", ...variants }, { keyPath: "/k/key", read: () => null });
    assert.deepEqual(hasAny(p2), []);
    assert.deepEqual(hasAny(tauri), [PW]);
    assert.deepEqual(hasAny(signer), [PW]);
  });

  test("child envs: plain never carries the password; tauri build and signer sign do; no key = no store read", () => {
    const base = { PATH: "p", [PW]: "inherited-pw", OTHER: "1" };
    assert.equal(PW in withoutUpdaterKeyPassword(base), false);
    assert.equal(base[PW], "inherited-pw"); // input not mutated
    const read = () => "store-pw";
    const { plain, tauri, signer } = updaterKeyChildEnvs(base, { keyPath: "/k/key", read });
    assert.equal(PW in plain, false);
    assert.equal(plain.OTHER, "1");
    assert.equal(tauri[PW], "inherited-pw");
    assert.equal(tauri.TAURI_SIGNING_PRIVATE_KEY, "/k/key");
    assert.equal(signer[PW], "inherited-pw");
    assert.equal(signer.TAURI_SIGNING_PRIVATE_KEY_PATH, "/k/key");
    assert.equal("TAURI_SIGNING_PRIVATE_KEY" in signer, false);
    assert.equal(updaterKeyChildEnvs({ PATH: "p" }, { keyPath: "/k/key", read }).tauri[PW], "store-pw");
    let reads = 0;
    const none = updaterKeyChildEnvs(base, { read: () => (reads++, "store-pw") });
    assert.equal(PW in none.tauri, false);
    assert.equal(none.signer, null);
    assert.equal(reads, 0);
  });
});
