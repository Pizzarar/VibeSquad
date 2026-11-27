// Preloaded by `npm test` (node --import) and imported directly by env-sensitive test files (`import "./setup/hermetic.mjs"`),
// so a direct `node --test <file>` run matches `npm test` (idea-667). Keeps the suite independent of the developer's real
// ~/.vibesquad and of the shell that started it (scripts/test-child-env.mjs hermeticizeEnv):
//  - every inherited VS_*/VIBESQUAD_*/PASEO_* var is dropped (agent identity: id + token, lane/team/role; the live server's
//    MESHNET/LAN/PORT config; VIBESQUAD_TEAMS_FILE; VIBESQUAD_START_RUNNER), except the VS_TEST_*/VS_BENCH/VS_ALLOW_REAL_HOME knobs;
//  - a TMPDIR inside the real ~/.vibesquad (runner shells export ~/.vibesquad/tmp) moves to the OS temp, so temp homes are
//    not mistaken for the real home by server/test-guard.mjs;
//  - VIBESQUAD_HOME is an empty temp dir with an empty teams.json, so no real settings, teams, runner lanes or runner agents leak in;
//  - VIBESQUAD_RUNTIME_DIR is an empty temp dir: runtimeDir() prefers it, and a test that synced with the live one would prune
//    and overwrite the running install.
// Tests that need their own home still set VIBESQUAD_HOME; process.env is per test file (one process each). Spawned children inherit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hermeticizeEnv, TEST_SCRATCH_PREFIX } from "../../scripts/test-child-env.mjs";

hermeticizeEnv(process.env);
// idea-977: one scratch dir per test run (under `node --test --import` the parent runner creates it and every file inherits it, so it
// lives until the whole run exits; a direct `node --test <file>` run creates its own); every mkdtemp(os.tmpdir()) in a test (and in its children) lands inside it and the
// exit hook below removes the lot. Killed processes leave theirs for scripts/run-tests.mjs (sweepTestScratch) to age out.
// A child that inherits its parent's scratch (TMPDIR already a vs-t- dir) reuses it: the parent owns and removes it.
mkdirSync(tmpdir(), { recursive: true }); // VS_TEST_TMPDIR may name a dir that does not exist yet
const inherited = basename(tmpdir()).startsWith(TEST_SCRATCH_PREFIX);
const scratch = inherited ? null : mkdtempSync(join(tmpdir(), TEST_SCRATCH_PREFIX));
if (scratch) {
  if (process.platform === "win32") process.env.TMP = process.env.TEMP = scratch;
  else process.env.TMPDIR = scratch;
}
const home = mkdtempSync(join(tmpdir(), "vs-test-home-"));
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
process.env.VIBESQUAD_HOME = home;
const runtimeDirTmp = mkdtempSync(join(tmpdir(), "vs-test-runtime-"));
process.env.VIBESQUAD_RUNTIME_DIR = runtimeDirTmp;
process.on("exit", () => {
  try {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    else {
      rmSync(home, { recursive: true, force: true });
      rmSync(runtimeDirTmp, { recursive: true, force: true });
    }
  } catch {}
});
