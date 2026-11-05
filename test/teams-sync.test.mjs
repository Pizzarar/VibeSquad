import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const teams = readFileSync(new URL("../src/teams.ts", import.meta.url), "utf8");
const paseo = readFileSync(new URL("../src/paseo.ts", import.meta.url), "utf8");

test("saveTeams always refreshes an unknown revision and bases on disk teams", () => {
  const fn = teams.slice(teams.indexOf("export async function saveTeams"));
  assert.match(fn, /if \(teamsRevision === "unknown"\) \{\s*await refreshTeams\(\);/);
  assert.doesNotMatch(fn.slice(0, 200), /isRemote\(\) && teamsRevision/);
  assert.match(fn, /opts\.base\?\.teams \?\? \(teamsRevision !== "unknown" \? diskTeams\(\) : TEAMS\)/);
});

test("loadTeams ignores legacy bare arrays and accepts revisioned caches", () => {
  const fn = teams.slice(teams.indexOf("function loadTeams"), teams.indexOf("export let TEAMS"));
  assert.doesNotMatch(fn, /if \(Array\.isArray\(parsed\)\) return parsed/);
  assert.match(fn, /!Array\.isArray\(parsed\)/);
  assert.match(fn, /parsed\.revision !== "unknown"/);
  assert.match(fn, /Array\.isArray\(parsed\.teams\)/);
  assert.match(teams, /JSON\.stringify\(\{ revision: teamsRevision, teams: next \}\)/);
  assert.match(teams, /export function resetTeamsToDisk[\s\S]*?localStorage\.removeItem\(TEAMS_KEY\)/);
});

test("paseo refreshes teams on connected transition", () => {
  assert.match(paseo, /import \{ refreshTeams, retiredLeadTitle \} from "\.\/teams"/);
  assert.match(paseo, /refetchProviderUsage\(\);\s*void refreshTeams\(\);/);
});

test("user registry names efi Escape From Idle", (t) => {
  let j;
  try {
    j = JSON.parse(readFileSync(join(homedir(), ".vibesquad", "teams.json"), "utf8"));
  } catch {
    return t.skip("no ~/.vibesquad/teams.json on this machine");
  }
  assert.equal(j.teams.find((x) => x.id === "efi")?.name, "Escape From Idle");
});
