import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArc } from "../server/storybook/unlocks.mjs";

const loc = (id, order, extra = {}) => ({ id, kind: "location", display: id, data: { unlock_order: order, ...extra }, links: [] });
const tr = (id, level_0) => ({ id, kind: "trader", display: id, data: { level_0 }, links: [] });
const step = (id, trader, index, task, rep = 0.1) => ({ id, kind: "quest_step", display: id, data: { trader, index, task, rep }, links: [] });
const con = (id, trader, rep_req, extra = {}) => ({ id, kind: "contract", display: id, data: { trader, rep_req, ...extra }, links: [] });
const line = (id, did, path) => ({ id, kind: "line", display: id, data: { id: did, data_path: path, text: "hi" }, links: [] });

const ents = [
  loc("a", 1), loc("b", 2), loc("vault", 3, { requires_key: "key_v" }),
  tr("popper", true), tr("mech", false),
  step("popper_1", "popper", 1, { type: "deliver", item_id: "x" }),
  step("popper_2", "popper", 2, { type: "extract", location: "b" }),
  step("popper_3", "popper", 3, { type: "kill", location: "a" }), // stage never goes down
  step("mech_1", "mech", 1, { type: "reach", room: "gunbench", level: 1 }),
  con("c0", "popper", 0), con("c15", "popper", 0.15), con("c_high", "popper", 0.9), con("c_loc", "popper", 0, { location: "vault" }), con("c_ghost", "nobody", 0.2),
  line("L1", "popper_1.story", '["questlines", "popper", "steps", 0, "story"]'),
  line("L0", "popper_1.title", '["questlines", "popper", "steps", 0, "title"]'),
  { id: "rel:popper:wary", kind: "line", display: "r", data: { origin: "trader_relations", speaker: "popper", text: "t" }, links: [] },
];

test("steps: chain order, stage never decreases, reach emits a reveal", () => {
  const a = buildArc(ents);
  const p = a.arcs.find((x) => x.trader === "popper");
  assert.deepEqual(p.steps.map((s) => [s.id, s.stage]), [["popper_1", 0], ["popper_2", 2], ["popper_3", 2]]);
  assert.deepEqual(p.steps[2].gates.map((g) => g.type), ["prev_step", "map"]);
  assert.equal(a.playOrder.filter((x) => x.kind === "reveal").length, 1);
  assert.match(a.playOrder.find((x) => x.kind === "reveal").label, /gunbench/);
});

test("step lines: title first, then story; reactions collected", () => {
  const p = buildArc(ents).arcs.find((x) => x.trader === "popper");
  assert.deepEqual(p.steps[0].lines.map((l) => l.field), ["title", "story"]);
  assert.deepEqual(p.reactions, ["rel:popper:wary"]);
});

test("contracts: placed after the step that reaches rep_req; unplaceable ones are gaps", () => {
  const a = buildArc(ents);
  const pos = (id) => a.playOrder.find((x) => x.id === id).pos;
  assert.ok(pos("c0") < pos("popper_1") || a.playOrder.find((x) => x.id === "c0").sub < 0);
  const c15 = a.playOrder.find((x) => x.id === "c15");
  assert.equal(c15.sub, 1.5); // 0.1 after step 1, 0.2 after step 2 -> rep 0.15 reached after popper_2 (k=1)
  assert.equal(c15.stage, 2);
  const gapIds = a.gaps.map((g) => g.id);
  assert.ok(gapIds.includes("c_high") && gapIds.includes("c_ghost"));
  assert.ok(gapIds.includes("mech")); // non-level_0 trader: unlock rule not in data
  assert.equal(a.playOrder.find((x) => x.id === "c_loc").stage, 3);
});

test("maps listed by unlock_order with key gate; play order is sorted and numbered", () => {
  const a = buildArc(ents);
  const maps = a.playOrder.filter((x) => x.kind === "map");
  assert.deepEqual(maps.map((m) => m.id), ["a", "b", "vault"]);
  assert.ok(maps[2].gates.some((g) => g.type === "key"));
  for (let i = 1; i < a.playOrder.length; i++) assert.ok(a.playOrder[i].stage >= a.playOrder[i - 1].stage);
  assert.deepEqual(a.playOrder.map((x) => x.pos), a.playOrder.map((_, i) => i + 1));
  assert.ok(a.notDerivable.some((n) => /feature_reveal/.test(n)));
});

test("empty / foreign snapshot: empty arc, no throw", () => {
  const a = buildArc([]);
  assert.deepEqual([a.arcs.length, a.playOrder.length, a.gaps.length], [0, 0, 0]);
});
