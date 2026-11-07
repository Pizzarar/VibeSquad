// Security follow-ups to S1/S2/S3 (post-merge review notes): ungated side-effect GETs, push endpoint redaction,
// lexical cwd check, Paseo id / cmd.exe argv checks, and the plain-HTTP /pair burn limiter.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-sec-followups-"));
process.env.VIBESQUAD_HOME = home;
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const push = await import("../server/push.mjs");
const stale = await import("../server/stale-runtime.mjs");
const fileSearch = await import("../server/file-search.mjs");
const { createMeshnetMux } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const rootDir = join(import.meta.dirname, "..");

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}
const json = (r) => JSON.parse(r.body);

describe("ungated side-effect GETs (read-only callers)", () => {
  let srv;
  let port;
  let token;
  // inspectFirstRunStatus reads env.PATH on every real run, so reads of the proxy count real (uncached) runs.
  const counts = { runs: 0 };
  before(async () => {
    token = auth.getLocalToken();
    const env = new Proxy({ ...process.env }, {
      get(t, k) {
        if (k === "PATH") counts.runs += 1;
        return t[k];
      },
    });
    srv = createServer(
      api.createVibesquadMiddleware(rootDir, { firstRun: { probeVersions: false, env } }),
    );
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(() => new Promise((ok) => srv.close(ok)));

  test("/first-run/status: read-only callers share one run per window; the owner always runs fresh", async () => {
    const path = "/__vibesquad/first-run/status";
    const first = await call(port, path);
    assert.equal(first.status, 200, first.body);
    const afterFirst = counts.runs;
    assert.ok(afterFirst > 0, "the first read-only call still gets real data");
    const burst = await Promise.all(Array.from({ length: 8 }, () => call(port, path)));
    for (const r of burst) assert.equal(r.status, 200);
    assert.equal(counts.runs, afterFirst, "a burst of read-only GETs runs nothing new");
    assert.deepEqual(json(burst[0]), json(first));
    await call(port, path, { headers: { "x-vibesquad-token": token } });
    assert.ok(counts.runs > afterFirst, "owner bypasses the cache");
  });

  test("an owner write clears the cache, so read-only callers see the new state", async () => {
    const path = "/__vibesquad/first-run/status";
    await call(port, path);
    const before = counts.runs;
    await call(port, path);
    assert.equal(counts.runs, before);
    await call(port, "/__vibesquad/vs-log", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await call(port, path);
    assert.equal(counts.runs, before, "a refused read-only write clears nothing");
    await call(port, "/__vibesquad/vs-log", { method: "POST", headers: { "content-type": "application/json", "x-vibesquad-token": token }, body: "{}" });
    await call(port, path);
    assert.ok(counts.runs > before);
  });

  test("the cache expires, and concurrent first calls share one run", async () => {
    let t = 0;
    let runs = 0;
    const cached = api.createReadOnlyCache(1000, () => t);
    const run = () => {
      runs += 1;
      return new Promise((ok) => setTimeout(() => ok(runs), 5));
    };
    const [a, b] = await Promise.all([cached("k", false, run), cached("k", false, run)]);
    assert.equal(runs, 1);
    assert.equal(a, b);
    t = 999;
    await cached("k", false, run);
    assert.equal(runs, 1);
    t = 2000;
    await cached("k", false, run);
    assert.equal(runs, 2, "stale entry re-runs");
    await cached("other", false, run);
    assert.equal(runs, 3, "keys are separate");
    cached.clear();
    await cached("k", false, run);
    assert.equal(runs, 4, "clear() drops cached results");
  });

  test("health: read-only gets the cached stale value without running git or writing stale.json", async () => {
    stale.resetStaleCache();
    const file = stale.staleFilePath();
    rmSync(file, { force: true });
    const r = await call(port, "/__vibesquad/health");
    assert.equal(json(r).localAccess, "read-only");
    assert.equal(json(r).stale, null);
    assert.equal(existsSync(file), false, "read-only health wrote nothing");
    await call(port, "/__vibesquad/health", { headers: { "x-vibesquad-token": token } });
    assert.equal(existsSync(file), true, "owner health refreshes and mirrors stale.json");
    stale.resetStaleCache();
  });

  test("/ca.crt, auth/status and devices never create the CA", async () => {
    const tls = join(home, "tls");
    rmSync(tls, { recursive: true, force: true });
    assert.equal((await call(port, "/ca.crt")).status, 404);
    assert.equal(json(await call(port, "/__vibesquad/auth/status")).caFingerprint.full, null);
    assert.equal(json(await call(port, "/__vibesquad/auth/status", { headers: { "x-vibesquad-token": token } })).caFingerprint.full, null);
    assert.equal((await call(port, "/__vibesquad/devices")).status, 200);
    assert.equal(existsSync(join(tls, "ca.crt")), false, "no CA or key written by a GET");
  });

  test("push/status redacts WebPush endpoints to the push service origin", async () => {
    push.writePushSubscriptions([
      { type: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/SECRET-CAPABILITY-ID", keys: { p256dh: "k", auth: "a" } },
      { type: "desktop", endpoint: "desktop://local" },
    ]);
    const r = await call(port, "/__vibesquad/push/status");
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes("SECRET-CAPABILITY-ID"));
    assert.deepEqual(
      json(r).subscriptions.map((s) => s.endpoint),
      ["https://fcm.googleapis.com/…", "desktop://local"],
    );
    assert.equal(api.redactPushEndpoint("not a url"), null);
    push.writePushSubscriptions([]);
  });
});

describe("confineCwd checks the roots lexically before touching the disk", () => {
  test("a path outside every root is 403 without a stat (missing dir, not 'not a directory')", () => {
    const root = mkdtempSync(join(tmpdir(), "vs-confine-"));
    try {
      const outside = join(tmpdir(), "vs-confine-definitely-missing-" + Date.now());
      const r = fileSearch.confineCwd(outside, [root]);
      assert.equal(r.status, 403);
      assert.match(r.error, /not a known agent or team path/);
      assert.match(fileSearch.confineCwd(join(root, "missing"), [root]).error, /not a directory/, "inside a root: falls through to the stat");
      assert.deepEqual(fileSearch.confineCwd(root, [root]), { cwd: root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plain-HTTP /pair burns codes under the per-IP limiter", () => {
  let mux;
  let port;
  before(async () => {
    auth.resetPairRateLimitForTest();
    ({ mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls: { key: "", cert: "" } }));
    await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
    port = mux.address().port;
  });
  after(() => {
    auth.resetPairRateLimitForTest();
    return new Promise((ok) => mux.close(ok));
  });

  test("a sweep of wrong codes locks the IP, after which a real code is no longer burnt", async () => {
    const real = auth.createPairCode();
    for (let i = 0; i < 5; i++) {
      const wrong = String(100000 + i) === real ? "999999" : String(100000 + i);
      const r = await call(port, `/pair?code=${wrong}`);
      assert.equal(r.status, 302);
      assert.ok(!String(r.headers.location).includes("code="), "code never echoed into the redirect");
    }
    await call(port, `/pair?code=${real}`);
    assert.equal(auth.discardPlainHttpPairCode(real, "10.9.9.9"), true, "the locked IP's request didn't burn the real code");
  });

  test("an unlocked IP's plain-HTTP code is still burnt", () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    assert.equal(auth.discardPlainHttpPairCode(code, "10.0.0.5"), true);
    assert.equal(auth.discardPlainHttpPairCode(code, "10.0.0.6"), false, "already gone");
  });
});

describe("review nits on 1be096a", () => {
  test("plain-HTTP HEAD /pair burns the code too and never echoes it into Location", async () => {
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    const { mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls: { key: "", cert: "" } });
    await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
    try {
      const r = await call(mux.address().port, `/pair?code=${code}`, { method: "HEAD", headers: { host: "100.64.0.7:4180" } });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "https://100.64.0.7:4180/pair");
    } finally {
      await new Promise((ok) => mux.close(ok));
    }
    assert.equal(auth.discardPlainHttpPairCode(code, "10.1.1.1"), false, "HEAD already burnt it");
    auth.resetPairRateLimitForTest();
  });

  test("a missing code uses up no rate-limit attempt", () => {
    auth.resetPairRateLimitForTest();
    for (let i = 0; i < 20; i++) assert.equal(auth.discardPlainHttpPairCode("", "10.2.2.2"), false);
    const code = auth.createPairCode();
    assert.equal(auth.discardPlainHttpPairCode(code, "10.2.2.2"), true, "the IP isn't throttled by empty requests");
    auth.resetPairRateLimitForTest();
  });
});
