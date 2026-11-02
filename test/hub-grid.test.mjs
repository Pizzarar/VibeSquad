// PLAN_HUB_BUDDY block 5: the hub lane stays out of the Team grid and Done shelf; its looks-done is ignored.
import assert from "node:assert/strict";
import test from "node:test";
import { gridPinsForSquad, looksDoneFor, pinsForSquad } from "../src/pins.ts";

const agent = (id) => ({ id, status: "idle", labels: {} });
function view() {
  const lane = (id, extra = {}) => ({
    lane: { id, name: id, ...extra },
    members: [], brainstorm: null, lead: null, topicBrainstorms: [], duplicateBrainstorms: [],
  });
  return {
    team: { id: "hubsq", name: "Hub Sq", lanes: [{ id: "hubsq" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "old" }] },
    lanes: [lane("hubsq"), lane("a"), lane("b"), lane("c"), lane("old", { state: "done" })],
  };
}

test("hub + 3 Teams renders 3 tiles", () => {
  const { pinned, done } = gridPinsForSquad(view());
  assert.deepEqual(pinned.map((p) => p.lane.id), ["a", "b", "c"]);
  assert.deepEqual(done.map((p) => p.lane.id), ["old"]);
  assert.equal(pinsForSquad(view()).pinned.length, 4, "sidebar/focus still see the hub pin");
});

test("a done hub lane stays off the Done shelf", () => {
  const v = view();
  v.lanes[0].lane.state = "done";
  const { pinned, done } = gridPinsForSquad(v);
  assert.deepEqual(done.map((p) => p.lane.id), ["old"]);
  assert.equal(pinned.length, 3);
});

test("hub's vs:looks-done is ignored, a Team's is not", () => {
  const { pinned } = pinsForSquad(view());
  const hub = pinned.find((p) => p.lane.id === "hubsq");
  const team = pinned.find((p) => p.lane.id === "a");
  assert.equal(looksDoneFor(hub, "msg-1"), null);
  assert.equal(looksDoneFor(team, "msg-1"), "msg-1");
});
