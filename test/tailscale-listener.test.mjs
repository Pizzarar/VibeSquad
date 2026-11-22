// Forge cutover A4 (docs/PLAN_FORGE_CUTOVER.md, LINUX_AUDIT R7, stakes tierA-security): Tailscale is a transport-only
// replacement for Meshnet on the existing Meshnet listener path. (1) the Tailscale interface (Linux `tailscale0`, the
// Windows "Tailscale" adapter) is matched next to NordLynx, but only its 100.64.0.0/10 address is ever selected; (2) the
// MagicDNS name rides the existing VIBESQUAD_MESHNET_HOST into isAllowedHostHeader and the cert SAN; (3) /pair?format=json,
// /pair/status and x-vs-device-token work on that listener with a ts.net Host, through the real TLS mux on a non-loopback
// socket address (127.0.0.2: isLocal() only knows 127.0.0.1/::1). Attacker / regression cases are marked "negative:".
// Run: node --test --import ./test/setup/hermetic.mjs test/tailscale-listener.test.mjs
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const TS_HOST = "forge.example.ts.net";
const TS_IP = "100.101.102.103";
const LAN_IP = "192.168.1.50";
const home = mkdtempSync(join(tmpdir(), "vs-tailscale-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_HOST = TS_HOST;
process.env.VIBESQUAD_MESHNET_IP = TS_IP;
process.env.VIBESQUAD_LAN_IP = LAN_IP;
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const { createMeshnetMux } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const addr = (address, extra = {}) => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", ...extra });
const v6 = (address) => ({ address, family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", scopeid: 0 });
const LO = { lo: [addr("127.0.0.1", { internal: true })] };

describe("detectMeshnetIp: Tailscale next to NordLynx, CGNAT address only", () => {
  const pick = (ifaces, env = {}) => auth.detectMeshnetIp(ifaces, env);

  test("Linux tailscale0 and the Windows Tailscale adapter are selected by their 100.64/10 address", () => {
    assert.equal(pick({ ...LO, eth0: [addr(LAN_IP)], tailscale0: [addr(TS_IP), v6("fd7a:115c:a1e0::1")] }), TS_IP);
    assert.equal(pick({ Ethernet: [addr(LAN_IP)], Tailscale: [v6("fd7a:115c:a1e0::1"), addr(TS_IP)] }), TS_IP);
  });

  test("the Tailscale interface beats a CGNAT address on another interface (e.g. a carrier-NAT uplink listed first)", () => {
    assert.equal(pick({ wan0: [addr("100.70.0.5")], tailscale0: [addr(TS_IP)] }), TS_IP);
  });

  test("negative: the name alone never selects an address outside 100.64.0.0/10", () => {
    assert.equal(pick({ eth0: [addr(LAN_IP)], tailscale0: [addr("10.0.0.5")] }), null);
    assert.equal(pick({ Tailscale: [addr("192.168.7.7"), v6("fd7a:115c:a1e0::1")] }), null);
    assert.equal(pick({ tailscale0: [addr("100.128.0.1"), addr("100.63.255.255")] }), null, "just outside the /10 on both sides");
    assert.equal(pick({ tailscale0: [addr(TS_IP, { internal: true })] }), null, "internal addresses are ignored");
    // A look-alike name is not the Tailscale interface; its address is only reachable through the old any-CGNAT fallback.
    assert.equal(pick({ "tailscale-evil": [addr("10.9.9.9")] }), null);
  });

  test("Meshnet unchanged: NordLynx still wins over Tailscale and keeps its old any-IPv4 rule; env override wins over both", () => {
    assert.equal(pick({ tailscale0: [addr(TS_IP)], NordLynx: [addr("100.80.1.2")] }), "100.80.1.2");
    assert.equal(pick({ tailscale0: [addr(TS_IP)], NordLynx: [addr("10.5.0.2")] }), "10.5.0.2");
    assert.equal(pick({ NordLynx: [addr("100.80.1.2")] }), "100.80.1.2");
    assert.equal(pick({ nordlynx: [addr("100.80.1.2")], tailscale0: [addr(TS_IP)] }, { VIBESQUAD_MESHNET_IP: "100.64.9.9" }), "100.64.9.9");
    assert.equal(pick({ wg0: [addr("100.90.0.1")] }), "100.90.0.1", "the pre-existing any-CGNAT fallback is unchanged");
    assert.equal(pick({ ...LO, eth0: [addr(LAN_IP)] }), null);
  });

  test("LAN unchanged: the Tailscale interface and its address never become the LAN IP", () => {
    const lan = (ifaces, env = {}) => auth.detectLanIp(ifaces, env);
    assert.equal(lan({ tailscale0: [addr(TS_IP)], eth0: [addr(LAN_IP)] }), LAN_IP);
    assert.equal(lan({ Tailscale: [addr(TS_IP)], Ethernet: [addr("10.1.2.3")] }), "10.1.2.3");
    assert.equal(lan({ tailscale0: [addr(TS_IP)] }), null);
    assert.equal(lan({ eth0: [addr(LAN_IP)] }, { VIBESQUAD_LAN_IP: " 10.0.0.9 " }), "10.0.0.9");
  });
});

describe("isAllowedHostHeader: the configured MagicDNS name and nothing broader", () => {
  test("accepts the configured ts.net name (with or without port), the transport IP, the LAN IP and loopback names", () => {
    for (const h of [TS_HOST, `${TS_HOST}:4180`, TS_IP, `${TS_IP}:4180`, LAN_IP, "localhost:4180", "127.0.0.1"]) {
      assert.equal(auth.isAllowedHostHeader(h), true, h);
    }
  });

  test("negative: other ts.net hosts, suffix/prefix tricks and random hosts are refused", () => {
    for (const h of [
      "other.example.ts.net",
      "forge.other.ts.net",
      `evil.${TS_HOST}`,
      `${TS_HOST}.evil.example`,
      `${TS_HOST}.`,
      "ts.net",
      "example.ts.net",
      "evil.example",
      `${TS_HOST}:4180/x`,
      ` ${TS_HOST}`,
      `${TS_HOST}@evil.example`,
      "",
      undefined,
    ]) {
      assert.equal(auth.isAllowedHostHeader(h), false, String(h));
    }
  });

  test("negative: without VIBESQUAD_MESHNET_HOST (Meshnet by IP, as before) no ts.net name is accepted", () => {
    const saved = process.env.VIBESQUAD_MESHNET_HOST;
    delete process.env.VIBESQUAD_MESHNET_HOST;
    try {
      assert.equal(auth.isAllowedHostHeader(TS_HOST), false);
      assert.equal(auth.isAllowedHostHeader(TS_IP), true);
    } finally {
      process.env.VIBESQUAD_MESHNET_HOST = saved;
    }
  });
});

describe("the Meshnet mux serving a Tailscale MagicDNS name", () => {
  let tls;
  let mux;
  let port;
  before(async () => {
    tls = auth.getTls();
    ({ mux } = createMeshnetMux({ port: 4180, meshnetHost: TS_HOST, meshnetIp: TS_IP, tls }));
    await new Promise((ok, fail) => {
      mux.once("error", fail);
      mux.listen(0, "127.0.0.2", ok);
    });
    port = mux.address().port;
  });
  after(() => new Promise((ok) => mux.close(ok)));

  const hostHeader = `${TS_HOST}:4180`;
  function tlsCall({ method = "GET", path, headers = {}, body, servername = TS_HOST }) {
    return new Promise((ok, fail) => {
      const req = httpsRequest(
        { host: "127.0.0.2", port, method, path, servername, ca: tls.ca, agent: false, headers: { host: hostHeader, connection: "close", ...headers } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            ok({ status: res.statusCode, headers: res.headers, text, json });
          });
        },
      );
      req.on("error", fail);
      req.end(body);
    });
  }
  function plainCall({ path = "/", host }) {
    return new Promise((ok, fail) => {
      const req = httpRequest({ host: "127.0.0.2", port, path, agent: false, headers: { host, connection: "close" } }, (res) => {
        res.resume();
        res.on("end", () => ok({ status: res.statusCode, location: res.headers.location }));
      });
      req.on("error", fail);
      req.end();
    });
  }

  test("the leaf cert's SAN carries the MagicDNS name and the Tailscale IP; a verifying client accepts that name", async () => {
    const san = new X509Certificate(tls.cert).subjectAltName ?? "";
    assert.match(san, new RegExp(`DNS:${TS_HOST.replace(/\./g, "\\.")}`));
    assert.match(san, new RegExp(`IP Address:${TS_IP.replace(/\./g, "\\.")}`));
    const r = await tlsCall({ path: "/ca.crt" });
    assert.equal(r.status, 200);
  });

  test("the CA's name constraints permit exactly the configured MagicDNS name (plus the existing localhost/IP entries)", () => {
    const caText = auth.openssl(["x509", "-in", join(auth.tlsDir(), "ca.crt"), "-noout", "-text"]);
    const nc = /X509v3 Name Constraints:[^\n]*\n([\s\S]*?)\n\s*(?:X509v3 |Signature Algorithm)/.exec(caText)?.[1] ?? "";
    assert.match(nc, new RegExp(`^\\s*DNS:${TS_HOST.replace(/\./g, "\\.")}\\s*$`, "m"), caText);
    assert.match(nc, /^\s*DNS:localhost\s*$/m);
    assert.equal((nc.match(/ts\.net/g) ?? []).length, 1, "only the configured ts.net name is permitted");
  });

  test("negative: without VIBESQUAD_MESHNET_HOST a fresh home's CA and leaf carry no ts.net name at all", () => {
    const fresh = mkdtempSync(join(tmpdir(), "vs-tailscale-nohost-"));
    const saved = process.env.VIBESQUAD_HOME;
    process.env.VIBESQUAD_HOME = fresh;
    try {
      auth.ensureTls({ meshnetIp: TS_IP, meshnetHost: "", lanIp: LAN_IP });
      for (const file of ["ca.crt", "server.crt"]) {
        const text = auth.openssl(["x509", "-in", join(fresh, "tls", file), "-noout", "-text"]);
        assert.doesNotMatch(text, /ts\.net/i, file);
      }
      const leafSan = new X509Certificate(readFileSync(join(fresh, "tls", "server.crt"))).subjectAltName ?? "";
      assert.match(leafSan, new RegExp(`IP Address:${TS_IP.replace(/\./g, "\\.")}`), "the transport IP is still covered");
    } finally {
      process.env.VIBESQUAD_HOME = saved;
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("negative: a ts.net name that is not configured fails TLS verification (not in the SAN / CA name constraints)", async () => {
    await assert.rejects(tlsCall({ path: "/ca.crt", servername: "other.example.ts.net" }), (e) => /ERR_TLS_CERT_ALTNAME_INVALID/.test(String(e?.code)));
  });

  test("/pair?format=json redeems an owner code; the token then works as x-vs-device-token and on /pair/status", async () => {
    const ownerCode = auth.createPairCode();
    const redeem = await tlsCall({ path: `/pair?format=json&code=${ownerCode}&name=forge-client` });
    assert.equal(redeem.status, 200, redeem.text);
    assert.equal(redeem.json.ok, true);
    assert.equal(redeem.json.state, "paired");
    assert.equal(redeem.json.role, "owner");
    const token = redeem.json.token;
    assert.ok(token);

    const status = await tlsCall({ path: "/pair/status", headers: { "x-vs-device-token": token } });
    assert.deepEqual(status.json, { state: "approved", role: "owner", allowedTeams: null });

    // A gated owner route behind the mux's authenticate() guard and the API trust gate.
    const pending = await tlsCall({ path: "/__vibesquad/pair/pending", headers: { "x-vs-device-token": token } });
    assert.equal(pending.status, 200, pending.text);
    assert.deepEqual(pending.json.pending, []);

    // Device-minted code: pending until the minter approves; /pair/status reports the transition by header token.
    const devices = JSON.parse(readFileSync(join(home, "devices.json"), "utf8"));
    const owner = (Array.isArray(devices) ? devices : devices.devices).find((d) => d.name === "forge-client");
    assert.ok(owner, "the owner device was recorded");
    const childCode = auth.createPairCode(undefined, owner.id);
    const child = await tlsCall({ path: `/pair?format=json&code=${childCode}&name=forge-child` });
    assert.equal(child.status, 200, child.text);
    assert.equal(child.json.state, "pending");
    const childToken = child.json.token;
    assert.equal((await tlsCall({ path: "/pair/status", headers: { "x-vs-device-token": childToken } })).json.state, "pending");
    assert.equal((await tlsCall({ path: "/__vibesquad/pair/pending", headers: { "x-vs-device-token": childToken } })).status, 401, "a pending token opens nothing");

    const list = await tlsCall({ path: "/__vibesquad/pair/pending", headers: { "x-vs-device-token": token } });
    const pendingId = list.json.pending[0]?.pendingId;
    assert.ok(pendingId, list.text);

    // negative: the same write with the cookie and a cross-site Origin is refused (cookie semantics unchanged).
    const crossSite = await tlsCall({
      method: "POST",
      path: "/__vibesquad/pair/approve",
      headers: { cookie: `${auth.DEVICE_COOKIE}=${token}`, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ pendingId, approve: true }),
    });
    assert.equal(crossSite.status, 403, crossSite.text);
    assert.equal((await tlsCall({ path: "/pair/status", headers: { "x-vs-device-token": childToken } })).json.state, "pending");

    // Header token write (not a CSRF vector, so no Origin proof needed): the minter approves.
    const approve = await tlsCall({
      method: "POST",
      path: "/__vibesquad/pair/approve",
      headers: { "x-vs-device-token": token, "content-type": "application/json" },
      body: JSON.stringify({ pendingId, approve: true }),
    });
    assert.equal(approve.status, 200, approve.text);
    assert.equal((await tlsCall({ path: "/pair/status", headers: { "x-vs-device-token": childToken } })).json.state, "approved");
  });

  test("negative: no token, a bogus token, or an invalid code get nothing on the ts.net listener", async () => {
    assert.equal((await tlsCall({ path: "/__vibesquad/pair/pending" })).status, 401);
    assert.equal((await tlsCall({ path: "/__vibesquad/pair/pending", headers: { "x-vs-device-token": "A".repeat(43) } })).status, 401);
    assert.deepEqual((await tlsCall({ path: "/pair/status" })).json, { state: "gone" });
    assert.deepEqual((await tlsCall({ path: "/pair/status", headers: { "x-vs-device-token": "A".repeat(43) } })).json, { state: "gone" });
    const bad = await tlsCall({ path: "/pair?format=json&code=000000" });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.state, "invalid");
    assert.equal(bad.json.token, undefined);
  });

  test("plain http on the listener: the configured ts.net Host is echoed into the https redirect; other hosts never are", async () => {
    const ok = await plainCall({ path: "/squads", host: hostHeader });
    assert.equal(ok.status, 301);
    assert.equal(ok.location, `https://${hostHeader}/squads`);
    for (const host of ["other.example.ts.net:4180", `evil.${TS_HOST}:4180`, `${TS_HOST}.evil.example:4180`, "evil.example"]) {
      const r = await plainCall({ path: "/squads", host });
      assert.equal(r.status, 301, host);
      assert.equal(r.location, `https://${TS_HOST}:4180/squads`, `negative: ${host} must not be echoed`);
    }
  });
});
