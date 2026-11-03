import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-daemon-pw-"));
const paseoHome = join(home, "paseo");
mkdirSync(paseoHome, { recursive: true });
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = paseoHome;

const {
  DAEMON_PASSWORD_FILE,
  daemonPasswordPath,
  daemonPasswordSource,
  getDaemonAuthStatus,
  isDaemonPasswordRequired,
  probeDaemonPassword,
  readDaemonPassword,
  writeDaemonPassword,
} = await import("../server/daemon-password.mjs");
const { getLocalToken, HOME_SECRET_FILES, resetLocalTokenForTest } = await import("../server/auth.mjs");
const { inspectFirstRunStatus } = await import("../server/first-run.mjs");
const { createVibesquadMiddleware, isGatedRead, stopPushWatcher } = await import("../server/vibesquad-api.mjs");
const { isBlockedPath } = await import("../plugin/server/remote-proxy-rules.ts");

const root = resolve(import.meta.dirname, "..");

after(async () => {
  await stopPushWatcher().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

describe("daemon-password store and helpers", () => {
  test("HOME_SECRET_FILES includes daemon-password and remote proxy blocks /__vibesquad/paseo/daemon-auth", () => {
    assert.equal(DAEMON_PASSWORD_FILE, "daemon-password");
    assert.ok(HOME_SECRET_FILES.includes("daemon-password"));
    assert.equal(isBlockedPath("/__vibesquad/paseo/daemon-auth"), true);
    assert.equal(isGatedRead("/__vibesquad/paseo/daemon-auth"), true);
    assert.equal(isGatedRead("GET", "/__vibesquad/paseo/daemon-auth"), true);
  });

  test("writeDaemonPassword, readDaemonPassword (BOM/newline stripping), clear, and daemonPasswordSource", () => {
    const storeHome = mkdtempSync(join(home, "store-"));
    const p = daemonPasswordPath(storeHome);

    assert.equal(readDaemonPassword({ home: storeHome, env: {} }), "");
    assert.equal(daemonPasswordSource({ home: storeHome, env: {} }), "none");

    const written = writeDaemonPassword("secret-pass-1\r\n", { home: storeHome });
    assert.deepEqual(written, { configured: true, path: p });
    assert.equal(existsSync(p), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(p).mode & 0o777, 0o600);
    }
    assert.equal(readDaemonPassword({ home: storeHome, env: {} }), "secret-pass-1");
    assert.equal(daemonPasswordSource({ home: storeHome, env: {} }), "file");

    // UTF-8 BOM + CRLF stripping
    writeFileSync(p, "\uFEFF  bom-pass-2 \r\n", "utf8");
    assert.equal(readDaemonPassword({ home: storeHome, env: {} }), "bom-pass-2");
    assert.equal(daemonPasswordSource({ home: storeHome, env: {} }), "file");

    // Env override takes precedence over file
    assert.equal(readDaemonPassword({ home: storeHome, env: { PASEO_DAEMON_PASSWORD: "  env-pass-3 " } }), "env-pass-3");
    assert.equal(daemonPasswordSource({ home: storeHome, env: { PASEO_DAEMON_PASSWORD: "  env-pass-3 " } }), "env");

    // Clear removes the file
    const cleared = writeDaemonPassword("", { home: storeHome });
    assert.deepEqual(cleared, { configured: false, path: p });
    assert.equal(existsSync(p), false);
    assert.equal(readDaemonPassword({ home: storeHome, env: {} }), "");
    assert.equal(daemonPasswordSource({ home: storeHome, env: {} }), "none");
  });

  test("isDaemonPasswordRequired reads ~/.paseo/config.json", () => {
    const cfgDir = mkdtempSync(join(home, "paseo-cfg-"));
    const cfgPath = join(cfgDir, "config.json");

    // Missing file -> false
    assert.equal(isDaemonPasswordRequired({ configPath: cfgPath }), false);

    // Invalid JSON -> false
    writeFileSync(cfgPath, "{not-json", "utf8");
    assert.equal(isDaemonPasswordRequired({ configPath: cfgPath }), false);

    // Empty password -> false
    writeFileSync(cfgPath, JSON.stringify({ daemon: { auth: { password: "" } } }), "utf8");
    assert.equal(isDaemonPasswordRequired({ configPath: cfgPath }), false);

    // Non-empty password -> true
    writeFileSync(cfgPath, "\uFEFF" + JSON.stringify({ daemon: { auth: { password: "my-daemon-password" } } }), "utf8");
    assert.equal(isDaemonPasswordRequired({ configPath: cfgPath }), true);
    assert.equal(isDaemonPasswordRequired({ paseoHome: cfgDir }), true);
  });

  test("probeDaemonPassword handles missing listen, auth failure, unreachable, and success", async () => {
    const noListen = await probeDaemonPassword("pw", { listen: null });
    assert.equal(noListen.ok, false);
    assert.equal(noListen.unreachable, true);
    assert.equal(noListen.authFailureReason, null);

    let closed = false;
    const okRes = await probeDaemonPassword("good-pw", {
      listen: { address: "127.0.0.1:6767", tls: false },
      clientFactory: (opts) => {
        assert.equal(opts.endpoint, "127.0.0.1:6767");
        assert.equal(opts.tls, false);
        assert.equal(opts.password, "good-pw");
        assert.deepEqual(opts.reconnect, { enabled: false });
        return {
          async connect() {},
          async close() {
            closed = true;
          },
        };
      },
    });
    assert.deepEqual(okRes, { ok: true, unreachable: false, authFailureReason: null });
    assert.equal(closed, true);

    const badPw = await probeDaemonPassword("bad-pw", {
      listen: { address: "127.0.0.1:6767", tls: false },
      clientFactory: () => ({
        getConnectionDetails: () => ({ authFailureReason: "incorrect_password" }),
        async connect() {
          throw new Error("Incorrect password");
        },
        async close() {},
      }),
    });
    assert.equal(badPw.ok, false);
    assert.equal(badPw.unreachable, false);
    assert.equal(badPw.authFailureReason, "incorrect_password");

    const unreachableRes = await probeDaemonPassword("any-pw", {
      listen: { address: "127.0.0.1:6767", tls: false },
      clientFactory: () => ({
        async connect() {
          throw new Error("ECONNREFUSED");
        },
        async close() {},
      }),
    });
    assert.equal(unreachableRes.ok, false);
    assert.equal(unreachableRes.unreachable, true);
    assert.equal(unreachableRes.authFailureReason, null);
  });

  test("inspectFirstRunStatus includes passwordRequired, passwordConfigured, passwordSource", async () => {
    const frHome = mkdtempSync(join(home, "fr-"));
    const frPaseo = mkdtempSync(join(home, "fr-paseo-"));
    writeFileSync(join(frPaseo, "config.json"), JSON.stringify({ daemon: { auth: { password: "req-pw" } } }), "utf8");
    writeDaemonPassword("configured-pw", { home: frHome });

    const status = await inspectFirstRunStatus({
      isListening: async () => true,
      probeVersions: false,
      daemonAuthOpts: { home: frHome, paseoHome: frPaseo, env: {} },
    });
    assert.equal(status.paseo.passwordRequired, true);
    assert.equal(status.paseo.passwordConfigured, true);
    assert.equal(status.paseo.passwordSource, "file");
  });
});

describe("/__vibesquad/paseo/daemon-auth HTTP endpoints", () => {
  let srv;
  let base;
  let token;
  let probeHandler = async () => ({ ok: true, unreachable: false, authFailureReason: null });
  const apiHome = mkdtempSync(join(home, "api-home-"));
  const apiPaseo = mkdtempSync(join(home, "api-paseo-"));

  before(async () => {
    writeFileSync(join(apiPaseo, "config.json"), JSON.stringify({ daemon: { auth: { password: "server-secret" } } }), "utf8");
    resetLocalTokenForTest();
    token = getLocalToken();
    const mw = createVibesquadMiddleware(root, {
      daemonAuthOpts: { home: apiHome, paseoHome: apiPaseo, env: {} },
      probeDaemonPassword: (candidate, opts) => probeHandler(candidate, opts),
    });
    srv = createServer((req, res) =>
      mw(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  after(async () => {
    await stopPushWatcher().catch(() => {});
    if (srv) await new Promise((r) => srv.close(r));
  });

  test("GET /__vibesquad/paseo/daemon-auth requires X-VS-Token and returns status (with optional includePassword=1)", async () => {
    const unauth = await fetch(`${base}/__vibesquad/paseo/daemon-auth`);
    assert.equal(unauth.status, 403);

    const res = await fetch(`${base}/__vibesquad/paseo/daemon-auth`, {
      headers: { "X-VS-Token": token },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: true,
      required: true,
      configured: false,
      source: "none",
    });
    assert.equal("password" in body, false);
  });

  test("POST /__vibesquad/paseo/daemon-auth validates probe before writing and supports clear", async () => {
    // Seed an initial password on disk to verify failed probes do not overwrite it
    writeDaemonPassword("initial-good-pw", { home: apiHome });

    // 1. Wrong password -> 401 and does NOT overwrite existing file
    probeHandler = async () => ({
      ok: false,
      unreachable: false,
      authFailureReason: "incorrect_password",
      error: "Incorrect password",
    });
    const wrongRes = await fetch(`${base}/__vibesquad/paseo/daemon-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VS-Token": token },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(wrongRes.status, 401);
    const wrongBody = await wrongRes.json();
    assert.equal(wrongBody.ok, false);
    assert.equal(wrongBody.authFailureReason, "incorrect_password");
    assert.equal(readDaemonPassword({ home: apiHome, env: {} }), "initial-good-pw");

    // 2. Unreachable daemon -> 503 and does NOT write file
    writeDaemonPassword("", { home: apiHome });
    probeHandler = async () => ({
      ok: false,
      unreachable: true,
      authFailureReason: null,
      error: "Paseo daemon unreachable",
    });
    const unreachRes = await fetch(`${base}/__vibesquad/paseo/daemon-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VS-Token": token },
      body: JSON.stringify({ password: "new-password" }),
    });
    assert.equal(unreachRes.status, 503);
    const unreachBody = await unreachRes.json();
    assert.equal(unreachBody.ok, false);
    assert.equal(unreachBody.unreachable, true);
    assert.equal(readDaemonPassword({ home: apiHome, env: {} }), "");

    // 3. Valid password -> 200, writes daemon-password, readDaemonPassword returns it
    probeHandler = async (candidate) => {
      assert.equal(candidate, "verified-secret-pw");
      return { ok: true, unreachable: false, authFailureReason: null };
    };
    const okRes = await fetch(`${base}/__vibesquad/paseo/daemon-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VS-Token": token },
      body: JSON.stringify({ password: "  verified-secret-pw \n" }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.deepEqual(okBody, {
      ok: true,
      required: true,
      configured: true,
      source: "file",
      verified: true,
    });
    assert.equal(readDaemonPassword({ home: apiHome, env: {} }), "verified-secret-pw");

    // GET with ?includePassword=1 returns the stored password to local owner
    const withPwRes = await fetch(`${base}/__vibesquad/paseo/daemon-auth?includePassword=1`, {
      headers: { "X-VS-Token": token },
    });
    assert.equal(withPwRes.status, 200);
    const withPwBody = await withPwRes.json();
    assert.equal(withPwBody.password, "verified-secret-pw");

    // 4. { clear: true } -> removes file, returns configured: false
    const clearRes = await fetch(`${base}/__vibesquad/paseo/daemon-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VS-Token": token },
      body: JSON.stringify({ clear: true }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.deepEqual(clearBody, {
      ok: true,
      required: true,
      configured: false,
      source: "none",
      cleared: true,
    });
    assert.equal(existsSync(daemonPasswordPath(apiHome)), false);
    assert.equal(readDaemonPassword({ home: apiHome, env: {} }), "");
  });
});
