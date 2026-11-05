// Security phase B, S3: owner trust on the loopback listener needs the per-install local token
// (x-vibesquad-token header or vs_local cookie). Without it a loopback caller is read-only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-sec-s3-"));
process.env.VIBESQUAD_HOME = home;
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const localToken = await import("../server/local-token.mjs");
const { server: loopbackServer } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const rootDir = join(import.meta.dirname, "..");

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}
const json = (r) => JSON.parse(r.body);

describe("local token file", () => {
  test("created once as 64 hex chars, reused, and a malformed file is replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-s3-token-"));
    try {
      const file = join(dir, "local-token");
      assert.equal(localToken.readLocalToken(file), null);
      const t = localToken.ensureLocalToken(file);
      assert.match(t, /^[0-9a-f]{64}$/);
      assert.equal(readFileSync(file, "utf8").trim(), t);
      assert.equal(localToken.ensureLocalToken(file), t, "second start reuses the token");
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(localToken.localTokenHeaders(file), { "x-vibesquad-token": t });
      writeFileSync(file, "not-a-token");
      const t2 = localToken.ensureLocalToken(file);
      assert.match(t2, /^[0-9a-f]{64}$/);
      assert.notEqual(t2, t);
      assert.deepEqual(localToken.localTokenHeaders(join(dir, "missing")), {}, "no token: no header, so an old server sees nothing new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the server's token lives in VIBESQUAD_HOME and is a locked-down home secret", () => {
    const t = auth.getLocalToken();
    assert.equal(localToken.readLocalToken(join(home, "local-token")), t);
    const chmods = [];
    auth.lockDownVibesquadHome({ home: "/h", platform: "linux", lock: () => {}, mkdir: () => {}, exists: () => true, chmod: (f, m) => chmods.push([f.replace(/\\/g, "/"), m]) });
    assert.ok(chmods.some(([f, m]) => f === "/h/local-token" && m === 0o600));
  });

  test("server startup creates it after locking the home dir", () => {
    const src = readFileSync(new URL("../server/serve.mjs", import.meta.url), "utf8");
    const main = src.slice(src.indexOf("if (isMain) {"));
    assert.ok(main.indexOf("lockDownVibesquadHome()") < main.indexOf("getLocalToken()"));
    assert.ok(main.indexOf("getLocalToken()") < main.indexOf("server.listen("));
  });
});

