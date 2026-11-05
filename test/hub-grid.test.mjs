// PLAN_HUB_BUDDY block 5: the hub lane stays out of the Team grid and Done shelf; its looks-done is ignored.
import assert from "node:assert/strict";
import test from "node:test";
import { gridPinsForSquad, hubPinForSquad, looksDoneFor, pinsForSquad } from "../src/pins.ts";
import { isFormerBrainstormMember } from "../src/teams.ts";
import { shownPaneIn } from "../src/panes.ts";

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

test("hubPinForSquad returns existing hub pin, synthesizes RiffBot when missing, and returns null for _unassigned", () => {
  // Declared hub lane (id matches squad id)
  const declared = hubPinForSquad(view());
  assert.ok(declared);
  assert.equal(declared.lane.id, "hubsq");

  // Squad without an explicit hub lane in teams.json (e.g. efi with feature lanes only, or empty lanes)
  const noHubView = {
    team: { id: "efi", name: "Escape Hatch", color: "#00f0ff", lanes: [{ id: "efi-ui", name: "UI Lab" }], paths: [] },
    lanes: [{ lane: { id: "efi-ui", name: "UI Lab" }, members: [], brainstorm: null, lead: null, topicBrainstorms: [], duplicateBrainstorms: [] }],
    members: [],
    needsYou: 0,
    running: 0,
    unsorted: [],
  };
  const synth = hubPinForSquad(noHubView);
  assert.ok(synth);
  assert.equal(synth.lane.id, "efi");
  assert.equal(synth.lane.name, "RiffBot");
  assert.equal(synth.lane.hub, true);
  assert.equal(synth.state, "pinned");
  assert.equal(synth.brainstorm, null);

  // Empty lanes Squad still gets a synthesized RiffBot hub pin
  const emptyLanesView = {
    team: { id: "zz-walk", name: "ZZ Walk", color: "#4df7a6", lanes: [], paths: [] },
    lanes: [],
    members: [],
    needsYou: 0,
    running: 0,
    unsorted: [],
  };
  const emptySynth = hubPinForSquad(emptyLanesView);
  assert.ok(emptySynth);
  assert.equal(emptySynth.lane.id, "zz-walk");
  assert.equal(emptySynth.lane.name, "RiffBot");
  assert.equal(emptySynth.lane.hub, true);

  // _unassigned returns null
  const unassignedView = {
    team: { id: "_unassigned", name: "Unassigned", color: "#777", lanes: [], paths: [] },
    lanes: [],
    members: [],
    needsYou: 0,
    running: 0,
    unsorted: [],
  };
  assert.equal(hubPinForSquad(unassignedView), null);
});

test("shownPaneIn only highlights the active visible tab, not background tabs in leftTabs/rightTabs", () => {
  const s = {
    leftTabs: ["bs-1", "bs-2", "bs-3"],
    rightTabs: ["bs-4", "bs-5"],
    leftActiveId: "bs-2",
    rightActiveId: "bs-5",
    split: false,
    activePane: "left",
    focus: false,
    sheet: false,
    mounted: ["bs-1", "bs-2"],
    closedTabs: [],
  };
  assert.equal(shownPaneIn(s, "bs-1"), null, "background tab in leftTabs must not stay highlighted");
  assert.equal(shownPaneIn(s, "bs-2"), "left", "active left tab is highlighted");
  assert.equal(shownPaneIn(s, "bs-5"), null, "rightActiveId is not highlighted when split is off");

  const splitState = { ...s, split: true };
  assert.equal(shownPaneIn(splitState, "bs-4"), null, "background tab in rightTabs must not stay highlighted");
  assert.equal(shownPaneIn(splitState, "bs-5"), "right", "active right tab is highlighted when split is on");

  const noneActive = { ...s, leftActiveId: null };
  assert.equal(shownPaneIn(noneActive, "bs-2"), null);
});

test("isFormerBrainstormMember and hubPinForSquad fall back to the most recent former-brainstorm when no active brainstorm exists", () => {
  const team = { id: "efi", name: "Escape Hatch", color: "#00f0ff", lanes: [{ id: "efi-ui", name: "UI Lab" }], paths: [] };
  const olderFormer = {
    kind: "retired",
    team,
    laneId: "efi",
    attention: null,
    children: [],
    agent: {
      id: "former-old",
      title: "(old) ◆ Efi · Buddy",
      status: "closed",
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T11:00:00.000Z",
      labels: { team: "efi", lane: "efi", role: "former-brainstorm" },
    },
  };
  const newerFormer = {
    kind: "retired",
    team,
    laneId: "efi",
    attention: null,
    children: [],
    agent: {
      id: "former-new",
      title: "(old) ◆ Efi · Buddy",
      status: "closed",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T11:00:00.000Z",
      labels: { team: "efi", lane: "efi", role: "former-brainstorm" },
    },
  };
  const archivedFormer = {
    ...newerFormer,
    agent: { ...newerFormer.agent, id: "former-arch", archivedAt: "2026-11-02T12:00:00.000Z" },
  };
  assert.equal(isFormerBrainstormMember(olderFormer), true);
  assert.equal(isFormerBrainstormMember(newerFormer), true);
  assert.equal(isFormerBrainstormMember(archivedFormer), false);

  const v = {
    team,
    lanes: [{ lane: { id: "efi-ui", name: "UI Lab" }, members: [], brainstorm: null, lead: null, topicBrainstorms: [], duplicateBrainstorms: [] }],
    members: [olderFormer, newerFormer, archivedFormer],
    needsYou: 0,
    running: 0,
    unsorted: [],
  };
  const hub = hubPinForSquad(v);
  assert.ok(hub);
  assert.equal(hub.brainstorm?.agent.id, "former-new", "picks newest unarchived former-brainstorm when no active brainstorm exists");
});
