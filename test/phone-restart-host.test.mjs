// H2 (docs/PLAN_HEADLESS_HOST_74.md, idea-74, Tier A security): GET/POST/DELETE /__vibesquad/restart-host is owner-only for
// every method (GET included), refuses agents, bug-tester and owner-playtest devices, read-only and unpaired callers, keeps
// the cookie same-origin write proof, and only ever records a request through server/restart-request.mjs (the coordinated
// drain), never a raw restart. Driven through the real middleware (harness after sec-tester-roles / api-caller-gate).
// Attacker cases are marked "attacker:".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "vs-h2-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "vs-h2-root-"));
const RUNTIME = mkdtempSync(join(tmpdir(), "vs-h2-runtime-"));
const REPO = mkdtempSync(join(tmpdir(), "vs-h2-repo-"));
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_RUNTIME_DIR = RUNTIME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
process.env.PASEO_HOME = join(HOME, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
delete process.env.VS_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;
delete process.env.PASEO_AGENT_ID;

const TEAMS = [
  { id: "efi", name: "EFI", paths: [], lanes: [{ id: "efi", name: "EFI Hub", hub: true }] },
  { id: "vibesquad", name: "VibeSquad", paths: [], lanes: [{ id: "vs-art", name: "Art" }, { id: "vibesquad", name: "Hub", hub: true }] },
];
writeFileSync(join(ROOT, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
writeFileSync(join(HOME, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");

// The checkout the runtime syncs from (build-stamp.json -> repo), so the POST tip is its real short HEAD.
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
git("init", "-q");
writeFileSync(join(REPO, "a.txt"), "a\n");
git("add", "a.txt");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
const SHORT_HEAD = git("rev-parse", "--short", "HEAD");
writeFileSync(join(RUNTIME, "build-stamp.json"), JSON.stringify({ repo: join(REPO, ".git"), commit: SHORT_HEAD }), "utf8");

const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const rr = await import("../server/restart-request.mjs");
after(() => {
  for (const d of [HOME, ROOT, RUNTIME, REPO]) rmSync(d, { recursive: true, force: true });
});

// A verified agent (the Overlord itself): the runner says the token is good. Agents are never the owner (X1c).
const AGENT = { id: "rn-overlord01", token: "good-agent-tok" };
const verifyAgent = async ({ id, token }) => (id === AGENT.id && token === AGENT.token ? { id, role: "lead", team: "vibesquad", lane: "vibesquad" } : null);
const backend = {
  async listAgents() { return []; },
  async fetchAgents() { return []; },
  async fetchAgentTimeline() { return { entries: [], hasOlder: false }; },
  async sendAgentPrompt() {},
  async verifyAgent(c) { return verifyAgent(c); },
};
const mw = api.createVibesquadMiddleware(ROOT, { backend, verifyAgent });

let ipN = 40;
const nextIp = () => `100.64.0.${++ipN}`;
function mkReq({ url, method = "GET", headers = {}, body, local = false, ip = nextIp() }) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: local ? "127.0.0.1:4180" : "100.64.0.7:4180", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  req.socket = local ? { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 } : { remoteAddress: ip, localAddress: "100.64.0.7" };
  const payload = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
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
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(code, h) { this.statusCode = code; for (const [k, v] of Object.entries(h ?? {})) this.setHeader(k, v); this.headersSent = true; },
    write(c) { this.body += c; return true; },
    end(b) { this.body += b ?? ""; this.headersSent = true; done("end"); },
  };
  return { res, finished };
}
async function call(opts) {
  const req = mkReq(opts);
  const { res, finished } = mkRes();
  let nextCalled = false;
  const viaNext = new Promise((r) => mw(req, res, () => ((nextCalled = true), r("next"))));
  await Promise.race([finished, viaNext]);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not json */ }
  return { status: res.statusCode, body: res.body, json, next: nextCalled };
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });
const ownerLocal = () => ({ "x-vibesquad-token": auth.getLocalToken() });
async function pcPair(name, scope = undefined) {
  const start = await call({ url: "/__vibesquad/pair/start", method: "POST", local: true, headers: ownerLocal(), body: scope ?? {} });
  assert.equal(start.status, 200, start.body);
  const r = await call({ url: `/pair?code=${start.json.code}&name=${encodeURIComponent(name)}&format=json` });
  assert.equal(r.status, 200, r.body);
  return r.json.token;
}
const ownerTok = await pcPair("Owner phone");
const testerTok = await pcPair("Alice", { role: "bug-tester", allowedTeams: ["efi"] });
const playtestTok = await pcPair("Playtest rig", { role: auth.OWNER_PLAYTEST_ROLE });

const URL_ = "/__vibesquad/restart-host";
const reqFile = () => join(HOME, rr.REQUEST_FILE);
const resetRequests = () => rmSync(reqFile(), { force: true });
const bodyFor = (method) => (method === "POST" ? { mode: "urgent" } : undefined);

/** Every non-owner shape, each with the status the gate gives it. */
const NON_OWNERS = [
  ["bug-tester device (Bearer)", { headers: bearer(testerTok) }, 403],
  ["bug-tester device (cookie, same-origin)", { headers: { cookie: `vs_device=${testerTok}` } }, 403],
  ["owner-playtest device", { headers: bearer(playtestTok) }, 403],
  ["verified agent token (remote)", { headers: { "x-vs-agent-id": AGENT.id, "x-vs-agent-token": AGENT.token }, local: true }, 403],
  ["verified agent token + the owner's local token", { headers: { "x-vs-agent-id": AGENT.id, "x-vs-agent-token": AGENT.token, ...ownerLocal() }, local: true }, 403],
  ["bad agent token", { headers: { "x-vs-agent-id": AGENT.id, "x-vs-agent-token": "nope" }, local: true }, 403],
  ["read-only loopback (no token)", { local: true }, 403],
  ["wrong local token", { local: true, headers: { "x-vibesquad-token": "not-the-token" } }, 403],
  ["unpaired remote (no credential)", {}, 401],
  ["unknown device token", { headers: bearer("f".repeat(64)) }, 401],
];

describe("H2 restart-host: the gate", () => {
  test("isGatedRead covers the route (GET is never open to a read-only caller)", () => {
    assert.equal(api.isGatedRead(URL_), true);
    assert.equal(api.isGatedRead("GET", URL_), true);
  });

  for (const method of ["GET", "POST", "DELETE"]) {
    test(`attacker: every non-owner ${method} is refused and the request file is untouched`, async () => {
      resetRequests();
      rr.createRestartRequest(undefined, { tip: "abc1234", requestedBy: "owner", urgent: false });
      const before = readFileSync(reqFile(), "utf8");
      for (const [who, opts, want] of NON_OWNERS) {
        const r = await call({ url: URL_, method, body: bodyFor(method), ...opts });
        assert.equal(r.status, want, `${who} ${method} -> ${r.status} ${r.body}`);
        assert.equal(r.next, false, `${who} ${method} must not fall through`);
        assert.doesNotMatch(r.body, /rr-\d{14}/, `${who} ${method} must not see the request`);
      }
      assert.equal(readFileSync(reqFile(), "utf8"), before, `${method}: no non-owner changed the request`);
    });
  }

  test("attacker: an owner cookie write from a foreign Origin is refused (CSRF); same-origin cookie works", async () => {
    resetRequests();
    const xsite = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    for (const method of ["POST", "DELETE"]) {
      const r = await call({ url: URL_, method, body: bodyFor(method), headers: { cookie: `vs_device=${ownerTok}`, ...xsite } });
      assert.equal(r.status, 403, `${method} ${r.body}`);
      assert.match(r.body, /cross-site/);
    }
    assert.equal(existsSync(reqFile()), false, "the cross-site POST recorded nothing");
    const ok = await call({ url: URL_, method: "POST", body: { mode: "window" }, headers: { cookie: `vs_device=${ownerTok}` } });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json.request.state, "queued");
  });

  test("owner shapes are allowed for all three methods: local token, paired owner device (Bearer), owner cookie", async () => {
    const owners = [["local token", { local: true, headers: ownerLocal() }], ["owner device", { headers: bearer(ownerTok) }], ["owner cookie", { headers: { cookie: `vs_device=${ownerTok}` } }]];
    for (const [who, opts] of owners) {
      resetRequests();
      const g = await call({ url: URL_, ...opts });
      assert.equal(g.status, 200, `${who} GET ${g.body}`);
      const p = await call({ url: URL_, method: "POST", body: {}, ...opts });
      assert.equal(p.status, 200, `${who} POST ${p.body}`);
      const d = await call({ url: URL_, method: "DELETE", ...opts });
      assert.equal(d.status, 200, `${who} DELETE ${d.body}`);
    }
  });

  test("other methods are 405 for the owner, refused for everyone else", async () => {
    for (const method of ["PUT", "PATCH"]) {
      assert.equal((await call({ url: URL_, method, body: {}, headers: bearer(ownerTok) })).status, 405, method);
      assert.equal((await call({ url: URL_, method, body: {}, headers: bearer(testerTok) })).status, 403, `tester ${method}`);
    }
    assert.equal((await call({ url: URL_, method: "HEAD", local: true })).status, 403, "read-only HEAD");
  });
});