describe("loopback API: owner vs read-only", () => {
  let srv;
  let port;
  let token;
  before(async () => {
    token = auth.getLocalToken();
    srv = createServer(api.createVibesquadMiddleware(rootDir));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(() => new Promise((ok) => srv.close(ok)));

  const postLog = (headers) =>
    call(port, "/__vibesquad/vs-log", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ team: "demo", type: "metric", text: "s3" }) });

  test("no token: GET passes", async () => {
    assert.equal((await call(port, "/__vibesquad/vs-log?team=demo")).status, 200);
    assert.equal((await call(port, "/__vibesquad/settings")).status, 200);
  });

  test("no token: every mutating method gets 403 with a clear JSON error", async () => {
    const r = await postLog({});
    assert.equal(r.status, 403);
    assert.equal(json(r).readOnly, true);
    assert.match(json(r).error, /read-only.*local token/);
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      assert.equal((await call(port, "/api/teams", { method })).status, 403, method);
    }
    assert.equal((await call(port, "/__vibesquad/settings", { method: "POST", headers: { "content-type": "application/json" }, body: '{"lanEnabled":true}' })).status, 403);
  });

  test("header token: owner", async () => {
    const r = await postLog({ "x-vibesquad-token": token });
    assert.equal(r.status, 200, r.body);
    assert.equal(json(r).ok, true);
  });

  test("bad or short token: 403", async () => {
    assert.equal((await postLog({ "x-vibesquad-token": "0".repeat(64) })).status, 403);
    assert.equal((await postLog({ "x-vibesquad-token": token.slice(0, 10) })).status, 403);
    assert.equal((await postLog({ cookie: "vs_local=" + "0".repeat(64) })).status, 403);
    assert.equal((await postLog({ cookie: `vs_local=${token}` })).status, 403, "the raw token is not the cookie value");
  });

  test("the token never helps a foreign Host or Origin", async () => {
    assert.equal((await postLog({ "x-vibesquad-token": token, host: "evil.example" })).status, 403);
    assert.equal((await postLog({ "x-vibesquad-token": token, origin: "http://evil.example" })).status, 403);
  });

  test("gated GETs need the token too", async () => {
    for (const path of ["/__vibesquad/paseo/pair", "/__vibesquad/push/vapid-public-key", "/__vibesquad/paseo/providers/diagnostic?provider=x", "/__vibesquad/paseo/providers/models?provider=x", "/__vibesquad/paseo/usage?refresh=1", "/__vibesquad/paseo/surface", "/__vibesquad/local-image?path=x.png"]) {
      const r = await call(port, path);
      assert.equal(r.status, 403, path);
      assert.equal(json(r).readOnly, true, path);
    }
    assert.equal(api.isGatedRead("/__vibesquad/paseo/usage", "/__vibesquad/paseo/usage"), false);
    assert.equal(api.isGatedRead("/__vibesquad/teams"), false);
    const vapid = await call(port, "/__vibesquad/push/vapid-public-key", { headers: { "x-vibesquad-token": token } });
    assert.equal(vapid.status, 200);
  });

  test("auth status and health say which access the caller has", async () => {
    assert.equal(json(await call(port, "/__vibesquad/auth/status")).localAccess, "read-only");
    assert.equal(json(await call(port, "/__vibesquad/auth/status", { headers: { "x-vibesquad-token": token } })).localAccess, "owner");
    assert.equal(json(await call(port, "/__vibesquad/health")).localAccess, "read-only");
  });

  const nonceFromServer = async () => {
    const r = await call(port, "/__vibesquad/local-login/nonce", { method: "POST", headers: { "x-vibesquad-token": token } });
    assert.equal(r.status, 200, r.body);
    const body = json(r);
    assert.match(body.nonce, /^[0-9a-f]{32}$/);
    assert.equal(body.path, `/__vibesquad/local-login?t=${body.nonce}`);
    assert.ok(!r.body.includes(token));
    return body.nonce;
  };

  test("local-login: a fresh nonce sets an HttpOnly SameSite=Strict session cookie and redirects; the cookie is owner", async () => {
    const r = await call(port, `/__vibesquad/local-login?t=${await nonceFromServer()}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    const setCookie = String(r.headers["set-cookie"]);
    assert.match(setCookie, /^vs_local=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Max-Age|Expires/i, "session cookie");
    assert.ok(!setCookie.includes(token), "cookie value is derived, not the header secret");
    const cookie = setCookie.split(";")[0];
    const browser = { cookie, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0" };
    assert.equal((await postLog(browser)).status, 200);
    assert.equal(json(await call(port, "/__vibesquad/auth/status", { headers: browser })).localAccess, "owner");
  });

  test("local-login refuses a bad or missing t, and the master token itself, and sets no cookie", async () => {
    for (const q of ["", "?t=", "?t=nope", `?t=${"f".repeat(32)}`, `?t=${token}`]) {
      const r = await call(port, `/__vibesquad/local-login${q}`);
      assert.equal(r.status, 403, q);
      assert.equal(r.headers["set-cookie"], undefined, q);
    }
    assert.equal((await call(port, `/__vibesquad/local-login?t=${await nonceFromServer()}`, { method: "POST" })).status, 405);
    assert.equal((await call(port, `/__vibesquad/local-login?t=${await nonceFromServer()}`, { headers: { host: "evil.example" } })).status, 403);
  });

  test("a nonce works once", async () => {
    const n = await nonceFromServer();
    assert.equal((await call(port, `/__vibesquad/local-login?t=${n}`)).status, 302);
    const again = await call(port, `/__vibesquad/local-login?t=${n}`);
    assert.equal(again.status, 403);
    assert.equal(again.headers["set-cookie"], undefined);
  });

  test("a nonce expires", async () => {
    const n = auth.mintLocalLoginNonce(5);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await call(port, `/__vibesquad/local-login?t=${n}`)).status, 403);
    assert.equal((await call(port, `/__vibesquad/local-login?t=${auth.mintLocalLoginNonce()}`)).status, 302, "an in-process nonce (serve.mjs --open) works");
  });

  test("the nonce endpoint needs the header token: no token, a bad one, the cookie or GET all fail", async () => {
    const login = await call(port, `/__vibesquad/local-login?t=${auth.mintLocalLoginNonce()}`);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    for (const headers of [{}, { "x-vibesquad-token": "0".repeat(64) }, { cookie, origin: `http://127.0.0.1:${port}` }, { "x-vibesquad-token": token, host: "evil.example" }]) {
      const r = await call(port, "/__vibesquad/local-login/nonce", { method: "POST", headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.ok(!/[0-9a-f]{32}/.test(r.body));
    }
    assert.equal((await call(port, "/__vibesquad/local-login/nonce", { headers: { "x-vibesquad-token": token } })).status, 405);
  });

  test("requestLocalLoginUrl (vs open, a second --open) gets a nonce URL, never the token", async () => {
    const url = await localToken.requestLocalLoginUrl({ port, file: join(home, "local-token") });
    assert.match(url, new RegExp(`^http://localhost:${port}/__vibesquad/local-login\\?t=[0-9a-f]{32}$`));
    assert.ok(!url.includes(token));
    assert.equal((await call(port, new URL(url).pathname + new URL(url).search)).status, 302);
    await assert.rejects(localToken.requestLocalLoginUrl({ port, file: join(home, "missing") }), /no local token/);
  });
});

