import assert from "node:assert/strict";
import test from "node:test";
import { allLaneIds, describeSpinOff, parseSpinOff, runSpinOff, runSpinOffOnce, slugLaneId, spinOffFrom, spinOffRemaining, uniqueLaneId, withoutSpinOffFence } from "../src/pins.ts";

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

test("malformed and blank lines are skipped, rows capped at 10", () => {
  assert.deepEqual(parseSpinOff(fence("\nno bar here\n | no name\nName |\nGood | ok | with | bars")), [{ name: "Good", brief: "ok | with | bars" }]);
  assert.equal(parseSpinOff(fence("junk")), null);
  assert.equal(parseSpinOff("no fence\nA | b"), null);
  const many = Array.from({ length: 12 }, (_, i) => `T${i} | b`).join("\n");
  assert.equal(parseSpinOff(fence(many)).length, 10);
});

test("only the newest assistant message counts; a revised block replaces the offer", () => {
  const four = asst(fence("Energy | e\nFood | f\nAmmo | a\nMap | m"), "m1");
  const revised = asst(fence("Needs | energy + food\nAmmo | a\nMap | m"), "m2");
  const chatter = asst("Sounds good, anything else?", "m3");
  const r = spinOffFrom("ag", [four, revised]);
  assert.match(r.id, /^spin-off:\*:needs,ammo,map:/); // content-derived, not the message id
  assert.equal(spinOffFrom("ag", [four, revised]).id, spinOffFrom("other", [four, revised]).id); // agent id no longer part of the card id (D1)
  assert.notEqual(r.id, spinOffFrom("ag", [four])?.id);
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

test("leading bullets and numbering are stripped from names", () => {
  assert.deepEqual(parseSpinOff(fence("- Energy | e\n* Food | f\n1. Ammo | a\n2) Map | m")).map((t) => t.name), ["Energy", "Food", "Ammo", "Map"]);
});

test("fences nested in an outer fence or blockquote are ignored; the last real fence wins", () => {
  const example = fence("Old | o") + "\n";
  assert.equal(parseSpinOff("Format:\n````md\n" + example + "````\n"), null);
  assert.equal(parseSpinOff("~~~\n" + example + "~~~\n"), null);
  assert.equal(parseSpinOff("```md\n" + example + "```\n"), null);
  assert.equal(parseSpinOff("> ```vs:spin-off\n> Old | o\n> ```\n"), null);
  assert.deepEqual(parseSpinOff("````md\n" + example + "````\n" + fence("Real | r")), [{ name: "Real", brief: "r" }]);
  assert.deepEqual(parseSpinOff(fence("First | f") + "\nrevised:\n" + fence("Second | s")), [{ name: "Second", brief: "s" }]);
});

test("tile preview strips the vs:spin-off fence and its rows", () => {
  const out = withoutSpinOffFence(fence(NEEDS).split("\n"));
  assert.deepEqual(out, ["Here is the plan.", "", "Ok?"]);
});

test("two concurrent calls create once", async () => {
  const f = fakeSquad();
  let calls = 0;
  const create = async (n, b) => { calls++; await new Promise((r) => setTimeout(r, 10)); return f.create(n, b); };
  const teams = parseSpinOff(fence(NEEDS));
  const [a, b] = await Promise.all([runSpinOffOnce("g1", create, teams), runSpinOffOnce("g1", create, teams)]);
  assert.equal(b, null);
  assert.equal(a.length, 3);
  assert.equal(calls, 3);
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["needs", "ammo", "map"]);
  assert.deepEqual(spinOffRemaining("g1", teams), []);
});

test("partial failure: retry offers and creates only the failed rows", async () => {
  const f = fakeSquad();
  const teams = [{ name: "A", brief: "a" }, { name: "B", brief: "boom" }, { name: "C", brief: "c" }];
  const first = await runSpinOffOnce("g2", f.create, teams);
  assert.equal(describeSpinOff(first), "Pinned 2 Teams · Failed: B (brief write failed)");
  assert.deepEqual(spinOffRemaining("g2", teams).map((t) => t.name), ["B"]);
  const fixed = teams.map((t) => ({ ...t, brief: t.brief === "boom" ? "b" : t.brief }));
  const second = await runSpinOffOnce("g2", f.create, fixed);
  assert.equal(second.length, 1);
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["a", "c", "b"]); // no a-2 / c-2 copies
  assert.deepEqual(spinOffRemaining("g2", fixed), []);
});

// The card's path: always the FULL offer list; runSpinOffOnce alone skips rows already created.
test("card path: [A ok, B fail, C ok] retry creates B, 'Pinned 1 Team', then nothing remains", async () => {
  const f = fakeSquad();
  const failing = new Set(["B"]);
  const create = (n, b) => (failing.has(n) ? Promise.reject(new Error("down")) : f.create(n, b));
  const offer = [{ name: "A", brief: "a" }, { name: "B", brief: "b" }, { name: "C", brief: "c" }];
  const first = await runSpinOffOnce("g3", create, offer);
  assert.equal(describeSpinOff(first), "Pinned 2 Teams · Failed: B (down)");
  assert.deepEqual(spinOffRemaining("g3", offer).map((t) => t.name), ["B"]);
  failing.clear();
  const retry = await runSpinOffOnce("g3", create, offer);
  assert.equal(describeSpinOff(retry), "Pinned 1 Team");
  assert.ok(retry.every((r) => r.pin));
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["a", "c", "b"]);
  assert.deepEqual(spinOffRemaining("g3", offer), []);
});

test("card path: [A fail, B ok, C fail] retry creates A and C", async () => {
  const f = fakeSquad();
  const failing = new Set(["A", "C"]);
  const create = (n, b) => (failing.has(n) ? Promise.reject(new Error("down")) : f.create(n, b));
  const offer = [{ name: "A", brief: "a" }, { name: "B", brief: "b" }, { name: "C", brief: "c" }];
  await runSpinOffOnce("g4", create, offer);
  assert.deepEqual(spinOffRemaining("g4", offer).map((t) => t.name), ["A", "C"]);
  failing.clear();
  const retry = await runSpinOffOnce("g4", create, offer);
  assert.equal(describeSpinOff(retry), "Pinned 2 Teams");
  assert.deepEqual(f.squad.lanes.map((l) => l.id), ["b", "a", "c"]);
});
