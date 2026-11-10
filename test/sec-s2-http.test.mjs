// Security phase B, S2 fixes 4-6: anti-framing headers, per-IP pairing lockout + cleartext /pair redirect, ~/.vibesquad lockdown.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-sec-s2-http-"));
process.env.VIBESQUAD_HOME = home;
const auth = await import("../server/auth.mjs");
const { createMeshnetMux, server } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

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
  };
}
const fakeReq = (url, remote) => ({ url, method: "GET", headers: { host: "example.test" }, socket: { remoteAddress: remote }, on() {} });

function call(port, path, headers = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      res.resume();
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("S2 fix 4: HTML responses can't be framed", () => {
  test("setNoFraming sets XFO and merges frame-ancestors into an existing CSP", () => {
    const a = fakeRes();
    auth.setNoFraming(a);
    assert.equal(a.headers["x-frame-options"], "DENY");
    assert.equal(a.headers["content-security-policy"], "frame-ancestors 'none'");
    const b = fakeRes();
    b.setHeader("content-security-policy", "default-src 'self';");
    auth.setNoFraming(b);
    assert.equal(b.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'none'");
    const c = fakeRes();
    c.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'self'");
    auth.setNoFraming(c);
    assert.equal(c.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'self'", "an explicit frame-ancestors is kept");
  });

  test("the loopback SPA shell and the pairing pages send the headers", async () => {
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const r = await call(server.address().port, "/", { host: `127.0.0.1:${server.address().port}` });
      assert.match(String(r.headers["content-type"]), /text\/html/);
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
    auth.resetPairRateLimitForTest();
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq("/pair?code=111111", "203.0.113.50"), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["x-frame-options"], "DENY");
  });
});

describe("S2 fix 5: pairing failures are per IP and the code stays out of plain-HTTP redirects", () => {
  test("one IP's failures lock out that IP only; another IP's code still works", () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = fakeRes();
      auth.handlePairRedeem(fakeReq("/pair?code=999999", "198.51.100.7"), res);
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    const ok = fakeRes();
    auth.handlePairRedeem(fakeReq(`/pair?code=${code}`, "198.51.100.8"), ok);
    assert.equal(ok.statusCode, 302, "another IP's live code survives");
  });

  test("a locked-out IP can't redeem even a valid code until the backoff ends", () => {
    auth.resetPairRateLimitForTest();
    for (let i = 0; i < 5; i++) auth.handlePairRedeem(fakeReq("/pair?code=999999", "198.51.100.9"), fakeRes());
    const code = auth.createPairCode();
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq(`/pair?code=${code}`, "::ffff:198.51.100.9"), res);
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers["retry-after"]) >= 60);
    const other = fakeRes();
    auth.handlePairRedeem(fakeReq(`/pair?code=${code}`, "198.51.100.10"), other);
    assert.equal(other.statusCode, 302, "the locked IP's attempt didn't consume the code");
  });

  test("a codeless /pair is a 400 and doesn't count as a failure", () => {
    auth.resetPairRateLimitForTest();
    for (let i = 0; i < 4; i++) {
      const res = fakeRes();
      auth.handlePairRedeem(fakeReq("/pair", "198.51.100.11"), res);
      assert.equal(res.statusCode, 400);
    }
    const code = auth.createPairCode();
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq(`/pair?code=${code}`, "198.51.100.11"), res);
    assert.equal(res.statusCode, 302);
  });

  test("plain-HTTP /pair redirects without the code and burns it", async () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    const { mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls: { key: "", cert: "" } });
    await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
    try {
      const r = await call(mux.address().port, `/pair?code=${code}`, { host: "100.64.0.7:4180" });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "https://100.64.0.7:4180/pair");
    } finally {
      await new Promise((ok) => mux.close(ok));
    }
    const res = fakeRes();
    auth.handlePairRedeem(fakeReq(`/pair?code=${code}`, "198.51.100.12"), res);
    assert.equal(res.statusCode, 401, "a code seen over cleartext can't be redeemed");
  });
});

describe("S2 fix 6: ~/.vibesquad is locked down at startup regardless of LAN", () => {
  test("Windows: icacls lockdown on the home dir", () => {
    const locked = [];
    auth.lockDownVibesquadHome({ home: "C:\\vs-home", platform: "win32", lock: (d) => locked.push(d), mkdir: () => {}, chmod: () => assert.fail("no chmod on Windows") });
    assert.deepEqual(locked, ["C:\\vs-home"]);
  });

  test("POSIX: 0700 home and 0600 secret files that exist", () => {
    const chmods = [];
    auth.lockDownVibesquadHome({
      home: "/h/.vibesquad",
      platform: "linux",
      lock: () => assert.fail("no icacls on POSIX"),
      mkdir: () => {},
      exists: (f) => !f.endsWith("push-subs.json"),
      chmod: (f, m) => chmods.push([f.replace(/\\/g, "/"), m]),
    });
    assert.deepEqual(chmods, [
      ["/h/.vibesquad", 0o700],
      ["/h/.vibesquad/local-token", 0o600],
      ["/h/.vibesquad/vapid.json", 0o600],
      ["/h/.vibesquad/devices.json", 0o600],
      ["/h/.vibesquad/daemon-password", 0o600],
      ["/h/.vibesquad/host-keypair.json", 0o600], // E4b MUST 6: the E5 relay host key
    ]);
  });

  test("startup calls it outside the LAN branch", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../server/serve.mjs", import.meta.url), "utf8");
    const mainBlock = src.slice(src.indexOf("if (isMain) {"));
    const lockAt = mainBlock.indexOf("lockDownVibesquadHome()");
    assert.ok(lockAt > 0, "lockDownVibesquadHome() runs in the main block");
    assert.ok(lockAt < mainBlock.indexOf("server.listen("), "before listening, not inside applyLanListeners");
  });
});
