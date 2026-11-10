// E4b (docs/PLAN_ANDROID_END_STATE.md, Tier A, 0.3 X1): phone-minted pairing with two-step confirm, mintedByDeviceId
// cascade revoke, the Hub5 pair/start gate, X1 E4a M3 (device list needs the token), L3 (`vs pair` proves the server
// before sending the token), MUST 6 (host-keypair.json lockdown) and the X1 R2 Lows. Threat note:
// docs/lanes/android-app/E4B_THREAT_NOTE.md. Attacker cases are marked "attacker:".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-e4b-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const cli = await import("../cli/vs.mjs");
const localTokenMod = await import("../server/local-token.mjs");
const logic = await import("../src/phonePairLogic.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const devicesFile = join(home, "devices.json");
const readDevicesJson = () => JSON.parse(readFileSync(devicesFile, "utf8")).devices;
const src = (f) => readFileSync(join(rootDir, f), "utf8");
const VS = join(rootDir, "cli", "vs.mjs");

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    end(b) {
      this.body += b ?? "";
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

let ipN = 20;
const nextIp = () => `100.64.0.${++ipN}`;

/** A request on the Meshnet listener (never loopback). `token` = vs_device cookie value. */
const meshReq = ({ url = "/", method = "GET", token = null, ip = nextIp(), body, headers = {} } = {}) => ({
  url,
  method,
  headers: { host: "100.64.0.7:4180", ...(token ? { cookie: `vs_device=${token}` } : {}), ...headers },
  socket: { remoteAddress: ip, localAddress: "100.64.0.7" },
  body,
  on() {},
});

/** A request on the loopback listener. `withToken` adds the x-vibesquad-token header (what the CLI / desktop proxy send). */
const localReq = ({ url = "/", method = "GET", withToken = false, headers = {}, body } = {}) => ({
  url,
  method,
  headers: { host: "127.0.0.1:4180", ...(withToken ? { "x-vibesquad-token": auth.getLocalToken() } : {}), ...headers },
  socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 },
  body,
  on() {},
});

const bodyOf = (req) => Promise.resolve(req.body ?? {});
const authAs = (token) => auth.authenticate({ headers: { cookie: `vs_device=${token}` }, socket: {} });
const byName = (name) => auth.listDevices().find((d) => d.name === name);

/** Redeems `code` as a new device; returns the response and the vs_device token it was handed (if any). */
function redeem(code, name, ip = nextIp()) {
  const res = fakeRes();
  auth.handlePairRedeem(meshReq({ url: `/pair?code=${code}&name=${encodeURIComponent(name)}`, ip }), res);
  const m = /vs_device=([^;]+)/.exec(String(res.headers["set-cookie"] ?? ""));
  return { res, token: m ? m[1] : null };
}

/** PC-minted pairing (the desktop dialog / `vs pair` path): immediate. */
function pairFromPc(name) {
  const code = auth.createPairCode();
  const { res, token } = redeem(code, name);
  assert.equal(res.statusCode, 302, res.body);
  assert.ok(token);
  return token;
}

/** The phone mints: POST /__vibesquad/pair/start as a paired device. */
async function mint(token) {
  const res = fakeRes();
  await auth.handlePairStart(meshReq({ url: "/__vibesquad/pair/start", method: "POST", token }), res);
  return { res, data: res.body ? res.json() : null };
}

async function pendingFor(token) {
  const res = fakeRes();
  auth.handlePairPending(meshReq({ url: "/__vibesquad/pair/pending", token }), res);
  return { res, data: res.body ? res.json() : null };
}

async function decide(token, pendingId, approve, reqOverride = null) {
  const res = fakeRes();
  await auth.handlePairApprove(reqOverride ?? meshReq({ url: "/__vibesquad/pair/approve", method: "POST", token, body: { pendingId, approve } }), res, bodyOf);
  return { res, data: res.body ? res.json() : null };
}

function statusOf(token) {
  const res = fakeRes();
  auth.handlePairStatus(meshReq({ url: "/pair/status", token }), res);
  return res.json().state;
}

/** Phone-minted pairing end to end: mint on `minterToken`, redeem, approve on the minter. Returns the new device's token. */
async function mintAndApprove(minterToken, name) {
  const { data } = await mint(minterToken);
  const { res, token } = redeem(data.code, name);
  assert.equal(res.statusCode, 200, "pending, not paired");
  const { data: p } = await pendingFor(minterToken);
  const ticket = p.pending.find((x) => x.name === name);
  assert.ok(ticket, "the minter sees the ticket");
  const d = await decide(minterToken, ticket.pendingId, true);
  assert.equal(d.res.statusCode, 200, d.res.body);
  assert.ok(authAs(token), `${name} is paired after approval`);
  return token;
}

const ageDevicesFile = () => {
  const st = statSync(devicesFile);
  utimesSync(devicesFile, st.atime, new Date(st.mtimeMs - 5000));
};

function httpCall({ port, path, method = "GET", headers = {}, body }) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (d) => (text += d));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => server.close(ok));

