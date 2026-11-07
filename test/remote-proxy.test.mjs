// Block R2-1: vs.http remote proxy RPC (plugin/server/remote-proxy*.ts) + browser fetch shim (src/remoteTransport.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  ENDPOINT_WRITE_LIMITS_PER_MIN,
  PINNED_LANE_KEYS,
  PINNED_TEAM_KEYS,
  REMOTE_ALLOW,
  REMOTE_BLOCKED,
  REMOTE_BUDGET_PER_MIN,
  REMOTE_MAX_BODY_BYTES,
  REMOTE_MAX_IN_FLIGHT,
  REMOTE_MAX_TERMINALS,
  REMOTE_TERMINAL_POLL_CHARS,
  REMOTE_OWNER_READS,
  REMOTE_SPAWN_TIMEOUT_MS,
  REMOTE_TIMEOUT_MS,
  REMOTE_BODY_POLICY,
  REMOTE_FORBIDDEN_BODY_KEYS,
  REMOTE_WRITES_CLOSED,
   checkLaneExists,
  checkRemoteBody,
  createRateLimiter,
  decideProxyRequest,
  isAllowedRoute,
  pinTeamsRegistry,
  proxyTimeoutFor,
  normalizeProxyPath,
  redactBody,
  scrubResponseBody,
} from "../plugin/server/remote-proxy-rules.ts";
import { REMOTE_MAX_BINARY_BYTES, makeVsHttpHandler, remoteEnabled, vsHttp, vsTokenHeaders } from "../plugin/server/remote-proxy.ts";
import { installRemoteTransport, isRemoteMode, proxiedPath } from "../src/remoteTransport.ts";
import { loadUserSettings, saveUserSettings } from "../server/user-settings.mjs";

const TOKEN = "a".repeat(64);
// Every byte value, so a text-decoding round trip would corrupt it.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
const home = mkdtempSync(join(tmpdir(), "vs-remote-proxy-"));
// Test-only allow map (the production map now opens these too; kept so plumbing tests don't depend on it).
const WRITE_ALLOW = { ...REMOTE_ALLOW, "/api/teams": ["GET", "PUT"], "/__vibesquad/teams": ["GET", "POST"] };
// What the fake loopback server answers on GET /api/teams (the registry the proxy checks writes against).
const REGISTRY = { teams: [{ id: "sq", name: "Squad", paths: ["Proj"], lanes: [{ id: "lane1", name: "One", lastProfile: "P" }] }], revision: "r1" };
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
  test("allows the UI's read endpoints", () => {
    for (const [p, m] of [
      ["/api/teams", "GET"],
      ["/__vibesquad/inbox?teamId=a", "GET"],
      ["/__vibesquad/log?team=core", "GET"],
      ["/__vibesquad/brainstorm-summary?lane=a", "GET"],
      ["/__vibesquad/settings", "GET"],
      ["/__vibesquad/paseo/usage", "GET"],
      ["/__vibesquad/paseo/plugins", "get"],
    ]) {
      const d = decideProxyRequest(m, p);
      assert.equal(d.ok, true, `${m} ${p}: ${d.error}`);
    }
  });
  const blocked = [
    "/__vibesquad/first-run/status",
    "/__vibesquad/paseo/daemon",
    "/__vibesquad/paseo/raw/open",
    "/__vibesquad/paseo/raw/restore",
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
    for (const [p, methods] of Object.entries(REMOTE_ALLOW)) assert.equal(decideProxyRequest(methods[0], p).ok, true, p);
    assert.ok(REMOTE_BLOCKED.length > 10);
  });
  test("deny by default: unknown endpoints and non-API paths", () => {
    for (const p of ["/__vibesquad/unknown", "/api/profiles", "/", "/index.html", "/ws", "/__vibesquad", "/api", "/__proto__", "/constructor"]) {
      const d = decideProxyRequest("GET", p);
      assert.equal(d.ok, false, p);
    }
  });
  test("every reopened write has a body policy, and every policy belongs to an open write", () => {
    for (const [p, methods] of Object.entries(REMOTE_ALLOW)) {
      if (methods.some((m) => m !== "GET")) assert.ok(REMOTE_BODY_POLICY[p], `${p} has a body policy`);
      for (const m of ["PATCH", "DELETE"]) assert.equal(decideProxyRequest(m, p).code, "method", `${m} ${p}`);
    }
    for (const p of Object.keys(REMOTE_BODY_POLICY)) assert.ok(REMOTE_ALLOW[p]?.some((m) => m !== "GET"), `${p} policy without a write`);
  });
  test("closed writes: lead-handoff, confirm and open-topic stay unreachable, each with a reason; Block 4 reopened handoff POST and brainstorm-restart", () => {
    for (const p of ["/__vibesquad/lead-handoff", "/__vibesquad/lead-handoff/confirm", "/__vibesquad/inbox/open-topic"]) {
      assert.equal(decideProxyRequest("POST", p).code, "not-allowed", p);
      assert.equal(isAllowedRoute("POST", p), false, p);
      assert.equal(REMOTE_BODY_POLICY[p], undefined, p);
      assert.ok(REMOTE_WRITES_CLOSED[p], p);
    }
    for (const p of ["/__vibesquad/handoff", "/__vibesquad/brainstorm-restart"]) {
      assert.equal(decideProxyRequest("POST", p).ok, true, p);
      assert.equal(REMOTE_BODY_POLICY[p].registry, "lane", p);
      assert.equal(REMOTE_WRITES_CLOSED[p], undefined, p);
    }
    for (const p of [...Object.keys(REMOTE_WRITES_CLOSED)]) assert.ok(REMOTE_WRITES_CLOSED[p].length > 20, p);
    assert.equal(decideProxyRequest("POST", "/__vibesquad/settings").code, "method");
    for (const p of [
      "/__vibesquad/paseo/surface",
      "/__vibesquad/paseo/providers/models",
      "/__vibesquad/paseo/providers/diagnostic",
      "/__vibesquad/files",
      "/__vibesquad/search",
    ]) {
      assert.equal(decideProxyRequest("GET", p).ok, false, p);
    }
  });
  test("write plumbing still works with an injected allow map", () => {
    assert.equal(decideProxyRequest("PUT", "/api/teams", WRITE_ALLOW).ok, true);
    assert.equal(decideProxyRequest("PATCH", "/api/teams", WRITE_ALLOW).code, "method");
    assert.equal(decideProxyRequest("POST", "/__vibesquad/pair/start", { "/__vibesquad/pair/start": ["POST"] }).code, "blocked");
  });
  test("usage: refresh is stripped from the query", () => {
    const strip = (q) => decideProxyRequest("GET", `/__vibesquad/paseo/usage${q}`).search;
    assert.equal(strip("?refresh=1"), "");
    assert.equal(strip("?a=1&refresh=1&b=2"), "?a=1&b=2");
    assert.equal(strip("?%72efresh=1"), "");
    assert.equal(strip("?refresh"), "");
    assert.equal(decideProxyRequest("GET", "/__vibesquad/log?refresh=1").search, "?refresh=1");
  });
  test("no allowlisted GET is an S3 gated read (token-less GETs work; S3 backs the allowlist)", async () => {
    const { isGatedRead } = await import("../server/vibesquad-api.mjs");
    for (const p of Object.keys(REMOTE_ALLOW).filter((k) => REMOTE_ALLOW[k].includes("GET") && !REMOTE_OWNER_READS.includes(k))) {
      for (const q of ["", "?refresh=1"]) {
        const d = decideProxyRequest("GET", p + q);
        assert.equal(d.ok, true, p + q);
        assert.equal(isGatedRead(d.pathname, d.pathname + d.search), false, p + q);
      }
    }
  });
  test("B8: fs/list|resolve|read|watch are GET-only remotely and are exactly the gated reads that carry the token", async () => {
    const { isGatedRead } = await import("../server/vibesquad-api.mjs");
    const fs = ["/__vibesquad/fs/list", "/__vibesquad/fs/resolve", "/__vibesquad/fs/read", "/__vibesquad/fs/watch"];
    assert.deepEqual([...REMOTE_OWNER_READS].sort(), [...fs].sort());
    for (const p of fs) {
      assert.equal(decideProxyRequest("GET", `${p}?cwd=C:/w&path=a.md`).ok, true, p);
      assert.equal(isGatedRead(p, p), true, `${p} is owner-gated server-side`);
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(decideProxyRequest(m, p).code, "method", `${m} ${p}`);
      assert.equal(decideProxyRequest("GET", `${p}/x`).code, "not-allowed", `${p}/x`);
      assert.equal(decideProxyRequest("GET", `${p}/../files`).code, "path", `${p}/../files`);
      assert.equal(decideProxyRequest("GET", `${p}%2F..%2Ffiles`).code, "path");
    }
    for (const p of ["/__vibesquad/files", "/__vibesquad/search", "/__vibesquad/files/x", "/__vibesquad/search/x"]) {
      assert.equal(decideProxyRequest("GET", p).ok, false, p);
      assert.equal(decideProxyRequest("GET", p).code, "blocked", p);
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
  test("caps, timeout and rate values", () => {
    assert.equal(REMOTE_MAX_BODY_BYTES, 512 * 1024);
    assert.equal(REMOTE_TIMEOUT_MS, 10_000);
    assert.equal(REMOTE_MAX_IN_FLIGHT, 4);
    assert.deepEqual(REMOTE_BUDGET_PER_MIN, { read: 120, write: 20, term: 1200 });
  });
});

describe("rate limiter", () => {
  test("at most 4 in flight; a release frees a slot", () => {
    const rl = createRateLimiter();
    const slots = [1, 2, 3, 4].map(() => rl.acquire("read"));
    assert.ok(slots.every((s) => s.ok));
    const fifth = rl.acquire("read");
    assert.equal(fifth.ok, false);
    assert.match(fifth.error, /too many requests in flight \(max 4\)/);
    slots[0].release();
    slots[0].release(); // idempotent
    assert.equal(rl.acquire("read").ok, true);
    assert.equal(rl.acquire("read").ok, false);
  });
  test("per-minute budget per kind, rolling window", () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ now: () => t });
    for (let i = 0; i < 120; i++) {
      const s = rl.acquire("read");
      assert.ok(s.ok, `read ${i}`);
      s.release();
    }
    const over = rl.acquire("read");
    assert.equal(over.ok, false);
    assert.match(over.error, /rate limited: 120 reads per minute, retry in 60 s/);
    const w = rl.acquire("write"); // separate budget
    assert.ok(w.ok);
    w.release();
    t += 60_000;
    assert.equal(rl.acquire("read").ok, true);
  });
});

