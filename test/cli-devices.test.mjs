// E4a (PLAN_ANDROID_END_STATE.md): headless `vs pair` / `vs devices list` / `vs devices revoke <id|--all>`.
// The revoke runs in a *separate process* from the server (SSH into a headless home PC), so the server must not keep
// trusting its in-memory device list: a token revoked on disk is refused on its very next request.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-cli-devices-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const cli = await import("../cli/vs.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const VS = new URL("../cli/vs.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const devicesFile = join(home, "devices.json");
const readDevicesJson = () => JSON.parse(readFileSync(devicesFile, "utf8")).devices;

const childEnv = (extraEnv) => ({ ...process.env, VIBESQUAD_HOME: home, PASEO_AGENT_ID: "", VS_AGENT_ID: "", ...extraEnv });

/** Runs `vs …` in its own process against this test's home (the lost-phone-over-SSH shape). */
function vs(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [VS, ...args], { encoding: "utf8", env: childEnv(extraEnv), windowsHide: true, timeout: 60_000 });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Same, without blocking this process: `vs pair` talks to a server that lives in this test process. */
function vsAsync(args, extraEnv = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [VS, ...args], { env: childEnv(extraEnv), windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (status) => ok({ status, out, err }));
  });
}

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

/** Pairs a device through the real redeem handler; returns the vs_device token the phone would hold. */
function pairDevice(name, ip) {
  auth.resetPairRateLimitForTest();
  const code = auth.createPairCode();
  const res = fakeRes();
  auth.handlePairRedeem({ url: `/pair?code=${code}&name=${encodeURIComponent(name)}`, method: "GET", headers: { host: "100.64.0.7:4180" }, socket: { remoteAddress: ip }, on() {} }, res);
  assert.equal(res.statusCode, 302, res.body);
  const m = /vs_device=([^;]+)/.exec(String(res.headers["set-cookie"]));
  assert.ok(m, "set-cookie carries the device token");
  return m[1];
}

/** What every meshnet/LAN request passes through before it is served (serve.mjs: `const dev = authenticate(req)`). */
const authAs = (token) => auth.authenticate({ headers: { cookie: `vs_device=${token}` }, socket: {} });

/** Pushes the file's mtime back so a same-millisecond rewrite by the other process still shows as a change. */
const ageDevicesFile = () => {
  const st = statSync(devicesFile);
  utimesSync(devicesFile, st.atime, new Date(st.mtimeMs - 5000));
};

describe("vs devices list", () => {
  test("empty, then lists paired devices without token hashes", () => {
    let r = vs(["devices", "list"]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /No paired devices/);

    const phoneToken = pairDevice("Owner phone", "100.64.0.9");
    pairDevice("Work PC", "100.64.0.10");
    const hashes = readDevicesJson().map((d) => d.tokenHash);
    assert.equal(hashes.length, 2);
    assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));

    r = vs(["devices", "list"]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Owner phone/);
    assert.match(r.out, /Work PC/);
    for (const h of hashes) assert.ok(!r.out.includes(h), "no token hash in the listing");
    assert.ok(!r.out.includes(phoneToken));

    r = vs(["devices", "list", "--json"]);
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.devices.length, 2);
    assert.deepEqual(Object.keys(j.devices[0]).sort(), ["createdAt", "current", "id", "lastSeenAt", "mintedByDeviceId", "name"]);
    assert.ok(!r.out.includes("tokenHash"));
    assert.ok(authAs(phoneToken), "the phone is still paired");
  });
});