describe("E4b MUST 1 + 2: a paired phone mints; the redeemed device waits for that phone's Approve", () => {
  test("mint -> redeem lands in pending: the token authenticates nothing, nothing is written, only the minter can decide", async () => {
    const phoneToken = pairFromPc("Owner phone");
    const phone = byName("Owner phone");
    const tablet = pairFromPc("Tablet"); // attacker: another paired device that did not mint
    const { res: startRes, data: start } = await mint(phoneToken);
    assert.equal(startRes.statusCode, 200, startRes.body);
    assert.match(start.code, /^\d{6}$/);
    assert.equal(start.requiresApproval, true);
    assert.equal(start.mintedByDeviceId, phone.id);
    assert.match(start.pairUrl, /^https:\/\/100\.64\.0\.7:4180\/pair\?code=\d{6}&fp=[0-9a-f]{64}$/);
    assert.ok(start.qrSvg.includes("<svg"));

    const before = readFileSync(devicesFile, "utf8");
    const { res, token } = redeem(start.code, "Work PC", "100.64.0.99");
    assert.equal(res.statusCode, 200, "a waiting page, not the 302 that grants entry");
    assert.match(res.body, /Waiting for approval/);
    assert.match(res.body, /Owner phone/, "names the phone that must approve");
    assert.match(res.body, /\/pair\/status/, "the page polls the public status route");
    assert.ok(token, "the cookie carries the (still useless) token");
    assert.ok(!res.body.includes(token), "the token is only in the cookie, never in the page body");
    assert.equal(readFileSync(devicesFile, "utf8"), before, "devices.json untouched: pending lives in memory only");
    assert.equal(auth.pendingCountForTest(), 1);

    // attacker: the pending token before approval
    assert.equal(authAs(token), null, "pending token authenticates nothing");
    assert.equal(statusOf(token), "pending");
    assert.equal((await pendingFor(token)).res.statusCode, 403, "a pending device can't list approvals");
    const { data: tabletView } = await pendingFor(tablet);
    assert.deepEqual(tabletView.pending, [], "another paired device doesn't even see the ticket");
    const { data: phoneView } = await pendingFor(phoneToken);
    assert.equal(phoneView.pending.length, 1);
    const ticket = phoneView.pending[0];
    assert.equal(ticket.name, "Work PC");
    assert.equal(ticket.ip, "100.64.0.99");
    assert.ok(ticket.expiresInMs > 0 && ticket.expiresInMs <= auth.PENDING_TTL_MS);

    // attacker: approval from a non-minting device, from the pending device itself, and from the PC with the local token
    assert.equal((await decide(tablet, ticket.pendingId, true)).res.statusCode, 403);
    assert.equal((await decide(token, ticket.pendingId, true)).res.statusCode, 403);
    const pcApprove = await decide(null, ticket.pendingId, true, localReq({ url: "/__vibesquad/pair/approve", method: "POST", withToken: true, body: { pendingId: ticket.pendingId, approve: true } }));
    assert.equal(pcApprove.res.statusCode, 403, "the PC owner is not the minter either");
    assert.equal(authAs(token), null, "still pending after every refused approval");
    assert.equal(auth.pendingCountForTest(), 1);

    // the minter approves
    const ok = await decide(phoneToken, ticket.pendingId, true);
    assert.equal(ok.res.statusCode, 200, ok.res.body);
    assert.equal(ok.data.approved, true);
    assert.equal(ok.data.device.mintedByDeviceId, phone.id);
    assert.deepEqual(ok.data.pending, []);
    const onDisk = readDevicesJson().find((d) => d.name === "Work PC");
    assert.equal(onDisk.mintedByDeviceId, phone.id, "mintedByDeviceId is recorded on disk");
    assert.equal(authAs(token)?.id, onDisk.id, "the same token now authenticates");
    assert.equal(statusOf(token), "approved");
    assert.equal(auth.pendingCountForTest(), 0);
    assert.equal((await decide(phoneToken, ticket.pendingId, true)).res.statusCode, 404, "a decided ticket is gone");
  });

  test("deny: the ticket is discarded, the token stays dead, the waiting page learns 'denied'", async () => {
    const phoneToken = pairFromPc("Phone D");
    const { data: start } = await mint(phoneToken);
    const { token } = redeem(start.code, "Shoulder surfer");
    const { data: p } = await pendingFor(phoneToken);
    const d = await decide(phoneToken, p.pending[0].pendingId, false);
    assert.equal(d.res.statusCode, 200);
    assert.equal(d.data.approved, false);
    assert.equal(authAs(token), null);
    assert.equal(statusOf(token), "denied");
    assert.equal(auth.pendingCountForTest(), 0);
    assert.ok(!readDevicesJson().some((x) => x.name === "Shoulder surfer"));
  });

  test("attacker: an expired pending entry can't be approved and its token is dead", async () => {
    const phoneToken = pairFromPc("Phone E");
    const { data: start } = await mint(phoneToken);
    const { token } = redeem(start.code, "Slow device");
    const { data: p } = await pendingFor(phoneToken);
    const id = p.pending[0].pendingId;
    auth.expirePendingForTest();
    assert.equal((await decide(phoneToken, id, true)).res.statusCode, 404);
    assert.deepEqual((await pendingFor(phoneToken)).data.pending, []);
    assert.equal(authAs(token), null);
    assert.equal(statusOf(token), "gone");
    assert.ok(!readDevicesJson().some((x) => x.name === "Slow device"));
  });

  test("revoking the minter kills its pending ticket and its unredeemed codes", async () => {
    const phoneToken = pairFromPc("Phone R");
    const phone = byName("Phone R");
    const { data: a } = await mint(phoneToken);
    const { data: b } = await mint(phoneToken);
    const { token } = redeem(a.code, "Pending child");
    assert.equal(auth.pendingCountForTest(), 1);
    assert.deepEqual(auth.revokeDevice(phone.id), [phone.id]);
    assert.equal(auth.pendingCountForTest(), 0, "the ticket died with the minter");
    assert.equal(authAs(token), null);
    const late = redeem(b.code, "Late child");
    assert.equal(late.res.statusCode, 401, "a dead minter's code is invalid");
    assert.equal(late.token, null);
  });

  test("a PC/CLI-minted code still pairs at once (302) with mintedByDeviceId null", () => {
    const token = pairFromPc("Desk browser");
    const d = readDevicesJson().find((x) => x.name === "Desk browser");
    assert.equal(d.mintedByDeviceId, null);
    assert.ok(authAs(token));
    assert.equal(statusOf(token), "approved");
  });

  test("/pair/status is public on both listeners but cookie-scoped: no cookie says nothing", () => {
    const res = fakeRes();
    auth.handlePairStatus(meshReq({ url: "/pair/status" }), res);
    assert.deepEqual(res.json(), { state: "gone" });
    const serve = src("server/serve.mjs");
    assert.ok(serve.indexOf('path === "/pair/status"') < serve.indexOf("const dev = authenticate(req);"), "served before the mesh auth guard");
    const mw = src("server/vibesquad-api.mjs");
    assert.ok(mw.indexOf('path === "/pair/status"') < mw.indexOf("if (isApi && !isTrusted(req))"), "served before the loopback trust gate");
  });
});

