// P5: VibeSquad never starts, probes or proxies to a Paseo daemon. These were the VIBESQUAD_NO_DAEMON gate tests; the gate is gone with the daemon.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("no Paseo daemon is ever started or reached", () => {
  test("serve.mjs has no daemon autostart, listen-exposure check or /ws proxy", async () => {
    const s = read("server/serve.mjs");
    assert.doesNotMatch(s, /ensurePaseoDaemon|shouldAutoStartPaseoDaemon|checkDaemonListenExposure|proxyUpgrade|readPaseo/);
    assert.doesNotMatch(s, /on\("upgrade"/);
    const mod = await import("../server/serve.mjs");
    assert.equal("shouldAutoStartPaseoDaemon" in mod, false);
  });

  test("the push watcher watches the runner only (no DaemonClient)", async () => {
    const s = read("server/push.mjs");
    assert.doesNotMatch(s, /DaemonClient|attachPaseo|paseoDaemonAlive|syncRunnerPushWatch/);
  });

  test("the Paseo backend, lane routing, daemon control and password modules are deleted", async () => {
    for (const f of ["server/backend/paseo-backend.mjs", "server/backend/paseo-cli.mjs", "server/backend/lane-routing.mjs", "server/paseo-control.mjs", "server/daemon-password.mjs", "plugin/index.ts", "plugin-screens/index.server.ts"]) {
      await assert.rejects(() => import(`../${f}`), /Cannot find module|ERR_MODULE_NOT_FOUND/, f);
    }
  });

  test("no package.json depends on @getpaseo", () => {
    for (const f of ["package.json", "server/package.json"]) assert.doesNotMatch(read(f), /@getpaseo/, f);
  });
});
