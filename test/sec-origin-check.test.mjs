// X1-E4b L4 (Tier A): a state-changing request authenticated by the vs_device cookie must also pass a same-origin proof
// (Origin / Sec-Fetch-Site), on both listeners, at the one chokepoint (server/auth.mjs authenticate -> cookieWriteRefusal).
// SameSite=Strict stays the first layer; this is the second. Attacker cases are marked "attacker:".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-origin-check-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { createMeshnetMux } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const MESH_HOST = "100.64.0.7:4180";
const MESH_ORIGIN = `https://${MESH_HOST}`;

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

let ipN = 40;
const nextIp = () => `100.64.0.${++ipN}`;

/** A request as the TLS Meshnet/LAN listener sees it. `token` = vs_device cookie value. */
const meshReq = ({ url = "/__vibesquad/pair/start", method = "POST", token = null, headers = {} } = {}) => ({
  url,
  method,
  headers: { host: MESH_HOST, ...(token ? { cookie: `vs_device=${token}` } : {}), ...headers },
  socket: { remoteAddress: nextIp(), localAddress: "100.64.0.7", encrypted: true },
  on() {},
});

/** PC-minted pairing: returns the new device's vs_device token. */
async function pairFromPc(name) {
  const code = auth.createPairCode();
  const res = fakeRes();
  await auth.handlePairRedeem({ url: `/pair?code=${code}&name=${encodeURIComponent(name)}`, method: "GET", headers: { host: MESH_HOST }, socket: { remoteAddress: nextIp() }, on() {} }, res);
  assert.equal(res.statusCode, 302, res.body);
  const m = /vs_device=([^;]+)/.exec(String(res.headers["set-cookie"] ?? ""));
  assert.ok(m, "set-cookie carries the device token");
  return m[1];
}

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => server.close(ok));