describe("E4b MUST 3: mintedByDeviceId cascade revoke", () => {
  test("revoking the root removes 3 levels in one locked write; an unrelated device survives", async () => {
    const rootToken = pairFromPc("Root phone");
    const root = byName("Root phone");
    const childToken = await mintAndApprove(rootToken, "Child PC");
    const child = byName("Child PC");
    const grandToken = await mintAndApprove(childToken, "Grandchild tablet");
    const grand = byName("Grandchild tablet");
    const other = pairFromPc("Independent");
    assert.equal(child.mintedByDeviceId, root.id);
    assert.equal(grand.mintedByDeviceId, child.id);
    assert.deepEqual(auth.cascadeIds(auth.listDevices(), root.id).sort(), [root.id, child.id, grand.id].sort());

    const removed = auth.revokeDevice(root.id);
    assert.deepEqual(removed.sort(), [root.id, child.id, grand.id].sort());
    assert.equal(authAs(rootToken), null);
    assert.equal(authAs(childToken), null);
    assert.equal(authAs(grandToken), null);
    assert.ok(authAs(other), "the unrelated device keeps access");
    assert.ok(!readDevicesJson().some((d) => [root.id, child.id, grand.id].includes(d.id)));
    const a = src("server/auth.mjs");
    const fn = a.slice(a.indexOf("export function revokeDevice("), a.indexOf("export function revokeAllDevices("));
    assert.equal((fn.match(/mutateDevices\(/g) ?? []).length, 1, "one locked read-modify-write for the whole cascade");
    assert.match(fn, /cascadeIds\(list, id\)/);
  });

  test("cascadeIds is pure and cycle-safe; revoking a leaf touches only the leaf", () => {
    const list = [
      { id: "a", mintedByDeviceId: "c" },
      { id: "b", mintedByDeviceId: "a" },
      { id: "c", mintedByDeviceId: "b" },
      { id: "x", mintedByDeviceId: null },
    ];
    assert.deepEqual(auth.cascadeIds(list, "a").sort(), ["a", "b", "c"]);
    assert.deepEqual(auth.cascadeIds(list, "x"), ["x"]);
    assert.deepEqual(auth.cascadeIds(list, "nope"), ["nope"]);
  });

  test("UI revoke (POST /__vibesquad/devices/revoke) reports the cascade; `vs devices revoke` prints it", async () => {
    const rootToken = pairFromPc("Root 2");
    const root = byName("Root 2");
    const childToken = await mintAndApprove(rootToken, "Child 2");
    const grandToken = await mintAndApprove(childToken, "Grandchild 2");
    const viewer = pairFromPc("Viewer");
    const res = fakeRes();
    await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: viewer, body: { id: byName("Child 2").id } }), res, bodyOf);
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    assert.equal(j.removed.length, 2, "child + grandchild");
    assert.ok(j.devices.every((d) => Object.hasOwn(d, "mintedByDeviceId")), "the list carries mintedByDeviceId for the UI warning");
    assert.ok(j.devices.some((d) => d.id === root.id));
    assert.equal(authAs(childToken), null);
    assert.equal(authAs(grandToken), null);
    assert.ok(authAs(rootToken));

    const kid = await mintAndApprove(rootToken, "Child 3");
    ageDevicesFile();
    const r = spawnSync(process.execPath, [VS, "devices", "revoke", root.id], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "", VS_AGENT_ID: "" }, windowsHide: true, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Also revoked 1 device it paired: Child 3/);
    assert.equal(authAs(kid), null, "the server noticed the out-of-process cascade");
    assert.equal(authAs(rootToken), null);
  });
});

