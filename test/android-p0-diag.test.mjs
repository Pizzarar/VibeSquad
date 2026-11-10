// unit-and-p0-white: blank white screen after pairing (BUG_INVENTORY theme 6). Diagnostics + the enter hop page.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { handleEnter } from "../server/auth.mjs";
import { ensureAndroidTrustKotlin } from "../server/build-android.mjs";
import { diagError, diagLines, installDiagOverlay } from "../src/diagOverlay.ts";
import { isAndroidApkPath } from "../server/vibesquad-api.mjs";

function enter(url, method = "GET") {
  const out = { headers: {}, body: "" };
  const res = {
    statusCode: 0,
    setHeader: (k, v) => (out.headers[k.toLowerCase()] = v),
    getHeader: (k) => out.headers[k.toLowerCase()],
    end: (b) => (out.body = b ?? ""),
  };
  handleEnter({ method, url, headers: {} }, res);
  return { ...out, status: res.statusCode };
}

describe("enter hop page", () => {
  test("is styled (never a bare white page) and still has the Continue link, meta refresh and script hop to /", () => {
    const r = enter("/__vibesquad/enter?vs_app=http%3A%2F%2Ftauri.localhost");
    assert.equal(r.status, 200);
    assert.match(r.body, /background:#070710/);
    assert.match(r.body, /<a id="go" href="\/\?vs_app=http%3A%2F%2Ftauri\.localhost">Continue<\/a>/);
    assert.match(r.body, /http-equiv="refresh"/);
    assert.doesNotMatch(r.body, /tauri\.localhost\/(?!")/);
  });

  test("its script parses, hops to the fixed target and prints a trace if it is still showing", () => {
    const r = enter("/__vibesquad/enter?vs_app=http%3A%2F%2Ftauri.localhost");
    const script = r.body.match(/<script>([\s\S]*)<\/script>/)[1];
    const calls = [];
    let timer;
    const el = { textContent: "" };
    new Function("location", "document", "navigator", "setTimeout", script)(
      { replace: (u) => calls.push(u) },
      { getElementById: () => el, referrer: "ref" },
      { cookieEnabled: true, userAgent: "UA-x" },
      (fn) => (timer = fn),
    );
    assert.deepEqual(calls, ["/?vs_app=http%3A%2F%2Ftauri.localhost"]);
    timer();
    assert.match(el.textContent, /did not leave this page/);
    assert.match(el.textContent, /UA-x/);
  });

  test("HEAD has no body", () => assert.equal(enter("/__vibesquad/enter", "HEAD").body, ""));
});

describe("diagnostics overlay", () => {
  const win = (ua) => {
    const handlers = {};
    return {
      handlers,
      navigator: { userAgent: ua },
      location: { href: "https://pc:4180/?vs_app=x&code=123456" },
      addEventListener: (t, f) => (handlers[t] = f),
      document: { body: null },
    };
  };

  test("diagError mounts no box before an Android install (desktop render errors)", () => {
    let created = 0;
    diagError("render", "x", { body: {}, createElement: () => (created++, {}) });
    assert.equal(created, 0);
  });

  test("installs only on Android and redacts pairing codes from the boot breadcrumb", () => {
    assert.equal(installDiagOverlay(win("Mozilla Windows")), false);
    const w = win("Mozilla Linux; Android 14");
    assert.equal(installDiagOverlay(w), true);
    assert.ok(w.handlers.error && w.handlers.unhandledrejection);
    assert.ok(diagLines().some((l) => /boot https:\/\/pc:4180\/\?vs_app=x&code=…/.test(l)));
  });

  test("records errors and rejections", () => {
    const w = win("Android");
    installDiagOverlay(w);
    w.handlers.error({ message: "boom", filename: "a.js", lineno: 3, colno: 4 });
    w.handlers.unhandledrejection({ reason: new Error("nope") });
    const all = diagLines().join("\n");
    assert.match(all, /error: boom @ a\.js:3:4/);
    assert.match(all, /unhandledrejection: Error: nope/);
  });
});

describe("WebView remote debugging", () => {
  const src = readFileSync(new URL("../src-tauri/android/VsTrust.kt", import.meta.url), "utf8");

  test("source keeps it off and gates the call on the flag", () => {
    assert.match(src, /private const val WEB_DEBUG = false/);
    assert.match(src, /if \(WEB_DEBUG\) WebView\.setWebContentsDebuggingEnabled\(true\)/);
  });

  test("only a sideload/debug build flips the flag in the generated copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-webdebug-"));
    const from = join(dir, "VsTrust.kt");
    writeFileSync(from, src);
    const plain = mkdtempSync(join(tmpdir(), "vs-webdebug-a-"));
    const dbg = mkdtempSync(join(tmpdir(), "vs-webdebug-b-"));
    ensureAndroidTrustKotlin(plain, from);
    ensureAndroidTrustKotlin(dbg, from, { webDebug: true });
    assert.match(readFileSync(join(plain, "VsTrust.kt"), "utf8"), /WEB_DEBUG = false/);
    assert.match(readFileSync(join(dbg, "VsTrust.kt"), "utf8"), /WEB_DEBUG = true/);
  });
});

describe("idea-82 /vibesquad.apk", () => {
  test("route matcher is case-insensitive (query string is stripped by the callers)", () => {
    for (const p of ["/vibesquad.apk", "/VibeSquad.apk", "/VIBESQUAD.APK"]) assert.ok(isAndroidApkPath(p), p);
  });
});
