// PTO v1.1 R1 (docs/lanes/playtest-overlay/PLAN_V1_1_ROLE.md, Tier A: auth role + route gate): the least-privilege
// `owner-playtest` device role for the Godot playtest addon. With a HEADER token it may file playtest reports and read/write
// the reply thread on any Squad (cards stay owner-source `[Owner playtest]`) and read its own auth status; everything else is
// 403 before routing (PLAYTEST_ROUTE_ALLOWLIST, deny by default). It is never owner proof and never mints a pairing code.
// Cookie-only, relayed and agent-header callers are refused, same as B1b. Every request goes through the real middleware.
// Attacker cases are marked "attacker:".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "vs-ptor1-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "vs-ptor1-root-"));
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
process.env.PASEO_HOME = join(HOME, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
delete process.env.VS_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;
delete process.env.PASEO_AGENT_ID;

const TEAMS = [
  { id: "efi", name: "EFI", paths: [join(homedir(), "secret-proj")], lanes: [{ id: "efi", name: "Hub", hub: true }, { id: "efi-bugs", name: "Bugs", code: "bug", kind: "bug" }] },
  { id: "oth", name: "Other", paths: [], lanes: [{ id: "oth", name: "Oth Hub", hub: true }, { id: "oth-bugs", name: "Oth Bugs", kind: "bug" }] },
];
writeFileSync(join(ROOT, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
writeFileSync(join(HOME, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");

const auth = await import("../server/auth.mjs");
const inbox = await import("../server/inbox.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { createSyntheticRequest } = await import("../server/relay-tunnel.mjs");
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

const agent = (id, team, lane, role) => ({ id, title: `${role} ${lane}`, status: "idle", cwd: join(homedir(), "secret-proj"), labels: { team, lane, role }, provider: "claude" });
const AGENTS = [agent("rn-efibuddy", "efi", "efi-bugs", "brainstorm"), agent("rn-othbuddy", "oth", "oth-bugs", "brainstorm")];
const prompts = [];
const spawned = [];
const backend = {
  async listAgents() {
    return AGENTS;
  },
  async fetchAgents() {
    return AGENTS;
  },
  async fetchAgentTimeline() {
    return { entries: [], hasOlder: false };
  },
  async sendAgentPrompt(id, text, opts) {
    prompts.push({ id, text, opts });
  },
  async createAgent(x) {
    spawned.push(x);
    return { id: "rn-spawned" };
  },
  async verifyAgent() {
    return null;
  },
};
const mw = api.createVibesquadMiddleware(ROOT, { backend, verifyAgent: async () => null });

let ipN = 40;
function mkReq({ url, method = "GET", headers = {}, body, local = false, host }) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: host ?? (local ? "127.0.0.1:4180" : "100.64.0.7:4180"), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  req.socket = local ? { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 } : { remoteAddress: `100.64.0.${++ipN}`, localAddress: "100.64.0.7" };
  const payload = body !== undefined ? JSON.stringify(body) : null;
  setImmediate(() => req.end(payload ?? undefined));
  return req;
}
function mkRes() {
  let done;
  const finished = new Promise((r) => (done = r));
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    writeHead(code, h) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(h ?? {})) this.setHeader(k, v);
      this.headersSent = true;
    },
    write(c) {
      this.body += c;
      return true;
    },
    end(b) {
      this.body += b ?? "";
      this.headersSent = true;
      done("end");
    },
  };
  return { res, finished };
}
async function call(opts) {
  const req = mkReq(opts);
  const { res, finished } = mkRes();
  let nextCalled = false;
  const viaNext = new Promise((r) => mw(req, res, () => ((nextCalled = true), r("next"))));
  await Promise.race([finished, viaNext]);
  return { status: res.statusCode, body: res.body, next: nextCalled, json: () => JSON.parse(res.body) };
}
const ownerLocal = () => ({ "x-vibesquad-token": auth.getLocalToken() });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const xdev = (t) => ({ "x-vs-device-token": t });

async function pcPair(name, scope) {
  const start = await call({ url: "/__vibesquad/pair/start", method: "POST", local: true, headers: ownerLocal(), body: scope ?? {} });
  assert.equal(start.status, 200, start.body);
  const r = await call({ url: `/pair?code=${start.json().code}&name=${encodeURIComponent(name)}&format=json` });
  assert.equal(r.status, 200, r.body);
  return r.json();
}
const ownerGame = (await pcPair("Owner game")).token;
const playRedeem = await pcPair("Godot dock", { role: "owner-playtest" });
const play = playRedeem.token;
const deviceId = (name) => auth.listDevices().find((d) => d.name === name)?.id;
const cards = () => inbox.readInboxCards();
const cardById = (id) => cards().find((c) => c.id === id);

const REPORT = "/__vibesquad/tester/report";
const THREAD = "/__vibesquad/tester/thread";
const ALLOWED = [
  { url: REPORT, method: "POST", body: { teamId: "efi", text: "x" } },
  { url: `${THREAD}?teamId=efi`, method: "GET" },
  { url: THREAD, method: "POST", body: { teamId: "efi", text: "x" } },
];

describe("auth.mjs: the owner-playtest scope", () => {
  test("normalizePairScope({role:'owner-playtest'}) -> { role, allowedTeams: null }; never owner proof", () => {
    assert.ok(auth.DEVICE_ROLES.includes("owner-playtest"));
    assert.equal(auth.OWNER_PLAYTEST_ROLE, "owner-playtest");
    assert.deepEqual(auth.normalizePairScope({ role: "owner-playtest" }), { role: "owner-playtest", allowedTeams: null });
    assert.deepEqual(auth.normalizePairScope({ role: "owner-playtest", allowedTeams: null }), { role: "owner-playtest", allowedTeams: null });
    assert.deepEqual(auth.normalizePairScope({ role: "owner-playtest", allowedTeams: [] }), { role: "owner-playtest", allowedTeams: null });
    assert.equal(auth.isOwnerDevice({ id: "d", role: "owner-playtest" }), false);
  });

  test("attacker: a per-Squad owner-playtest scope is refused (400), never silently widened to every Squad", () => {
    for (const allowedTeams of [["efi"], "efi", { efi: 1 }]) {
      assert.throws(() => auth.normalizePairScope({ role: "owner-playtest", allowedTeams }), (e) => e.status === 400, JSON.stringify(allowedTeams));
    }
    for (const role of ["Owner-Playtest", "owner_playtest", "owner-playtest ", "playtest"]) {
      assert.throws(() => auth.normalizePairScope({ role }), (e) => e.status === 400, role);
    }
  });

  test("a Playtest code redeems to an owner-playtest record (allowedTeams null) with no approval step", () => {
    assert.equal(playRedeem.state, "paired");
    assert.equal(playRedeem.role, "owner-playtest");
    assert.equal(playRedeem.allowedTeams, null);
    const rec = auth.listDevices().find((d) => d.name === "Godot dock");
    assert.equal(rec.role, "owner-playtest");
    assert.equal(rec.allowedTeams, null);
  });

  test("ownerProof is false for an owner-playtest header token, cookie or relay channel", () => {
    const viaHeader = mkReq({ url: "/__vibesquad/settings", headers: bearer(play) });
    const viaCookie = mkReq({ url: "/__vibesquad/settings", headers: { cookie: `${auth.DEVICE_COOKIE}=${play}` } });
    const viaRelay = createSyntheticRequest({ method: "GET", path: "/__vibesquad/settings", headers: {}, body: Buffer.alloc(0), deviceId: deviceId("Godot dock") });
    for (const r of [viaHeader, viaCookie, viaRelay]) {
      assert.equal(auth.ownerProof(r), false);
      assert.equal(auth.authenticate(r)?.role, "owner-playtest", "sanity: the credential is valid");
    }
  });
});

describe("owner-playtest header token: report + thread on any Squad", () => {
  for (const [label, h] of [["Bearer", () => bearer(play)], ["x-vs-device-token", () => xdev(play)]]) {
    test(`${label}: report 200 on two Squads, owner-source [Owner playtest] card owned by device:<id>`, async () => {
      for (const teamId of ["efi", "oth"]) {
        prompts.length = 0;
        const r = await call({ url: REPORT, method: "POST", headers: h(), body: { teamId, text: `door ${label} ${teamId}`, telemetry: { scene: "res://door.tscn" } } });
        assert.equal(r.status, 200, r.body);
        const out = r.json();
        assert.equal(out.laneId, `${teamId}-bugs`);
        const card = cardById(out.cardId);
        assert.ok(card.text.startsWith("[Owner playtest]\n"), card.text.slice(0, 40));
        assert.ok(!card.text.includes("Alpha Tester"));
        assert.equal(card.source, "owner-playtest");
        assert.equal(card.ownerPlaytest, true);
        assert.equal(card.ownerPlaytestBy, `device:${deviceId("Godot dock")}`);
        assert.equal("testerDeviceId" in card, false);
        assert.ok(!JSON.stringify(card).includes(play), "the device token is never stored on the card");
        assert.ok(prompts.some((p) => p.id === `rn-${teamId}buddy` && p.text.includes(`#${out.cardId}`)));
      }
    });

    test(`${label}: thread GET 200 and POST 200 (owner line) on two Squads`, async () => {
      for (const teamId of ["efi", "oth"]) {
        const g = await call({ url: `${THREAD}?teamId=${teamId}`, headers: h() });
        assert.equal(g.status, 200, g.body);
        assert.equal(g.json().teamId, teamId);
        prompts.length = 0;
        const p = await call({ url: THREAD, method: "POST", headers: h(), body: { teamId, text: "dock line" } });
        assert.equal(p.status, 200, p.body);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].id, `rn-${teamId}buddy`);
        assert.equal(prompts[0].text, "[Owner playtest] dock line");
        assert.equal(prompts[0].opts.owner, true);
      }
    });
  }

  test("clientReportId dedupes per owner-playtest device and never collides with the owner device's id", async () => {
    const body = { teamId: "efi", text: "dupe", clientReportId: "pt-dedupe-1" };
    const a = await call({ url: REPORT, method: "POST", headers: bearer(play), body });
    const b = await call({ url: REPORT, method: "POST", headers: xdev(play), body });
    assert.equal(a.status, 200, a.body);
    assert.equal(b.json().cardId, a.json().cardId);
    assert.equal(b.json().deduplicated, true);
    const o = await call({ url: REPORT, method: "POST", headers: bearer(ownerGame), body });
    assert.equal(o.status, 200, o.body);
    assert.notEqual(o.json().cardId, a.json().cardId);
  });

  test("auth status says role owner-playtest and leaks no LAN / relay / installer detail; health is liveness only", async () => {
    for (const url of ["/api/auth/status", "/__vibesquad/auth/status"]) {
      const r = await call({ url, headers: bearer(play) });
      assert.equal(r.status, 200, r.body);
      const s = r.json();
      assert.equal(s.paired, true);
      assert.equal(s.role, "owner-playtest");
      assert.equal(s.localAccess, "owner-playtest");
      assert.equal(s.allowedTeams, null);
      assert.equal(s.deviceName, "Godot dock");
      for (const k of ["lanIp", "meshnetIp", "meshnetHost", "relay", "port", "lanHttpsUrl"]) assert.equal(k in s, false, `auth status leaks ${k}`);
      assert.equal((await call({ url, method: "HEAD", headers: bearer(play) })).status, 200);
    }
    const h = await call({ url: "/__vibesquad/health", headers: bearer(play) });
    const hs = h.json();
    assert.equal(hs.role, "owner-playtest");
    for (const k of ["port", "exposedIps", "lanEnabled", "stale", "configWarnings"]) assert.equal(k in hs, false, `health leaks ${k}`);
  });

  test("an owner device token still works on the same routes (owner is owner)", async () => {
    assert.equal((await call({ url: REPORT, method: "POST", headers: bearer(ownerGame), body: { teamId: "efi", text: "owner still" } })).status, 200);
    assert.equal((await call({ url: `${THREAD}?teamId=oth`, headers: xdev(ownerGame) })).status, 200);
    const s = (await call({ url: "/api/auth/status", headers: bearer(ownerGame) })).json();
    assert.equal(s.role, "owner");
  });
});

