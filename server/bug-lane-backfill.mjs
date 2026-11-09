import path from "node:path";
import { cleanLaneCode, findBugLane, laneCodesForTeam } from "./identity.mjs";
import { takenLaneIds, uniqueLaneId } from "./pin-ideas.mjs";
import { resolveTeamsFilePath, writeTeamsRegistry } from "./teams-file.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

const freezeCodes = (lanes) => {
  const codes = laneCodesForTeam({ lanes });
  return lanes.map((l) => (cleanLaneCode(l.code) === codes[l.id] ? l : { ...l, code: codes[l.id] }));
};

/** The Squad with its standing, hidden Bug Runner lane. Idempotent: a bug lane it already has (flagged or by fallback id) is kept. Lane ids are unique across Squads (`bug-runner-2`, ...). The audit (Perfection) lane is never seeded here. */
export function seedBugLane(team, existingTeams = []) {
  if (findBugLane(team)) return team;
  const others = existingTeams.filter((t) => t.id !== team.id);
  const taken = takenLaneIds([...others, team].flatMap((t) => t.lanes ?? []));
  const lane = { id: uniqueLaneId("bug-runner", taken), name: "Bug Runner", kind: "bug", hidden: true, standing: true, state: "pinned" };
  return { ...team, lanes: freezeCodes([...(team.lanes ?? []), lane]) };
}

/** Adds the missing bug lane to every Squad in the list. Returns the same array when nothing changed. */
export function backfillBugLanes(teams) {
  let changed = false;
  const out = [];
  for (const t of teams) {
    const next = seedBugLane(t, [...out, ...teams.slice(out.length + 1)]);
    if (next !== t) changed = true;
    out.push(next);
  }
  return changed ? out : teams;
}

/** At server start: persist the backfill once. Never writes the bundled teams.example.json. */
export function persistBugLaneBackfill(rootDir) {
  const file = resolveTeamsFilePath(rootDir);
  if (path.basename(file) === "teams.example.json") return { changed: false };
  const r = readJsonFileWithBom(file, { label: "teams.json", fallback: null });
  const teams = r.ok && r.data && Array.isArray(r.data.teams) ? r.data.teams : null;
  if (!teams) return { changed: false };
  const next = backfillBugLanes(teams);
  if (next === teams) return { changed: false };
  writeTeamsRegistry({ ...r.data, teams: next }, rootDir);
  return { changed: true, added: next.filter((t, i) => t !== teams[i]).map((t) => ({ team: t.id, lane: findBugLane(t).id })) };
}
