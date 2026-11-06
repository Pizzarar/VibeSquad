import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the teams registry at an empty temp file for the duration of `fn`, so getBackend()/runnerLanes() never read the
 * developer's real ~/.vibesquad/teams.json (whose runner lanes would wrap fake clients in a RoutingBackend and leak live
 * rn- agents into assertions).
 */
export async function withIsolatedLanes(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-lanes-"));
  const file = join(dir, "teams.json");
  writeFileSync(file, JSON.stringify({ teams: [] }));
  const prev = process.env.VIBESQUAD_TEAMS_FILE;
  const prevRunner = process.env.VS_RUNNER_LANES;
  process.env.VIBESQUAD_TEAMS_FILE = file;
  delete process.env.VS_RUNNER_LANES;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
    else process.env.VIBESQUAD_TEAMS_FILE = prev;
    if (prevRunner !== undefined) process.env.VS_RUNNER_LANES = prevRunner;
    rmSync(dir, { recursive: true, force: true });
  }
}
