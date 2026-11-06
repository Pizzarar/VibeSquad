// Preloaded by `npm test` (node --import). Keeps the suite independent of the developer's real ~/.vibesquad:
//  - VIBESQUAD_HOME is an empty temp dir with an empty teams.json, so no real settings, teams, runner lanes or runner agents leak in;
//  - VS_DEFAULT_BACKEND=paseo restores the pre-cutover "only explicit runner lanes use the runner" routing, so tests that hand
//    getBackend() a fake client never reach a live runner. Tests of the cutover default pass `env` to runnerLanes() themselves.
// Tests that need their own home still set VIBESQUAD_HOME; process.env is per test file (one process each).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vs-test-home-"));
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
process.env.VIBESQUAD_HOME = home;
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_RUNNER_LANES;
delete process.env.VS_PASEO_LANES;
delete process.env.VIBESQUAD_TEAMS_FILE;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});