describe("loopback /ws upgrade", () => {
  let upstream;
  let upstreamHits = 0;
  const sockets = new Set();
  let port;
  let token;
  before(async () => {
    token = auth.getLocalToken();
    upstream = createTcpServer((s) => {
      upstreamHits++;
      sockets.add(s);
      s.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
    process.env.PASEO_DAEMON = `127.0.0.1:${upstream.address().port}`;
    await new Promise((ok) => loopbackServer.listen(0, "127.0.0.1", ok));
    port = loopbackServer.address().port;
  });
  after(async () => {
    delete process.env.PASEO_DAEMON;
    for (const s of sockets) s.destroy();
    loopbackServer.closeAllConnections();
    await new Promise((ok) => loopbackServer.close(ok));
    await new Promise((ok) => upstream.close(ok));
  });

  const upgrade = (headers) =>
    new Promise((ok, fail) => {
      const s = connect(port, "127.0.0.1", () => {
        sockets.add(s);
        let raw = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n`;
        for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
        s.write(raw + "\r\n");
      });
      let data = "";
      s.on("data", (c) => (data += c));
      s.on("close", () => ok(data.split("\r\n")[0]));
      s.on("error", fail);
    });

  test("no token: refused, even with a loopback Origin", async () => {
    assert.match(await upgrade({}), /403/);
    assert.match(await upgrade({ Origin: `http://127.0.0.1:${port}` }), /403/);
    assert.match(await upgrade({ "x-vibesquad-token": "0".repeat(64) }), /403/);
    assert.equal(upstreamHits, 0);
  });

  test("token header or vs_local cookie reaches the daemon; a foreign Origin never does", async () => {
    assert.match(await upgrade({ Origin: "http://evil.example", "x-vibesquad-token": token }), /403/);
    assert.equal(upstreamHits, 0);
    assert.match(await upgrade({ "x-vibesquad-token": token }), /101/);
    const r = await call(port, `/__vibesquad/local-login?t=${auth.mintLocalLoginNonce()}`);
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    assert.match(await upgrade({ Origin: `http://127.0.0.1:${port}`, Cookie: cookie }), /101/);
    assert.equal(upstreamHits, 2);
  });

  test("a second `serve.mjs --open` while the server runs gets a nonce URL from it (no TDZ crash, no token on argv)", async (t) => {
    // If the child ever misses the running server it falls through to a full startup: sandbox the vs shims
    // (installVsShim writes under APPDATA / the home dir) and keep it from starting a Paseo daemon.
    const sandbox = mkdtempSync(join(tmpdir(), "vs-s3-open-"));
    const childHome = join(sandbox, "vshome");
    mkdirSync(childHome, { recursive: true });
    writeFileSync(join(childHome, "settings.json"), JSON.stringify({ startPaseoWithVibeSquad: false }));
    writeFileSync(join(childHome, "local-token"), readFileSync(join(home, "local-token")));
    t.after(() => rmSync(sandbox, { recursive: true, force: true }));
    // Async: this process hosts the running server the child must reach.
    const child = await new Promise((ok, fail) => {
      const c = spawn(process.execPath, [join(rootDir, "server", "serve.mjs"), "--open"], {
        env: { ...process.env, VIBESQUAD_HOME: childHome, USERPROFILE: sandbox, HOME: sandbox, APPDATA: join(sandbox, "appdata"), VIBESQUAD_PORT: String(port), VIBESQUAD_TEST_OPEN_PRINT: "1" },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => c.kill(), 30_000);
      c.on("error", fail);
      c.on("close", (status) => {
        clearTimeout(timer);
        ok({ status, stdout, stderr });
      });
    });
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr, /ReferenceError/);
    const url = /VIBESQUAD_OPEN_URL=(\S+)/.exec(child.stdout)?.[1];
    assert.match(url ?? "", new RegExp(`^http://localhost:${port}/__vibesquad/local-login\\?t=[0-9a-f]{32}$`), child.stdout);
    assert.ok(!url.includes(token));
    const u = new URL(url);
    assert.equal((await call(port, u.pathname + u.search)).status, 302, "the running server minted it");
  });
});

describe("UNC / device paths never reach the filesystem", () => {
  let srv;
  let port;
  let token;
  before(async () => {
    token = auth.getLocalToken();
    srv = createServer(api.createVibesquadMiddleware(rootDir));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(() => new Promise((ok) => srv.close(ok)));
  const UNC = ["\\\\attacker\\share\\x", "//attacker/share/x", "\\\\?\\UNC\\attacker\\share\\x", "\\\\.\\pipe\\x"];

  test("isUncLikePath", () => {
    for (const p of UNC) assert.equal(api.isUncLikePath(p), true, p);
    for (const p of ["C:\\x", "/home/x", "x/y", "", undefined]) assert.equal(api.isUncLikePath(p), false, String(p));
  });

  test("local-image refuses UNC paths and file:// URLs to another host", () => {
    for (const p of [...UNC.map((u) => u + ".png"), "file://attacker/share/x.png"]) assert.equal(api.resolveAllowedImage(p, [tmpdir()]), null, p);
  });

  test("workspace-package-scripts: UNC is 400, and a path outside the roots is 403 before any existence check", async () => {
    for (const p of UNC) {
      const r = await call(port, `/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(p)}`, { headers: { "x-vibesquad-token": token } });
      assert.equal(r.status, 400, p);
    }
    const missing = join(tmpdir(), "vs-s3-definitely-missing-dir");
    const r = await call(port, `/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(missing)}`, { headers: { "x-vibesquad-token": token } });
    assert.equal(r.status, 403, "allowlist runs before existsSync");
  });

  test("attach refuses a UNC cwd or source file, and checks the allowlist before touching cwd", async () => {
    const post = (body) => call(port, "/__vibesquad/attach", { method: "POST", headers: { "content-type": "application/json", "x-vibesquad-token": token }, body: JSON.stringify(body) });
    for (const p of UNC) assert.equal((await post({ cwd: p, files: ["a"] })).status, 400, p);
    assert.equal((await post({ cwd: join(tmpdir(), "vs-s3-missing-cwd"), files: ["a"] })).status, 403);
    for (const p of UNC) assert.equal((await post({ cwd: rootDir, files: [p] })).status, 403, p);
  });
});