describe("E4b MUST 4 (Hub5) + X1 M3: pair/start and the device list need the local token on loopback", () => {
  test("attacker: a token-less loopback non-browser call can't mint, in the handler itself", async () => {
    let res = fakeRes();
    await auth.handlePairStart(localReq({ url: "/__vibesquad/pair/start", method: "POST" }), res);
    assert.equal(res.statusCode, 403, res.body);
    res = fakeRes(); // a token-less loopback *browser* can't either
    await auth.handlePairStart(localReq({ url: "/__vibesquad/pair/start", method: "POST", headers: { "user-agent": "Mozilla/5.0", origin: "http://127.0.0.1:4180", "sec-fetch-site": "same-origin" } }), res);
    assert.equal(res.statusCode, 403, res.body);
    res = fakeRes(); // the local token (CLI / desktop proxy) mints a plain, no-approval code
    await auth.handlePairStart(localReq({ url: "/__vibesquad/pair/start", method: "POST", withToken: true }), res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().requiresApproval, false);
    assert.equal(res.json().mintedByDeviceId, null);
  });

  test("attacker: the device list without the token is refused by the handler and the router", async () => {
    pairFromPc("Listed");
    const res = fakeRes();
    auth.handleDevices(localReq({ url: "/__vibesquad/devices" }), res);
    assert.equal(res.statusCode, 403, res.body);
    assert.ok(!res.body.includes("Listed"));
    assert.equal(api.isGatedRead("/__vibesquad/devices"), true);
    assert.equal(api.isGatedRead("/__vibesquad/pair/pending"), true);

    const server = createServer(api.createVibesquadMiddleware(rootDir));
    const port = await listen(server);
    try {
      let r = await httpCall({ port, path: "/__vibesquad/devices" });
      assert.equal(r.status, 403);
      assert.ok(!r.text.includes("Listed"));
      r = await httpCall({ port, path: "/__vibesquad/pair/pending" });
      assert.equal(r.status, 403);
      r = await httpCall({ port, path: "/__vibesquad/pair/start", method: "POST" });
      assert.equal(r.status, 403);
      r = await httpCall({ port, path: "/__vibesquad/devices", headers: { "x-vibesquad-token": auth.getLocalToken() } });
      assert.equal(r.status, 200);
      assert.ok(r.json().devices.some((d) => d.name === "Listed"));
    } finally {
      await close(server);
    }
  });
});