describe("vs devices revoke runs in another process and the server notices", () => {
  test("revoke <id>: the phone's next request is refused; the other device stays; its live sockets drop", () => {
    const list = auth.listDevices();
    const phone = list.find((d) => d.name === "Owner phone");
    const pc = list.find((d) => d.name === "Work PC");
    const phoneToken = pairDevice("Owner phone 2", "100.64.0.11"); // a third device the server has in memory
    const phone2 = auth.listDevices().find((d) => d.name === "Owner phone 2");
    const destroyed = [];
    const sock = { destroy: () => destroyed.push(phone.id), once() {} };
    auth.trackSocket(phone.id, sock);
    assert.ok(authAs(phoneToken), "sanity: server-side cache is warm");
    ageDevicesFile();

    const r = vs(["devices", "revoke", phone.id]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, new RegExp(`Revoked ${phone.id}`));
    assert.ok(!readDevicesJson().some((d) => d.id === phone.id), "token hash gone from devices.json");

    // The server process never restarted and never called revoke itself: it must re-read, not trust memory.
    const phoneHash = readDevicesJson().map((d) => d.id);
    assert.ok(!phoneHash.includes(phone.id));
    assert.ok(!auth.listDevices().some((d) => d.id === phone.id), "server-side list dropped the revoked device");
    assert.deepEqual(destroyed, [phone.id], "the revoked device's live socket was destroyed on reload");
    assert.ok(authAs(phoneToken), "an unrevoked device is still accepted");
    assert.ok(auth.listDevices().some((d) => d.id === pc.id));
    assert.ok(auth.listDevices().some((d) => d.id === phone2.id));
  });

  test("a revoked token is refused by authenticate() even when the cookie is still presented", () => {
    const token = pairDevice("Lost phone", "100.64.0.12");
    const lost = auth.listDevices().find((d) => d.name === "Lost phone");
    assert.equal(authAs(token)?.id, lost.id);
    ageDevicesFile();
    const r = vs(["devices", "revoke", lost.id.slice(0, 8)]); // unique id prefix is enough over SSH
    assert.equal(r.status, 0, r.err);
    assert.equal(authAs(token), null, "refused on the next request, no server restart");
  });

  test("a server-side save after an external revoke does not resurrect the revoked device", () => {
    const token = pairDevice("Resurrect me", "100.64.0.13");
    const victim = auth.listDevices().find((d) => d.name === "Resurrect me");
    assert.ok(authAs(token));
    ageDevicesFile();
    assert.equal(vs(["devices", "revoke", victim.id]).status, 0);
    // Pair a new device in-process: that pushes onto the in-memory list and saves. The external removal must win.
    const newToken = pairDevice("Newest", "100.64.0.14");
    assert.ok(!readDevicesJson().some((d) => d.id === victim.id), "still gone on disk after the server's own write");
    assert.equal(authAs(token), null);
    assert.ok(authAs(newToken), "the server's own addition survived the merge");
  });

  test("revoke --all empties devices.json and every token is refused", () => {
    const tokens = auth.listDevices().length ? [pairDevice("A", "100.64.0.20"), pairDevice("B", "100.64.0.21")] : [];
    assert.ok(tokens.every((t) => authAs(t)));
    ageDevicesFile();
    const r = vs(["devices", "revoke", "--all"]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Revoked \d+ devices?/);
    assert.deepEqual(readDevicesJson(), []);
    assert.ok(tokens.every((t) => authAs(t) === null));
    assert.deepEqual(auth.listDevices(), []);
    assert.match(vs(["devices", "revoke", "--all"]).out, /No paired devices/);
  });

  test("bad ids and bad usage fail without touching the file", () => {
    pairDevice("Keep", "100.64.0.30");
    const before = readFileSync(devicesFile, "utf8");
    let r = vs(["devices", "revoke", "nope-nope-nope"]);
    assert.equal(r.status, 1);
    assert.match(r.err, /no paired device matches/);
    r = vs(["devices", "revoke"]);
    assert.equal(r.status, 1);
    assert.match(r.err, /usage: vs devices/);
    r = vs(["devices", "frobnicate"]);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(devicesFile, "utf8"), before);
    assert.deepEqual(cli.foldDevicesArgv(["devices", "revoke", "--all"]), ["devices", "revoke", "all"]);
    assert.deepEqual(cli.foldDevicesArgv(["spawn", "--all"]), ["spawn", "--all"], "only vs devices folds --all");
  });
});

