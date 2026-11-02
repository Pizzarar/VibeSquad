// Hub flag contract (PLAN_HUB_BUDDY block 1): src/teams.ts and its server/identity.mjs mirror agree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
  const src = readFileSync(new URL("../src/NewSquadModal.tsx", import.meta.url), "utf8");
  const laneBlock = src.match(/const lane: PinLane = \{[\s\S]*?\};/)[0];
  assert.match(laneBlock, /hub: true/);
});
