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
// X1b: the suite often runs inside a runner agent; its identity (id + token) must never make a test process, or a CLI it
// spawns, an agent caller (owner verbs would refuse, token-bearing calls would 403 against a test server).
for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_AGENT_TOKEN_REQUIRED"]) delete process.env[k];
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});
