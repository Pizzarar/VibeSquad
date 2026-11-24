// Preloaded by `npm test` (node --import). Keeps the suite independent of the developer's real ~/.vibesquad and of the shell
// that started it (scripts/test-child-env.mjs hermeticizeEnv):
//  - every inherited VS_*/VIBESQUAD_*/PASEO_* var is dropped (agent identity: id + token, lane/team/role; the live server's
//    MESHNET/LAN/PORT config; VIBESQUAD_TEAMS_FILE; VIBESQUAD_START_RUNNER), except the VS_TEST_*/VS_BENCH/VS_ALLOW_REAL_HOME knobs;
//  - a TMPDIR inside the real ~/.vibesquad (runner shells export ~/.vibesquad/tmp) moves to the OS temp, so temp homes are
//    not mistaken for the real home by server/test-guard.mjs;
//  - VIBESQUAD_HOME is an empty temp dir with an empty teams.json, so no real settings, teams, runner lanes or runner agents leak in;
//  - VIBESQUAD_RUNTIME_DIR is an empty temp dir: runtimeDir() prefers it, and a test that synced with the live one would prune
//    and overwrite the running install.
// Tests that need their own home still set VIBESQUAD_HOME; process.env is per test file (one process each). Spawned children inherit.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticizeEnv } from "../../scripts/test-child-env.mjs";

hermeticizeEnv(process.env);
const home = mkdtempSync(join(tmpdir(), "vs-test-home-"));
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
process.env.VIBESQUAD_HOME = home;
const runtimeDirTmp = mkdtempSync(join(tmpdir(), "vs-test-runtime-"));
process.env.VIBESQUAD_RUNTIME_DIR = runtimeDirTmp;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDirTmp, { recursive: true, force: true });
  } catch {}
});