describe("vs pair (headless)", () => {
  test("needs the local token file, never a network route", () => {
    const r = vs(["pair"], { VIBESQUAD_HOME: mkdtempSync(join(tmpdir(), "vs-cli-pair-empty-")), VIBESQUAD_PORT: "1" });
    assert.equal(r.status, 1);
    assert.match(r.err, /no local token/);
  });

  test("mints through the running server's POST /__vibesquad/pair/start and prints link, code, fingerprint and QR", async () => {
    process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
    process.env.VIBESQUAD_MESHNET_HOST = "home-pc.test";
    const { server } = await import("../server/serve.mjs");
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = String(server.address().port);
      auth.getLocalToken(); // the server creates it at startup; the CLI reads the file
      let r = await vsAsync(["pair", "--json"], { VIBESQUAD_PORT: port });
      assert.equal(r.status, 0, r.err);
      const j = JSON.parse(r.out);
      assert.match(j.code, /^\d{6}$/);
      // The link carries the server's configured public port (4180 by default), not the ephemeral loopback port of this test.
      assert.equal(j.pairUrl, `https://home-pc.test:4180/pair?code=${j.code}&fp=${j.caFingerprint.full.replace(/:/g, "").toLowerCase()}`);
      assert.equal(j.qrSvg, undefined, "SVG payloads are not dumped to the terminal");
      assert.ok(auth.discardPairCode && typeof j.expiresAt === "number");

      r = await vsAsync(["pair"], { VIBESQUAD_PORT: port });
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /Pairing code:\s+\d{3} \d{3}/);
      assert.match(r.out, /Pairing link:\s+https:\/\/home-pc\.test:4180\/pair\?code=\d{6}&fp=[0-9a-f]{64}/);
      assert.match(r.out, /CA fingerprint:\s+([0-9A-F]{2}:){31}[0-9A-F]{2}/);
      assert.ok(r.out.split("\n").length > 20, "an ASCII QR follows the text");
      assert.ok(!r.out.includes("<svg"));

      // The code the CLI printed is a real one in the server process: redeeming it pairs a device.
      const code = /Pairing code:\s+(\d{3}) (\d{3})/.exec(r.out);
      const res = fakeRes();
      // (no resetPairRateLimitForTest here: it would also clear the minted code; the IP below is fresh)
      auth.handlePairRedeem({ url: `/pair?code=${code[1]}${code[2]}`, method: "GET", headers: { host: "home-pc.test:4180" }, socket: { remoteAddress: "100.64.0.40" }, on() {} }, res);
      assert.equal(res.statusCode, 302, "the CLI's code redeems on the server");
    } finally {
      await new Promise((ok) => server.close(ok));
      delete process.env.VIBESQUAD_MESHNET_IP;
      delete process.env.VIBESQUAD_MESHNET_HOST;
    }
  });

  test("formatPairOutput is plain text with no SVG and no hashes beyond the CA fingerprint", () => {
    const text = cli.formatPairOutput({ code: "123456", pairUrl: "https://pc:4180/pair?code=123456", caFingerprint: { full: "AA:BB" }, hostId: "h".repeat(22), expiresAt: Date.now() + 1000 }, "QR\n");
    assert.match(text, /Pairing code:\s+123 456/);
    assert.match(text, /Host id:\s+h{22}/);
    assert.match(text, /QR\n$/);
    assert.ok(!text.includes("<svg"));
  });
});

describe("X1 R1 H1: an external revoke cuts a device's live SSE stream, not only its next request", () => {
  test("a real /__vibesquad/runner/events stream over the TLS listener closes within ~2 s of `vs devices revoke` in another process", async () => {
    process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
    const { createMeshnetMux } = await import("../server/serve.mjs");
    const { request: httpsRequest } = await import("node:https");
    const token = pairDevice("Streaming phone", "100.64.0.50");
    const dev = auth.listDevices().find((d) => d.name === "Streaming phone");
    const { mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls: auth.getTls() });
    await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
    try {
      const port = mux.address().port;
      const opened = await new Promise((ok, fail) => {
        const req = httpsRequest(
          { host: "127.0.0.1", port, path: "/__vibesquad/runner/events", method: "GET", rejectUnauthorized: false, headers: { host: "100.64.0.7:4180", cookie: `vs_device=${token}`, accept: "text/event-stream" } },
          (res) => ok({ req, res }),
        );
        req.on("error", fail);
        req.end();
      });
      assert.equal(opened.res.statusCode, 200, "the paired device's stream opens");
      assert.match(String(opened.res.headers["content-type"]), /text\/event-stream/);
      await new Promise((ok) => opened.res.once("data", ok)); // ": ok" preamble: the stream is live
      assert.equal(auth.hasDeviceSockets(dev.id), true, "authenticate() registered the stream's socket");
      const closed = new Promise((ok) => {
        opened.res.once("close", () => ok("close"));
        opened.res.once("end", () => ok("end"));
      });
      ageDevicesFile();
      const r = vs(["devices", "revoke", dev.id]);
      assert.equal(r.status, 0, r.err);
      // No further request from the phone: the server's 1 s devices.json watch must notice and destroy the socket.
      const how = await Promise.race([closed, new Promise((_, fail) => setTimeout(() => fail(new Error("stream still open 4 s after revoke")), 4000))]);
      assert.ok(how === "close" || how === "end");
      assert.equal(auth.hasDeviceSockets(dev.id), false);
      assert.equal(authAs(token), null);
    } finally {
      await new Promise((ok) => mux.close(ok));
      delete process.env.VIBESQUAD_MESHNET_IP;
    }
  });
});

