import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-public-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_DAEMON = "127.0.0.1:1"; // never reach a real daemon from tests
process.env.PASEO_HOME = join(home, "paseo");

const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { qrSvg } = await import("../server/qr.mjs");
const { savePushSubscription } = await import("../server/push.mjs");

after(() => rmSync(home, { recursive: true, force: true }));

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code) {
      this.statusCode = code;
    },
    end(b) {
      this.body += b ?? "";
    },
  };
  return res;
}

function fakeReq({ url = "/", method = "GET", headers = {}, local = false, remote = "203.0.113.9" } = {}) {
  return {
    url,
    method,
    headers: { host: local ? "127.0.0.1:4180" : "example.test", ...headers },
    socket: { localAddress: local ? "127.0.0.1" : "10.9.8.7", remoteAddress: local ? "127.0.0.1" : remote },
    on() {},
  };
}

describe("repo hygiene", () => {
  test("no personal identifiers in tracked or untracked-unignored files", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: rootDir, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const parts = [["fu", "gma"], ["au", "bross"], ["gma", "il"], ["escape-from", "-idle"], ["rosser", "logic"], ["192[.]", "168[.]"], ["100[.]", "83[.]"], ["[.]", "nord"]];
    const personal = new RegExp(parts.map((p) => p.join("")).join("|"), "i");
    const name = new RegExp("\\b" + ["Au", "b"].join("") + "\\b", "i");
    const legacyLabel = new RegExp("needs-" + ["au", "b"].join(""), "i");
    const skip = /\.(png|ico|exe|woff2?|icns|jpg|webp)$/i;
    const hits = [];
    for (const f of files) {
      if (skip.test(f) || !existsSync(join(rootDir, f))) continue;
      let text;
      try {
        text = readFileSync(join(rootDir, f), "utf8");
      } catch {
        continue;
      }
      if (personal.test(text) || name.test(text) || legacyLabel.test(text)) hits.push(f);
    }
    assert.deepEqual(hits, []);
  });
});

describe("third-party licenses", () => {
  const text = readFileSync(join(rootDir, "public", "THIRD-PARTY-LICENSES.txt"), "utf8").replace(/\r\n/g, "\n");
  test("credits Paseo under Apache-2.0", () => {
    assert.match(text, /@getpaseo\/client@[\d.]+\s+Apache-2\.0/);
    assert.match(text, /@getpaseo\/protocol@[\d.]+\s+Apache-2\.0/);
    assert.ok(text.includes("Copyright (c) 2025-present Mohamed Boudra"));
  });
  test("embeds the full Apache License 2.0 text", () => {
    assert.ok(text.includes("Apache License\n                           Version 2.0, January 2004"));
    assert.ok(text.includes("END OF TERMS AND CONDITIONS"));
    assert.ok(text.includes("MIT License"));
  });
});

describe("pairing in an isolated home", () => {
  test("QR svg renders", async () => {
    const svg = await qrSvg("https://example.test/pair?code=123456");
    assert.match(svg, /<svg/);
  });

  test("code is created, redeemed once, and yields a SameSite=Strict cookie that authenticates", () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq({ url: `/pair?code=${code}` }), res);
    assert.equal(res.statusCode, 302);
    const cookie = res.headers["set-cookie"];
    assert.match(cookie, /SameSite=Strict/);
    const token = cookie.split(";")[0];
    assert.ok(auth.authenticate(fakeReq({ headers: { cookie: token } })));
    assert.equal(auth.authenticate(fakeReq({ headers: { cookie: "vs_device=wrong" } })), null);
    const again = fakeRes();
    auth.handlePairRedeem(fakeReq({ url: `/pair?code=${code}` }), again);
    assert.equal(again.statusCode, 401);
  });

  test("/pair is rate limited to 5 attempts per minute per IP", () => {
    auth.resetPairRateLimitForTest();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = fakeRes();
      auth.handlePairRedeem(fakeReq({ url: "/pair?code=000000", remote: "198.51.100.7" }), res);
      codes.push(res.statusCode);
    }
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(codes[5], 429);
  });

  test("failed attempts from other IPs don't wipe active codes", () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    for (let i = 0; i < 5; i++) auth.handlePairRedeem(fakeReq({ url: "/pair?code=999999", remote: `198.51.100.${i + 10}` }), fakeRes());
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq({ url: `/pair?code=${code}`, remote: "198.51.100.99" }), res);
    assert.equal(res.statusCode, 302);
  });
});

