import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  SECRET_MASK,
  clearManagedDaemonMarker,
  controlPaseoDaemon,
  controlPaseoPlugin,
  createPaseoConfigBackup,
  getPaseoConfigSurface,
  getPaseoDaemonStatus,
  getPaseoPlugins,
  getPaseoProviders,
  getPaseoUsage,
  listPaseoConfigBackups,
  markDaemonManagedByVibeSquad,
  maskSecrets,
  maskSecretsInText,
  restoreLastPaseoConfigBackup,
  saveCustomAcpProvider,
  togglePaseoProvider,
  updatePaseoSettingsPatch,
  writePaseoConfigAndReload,
} from "../server/paseo-control.mjs";
import { saveUserSettings } from "../server/user-settings.mjs";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";

const rootDir = resolve(import.meta.dirname, "..");

describe("PLAN_PASEO_CONTROLS — Paseo settings & daemon controls (isolated temp daemon)", () => {
  let tempRoot;
  let tempPaseoHome;
  let tempVsHome;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "vs-paseo-controls-"));
    tempPaseoHome = join(tempRoot, "paseo-home");
    tempVsHome = join(tempRoot, "vs-home");
    process.env.VIBESQUAD_HOME = tempVsHome;
  });

  after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  test("1. Secret masking hides keys matching token|secret|key|password|cred|auth and all provider env values", () => {
    const raw = {
      version: 1,
      daemon: {
        listen: "127.0.0.1:6767",
        authToken: "super-secret-daemon-token-999",
      },
      agents: {
        providers: {
          codewhale: {
            extends: "acp",
            label: "CodeWhale",
            command: ["codewhale", "serve", "--acp"],
            env: {
              DEEPSEEK_API_KEY: "sk-live-deepseek-12345",
              PLAIN_VAR: "also-masked-because-provider-env",
            },
            enabled: true,
          },
        },
      },
      hubCredentials: {
        apiKey: "hub-key-xyz",
        password: "my-password-abc",
      },
    };

    const masked = maskSecrets(raw);
    const jsonStr = JSON.stringify(masked);
    assert.ok(!jsonStr.includes("super-secret-daemon-token-999"));
    assert.ok(!jsonStr.includes("sk-live-deepseek-12345"));
    assert.ok(!jsonStr.includes("also-masked-because-provider-env"));
    assert.ok(!jsonStr.includes("hub-key-xyz"));
    assert.ok(!jsonStr.includes("my-password-abc"));
    assert.equal(masked.daemon.authToken, SECRET_MASK);
    assert.equal(masked.agents.providers.codewhale.env.DEEPSEEK_API_KEY, SECRET_MASK);
    assert.equal(masked.agents.providers.codewhale.env.PLAIN_VAR, SECRET_MASK);
    assert.equal(masked.hubCredentials.apiKey, SECRET_MASK);
    assert.equal(masked.hubCredentials.password, SECRET_MASK);

    const textMasked = maskSecretsInText(
      "Connected to relay://relay.paseo.sh:443/srv_1?key=F1MrcI5jyHvCjVm&ssl=true apiKey=sk-99999",
    );
    assert.ok(!textMasked.includes("F1MrcI5jyHvCjVm"));
    assert.ok(!textMasked.includes("sk-99999"));
  });

  test("2. Backups keep max 5 config.json.bak-<ts> files and auto-restore when paseo reload fails", async () => {
    const cfgPath = join(tempPaseoHome, "config.json");
    const initialCfg = {
      version: 1,
      daemon: { listen: "127.0.0.1:16767" },
      pluginsEnabled: true,
      plugins: {
        vibesquad: { source: "directory", path: "C:\\VibeSquad\\plugin", enabled: true },
      },
      agents: {
        providers: {
          claude: { enabled: true },
          codex: { enabled: true },
        },
      },
    };
    await writePaseoConfigAndReload(initialCfg, {
      paseoHome: tempPaseoHome,
      skipReload: true,
    });

    // Create 7 backups -> only 5 newest should remain
    for (let i = 0; i < 7; i++) {
      createPaseoConfigBackup({ paseoHome: tempPaseoHome });
    }
    const backups = listPaseoConfigBackups({ paseoHome: tempPaseoHome });
    assert.equal(backups.length, 5, "Should prune backups to at most 5");

    // Simulate a write where `paseo reload` fails -> must auto-restore the backup
    const failRes = await writePaseoConfigAndReload(
      (cfg) => {
        cfg.daemon.listen = "0.0.0.0:9999";
        return cfg;
      },
      {
        paseoHome: tempPaseoHome,
        isListening: async () => true,
        cliRunner: async (args) => {
          if (args[0] === "reload") {
            return { ok: false, code: 1, stdout: "", stderr: "Invalid daemon configuration" };
          }
          return { ok: true, code: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(failRes.ok, false);
    assert.equal(failRes.restored, true);
    assert.match(failRes.error, /paseo reload failed \(restored backup\)/);

    const diskAfterFail = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(diskAfterFail.daemon.listen, "127.0.0.1:16767", "Backup should have been automatically restored");
  });

  test("3. Toggling a provider or adding a custom ACP provider updates config.json without BOM and reloads", async () => {
    const cliCalls = [];
    const mockOpts = {
      paseoHome: tempPaseoHome,
      isListening: async () => true,
      cliRunner: async (args) => {
        cliCalls.push(args);
        if (args[0] === "provider" && args[1] === "ls") {
          const disk = JSON.parse(readFileSync(join(tempPaseoHome, "config.json"), "utf8"));
          const codexEnabled = disk.agents?.providers?.codex?.enabled !== false;
          return {
            ok: true,
            code: 0,
            stdout: "",
            stderr: "",
            data: [
              { provider: "claude", label: "Claude", status: "available", enabled: "Enabled", defaultMode: "auto", modes: "Auto" },
              {
                provider: "codex",
                label: "Codex",
                status: codexEnabled ? "available" : "unavailable",
                enabled: codexEnabled ? "Enabled" : "Disabled",
                defaultMode: "auto",
                modes: "",
              },
            ],
          };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
    };

    const toggleRes = await togglePaseoProvider("codex", false, mockOpts);
    assert.equal(toggleRes.ok, true);
    assert.equal(toggleRes.reloaded, true);
    assert.ok(cliCalls.some((c) => c[0] === "reload"));

    const provList = await getPaseoProviders(mockOpts);
    const codexRow = provList.providers.find((p) => p.id === "codex");
    assert.equal(codexRow.enabled, false);

    // Add custom ACP provider with secret env var
    const acpRes = await saveCustomAcpProvider(
      {
        id: "openrouter-acp",
        label: "OpenRouter ACP",
        description: "Custom OpenRouter coding agent",
        command: "openrouter-acp serve --stdio",
        env: { OPENROUTER_API_KEY: "sk-or-secret-value-777" },
        enabled: true,
      },
      mockOpts,
    );
    assert.equal(acpRes.ok, true);

    const afterAcp = await getPaseoProviders(mockOpts);
    const customRow = afterAcp.providers.find((p) => p.id === "openrouter-acp");
    assert.ok(customRow);
    assert.equal(customRow.isCustomAcp, true);
    assert.deepEqual(customRow.command, ["openrouter-acp", "serve", "--stdio"]);
    assert.equal(customRow.envMasked.OPENROUTER_API_KEY, SECRET_MASK);
    assert.ok(!JSON.stringify(afterAcp).includes("sk-or-secret-value-777"), "Secret env must never appear in API output");

    // Re-saving with SECRET_MASK preserves the original secret on disk
    await saveCustomAcpProvider(
      {
        id: "openrouter-acp",
        label: "OpenRouter ACP Updated",
        command: ["openrouter-acp", "serve", "--stdio"],
        env: { OPENROUTER_API_KEY: SECRET_MASK },
        enabled: true,
      },
      mockOpts,
    );
    const rawDisk = JSON.parse(readFileSync(join(tempPaseoHome, "config.json"), "utf8"));
    assert.equal(rawDisk.agents.providers["openrouter-acp"].env.OPENROUTER_API_KEY, "sk-or-secret-value-777");
  });

  test("4. Plugins: disabling vibesquad requires confirmation; installing requires unsandboxed confirmation", async () => {
    const mockOpts = {
      paseoHome: tempPaseoHome,
      isListening: async () => true,
      cliRunner: async (args) => {
        if (args[0] === "plugin" && args[1] === "ls") {
          const disk = JSON.parse(readFileSync(join(tempPaseoHome, "config.json"), "utf8"));
          const vsEnabled = disk.plugins?.vibesquad?.enabled !== false;
          return {
            ok: true,
            code: 0,
            stdout: "",
            stderr: "",
            data: [{ id: "vibesquad", name: "VibeSquad", enabled: vsEnabled, status: vsEnabled ? "running" : "disabled", path: "C:\\VibeSquad\\plugin" }],
          };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
    };

    const warnDisable = await controlPaseoPlugin("disable", { id: "vibesquad" }, mockOpts);
    assert.equal(warnDisable.ok, false);
    assert.equal(warnDisable.needsConfirmation, true);
    assert.match(warnDisable.warning, /stops role packs and roster guards/);

    const confirmedDisable = await controlPaseoPlugin("disable", { id: "vibesquad", confirmDisableVibeSquad: true }, mockOpts);
    assert.equal(confirmedDisable.ok, true);
    assert.equal(confirmedDisable.plugins.find((p) => p.id === "vibesquad").enabled, false);

    // Re-enable
    const reEnable = await controlPaseoPlugin("enable", { id: "vibesquad" }, mockOpts);
    assert.equal(reEnable.ok, true);
    assert.equal(reEnable.plugins.find((p) => p.id === "vibesquad").enabled, true);

    // Install without unsandboxed confirmation is rejected
    const warnInstall = await controlPaseoPlugin("install", { source: "npm:some-plugin" }, mockOpts);
    assert.equal(warnInstall.ok, false);
    assert.equal(warnInstall.needsConfirmation, true);
    assert.match(warnInstall.warning, /unsandboxed/);
  });

  test("5. Daemon controls: busy agent confirmation, quit keep-running toggle, and external daemon protection", async () => {
    let daemonStopped = false;
    let busyCount = 2;

    const mockOpts = {
      paseoHome: tempPaseoHome,
      baseHome: tempVsHome,
      isListening: async () => !daemonStopped,
      cliRunner: async (args) => {
        if (args[0] === "status") {
          return {
            ok: true,
            code: 0,
            stdout: "",
            stderr: "",
            data: {
              home: tempPaseoHome,
              pid: 42424,
              startedAt: new Date(Date.now() - 60_000).toISOString(),
              listen: "127.0.0.1:16767",
              configuredListen: "127.0.0.1:16767",
              localDaemon: daemonStopped ? "stopped" : "running",
              daemonVersion: "0.14.0",
            },
          };
        }
        if (args[0] === "ls") {
          const list = [];
          for (let i = 0; i < busyCount; i++) {
            list.push({ id: `busy-${i}`, name: `Worker ${i}`, status: "running" });
          }
          return { ok: true, code: 0, stdout: "", stderr: "", data: list };
        }
        if (args[0] === "daemon" && args[1] === "stop") {
          daemonStopped = true;
          return { ok: true, code: 0, stdout: "Stopped", stderr: "" };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
    };

    // External daemon (no managed marker yet): stop without confirmBusy when busyCount=2 -> requires confirmation
    clearManagedDaemonMarker(mockOpts);
    const stopBusy = await controlPaseoDaemon("stop", mockOpts);
    assert.equal(stopBusy.ok, false);
    assert.equal(stopBusy.needsConfirmation, true);
    assert.equal(stopBusy.busyAgentCount, 2);
    assert.equal(daemonStopped, false);

    // App-quit on an external daemon with keepPaseoRunningOnQuit=false and 0 busy agents -> NEVER stops an external daemon
    busyCount = 0;
    saveUserSettings({ keepPaseoRunningOnQuit: false }, tempVsHome);
    const quitExternal = await controlPaseoDaemon("stop", { ...mockOpts, reason: "app-quit" });
    assert.equal(quitExternal.ok, true);
    assert.equal(quitExternal.skipped, "external-daemon-never-stopped");
    assert.equal(daemonStopped, false);

    // Mark daemon as VibeSquad-managed, but keepPaseoRunningOnQuit=true -> leaves it running on quit
    markDaemonManagedByVibeSquad(42424, mockOpts);
    saveUserSettings({ keepPaseoRunningOnQuit: true }, tempVsHome);
    const quitKeepOn = await controlPaseoDaemon("stop", { ...mockOpts, reason: "app-quit" });
    assert.equal(quitKeepOn.ok, true);
    assert.equal(quitKeepOn.skipped, "keep-running-on-quit");
    assert.equal(daemonStopped, false);

    // Quit with keepPaseoRunningOnQuit=false and 0 busy agents on VibeSquad-managed daemon -> stops Paseo process
    saveUserSettings({ keepPaseoRunningOnQuit: false }, tempVsHome);
    const quitKeepOff = await controlPaseoDaemon("stop", { ...mockOpts, reason: "app-quit" });
    assert.equal(quitKeepOff.ok, true);
    assert.equal(daemonStopped, true);
  });

  test("6. HTTP endpoints (/paseo/status, /paseo/surface, /paseo/usage, /paseo/raw/restore) work and leak zero secrets", async () => {
    // Write a secret into config.json first
    await writePaseoConfigAndReload(
      (cfg) => {
        cfg.daemon.secretToken = "TOP_SECRET_TOKEN_VALUE_888";
        return cfg;
      },
      { paseoHome: tempPaseoHome, skipReload: true },
    );

    const srv = createServer(
      createVibesquadMiddleware(rootDir, {
        paseo: {
          paseoHome: tempPaseoHome,
          baseHome: tempVsHome,
          isListening: async () => true,
          cliRunner: async (args) => {
            if (args[0] === "status") {
              return {
                ok: true,
                code: 0,
                data: {
                  home: tempPaseoHome,
                  pid: 51515,
                  listen: "127.0.0.1:16767",
                  configuredListen: "127.0.0.1:16767",
                  localDaemon: "running",
                  daemonVersion: "0.14.0",
                },
              };
            }
            if (args[0] === "usage") {
              return {
                ok: true,
                code: 0,
                data: [
                  {
                    id: "claude:1",
                    sourceId: "claude",
                    sourceLabel: "Claude",
                    account: { label: "dev@example.com" },
                    report: {
                      status: "available",
                      planLabel: "Max",
                      windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 42, remainingPct: 58, tone: "ok" }],
                      balances: [],
                    },
                  },
                ],
              };
            }
            if (args[0] === "hub") {
              return { ok: true, code: 0, data: [{ state: "not_connected" }] };
            }
            return { ok: true, code: 0, data: [] };
          },
        },
      }),
    );

    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = srv.address().port;

    try {
      const surfaceResp = await fetch(`http://127.0.0.1:${port}/__vibesquad/paseo/surface`);
      assert.equal(surfaceResp.status, 200);
      const surfaceText = await surfaceResp.text();
      assert.ok(!surfaceText.includes("TOP_SECRET_TOKEN_VALUE_888"), "No secret value may appear in /paseo/surface response");
      assert.ok(!surfaceText.includes("sk-or-secret-value-777"), "No provider env secret may appear in /paseo/surface response");

      // Changing daemon.listen flags restartRequired: true
      const listenPatchResp = await fetch(`http://127.0.0.1:${port}/__vibesquad/paseo/surface`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listen: "0.0.0.0:16767", browserToolsEnabled: true }),
      });
      const listenPatchJson = await listenPatchResp.json();
      assert.equal(listenPatchJson.ok, true);
      assert.equal(listenPatchJson.restartRequired, true);
      assert.equal(listenPatchJson.surface.network.listen, "0.0.0.0:16767");
      assert.equal(listenPatchJson.surface.behaviour.browserToolsEnabled, true);

      const usageResp = await fetch(`http://127.0.0.1:${port}/__vibesquad/paseo/usage`);
      const usageJson = await usageResp.json();
      assert.equal(usageJson.ok, true);
      assert.equal(usageJson.providers[0].usedPct, 42);
    } finally {
      srv.close();
    }
  });
});
