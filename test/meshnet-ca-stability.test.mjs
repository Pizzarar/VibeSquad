// idea-69 (docs/PLAN_MESHNET_CA_STABILITY_69.md, stakes tierA-security): Meshnet-first pairing and a LAN-IP-stable CA.
// (1) On a Meshnet host a LAN-IP change (or the LAN IP going away) never rotates the CA the phone pinned; the CA keeps only
// exact /32 nameConstraints (SECURITY.md, no CIDR ranges) and the leaf SAN carries only IPs that CA permits, proved with a
// real `openssl verify` (RFC 5280 chain + nameConstraints). (2) A LAN-only host still rotates. (3) handlePairStart pairs by
// the Meshnet IP, never the host name, LAN IP as fallback. (4) The phone sheet prefers pairIpUrl / qrSvgIp.
// Attacker / regression cases are marked "negative:".
// Run: node --test test/meshnet-ca-stability.test.mjs
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

const MESH_IP = "100.64.0.10";
const LAN_A = "192.168.1.10";
const LAN_B = "192.168.1.99";
const baseHome = mkdtempSync(join(tmpdir(), "vs-mesh-ca-base-"));
process.env.VIBESQUAD_HOME = baseHome;
process.env.PASEO_HOME = join(baseHome, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
writeFileSync(join(baseHome, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const { phonePairLinkAndQr } = await import("../src/phonePairLogic.ts");
// Never read the developer's real interfaces (a live NordLynx / LAN address would leak into netConfig()).
auth.setNetInterfacesForTest({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00" }] });
after(() => rmSync(baseHome, { recursive: true, force: true }));

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vs-mesh-ca-"));
  writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
  process.env.VIBESQUAD_HOME = home;
});
afterEach(() => {
  process.env.VIBESQUAD_HOME = baseHome;
  rmSync(home, { recursive: true, force: true });
});

const tls = (n) => join(home, "tls", n);
const caBytes = () => readFileSync(tls("ca.crt"));
const caSha256 = () => createHash("sha256").update(new X509Certificate(caBytes()).raw).digest("hex");
const leafSan = () => new X509Certificate(readFileSync(tls("server.crt"))).subjectAltName ?? "";
const meta = () => JSON.parse(readFileSync(tls("meta.json"), "utf8"));
const esc = (s) => s.replace(/\./g, "\\.");

/** The CA's permitted nameConstraints entries, one per line as openssl prints them. */
function permittedSubtrees() {
  const text = auth.openssl(["x509", "-in", tls("ca.crt"), "-noout", "-text"]);
  const block = /X509v3 Name Constraints:[^\n]*\n([\s\S]*?)\n\s*(?:X509v3 |Signature Algorithm)/.exec(text)?.[1] ?? "";
  assert.match(block, /Permitted:/, text);
  assert.doesNotMatch(block, /Excluded:/);
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "Permitted:");
}

/** SECURITY.md:13: only localhost, 127.0.0.1/32 and the exact /32 host IPs; never a range. */
function assertExactSlash32(expectIps) {
  const entries = permittedSubtrees();
  const ips = entries.filter((e) => e.startsWith("IP:"));
  for (const e of ips) assert.match(e, /^IP:\d+\.\d+\.\d+\.\d+\/255\.255\.255\.255$/, `not an exact /32: ${e}`);
  for (const range of ["/255.255.255.0", "/255.255.0.0", "/255.0.0.0", "/255.240.0.0", "10.0.0.0", "172.16.0.0", "192.168.0.0"]) {
    assert.ok(!entries.some((e) => e.includes(range)), `negative: CIDR range ${range} in ${JSON.stringify(entries)}`);
  }
  assert.deepEqual(
    [...ips].sort(),
    ["127.0.0.1", ...expectIps].map((ip) => `IP:${ip}/255.255.255.255`).sort(),
  );
  assert.deepEqual(entries.filter((e) => !e.startsWith("IP:")), ["DNS:localhost"]);
}

/** Real RFC 5280 path validation, nameConstraints included (OpenSSL enforces permitted subtrees on SAN IPs). */
function opensslVerify(caFile = tls("ca.crt"), leafFile = tls("server.crt")) {
  const r = spawnSync("openssl", ["verify", "-CAfile", caFile, leafFile], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("Meshnet host: a LAN-IP change never rotates the pinned CA", () => {
  test("lanIp change and lanIp gone: CA bytes + SHA-256 unchanged, exact /32 only, openssl verify passes, leaf SAN gated", () => {
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_A });
    const ca0 = caBytes();
    const fp0 = caSha256();
    assertExactSlash32([MESH_IP, LAN_A]);
    let v = opensslVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(MESH_IP)}`));
    assert.match(leafSan(), new RegExp(`IP Address:${esc(LAN_A)}`), "the LAN IP the CA was issued for is in the leaf");
    assert.deepEqual(meta().ca, { host: "", ip: MESH_IP, lanIp: LAN_A, v: 4 });

    // DHCP renewal / Wi-Fi switch: new LAN IP.
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_B });
    assert.ok(caBytes().equals(ca0), "ca.crt bytes unchanged after a LAN-IP change");
    assert.equal(caSha256(), fp0, "CA SHA-256 fingerprint unchanged (no re-pair)");
    assert.equal(auth.caFingerprint().full.replace(/:/g, "").toLowerCase(), fp0);
    assertExactSlash32([MESH_IP, LAN_A]);
    assert.deepEqual(meta().ca, { host: "", ip: MESH_IP, lanIp: LAN_A, v: 4 }, "meta.ca keeps its original lanIp");
    v = opensslVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(MESH_IP)}`));
    assert.match(leafSan(), /IP Address:127\.0\.0\.1/);
    assert.doesNotMatch(leafSan(), new RegExp(esc(LAN_B)), "negative: the unpermitted new LAN IP is never in the leaf");
    assert.doesNotMatch(leafSan(), new RegExp(esc(LAN_A)), "the old LAN IP is no longer this host's: not in the leaf");

    // Unplugged: no LAN IP at all.
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: null });
    assert.ok(caBytes().equals(ca0), "ca.crt bytes unchanged with no LAN IP");
    assert.equal(caSha256(), fp0);
    assertExactSlash32([MESH_IP, LAN_A]);
    v = opensslVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(MESH_IP)}`));
    assert.doesNotMatch(leafSan(), /IP Address:192\.168\./);

    // Back on the original network: same CA, the permitted LAN IP returns to the leaf.
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_A });
    assert.ok(caBytes().equals(ca0));
    v = opensslVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(LAN_A)}`));
  });

  test("negative: openssl verify really enforces the /32 constraints (a leaf naming the new LAN IP fails under the kept CA)", () => {
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_A });
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_B });
    // Hand-sign a leaf with the kept CA that names the unpermitted LAN IP: what the pre-gate code would have issued.
    const d = mkdtempSync(join(tmpdir(), "vs-mesh-ca-bad-"));
    try {
      writeFileSync(
        join(d, "leaf.cnf"),
        ["[req]", "distinguished_name = dn", "prompt = no", "[dn]", "CN = localhost", "[v3_leaf]", "basicConstraints = critical, CA:FALSE",
          `subjectAltName = DNS:localhost, IP:${MESH_IP}, IP:${LAN_B}, IP:127.0.0.1`, ""].join("\n"),
      );
      auth.openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", join(d, "k.pem")]);
      auth.openssl(["req", "-new", "-key", join(d, "k.pem"), "-config", join(d, "leaf.cnf"), "-out", join(d, "r.csr")]);
      auth.openssl(["x509", "-req", "-in", join(d, "r.csr"), "-CA", tls("ca.crt"), "-CAkey", tls("ca.key"), "-set_serial", "7",
        "-days", "1", "-sha256", "-extfile", join(d, "leaf.cnf"), "-extensions", "v3_leaf", "-out", join(d, "bad.crt")]);
      const v = opensslVerify(tls("ca.crt"), join(d, "bad.crt"));
      assert.notEqual(v.status, 0, v.out);
      assert.match(v.out, /permitted subtree violation|name constraint/i, v.out);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a Meshnet-IP change or a missing CA file still rotates the CA (the guard is LAN-IP only)", () => {
    auth.ensureTls({ meshnetIp: MESH_IP, meshnetHost: "", lanIp: LAN_A });
    const fp0 = caSha256();
    auth.ensureTls({ meshnetIp: "100.64.0.11", meshnetHost: "", lanIp: LAN_A });
    assert.notEqual(caSha256(), fp0, "a new Meshnet IP rotates");
    assertExactSlash32(["100.64.0.11", LAN_A]);
    assert.equal(opensslVerify().status, 0);
    const fp1 = caSha256();
    rmSync(tls("ca.key"));
    auth.ensureTls({ meshnetIp: "100.64.0.11", meshnetHost: "", lanIp: LAN_B });
    assert.notEqual(caSha256(), fp1, "a missing ca.key rotates");
    assertExactSlash32(["100.64.0.11", LAN_B]);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(LAN_B)}`), "a fresh CA permits and the leaf carries the current LAN IP");
    assert.equal(opensslVerify().status, 0);
  });
});

describe("LAN-only host (no Meshnet IP): a LAN-IP change still rotates", () => {
  test("CA rotates to the new /32 LAN IP and openssl verify passes", () => {
    auth.ensureTls({ meshnetIp: "", meshnetHost: "", lanIp: LAN_A });
    const fp0 = caSha256();
    assertExactSlash32([LAN_A]);
    assert.equal(opensslVerify().status, 0);
    auth.ensureTls({ meshnetIp: "", meshnetHost: "", lanIp: LAN_B });
    assert.notEqual(caSha256(), fp0, "LAN-only host rotates on LAN-IP change");
    assertExactSlash32([LAN_B]);
    assert.equal(meta().ca.lanIp, LAN_B);
    const v = opensslVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(leafSan(), new RegExp(`IP Address:${esc(LAN_B)}`));
    assert.doesNotMatch(leafSan(), new RegExp(esc(LAN_A)));
  });
});

// ---- handlePairStart: Meshnet IP first, never the host name ----

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
const localReq = () => ({
  url: "/__vibesquad/pair/start",
  method: "POST",
  headers: { host: "127.0.0.1:4180", "x-vibesquad-token": auth.getLocalToken() },
  socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 },
  on() {},
});
async function pairStart(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    auth.ensureTls(auth.netConfig()); // this home's CA (getTls() may hold an earlier home's)
    const res = fakeRes();
    await auth.handlePairStart(localReq(), res);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("handlePairStart pairs by the Meshnet IP", () => {
  test("pairUrl uses the Meshnet IP even with a Meshnet host name and a LAN IP set; pairIpUrl / qrSvgIp stay populated", async () => {
    const p = await pairStart({ VIBESQUAD_MESHNET_IP: MESH_IP, VIBESQUAD_MESHNET_HOST: "pc.example", VIBESQUAD_LAN_IP: LAN_A });
    assert.match(p.pairUrl, new RegExp(`^https://${esc(MESH_IP)}:4180/pair\\?code=\\d{6}`));
    assert.doesNotMatch(p.pairUrl, /pc\.example/, "negative: never pair by host name");
    assert.doesNotMatch(p.pairUrl, new RegExp(esc(LAN_A)));
    assert.equal(p.pairIpUrl, p.pairUrl);
    assert.match(p.lanPairUrl, new RegExp(`^https://${esc(LAN_A)}:4180/pair\\?code=${p.code}`), "Home LAN link still offered");
    assert.match(p.qrSvg, /<svg/);
    assert.match(p.qrSvgIp, /<svg/);
    assert.equal(p.meshnetIp, MESH_IP);
  });

  test("falls back to the LAN IP when there is no Meshnet IP", async () => {
    const p = await pairStart({ VIBESQUAD_MESHNET_IP: undefined, VIBESQUAD_MESHNET_HOST: "pc.example", VIBESQUAD_LAN_IP: LAN_A });
    assert.match(p.pairUrl, new RegExp(`^https://${esc(LAN_A)}:4180/pair\\?code=\\d{6}`));
    assert.doesNotMatch(p.pairUrl, /pc\.example/);
    assert.equal(p.pairIpUrl, p.pairUrl);
  });
});

