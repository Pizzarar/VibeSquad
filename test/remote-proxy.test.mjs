// Block R2-1/R2-5: remote proxy rules (server/hooks/remote-proxy-rules.ts) + browser fetch shim (src/remoteTransport.ts). The vs.http handler is gone (RH1).
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
} from "../server/hooks/remote-proxy-rules.ts";
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
