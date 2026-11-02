// New Squad -> hub brief: when a PUT /api/teams adds a Team, write docs/brainstorm/<hubLane>.md (## Teams / ## Unsplit threads)
// before any Buddy boots. Never overwrites a brief; existing Squads keep the boot self-heal (HUB_BOOT_RULES).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneWorkingDir } from "./brief-path.mjs";
import { isHubLane } from "./identity.mjs";
import { newPinBrief } from "./pin-ideas.mjs";

const SAFE_LANE = /^[A-Za-z0-9_-]+$/;

/**
 * Seed the hub brief of every Team in `nextTeams` that is not in `prevTeams`. Only the lane flagged `hub: true` counts
 * (no id-fallback guess for a brand-new Squad). `workDir(teamId, laneId)` -> project folder or null (skipped; boot self-heals).
 * Returns the paths written. Never throws: a seed failure must not fail the teams save.
 */
export function seedHubBriefs(prevTeams, nextTeams, rootDir, workDir = (teamId, laneId) => laneWorkingDir(teamId, laneId, rootDir)) {
  const known = new Set((prevTeams ?? []).map((t) => t?.id));
  const written = [];
  for (const team of nextTeams ?? []) {
    if (!team || known.has(team.id)) continue;
    for (const lane of team.lanes ?? []) {
      if (lane?.hub !== true || !isHubLane(team, lane) || !SAFE_LANE.test(String(lane.id))) continue;
      try {
        const root = workDir(team.id, lane.id);
        if (!root) continue;
        const dir = join(root, "docs", "brainstorm");
        const file = join(dir, `${lane.id}.md`);
        if (existsSync(file)) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, newPinBrief(lane.id, lane.name || team.name, "", { hub: true }), { encoding: "utf8", flag: "wx" });
        written.push(file);
      } catch {}
    }
  }
  return written;
}
