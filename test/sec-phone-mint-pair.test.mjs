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
async function redeem(code, name, ip = nextIp()) {
  const res = fakeRes();
  await auth.handlePairRedeem(meshReq({ url: `/pair?code=${code}&name=${encodeURIComponent(name)}`, ip }), res);
  const m = /vs_device=([^;]+)/.exec(String(res.headers["set-cookie"] ?? ""));
  return { res, token: m ? m[1] : null };
}

/** PC-minted pairing (the desktop dialog / `vs pair` path): immediate. */
async function pairFromPc(name) {
  const code = auth.createPairCode();
  const { res, token } = await redeem(code, name);
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
  const { res, token } = await redeem(data.code, name);
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
    const phoneToken = await pairFromPc("Owner phone");
    const phone = byName("Owner phone");
    const tablet = await pairFromPc("Tablet"); // attacker: another paired device that did not mint
    const { res: startRes, data: start } = await mint(phoneToken);
    assert.equal(startRes.statusCode, 200, startRes.body);
    assert.match(start.code, /^\d{6}$/);
    assert.equal(start.requiresApproval, true);
    assert.equal(start.mintedByDeviceId, phone.id);
    assert.match(start.pairUrl, /^https:\/\/100\.64\.0\.7:4180\/pair\?code=\d{6}&fp=[0-9a-f]{64}$/);
    assert.ok(start.qrSvg.includes("<svg"));

    const before = readFileSync(devicesFile, "utf8");
    const { res, token } = await redeem(start.code, "Work PC", "100.64.0.99");
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
    const phoneToken = await pairFromPc("Phone D");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Shoulder surfer");
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
    const phoneToken = await pairFromPc("Phone E");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Slow device");
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
    const phoneToken = await pairFromPc("Phone R");
    const phone = byName("Phone R");
    const { data: a } = await mint(phoneToken);
    const { token } = await redeem(a.code, "Pending child");
    const { data: b } = await mint(phoneToken); // minted after the redeem: the cap (X1 L2) replaces only *live* codes
    assert.equal(auth.pendingCountForTest(), 1);
    assert.deepEqual(auth.revokeDevice(phone.id), [phone.id]);
    assert.equal(auth.pendingCountForTest(), 0, "the ticket died with the minter");
    assert.equal(authAs(token), null);
    const late = await redeem(b.code, "Late child");
    assert.equal(late.res.statusCode, 401, "a dead minter's code is invalid");
    assert.equal(late.token, null);
  });

  test("a PC/CLI-minted code still pairs at once (302) with mintedByDeviceId null", async () => {
    const token = await pairFromPc("Desk browser");
    const d = readDevicesJson().find((x) => x.name === "Desk browser");
    assert.equal(d.mintedByDeviceId, null);
    assert.ok(authAs(token));
    assert.equal(statusOf(token), "approved");
  });

  test("/pair/status is public on both listeners but cookie-scoped: no cookie says nothing", async () => {
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
    const rootToken = await pairFromPc("Root phone");
    const root = byName("Root phone");
    const childToken = await mintAndApprove(rootToken, "Child PC");
    const child = byName("Child PC");
    const grandToken = await mintAndApprove(childToken, "Grandchild tablet");
    const grand = byName("Grandchild tablet");
    const other = await pairFromPc("Independent");
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

  test("cascadeIds is pure and cycle-safe; revoking a leaf touches only the leaf", async () => {
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
    const rootToken = await pairFromPc("Root 2");
    const root = byName("Root 2");
    const childToken = await mintAndApprove(rootToken, "Child 2");
    const grandToken = await mintAndApprove(childToken, "Grandchild 2");
    const viewer = await pairFromPc("Viewer");
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
    const r = spawnSync(process.execPath, [VS, "devices", "revoke", root.id], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "", VS_AGENT_ID: "", VS_AGENT_TOKEN: "" }, windowsHide: true, timeout: 60_000 });
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
    await pairFromPc("Listed");
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

  test("the proof route is loopback-only, rejects bad nonces, and is a keyed HMAC over nonce + port", async () => {
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
    // unit-and-prove-local: the proof-then-header order now lives in fetchWithLocalToken (server/local-token.mjs); `vs pair` only calls it.
    assert.ok(fn.includes("await fetchWithLocalToken("), "the token goes out only through the proving helper");
    assert.ok(!fn.includes("LOCAL_TOKEN_HEADER") && !fn.includes("readLocalToken("), "requestPairStart never touches the token itself");
  });
});