describe("request guard", () => {
  const mw = api.createVibesquadMiddleware(rootDir);

  test("non-loopback callers without a token get 401 on API routes", () => {
    for (const url of ["/__vibesquad/inbox", "/__vibesquad/log?team=x", "/__vibesquad/handoff", "/api/teams", "/__vibesquad/vs-log?team=x"]) {
      const res = fakeRes();
      mw(fakeReq({ url, method: url.endsWith("handoff") ? "POST" : "GET" }), res, () => assert.fail("fell through"));
      assert.equal(res.statusCode, 401, url);
    }
  });

  test("unauthenticated health is minimal", () => {
    const res = fakeRes();
    mw(fakeReq({ url: "/__vibesquad/health" }), res, () => {});
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ["distReady", "ok"]);
  });

  describe("loopback server", () => {
    let server;
    let port;
    before(async () => {
      server = createServer(mw);
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
      port = server.address().port;
    });
    after(() => server.close());

    const call = (path, { method = "GET", headers = {}, body, timeoutMs } = {}) =>
      new Promise((ok, fail) => {
        const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => ok({ status: res.statusCode, body: data }));
        });
        req.on("error", fail);
        if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
        req.end(body);
      });

    test("plain loopback clients (CLI, tests) work without Origin", async () => {
      const r = await call("/__vibesquad/vs-log?team=demo");
      assert.equal(r.status, 200);
    });

    test("cross-origin browser requests are rejected", async () => {
      assert.equal((await call("/__vibesquad/vs-log?team=demo", { headers: { origin: "http://evil.example" } })).status, 403);
      assert.equal((await call("/__vibesquad/vs-log?team=demo", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
      const post = await call("/__vibesquad/inbox", {
        method: "POST",
        headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0" },
        body: "{}",
      });
      assert.equal(post.status, 403);
    });

    test("same-origin browser requests are allowed", async () => {
      const r = await call("/__vibesquad/vs-log?team=demo", { headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      assert.equal(r.status, 200);
    });

    test("foreign Host header is rejected", async () => {
      assert.equal((await call("/__vibesquad/vs-log?team=demo", { headers: { host: "evil.example" } })).status, 403);
    });

    test("vs-log rejects path traversal in team", async () => {
      const r = await call(`/__vibesquad/vs-log?team=${encodeURIComponent("../../etc")}`);
      assert.equal(r.status, 400);
    });

    test("oversized bodies are refused with 413", async () => {
      const r = await call("/__vibesquad/inbox", { method: "POST", headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) } });
      assert.equal(r.status, 413);
    });

    test("handoff ignores injected baseHome / oldLead", async () => {
      const evil = mkdtempSync(join(tmpdir(), "vs-evil-"));
      try {
        // The daemon is unreachable in tests, so the handler may hang or reset; only the side effects matter.
        await call("/__vibesquad/lead-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseHome: evil, profilesPath: join(evil, "p.json"), oldLead: { id: "x", cwd: evil, labels: {} }, agentId: "x" }),
          timeoutMs: 1500,
        }).catch(() => {});
        assert.deepEqual(readdirSync(evil), []);
      } finally {
        rmSync(evil, { recursive: true, force: true });
      }
    });

    test("local-image answers 404 for everything it refuses", async () => {
      const missing = await call(`/__vibesquad/local-image?path=${encodeURIComponent(join(home, "nope.png"))}`);
      const existsButDenied = await call(`/__vibesquad/local-image?path=${encodeURIComponent(join(rootDir, "package.json"))}`);
      assert.equal(missing.status, 404);
      assert.equal(existsButDenied.status, 404);
      assert.equal(missing.body, existsButDenied.body);
    });
  });

  test("sanitizeBody-equivalent: internal keys never reach the handoff helpers", () => {
    assert.ok(api.sanitizeBody);
    const clean = api.sanitizeBody({ baseHome: "x", oldLead: {}, oldAgent: {}, daemonClient: {}, execSpawn: 1, teamsFilePath: "y", profilesPath: "z", team: "t" });
    assert.deepEqual(clean, { team: "t" });
  });
});

