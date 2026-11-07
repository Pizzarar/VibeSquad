// Preloaded by `npm test` (node --import). Keeps the suite independent of the developer's real ~/.vibesquad:
//  - VIBESQUAD_HOME is an empty temp dir with an empty teams.json, so no real settings, teams, runner lanes or runner agents leak in;
// Tests that need their own home still set VIBESQUAD_HOME; process.env is per test file (one process each).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vs-test-home-"));
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
process.env.VIBESQUAD_HOME = home;
delete process.env.VIBESQUAD_TEAMS_FILE;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});
