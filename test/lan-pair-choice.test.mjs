import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "vs-lan-pair-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.PASEO_HOME = join(home, "paseo");

const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const {
  clearAllConfigWarnings,
  getConfigWarnings,
  loadUserSettings,
  readJsonFileWithBom,
  saveUserSettings,
  stripBom,
} = await import("../server/user-settings.mjs");
const { DEFAULT_PROFILES, loadProfiles } = await import("../server/profiles.mjs");
const { loadTeamsRegistry } = await import("../server/identity.mjs");
const { resolveLanEnabled, createMeshnetMux } = await import("../server/serve.mjs");

after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

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

function findLocalNonLoopbackIpv4() {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return null;
}

function httpCall({ host = "127.0.0.1", port, path, method = "GET", headers = {}, body }) {
  return new Promise((ok, fail) => {
    const req = request({ host, port, path, method, headers: ownerHeaders(headers) }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("persistent LAN opt-in & precedence", () => {
  test("user-settings defaults lanEnabled to false and persists changes", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vs-settings-"));
    try {
      assert.deepEqual(loadUserSettings(tmpHome), { userName: "you", lanEnabled: false });
      const saved = saveUserSettings({ lanEnabled: true }, tmpHome);
      assert.equal(saved.lanEnabled, true);
      assert.equal(saved.userName, "you");
      assert.equal(loadUserSettings(tmpHome).lanEnabled, true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("resolveLanEnabled respects CLI flag and VIBESQUAD_LAN overrides over settings.json", () => {
    assert.equal(resolveLanEnabled({ argv: [], env: {}, settings: { lanEnabled: false } }), false);
    assert.equal(resolveLanEnabled({ argv: [], env: {}, settings: { lanEnabled: true } }), true);
    assert.equal(resolveLanEnabled({ argv: ["--no-lan"], env: { VIBESQUAD_LAN: "1" }, settings: { lanEnabled: true } }), false);
    assert.equal(resolveLanEnabled({ argv: ["--lan"], env: { VIBESQUAD_LAN: "0" }, settings: { lanEnabled: false } }), true);
    assert.equal(resolveLanEnabled({ argv: [], env: { VIBESQUAD_LAN: "0" }, settings: { lanEnabled: true } }), false);
    assert.equal(resolveLanEnabled({ argv: [], env: { VIBESQUAD_LAN: "false" }, settings: { lanEnabled: true } }), false);
    assert.equal(resolveLanEnabled({ argv: [], env: { VIBESQUAD_LAN: "1" }, settings: { lanEnabled: false } }), true);
    assert.equal(resolveLanEnabled({ argv: [], env: { VIBESQUAD_LAN: "true" }, settings: { lanEnabled: false } }), true);
  });

  test("POST /__vibesquad/settings persists lanEnabled and invokes live toggle handler", async () => {
    let toggledState = false;
    let fakeIps = [];
    api.setExposure(false, [], async (want) => {
      toggledState = Boolean(want);
      fakeIps = toggledState ? ["10.0.0.42", "100.64.0.7"] : [];
      return { lanEnabled: toggledState, exposedIps: fakeIps };
    });

    const srv = createServer(api.createVibesquadMiddleware(rootDir));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = srv.address().port;
    try {
      const r1 = await httpCall({
        port,
        path: "/__vibesquad/settings",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lanEnabled: true }),
      });
      assert.equal(r1.status, 200);
      const b1 = JSON.parse(r1.body);
      assert.equal(b1.lanEnabled, true);
      assert.equal(b1.activeLanEnabled, true);
      assert.deepEqual(b1.exposedIps, ["10.0.0.42", "100.64.0.7"]);
      assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).lanEnabled, true);

      const r2 = await httpCall({
        port,
        path: "/__vibesquad/settings",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lanEnabled: false }),
      });
      const b2 = JSON.parse(r2.body);
      assert.equal(b2.lanEnabled, false);
      assert.equal(b2.activeLanEnabled, false);
      assert.deepEqual(b2.exposedIps, []);
    } finally {
      api.setExposure(false, [], null);
      srv.close();
    }
  });

  test("UTF-8 BOM in settings.json, profiles.json, and teams.json is stripped cleanly and scrubbed on disk; corrupt JSON logs warning and surfaces in API", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vs-bom-"));
    try {
      clearAllConfigWarnings();
      // 1. Write settings.json with a leading UTF-8 BOM (EF BB BF) as PowerShell Set-Content does
      const settingsPath = join(tmpHome, "settings.json");
      const bomBuf = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify({ userName: "Alex", lanEnabled: true }, null, 2), "utf8"),
      ]);
      writeFileSync(settingsPath, bomBuf);
      assert.equal(readFileSync(settingsPath)[0], 0xef);

      const loaded = loadUserSettings(tmpHome);
      assert.equal(loaded.userName, "Alex");
      assert.equal(loaded.lanEnabled, true);
      assert.equal(loaded.parseError, undefined);
      assert.equal(getConfigWarnings().length, 0);

      // BOM should have been scrubbed on disk automatically
      assert.notEqual(readFileSync(settingsPath)[0], 0xef);

      // 2. Write profiles.json with a leading UTF-8 BOM
      const profilesPath = join(tmpHome, "profiles.json");
      writeFileSync(
        profilesPath,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify({ profiles: DEFAULT_PROFILES.slice(0, 2) }, null, 2), "utf8"),
        ]),
      );
      const profRes = loadProfiles(profilesPath);
      assert.equal(profRes.exists, true);
      assert.equal(profRes.profiles.length, 2);
      assert.notEqual(readFileSync(profilesPath)[0], 0xef);

      // 3. Write teams.json with a leading UTF-8 BOM
      const teamsPath = join(tmpHome, "teams.json");
      writeFileSync(
        teamsPath,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad" }], paths: ["VibeSquad"] }] }), "utf8"),
        ]),
      );
      const prevTeamsFile = process.env.VIBESQUAD_TEAMS_FILE;
      process.env.VIBESQUAD_TEAMS_FILE = teamsPath;
      try {
        const teams = loadTeamsRegistry(tmpHome);
        assert.equal(teams.length, 1);
        assert.equal(teams[0].id, "vibesquad");
      } finally {
        if (prevTeamsFile === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
        else process.env.VIBESQUAD_TEAMS_FILE = prevTeamsFile;
      }

      // 4. Write malformed JSON into settings.json -> surfaces parseError and configWarnings without overwriting file
      const corruptBytes = Buffer.from("{corrupt json", "utf8");
      writeFileSync(settingsPath, corruptBytes);
      const corruptLoaded = loadUserSettings(tmpHome);
      assert.equal(corruptLoaded.lanEnabled, false);
      assert.ok(corruptLoaded.parseError, "Expected parseError on corrupt settings.json");
      assert.equal(getConfigWarnings().length, 1);
      assert.match(getConfigWarnings()[0].label, /settings\.json/);
      assert.deepEqual(readFileSync(settingsPath), corruptBytes, "Corrupt settings.json must not be silently overwritten on read");

      // 5. Verify lead profile notes include the node JSON write rule (never PowerShell Set-Content)
      const leadClaude = DEFAULT_PROFILES.find((p) => p.name === "Lead - Claude");
      const leadGemini = DEFAULT_PROFILES.find((p) => p.name === "Lead - Gemini");
      assert.match(leadClaude.notes, /Write JSON files with node.*never PowerShell Set-Content/);
      assert.match(leadGemini.notes, /Write JSON files with node.*never PowerShell Set-Content/);
    } finally {
      clearAllConfigWarnings();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("desktop proxy: first-launch mode choice, greyed LAN/Meshnet buttons, and CA auto-pinning", () => {
  const exeCandidates = [
    join(rootDir, "src-tauri", "target", "debug", "VibeSquad.exe"),
    join(rootDir, "src-tauri", "target", "release", "VibeSquad.exe"),
  ];
  const exePath = exeCandidates.find((p) => existsSync(p));

  test("fresh launch shows mode choice before spawning anything, remote mode greys out buttons until paired, and pairing auto-pins CA", async (t) => {
    if (!exePath) {
      t.skip("VibeSquad.exe not built in src-tauri/target");
      return;
    }
    const nonLoopbackIp = findLocalNonLoopbackIpv4();
    if (!nonLoopbackIp) {
      t.skip("No non-loopback IPv4 interface available for remote pairing test");
      return;
    }

    const configDir = mkdtempSync(join(tmpdir(), "vs-desktop-cfg-"));
    const clientEmptyHome = mkdtempSync(join(tmpdir(), "vs-client-home-"));
    const proxyPort = await getFreePort("127.0.0.1");

    // Start an isolated HTTPS+HTTP mux server on the non-loopback IPv4 interface
    const tls = auth.getTls();
    const mux = createMeshnetMux({ tls });
    await new Promise((ok) => mux.mux.listen(0, nonLoopbackIp, ok));
    const remotePort = mux.mux.address().port;
    const remoteHost = `${nonLoopbackIp}:${remotePort}`;

    const child = spawn(exePath, ["--headless-proxy"], {
      env: {
        ...process.env,
        VIBESQUAD_DESKTOP_CONFIG_DIR: configDir,
        VIBESQUAD_DESKTOP_PORT: String(proxyPort),
        VIBESQUAD_HOME: clientEmptyHome, // Ensure proxy CANNOT read server's local ~/.vibesquad/tls/ca.crt
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      // Wait for proxy port to listen
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await httpCall({ port: proxyPort, path: "/" });
          if (r.status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(ready, "Headless proxy did not start listening in time");

      // 1. Fresh install: GET / renders mode choice page, spawns nothing
      const rootResp = await httpCall({ port: proxyPort, path: "/" });
      assert.equal(rootResp.status, 200);
      assert.match(rootResp.body, /data-testid="desktop-mode-choice"/);
      assert.match(rootResp.body, /Run agents on this PC/);
      assert.match(rootResp.body, /Connect to another PC/);
      assert.equal(existsSync(join(configDir, "server.pid")), false, "Fresh launch must not spawn local server");

      // 2. Choose "Connect to another PC" (remote mode)
      const chooseResp = await httpCall({
        port: proxyPort,
        path: "/__desktop/choose-mode",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "remote" }),
      });
      assert.equal(chooseResp.status, 200);
      const chooseBody = JSON.parse(chooseResp.body);
      assert.equal(chooseBody.ok, true);
      assert.equal(chooseBody.serverMode, "remote");
      assert.equal(existsSync(join(configDir, "server.pid")), false, "Remote mode must never spawn local server");

      // 3. Setup screen hides the server picker and both preset buttons when no host is known
      const setupBefore = await httpCall({ port: proxyPort, path: "/__desktop/setup" });
      assert.equal(setupBefore.status, 200);
      assert.match(setupBefore.body, /id="server-picker" style="display:none"/);
      assert.match(setupBefore.body, /id="preset-lan" data-host="" style="display:none"/);
      assert.match(setupBefore.body, /id="preset-meshnet" data-host="" style="display:none"/);

      // 4. Pair with remote server over TLS: proxy auto-fetches http://<remoteHost>/ca.crt, pins it, and redeems code over HTTPS
      auth.resetPairRateLimitForTest();
      const pairCode = auth.createPairCode();
      const pairResp = await httpCall({
        port: proxyPort,
        path: "/__desktop/pair",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverHost: remoteHost, code: pairCode }),
      });
      assert.equal(pairResp.status, 200, `Expected 200 from /__desktop/pair, got ${pairResp.status}: ${pairResp.body}`);
      const pairBody = JSON.parse(pairResp.body);
      assert.equal(pairBody.ok, true);
      assert.equal(pairBody.deviceTokenSaved, true);

      // Verify CA was auto-pinned in configDir/trusted-cas/
      const pinnedFiles = readdirSync(join(configDir, "trusted-cas"));
      assert.ok(pinnedFiles.length >= 1, "Expected server CA to be pinned into trusted-cas/");

      // 5. Proxying GET /__vibesquad/health through the desktop proxy now reaches the remote TLS server with the device token and pinned CA
      const proxiedHealth = await httpCall({ port: proxyPort, path: "/__vibesquad/health" });
      assert.equal(proxiedHealth.status, 200);
      assert.equal(typeof JSON.parse(proxiedHealth.body).port, "number");

      // 6. Setup screen now reveals the server picker and the saved host's preset button
      const setupAfter = await httpCall({ port: proxyPort, path: "/__desktop/setup" });
      const savedCfg = JSON.parse(readFileSync(join(configDir, "desktop-config.json"), "utf8"));
      assert.match(setupAfter.body, /id="server-picker" style=""/);
      if (savedCfg.lastLanHost) {
        assert.ok(setupAfter.body.includes(`id="preset-lan" data-host="${savedCfg.lastLanHost}" style=""`));
      } else {
        assert.ok(savedCfg.lastMeshnetHost);
        assert.ok(setupAfter.body.includes(`id="preset-meshnet" data-host="${savedCfg.lastMeshnetHost}" style=""`));
      }

      // 7. Still zero local server spawned
      assert.equal(existsSync(join(configDir, "server.pid")), false, "Remote pairing must leave zero local server processes");
    } finally {
      child.kill();
      mux.httpsServer.close();
      mux.meshHttpServer.close();
      mux.mux.close();
      try {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(clientEmptyHome, { recursive: true, force: true });
      } catch {}
    }
  });
});