describe("E4b MUST 5 (X1 L3): `vs pair` makes the listener prove the local token before sending it", () => {
  const tokenFile = join(home, "local-token");

  test("attacker: a rogue loopback listener never receives x-vibesquad-token", async () => {
    auth.getLocalToken();
    const seen = [];
    const rogue = createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers["x-vibesquad-token"] ?? null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, proof: "f".repeat(64), code: "123456", pairUrl: "https://evil/pair?code=123456" }));
    });
    const port = await listen(rogue);
    try {
      await assert.rejects(cli.requestPairStart({ port, file: tokenFile }), /failed the local-token proof; the local token was not sent/);
    } finally {
      await close(rogue);
    }
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((s) => s.token === null), "no request to the rogue carried the token");
    assert.ok(seen.every((s) => s.url.startsWith("/__vibesquad/local-proof?c=")), "only the challenge went out");
  });

  test("attacker: a rogue that relays the challenge to a real server on another port fails (proof is port-bound)", async () => {
    const real = createServer(api.createVibesquadMiddleware(rootDir));
    const realPort = await listen(real);
    const seen = [];
    const relay = createServer((req, res) => {
      seen.push(req.headers["x-vibesquad-token"] ?? null);
      const up = request({ host: "127.0.0.1", port: realPort, path: req.url, method: req.method, headers: { host: `127.0.0.1:${realPort}` } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    const relayPort = await listen(relay);
    try {
      await assert.rejects(cli.requestPairStart({ port: relayPort, file: tokenFile }), /failed the local-token proof/);
      assert.ok(seen.every((t) => t === null), "the relay never saw the token");
      // the real server, addressed directly, proves itself and `vs pair` goes through
      assert.equal(await localTokenMod.proveLocalServer({ port: realPort, token: auth.getLocalToken() }), true);
      const p = await cli.requestPairStart({ port: realPort, file: tokenFile });
      assert.match(p.code, /^\d{6}$/);
      assert.equal(p.requiresApproval, false, "CLI-minted codes pair at once");
    } finally {
      await close(relay);
      await close(real);
    }
  });

  test("the proof route is loopback-only, rejects bad nonces, and is a keyed HMAC over nonce + port", () => {
    let res = fakeRes();
    auth.handleLocalProof(meshReq({ url: "/__vibesquad/local-proof?c=" + "a".repeat(32) }), res);
    assert.equal(res.statusCode, 403);
    res = fakeRes();
    auth.handleLocalProof(localReq({ url: "/__vibesquad/local-proof?c=short" }), res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    auth.handleLocalProof(localReq({ url: "/__vibesquad/local-proof?c=" + "b".repeat(32) }), res);
    assert.equal(res.statusCode, 200);
    const { proof, port } = res.json();
    assert.equal(port, 4180);
    assert.equal(proof, auth.localProof(auth.getLocalToken(), "b".repeat(32), 4180));
    assert.notEqual(proof, auth.localProof(auth.getLocalToken(), "b".repeat(32), 4181), "port-bound");
    assert.notEqual(proof, auth.localProof(auth.getLocalToken(), "c".repeat(32), 4180), "nonce-bound");
    assert.ok(!res.body.includes(auth.getLocalToken()), "the token itself never leaves the server");
    const vs = src("cli/vs.mjs");
    const fn = vs.slice(vs.indexOf("export async function requestPairStart("), vs.indexOf("async function commandPair("));
    assert.ok(fn.indexOf("await proveLocalServer(") < fn.indexOf("[LOCAL_TOKEN_HEADER]: token"), "proof before the header goes out");
  });
});

describe("E4b MUST 6: the E5 host keypair is a home secret", () => {
  test("HOME_SECRET_FILES lists host-keypair.json (POSIX 0600 at startup)", () => {
    assert.ok(auth.HOME_SECRET_FILES.includes("host-keypair.json"));
    const chmods = [];
    auth.lockDownVibesquadHome({ home: "/h/.vibesquad", platform: "linux", lock: () => {}, mkdir: () => {}, exists: () => true, chmod: (f, m) => chmods.push([f.replace(/\\/g, "/"), m]) });
    assert.ok(chmods.some(([f, m]) => f === "/h/.vibesquad/host-keypair.json" && m === 0o600));
  });
});

describe("E4b MUST 7: X1 E4a R2 Lows", () => {
  const lock = `${devicesFile}.lock`;

  test("L1: a request-path write gives up on a held lock in ~200 ms (the CLI keeps 5 s)", () => {
    const code = auth.createPairCode();
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const t0 = Date.now();
    try {
      const { res } = redeem(code, "Blocked");
      assert.equal(res.statusCode, 503, res.body);
    } finally {
      rmSync(lock, { force: true });
    }
    const took = Date.now() - t0;
    assert.ok(took < 1500, `pair redeem waited ${took} ms; request paths must use the 200 ms budget`);
    const a = src("server/auth.mjs");
    assert.match(a, /const REQUEST_LOCK_MS = 200;/);
    assert.match(a.slice(a.indexOf("function persistLastSeen("), a.indexOf("export function resetDevicesForTest(")), /timeoutMs: REQUEST_LOCK_MS/);
    const vs = src("cli/vs.mjs");
    assert.match(vs, /auth\.revokeDevice\(matches\[0\]\.id\)/, "the CLI passes no timeout: file-lock's 5 s default");
  });

  test("L2: an unreadable devices.json destroys every tracked live socket (fail closed covers open streams)", () => {
    const token = pairFromPc("Streamer");
    const dev = byName("Streamer");
    const destroyed = [];
    auth.trackSocket(dev.id, { destroy: () => destroyed.push(dev.id), once() {} });
    assert.equal(auth.hasDeviceSockets(dev.id), true);
    const good = readFileSync(devicesFile, "utf8");
    writeFileSync(devicesFile, "{ not json");
    ageDevicesFile();
    try {
      assert.equal(authAs(token), null, "refused while unreadable");
      assert.deepEqual(destroyed, [dev.id], "the open stream was cut, not left flowing");
      assert.equal(auth.hasDeviceSockets(dev.id), false);
    } finally {
      writeFileSync(devicesFile, good);
      ageDevicesFile();
    }
    assert.ok(authAs(token), "recovers once readable");
  });

  test("L3: a lock timeout on UI revoke is a generic retryable 503 with no path or pid", async () => {
    const victim = pairFromPc("Victim");
    const me = pairFromPc("Revoker");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const res = fakeRes();
    try {
      await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: me, body: { id: byName("Victim").id } }), res, bodyOf);
    } finally {
      rmSync(lock, { force: true });
    }
    assert.equal(res.statusCode, 503, res.body);
    assert.deepEqual(res.json(), { error: "device list busy or unreadable; retry", retryable: true });
    assert.ok(!res.body.includes(".lock") && !/pid/i.test(res.body) && !res.body.includes(home));
    assert.ok(authAs(victim), "nothing was revoked");
    const bad = fakeRes();
    await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: me, body: {} }), bad, bodyOf);
    assert.equal(bad.statusCode, 400, "a bad body is still the caller's fault");
  });

  test("L4: writeDevicesFile asserts lock ownership right before the rename (shared file-lock primitive)", () => {
    const a = src("server/auth.mjs");
    const fn = a.slice(a.indexOf("function writeDevicesFile("), a.indexOf("function mutateDevices("));
    assert.ok(fn.indexOf("lock?.assertOwned()") > 0 && fn.indexOf("lock?.assertOwned()") < fn.indexOf("renameSync(tmp, devicesFile())"));
    assert.match(a, /withFileLockSync\(devicesFile\(\), \(lock\) =>/);
    const fl = src("server/file-lock.mjs");
    assert.ok(fl.indexOf("lock.assertOwned()") < fl.indexOf("writeFileAtomic(targetPath"), "updateJsonFileSync (teams-file, inbox) checks too");
  });
});