describe("local origin helper", () => {
  test("tauri origins count as loopback", () => {
    for (const o of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://[::1]:4180"]) assert.ok(auth.isLoopbackOrigin(o), o);
    assert.equal(auth.isLoopbackOrigin("http://evil.example"), false);
    assert.equal(auth.isLoopbackOrigin("http://127.0.0.1.evil.example"), false);
  });
});

describe("push subscription SSRF", () => {
  const keys = { p256dh: "BPubKey", auth: "authSecret" };
  test("rejects non-https and private endpoints", () => {
    for (const endpoint of [
      "http://push.example.com/abc",
      "https://127.0.0.1/abc",
      "https://localhost/abc",
      "https://10.0.0.5/abc",
      "https://172.20.1.1/abc",
      "https://169.254.169.254/latest",
      "https://100.100.1.1/abc",
      "https://[::1]/abc",
      "https://intranet/abc",
    ]) {
      assert.throws(() => savePushSubscription({ endpoint, keys }), /public https|valid URL/, endpoint);
    }
  });
  test("accepts a public https endpoint", () => {
    const r = savePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys });
    assert.equal(r.ok, true);
  });
});

describe("WebSocket CSWSH upgrade guard", () => {
  let srv;
  let wsPort;
  before(async () => {
    const mod = await import("../server/serve.mjs");
    srv = mod.server;
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    wsPort = srv.address().port;
  });
  after(() => srv?.close());

  const tryUpgrade = (headers = {}) =>
    new Promise((resolveResp, rejectResp) => {
      const req = request({
        host: "127.0.0.1",
        port: wsPort,
        path: "/ws",
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow
          "Sec-WebSocket-Version": "13",
          ...headers,
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolveResp(res.statusCode);
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolveResp(101);
      });
      req.on("error", rejectResp);
      req.end();
    });

  test("rejects WebSocket upgrade from evil Origin with 403 (CSWSH check)", async () => {
    assert.equal(await tryUpgrade({ Origin: "http://evil.example" }), 403);
  });

  test("rejects unauthenticated WebSocket upgrade without Origin with 403", async () => {
    assert.equal(await tryUpgrade({}), 403);
  });
});

describe("needs-you rename", () => {
  const legacyUser = "au" + "b";
  const legacyNeeds = "needs-" + legacyUser;

  test("git grep -iw for the legacy owner name has 0 hits", () => {
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-iwI", legacyUser], { cwd: rootDir, encoding: "utf8" });
    } catch (e) {
      assert.equal(e.status, 1, "git grep should exit 1 (no matches)");
    }
    assert.equal(out, "");
  });

  test("legacy needs label is recognised by attentionOf", async () => {
    const { attentionOf } = await import("../src/teams.ts");
    const att = attentionOf({ id: "a1", status: "idle", labels: { [legacyNeeds]: "legacy decision needed" } });
    assert.deepEqual(att, { tone: "needs-you", reason: "legacy decision needed" });
  });

  test("legacy needs label is still recognised by push notifications", async () => {
    const { evaluateAgentTransition } = await import("../server/push.mjs");
    const notes = evaluateAgentTransition(null, { id: "a1", title: "Legacy", labels: { [legacyNeeds]: "legacy decision needed" } }, new Set());
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, "needs-you");
    assert.equal(notes[0].title, "VibeSquad · Needs you");
  });

  describe("/__vibesquad/settings", () => {
    let server;
    let port;
    before(async () => {
      server = createServer(api.createVibesquadMiddleware(rootDir));
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
      port = server.address().port;
    });
    after(() => server.close());

    const call = (method, body) =>
      new Promise((ok, fail) => {
        const req = request({ host: "127.0.0.1", port, path: "/__vibesquad/settings", method, headers: { "content-type": "application/json" } }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on("error", fail);
        req.end(body ? JSON.stringify(body) : undefined);
      });

    test("defaults to 'you', then persists a new name to settings.json", async () => {
      assert.deepEqual((await call("GET")).body, { ok: true, userName: "you", lanEnabled: false, activeLanEnabled: false, exposedIps: [] });
      const saved = await call("POST", { userName: "Alex" });
      assert.deepEqual(saved.body, { ok: true, userName: "Alex", lanEnabled: false, activeLanEnabled: false, exposedIps: [] });
      assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).userName, "Alex");
      assert.deepEqual((await call("GET")).body, { ok: true, userName: "Alex", lanEnabled: false, activeLanEnabled: false, exposedIps: [] });
    });
  });
});
