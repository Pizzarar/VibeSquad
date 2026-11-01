import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { buildLatestJson, computeNextBetaVersion, computeStableVersion } from "../server/release.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const tauriCliJs = require.resolve("@tauri-apps/cli/tauri.js");

function getFreePort(host = "127.0.0.1") {
  return new Promise((ok, fail) => {
    const srv = createNetServer();
    srv.on("error", fail);
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => ok(port));
    });
  });
}

function httpCall({ host = "127.0.0.1", port, path, method = "GET", headers = {}, body }) {
  return new Promise((ok, fail) => {
    const req = request({ host, port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

function signPayloadWithTauriKey(payloadBuffer, keyPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), "vs-sign-"));
  const binPath = join(tmpDir, "payload.exe");
  try {
    writeFileSync(binPath, payloadBuffer);
    const signEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath };
    delete signEnv.TAURI_SIGNING_PRIVATE_KEY;
    delete signEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    execFileSync(process.execPath, [tauriCliJs, "signer", "sign", binPath], {
      cwd: rootDir,
      env: signEnv,
      stdio: "pipe",
    });
    return readFileSync(`${binPath}.sig`, "utf8").trim();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("auto-update config & release helpers", () => {
  test("tauri.conf.json configures updater pubkey and createUpdaterArtifacts without weakening CSP", () => {
    const conf = JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
    assert.equal(conf.bundle?.createUpdaterArtifacts, true);
    assert.ok(conf.plugins?.updater?.pubkey?.length > 40);
    assert.ok(Array.isArray(conf.plugins?.updater?.endpoints));
    assert.equal(conf.app?.security?.dangerousInsecureTransportProtocol, undefined);
    assert.match(conf.app?.security?.csp || "", /default-src 'self'/);
  });

  test("computeNextBetaVersion strictly increments beta suffix and computeStableVersion strips pre-release", () => {
    assert.equal(computeNextBetaVersion("0.1.1"), "0.1.1-beta.1");
    assert.equal(computeNextBetaVersion("0.1.1-beta.1"), "0.1.1-beta.2");
    assert.equal(computeNextBetaVersion("0.1.1-beta.9"), "0.1.1-beta.10");
    assert.equal(computeStableVersion("0.1.1-beta.3"), "0.1.1");
  });

  test("buildLatestJson points beta to rolling 'beta' tag and stable to 'vX.Y.Z' tag", () => {
    const beta = buildLatestJson({ version: "0.1.1-beta.2", channel: "beta", signature: "SIG1" });
    assert.equal(beta.version, "0.1.1-beta.2");
    assert.equal(
      beta.platforms["windows-x86_64"].url,
      "https://github.com/Pizzarar/VibeSquad/releases/download/beta/VibeSquad-setup.exe",
    );

    const stable = buildLatestJson({ version: "0.1.2", channel: "stable", signature: "SIG2" });
    assert.equal(stable.version, "0.1.2");
    assert.equal(
      stable.platforms["windows-x86_64"].url,
      "https://github.com/Pizzarar/VibeSquad/releases/download/v0.1.2/VibeSquad-setup.exe",
    );
  });
});

describe("desktop updater verification: channels, signature rejection, and idle beta auto-install", () => {
  const exeCandidates = [
    join(rootDir, "src-tauri", "target", "debug", "VibeSquad.exe"),
    join(rootDir, "src-tauri", "target", "release", "VibeSquad.exe"),
  ];
  const exePath = exeCandidates.find((p) => existsSync(p));
  const keyPath = join(homedir(), ".tauri", "vibesquad-updater.key");

  test("stable ignores beta builds, rejects unsigned/tampered payloads, and beta auto-installs when agent turn finishes", async (t) => {
    if (!exePath) {
      t.skip("VibeSquad.exe not built");
      return;
    }
    if (!existsSync(keyPath)) {
      t.skip("Tauri updater signing key not present at ~/.tauri/vibesquad-updater.key");
      return;
    }

    const validInstallerBytes = Buffer.from("MZ-FAKE-SIGNED-VIBESQUAD-INSTALLER-PAYLOAD-0.1.2");
    const validSignature = signPayloadWithTauriKey(validInstallerBytes, keyPath);

    let stableManifest = {};
    let betaManifest = {};
    let servedInstallerBytes = validInstallerBytes;

    const updateServer = createServer((req, res) => {
      if (req.url === "/stable/latest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(stableManifest));
      }
      if (req.url === "/beta/latest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(betaManifest));
      }
      if (req.url === "/download/VibeSquad-setup.exe") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(servedInstallerBytes);
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise((ok) => updateServer.listen(0, "127.0.0.1", ok));
    const updatePort = updateServer.address().port;
    const baseUrl = `http://127.0.0.1:${updatePort}`;
    const downloadUrl = `${baseUrl}/download/VibeSquad-setup.exe`;

    const configDir = mkdtempSync(join(tmpdir(), "vs-updater-cfg-"));
    const proxyPort = await getFreePort("127.0.0.1");

    const child = spawn(exePath, ["--headless-proxy"], {
      env: {
        ...process.env,
        VIBESQUAD_DESKTOP_CONFIG_DIR: configDir,
        VIBESQUAD_DESKTOP_PORT: String(proxyPort),
        VIBESQUAD_UPDATE_BASE_URL: baseUrl,
        VIBESQUAD_TEST_NO_EXEC_INSTALL: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await httpCall({ port: proxyPort, path: "/__desktop/updater/status" });
          if (r.status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(ready, "Headless proxy did not start in time");

      // 1. Default channel is stable
      const st0 = JSON.parse((await httpCall({ port: proxyPort, path: "/__desktop/updater/status" })).body);
      assert.equal(st0.channel, "stable");

      // 2. Stable channel ignores beta pre-release versions (e.g. 0.1.2-beta.1)
      stableManifest = {
        version: "0.1.2-beta.1",
        notes: "Beta build",
        pub_date: "2026-11-01T18:00:00Z",
        platforms: { "windows-x86_64": { signature: validSignature, url: downloadUrl } },
      };
      const chkBetaOnStable = await httpCall({ port: proxyPort, path: "/__desktop/updater/check", method: "POST" });
      assert.equal(chkBetaOnStable.status, 200);
      const bBetaOnStable = JSON.parse(chkBetaOnStable.body);
      assert.equal(bBetaOnStable.updateAvailable, false, "Stable channel must ignore pre-release versions");

      // 3. Unsigned latest.json (empty signature) is rejected
      stableManifest = {
        version: "0.1.2",
        notes: "Unsigned build",
        pub_date: "2026-11-01T18:00:00Z",
        platforms: { "windows-x86_64": { signature: "", url: downloadUrl } },
      };
      const chkUnsigned = await httpCall({ port: proxyPort, path: "/__desktop/updater/check", method: "POST" });
      assert.equal(chkUnsigned.status, 400);
      const bUnsigned = JSON.parse(chkUnsigned.body);
      assert.equal(bUnsigned.updateAvailable, false);
      assert.match(bUnsigned.lastError, /unsigned/i);

      // 4. Tampered installer binary is rejected by Minisign verification
      stableManifest = {
        version: "0.1.2",
        notes: "Tampered build",
        pub_date: "2026-11-01T18:00:00Z",
        platforms: { "windows-x86_64": { signature: validSignature, url: downloadUrl } },
      };
      servedInstallerBytes = Buffer.from("MZ-TAMPERED-MALICIOUS-BYTES-0.1.2");
      const chkTampered = await httpCall({ port: proxyPort, path: "/__desktop/updater/check", method: "POST" });
      assert.equal(chkTampered.status, 400);
      const bTampered = JSON.parse(chkTampered.body);
      assert.equal(bTampered.updateAvailable, false);
      assert.equal(bTampered.downloaded, false);
      assert.match(bTampered.lastError, /tampered|Signature verification failed/i);

      // 5. Valid signed stable release is downloaded & verified, sets updateAvailable=true without auto-installing
      servedInstallerBytes = validInstallerBytes;
      const chkValidStable = await httpCall({ port: proxyPort, path: "/__desktop/updater/check", method: "POST" });
      assert.equal(chkValidStable.status, 200);
      const bValidStable = JSON.parse(chkValidStable.body);
      assert.equal(bValidStable.updateAvailable, true);
      assert.equal(bValidStable.availableVersion, "0.1.2");
      assert.equal(bValidStable.downloaded, true);
      assert.equal(bValidStable.installTriggered, false, "Stable channel should prompt user rather than auto-installing");

      // 6. Beta channel with agent turn mid-flight downloads & verifies 0.1.2-beta.1, waits until turn finishes, then auto-installs
      await httpCall({
        port: proxyPort,
        path: "/__desktop/updater/busy",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: true }),
      });
      betaManifest = {
        version: "0.1.2-beta.1",
        notes: "Rolling beta",
        pub_date: "2026-11-01T18:30:00Z",
        platforms: { "windows-x86_64": { signature: validSignature, url: downloadUrl } },
      };
      const switchBeta = await httpCall({
        port: proxyPort,
        path: "/__desktop/updater/channel",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "beta" }),
      });
      assert.equal(switchBeta.status, 200);
      const bBetaBusy = JSON.parse(switchBeta.body);
      assert.equal(bBetaBusy.channel, "beta");
      assert.equal(bBetaBusy.updateAvailable, true);
      assert.equal(bBetaBusy.availableVersion, "0.1.2-beta.1");
      assert.equal(bBetaBusy.downloaded, true);
      assert.equal(bBetaBusy.agentTurnMidFlight, true);
      assert.equal(bBetaBusy.installTriggered, false, "Beta must wait while an agent turn is mid-flight");

      // Now agent turn finishes -> auto-installs immediately!
      const clearBusy = await httpCall({
        port: proxyPort,
        path: "/__desktop/updater/busy",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: false }),
      });
      const bBetaIdle = JSON.parse(clearBusy.body);
      assert.equal(bBetaIdle.agentTurnMidFlight, false);
      assert.equal(bBetaIdle.installTriggered, true, "Beta must auto-install as soon as no agent turn is mid-flight");
      assert.equal(bBetaIdle.installedVersion, "0.1.2-beta.1");
    } finally {
      child.kill();
      updateServer.close();
      try {
        rmSync(configDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
