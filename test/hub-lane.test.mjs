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
  const bugs = team.lanes.filter((l) => l.kind === "bug");
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

// ── A1: lane kind + hidden ────────────────────────────────────────────────────
import { findAuditLane as findAuditTs, isHiddenLane as hiddenTs, laneKindOf } from "../src/teams.ts";
import { findAuditLane as findAuditMjs, isHiddenLane as hiddenMjs } from "../server/identity.mjs";
import { pinsForSquad } from "../src/pins.ts";
import { hubTeamsBlock } from "../server/brainstorm.mjs";

test("new Squad seeds one hidden bug lane and one hidden audit lane, no duplicates on re-seed", () => {
  const team = buildNewSquadTeamDef({ id: "demo", name: "Demo", folderPath: "C:/x/demo", existingTeams: [] });
  assert.equal(team.lanes.filter((l) => l.kind === "bug").length, 1);
  assert.equal(team.lanes.filter((l) => l.kind === "audit").length, 1);
  for (const l of team.lanes.filter((l) => l.kind)) assert.equal(l.hidden, true);
  assert.equal(team.lanes[0].hub, true);
  assert.equal(withBugLane(team, [team]), team);
});

test("a second Squad's audit lane id doesn't clash", () => {
  const a = buildNewSquadTeamDef({ id: "a", name: "A", folderPath: "C:/x/a", existingTeams: [] });
  const b = buildNewSquadTeamDef({ id: "b", name: "B", folderPath: "C:/x/b", existingTeams: [a] });
  assert.notEqual(findAuditTs(a).id, findAuditTs(b).id);
});

test("laneKindOf: kind wins, legacy bug:true reads as bug", () => {
  assert.equal(laneKindOf({ bug: true }), "bug");
  assert.equal(laneKindOf({ kind: "audit" }), "audit");
  assert.equal(laneKindOf({ kind: "audit", bug: true }), "audit");
  assert.equal(laneKindOf({ id: "x" }), undefined);
});

for (const [name, findBug, findAudit, isHidden] of [["teams.ts", findBugTs, findAuditTs, hiddenTs], ["identity.mjs", findBugMjs, findAuditMjs, hiddenMjs]]) {
  test(`findAuditLane / isHiddenLane (${name})`, () => {
    const vs = { id: "vibesquad", lanes: [{ id: "vibesquad", hub: true }, { id: "bug-chaser" }, { id: "perfection" }, { id: "art" }] };
    assert.equal(findAudit(vs).id, "perfection");
    assert.equal(findBug(vs).id, "bug-chaser");
    assert.equal(isHidden(vs, vs.lanes[1]), true);
    assert.equal(isHidden(vs, vs.lanes[2]), true);
    assert.equal(isHidden(vs, vs.lanes[3]), false);
    assert.equal(isHidden(vs, vs.lanes[0]), false);
    assert.equal(isHidden(vs, { id: "perfection", hidden: false }), false); // explicit false wins
    const legacy = { id: "x", lanes: [{ id: "triage", bug: true }, { id: "bug-chaser" }] };
    assert.equal(findBug(legacy).id, "triage");
    assert.equal(isHidden(legacy, legacy.lanes[0]), true);
    assert.equal(findAudit({ id: "y", lanes: [{ id: "y" }] }), null);
  });
}

function viewOf(team) {
  return { team, members: [], lanes: team.lanes.map((lane) => ({ lane, lead: null, brainstorm: null, members: [], topicBrainstorms: [], duplicateLeads: [], duplicateBrainstorms: [] })) };
}

test("pinsForSquad leaves hidden lanes out of the grid but includeHidden still resolves them", () => {
  const team = { id: "vibesquad", name: "VibeSquad", color: "#0ff", paths: [], lanes: [{ id: "vibesquad", name: "R", hub: true }, { id: "bug-chaser", name: "Bug" }, { id: "perfection", name: "Perf" }, { id: "art", name: "Art" }] };
  const ids = (r) => r.pinned.map((p) => p.lane.id);
  assert.deepEqual(ids(pinsForSquad(viewOf(team))), ["vibesquad", "art"]);
  assert.deepEqual(ids(pinsForSquad(viewOf(team), { includeHidden: true })), ["vibesquad", "bug-chaser", "perfection", "art"]);
});

test("hubTeamsBlock omits hidden lanes", () => {
  const team = { id: "vibesquad", lanes: [{ id: "vibesquad", hub: true }, { id: "bug-chaser", name: "Bug" }, { id: "perfection", name: "Perf" }, { id: "art", name: "Art" }] };
  const out = hubTeamsBlock({ team, agents: [] });
  assert.ok(out.includes("art") && !out.includes("perfection") && !out.includes("bug-chaser"), out);
});

import { findPinInViews } from "../src/pins.ts";

test("findPinInViews resolves an agent in a hidden lane (SendTo/SpinOff/LooksDone cards keep working)", () => {
  const team = { id: "vibesquad", name: "VibeSquad", color: "#0ff", paths: [], lanes: [{ id: "vibesquad", name: "R", hub: true }, { id: "bug-chaser", name: "Bug" }, { id: "art", name: "Art" }] };
  const view = viewOf(team);
  const bs = { agent: { id: "bs-bug", status: "idle", labels: {} }, kind: "brainstorm", laneId: "bug-chaser" };
  view.lanes[1].brainstorm = bs;
  view.lanes[1].members = [bs];
  view.members = [bs];
  assert.equal(findPinInViews([view], "bs-bug")?.lane.id, "bug-chaser");
  assert.equal(findPinInViews([view], "nope"), null);
});
