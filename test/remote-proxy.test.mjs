// Block R2-1: vs.http remote proxy RPC (plugin/server/remote-proxy*.ts) + browser fetch shim (src/remoteTransport.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  REMOTE_ALLOW,
  REMOTE_BLOCKED,
  REMOTE_MAX_BODY_BYTES,
  REMOTE_TIMEOUT_MS,
  decideProxyRequest,
  normalizeProxyPath,
} from "../plugin/server/remote-proxy-rules.ts";
import { makeVsHttpHandler, remoteEnabled, vsHttp, vsTokenHeaders } from "../plugin/server/remote-proxy.ts";
import { installRemoteTransport, isRemoteMode, proxiedPath } from "../src/remoteTransport.ts";
import { loadUserSettings, saveUserSettings } from "../server/user-settings.mjs";

const TOKEN = "a".repeat(64);
const home = mkdtempSync(join(tmpdir(), "vs-remote-proxy-"));
after(() => rmSync(home, { recursive: true, force: true }));
const setGate = (enabled) => writeFileSync(join(home, "settings.json"), JSON.stringify({ userName: "t", remote: { enabled } }));

describe("normalise", () => {
  const bad = [
    "",
    "teams",
    "//evil.example/api/teams",
    "http://evil.example/api/teams",
    "https:/api/teams",
    "/api/../__vibesquad/pair/start",
    "/__vibesquad/./teams",
    "/__vibesquad/inbox/../pair/start",
    "/__vibesquad/%2e%2e/pair/start",
    "/__vibesquad/%2E%2E%2Fpair",
    "/__vibesquad/teams%2f..%2fpair",
    "/__vibesquad\\..\\pair\\start",
    "/__vibesquad//teams",
    "/__vibesquad/teams#frag",
    "/__vibesquad/te ams",
    "/__vibesquad/teams\n",
    "/__vibesquad/te\u0000ams",
    "/__vibesquad/t\u00e9ams",
    "/@evil.example/api/teams",
    "/__vibesquad/log?team=a b",
    "/__vibesquad/log?team=%zz",
    "/__vibesquad/log?x=" + "a".repeat(3000),
  ];
  for (const p of bad) {
    test(`rejects ${JSON.stringify(p).slice(0, 60)}`, () => {
      assert.equal(normalizeProxyPath(p).ok, false);
      assert.equal(decideProxyRequest("GET", p).ok, false);
    });
  }
  test("rejects non-strings", () => {
    for (const p of [undefined, null, 1, {}, ["/api/teams"]]) assert.equal(normalizeProxyPath(p).ok, false);
  });
  test("keeps an encoded query verbatim and trims a trailing slash", () => {
    assert.deepEqual(normalizeProxyPath("/__vibesquad/log?team=a%20b&x=1"), { ok: true, pathname: "/__vibesquad/log", search: "?team=a%20b&x=1" });
    assert.deepEqual(normalizeProxyPath("/api/teams/"), { ok: true, pathname: "/api/teams", search: "" });
  });
});

describe("allowlist", () => {
  test("allows the UI's read and squad endpoints", () => {
    for (const [p, m] of [
      ["/api/teams", "GET"],
      ["/api/teams", "PUT"],
      ["/__vibesquad/teams", "POST"],
      ["/__vibesquad/inbox/triage", "POST"],
      ["/__vibesquad/log?team=core", "GET"],
      ["/__vibesquad/brainstorm-summary?lane=a", "GET"],
      ["/__vibesquad/settings", "GET"],
      ["/__vibesquad/paseo/providers/models?provider=claude", "GET"],
      ["/__vibesquad/paseo/plugins", "get"],
    ]) {
      const d = decideProxyRequest(m, p);
      assert.equal(d.ok, true, `${m} ${p}: ${d.error}`);
    }
  });
  const blocked = [
    "/__vibesquad/first-run/status",
    "/__vibesquad/first-run/install-paseo",
    "/__vibesquad/paseo/daemon",
    "/__vibesquad/paseo/raw/open",
    "/__vibesquad/paseo/raw/restore",
    "/__vibesquad/paseo/pair",
    "/__vibesquad/paseo/hub",
    "/__vibesquad/pair/start",
    "/pair",
    "/__vibesquad/push/subscribe",
    "/__vibesquad/push/vapid-public-key",
    "/__vibesquad/devices",
    "/__vibesquad/devices/revoke",
    "/__vibesquad/local-image?path=C:/Users/x/.ssh/id_rsa",
    "/__vibesquad/local-login",
    "/__vibesquad/remove-team-worktrees",
    "/__vibesquad/desktop/update.json",
    "/__vibesquad/attach",
    "/__vibesquad/attach-files",
    "/__vibesquad/profiles/import",
    "/ca.crt",
  ];
  for (const p of blocked) {
    test(`blocks ${p}`, () => {
      for (const m of ["GET", "POST"]) {
        const d = decideProxyRequest(m, p);
        assert.equal(d.ok, false);
        assert.equal(d.code, "blocked", `${m} ${p} -> ${d.code}`);
      }
    });
  }
  test("no allowlisted path is also blocked", () => {
    for (const p of Object.keys(REMOTE_ALLOW)) assert.equal(decideProxyRequest("GET", p).ok, true, p);
    assert.ok(REMOTE_BLOCKED.length > 10);
  });
  test("deny by default: unknown endpoints and non-API paths", () => {
    for (const p of ["/__vibesquad/unknown", "/api/profiles", "/", "/index.html", "/ws", "/__vibesquad", "/api", "/__proto__", "/constructor"]) {
      const d = decideProxyRequest("GET", p);
      assert.equal(d.ok, false, p);
    }
  });
  test("write-protected endpoints are read-only", () => {
    for (const p of ["/__vibesquad/settings", "/__vibesquad/paseo/plugins", "/__vibesquad/paseo/surface", "/__vibesquad/profiles"]) {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(decideProxyRequest(m, p).code, "method", `${m} ${p}`);
    }
  });
  test("method filter", () => {
    for (const m of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "", undefined, 1, "GET "]) {
      assert.equal(decideProxyRequest(m, "/api/teams").code, "method", String(m));
    }
  });
});

