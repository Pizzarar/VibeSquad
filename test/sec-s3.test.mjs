// Security phase B, S3: owner trust on the loopback listener needs the per-install local token
// (x-vibesquad-token header or vs_local cookie). Without it a loopback caller is read-only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
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
    for (const path of ["/__vibesquad/paseo/pair", "/__vibesquad/push/vapid-public-key", "/__vibesquad/paseo/providers/diagnostic?provider=x", "/__vibesquad/paseo/providers/models?provider=x", "/__vibesquad/paseo/usage?refresh=1"]) {
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

  test("local-login: a good t sets an HttpOnly SameSite=Strict cookie and redirects; the cookie is owner", async () => {
    const r = await call(port, `/__vibesquad/local-login?t=${token}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    const setCookie = String(r.headers["set-cookie"]);
    assert.match(setCookie, /^vs_local=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.ok(!setCookie.includes(token), "cookie value is derived, not the header secret");
    const cookie = setCookie.split(";")[0];
    const browser = { cookie, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0" };
    assert.equal((await postLog(browser)).status, 200);
    assert.equal(json(await call(port, "/__vibesquad/auth/status", { headers: browser })).localAccess, "owner");
  });

  test("local-login refuses a bad or missing t and sets no cookie", async () => {
    for (const q of ["", "?t=", "?t=nope", `?t=${"f".repeat(64)}`]) {
      const r = await call(port, `/__vibesquad/local-login${q}`);
      assert.equal(r.status, 403, q);
      assert.equal(r.headers["set-cookie"], undefined, q);
    }
    assert.equal((await call(port, `/__vibesquad/local-login?t=${token}`, { method: "POST" })).status, 405);
    assert.equal((await call(port, `/__vibesquad/local-login?t=${token}`, { headers: { host: "evil.example" } })).status, 403);
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
    const r = await call(port, `/__vibesquad/local-login?t=${token}`);
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    assert.match(await upgrade({ Origin: `http://127.0.0.1:${port}`, Cookie: cookie }), /101/);
    assert.equal(upstreamHits, 2);
  });
});
