// E4a (PLAN_ANDROID_END_STATE.md): a stable per-install host id in ~/.vibesquad/host-id, created atomically on first
// use, on /api/auth/status (paired and unpaired) and on the /__vibesquad/teams envelope only (never in lane/agent records).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-host-id-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [{ id: "t1", name: "T1", lanes: [{ id: "l1", name: "L1" }] }] }));
const hostId = await import("../server/host-id.mjs");
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

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
const loopbackReq = (url, extraHeaders = {}) => ({
  url,
  method: "GET",
  headers: { host: "127.0.0.1:4180", ...extraHeaders },
  socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
  on() {},
});
const remoteReq = (url, extraHeaders = {}) => ({
  url,
  method: "GET",
  headers: { host: "100.64.0.7:4180", ...extraHeaders },
  socket: { remoteAddress: "100.64.0.9", localAddress: "100.64.0.7" },
  on() {},
});

describe("host-id file", () => {
  test("created on first use, URL-safe, >= 128 bits, stable across calls and a fresh cache", () => {
    const file = hostId.hostIdPath();
    assert.equal(file, join(home, "host-id"));
    assert.equal(existsSync(file), false);
    const id = hostId.getHostId();
    assert.match(id, ID_RE);
    assert.equal(Buffer.from(id, "base64url").length, 16, "16 random bytes");
    assert.equal(readFileSync(file, "utf8"), id + "\n");
    assert.equal(hostId.getHostId(), id, "cached");
    hostId.resetHostIdForTest();
    assert.equal(hostId.getHostId(), id, "re-read from disk, not re-minted");
    assert.ok(!readdirSync(home).some((n) => n.endsWith(".tmp")), "no temp file left behind");
  });

  test("two minters racing agree on whichever file landed first", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-host-id-race-"));
    try {
      const file = join(dir, "host-id");
      // Simulate the other process winning the exclusive create between our read-miss and our write.
      const a = hostId.ensureHostId(file);
      const b = hostId.ensureHostId(file);
      assert.equal(a, b);
      assert.match(a, ID_RE);
      assert.notEqual(hostId.mintHostId(), hostId.mintHostId(), "mint is random");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed file is replaced atomically (and a foreign-but-valid one is kept)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-host-id-bad-"));
    try {
      const file = join(dir, "host-id");
      writeFileSync(file, "not a host id!\n");
      assert.equal(hostId.readHostId(file), null);
      const id = hostId.ensureHostId(file);
      assert.match(id, ID_RE);
      assert.equal(readFileSync(file, "utf8"), id + "\n");
      assert.ok(!readdirSync(dir).some((n) => n.endsWith(".tmp")));
      const foreign = "a".repeat(40);
      writeFileSync(file, foreign + "\n");
      assert.equal(hostId.ensureHostId(file), foreign);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the id is not one of the locked-down secret files (it is public on the unpaired status route)", () => {
    assert.ok(!auth.HOME_SECRET_FILES.includes("host-id"));
  });
});

describe("hostId on the status payload", () => {
  test("getAuthStatus carries hostId", () => {
    assert.equal(auth.getAuthStatus().hostId, hostId.getHostId());
  });

  test("unpaired /api/auth/status gets hostId and nothing else new", () => {
    const res = fakeRes();
    api.handleAuthStatus(remoteReq("/api/auth/status"), res);
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.paired, false);
    assert.equal(j.hostId, hostId.getHostId());
    assert.deepEqual(Object.keys(j).sort(), ["caFingerprint", "distReady", "hostId", "ok", "paired"], "unauthenticated payload is not widened beyond hostId");
  });

  test("paired (loopback) /api/auth/status gets hostId too", () => {
    const res = fakeRes();
    api.handleAuthStatus(loopbackReq("/api/auth/status"), res);
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.paired, true);
    assert.equal(j.hostId, hostId.getHostId());
  });
});

describe("hostId on the /__vibesquad/teams envelope", () => {
  test("the envelope has hostId; team and lane records do not", async () => {
    // Over the wire: the loopback listener routes /__vibesquad/teams to handleTeams.
    const { server } = await import("../server/serve.mjs");
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/__vibesquad/teams`, { headers: { "x-vibesquad-token": auth.getLocalToken() } });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.hostId, hostId.getHostId());
      assert.ok(j.revision, "revision still on the envelope");
      assert.equal(j.teams[0].hostId, undefined, "no hostId inside team records");
      assert.equal(j.teams[0].lanes[0].hostId, undefined, "no hostId inside lane records");
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });

  test("server/identity.mjs is untouched by E4a (hostId lives on envelopes, per the Overlord decision)", () => {
    const src = readFileSync(new URL("../server/identity.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(src, /hostId/);
  });
});

describe("X1 R1 L1: a concurrent first start waits for the other writer before replacing the file", () => {
  test("an empty file (other process opened it, not yet written) is re-read ~5 x 20 ms before being called malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-host-id-wait-"));
    try {
      const file = join(dir, "host-id");
      writeFileSync(file, ""); // what `wx` leaves between open and write in the other process
      const t0 = Date.now();
      const id = hostId.ensureHostId(file);
      const waited = Date.now() - t0;
      assert.match(id, ID_RE);
      assert.ok(waited >= 80, `waited ${waited} ms for the other writer (5 reads, 20 ms apart)`);
      assert.equal(readFileSync(file, "utf8"), id + "\n");
      writeFileSync(file, "");
      const t1 = Date.now();
      hostId.ensureHostId(file, { readRetries: 0 });
      assert.ok(Date.now() - t1 < 60, "no wait when retries are off");
      assert.match(readFileSync(new URL("../server/host-id.mjs", import.meta.url), "utf8"), /for \(let i = 0; i < readRetries; i\+\+\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