describe("X1 R1 M1: devices.json has one locked writer (server/file-lock.mjs withFileLockSync)", () => {
  test("a held <devices.json>.lock makes `vs devices revoke` wait and fail without writing; a dead holder is reaped", () => {
    const token = pairDevice("Locked out", "100.64.0.60");
    const victim = auth.listDevices().find((d) => d.name === "Locked out");
    const lock = `${devicesFile}.lock`;
    const before = readFileSync(devicesFile, "utf8");
    // Held by a live process (this test runner's parent) and fresh: the CLI must not steal it.
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    try {
      const r = vs(["devices", "revoke", victim.id]);
      assert.equal(r.status, 1);
      assert.match(r.err, /Timed out .* waiting for lock/);
      assert.equal(readFileSync(devicesFile, "utf8"), before, "nothing written while the lock is held");
      assert.ok(authAs(token), "still paired");
    } finally {
      rmSync(lock, { force: true });
    }
    // Held by a dead pid: reaped, and the revoke goes through.
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, startedAt: Date.now() - 60_000 }));
    const r2 = vs(["devices", "revoke", victim.id]);
    assert.equal(r2.status, 0, r2.err);
    assert.equal(authAs(token), null);
    assert.ok(!existsSync(lock), "the CLI released the lock it took over");
  });

  test("the server's own writes take the same lock (a pairing is refused, not lost, while another writer holds it)", () => {
    const lock = `${devicesFile}.lock`;
    const before = readFileSync(devicesFile, "utf8");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    try {
      auth.resetPairRateLimitForTest();
      const code = auth.createPairCode();
      const res = fakeRes();
      auth.handlePairRedeem({ url: `/pair?code=${code}&name=Blocked`, method: "GET", headers: { host: "100.64.0.7:4180" }, socket: { remoteAddress: "100.64.0.61" }, on() {} }, res);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.headers["set-cookie"], undefined, "no device cookie without a recorded device");
      assert.equal(readFileSync(devicesFile, "utf8"), before);
    } finally {
      rmSync(lock, { force: true });
    }
    assert.match(readFileSync(new URL("../server/auth.mjs", import.meta.url), "utf8"), /withFileLockSync\(devicesFile\(\)/);
  });
});

describe("X1 R1 M2: an unreadable devices.json fails closed and is never written over", () => {
  test("malformed file: auth refused, list throws, GET 503, pair redeem 503 with the file untouched; recovers once readable", () => {
    const token = pairDevice("Survivor", "100.64.0.70");
    assert.ok(authAs(token));
    const good = readFileSync(devicesFile, "utf8");
    ageDevicesFile();
    writeFileSync(devicesFile, "{ not json");
    assert.equal(authAs(token), null, "fail closed: a paired token is refused while the file is unreadable");
    assert.throws(() => auth.listDevices(), /unreadable/);
    const list = fakeRes();
    auth.handleDevices({ url: "/__vibesquad/devices", method: "GET", headers: { host: "100.64.0.7:4180", cookie: `vs_device=${token}` }, socket: {}, on() {} }, list);
    assert.equal(list.statusCode, 503);
    auth.resetPairRateLimitForTest();
    const code = auth.createPairCode();
    const res = fakeRes();
    auth.handlePairRedeem({ url: `/pair?code=${code}&name=Intruder`, method: "GET", headers: { host: "100.64.0.7:4180" }, socket: { remoteAddress: "100.64.0.71" }, on() {} }, res);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(readFileSync(devicesFile, "utf8"), "{ not json", "a pairing never overwrites an unreadable list");
    assert.equal(vs(["devices", "revoke", "--all"]).status, 1, "the CLI refuses too");
    assert.equal(readFileSync(devicesFile, "utf8"), "{ not json");
    writeFileSync(devicesFile, good);
    assert.ok(authAs(token), "the previous list is back once the file reads again");
    assert.equal(auth.listDevices().length, JSON.parse(good).devices.length, "nothing was cached as empty in between");
  });
});
