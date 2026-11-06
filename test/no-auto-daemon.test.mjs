import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

// Isolate settings so importing serve.mjs never reads/writes the owner's real ~/.vibesquad.
const home = mkdtempSync(join(tmpdir(), "vs-no-daemon-"));
process.env.VIBESQUAD_HOME = home;

const { shouldAutoStartPaseoDaemon } = await import("../server/serve.mjs");

after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("no-auto-daemon · VIBESQUAD_NO_DAEMON gate", () => {
  test("shouldAutoStartPaseoDaemon returns false when VIBESQUAD_NO_DAEMON=1", () => {
    assert.equal(shouldAutoStartPaseoDaemon({ VIBESQUAD_NO_DAEMON: 1 }, { startPaseoWithVibeSquad: true }), false);
  });

  test("shouldAutoStartPaseoDaemon returns false when startPaseoWithVibeSquad=false", () => {
    assert.equal(shouldAutoStartPaseoDaemon({}, { startPaseoWithVibeSquad: false }), false);
  });

  test("shouldAutoStartPaseoDaemon returns true when both env and settings allow it", () => {
    assert.equal(shouldAutoStartPaseoDaemon({}, { startPaseoWithVibeSquad: true }), true);
  });

  test("shouldAutoStartPaseoDaemon is opt-in: unset setting means the daemon is not started", () => {
    assert.equal(shouldAutoStartPaseoDaemon({}, {}), false);
    assert.equal(shouldAutoStartPaseoDaemon({}, { startPaseoWithVibeSquad: undefined }), false);
  });

  test("push watcher builds its DaemonClient only when Paseo is enabled or already listening", () => {
    const s = src("server/push.mjs");
    assert.match(s, /const attachPaseo = \(\) => \{[\s\S]*?client = \(createClient \?\? \(\(cfg\) => new DaemonClient\(cfg\)\)\)\(/);
    assert.match(s, /shouldWatchPaseo\(\) \|\| \(await paseoDaemonAlive\(\)\)/);
    assert.equal((s.match(/new DaemonClient\(/g) || []).length, 1);
  });

  test("shouldAutoStartPaseoDaemon treats the env string \"1\" the same as the number 1", () => {
    assert.equal(shouldAutoStartPaseoDaemon({ VIBESQUAD_NO_DAEMON: "1" }, { startPaseoWithVibeSquad: true }), false);
  });

  test("server/serve.mjs gates ensurePaseoDaemon on the VIBESQUAD_NO_DAEMON guard", () => {
    const s = src("server/serve.mjs");
    assert.match(s, /export function shouldAutoStartPaseoDaemon\(env = process\.env, settings = loadUserSettings\(\)\)/);
    assert.match(s, /VIBESQUAD_NO_DAEMON/);
    assert.match(s, /if \(shouldAutoStartPaseoDaemon\(\)\) \{[\s\S]*?void ensurePaseoDaemon\(\{ listen: readPaseo\(rootDir\)\.listen \}\);/);
  });
});
