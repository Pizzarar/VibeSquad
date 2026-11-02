import assert from "node:assert/strict";
import test from "node:test";
import { allLaneIds, describeSpinOff, parseSpinOff, runSpinOff, slugLaneId, spinOffFrom, uniqueLaneId } from "../src/pins.ts";

const NEEDS = ["Needs | energy + food", "Ammo | a", "Map | m"].join("\n");
const FOUR = ["Energy | e", "Food | f", "Ammo | a", "Map | m"].join("\n");
const fence = (body) => `Here is the plan.\n\n\`\`\`vs:spin-off\n${body}\n\`\`\`\nOk?`;
const asst = (text, id) => ({ item: { type: "assistant_message", text, id } });

test("valid block parses one Team per line", () => {
  assert.deepEqual(parseSpinOff(fence("Energy | power budget\nFood | hunger loop")), [
    { name: "Energy", brief: "power budget" },
    { name: "Food", brief: "hunger loop" },
  ]);
});

test("malformed and blank lines are skipped, rows capped at 6", () => {
  assert.deepEqual(parseSpinOff(fence("\nno bar here\n | no name\nName |\nGood | ok | with | bars")), [{ name: "Good", brief: "ok | with | bars" }]);
  assert.equal(parseSpinOff(fence("junk")), null);
  assert.equal(parseSpinOff("no fence\nA | b"), null);
  const many = Array.from({ length: 9 }, (_, i) => `T${i} | b`).join("\n");
  assert.equal(parseSpinOff(fence(many)).length, 6);
});

test("only the newest assistant message counts; a revised block replaces the offer", () => {
  const four = asst(fence("Energy | e\nFood | f\nAmmo | a\nMap | m"), "m1");
  const revised = asst(fence("Needs | energy + food\nAmmo | a\nMap | m"), "m2");
  const chatter = asst("Sounds good, anything else?", "m3");
  const r = spinOffFrom("ag", [four, revised]);
  assert.equal(r.id, "ag:m2");
  assert.deepEqual(r.teams.map((t) => t.name), ["Needs", "Ammo", "Map"]);
  assert.equal(spinOffFrom("ag", [four, revised, chatter]), null); // newer message without a block: no offer
  assert.equal(spinOffFrom("ag", [asst("x", "a"), { item: { type: "user_message", text: "hi" } }])?.id, undefined);
});

// Stand-in for createPin: same id rule (slug + uniqueLaneId over every lane), no brief/network.
function fakeSquad(lanes = []) {
  const squad = { id: "sq", lanes: [...lanes] };
  const create = async (name, brief) => {
    if (brief === "boom") throw new Error("brief write failed");
    const lane = { id: uniqueLaneId(slugLaneId(name), allLaneIds([squad])), name, state: "pinned" };
    squad.lanes.push(lane);
    return lane;
  };
  return { squad, create };
}

test("3-line block creates 3 pins; exact ids dedupe", async () => {
  const f = fakeSquad([{ id: "ammo", name: "Ammo", state: "pinned" }]);
  const res = await runSpinOff(f.create, parseSpinOff(fence(NEEDS)));
  assert.equal(res.filter((r) => r.pin).length, 3);
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["ammo", "needs", "ammo-2", "map"]);
  assert.equal(describeSpinOff(res), "Pinned 3 Teams");
});

test("Needs example: only the revised block's button creates 3", async () => {
  const four = asst(fence(FOUR), "m1");
  const revised = asst(fence(NEEDS), "m2");
  const f = fakeSquad();
  await runSpinOff(f.create, spinOffFrom("ag", [four, revised]).teams);
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["needs", "ammo", "map"]);
});

test("failures are reported per row and do not stop the rest", async () => {
  const f = fakeSquad();
  const res = await runSpinOff(f.create, [{ name: "A", brief: "boom" }, { name: "B", brief: "b" }]);
  assert.equal(describeSpinOff(res), "Pinned 1 Team · Failed: A (brief write failed)");
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["b"]);
});