// ---- PhonePairSheet: pairIpUrl / qrSvgIp first ----

describe("PhonePairSheet prefers the Meshnet IP link and QR", () => {
  const full = {
    pairUrl: "https://pc.example:4180/pair?code=1",
    pairIpUrl: `https://${MESH_IP}:4180/pair?code=1`,
    lanPairUrl: `https://${LAN_A}:4180/pair?code=1`,
    qrSvg: "<svg id='host'/>",
    qrSvgIp: "<svg id='ip'/>",
    lanQrSvg: "<svg id='lan'/>",
  };
  test("pairIpUrl / qrSvgIp beat lanPairUrl / lanQrSvg and pairUrl / qrSvg", () => {
    assert.deepEqual(phonePairLinkAndQr(full), { link: full.pairIpUrl, qr: full.qrSvgIp });
  });
  test("an older server without pairIpUrl falls back to pairUrl, then the LAN pair", () => {
    assert.deepEqual(phonePairLinkAndQr({ ...full, pairIpUrl: null, qrSvgIp: null }), { link: full.pairUrl, qr: full.qrSvg });
    assert.deepEqual(phonePairLinkAndQr({ lanPairUrl: full.lanPairUrl, lanQrSvg: full.lanQrSvg }), { link: full.lanPairUrl, qr: full.lanQrSvg });
    assert.deepEqual(phonePairLinkAndQr(null), { link: "", qr: "" });
  });
  test("the sheet reads its link and QR through phonePairLinkAndQr and types pairIpUrl / qrSvgIp", () => {
    const sheet = readFileSync(resolve(import.meta.dirname, "..", "src", "PhonePairSheet.tsx"), "utf8");
    assert.match(sheet, /const \{ link, qr \} = phonePairLinkAndQr\(pair\)/);
    assert.match(sheet, /pairIpUrl\?: string \| null;/);
    assert.match(sheet, /qrSvgIp\?: string \| null;/);
    assert.doesNotMatch(sheet, /pair\?\.lanPairUrl \|\| pair\?\.pairUrl/, "negative: the old LAN-first pick is gone");
  });
});