function call(mod, { port, path, method = "GET", headers = {}, body }) {
  return new Promise((ok, fail) => {
    const req = mod(
      { host: "127.0.0.1", port, path, method, rejectUnauthorized: false, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => (text += d));
        res.on("end", () => ok({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on("error", fail);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const https = (o) => call(httpsRequest, o);
const http = (o) => call(request, o);

let phone;
before(async () => {
  phone = await pairFromPc("Owner phone");
});

describe("cookieWriteRefusal: the decision table", () => {
  const refusal = (method, headers, encrypted = true) => auth.cookieWriteRefusal({ method, headers: { host: MESH_HOST, ...headers }, socket: { encrypted } });

  test("safe methods never refuse, whatever the headers say (reads are not CSRF targets; SSE/WS upgrades are GETs)", async () => {
    for (const method of ["GET", "HEAD", "get"]) {
      assert.equal(refusal(method, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), null, method);
    }
    // X1 I1: one definition of "write" with the middleware (vibesquad-api.mjs gated: anything but GET/HEAD), so OPTIONS is checked.
    assert.match(refusal("OPTIONS", { origin: "https://evil.example" }), /is not this host/);
    assert.equal(refusal("OPTIONS", { origin: MESH_ORIGIN }), null);
  });

  test("Origin present: only the listener's own scheme://Host passes (case-insensitive); null, foreign, or wrong scheme is refused", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(refusal(method, { origin: MESH_ORIGIN }), null, method);
      assert.equal(refusal(method, { origin: MESH_ORIGIN, "sec-fetch-site": "same-origin" }), null, method);
    }
    assert.equal(refusal("POST", { origin: `HTTPS://${MESH_HOST}` }), null, "origin is case-insensitive");
    assert.match(refusal("POST", { origin: "https://evil.example" }), /Origin https:\/\/evil\.example is not this host/);
    assert.match(refusal("POST", { origin: "null" }), /Origin null is not this host/, "sandboxed / redirected cross-site POST");
    assert.match(refusal("POST", { origin: "" }), /Origin \(empty\) is not this host/);
    assert.match(refusal("POST", { origin: `http://${MESH_HOST}` }), /is not this host/, "http:// on the TLS listener is not our origin");
    assert.match(refusal("POST", { origin: `https://${MESH_HOST}.evil.example` }), /is not this host/, "a suffix-matching host is not ours");
    assert.match(refusal("POST", { origin: "https://100.64.0.7" }), /is not this host/, "port must match too");
    assert.match(refusal("POST", { origin: `${MESH_ORIGIN}, https://evil.example` }), /is not this host/, "a repeated Origin header joins and fails");
    // Origin is browser-set and unforgeable from a page, so a matching Origin wins over Sec-Fetch-Site (no real browser sends
    // this pair; the desktop proxy sets Origin http://<host> for a local upstream while a tauri:// page reads as cross-site).
    assert.equal(refusal("POST", { origin: MESH_ORIGIN, "sec-fetch-site": "cross-site" }), null);
  });

  test("Origin present on the loopback (http) listener matches http://Host", async () => {
    assert.equal(refusal("POST", { host: "127.0.0.1:4189", origin: "http://127.0.0.1:4189" }, false), null);
    assert.match(refusal("POST", { host: "127.0.0.1:4189", origin: "https://127.0.0.1:4189" }, false), /is not this host/);
  });

  test("Origin absent: Sec-Fetch-Site absent / none / same-origin passes; cross-site and same-site are refused", async () => {
    assert.equal(refusal("POST", {}), null, "neither header: non-browser client (desktop proxy on old WebKit, curl, tests)");
    assert.equal(refusal("POST", { "sec-fetch-site": "none" }), null);
    assert.equal(refusal("POST", { "sec-fetch-site": "same-origin" }), null, "desktop proxy -> remote host shape");
    assert.match(refusal("POST", { "sec-fetch-site": "cross-site" }), /Sec-Fetch-Site cross-site without an Origin/);
    assert.match(refusal("POST", { "sec-fetch-site": "same-site" }), /Sec-Fetch-Site same-site without an Origin/, "a sibling origin shares the Strict cookie");
    assert.match(refusal("POST", { "sec-fetch-site": "same-origin, cross-site" }), /without an Origin/, "a repeated header joins and fails");
  });

  test("the Tauri WebView origins are not an exception: the APK writes from this host's own origin after the /__vibesquad/enter hop", async () => {
    for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]) {
      assert.match(refusal("POST", { origin }), /is not this host/, origin);
    }
  });

  test("ownOrigin is scheme + Host, or null without a Host header", async () => {
    assert.equal(auth.ownOrigin({ headers: { host: "Home-PC.test:4180" }, socket: { encrypted: true } }), "https://home-pc.test:4180");
    assert.equal(auth.ownOrigin({ headers: { host: "[fd00::7]:4180" }, socket: { encrypted: true } }), "https://[fd00::7]:4180");
    assert.equal(auth.ownOrigin({ headers: {}, socket: { encrypted: true } }), null);
    assert.match(auth.cookieWriteRefusal({ method: "POST", headers: { origin: MESH_ORIGIN }, socket: { encrypted: true } }), /is not this host$/, "no Host: nothing to match, refused");
  });
});

describe("authenticate() is the chokepoint", () => {
  test("attacker: a valid cookie on a cross-site POST authenticates nothing, the reason is readable, and no device state is touched", async () => {
    const before = auth.listDevices().find((d) => d.name === "Owner phone").lastSeenAt;
    const req = meshReq({ token: phone, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    assert.equal(auth.authenticate(req), null);
    assert.match(auth.originRefusal(req), /Origin https:\/\/evil\.example is not this host/);
    assert.equal(auth.listDevices().find((d) => d.name === "Owner phone").lastSeenAt, before, "no last-seen update for a refused write");
    assert.equal(auth.ownerProof(req), false, "ownerProof follows authenticate");
  });

  test("Gemini R1 L1: the refusal is stateless, so nothing stale can leak into a later decision on the same request", async () => {
    const headers = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    const req = meshReq({ token: phone, headers });
    assert.equal(auth.authenticate(req), null);
    assert.deepEqual(Object.getOwnPropertySymbols(req), [], "authenticate() writes nothing on the request");
    assert.equal(auth.originRefusal(meshReq({ token: phone, headers })), auth.originRefusal(req), "same headers, same answer, no history needed");
    // The same request object, re-asked as a read: no refusal (the answer follows the request, not an earlier call).
    req.method = "GET";
    assert.equal(auth.originRefusal(req), null);
    assert.equal(auth.authenticate(req)?.name, "Owner phone");
    // A loopback request whose vs_device cookie fails the proof but which holds the local token is the owner, and a later
    // originRefusal() on it is irrelevant to the gates (they only ask on the not-owner branch) and reads the same truth.
    const local = {
      url: "/__vibesquad/pair/start",
      method: "POST",
      headers: { host: "127.0.0.1:4180", origin: "http://tauri.localhost", "x-vibesquad-token": auth.getLocalToken(), cookie: `vs_device=${phone}` },
      socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
      on() {},
    };
    assert.equal(auth.isLocalBrowserSafe(local), true, "the Tauri shell origin is allowed on loopback");
    assert.equal(auth.authenticate(local), null, "the cookie alone does not authenticate this shape");
    assert.equal(auth.ownerProof(local), true, "the local token does (local owner is checked first)");
    assert.match(auth.originRefusal(local), /is not this host/);
  });

  test("the same cookie on a same-origin POST, a GET, or a header-less POST authenticates", async () => {
    for (const req of [
      meshReq({ token: phone, headers: { origin: MESH_ORIGIN, "sec-fetch-site": "same-origin" } }),
      meshReq({ token: phone, method: "GET", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      meshReq({ token: phone }),
      meshReq({ token: phone, headers: { "sec-fetch-site": "same-origin" } }),
    ]) {
      assert.equal(auth.authenticate(req)?.name, "Owner phone", JSON.stringify(req.headers));
      assert.equal(auth.originRefusal(req), null);
    }
  });

  test("a request without the cookie records no refusal (it was never cookie-authenticated)", async () => {
    const req = meshReq({ headers: { origin: "https://evil.example" } });
    assert.equal(auth.authenticate(req), null);
    assert.equal(auth.originRefusal(req), null);
  });

  test("E5 relay: a relayed request authenticates by channel identity; its Origin / Sec-Fetch-Site / cookie are ignored", async () => {
    const dev = auth.listDevices().find((d) => d.name === "Owner phone");
    const req = {
      url: "/__vibesquad/pair/start",
      method: "POST",
      relayDevice: Object.freeze({ id: dev.id }),
      headers: { host: "relay.example", origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: "vs_device=garbage" },
      socket: { remoteAddress: "203.0.113.9", localAddress: "203.0.113.9" },
      on() {},
    };
    assert.equal(auth.authenticate(req)?.id, dev.id);
    assert.equal(auth.originRefusal(req), null);
    assert.equal(auth.isLocal(req), false);
  });

  test("handlePairStart (its own gate) refuses the cross-site cookie write with 403 and never mints", async () => {
    const res = fakeRes();
    await auth.handlePairStart(meshReq({ token: phone, headers: { origin: "https://evil.example" } }), res);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, undefined, res.body);
  });
});

describe("TLS Meshnet/LAN listener: the gate in serve.mjs", () => {
  let mux, port;
  before(async () => {
    ({ mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls: auth.getTls() }));
    port = await listen(mux);
  });
  after(() => close(mux));

  const cookie = () => ({ host: MESH_HOST, cookie: `vs_device=${phone}` });

  test("attacker: cross-site POST with a valid cookie -> 403, plain JSON error, no code minted", async () => {
    const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...cookie(), origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(r.json(), { error: auth.CROSS_SITE_ERROR });
    assert.equal(r.headers["cache-control"], "no-store, no-cache, must-revalidate");
  });

  test("attacker: Origin: null (a form in a sandboxed frame / after a cross-site redirect) -> 403", async () => {
    const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...cookie(), origin: "null" } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json().error, auth.CROSS_SITE_ERROR);
  });

  test("attacker: no Origin but Sec-Fetch-Site: cross-site -> 403; same-site (sibling origin) -> 403", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...cookie(), "sec-fetch-site": site } });
      assert.equal(r.status, 403, `${site}: ${r.text}`);
      assert.equal(r.json().error, auth.CROSS_SITE_ERROR);
    }
  });

  test("attacker: a non-API path refused the same way gets a plain-text 403, not the HTML unpaired page", async () => {
    const r = await https({ port, path: "/anything", method: "POST", headers: { ...cookie(), origin: "https://evil.example" } });
    assert.equal(r.status, 403, r.text);
    assert.match(r.headers["content-type"], /^text\/plain/);
    assert.equal(r.text, auth.CROSS_SITE_ERROR);
  });

  test("a paired browser / APK page at this host (Origin = own origin, Sec-Fetch-Site: same-origin) writes as before", async () => {
    const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...cookie(), origin: MESH_ORIGIN, "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json().code, /^\d{6}$/);
  });

  test("the desktop proxy -> remote host shape (Origin stripped, webview Sec-Fetch-Site: same-origin passed through) writes as before", async () => {
    const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...cookie(), "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 200, r.text);
  });

  test("a non-browser client with the cookie and neither header (old WebKit behind the proxy, curl) writes as before", async () => {
    const r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: cookie() });
    assert.equal(r.status, 200, r.text);
  });

  test("cross-site GETs with the cookie still read (not a CSRF target); without the cookie the write is 401 unpaired, not 403 cross-site", async () => {
    let r = await https({ port, path: "/__vibesquad/devices", headers: { ...cookie(), origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json().devices.some((d) => d.name === "Owner phone"));
    r = await https({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { host: MESH_HOST, origin: "https://evil.example" } });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json().error, "unpaired device");
  });
});