describe("H2 restart-host: round-trip through restart-request.mjs", () => {
  const owner = (method, body) => call({ url: URL_, method, body, headers: bearer(ownerTok) });

  test("GET with no request: { ok, request: null, status }", async () => {
    resetRequests();
    const r = await owner("GET");
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { ok: true, request: null, status: rr.formatRequestStatus(null) });
  });

  test("POST (default urgent) records a requested, urgent owner request at the sync checkout's short HEAD; GET reads it; DELETE aborts", async () => {
    resetRequests();
    const p = await owner("POST", {});
    assert.equal(p.status, 200, p.body);
    const req = p.json.request;
    assert.equal(req.state, "requested");
    assert.equal(req.urgent, true);
    assert.equal(req.urgentReason, "phone cockpit restart");
    assert.equal(req.requestedBy, "owner");
    assert.equal(req.tip, SHORT_HEAD);
    assert.deepEqual([req.team, req.lane], ["vibesquad", "vibesquad"], "logged to the owner hub lane like vs restart request");
    assert.equal(req.scope, "all");
    assert.match(p.json.status, new RegExp(`restart request ${req.id}: requested URGENT`));
    assert.deepEqual(rr.readRestartRequest(), req, "what the server loop reads is what POST answered");

    const g = await owner("GET");
    assert.equal(g.json.request.id, req.id);
    assert.match(g.json.status, new RegExp(`restart request ${req.id}: requested URGENT`));

    const again = await owner("POST", { mode: "urgent", reason: "second" });
    assert.equal(again.status, 409, "an open requested restart refuses a second one (no stacking)");
    assert.match(again.json.error, /still requested/);

    const d = await owner("DELETE");
    assert.equal(d.status, 200, d.body);
    assert.equal(d.json.request.state, "aborted");
    assert.match(d.json.request.abortReason, /aborted by owner: phone cockpit cancel/);
    assert.equal(rr.readRestartRequest().state, "aborted");

    const d2 = await owner("DELETE");
    assert.equal(d2.status, 409, "nothing left to abort");
    assert.match(d2.json.error, /no open restart request/);
  });

  test("POST mode=window queues for the next window with no reason; urgent with a reason promotes it", async () => {
    resetRequests();
    const q = await owner("POST", { mode: "window" });
    assert.equal(q.status, 200, q.body);
    assert.equal(q.json.request.state, "queued");
    assert.equal(q.json.request.urgent, false);
    assert.ok(q.json.request.windowAt);
    const u = await owner("POST", { mode: "urgent", reason: "server wedged" });
    assert.equal(u.status, 200, u.body);
    assert.equal(u.json.request.id, q.json.request.id, "folded into the queued request");
    assert.equal(u.json.request.state, "requested");
    assert.equal(u.json.request.urgentReason, "server wedged");
  });

  test("DELETE cannot call back a request that is already firing (409)", async () => {
    resetRequests();
    const p = await owner("POST", {});
    const doc = JSON.parse(readFileSync(reqFile(), "utf8"));
    doc.current.state = "firing";
    doc.current.firedAt = new Date().toISOString();
    writeFileSync(reqFile(), JSON.stringify(doc));
    const d = await owner("DELETE");
    assert.equal(d.status, 409, d.body);
    assert.match(d.json.error, /cannot be called back/);
    assert.equal(rr.readRestartRequest().id, p.json.request.id);
  });

  test("attacker: bad POST bodies are 400 and record nothing", async () => {
    const bad = [
      { mode: "now" },
      { mode: 1 },
      { mode: "urgent", reason: 5 },
      { mode: "urgent", reason: "x".repeat(api.RESTART_HOST_REASON_MAX + 1) },
      { mode: "window", reason: "why" },
      { mode: "urgent", tip: "evil;rm -rf" },
      { requestedBy: "rn-someone" },
      ["urgent"],
      "\"urgent\"",
      "{not json",
    ];
    for (const body of bad) {
      resetRequests();
      const r = await owner("POST", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.body}`);
      assert.equal(existsSync(reqFile()), false, `${JSON.stringify(body)} recorded nothing`);
    }
  });
});

describe("H2 restart-host: never a raw restart", () => {
  const apiSrc = readFileSync(new URL("../server/vibesquad-api.mjs", import.meta.url), "utf8");
  const start = apiSrc.indexOf("async function handleRestartHost(");
  const handler = apiSrc.slice(start, apiSrc.indexOf("\n}\n", start) + 2);

  test("the handler only uses restart-request.mjs (createRestartRequest / abortRestartRequest / readRestartRequest)", () => {
    assert.ok(start > 0 && handler.length > 200, "handler found");
    assert.match(handler, /createRestartRequest\(/);
    assert.match(handler, /abortRestartRequest\(/);
    assert.match(handler, /readRestartRequest\(/);
    assert.doesNotMatch(handler, /forceRestartRunner|unstick|runVsAsync|runSyncAsync|commandRestart|restart-runtime|spawn|execFile|process\.exit|process\.kill|\.kill\(/);
    assert.match(handler, /if \(!owner\) return sendJson\(res, 403/, "in-handler owner check before any method");
    assert.match(apiSrc, /case "\/__vibesquad\/restart-host":[^\n]*\n\s*return handleRestartHost\(req, res, \{ owner, rootDir \}\);/);
  });

  test("an owner POST leaves the runner and the process alone: it only writes restart-request.json", async () => {
    resetRequests();
    const spawned = [];
    const realExit = process.exit;
    process.exit = (c) => { spawned.push(`exit ${c}`); };
    try {
      const p = await call({ url: URL_, method: "POST", body: {}, headers: bearer(ownerTok) });
      assert.equal(p.status, 200, p.body);
    } finally {
      process.exit = realExit;
    }
    assert.deepEqual(spawned, []);
    const cur = rr.readRestartRequest();
    assert.equal(cur.state, "requested", "the server loop (not this route) drains and fires");
    assert.equal(cur.firedAt, undefined);
    assert.equal(cur.launch, undefined);
  });

  test("resolveRestartTip: no sync checkout -> HEAD; a checkout -> its short hex HEAD", async () => {
    assert.equal(await api.resolveRestartTip({ repoRoot: null }), "HEAD");
    assert.equal(await api.resolveRestartTip({ repoRoot: join(tmpdir(), "vs-h2-no-such-repo") }), "HEAD");
    assert.equal(await api.resolveRestartTip({ repoRoot: REPO }), SHORT_HEAD);
    mkdirSync(join(HOME, "plain"), { recursive: true });
    assert.equal(await api.resolveRestartTip({ repoRoot: join(HOME, "plain") }), "HEAD");
  });
});