describe("redaction", () => {
  const H = "C:\\Users\\Jordan";
  test("home path in every form and the bare username become ~", () => {
    const raw = JSON.stringify({ a: "C:\\Users\\Jordan\\projects\\x", b: "c:/users/jordan/.vibesquad", c: "by Jordan.", d: "JordanTool" });
    const out = redactBody(raw, H, "Jordan");
    assert.deepEqual(JSON.parse(out), { a: "~\\projects\\x", b: "~/.vibesquad", c: "by ~.", d: "JordanTool" });
    assert.equal(redactBody("C:\\Users\\Jordan\\a", H, "Jordan"), "~\\a");
    assert.equal(redactBody("/home/jordan/x", "/home/jordan", "jordan"), "~/x");
  });
  test("short or empty identities redact nothing", () => {
    assert.equal(redactBody("ab /x/ab", "/", "ab"), "ab /x/ab");
    assert.equal(redactBody("hello", "", ""), "hello");
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
          res.setHeader("content-type", "application/json; charset=utf-8");
          if (req.method === "GET") return res.end(JSON.stringify(REGISTRY));
          res.statusCode = 409;
          return res.end(JSON.stringify({ echo: body }));
        }
        if (req.url === "/__vibesquad/settings") {
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              ok: true,
              userName: "Jordan",
              dir: "C:\\Users\\Jordan\\.vibesquad",
              path: "C:\\Users\\Jordan\\.vibesquad\\settings.json",
              remote: { enabled: true },
            }),
          );
        }
        if (req.url.startsWith("/__vibesquad/paseo/usage")) {
          res.setHeader("content-type", "application/json");
          return res.end("{}");
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

  test("gate on: GET forwards path + query with no token or caller headers, returns a header subset", async () => {
    setGate(true);
    const out = await handler()({ method: "GET", path: "/__vibesquad/log?team=a%20b" });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { ok: true, url: "/__vibesquad/log?team=a%20b" });
    assert.deepEqual(out.headers, { "content-type": "application/json", etag: '"r1"' });
    const req = seen.at(-1);
    assert.equal(req.headers["x-vibesquad-token"], undefined);
    assert.equal(req.headers.host, `127.0.0.1:${port}`);
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.cookie, undefined);
  });

  test("production allowlist refuses writes before fetching", async () => {
    setGate(true);
    const n = seen.length;
    await assert.rejects(handler()({ method: "PUT", path: "/api/teams", body: "{}" }), /key required remotely: body\.teams \[403\]/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/inbox", body: '{"cwd":"C:/"}' }), /body key not allowed remotely: cwd \[403\]/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/inbox/open-topic", body: '{"cardId":"idea-1"}' }), /not available remotely.*\[403\]/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/brainstorm-restart", body: '{"reason":"start-brainstorm"}' }), /key required remotely: body\.laneId \[403\]/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/brainstorm-restart", body: '{"laneId":"lane1","profile":"P"}' }), /body key not allowed remotely: profile \[403\]/);
    await assert.rejects(handler()({ method: "POST", path: "/__vibesquad/lead-handoff", body: '{"agentId":"a"}' }), /not available remotely.*\[403\]/);
    assert.equal(seen.length, n);
  });

  test("writes (injected allow) forward the body as JSON with the S3 token and pass through the status", async () => {
    setGate(true);
    const sent = JSON.stringify({ teams: REGISTRY.teams, revision: "r1" });
    const out = await handler({ allow: WRITE_ALLOW })({ method: "put", path: "/api/teams", body: sent });
    assert.equal(out.status, 409);
    assert.deepEqual(JSON.parse(out.body), { echo: sent });
    assert.equal(seen.at(-2).method, "GET", "registry read first");
    assert.equal(seen.at(-2).headers["x-vibesquad-token"], undefined, "registry read carries no token");
    assert.equal(seen.at(-1).method, "PUT");
    assert.equal(seen.at(-1).headers["content-type"], "application/json");
    assert.equal(seen.at(-1).headers["x-vibesquad-token"], TOKEN);
  });

  test("responses are redacted; settings lose `remote` and `path`; usage loses refresh", async () => {
    setGate(true);
    const h = handler({ homeDir: "C:\\Users\\Jordan", userName: "Jordan" });
    const settings = await h({ method: "GET", path: "/__vibesquad/settings" });
    assert.deepEqual(JSON.parse(settings.body), { ok: true, userName: "~", dir: "~\\.vibesquad" });
    await h({ method: "GET", path: "/__vibesquad/paseo/usage?refresh=1" });
    assert.equal(seen.at(-1).url, "/__vibesquad/paseo/usage");
  });

  test("rate limit: 5th concurrent request is refused without fetching", async () => {
    setGate(true);
    const h = handler({ timeoutMs: 300 });
    const n = seen.length;
    const hung = [1, 2, 3, 4].map(() => h({ method: "GET", path: "/__vibesquad/handoff" }).catch((e) => e));
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(h({ method: "GET", path: "/api/teams" }), /too many requests in flight/);
    await Promise.all(hung);
    assert.equal(seen.length, n + 4);
    const ok = await h({ method: "GET", path: "/api/teams" });
    assert.equal(ok.status, 200);
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
    await assert.rejects(
      handler({ allow: WRITE_ALLOW })({ method: "PUT", path: "/api/teams", body: "z".repeat(REMOTE_MAX_BODY_BYTES + 1) }),
      /request body too large.*\[413\]/,
    );
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
      assert.equal(seen.at(-1).url, "/__vibesquad/log?team=x");
    } finally {
      stop();
      for (const [k, v] of Object.entries({ VIBESQUAD_HOME: prev.home, VIBESQUAD_PORT: prev.port })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("against the real VS middleware with S3", () => {
  test("token-less GET reads work; a gated read is refused; writes with the S3 token pass the owner check", async () => {
    const prevHome = process.env.VIBESQUAD_HOME;
    const h = mkdtempSync(join(tmpdir(), "vs-remote-s3-"));
    process.env.VIBESQUAD_HOME = h;
    writeFileSync(join(h, "settings.json"), JSON.stringify({ userName: "Owner", remote: { enabled: true } }));
    const prevTeams = process.env.VIBESQUAD_TEAMS_FILE;
    const teamsFile = join(h, "teams.json");
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: ["C:\\Users\\Owner\\proj"], lanes: [{ id: "l1", name: "One" }] }] }));
    const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
    const mw = createVibesquadMiddleware(h);
    const srv = createServer((req, res) => mw(req, res, () => ((res.statusCode = 404), res.end())));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const vs = makeVsHttpHandler({ port, home: h, allow: { ...REMOTE_ALLOW, "/api/teams": ["GET", "PUT"], "/__vibesquad/paseo/surface": ["GET"] } });
      const settings = await vs({ method: "GET", path: "/__vibesquad/settings" });
      assert.equal(settings.status, 200);
      const body = JSON.parse(settings.body);
      assert.equal(body.userName, "Owner");
      assert.equal("remote" in body, false);
      // Injected only to prove the backstop: S3 refuses a gated read sent without the token.
      const gated = await vs({ method: "GET", path: "/__vibesquad/paseo/surface" });
      assert.equal(gated.status, 403);
      // The token file now exists (the server created it on first use); a write carries it and gets past
      // the owner gate (409 from the handler's own revision check, not 403 read-only).
      const w = await vs({
        method: "PUT",
        path: "/api/teams",
        body: JSON.stringify({ teams: [{ id: "sq", name: "Squad", lanes: [{ id: "l1", name: "One" }] }], revision: "stale" }),
      });
      assert.notEqual(w.status, 403, w.body);
      // R2-5 end to end on the production allowlist: the remote GET shows the redacted path; echoing it back
      // renames the lane and keeps the real path on disk.
      const prod = makeVsHttpHandler({ port, home: h, homeDir: "C:\\Users\\Owner", userName: "Owner" });
      const got = JSON.parse((await prod({ method: "GET", path: "/api/teams" })).body);
      assert.deepEqual(got.teams[0].paths, ["~\\proj"]);
      got.teams[0].lanes[0].name = "Renamed";
      const put = await prod({ method: "PUT", path: "/api/teams", body: JSON.stringify({ teams: got.teams, revision: got.revision }) });
      assert.equal(put.status, 200, put.body);
      const disk = JSON.parse(readFileSync(teamsFile, "utf8"));
      assert.equal(disk.teams[0].lanes[0].name, "Renamed");
      assert.deepEqual(disk.teams[0].paths, ["C:\\Users\\Owner\\proj"]);
      got.teams[0].paths = ["Elsewhere"];
      const fresh = JSON.parse((await prod({ method: "GET", path: "/api/teams" })).body);
      await assert.rejects(prod({ method: "PUT", path: "/api/teams", body: JSON.stringify({ teams: got.teams, revision: fresh.revision }) }), /paths can't be changed remotely \[403\]/);
    } finally {
      if (prevTeams === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
      else process.env.VIBESQUAD_TEAMS_FILE = prevTeams;
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prevHome;
      rmSync(h, { recursive: true, force: true });
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

// Block R2-5: one row per reopened write. `ok` is a body the UI sends; each must pass, and each forbidden
// key (top level and nested), an unknown key, an oversize value and a wrong method must be refused.
const LANE_OK = { id: "lane1", name: "One", state: "pinned", lastProfile: "P" };
const ENDPOINTS = [
  { path: "/api/teams", method: "PUT", ok: { teams: [{ id: "sq", name: "Squad", color: "#fff", paths: ["Proj"], lanes: [LANE_OK] }], revision: "r1" }, big: { revision: "r".repeat(129) }, nest: (b, k) => (b.teams[0].lanes[0][k] = "x") },
  { path: "/__vibesquad/teams", method: "POST", ok: { teams: [{ id: "sq", lanes: [{ id: "lane1" }] }], revision: "r1", leadFlagTokens: 150000 }, big: { teams: Array.from({ length: 201 }, (_, i) => ({ id: `t${i}` })) }, nest: (b, k) => (b.teams[0][k] = "x") },
  { path: "/__vibesquad/inbox", method: "POST", ok: { text: "an idea", splitDump: false, laneId: "lane1" }, big: { text: "x".repeat(20_001) } },
  { path: "/__vibesquad/inbox/triage", method: "POST", ok: { action: "update", cardId: "idea-3", laneId: "lane1", patch: { status: "parked", summaryNote: "n" } }, big: { patch: { relatedReason: "x".repeat(501) } }, nest: (b, k) => (b.patch[k] = "x") },
  { path: "/__vibesquad/inbox/park-topic", method: "POST", ok: { cardId: "idea-3", agentId: "abc-123", summaryNote: "parked" }, big: { summaryNote: "x".repeat(4001) } },
  { path: "/__vibesquad/inbox/handoff-topic", method: "POST", ok: { cardId: "idea-3", agentId: "abc-123", planNote: "p", usedTokens: 1200 }, big: { planNote: "x".repeat(4001) } },
  { path: "/__vibesquad/log", method: "POST", ok: { team: "sq", lane: "lane1", type: "you", text: "hi", refs: ["a"] }, big: { text: "x".repeat(241) } },
  { path: "/__vibesquad/vs-log", method: "POST", ok: { teamId: "sq", laneId: "lane1", type: "metric", text: "m" }, big: { text: "x".repeat(2001) } },
  { path: "/__vibesquad/brainstorm-summary", method: "POST", ok: { laneId: "lane1", content: "# brief", revision: "abc" }, big: { content: "x".repeat(20_000) } },
  { path: "/__vibesquad/brainstorm-summary", method: "PUT", ok: { lane: "lane1", content: "# brief", revision: "abc" }, big: { content: "x".repeat(20_000) } },
  { path: "/__vibesquad/brainstorm-restart", method: "POST", ok: { reason: "start-brainstorm", mode: "quick-start", teamId: "sq", laneId: "lane1", laneName: "One" }, big: { laneName: "x".repeat(201) } },
  { path: "/__vibesquad/brainstorm-restart", method: "POST", ok: { reason: "manual", teamId: "sq", laneId: "lane1", agentId: "bs-1", usedTokens: 50000 }, big: { usedTokens: 100_000_001 } },
  { path: "/__vibesquad/handoff", method: "POST", ok: { team: "sq", lane: "lane1", agentId: "lead-1" }, big: { agentId: "x".repeat(65) } },
];
const clone = (v) => JSON.parse(JSON.stringify(v));
const bodyErr = (method, path, body) => checkRemoteBody(method, path, typeof body === "string" ? body : JSON.stringify(body));

describe("R2-5 body policy per endpoint", () => {
  for (const e of ENDPOINTS) {
    describe(`${e.method} ${e.path}`, () => {
      test("the UI's body passes and the method is open", () => {
        assert.equal(decideProxyRequest(e.method, e.path).ok, true);
        assert.deepEqual(bodyErr(e.method, e.path, e.ok), { ok: true, value: e.ok });
      });
      test("every forbidden key is refused with 403, top level and nested", () => {
        for (const k of REMOTE_FORBIDDEN_BODY_KEYS) {
          // Raw JSON so __proto__ is a real own key, as JSON.parse makes it.
          const top = bodyErr(e.method, e.path, `{"${k}":"x",${JSON.stringify(e.ok).slice(1)}`);
          assert.equal(top.ok, false, k);
          assert.equal(top.status, 403, k);
          const deep = clone(e.ok);
          let raw;
          if (e.nest && k !== "__proto__") {
            e.nest(deep, k);
            raw = JSON.stringify(deep);
          } else {
            raw = `{"wrap":{"inner":[{"${k}":"x"}]},${JSON.stringify(deep).slice(1)}`;
          }
          const r = bodyErr(e.method, e.path, raw);
          assert.equal(r.ok, false, `nested ${k}`);
          assert.equal(r.status, 403, `nested ${k}`);
          assert.match(r.error, new RegExp(`body key not allowed remotely: ${k}`), `nested ${k} caught by the deep scan`);
        }
      });
      test("unknown key, wrong type, oversize value and missing required key: 403; bad JSON: 400", () => {
        assert.match(bodyErr(e.method, e.path, { ...e.ok, sneaky: 1 }).error, /key not allowed remotely: body\.sneaky/);
        const big = bodyErr(e.method, e.path, { ...e.ok, ...e.big });
        assert.equal(big.ok, false);
        assert.equal(big.status, 403);
        const key = Object.keys(e.ok)[0];
        assert.equal(bodyErr(e.method, e.path, { ...e.ok, [key]: { nested: true } }).status, 403);
        for (const k of REMOTE_BODY_POLICY[e.path].require ?? []) {
          const { [k]: _drop, ...rest } = e.ok;
          assert.match(bodyErr(e.method, e.path, rest).error, new RegExp(`key required remotely: body\\.${k}`));
        }
        assert.equal(bodyErr(e.method, e.path, "[1]").status, 400);
        assert.equal(bodyErr(e.method, e.path, "{oops").status, 400);
      });
      test("wrong methods are refused", () => {
        for (const m of ["PATCH", "DELETE"]) assert.equal(decideProxyRequest(m, e.path).code, "method", m);
      });
    });
  }

  test("spawn config and titles can't ride inside a nested object; enums, caps and required laneId are checked", () => {
    const r = bodyErr("POST", "/__vibesquad/inbox/triage", { action: "update", cardId: "idea-1", laneId: "lane1", patch: { title: "x" } });
    assert.match(r.error, /body key not allowed remotely: title/);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox/open-topic", { cardId: "idea-1" }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/brainstorm-restart", { reason: "start-brainstorm" }).status, 403); // no laneId
    assert.equal(bodyErr("POST", "/__vibesquad/brainstorm-restart", { reason: "auto-hard-limit", laneId: "lane1" }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/brainstorm-restart", { reason: "provider-switch", laneId: "lane1" }).ok, true); // accepted
    assert.equal(bodyErr("POST", "/__vibesquad/log", { team: "sq", lane: "lane1", text: "t", type: "done" }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/log", { team: "../x", lane: "lane1", text: "t" }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox/triage", { action: "merge", laneId: "lane1", sourceIds: Array(101).fill("idea-1") }).status, 403);
    assert.equal(bodyErr("PUT", "/api/teams", { teams: [{ id: "sq", lanes: [{ id: "l", order: 1e9 }] }], revision: "r" }).ok, false);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox", { text: null, laneId: "lane1" }).status, 403);
    // Inbox ideas cap (max 20 items, each text <= 5000 chars) and brainstorm-summary cap (19,999 chars).
    assert.equal(bodyErr("POST", "/__vibesquad/inbox", { laneId: "lane1", ideas: Array(20).fill("ok") }).ok, true);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox", { laneId: "lane1", ideas: Array(21).fill("ok") }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox", { laneId: "lane1", ideas: ["x".repeat(5000)] }).ok, true);
    assert.equal(bodyErr("POST", "/__vibesquad/inbox", { laneId: "lane1", ideas: ["x".repeat(5001)] }).status, 403);
    assert.equal(bodyErr("POST", "/__vibesquad/brainstorm-summary", { laneId: "lane1", content: "x".repeat(19_999), revision: "r" }).ok, true);
    assert.equal(bodyErr("POST", "/__vibesquad/brainstorm-summary", { laneId: "lane1", content: "x".repeat(20_000), revision: "r" }).status, 403);
    // Requiring laneId / lane on lane-scoped writes:
    for (const [p, b] of [
      ["/__vibesquad/inbox", { text: "idea" }],
      ["/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-1" }],
      ["/__vibesquad/log", { team: "sq", text: "hi" }],
      ["/__vibesquad/vs-log", { teamId: "sq", text: "hi" }],
      ["/__vibesquad/brainstorm-summary", { content: "c", revision: "r" }],
    ]) {
      const res = bodyErr("POST", p, b);
      assert.equal(res.ok, false, p);
      assert.equal(res.status, 403, p);
    }
  });

  test("a write with no policy is refused even if an allow map opens it", () => {
    const r = checkRemoteBody("POST", "/__vibesquad/lead-handoff", '{"agentId":"a"}');
    assert.deepEqual(r, { ok: false, status: 403, error: "no remote body policy for /__vibesquad/lead-handoff" });
  });
});

describe("R2-5 registry checks", () => {
  const cur = {
    teams: [
      {
        id: "sq",
        name: "Squad",
        paths: ["C:\\Users\\Jo\\proj"],
        vibeMode: true,
        customTeamMeta: "keep-team",
        lanes: [
          { id: "l1", paths: ["A"], lastProfile: "P", worktree: "WT1", branch: "b1", aliases: ["old-l1"], customLaneMeta: "keep-lane" },
          { id: "l2" },
        ],
      },
    ],
  };
  const redact = (s) => redactBody(s, "C:\\Users\\Jo", "Jo");
  const body = (teams) => ({ teams, revision: "r" });

  test("teams: echoed (raw or redacted) or omitted pinned fields are forwarded as the disk values, preserving unknown fields", () => {
    assert.deepEqual(PINNED_TEAM_KEYS, ["paths", "path", "vibeMode"]);
    assert.ok(PINNED_LANE_KEYS.includes("worktree") && PINNED_LANE_KEYS.includes("branch") && PINNED_LANE_KEYS.includes("cwd"));
    const r = pinTeamsRegistry(body([{ id: "SQ", paths: ["~\\proj"], lanes: [{ id: "L1", name: "N" }, { id: "l2" }] }]), cur, redact);
    assert.equal(r.ok, true);
    assert.equal(r.value.teams[0].id, "sq", "canonical on-disk team id preserved");
    assert.deepEqual(r.value.teams[0].paths, ["C:\\Users\\Jo\\proj"]);
    assert.equal(r.value.teams[0].vibeMode, true);
    assert.equal(r.value.teams[0].customTeamMeta, "keep-team");
    assert.deepEqual(r.value.teams[0].lanes[0], {
      id: "l1",
      name: "N",
      paths: ["A"],
      lastProfile: "P",
      worktree: "WT1",
      branch: "b1",
      aliases: ["old-l1"],
      customLaneMeta: "keep-lane",
    });
    assert.equal("paths" in r.value.teams[0].lanes[1], false);
    const raw = pinTeamsRegistry(
      body([{ id: "sq", paths: ["C:\\Users\\Jo\\proj"], vibeMode: true, lanes: [{ id: "l1", paths: ["A"], lastProfile: "P" }, { id: "l2" }] }]),
      cur,
      redact,
    );
    assert.equal(raw.ok, true);
  });
  test("teams: changing paths/path/vibeMode/lastProfile, or setting them on a new team or lane, is 403", () => {
    const cases = [
      [{ id: "sq", paths: ["Other"] }, /team sq\.paths can't be changed/],
      [{ id: "sq", path: "Other" }, /team sq\.path can't be changed/],
      [{ id: "sq", vibeMode: false }, /RemoteDenied: team paths and vibeMode are pinned on host/],
      [{ id: "sq", lanes: [{ id: "l1", lastProfile: "Yolo" }, { id: "l2" }] }, /lane l1\.lastProfile can't be changed/],
      [{ id: "sq", lanes: [{ id: "l1" }, { id: "l2", paths: ["X"] }] }, /lane l2\.paths can't be changed/],
      [{ id: "sq", lanes: [{ id: "l1" }, { id: "l2" }, { id: "new", path: "X" }] }, /lane new\.path can't be set remotely on a new entry/],
      [{ id: "new-team", paths: ["X"] }, /team new-team\.paths can't be set remotely/],
      [{ id: "new-team", vibeMode: true }, /RemoteDenied: new remote teams cannot enable vibeMode/],
    ];
    for (const [team, re] of cases) {
      const r = pinTeamsRegistry(body([team]), cur, redact);
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
      assert.match(r.error, re);
    }
    assert.equal(
      pinTeamsRegistry(
        body([
          { id: "sq", lanes: [{ id: "l1" }, { id: "l2" }] },
          { id: "new-team", vibeMode: false, lanes: [{ id: "x", name: "pin" }] },
        ]),
        cur,
        redact,
      ).ok,
      true,
    );
  });
  test("teams: refuses deleting or reordering teams/lanes, caps new additions, prevents cross-team lane moves", () => {
    const twoTeams = {
      teams: [
        { id: "t1", name: "Team One", lanes: [{ id: "l1", name: "Lane 1" }, { id: "l2", name: "Lane 2" }] },
        { id: "t2", name: "Team Two", lanes: [{ id: "l3", name: "Lane 3" }] },
      ],
    };
    // Deleting team t2
    const delTeam = pinTeamsRegistry(body([twoTeams.teams[0]]), twoTeams);
    assert.equal(delTeam.ok, false);
    assert.match(delTeam.error, /cannot delete teams remotely/);
    // Reordering t2 before t1
    const reordTeam = pinTeamsRegistry(body([twoTeams.teams[1], twoTeams.teams[0]]), twoTeams);
    assert.equal(reordTeam.ok, false);
    assert.match(reordTeam.error, /cannot reorder existing teams remotely/);
    // Deleting lane l2 from t1
    const delLane = pinTeamsRegistry(body([{ id: "t1", lanes: [{ id: "l1" }] }, twoTeams.teams[1]]), twoTeams);
    assert.equal(delLane.ok, false);
    assert.match(delLane.error, /cannot delete lanes remotely/);
    // Reordering lanes l2 before l1 in t1
    const reordLane = pinTeamsRegistry(body([{ id: "t1", lanes: [{ id: "l2" }, { id: "l1" }] }, twoTeams.teams[1]]), twoTeams);
    assert.equal(reordLane.ok, false);
    assert.match(reordLane.error, /cannot reorder existing lanes remotely/);
    // > 1 new team per save
    const tooManyTeams = pinTeamsRegistry(
      body([...twoTeams.teams, { id: "t3", lanes: [] }, { id: "t4", lanes: [] }]),
      twoTeams,
    );
    assert.equal(tooManyTeams.ok, false);
    assert.match(tooManyTeams.error, /at most 1 new team per remote save/);
    // > 3 new lanes per save
    const tooManyLanes = pinTeamsRegistry(
      body([
        { id: "t1", lanes: [{ id: "l1" }, { id: "l2" }, { id: "n1" }, { id: "n2" }] },
        { id: "t2", lanes: [{ id: "l3" }, { id: "n3" }, { id: "n4" }] },
      ]),
      twoTeams,
    );
    assert.equal(tooManyLanes.ok, false);
    assert.match(tooManyLanes.error, /at most 3 new lanes per remote save/);
    // Moving / duplicating lane l2 into t2
    const crossMove = pinTeamsRegistry(
      body([
        twoTeams.teams[0],
        { id: "t2", lanes: [{ id: "l3" }, { id: "L2" }] },
      ]),
      twoTeams,
    );
    assert.equal(crossMove.ok, false);
    assert.equal(crossMove.status, 403);
  });
  test("unreadable registry fails closed (503)", () => {
    assert.equal(pinTeamsRegistry(body([]), null).status, 503);
    assert.equal(pinTeamsRegistry(body([]), { echo: "" }).status, 503);
    assert.equal(checkLaneExists({ laneId: "l1" }, null).status, 503);
  });
  test("lane checks: id or alias passes, team-lane ownership enforced, missing lane is 400 (never fail-open)", () => {
    assert.equal(checkLaneExists({ laneId: "L1" }, cur).ok, true);
    assert.equal(checkLaneExists({ lane: "old-l1" }, cur).ok, true);
    assert.equal(checkLaneExists({ teamId: "sq", laneId: "l1" }, cur).ok, true);
    assert.equal(checkLaneExists({ teamId: "unknown", laneId: "l1" }, cur).status, 403);
    assert.equal(checkLaneExists({ teamId: "sq", laneId: "ghost" }, cur).status, 403);
    assert.equal(checkLaneExists({ laneId: "ghost" }, cur).status, 403);
    assert.equal(checkLaneExists({ reason: "x" }, cur).status, 400);
    assert.equal(checkLaneExists({}, cur).status, 400);
  });
});

describe("R2-5 handler: reopened writes against a fake loopback server", () => {
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
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/teams" && req.method === "GET") return res.end(JSON.stringify(REGISTRY));
        res.end(JSON.stringify({ ok: true, echo: body, path: "C:\\Users\\Jordan\\secret\\file.jsonl", teamLogPath: "C:\\Users\\Jordan\\secret\\team.jsonl" }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  for (const e of ENDPOINTS) {
    test(`${e.method} ${e.path}: allowed body forwards with the token (not echoed back) and strips path/teamLogPath; refused bodies never fetch`, async () => {
      setGate(true);
      const h = makeVsHttpHandler({ port, home });
      const out = await h({ method: e.method, path: e.path, body: JSON.stringify(e.ok) });
      assert.equal(out.status, 200, out.body);
      const parsedOut = JSON.parse(out.body);
      assert.equal("path" in parsedOut, false, "path stripped from response");
      assert.equal("teamLogPath" in parsedOut, false, "teamLogPath stripped from response");
      const last = seen.at(-1);
      assert.equal(last.method, e.method);
      assert.equal(last.headers["x-vibesquad-token"], TOKEN);
      assert.ok(!JSON.stringify(out).includes(TOKEN), "token never in the response");
      const n = seen.length;
      await assert.rejects(h({ method: e.method, path: e.path, body: JSON.stringify({ ...e.ok, cwd: "C:/" }) }), /\[403\]/);
      await assert.rejects(h({ method: e.method, path: e.path, body: JSON.stringify({ ...e.ok, extra: 1 }) }), /\[403\]/);
      await assert.rejects(h({ method: "DELETE", path: e.path, body: JSON.stringify(e.ok) }), /\[405\]/);
      await assert.rejects(h({ method: e.method, path: e.path, body: "z".repeat(REMOTE_MAX_BODY_BYTES + 1) }), /\[413\]/);
      assert.equal(seen.length, n, "nothing reached the server");
    });
  }

  test("registry-checked writes: unknown lane, mismatched team/lane and changed paths are refused after only the registry read", async () => {
    setGate(true);
    const h = makeVsHttpHandler({ port, home });
    const n = seen.length;
    await assert.rejects(
      h({ method: "POST", path: "/__vibesquad/brainstorm-summary", body: '{"laneId":"ghost","content":"x","revision":"r"}' }),
      /lane ghost is not in teams\.json \[403\]/,
    );
    await assert.rejects(
      h({ method: "POST", path: "/__vibesquad/log", body: '{"team":"sq","lane":"ghost","text":"x"}' }),
      /lane "ghost" does not belong to team "sq" \[403\]/,
    );
    await assert.rejects(
      h({ method: "PUT", path: "/api/teams", body: JSON.stringify({ teams: [{ id: "sq", paths: ["Elsewhere"] }], revision: "r1" }) }),
      /team sq\.paths can't be changed remotely.*\[403\]/,
    );
    assert.deepEqual(seen.slice(n).map((r) => `${r.method} ${r.url}`), ["GET /api/teams", "GET /api/teams", "GET /api/teams"]);
    // Omitted pinned fields and unknown on-disk fields go out as the disk values.
    await h({ method: "PUT", path: "/api/teams", body: JSON.stringify({ teams: [{ id: "sq", name: "S2", lanes: [{ id: "lane1" }] }], revision: "r1" }) });
    assert.deepEqual(JSON.parse(seen.at(-1).body), {
      teams: [{ id: "sq", name: "S2", lanes: [{ id: "lane1", name: "One", lastProfile: "P" }], paths: ["Proj"] }],
      revision: "r1",
    });
  });

  test("write budget: per-endpoint cap (5 on /api/teams, 10 on /log) and global 20/min write budget", async () => {
    setGate(true);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /api/teams"], 5);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/brainstorm-summary"], 5);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/log"], 10);
    const hTeams = makeVsHttpHandler({ port, home });
    const teamsBody = JSON.stringify({ teams: REGISTRY.teams, revision: "r1" });
    for (let i = 0; i < 5; i++) await hTeams({ method: "POST", path: "/api/teams", body: teamsBody });
    await assert.rejects(hTeams({ method: "POST", path: "/api/teams", body: teamsBody }), /rate limited: 5 writes per minute on POST \/api\/teams.*\[429\]/);

    const hGlobal = makeVsHttpHandler({ port, home });
    const logBody = JSON.stringify({ team: "sq", lane: "lane1", text: "t" });
    const vsLogBody = JSON.stringify({ teamId: "sq", laneId: "lane1", text: "t" });
    for (let i = 0; i < 10; i++) await hGlobal({ method: "POST", path: "/__vibesquad/log", body: logBody });
    for (let i = 0; i < 10; i++) await hGlobal({ method: "POST", path: "/__vibesquad/vs-log", body: vsLogBody });
    const n = seen.length;
    await assert.rejects(
      hGlobal({ method: "POST", path: "/__vibesquad/inbox", body: JSON.stringify({ text: "t", laneId: "lane1" }) }),
      /rate limited: 20 writes per minute.*\[429\]/,
    );
    assert.equal(seen.length, n);
    const r = await hGlobal({ method: "GET", path: "/__vibesquad/log?team=sq" });
    assert.equal(r.status, 200, "reads keep their own budget");
  });

  test("scrubResponseBody strips path/teamLogPath and scrubs >= 400 error bodies", () => {
    assert.deepEqual(
      JSON.parse(scrubResponseBody("/__vibesquad/vs-log", JSON.stringify({ ok: true, path: "C:\\a\\b.jsonl", teamLogPath: "/home/u/x.jsonl" }), 200)),
      { ok: true },
    );
    const resolved = JSON.stringify({ ok: true, path: "docs/a.md", count: 1 });
    assert.deepEqual(JSON.parse(scrubResponseBody("/__vibesquad/fs/resolve", resolved, 200)), { ok: true, path: "docs/a.md", count: 1 });
    const errOut = JSON.parse(
      scrubResponseBody(
        "/api/teams",
        JSON.stringify({
          ok: false,
          error: "ENOENT: open C:\\Users\\Owner\\secret\\teams.json",
          path: "C:\\Users\\Owner\\secret\\teams.json",
          teamLogPath: "C:\\Users\\Owner\\log.jsonl",
          cwd: "C:\\Users\\Owner",
          worktree: "C:\\Users\\Owner\\wt",
          stack: "Error: boom\n at Object.<anonymous>",
        }),
        500,
      ),
    );
    assert.deepEqual(errOut, { ok: false, error: "ENOENT: open [redacted-path]" });
  });

  test("still denied: blocked paths win over any allow entry; settings POST is 405; a bad handoff POST is refused", async () => {
    setGate(true);
    const everything = Object.fromEntries(
      [
        "/__vibesquad/paseo/daemon",
        "/__vibesquad/paseo/raw/x",
        "/__vibesquad/pair/start",
        "/__vibesquad/devices/revoke",
        "/__vibesquad/push/subscribe",
        "/__vibesquad/remove-team-worktrees",
        "/__vibesquad/local-image",
      ].map((p) => [p, ["GET", "POST"]]),
    );
    const h = makeVsHttpHandler({ port, home, allow: { ...REMOTE_ALLOW, ...everything } });
    const n = seen.length;
    for (const p of Object.keys(everything)) {
      await assert.rejects(h({ method: "POST", path: p, body: "{}" }), /blocked remotely.*\[403\]/, p);
      assert.equal(decideProxyRequest("POST", p).code, "blocked", p);
    }
    await assert.rejects(h({ method: "POST", path: "/__vibesquad/settings", body: "{}" }), /\[405\]/);
    await assert.rejects(h({ method: "POST", path: "/__vibesquad/handoff", body: '{"team":"sq","lane":"lane1","cwd":"C:/"}' }), /body key not allowed remotely: cwd \[403\]/);
    await assert.rejects(h({ method: "POST", path: "/__vibesquad/handoff", body: '{"team":"sq"}' }), /key required remotely: body\.lane \[403\]/);
    assert.equal(seen.length, n);
  });

  test("proxyTimeoutFor extends timeout to 45000ms for spawn endpoints and keeps 10000ms default otherwise", () => {
    assert.equal(REMOTE_SPAWN_TIMEOUT_MS, 45_000);
    assert.equal(proxyTimeoutFor("/__vibesquad/brainstorm-restart"), 45_000);
    assert.equal(proxyTimeoutFor("/__vibesquad/inbox/triage"), 45_000);
    assert.equal(proxyTimeoutFor("/api/health"), 10_000);
  });
});

describe("B8: fs/* over the proxy reach the real handlers, owner-gated, confined", () => {
  let server;
  let port;
  let ws;
  let outside;
  const seenTokens = [];
  before(async () => {
    const { handleFsList, handleFsRead, handleFsResolve } = await import("../server/file-search.mjs");
    ws = mkdtempSync(join(tmpdir(), "vs-b8-ws-"));
    outside = mkdtempSync(join(tmpdir(), "vs-b8-out-"));
    writeFileSync(join(ws, "note.md"), "# hi");
    writeFileSync(join(ws, "shot.png"), PNG);
    writeFileSync(join(ws, "home.md"), `see ${homedir()} and ${userInfo().username}
`);
    writeFileSync(join(ws, "long.md"), "x".repeat(600 * 1024));
    writeFileSync(join(ws, "big.png"), Buffer.alloc(REMOTE_MAX_BINARY_BYTES + 1, 7));
    writeFileSync(join(ws, "edge.png"), Buffer.alloc(REMOTE_MAX_BINARY_BYTES, 9));
    writeFileSync(join(outside, "secret.txt"), "nope");
    writeFileSync(join(home, "local-token"), TOKEN);
    const send = (res, status, obj) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      seenTokens.push(req.headers["x-vibesquad-token"]);
      // Mirrors the real middleware: fs/* are isGatedRead, so a tokenless loopback caller gets 403.
      if (req.headers["x-vibesquad-token"] !== TOKEN) return send(res, 403, { error: "read-only", readOnly: true });
      if (path === "/__vibesquad/fs/list") return handleFsList(req, res, [ws], send);
      if (path === "/__vibesquad/fs/read") return handleFsRead(req, res, [ws], send);
      if (path === "/__vibesquad/fs/resolve") return handleFsResolve(req, res, async () => ws, send, [ws]);
      send(res, 404, {});
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const call = (path, method = "GET") => {
    setGate(true);
    return makeVsHttpHandler({ port, home })({ method, path });
  };
  const q = (o) => "?" + new URLSearchParams(o).toString();

  test("list / read / resolve succeed and the proxy sent the owner token", async () => {
    const list = await call("/__vibesquad/fs/list" + q({ cwd: ws, path: "" }));
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body).entries.map((e) => e.name).sort(), ["big.png", "edge.png", "home.md", "long.md", "note.md", "shot.png"]);
    const read = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "note.md" }));
    assert.equal(read.status, 200);
    assert.equal(read.body, "# hi");
    const resolved = await call("/__vibesquad/fs/resolve" + q({ agentId: "a", name: "note.md" }));
    assert.equal(resolved.status, 200, resolved.body);
    assert.deepEqual(JSON.parse(resolved.body), { ok: true, path: "note.md", count: 1 });
    assert.ok(seenTokens.slice(-3).every((t) => t === TOKEN));
  });
  test("a PNG round-trips byte-exact as base64 with its content type; the shim hands back real bytes", async () => {
    const out = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "shot.png" }));
    assert.equal(out.status, 200);
    assert.equal(out.encoding, "base64");
    assert.equal(out.headers["content-type"], "image/png");
    assert.equal(out.headers["x-vs-size"], String(PNG.length));
    assert.ok(Buffer.from(out.body, "base64").equals(PNG));
    const target = { fetch: async () => new Response("no"), location: { origin: "http://x" } };
    const uninstall = installRemoteTransport(async () => out, target);
    const r = await target.fetch("http://x/__vibesquad/fs/read?cwd=a&path=shot.png");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
    assert.equal(r.headers.get("content-type"), "image/png");
    uninstall();
  });
  test("text fs/read is byte-exact (no homedir/username redaction), keeps x-vs-* headers; >512 KB text is a 413 with size", async () => {
    const out = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "home.md" }));
    assert.equal(out.status, 200);
    assert.equal(out.encoding, undefined);
    assert.equal(out.body, `see ${homedir()} and ${userInfo().username}
`);
    assert.equal(out.headers["x-vs-size"], String(Buffer.byteLength(out.body)));
    assert.ok(out.headers["x-vs-modified"]);
    const big = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "long.md" }));
    assert.equal(big.status, 413);
    const j = JSON.parse(big.body);
    assert.equal(j.ok, false);
    assert.equal(j.size, 600 * 1024);
  });
  test("over 8 MB raw is a 413 carrying the size; exactly 8 MB passes", async () => {
    const big = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "big.png" }));
    assert.equal(big.status, 413);
    assert.equal(big.encoding, undefined);
    const j = JSON.parse(big.body);
    assert.equal(j.ok, false);
    assert.equal(j.size, REMOTE_MAX_BINARY_BYTES + 1);
    const edge = await call("/__vibesquad/fs/read" + q({ cwd: ws, path: "edge.png" }));
    assert.equal(edge.status, 200);
    assert.equal(Buffer.from(edge.body, "base64").length, REMOTE_MAX_BINARY_BYTES);
  });
  test("traversal, absolute paths and a cwd outside the roots are still refused over remote", async () => {
    for (const path of ["../" + "x", "a/../../x", "/etc/passwd", "C:/Windows/win.ini", "~/x"]) {
      const r = await call("/__vibesquad/fs/read" + q({ cwd: ws, path }));
      assert.ok(r.status >= 400, `${path} -> ${r.status}`);
    }
    const out = await call("/__vibesquad/fs/read" + q({ cwd: outside, path: "secret.txt" }));
    assert.ok(out.status >= 400 && !out.body.includes("nope"), `outside cwd -> ${out.status}`);
  });
  test("POST and files/search are refused before any fetch", async () => {
    const n = seenTokens.length;
    await assert.rejects(call("/__vibesquad/fs/read" + q({ cwd: ws, path: "note.md" }), "POST"), /not available remotely.*\[405\]/);
    await assert.rejects(call("/__vibesquad/files" + q({ cwd: ws })), /blocked remotely.*\[403\]/);
    await assert.rejects(call("/__vibesquad/search" + q({ cwd: ws, q: "hi" })), /blocked remotely.*\[403\]/);
    assert.equal(seenTokens.length, n);
  });
});

