import assert from "node:assert/strict";
import test from "node:test";
import { countUnsplit } from "../src/hubBarLogic.ts";

test("countUnsplit: no section is 0", () => {
  assert.equal(countUnsplit("# Brief\n\n## Teams\n- a\n"), 0);
  assert.equal(countUnsplit(""), 0);
});
test("countUnsplit: empty section or a lone none is 0", () => {
  assert.equal(countUnsplit("## Unsplit threads\n\n## Teams\n- a\n"), 0);
  assert.equal(countUnsplit("## Unsplit threads\n- none\n"), 0);
  assert.equal(countUnsplit("## Unsplit threads\n- **None**\n"), 0);
});
test("countUnsplit: counts bullets, either marker, CRLF", () => {
  assert.equal(countUnsplit("## Unsplit threads\n- a\n* b\n- c\n"), 3);
  assert.equal(countUnsplit("## Unsplit threads\r\n- a\r\n- b\r\n- c\r\n"), 3);
});
test("countUnsplit: stops at the next ## heading", () => {
  assert.equal(countUnsplit("## Unsplit threads\n- a\n- b\n## Teams\n- x\n- y\n- z\n"), 2);
});
test("countUnsplit: blank lines ignored, nested bullets count too, prose doesn't", () => {
  assert.equal(countUnsplit("## Unsplit threads\n\n- a\n\n  - sub\n\nsome prose\n- b\n"), 3);
});

test("countUnsplit: the seeded '(none yet)' placeholder counts as 0", () => {
  assert.equal(countUnsplit("## Unsplit threads\n- (none yet)\n\n## Open\n- x\n"), 0);
  assert.equal(countUnsplit("## Unsplit threads\n- (none yet)\n- dark mode\n"), 1);
  assert.equal(countUnsplit("## Unsplit threads\n- None.\n- n/a\n"), 0);
});

import { bugCounts, resolveBugLane } from "../src/hubBarLogic.ts";

test("resolveBugLane: Bug Runner name, then bug-chaser id, else null", () => {
  assert.equal(resolveBugLane([{ id: "x", name: "X" }, { id: "bug-chaser", name: "Bug Chaser" }]), "bug-chaser");
  assert.equal(resolveBugLane([{ id: "b1", name: "Bug Runner" }, { id: "bug-chaser" }]), "b1");
  assert.equal(resolveBugLane([{ id: "ui", name: "UI" }]), null);
});
test("bugCounts: only parked cards of the lane; unseen = newer than seenMax", () => {
  const cards = [
    { id: "idea-1", laneId: "bug-chaser", status: "parked" },
    { id: "idea-5", laneId: "Bug-Chaser", status: "parked" },
    { id: "idea-6", laneId: "bug-chaser", status: "archived" },
    { id: "idea-7", laneId: "ui", status: "parked" },
  ];
  assert.deepEqual(bugCounts(cards, "bug-chaser", 0), { total: 2, unseen: 2, max: 5 });
  assert.deepEqual(bugCounts(cards, "bug-chaser", 5), { total: 2, unseen: 0, max: 5 });
  assert.deepEqual(bugCounts([], "bug-chaser", 3), { total: 0, unseen: 0, max: 0 });
});
