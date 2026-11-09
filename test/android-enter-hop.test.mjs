// Block A2d-1: /pair must not 302 straight to "/" or the app: a redirect chain that starts cross-site (QR scan, APK
// navigation) withholds the SameSite=Strict vs_device cookie. It lands on the same-site /__vibesquad/enter page instead.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-enter-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.PASEO_HOME = join(home, "paseo");
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const APP = "http://tauri.localhost";
const fakeRes = () => ({
  statusCode: 200, headers: {}, body: "",
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  end(b) { this.body += b ?? ""; },
});
const fakeReq = (url, method = "GET", remote = "203.0.113.9") => ({ url, method, headers: {}, socket: { remoteAddress: remote } });
const redeem = (qs, remote) => {
  auth.resetPairRateLimitForTest();
  const code = auth.createPairCode();
  const res = fakeRes();
  auth.handlePairRedeem(fakeReq(`/pair?code=${code}${qs}`, "GET", remote), res);
  return res;
};

describe("redeem -> same-site enter hop", () => {
  test("browser: 302 to /__vibesquad/enter with the Strict cookie, no token in the URL", () => {
    const res = redeem("");
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/__vibesquad/enter");
    assert.match(res.headers["set-cookie"], /vs_device=[^;]+; HttpOnly; Secure; SameSite=Strict/);
    const token = res.headers["set-cookie"].split(";")[0].split("=")[1];
    assert.ok(!res.headers.location.includes(token));
    const page = fakeRes();
    auth.handleEnter(fakeReq(res.headers.location), page);
    assert.match(page.body, /location\.replace\("\/"\)/);
  });

  test("APK: 302 to enter?paired=1&vs_app, page returns to <app>/#paired", () => {
    const res = redeem(`&vs_app=${encodeURIComponent(APP)}`);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/__vibesquad/enter?paired=1&vs_app=${encodeURIComponent(APP)}`);
    const page = fakeRes();
    auth.handleEnter(fakeReq(res.headers.location), page);
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers.location, undefined);
    assert.match(page.body, /location\.replace\("http:\/\/tauri\.localhost\/#paired"\)/);
  });

  test("a non-whitelisted vs_app never reaches the redirect or the page", () => {
    const res = redeem(`&vs_app=${encodeURIComponent("https://evil.example")}`);
    assert.equal(res.headers.location, "/__vibesquad/enter");
    const page = fakeRes();
    auth.handleEnter(fakeReq("/__vibesquad/enter?paired=1&vs_app=https%3A%2F%2Fevil.example"), page);
    assert.match(page.body, /location\.replace\("\/"\)/);
    assert.doesNotMatch(page.body, /evil/);
  });

  test("HEAD sends headers and no body", () => {
    const page = fakeRes();
    auth.handleEnter(fakeReq("/__vibesquad/enter", "HEAD"), page);
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.equal(page.body, "");
  });
});

describe("dev middleware routes /__vibesquad/enter before the auth gate", () => {
  test("unpaired GET gets the hop page, HEAD gets no body, POST is 405", () => {
    const mw = api.createVibesquadMiddleware(process.cwd());
    const run = (method) => {
      const res = fakeRes();
      let nexted = false;
      mw({ ...fakeReq("/__vibesquad/enter?vs_app=" + encodeURIComponent(APP), method), headers: { host: "pc.example:4180" } }, res, () => (nexted = true));
      return { res, nexted };
    };
    const get = run("GET");
    assert.equal(get.res.statusCode, 200);
    assert.match(get.res.body, /location\.replace/);
    assert.equal(run("HEAD").res.body, "");
    assert.equal(run("POST").res.statusCode, 405);
  });
});

describe("pairing URLs never have an empty host", () => {
  test("empty meshnetHost falls back to the Meshnet IP, then the LAN IP", async () => {
    process.env.VIBESQUAD_MESHNET_HOST = "";
    process.env.VIBESQUAD_MESHNET_IP = "100.64.1.2";
    const start = async () => {
      const res = fakeRes();
      res.statusCode = 0;
      const req = { ...fakeReq("/__vibesquad/pair/start", "POST", "127.0.0.1"), socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4180", "x-vibesquad-token": auth.getLocalToken() } };
      await auth.handlePairStart(req, res);
      assert.equal(res.statusCode, 200, res.body);
      return JSON.parse(res.body);
    };
    try {
      const j = await start();
      assert.match(j.pairUrl, /^https:\/\/100\.64\.1\.2:\d+\/pair\?code=/);
      assert.doesNotMatch(j.pairUrl, /^https:\/\/:/);
    } finally {
      delete process.env.VIBESQUAD_MESHNET_HOST;
      delete process.env.VIBESQUAD_MESHNET_IP;
    }
  });
});

describe("VsTrust.kt keeps the pairing cookie", () => {
  test("accepts and flushes cookies at install and on a flush op, CA pin untouched", () => {
    const kt = readFileSync(new URL("../src-tauri/android/VsTrust.kt", import.meta.url), "utf8");
    assert.match(kt, /setAcceptCookie\(true\)/);
    assert.match(kt, /cm\.flush\(\)/);
    assert.match(kt, /"flush" -> persistCookies\(\)/);
    assert.match(kt, /leaf\.verify\(ca\.publicKey\)/);
  });
});