describe("E4b MUST 8: the phone ⋯ sheet (PhonePairSheet) lists, warns on cascade, approves", () => {
  test("descendantsOf / cascadeWarning over mintedByDeviceId (3 levels, cycle-safe)", () => {
    const devices = [
      { id: "root", name: "Phone", mintedByDeviceId: null },
      { id: "c1", name: "Work PC", mintedByDeviceId: "root" },
      { id: "g1", name: "Tablet", mintedByDeviceId: "c1" },
      { id: "other", name: "Desk", mintedByDeviceId: null },
      { id: "loopA", name: "A", mintedByDeviceId: "loopB" },
      { id: "loopB", name: "B", mintedByDeviceId: "loopA" },
    ];
    assert.deepEqual(logic.descendantsOf(devices, "root").map((d) => d.id), ["c1", "g1"]);
    assert.deepEqual(logic.descendantsOf(devices, "g1"), []);
    assert.deepEqual(logic.descendantsOf(devices, "loopA").map((d) => d.id), ["loopB"]);
    assert.equal(logic.cascadeWarning(devices, "root"), "Also revokes 2 devices it paired: Work PC, Tablet.");
    assert.equal(logic.cascadeWarning(devices, "c1"), "Also revokes 1 device it paired: Tablet.");
    assert.equal(logic.cascadeWarning(devices, "other"), null);
    assert.equal(logic.formatPairCode("123456"), "123 456");
    assert.equal(logic.secondsLeft(10_500, 10_000), 1);
    assert.equal(logic.secondsLeft(9_000, 10_000), 0);
    assert.equal(logic.agoLabel(undefined, 0), "never");
    assert.equal(logic.agoLabel(new Date(0).toISOString(), 5 * 60_000), "5m ago");
    assert.equal(logic.mintedByLabel(devices, devices[1]), "Phone");
    assert.equal(logic.mintedByLabel(devices, { id: "z", name: "Z", mintedByDeviceId: "gone" }), "a revoked device");
  });

  test("App mounts the sheet through PhoneCockpit's pairSlot; the sheet hits the E4b routes and shows a cascade confirm", () => {
    const app = src("src/App.tsx");
    const gate = app.indexOf("if (phoneShell)");
    assert.ok(app.indexOf("pairSlot={<PhonePairSheet />}") > gate);
    const sheet = src("src/PhonePairSheet.tsx");
    for (const route of ['"/__vibesquad/pair/start"', '"/__vibesquad/pair/pending"', '"/__vibesquad/pair/approve"', '"/__vibesquad/devices"', '"/__vibesquad/devices/revoke"']) {
      assert.ok(sheet.includes(route), `sheet uses ${route}`);
    }
    for (const id of ["phone-pair-code", "phone-pair-qr", "phone-pair-link", "phone-pair-approve", "phone-pair-deny", "phone-pair-revoke", "phone-pair-revoke-confirm", "phone-pair-cascade"]) {
      assert.ok(sheet.includes(`data-testid="${id}"`), `sheet has ${id}`);
    }
    assert.ok(sheet.includes("cascadeWarning(devices, d.id)"), "the warning comes from the shared logic");
    const cockpit = src("src/PhoneCockpit.tsx");
    assert.ok(cockpit.includes('className="phone-pair-slot"') && cockpit.includes("{pairSlot}"), "E1's slot is where it renders");
    const css = src("src/styles.css");
    for (const cls of [".phone-pair-sheet", ".phone-pair-code", ".phone-pair-pending-item", ".phone-pair-cascade", ".phone-pair-device"]) assert.ok(css.includes(cls), `css rule for ${cls}`);
    assert.match(css, /\.phone-pair-sheet[^}]*--phone-safe-top/, "E1b: top-anchored sheets respect the phone safe area");
  });
});
