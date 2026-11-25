// idea-384 (docs/PLAN_INBOX_TOP3_1120.md T1): the pair dialog's desktop installer and Android APK links are https only,
// the LAN/Meshnet plain-http listener refuses them (301 to https, never the bytes), and each artifact's SHA-256 rides
// along in the CA-fingerprint shape. /ca.crt stays on plain http: it is the bootstrap, checked by the CA fingerprint.
// Run: node --test test/pair-artifact-https.test.mjs
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-pair-artifact-https-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_LAN_IP = "192.168.1.50";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { createMeshnetMux } = await import("../server/serve.mjs");
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
    json() {
      return JSON.parse(this.body);
    },
  };
}
/** The desktop dialog on loopback with the local token: the PC owner. */
const localReq = ({ url = "/__vibesquad/pair/start", method = "POST" } = {}) => ({
  url,
  method,
  headers: { host: "127.0.0.1:4180", "x-vibesquad-token": auth.getLocalToken() },
  socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 },
  on() {},
});

const ARTIFACT_RE = /(VibeSquad-setup\.exe|vibesquad\.apk)$/i;
/** Every string value in the payload that links a desktop installer or APK. */
function artifactLinks(payload) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (ARTIFACT_RE.test(v)) out.push([key, v]);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(payload, "");
  return out;
}
function assertHttpsArtifactsOnly(payload, label) {
  const links = artifactLinks(payload);
  assert.ok(links.length >= 2, `${label}: expected installer/APK links, got ${JSON.stringify(links)}`);
  for (const [k, v] of links) {
    assert.doesNotMatch(v, /^http:\/\//i, `${label}.${k} is plain http: ${v}`);
    assert.match(v, /^https:\/\//, `${label}.${k}`);
  }
}
function assertShaShape(sha, label) {
  if (sha === null) return; // not built in this checkout, or still hashing
  assert.match(sha.full, /^[0-9A-F]{64}$/, label);
  assert.equal(sha.short, sha.full.slice(0, 16), label);
}

describe("LAN path payloads: installer and APK links are https, never http://", () => {
  test("POST /pair/start: LAN + Meshnet installer/APK links are https; SHA-256 fields present", async () => {
    const res = fakeRes();
    await auth.handlePairStart(localReq(), res);
    assert.equal(res.statusCode, 200, res.body);
    const p = res.json();
    assert.equal(p.lanIp, "192.168.1.50");
    assert.equal(p.lanDesktopInstallerUrl, "https://192.168.1.50:4180/VibeSquad-setup.exe");
    assert.equal(p.lanAndroidApkUrl, "https://192.168.1.50:4180/VibeSquad.apk");
    assert.equal(p.desktopSetupHttpUrl, "https://100.64.0.7:4180/VibeSquad-setup.exe");
    assert.equal(p.androidApkHttpUrl, "https://100.64.0.7:4180/VibeSquad.apk");
    assertHttpsArtifactsOnly(p, "pair/start");
    assert.ok("desktopInstallerSha256" in p && "androidApkSha256" in p);
    assertShaShape(p.desktopInstallerSha256, "pair/start installer");
    assertShaShape(p.androidApkSha256, "pair/start apk");
    // The CA bootstrap stays on plain http (verified by caFingerprint in the same payload).
    assert.equal(p.lanCaUrl, "http://192.168.1.50:4180/ca.crt");
    assert.match(p.caFingerprint.full, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  test("GET /devices (dialog meta) and auth status: installer/APK links are https", () => {
    const res = fakeRes();
    auth.handleDevices(localReq({ url: "/__vibesquad/devices", method: "GET" }), res);
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json();
    assertHttpsArtifactsOnly(d, "devices");
    assert.ok("desktopInstallerSha256" in d && "androidApkSha256" in d);
    assertShaShape(d.desktopInstallerSha256, "devices installer");
    assertShaShape(d.androidApkSha256, "devices apk");

    const s = auth.getAuthStatus();
    for (const [k, v] of artifactLinks(s)) assert.match(v, /^https:\/\//, `auth status ${k}`);
    assert.equal(s.lanDesktopInstallerUrl, "https://192.168.1.50:4180/VibeSquad-setup.exe");
  });

  test("artifactShaFingerprint: 64 hex -> uppercase full + 16-char short; anything else -> null", () => {
    const hex = "ab".repeat(32);
    assert.deepEqual(auth.artifactShaFingerprint(hex), { full: hex.toUpperCase(), short: "AB".repeat(8) });
    for (const bad of [null, undefined, "", "ab".repeat(31), "zz".repeat(32), `${hex}00`]) assert.equal(auth.artifactShaFingerprint(bad), null);
  });
});

function call({ port, method = "GET", path = "/", host = "192.168.1.50:4180" }) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, location: res.headers.location, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("LAN/Meshnet plain-http listener refuses installer and APK bytes", () => {
  test("GET/HEAD installer + APK paths over http are 301s to https on the same path, never the file", async () => {
    const tls = auth.getTls();
    const { mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls });
    await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
    const port = mux.address().port;
    try {
      for (const path of ["/VibeSquad-setup.exe", "/__vibesquad/desktop/VibeSquad-setup.exe", "/VibeSquad.apk", "/vibesquad.apk", "/__vibesquad/android/VibeSquad.apk"]) {
        for (const method of ["GET", "HEAD"]) {
          const r = await call({ port, method, path });
          assert.equal(r.status, 301, `${method} ${path}`);
          assert.equal(r.location, `https://192.168.1.50:4180${path}`, `${method} ${path}`);
          assert.equal(r.body.length, 0, `${method} ${path} sent bytes over http`);
          assert.doesNotMatch(String(r.type ?? ""), /portable-executable|android\.package-archive/);
        }
      }
      // The CA bootstrap is still served over http (its fingerprint is in the dialog).
      const ca = await call({ port, path: "/ca.crt" });
      assert.equal(ca.status, 200);
      assert.match(ca.body.toString("utf8"), /BEGIN CERTIFICATE/);
      // The 426 hint no longer advertises the installer over http.
      const post = await call({ port, method: "POST", path: "/api/x" });
      assert.equal(post.status, 426);
      assert.doesNotMatch(post.body.toString("utf8"), /setup\.exe/i);
    } finally {
      await new Promise((ok) => mux.close(ok));
    }
  });
});

describe("downloadArtifactSha256s: hash of the exact bytes the download routes serve", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-artifact-sha-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist-desktop"), { recursive: true });
  const exe = Buffer.from("MZ fake installer bytes");
  const apk = Buffer.from("PK fake apk bytes");
  writeFileSync(join(root, "dist-desktop", "VibeSquad-setup.exe"), exe);
  writeFileSync(join(root, "dist-desktop", "VibeSquad.apk"), apk);
  const sha = (b) => createHash("sha256").update(b).digest("hex");

  test("async waits for the stream hash; sync then reads the cache; a changed file re-hashes", async () => {
    assert.deepEqual(await api.downloadArtifactSha256sAsync(root), { desktopInstaller: sha(exe), androidApk: sha(apk) });
    assert.deepEqual(api.downloadArtifactSha256s(root), { desktopInstaller: sha(exe), androidApk: sha(apk) });
    const apk2 = Buffer.from("PK rebuilt apk bytes, longer");
    writeFileSync(join(root, "dist-desktop", "VibeSquad.apk"), apk2);
    assert.equal((await api.downloadArtifactSha256sAsync(root)).androidApk, sha(apk2));
  });

  test("a fresh <file>.sha256 sidecar is trusted; a stale one is ignored; missing files are null", async () => {
    const file = join(root, "dist-desktop", "VibeSquad-setup.exe");
    const exe2 = Buffer.from("MZ installer v2");
    writeFileSync(file, exe2);
    const fake = "cd".repeat(32);
    writeFileSync(`${file}.sha256`, `${fake}  VibeSquad-setup.exe\n`);
    assert.equal((await api.downloadArtifactSha256sAsync(root)).desktopInstaller, fake, "build sidecar (sha256sum format) wins when fresh");
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${file}.sha256`, past, past);
    const exe3 = Buffer.from("MZ installer v3");
    writeFileSync(file, exe3);
    assert.equal((await api.downloadArtifactSha256sAsync(root)).desktopInstaller, sha(exe3), "stale sidecar ignored");

    const empty = mkdtempSync(join(tmpdir(), "vs-artifact-none-"));
    try {
      const none = await api.downloadArtifactSha256sAsync(empty);
      assert.equal(none.androidApk, null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the installer route sends x-vibesquad-sha256 once hashed", async () => {
    const res = fakeRes();
    api.handleDesktopInstaller({ method: "HEAD", url: "/VibeSquad-setup.exe", headers: {} }, res, root);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["x-vibesquad-sha256"] ?? ""), /^[0-9a-f]{64}$/);
  });
});
