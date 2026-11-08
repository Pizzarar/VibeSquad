// Hub flag contract (PLAN_HUB_BUDDY block 1): src/teams.ts and its server/identity.mjs mirror agree.
import assert from "node:assert/strict";
import test from "node:test";
import { buildNewSquadTeamDef } from "../src/newSquadDef.ts";
import { isHubLane as isHubTs } from "../src/teams.ts";
import { isHubLane as isHubMjs } from "../server/identity.mjs";

for (const [name, isHub] of [["teams.ts", isHubTs], ["identity.mjs", isHubMjs]]) {
  test(`isHubLane (${name}) – explicit hub flag wins`, () => {
    const team = { id: "efi", lanes: [{ id: "efi" }, { id: "boss", hub: true }] };
    assert.equal(isHub(team, team.lanes[1]), true);
  });
  test(`isHubLane (${name}) – id fallback when no lane is flagged`, () => {
    const team = { id: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "other" }] };
    assert.equal(isHub(team, team.lanes[0]), true);
    assert.equal(isHub(team, team.lanes[1]), false);
  });
  test(`isHubLane (${name}) – no fallback when another lane is flagged`, () => {
    const team = { id: "site", lanes: [{ id: "site" }, { id: "home", hub: true }] };
    assert.equal(isHub(team, team.lanes[0]), false);
  });
}

test("new Squad's first lane is the hub", () => {
  const team = buildNewSquadTeamDef({ id: "demo", name: "Demo", folderPath: "C:/x/demo", existingTeams: [] });
  assert.equal(team.lanes[0].hub, true);
  assert.equal(isHubTs(team, team.lanes[0]), true);
});

for (const [name, isHub] of [["teams.ts", isHubTs], ["identity.mjs", isHubMjs]]) {
  test(`isHubLane (${name}): a lane with no id is never the hub`, () => {
    assert.equal(isHub({ lanes: [] }, {}), false);
    assert.equal(isHub({ id: undefined, lanes: [] }, { id: undefined }), false);
  });
}

import { withBugLane } from "../src/newSquadDef.ts";
import { findBugLane as findBugTs } from "../src/teams.ts";
import { findBugLane as findBugMjs } from "../server/identity.mjs";

test("new Squad is seeded with one standing Bug Runner lane; seeding twice adds no duplicate", () => {
  const team = buildNewSquadTeamDef({ id: "demo", name: "Demo", folderPath: "C:/x/demo", existingTeams: [] });
  const bugs = team.lanes.filter((l) => l.bug === true);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].name, "Bug Runner");
  assert.equal(bugs[0].standing, true);
  assert.equal(team.lanes[0].hub, true);
  assert.equal(withBugLane(team, [team]), team);
  assert.equal(withBugLane(withBugLane(team), []).lanes.length, team.lanes.length);
});

test("a second Squad's Bug Runner lane id doesn't clash with the first", () => {
  const a = buildNewSquadTeamDef({ id: "a", name: "A", folderPath: "C:/x/a", existingTeams: [] });
  const b = buildNewSquadTeamDef({ id: "b", name: "B", folderPath: "C:/x/b", existingTeams: [a] });
  assert.notEqual(findBugTs(a).id, findBugTs(b).id);
});

for (const [name, find] of [["teams.ts", findBugTs], ["identity.mjs", findBugMjs]]) {
  test(`findBugLane (${name}): VibeSquad maps to existing bug-chaser, flag wins, none -> null`, () => {
    const vs = { id: "vibesquad", lanes: [{ id: "vibesquad", hub: true }, { id: "bug-chaser", name: "Bug Chaser" }, { id: "art" }] };
    assert.equal(find(vs).id, "bug-chaser");
    const flagged = { id: "x", lanes: [{ id: "bug-chaser" }, { id: "triage", bug: true }] };
    assert.equal(find(flagged).id, "triage");
    assert.equal(find({ id: "y", lanes: [{ id: "y" }] }), null);
    assert.equal(find(undefined), null);
  });
}