describe("B8 part 2b: remote terminals are owner-only, long-polled, byte-exact and bounded", () => {
  let server;
  let port;
  let ws;
  let mgr;
  const seen = [];
  const OWNER_HOME = mkdtempSync(join(tmpdir(), "vs-b8t-owner-"));
  const NO_TOKEN_HOME = mkdtempSync(join(tmpdir(), "vs-b8t-none-"));
  const WRONG_HOME = mkdtempSync(join(tmpdir(), "vs-b8t-wrong-"));
  const fakeShell = {
    file: process.execPath,
    args: ["-e", `process.stdin.setEncoding("utf8");let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l==="quit")process.exit(3);console.log("got:"+l)}});setInterval(()=>{},1000);`],
  };
  before(async () => {
    const { TerminalManager } = await import("../server/terminals.mjs");
    const { handleTerminalsApi, isTerminalsPath } = await import("../server/terminals-api.mjs");
    ws = mkdtempSync(join(tmpdir(), "vs-b8t-ws-"));
    mgr = new TerminalManager({ pty: null, shell: fakeShell });
    for (const [h, tok] of [[OWNER_HOME, TOKEN], [WRONG_HOME, "b".repeat(64)]]) {
      writeFileSync(join(h, "local-token"), tok);
    }
    for (const h of [OWNER_HOME, NO_TOKEN_HOME, WRONG_HOME]) writeFileSync(join(h, "settings.json"), JSON.stringify({ remote: { enabled: true } }));
    const sendJson = (res, status, obj) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : {})); });
    server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      seen.push({ method: req.method, url: req.url, token: req.headers["x-vibesquad-token"] });
      // Mirrors the middleware: terminals + scripts are isGatedRead and owner-only for writes, so no token = 403.
      if (!isTerminalsPath(path)) return sendJson(res, 404, {});
      if (req.headers["x-vibesquad-token"] !== TOKEN) return sendJson(res, 403, { error: "read-only", readOnly: true });
      return handleTerminalsApi(req, res, { readBody, sendJson, resolveCwd: async (c) => (c === ws ? ws : null), terminals: mgr });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    mgr.killAll();
    server.closeAllConnections?.();
    server.close();
    for (const d of [ws, OWNER_HOME, NO_TOKEN_HOME, WRONG_HOME]) {
      try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} // a killed shell may still hold its cwd on Windows
    }
  });
  const mk = (h, extra = {}) => makeVsHttpHandler({ port, home: h, ...extra });
  const T = "/__vibesquad/terminals";
  const post = (h, path, body) => h({ method: "POST", path, body: JSON.stringify(body) });
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); }
    return null;
  };

  test("an owner can create, send input, read output (byte-exact, unredacted) and kill a terminal", async () => {
    const h = mk(OWNER_HOME, { homeDir: homedir(), userName: userInfo().username });
    const made = await post(h, T, { cwd: ws, name: "t", cols: 90, rows: 20 });
    assert.equal(made.status, 201);
    const id = JSON.parse(made.body).terminal.id;
    assert.equal(seen.at(-1).token, TOKEN, "owner token injected");
    const secret = `${homedir()} ${userInfo().username}`;
    assert.equal((await post(h, `${T}/${id}/input`, { data: `${secret}\r` })).status, 200);
    assert.equal((await post(h, `${T}/${id}/resize`, { cols: 100, rows: 30 })).status, 200);
    assert.equal((await post(h, `${T}/${id}/rename`, { name: "renamed" })).status, 200);
    let cursor;
    let text = "";
    const got = await until(async () => {
      const r = await h({ method: "GET", path: `${T}/${id}/poll?${cursor === undefined ? "" : `since=${cursor}&`}wait=500` });
      assert.equal(r.status, 200);
      const j = JSON.parse(r.body);
      text += j.text;
      cursor = j.next;
      return text.includes(`got:${secret}`);
    });
    assert.ok(got, `polled output: ${JSON.stringify(text)}`);
    const out = JSON.parse((await h({ method: "GET", path: `${T}/${id}/output?max=20` })).body);
    assert.ok(out.text.length <= 20);
    const list = JSON.parse((await h({ method: "GET", path: `${T}?cwd=${encodeURIComponent(ws)}` })).body);
    assert.equal(list.terminals.length >= 1, true);
    assert.equal((await post(h, `${T}/${id}/kill`, {})).status, 200);
    const gone = await post(h, `${T}/${id}/input`, { data: "x" });
    assert.equal(gone.status, 404);
  });

  const ROUTES = () => {
    const id = "tm-0123456789ab";
    return [
      ["GET", T], ["POST", T, { cwd: ws }], ["GET", `${T}/${id}/poll`], ["GET", `${T}/${id}/output`],
      ["POST", `${T}/${id}/input`, { data: "x" }], ["POST", `${T}/${id}/resize`, { cols: 80, rows: 24 }],
      ["POST", `${T}/${id}/rename`, { name: "n" }], ["POST", `${T}/${id}/kill`, {}],
      ["GET", "/__vibesquad/workspace-scripts"], ["GET", "/__vibesquad/workspace-scripts/logs?cwd=a&name=b"],
      ["POST", "/__vibesquad/workspace-scripts/start", { cwd: ws, name: "x" }], ["POST", "/__vibesquad/workspace-scripts/stop", { cwd: ws, name: "x" }],
    ];
  };
  test("a non-owner is refused on EVERY terminal and script route: no token file -> refused before any fetch", async () => {
    const h = mk(NO_TOKEN_HOME);
    const n = seen.length;
    for (const [method, path, body] of ROUTES()) {
      await assert.rejects(h({ method, path, ...(body ? { body: JSON.stringify(body) } : {}) }), /owner-only.*\[403\]/, `${method} ${path}`);
    }
    assert.equal(seen.length, n);
  });
  test("a paired client holding the wrong token gets the server's 403 on every route and nothing is created", async () => {
    const h = mk(WRONG_HOME);
    const before = mgr.list().length;
    for (const [method, path, body] of ROUTES()) {
      const r = await h({ method, path, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal(mgr.list().length, before);
  });
  test("no stream route, no stream=1 on script logs, wrong methods/ids and non-terminal lookalikes stay refused", async () => {
    const h = mk(OWNER_HOME);
    const id = "tm-0123456789ab";
    const n = seen.length;
    await assert.rejects(h({ method: "GET", path: `${T}/${id}/stream` }), /not available remotely.*\[403\]/);
    await assert.rejects(h({ method: "GET", path: "/__vibesquad/workspace-scripts/logs?stream=1&cwd=a&name=b" }), /not available remotely.*\[403\]/);
    for (const q of ["%73tream=1", "cwd=a&%73%74ream=1", "stream", "x=1&stream=0"]) {
      const d = decideProxyRequest("GET", `/__vibesquad/workspace-scripts/logs?${q}`);
      assert.equal(d.ok, false, q);
      assert.equal(d.code, "not-allowed", q);
    }
    assert.equal(decideProxyRequest("GET", "/__vibesquad/workspace-scripts/logs?cwd=a&name=b").ok, true);
    await assert.rejects(h({ method: "GET", path: `${T}/${id}/input` }), /not available remotely on.*\[405\]/);
    await assert.rejects(h({ method: "DELETE", path: `${T}/${id}/kill` }), /\[405\]/);
    await assert.rejects(h({ method: "GET", path: `${T}/not-an-id/poll` }), /not available remotely.*\[403\]/);
    await assert.rejects(h({ method: "GET", path: `${T}-x` }), /not available remotely.*\[403\]/);
    await assert.rejects(h({ method: "GET", path: "/__vibesquad/workspace-scripts/other" }), /not available remotely.*\[403\]/);
    assert.equal(seen.length, n);
  });
  test("bodies are typed: unknown keys, oversize input, missing cwd and a bad cwd are refused", async () => {
    const h = mk(OWNER_HOME);
    const id = "tm-0123456789ab";
    const n = seen.length;
    await assert.rejects(post(h, T, { name: "x" }), /\[403\]/);
    await assert.rejects(post(h, T, { cwd: ws, shell: "cmd.exe" }), /\[403\]/);
    await assert.rejects(post(h, `${T}/${id}/input`, { data: "x".repeat(65_537) }), /\[403\]/);
    await assert.rejects(post(h, `${T}/${id}/input`, { data: "x", extra: 1 }), /\[403\]/);
    assert.equal(seen.length, n);
    const outside = await post(h, T, { cwd: tmpdir() });
    assert.equal(outside.status, 403, "server resolveCwd still decides which folders get a shell");
  });
  test("per-caller cap: the 5th open remote terminal is refused; killing one frees a slot; responses stay under the text cap", async () => {
    const h = mk(OWNER_HOME);
    const ids = [];
    for (let i = 0; i < REMOTE_MAX_TERMINALS; i++) ids.push(JSON.parse((await post(h, T, { cwd: ws })).body).terminal.id);
    await assert.rejects(post(h, T, { cwd: ws }), /too many remote terminals.*\[429\]/);
    assert.equal((await post(h, `${T}/${ids[0]}/kill`, {})).status, 200);
    const again = await post(h, T, { cwd: ws });
    assert.equal(again.status, 201);
    ids.push(JSON.parse(again.body).terminal.id);
    // A big burst: each poll body is capped by the server, so no response exceeds the proxy's text cap.
    const big = ids[1];
    mgr.get(big).write("x".repeat(100));
    for (let i = 0; i < 3; i++) mgr.get(big).events.emit("data", "y".repeat(50_000)), (mgr.get(big).buf += "y".repeat(50_000)), (mgr.get(big).total += 50_000);
    const r = await h({ method: "GET", path: `${T}/${big}/poll?since=0` });
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(r.body).text.length <= REMOTE_TERMINAL_POLL_CHARS);
    assert.ok(Buffer.byteLength(r.body) < REMOTE_MAX_BODY_BYTES);
    for (const id of ids.slice(1)) await post(h, `${T}/${id}/kill`, {});
  });
  test("slots freed by a local kill, an exit or a closed tab are reclaimed: 4 killed on the host, then a 5th create succeeds", async () => {
    const h = mk(OWNER_HOME);
    const ids = [];
    for (let i = 0; i < REMOTE_MAX_TERMINALS; i++) ids.push(JSON.parse((await post(h, T, { cwd: ws })).body).terminal.id);
    await assert.rejects(post(h, T, { cwd: ws }), /too many remote terminals.*\[429\]/);
    mgr.kill(ids[0]); // killed on the host, not through the proxy
    mgr.get(ids[1]).kill();
    mgr.get(ids[1]).exited = { code: 1 }; // exited on its own
    mgr.kill(ids[2]);
    mgr.kill(ids[3]);
    const fresh = await post(h, T, { cwd: ws });
    assert.equal(fresh.status, 201);
    for (let i = 0; i < REMOTE_MAX_TERMINALS - 1; i++) assert.equal((await post(h, T, { cwd: ws })).status, 201);
    await assert.rejects(post(h, T, { cwd: ws }), /too many remote terminals.*\[429\]/, "the cap still holds after a prune");
    mgr.killAll();
  });
  test("terminal calls use their own rate bucket, not the 20/min write budget", async () => {
    const h = mk(OWNER_HOME);
    const made = JSON.parse((await post(h, T, { cwd: ws })).body).terminal.id;
    for (let i = 0; i < 40; i++) assert.equal((await post(h, `${T}/${made}/input`, { data: "k" })).status, 200);
    await post(h, `${T}/${made}/kill`, {});
    await assert.rejects(
      (async () => {
        const lim = createRateLimiter({ budget: { read: 120, write: 20, term: 2 } });
        const hh = mk(OWNER_HOME, { limiter: lim });
        for (let i = 0; i < 3; i++) await hh({ method: "GET", path: `${T}?cwd=${encodeURIComponent(ws)}` });
      })(),
      /rate limited: 2 terms per minute.*\[429\]/,
    );
  });
  test("non-terminal routes are unchanged by the owner-route patterns", () => {
    for (const p of ["/__vibesquad/terminals/tm-0123456789ab/poll/x", "/__vibesquad/workspace-scripts/logs/x", "/__vibesquad/terminal"]) {
      assert.equal(decideProxyRequest("GET", p).ok, false, p);
    }
    assert.equal(decideProxyRequest("GET", "/api/teams").ok, true);
    assert.equal(decideProxyRequest("POST", "/__vibesquad/settings").code, "method");
    assert.equal(decideProxyRequest("GET", "/__vibesquad/files").code, "blocked");
  });
});
