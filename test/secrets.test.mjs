import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readCredential, resolveSecret, withSecretEnv } from "../server/secrets.mjs";
import { ensureAndroidKeystore, signAndVerifyApk } from "../server/build-android.mjs";

const SECRET = "s3cr3t-VALUE-xyz";

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

function mkKs() { const p = join(mkdtempSync(join(tmpdir(), "vs-ks-")), "k.jks"); writeFileSync(p, "x"); return p; }

describe("build-android keystore secrets", () => {
  test("keystore env carries the secret; missing keystore fails pointing at rotate script", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-ks-"));
    const keystorePath = join(dir, "x.jks");
    assert.throws(() => ensureAndroidKeystore({ keystorePath, env: { VS_KS_PASS: SECRET } }), /rotate-android-keystore.mjs/);
    writeFileSync(keystorePath, "x");
    const r = ensureAndroidKeystore({ keystorePath, env: { VS_KS_PASS: SECRET } });
    assert.equal(r.secretEnv.VS_KS_PASS, SECRET);
    assert.ok(!JSON.stringify({ keystorePath: r.keystorePath, alias: r.alias }).includes(SECRET));
  });
  test("apksigner sign gets VS_KS_PASS in env only, then verify --print-certs runs", () => {
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), "vs-pin-"));
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