describe("loopback listener: the gate in vibesquad-api.mjs", () => {
  let server, port;
  before(async () => {
    server = createServer(api.createVibesquadMiddleware(rootDir));
    port = await listen(server);
  });
  after(() => close(server));

  test("x-vibesquad-token header auth is not cookie auth: a POST with the header and no Origin / Sec-Fetch-Site works as before", async () => {
    const r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { "x-vibesquad-token": auth.getLocalToken() } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().requiresApproval, false);
  });

  test("the desktop proxy -> local host shape (token header + vs_device cookie + Origin http://<Host>) works as before", async () => {
    const r = await http({
      port,
      path: "/__vibesquad/pair/start",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "x-vibesquad-token": auth.getLocalToken(), cookie: `vs_device=${phone}` },
    });
    assert.equal(r.status, 200, r.text);
  });

  test("attacker: a cross-site POST carrying the cookie on loopback -> 403 with the cross-site error (not the generic forbidden)", async () => {
    const r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: `vs_device=${phone}` } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json().error, auth.CROSS_SITE_ERROR);
  });

  test("X1 L1 / M5: the vs_local cookie from another loopback port (legacy browser, no Sec-Fetch-Site) is refused; the served origin and the Tauri shell pass", async () => {
    const login = await http({ port, path: `/__vibesquad/local-login?t=${auth.mintLocalLoginNonce()}` });
    assert.equal(login.status, 302, login.text);
    const m = /vs_local=([^;]+)/.exec(String(login.headers["set-cookie"] ?? ""));
    assert.ok(m, "the launcher login sets vs_local");
    const session = (origin) => ({ cookie: `vs_local=${m[1]}`, "user-agent": "Mozilla/5.0", ...(origin ? { origin } : {}) });
    // attacker: M5, a page on another loopback port in a browser that sends no Sec-Fetch-* (vs_local is same-site, so it is attached)
    let r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: session("http://127.0.0.1:3000") });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json().error, "forbidden");
    // attacker: same port, other loopback name: a different origin
    r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: session(`http://localhost:${port}`) });
    assert.equal(r.status, 403, r.text);
    // the served URL (launcher / vs open land here) and the Tauri shell origins keep working
    r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: session(`http://127.0.0.1:${port}`) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().requiresApproval, false, "vs_local is the PC owner");
    r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: session("http://tauri.localhost") });
    assert.equal(r.status, 200, r.text);
    // Host and Origin compare case-insensitively
    r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { ...session(`HTTP://127.0.0.1:${port}`), host: `127.0.0.1:${port}` } });
    assert.equal(r.status, 200, r.text);
  });

  test("attacker: the loopback foreign-Origin refusal for token-less browsers is unchanged (403 forbidden)", async () => {
    const r = await http({ port, path: "/__vibesquad/pair/start", method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "user-agent": "Mozilla/5.0" } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json().error, "forbidden");
  });

  test("both listener gates route the refusal through the one helper (source check; behaviour is covered above)", async () => {
    assert.ok(readFileSync(join(rootDir, "server/serve.mjs"), "utf8").includes("originRefusal(req) ? sendCrossSiteRefused(req, res) : sendUnpaired(req, res)"));
    assert.ok(readFileSync(join(rootDir, "server/vibesquad-api.mjs"), "utf8").includes("if (originRefusal(req)) return sendCrossSiteRefused(req, res);"));
    const authSrc = readFileSync(join(rootDir, "server/auth.mjs"), "utf8");
    const fn = authSrc.slice(authSrc.indexOf("export function authenticate(req) {"), authSrc.indexOf("function authenticateRelayDevice(req) {"));
    assert.ok(fn.indexOf("if (cookieWriteRefusal(req)) return null;") > 0, "authenticate() calls the check");
    assert.ok(fn.indexOf("if (cookieWriteRefusal(req)) return null;") < fn.indexOf("deviceByTokenHash("), "refused before the hash lookup");
    assert.ok(!authSrc.includes("ORIGIN_REFUSED"), "no per-request refusal flag (Gemini R1 L1)");
  });
});