describe("attacker: owner-playtest is denied everything else, before routing", () => {
  const DENIED = [
    ["GET", "/__vibesquad/teams"],
    ["GET", "/api/teams"],
    ["POST", "/api/teams", { teams: [] }],
    ["POST", "/__vibesquad/runner/spawn", { teamId: "efi", lane: "efi-bugs", prompt: "x" }],
    ["GET", "/__vibesquad/runner/agents"],
    ["GET", "/__vibesquad/runner/agents/rn-efibuddy"],
    ["POST", "/__vibesquad/runner/agents/rn-efibuddy/input", { text: "x" }],
    ["GET", "/__vibesquad/runner/events"],
    ["GET", "/__vibesquad/runner/status"],
    ["GET", "/__vibesquad/inbox"],
    ["POST", "/__vibesquad/inbox", { text: "x", teamId: "efi" }],
    ["POST", "/__vibesquad/inbox/send", { id: "idea-1" }],
    ["POST", "/__vibesquad/pair/start", {}],
    ["POST", "/__vibesquad/pair/start", { role: "owner-playtest" }],
    ["GET", "/__vibesquad/pair/pending"],
    ["POST", "/__vibesquad/pair/approve", { pendingId: "x" }],
    ["GET", "/__vibesquad/devices"],
    ["POST", "/__vibesquad/devices/revoke", { id: "x" }],
    ["GET", "/__vibesquad/settings"],
    ["POST", "/__vibesquad/log", { text: "x" }],
    ["POST", "/__vibesquad/vs-log", { text: "x" }],
    ["GET", "/__vibesquad/profiles"],
    ["GET", "/api/profiles"],
    ["GET", "/__vibesquad/search?q=x"],
    ["GET", "/__vibesquad/schedules"],
    ["GET", "/__vibesquad/providers"],
    ["POST", "/__vibesquad/remove-team-worktrees", { worktrees: [] }],
    ["GET", "/__vibesquad/unknown-route"],
    // allowlisted paths with the wrong method
    ["GET", REPORT],
    ["PUT", REPORT, { teamId: "efi", text: "x" }],
    ["DELETE", THREAD],
    ["PATCH", THREAD, { teamId: "efi", text: "x" }],
    ["POST", "/api/auth/status", {}],
    ["POST", "/__vibesquad/auth/status", {}],
    // static / SPA tree: no read-only fall-through either
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/assets/app.js"],
    // non-canonical spellings of allowlisted paths
    ["POST", "/__vibesquad/tester/./report", { teamId: "efi", text: "x" }],
    ["POST", "/__vibesquad//tester/report", { teamId: "efi", text: "x" }],
    ["POST", "/__vibesquad/tester/%72eport", { teamId: "efi", text: "x" }],
    ["GET", "//api/settings"],
    ["GET", "/__vibesquad/tester/../teams"],
    ["POST", "/__vibesquad/tester/report/", { teamId: "efi", text: "x" }],
  ];

  for (const [label, h] of [["Bearer", () => bearer(play)], ["x-vs-device-token", () => xdev(play)], ["cookie", () => ({ cookie: `${auth.DEVICE_COOKIE}=${play}` })]]) {
    test(`${label}: every non-allowlisted route/method is 403 (remote and loopback); nothing spawned, sent or parked`, async () => {
      prompts.length = 0;
      spawned.length = 0;
      const before = cards().length;
      for (const [method, url, body] of DENIED) {
        for (const local of [false, true]) {
          const r = await call({ url, method, headers: h(), body, local });
          assert.equal(r.status, 403, `${label} ${local ? "loopback" : "remote"} ${method} ${url} -> ${r.status} ${r.body}`);
          assert.equal(r.next, false, `${method} ${url} fell through to the static handler`);
        }
      }
      assert.equal(spawned.length, 0);
      assert.equal(prompts.length, 0);
      assert.equal(cards().length, before);
    });
  }

  test("owner-playtest cannot mint a code: router 403, and handlePairStart itself 403 when called directly", async () => {
    const codesBefore = auth.listDevices().length;
    const r = await call({ url: "/__vibesquad/pair/start", method: "POST", headers: bearer(play), body: { role: "owner" } });
    assert.equal(r.status, 403, r.body);
    for (const local of [false, true]) {
      for (const headers of [bearer(play), xdev(play), { cookie: `${auth.DEVICE_COOKIE}=${play}` }]) {
        const req = mkReq({ url: "/__vibesquad/pair/start", method: "POST", headers, body: {}, local });
        const { res, finished } = mkRes();
        await auth.handlePairStart(req, res, async () => ({}));
        await finished;
        assert.equal(res.statusCode, 403, `direct pair/start ${local ? "loopback" : "remote"} ${Object.keys(headers)} -> ${res.body}`);
        assert.ok(!res.body.includes('"code"'), "no code in the answer");
      }
    }
    assert.equal(auth.listDevices().length, codesBefore);
  });

  test("cookie-only owner-playtest is 403 on report/thread (remote and loopback, same-origin or not)", async () => {
    prompts.length = 0;
    const before = cards().length;
    const cookie = { cookie: `${auth.DEVICE_COOKIE}=${play}` };
    for (const r of ALLOWED) {
      for (const extra of [{}, { origin: "https://100.64.0.7:4180", "sec-fetch-site": "same-origin" }]) {
        const out = await call({ ...r, headers: { ...cookie, ...extra } });
        assert.equal(out.status, 403, `cookie ${r.method} ${r.url} ${JSON.stringify(extra)} -> ${out.body}`);
      }
      assert.equal((await call({ ...r, local: true, headers: cookie })).status, 403, `loopback cookie ${r.method} ${r.url}`);
    }
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("a relayed owner-playtest device is 403 on report/thread, even with a token header riding along", async () => {
    prompts.length = 0;
    const before = cards().length;
    const relayed = async (method, path, headers = {}, body) => {
      const req = createSyntheticRequest({ method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), deviceId: deviceId("Godot dock") });
      const { res, finished } = mkRes();
      const viaNext = new Promise((done) => mw(req, res, () => done("next")));
      assert.notEqual(await Promise.race([finished, viaNext]), "next");
      return res;
    };
    for (const r of ALLOWED) {
      for (const headers of [{}, bearer(play), xdev(play), bearer(ownerGame)]) {
        const res = await relayed(r.method, r.url, headers, r.body);
        assert.equal(res.statusCode, 403, `relay ${r.method} ${r.url} ${JSON.stringify(Object.keys(headers))} -> ${res.body}`);
      }
    }
    // and the relay never widens it elsewhere
    assert.equal((await relayed("GET", "/__vibesquad/settings")).statusCode, 403);
    assert.equal((await relayed("POST", "/__vibesquad/runner/spawn", {}, { teamId: "efi" })).statusCode, 403);
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("owner-playtest token plus agent headers is 403 on report/thread and elsewhere", async () => {
    prompts.length = 0;
    const before = cards().length;
    const agentH = { "x-vs-agent-id": "rn-efibuddy", "x-vs-agent-token": "t" };
    for (const r of ALLOWED) {
      for (const h of [bearer(play), xdev(play)]) {
        for (const local of [false, true]) {
          const out = await call({ ...r, local, headers: { ...h, ...agentH } });
          assert.equal(out.status, 403, `agent headers ${r.method} ${r.url} -> ${out.body}`);
        }
      }
    }
    assert.equal((await call({ url: "/__vibesquad/teams", headers: { ...bearer(play), ...agentH } })).status, 403);
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("a playtest token can't borrow the local owner: loopback + playtest header without the local token stays playtest", async () => {
    const r = await call({ url: "/__vibesquad/settings", local: true, headers: bearer(play) });
    assert.equal(r.status, 403);
    const s = (await call({ url: "/api/auth/status", local: true, headers: bearer(play) })).json();
    assert.equal(s.role, "owner-playtest");
  });

  test("revoking the owner-playtest device cuts it off (401 remote)", async () => {
    const extra = await pcPair("Godot dock 2", { role: "owner-playtest" });
    assert.equal((await call({ url: `${THREAD}?teamId=efi`, headers: bearer(extra.token) })).status, 200);
    const rv = await call({ url: "/__vibesquad/devices/revoke", method: "POST", local: true, headers: ownerLocal(), body: { id: deviceId("Godot dock 2") } });
    assert.equal(rv.status, 200, rv.body);
    assert.equal((await call({ url: `${THREAD}?teamId=efi`, headers: bearer(extra.token) })).status, 401);
    assert.equal((await call({ url: REPORT, method: "POST", headers: bearer(extra.token), body: { teamId: "efi", text: "x" } })).status, 401);
  });
});