describe("contract", () => {
  test("input parse rejects extra fields (no header/host override) and non-string body", async () => {
    await assert.rejects(vsHttp.input.parseAsync({ method: "GET", path: "/api/teams", headers: { host: "x" } }), /unexpected field headers/);
    await assert.rejects(vsHttp.input.parseAsync({ method: "GET", path: "/api/teams", url: "http://x" }), /unexpected field url/);
    await assert.rejects(vsHttp.input.parseAsync({ method: "POST", path: "/api/teams", body: { a: 1 } }), /body must be a string/);
    await assert.rejects(vsHttp.input.parseAsync(null));
    assert.deepEqual(await vsHttp.input.parseAsync({ method: "GET", path: "/api/teams" }), { method: "GET", path: "/api/teams" });
    assert.equal(vsHttp.name, "vs.http");
  });
  test("caps and timeout values", () => {
    assert.equal(REMOTE_MAX_BODY_BYTES, 512 * 1024);
    assert.equal(REMOTE_TIMEOUT_MS, 10_000);
  });
});

describe("gate + token files", () => {
  test("gate is off when settings are missing, malformed or not exactly true", () => {
    const h = mkdtempSync(join(tmpdir(), "vs-remote-gate-"));
    try {
      assert.equal(remoteEnabled(h), false);
      writeFileSync(join(h, "settings.json"), "{not json");
      assert.equal(remoteEnabled(h), false);
      writeFileSync(join(h, "settings.json"), JSON.stringify({ remote: { enabled: "true" } }));
      assert.equal(remoteEnabled(h), false);
      writeFileSync(join(h, "settings.json"), "\uFEFF" + JSON.stringify({ remote: { enabled: true } }));
      assert.equal(remoteEnabled(h), true);
      assert.deepEqual(vsTokenHeaders(h), {});
      writeFileSync(join(h, "local-token"), "short\n");
      assert.deepEqual(vsTokenHeaders(h), {});
      writeFileSync(join(h, "local-token"), TOKEN + "\n");
      assert.deepEqual(vsTokenHeaders(h), { "x-vibesquad-token": TOKEN });
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
  test("saveUserSettings keeps remote and never takes it from a patch", () => {
    const h = mkdtempSync(join(tmpdir(), "vs-remote-settings-"));
    try {
      saveUserSettings({ userName: "a", remote: { enabled: true } }, h);
      assert.equal(JSON.parse(readFileSync(join(h, "settings.json"), "utf8")).remote, undefined);
      writeFileSync(join(h, "settings.json"), JSON.stringify({ userName: "a", remote: { enabled: true } }));
      saveUserSettings({ userName: "b", lanEnabled: true, remote: { enabled: false } }, h);
      const saved = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
      assert.deepEqual(saved.remote, { enabled: true });
      assert.equal(saved.userName, "b");
      assert.deepEqual(loadUserSettings(h).remote, { enabled: true });
      assert.equal(remoteEnabled(h), true);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("handler against a fake loopback VS server", () => {
  let server;
  let port;
  const seen = [];
  before(async () => {
    writeFileSync(join(home, "local-token"), TOKEN);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith("/__vibesquad/log")) {
          res.setHeader("set-cookie", "s=1");
          res.setHeader("x-internal", "secret");
          res.setHeader("etag", '"r1"');
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ ok: true, url: req.url }));
        }
        if (req.url === "/api/teams") {
          res.statusCode = req.method === "PUT" ? 409 : 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          return res.end(JSON.stringify({ echo: body }));
        }
        if (req.url === "/__vibesquad/inbox") {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ big: "x".repeat(REMOTE_MAX_BODY_BYTES) }));
        }
        if (req.url === "/__vibesquad/vs-log") {
          // Chunked, no content-length: the streaming cap must catch it.
          res.setHeader("content-type", "text/plain");
          for (let i = 0; i < 70; i++) res.write("y".repeat(8192));
          return res.end();
        }
        if (req.url === "/__vibesquad/handoff") return; // hang: timeout case
        if (req.url === "/__vibesquad/profiles") {
          res.setHeader("content-type", "application/octet-stream");
          return res.end(Buffer.from([0, 1, 2]));
        }
        if (req.url === "/__vibesquad/teams") {
          res.statusCode = 302;
          res.setHeader("location", "http://evil.example/");
          return res.end();
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const handler = (extra = {}) => makeVsHttpHandler({ port, home, ...extra });

  test("gate off: rejects without fetching", async () => {
    setGate(false);
    const n = seen.length;
    await assert.rejects(handler()({ method: "GET", path: "/api/teams" }), /remote access is off/);
    let fetched = false;
    await assert.rejects(
      handler({ fetch: async () => ((fetched = true), new Response("")) })({ method: "GET", path: "/api/teams" }),
      /remote access is off/,
    );
    assert.equal(fetched, false);
    assert.equal(seen.length, n);
  });

  test("gate on: GET forwards path + query with only the token header, returns a header subset", async () => {
    setGate(true);
    const out = await handler()({ method: "GET", path: "/__vibesquad/log?team=a%20b" });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { ok: true, url: "/__vibesquad/log?team=a%20b" });
    assert.deepEqual(out.headers, { "content-type": "application/json", etag: '"r1"' });
    const req = seen.at(-1);
    assert.equal(req.headers["x-vibesquad-token"], TOKEN);
    assert.equal(req.headers.host, `127.0.0.1:${port}`);
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.cookie, undefined);
  });

  test("POST/PUT forward the body as JSON and pass through the status", async () => {
    setGate(true);
    const out = await handler()({ method: "put", path: "/api/teams", body: '{"a":1}' });
    assert.equal(out.status, 409);
    assert.deepEqual(JSON.parse(out.body), { echo: '{"a":1}' });
    assert.equal(seen.at(-1).method, "PUT");
    assert.equal(seen.at(-1).headers["content-type"], "application/json");
  });

  test("blocked and unknown paths never reach the server", async () => {
    setGate(true);
    const n = seen.length;
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/pair/start" }), /blocked remotely/);
    await assert.rejects(handler()({ method: "GET", path: "/__vibesquad/%2e%2e/pair" }), /disallowed characters/);
    await assert.rejects(handler()({ method: "GET", path: "/api/../__vibesquad/devices" }), /traversal/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/settings", body: '{"lanEnabled":true}' }), /POST not available/);
    await assert.rejects(handler()({ method: "OPTIONS", path: "/api/teams" }), /method not allowed/);
    assert.equal(seen.length, n);
  });

  test("request body over the cap is refused before fetching", async () => {
    setGate(true);
    const n = seen.length;
    await assert.rejects(handler()({ method: "POST", path: "/api/teams", body: "z".repeat(REMOTE_MAX_BODY_BYTES + 1) }), /request body too large/);
    assert.equal(seen.length, n);
  });

  test("response over the cap is refused (content-length and streamed)", async () => {
    setGate(true);
    await assert.rejects(handler()({ method: "GET", path: "/__vibesquad/inbox" }), /response too large/);
    await assert.rejects(handler()({ method: "GET", path: "/__vibesquad/vs-log" }), /response too large/);
  });

  test("timeout", async () => {
    setGate(true);
    await assert.rejects(handler({ timeoutMs: 200 })({ method: "GET", path: "/__vibesquad/handoff" }), /timed out after 200 ms/);
  });

  test("non-text responses are not proxied; redirects are not followed", async () => {
    setGate(true);
    await assert.rejects(handler()({ method: "GET", path: "/__vibesquad/profiles" }), /non-text response/);
    const out = await handler()({ method: "GET", path: "/__vibesquad/teams" });
    assert.equal(out.status, 302);
    assert.equal(out.headers.location, undefined);
  });

  test("server down: clear error", async () => {
    setGate(true);
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const dead = probe.address().port;
    await new Promise((r) => probe.close(r));
    await assert.rejects(makeVsHttpHandler({ port: dead, home })({ method: "GET", path: "/api/teams" }), /unreachable on 127\.0\.0\.1/);
  });

  test("the vibesquad plugin registers vs.http and the registered handler runs end to end", async () => {
    setGate(true);
    const { createPlugin } = await import("../plugin/index.server.ts");
    const handles = new Map();
    const fakeServer = {
      before: () => () => {},
      on: () => () => {},
      handle(contract, fn) {
        handles.set(contract.name, { contract, fn });
      },
    };
    const prev = { home: process.env.VIBESQUAD_HOME, port: process.env.VIBESQUAD_PORT };
    process.env.VIBESQUAD_HOME = home;
    process.env.VIBESQUAD_PORT = String(port);
    const stop = createPlugin({ startWatcher: false })(fakeServer);
    try {
      const reg = handles.get("vs.http");
      assert.ok(reg, "vs.http registered");
      // Same path the daemon takes: input.parseAsync -> handler -> output.parseAsync.
      const input = await reg.contract.input.parseAsync({ method: "GET", path: "/__vibesquad/log?team=x" });
      const out = await reg.contract.output.parseAsync(await reg.fn(input, { paseo: {} }));
      assert.equal(out.status, 200);
      assert.equal(seen.at(-1).headers["x-vibesquad-token"], TOKEN);
    } finally {
      stop();
      for (const [k, v] of Object.entries({ VIBESQUAD_HOME: prev.home, VIBESQUAD_PORT: prev.port })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("fetch shim", () => {
  const ORIGIN = "https://vs.example";
  function target() {
    const calls = [];
    const t = {
      location: { origin: ORIGIN },
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response("native");
      },
    };
    return { t, calls };
  }

  test("isRemoteMode: off by default, on with ?remote=1 or the localStorage flag", () => {
    assert.equal(isRemoteMode({ search: "" }, null), false);
    assert.equal(isRemoteMode({ search: "?remote=0" }, { getItem: () => null }), false);
    assert.equal(isRemoteMode({ search: "?remote=1" }, null), true);
    assert.equal(isRemoteMode({ search: "" }, { getItem: (k) => (k === "vs.remote" ? "1" : null) }), true);
    assert.equal(isRemoteMode({ search: "" }, { getItem: () => { throw new Error("denied"); } }), false);
  });

  test("proxiedPath: same-origin VS API only", () => {
    assert.equal(proxiedPath("/__vibesquad/teams", ORIGIN), "/__vibesquad/teams");
    assert.equal(proxiedPath("/api/teams?x=1", ORIGIN), "/api/teams?x=1");
    assert.equal(proxiedPath(`${ORIGIN}/api/teams`, ORIGIN), "/api/teams");
    assert.equal(proxiedPath("https://other.example/api/teams", ORIGIN), null);
    assert.equal(proxiedPath("/assets/app.js", ORIGIN), null);
    assert.equal(proxiedPath("/apiteams", ORIGIN), null);
  });

  test("routes VS calls through invoke, passes everything else through, and uninstalls", async () => {
    const { t, calls } = target();
    const original = t.fetch;
    const invoked = [];
    const uninstall = installRemoteTransport(async (input) => {
      invoked.push(input);
      return { status: 201, headers: { "content-type": "application/json" }, body: '{"ok":true}' };
    }, t);
    assert.notEqual(t.fetch, original);

    const res = await t.fetch("/__vibesquad/inbox/triage", { method: "post", body: '{"id":1}', headers: { "x-evil": "1" } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(invoked, [{ method: "POST", path: "/__vibesquad/inbox/triage", body: '{"id":1}' }]);

    const r2 = await t.fetch(new Request(`${ORIGIN}/api/teams`, { method: "PUT", body: "{}" }));
    assert.equal(r2.status, 201);
    assert.deepEqual(invoked[1], { method: "PUT", path: "/api/teams", body: "{}" });

    assert.equal(await (await t.fetch("https://cdn.example/x.js")).text(), "native");
    assert.equal(await (await t.fetch("/index.html")).text(), "native");
    assert.equal(calls.length, 2);

    await assert.rejects(t.fetch("/api/teams", { method: "POST", body: new Blob(["x"]) }), /only string request bodies/);

    uninstall();
    assert.equal(t.fetch, original);
  });

  test("maps null-body statuses, propagates RPC errors, honours abort", async () => {
    const { t } = target();
    let mode = "204";
    installRemoteTransport(async () => {
      if (mode === "204") return { status: 204, headers: {}, body: "" };
      if (mode === "err") throw new Error("vs.http: blocked remotely: /__vibesquad/pair/start");
      return new Promise(() => {});
    }, t);
    assert.equal((await t.fetch("/api/teams", { method: "DELETE" })).status, 204);
    mode = "err";
    await assert.rejects(t.fetch("/__vibesquad/pair/start", { method: "POST" }), /blocked remotely/);
    mode = "hang";
    const ac = new AbortController();
    const p = t.fetch("/api/teams", { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, { name: "AbortError" });
  });
});