describe("E4b MUST 6: the E5 host keypair is a home secret", () => {
  test("HOME_SECRET_FILES lists host-keypair.json (POSIX 0600 at startup)", async () => {
    assert.ok(auth.HOME_SECRET_FILES.includes("host-keypair.json"));
    const chmods = [];
    auth.lockDownVibesquadHome({ home: "/h/.vibesquad", platform: "linux", lock: () => {}, mkdir: () => {}, exists: () => true, chmod: (f, m) => chmods.push([f.replace(/\\/g, "/"), m]) });
    assert.ok(chmods.some(([f, m]) => f === "/h/.vibesquad/host-keypair.json" && m === 0o600));
  });
});

describe("E4b MUST 7: X1 E4a R2 Lows", () => {
  const lock = `${devicesFile}.lock`;

  test("L1: a request-path write gives up on a held lock in ~200 ms (the CLI keeps 5 s)", async () => {
    const code = auth.createPairCode();
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const t0 = Date.now();
    try {
      const { res } = await redeem(code, "Blocked");
      assert.equal(res.statusCode, 503, res.body);
    } finally {
      rmSync(lock, { force: true });
    }
    const took = Date.now() - t0;
    assert.ok(took < 1500, `pair redeem waited ${took} ms; request paths must use the 200 ms budget`);
    const a = src("server/auth.mjs");
    assert.match(a, /const REQUEST_LOCK_MS = 200;/);
    assert.match(a.slice(a.indexOf("function persistLastSeen("), a.indexOf("export function resetDevicesForTest(")), /timeoutMs: 0 }/, "idea-227: last-seen runs inside the sync authenticate(), so it tries the lock once and never waits");
    const vs = src("cli/vs.mjs");
    assert.match(vs, /auth\.revokeDevice\(matches\[0\]\.id\)/, "the CLI passes no timeout: file-lock's 5 s default");
  });

  test("L2: an unreadable devices.json destroys every tracked live socket (fail closed covers open streams)", async () => {
    const token = await pairFromPc("Streamer");
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
    const victim = await pairFromPc("Victim");
    const me = await pairFromPc("Revoker");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const res = fakeRes();
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(" "));
    try {
      await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: me, body: { id: byName("Victim").id } }), res, bodyOf);
    } finally {
      console.warn = realWarn;
      rmSync(lock, { force: true });
    }
    assert.equal(res.statusCode, 503, res.body);
    assert.deepEqual(res.json(), { error: "device list busy or unreadable; retry", retryable: true });
    assert.ok(!res.body.includes(".lock") && !/pid/i.test(res.body) && !res.body.includes(home));
    assert.ok(warned.some((w) => w.includes("Timed out") && w.includes(".lock")), `idea-232 L3: the detail is logged server-side only: ${warned}`);
    assert.ok(authAs(victim), "nothing was revoked");
    const bad = fakeRes();
    await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: me, body: {} }), bad, bodyOf);
    assert.equal(bad.statusCode, 400, "a bad body is still the caller's fault");
  });

  test("idea-232 L3: a teams PUT lock timeout is a generic retryable 503 with no path or pid; a bad body stays 400", async () => {
    const teamsLock = join(home, "teams.json.lock");
    writeFileSync(teamsLock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const server = createServer(api.createVibesquadMiddleware(rootDir));
    const port = await listen(server);
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(" "));
    try {
      const headers = { "x-vibesquad-token": auth.getLocalToken() };
      const r = await httpCall({ port, path: "/api/teams", method: "PUT", headers, body: { teams: [] } });
      assert.equal(r.status, 503, r.text);
      assert.deepEqual(r.json(), { error: "teams registry busy or unwritable; retry", retryable: true });
      assert.ok(!r.text.includes(".lock") && !/pid/i.test(r.text) && !r.text.includes(home), r.text);
      assert.ok(warned.some((w) => w.includes("Timed out") && w.includes(".lock")), `the detail is logged server-side only: ${warned}`);
      rmSync(teamsLock, { force: true });
      const bad = await httpCall({ port, path: "/api/teams", method: "PUT", headers, body: { teams: "nope" } });
      assert.equal(bad.status, 400, "a bad body is still the caller's fault");
      assert.match(bad.text, /teams must be an array/);
    } finally {
      console.warn = realWarn;
      rmSync(teamsLock, { force: true });
      await close(server);
    }
  });

  test("idea-232 L2: a corrupt devices.json cuts an open stream with no request in flight (the 1 s device watch)", async () => {
    await pairFromPc("Idle streamer");
    const dev = byName("Idle streamer");
    const destroyed = [];
    auth.trackSocket(dev.id, { destroy: () => destroyed.push(dev.id), once() {} });
    const good = readFileSync(devicesFile, "utf8");
    writeFileSync(devicesFile, "{ not json");
    ageDevicesFile();
    try {
      const t0 = Date.now();
      while (!destroyed.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(destroyed, [dev.id], "the watch dropped the stream without any request re-checking");
      assert.equal(auth.hasDeviceSockets(dev.id), false);
    } finally {
      writeFileSync(devicesFile, good);
      ageDevicesFile();
    }
  });

  test("idea-232 L2: a devices.json that can't even be stat'ed fails closed (drops streams, never throws)", async () => {
    // No portable way to make statSync throw (EACCES/ELOOP/ENAMETOOLONG) on every CI OS, so pin the shape: the stamp is
    // taken inside loadDevices' fail-closed try, and the 1 s watch never lets a throw escape its timer.
    const a = src("server/auth.mjs");
    const load = a.slice(a.indexOf("function loadDevices("), a.indexOf("function writeDevicesFile("));
    assert.ok(load.indexOf("try {") >= 0 && load.indexOf("try {") < load.indexOf("devicesFileStamp()"), "the stat is inside the try");
    assert.ok(load.indexOf("dropDeviceSockets(id)") > load.indexOf("catch (e)"), "the catch drops every tracked socket");
    const watch = a.slice(a.indexOf("function ensureDeviceWatch("), a.indexOf("export function trackSocket("));
    assert.match(watch, /try \{\s*loadDevices\(\);[\s\S]*catch[\s\S]*dropDeviceSockets/, "the watch fails closed on any throw");
  });

  test("L4: writeDevicesFile asserts lock ownership right before the rename (shared file-lock primitive)", async () => {
    const a = src("server/auth.mjs");
    const fn = a.slice(a.indexOf("function writeDevicesFile("), a.indexOf("function mutateDevices("));
    assert.ok(fn.indexOf("lock?.assertOwned()") > 0 && fn.indexOf("lock?.assertOwned()") < fn.indexOf("renameSync(tmp, devicesFile())"));
    assert.match(a, /withFileLockSync\(devicesFile\(\), \(lock\) => devicesMutation\(mutate, lock\)/);
    assert.match(a, /withFileLock\(devicesFile\(\), \(lock\) => devicesMutation\(mutate, lock\)/, "the async request-path writer shares the same body");
    const body = a.slice(a.indexOf("function devicesMutation("), a.indexOf("function devicesMutation(") + 400);
    assert.match(body, /writeDevicesFile\(list, lock\)/, "the shared body hands the lock to writeDevicesFile");
    const fl = src("server/file-lock.mjs");
    assert.ok(fl.indexOf("lock.assertOwned()") < fl.indexOf("writeFileAtomic(targetPath"), "updateJsonFileSync (teams-file, inbox) checks too");
  });
});

describe("E4b MUST 8: the phone ⋯ sheet (PhonePairSheet) lists, warns on cascade, approves", () => {
  test("descendantsOf / cascadeWarning over mintedByDeviceId (3 levels, cycle-safe)", async () => {
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

  test("App mounts the sheet through PhoneCockpit's pairSlot; the sheet hits the E4b routes and shows a cascade confirm", async () => {
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

describe("E4b review fix round (Review-Gemini R1 L1/L2, X1 walk L1/L2/L3/L5)", () => {
  const lock = `${devicesFile}.lock`;

  test("X1-L2: one live code per minter; a new mint replaces the previous one (phone and PC alike)", async () => {
    const phoneToken = await pairFromPc("Capped phone");
    const phone = byName("Capped phone");
    const { data: first } = await mint(phoneToken);
    const { data: second } = await mint(phoneToken);
    assert.notEqual(first.code, second.code);
    assert.equal(auth.liveCodeCountForTest(phone.id), 1, "only the newest code is live");
    const dead = await redeem(first.code, "Old QR");
    assert.equal(dead.res.statusCode, 401, "the replaced code is invalid");
    assert.equal(dead.token, null);
    const live = await redeem(second.code, "New QR");
    assert.equal(live.res.statusCode, 200, "the newest code still lands in pending");
    assert.equal(auth.pendingCountForTest(), 1);
    const { data: p } = await pendingFor(phoneToken);
    await decide(phoneToken, p.pending[0].pendingId, false);
    // the PC / CLI is one minter too
    const a = auth.createPairCode();
    const b = auth.createPairCode();
    assert.equal(auth.liveCodeCountForTest(null), 1);
    assert.equal((await redeem(a, "Stale PC code")).res.statusCode, 401);
    assert.equal((await redeem(b, "Fresh PC code")).res.statusCode, 302);
    // a phone's mint never touches the PC's live code and vice versa
    const pc = auth.createPairCode();
    await mint(phoneToken);
    assert.equal(auth.liveCodeCountForTest(null), 1);
    assert.equal(auth.liveCodeCountForTest(phone.id), 1);
    assert.equal((await redeem(pc, "PC code survives")).res.statusCode, 302);
  });

  test("X1-L3: approve and deny write a vs log audit entry (needs-you on approve) with names, IP and ids, never a token or code", async () => {
    const phoneToken = await pairFromPc("Auditor phone");
    const phone = byName("Auditor phone");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Audited PC", "100.64.0.77");
    const { data: p } = await pendingFor(phoneToken);
    const ok = await decide(phoneToken, p.pending[0].pendingId, true);
    assert.equal(ok.res.statusCode, 200, ok.res.body);
    const laneLog = join(home, "logs", `${auth.PAIR_AUDIT_TEAM}--${auth.PAIR_AUDIT_LANE}.jsonl`);
    const teamLog = join(home, "teams", auth.PAIR_AUDIT_TEAM, "log.jsonl");
    assert.ok(existsSync(laneLog) && existsSync(teamLog), "lane log + team log (what every paired device's log view reads)");
    const entries = readFileSync(laneLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const e = entries.at(-1);
    assert.equal(e.type, "needs-you");
    assert.match(e.text, /approved/);
    assert.ok(e.text.includes("Audited PC") && e.text.includes("100.64.0.77") && e.text.includes("Auditor phone"));
    const audited = byName("Audited PC");
    assert.ok(e.refs.includes(`mintedBy:${phone.id}`) && e.refs.includes(`device:${audited.id}`));
    const hash = readDevicesJson().find((d) => d.id === audited.id).tokenHash;
    const raw = readFileSync(laneLog, "utf8") + readFileSync(teamLog, "utf8");
    assert.ok(!raw.includes(token) && !raw.includes(start.code) && !raw.includes(hash), "no token, hash or code in the log");
    // deny is audited as a metric
    const { data: s2 } = await mint(phoneToken);
    await redeem(s2.code, "Denied PC", "100.64.0.78");
    const { data: p2 } = await pendingFor(phoneToken);
    await decide(phoneToken, p2.pending[0].pendingId, false);
    const after = readFileSync(laneLog, "utf8");
    const last = after.trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.type, "metric");
    assert.match(last.text, /denied/);
    assert.ok(last.text.includes("Denied PC") && !after.includes(s2.code));
  });

  test("X1-L1: an already-paired device opening a device-minted link keeps its cookie; the code stays live", async () => {
    const ownerToken = await pairFromPc("Owner phone L1");
    const owner = byName("Owner phone L1");
    const p1 = await pairFromPc("Paired not owner");
    const { data: start } = await mint(p1); // attacker: P1 sends the owner this link
    const res = fakeRes();
    await auth.handlePairRedeem(meshReq({ url: `/pair?code=${start.code}`, token: ownerToken, ip: "100.64.0.80" }), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Already paired/);
    assert.match(res.body, /\/__vibesquad\/enter/);
    assert.equal(res.headers["set-cookie"], undefined, "the live cookie is not replaced");
    assert.equal(authAs(ownerToken)?.id, owner.id, "still the owner's own device");
    assert.equal(auth.pendingCountForTest(), 0, "no ticket was created for the owner");
    assert.equal(auth.liveCodeCountForTest(byName("Paired not owner").id), 1, "the code was not spent");
    const fresh = await redeem(start.code, "Intended device", "100.64.0.81");
    assert.equal(fresh.res.statusCode, 200, "the device it was meant for still lands in pending");
    const { data: p } = await pendingFor(p1);
    await decide(p1, p.pending[0].pendingId, false);
    // a stale cookie (revoked device) does not count as paired: the link redeems normally
    const stale = await pairFromPc("Stale cookie");
    auth.revokeDevice(byName("Stale cookie").id);
    const { data: s2 } = await mint(p1);
    const r2 = fakeRes();
    await auth.handlePairRedeem(meshReq({ url: `/pair?code=${s2.code}`, token: stale, ip: "100.64.0.82" }), r2);
    assert.equal(r2.statusCode, 200);
    assert.match(r2.body, /Waiting for approval/);
    const { data: p3 } = await pendingFor(p1);
    await decide(p1, p3.pending[0].pendingId, false);
  });

  test("X1-L5: the PC owner (local token) mints no-approval codes even with a vs_device cookie; a remote paired browser gets the approve UI", async () => {
    const browser = await pairFromPc("PC browser");
    let res = fakeRes();
    await auth.handlePairStart(localReq({ url: "/__vibesquad/pair/start", method: "POST", withToken: true, headers: { cookie: `vs_device=${browser}` } }), res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().requiresApproval, false, "local owner wins over the cookie");
    assert.equal(res.json().mintedByDeviceId, null);
    assert.equal((await redeem(res.json().code, "Immediate")).res.statusCode, 302);
    res = fakeRes(); // the same cookie from a remote listener (a work PC browser paired over https) still needs approval
    await auth.handlePairStart(meshReq({ url: "/__vibesquad/pair/start", method: "POST", token: browser }), res);
    assert.equal(res.json().requiresApproval, true);
    const modal = src("src/PairDeviceModal.tsx");
    assert.ok(modal.includes('"/__vibesquad/pair/pending"') && modal.includes('"/__vibesquad/pair/approve"'), "desktop modal polls and decides");
    assert.ok(modal.includes('data-testid="pair-pending-approve"') && modal.includes('data-testid="pair-pending-deny"'));
    assert.ok(modal.includes("pair?.requiresApproval"), "only when this browser's mint needs a second tap");
    assert.ok(src("src/styles.css").includes(".pair-pending-item"));
  });

  test("Gemini-L1: a 503 lock timeout on approve keeps the ticket, so the retry succeeds", async () => {
    const phoneToken = await pairFromPc("Retry phone");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Retry PC");
    const { data: p } = await pendingFor(phoneToken);
    const id = p.pending[0].pendingId;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    let r;
    try {
      r = await decide(phoneToken, id, true);
    } finally {
      rmSync(lock, { force: true });
    }
    assert.equal(r.res.statusCode, 503);
    assert.equal(r.data.retryable, true);
    assert.equal(auth.pendingCountForTest(), 1, "the ticket survived the failed write");
    assert.equal(statusOf(token), "pending");
    assert.equal(authAs(token), null, "nothing was written");
    const again = await decide(phoneToken, id, true);
    assert.equal(again.res.statusCode, 200, again.res.body);
    assert.ok(authAs(token), "the retry paired it");
    assert.equal(auth.pendingCountForTest(), 0);
  });

  test("idea-227: approve waits on the lock without blocking; a second decision in that gap is a 404, the device lands once", async () => {
    const phoneToken = await pairFromPc("Double-tap phone");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Double-tap PC");
    const { data: p } = await pendingFor(phoneToken);
    const id = p.pending[0].pendingId;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    let first;
    try {
      first = decide(phoneToken, id, true); // waits on the held lock (200 ms budget)
      let ticked = false;
      await new Promise((ok) => setTimeout(() => ((ticked = true), ok()), 20));
      assert.ok(ticked, "the event loop ran while the approve waited");
      const second = await decide(phoneToken, id, true);
      assert.equal(second.res.statusCode, 404, "the in-flight ticket is claimed");
      const deny = await decide(phoneToken, id, false);
      assert.equal(deny.res.statusCode, 404, "a deny can't race the in-flight approve either");
    } finally {
      rmSync(lock, { force: true });
    }
    const r = await first;
    assert.equal(r.res.statusCode, 200, r.res.body);
    assert.ok(authAs(token));
    assert.equal(readDevicesJson().filter((d) => d.name === "Double-tap PC").length, 1, "written exactly once");
    assert.equal(auth.pendingCountForTest(), 0);
  });

  test("Gemini-L2: an out-of-process `vs devices revoke` of the minter discards its pending ticket on reload", async () => {
    const phoneToken = await pairFromPc("CLI-revoked phone");
    const phone = byName("CLI-revoked phone");
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Orphan ticket");
    assert.equal(auth.pendingCountForTest(), 1);
    ageDevicesFile();
    const r = spawnSync(process.execPath, [VS, "devices", "revoke", phone.id], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "", VS_AGENT_ID: "", VS_AGENT_TOKEN: "" }, windowsHide: true, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(authAs(phoneToken), null, "the server reloaded the file");
    assert.equal(auth.pendingCountForTest(), 0, "the minter's ticket went with it");
    assert.equal(statusOf(token), "gone");
    const late = await decide(phoneToken, "whatever", true);
    assert.equal(late.res.statusCode, 403, "the revoked minter can't decide anything");
  });
});

describe("E4b X1 R2 L1: pending, approve and revoke self-gate against agent-header callers (defence in depth, like pair/start and devices)", () => {
  test("a valid paired cookie plus x-vs-agent-id is refused by each handler itself, and nothing changes", async () => {
    const phoneToken = await pairFromPc("Agent-proof phone");
    const victim = await pairFromPc("Agent-proof victim");
    const victimId = byName("Agent-proof victim").id;
    const { data: start } = await mint(phoneToken);
    const { token } = await redeem(start.code, "Agent-proof pending");
    const { data: p } = await pendingFor(phoneToken);
    const id = p.pending[0].pendingId;
    const agent = { "x-vs-agent-id": "rn-deadbeefdeadbeef", "x-vs-agent-token": "nope" };

    let res = fakeRes();
    auth.handlePairPending(meshReq({ url: "/__vibesquad/pair/pending", token: phoneToken, headers: agent }), res);
    assert.equal(res.statusCode, 403, res.body);
    assert.ok(!res.body.includes(id), "the ticket is not listed to an agent caller");

    res = fakeRes();
    await auth.handlePairApprove(meshReq({ url: "/__vibesquad/pair/approve", method: "POST", token: phoneToken, headers: agent, body: { pendingId: id, approve: true } }), res, bodyOf);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(auth.pendingCountForTest(), 1, "still pending");
    assert.equal(authAs(token), null);

    res = fakeRes();
    await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: phoneToken, headers: agent, body: { id: victimId } }), res, bodyOf);
    assert.equal(res.statusCode, 403, res.body);
    assert.ok(authAs(victim), "nothing was revoked");

    // the same calls without the agent header still work for the paired device
    res = fakeRes();
    auth.handlePairPending(meshReq({ url: "/__vibesquad/pair/pending", token: phoneToken }), res);
    assert.equal(res.statusCode, 200);
    const ok = await decide(phoneToken, id, true);
    assert.equal(ok.res.statusCode, 200, ok.res.body);
    assert.ok(authAs(token));
    res = fakeRes();
    await auth.handleRevoke(meshReq({ url: "/__vibesquad/devices/revoke", method: "POST", token: phoneToken, body: { id: victimId } }), res, bodyOf);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(authAs(victim), null);
  });
});
