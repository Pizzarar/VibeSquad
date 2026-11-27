// Storybook item checks #13, #14, #15 (PLAN_STORYBOOK_V2 V4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entity, makeRegistry, validateFinding } from "../server/storybook/schema.mjs";
import { checks, buildItemIndex } from "../server/storybook/checks/items.mjs";
import { CHECK_MODULES } from "../server/storybook/checks/index.mjs";

const src = { path: "data/items.json", line: 10 };
const item = (id, display, data = {}) => entity({ id, kind: "item", display, source: src, data: { description: "", ...data } });
const runAll = (ents) => {
  const reg = makeRegistry(ents);
  return checks.flatMap((c) => c.run({ snapshot: { project: "efi" }, registry: reg, adapter: {} }));
};

test("#13/#14/#15 are registered in CHECK_MODULES and produce valid findings", () => {
  const ids = CHECK_MODULES.flatMap((m) => m.checks.map((c) => c.id));
  for (const id of ["#13", "#14", "#15"]) assert.ok(ids.includes(id), `missing ${id}`);
  const fs = runAll([item("orphan_bolt", "Orphan Bolt")]);
  assert.ok(fs.length >= 2);
  for (const f of fs) assert.equal(validateFinding(f).ok, true, JSON.stringify(f));
});

test("#13 flags quest/contract item with no source; clears when loot, trader, recipe, or node supplies it", () => {
  const missingItem = item("unobtanium", "Unobtanium");
  const nodeItem = item("scrap_wire", "Scrap Wire", { node_sources: [{ kind: "node", id: "debris_pile", label: "Debris Pile" }] });
  const traderItem = item("pistol", "Pistol");
  const recipeItem = item("bandage", "Bandage");
  const lootItem = item("casing", "Brass Casing");
  const ents = [
    missingItem, nodeItem, traderItem, recipeItem, lootItem,
    entity({ id: "q1", kind: "quest_step", display: "Bring It", source: src, links: [{ rel: "wants_item", kind: "item", id: "unobtanium" }], data: { trader: "popper", task: {} } }),
    entity({ id: "c1", kind: "contract", display: "c1", source: src, links: [{ rel: "item", kind: "item", id: "scrap_wire" }], data: { trader: "popper" } }),
    entity({ id: "c2", kind: "contract", display: "c2", source: src, links: [{ rel: "item", kind: "item", id: "pistol" }], data: { trader: "popper" } }),
    entity({ id: "c3", kind: "contract", display: "c3", source: src, links: [{ rel: "item", kind: "item", id: "bandage" }], data: { trader: "popper" } }),
    entity({ id: "c4", kind: "contract", display: "c4", source: src, links: [{ rel: "item", kind: "item", id: "casing" }], data: { trader: "popper" } }),
    entity({ id: "popper", kind: "trader", display: "Popper", source: src, links: [{ rel: "sells", kind: "item", id: "pistol" }] }),
    entity({ id: "rec_bandage", kind: "recipe", display: "Bandage", source: src, links: [{ rel: "produces", kind: "item", id: "bandage" }] }),
    entity({ id: "scav", kind: "enemy", display: "Scav", source: src, links: [{ rel: "drops", kind: "item", id: "casing" }], data: { boss: false } }),
  ];
  const f13 = runAll(ents).filter((f) => f.check === "#13");
  assert.equal(f13.length, 1);
  assert.equal(f13[0].severity, "error");
  assert.deepEqual(f13[0].entityRef, { kind: "item", id: "unobtanium" });
  assert.match(f13[0].msg, /quest_step:q1/);
});

test("#14 flags items with no source and no use; extra_uses / node_sources / recipe / room count as references", () => {
  const ents = [
    item("ghost_item", "Ghost Item"),
    item("fuel", "Fuel", { extra_uses: [{ kind: "power", id: "generator", label: "Generator fuel" }] }),
    item("herb", "Herb", { node_sources: [{ kind: "plant", id: "grow_herbs", label: "Grow Herbs" }] }),
    item("cloth", "Cloth"),
    entity({ id: "bedroom", kind: "room", display: "Barracks", source: src, links: [{ rel: "upgrade_material", kind: "item", id: "cloth" }] }),
  ];
  const f14 = runAll(ents).filter((f) => f.check === "#14");
  assert.deepEqual(f14.map((f) => f.entityRef.id), ["ghost_item"]);
  assert.equal(f14[0].severity, "info");
});

test("#15 flags items with no description and no story mention; description, quest link, lore, or story line clears it", () => {
  const ents = [
    item("described", "Described", { description: "A heavy wrench." }),
    item("quested", "Quested"),
    item("mentioned_lore", "Brass Casing"),
    item("mentioned_line", "Medkit"),
    item("silent_bolt", "Silent Bolt"),
    entity({ id: "q1", kind: "quest_step", display: "Fetch", source: src, links: [{ rel: "wants_item", kind: "item", id: "quested" }], data: { trader: "popper", task: {}, story: "Bring it." } }),
    entity({ id: "l1", kind: "lore", display: "Vibe", source: src, data: { text: "Spent brass casing littering the floor.", lore_kind: "map_vibe" } }),
    entity({ id: "ln1", kind: "line", display: "Line", source: src, data: { text: "Grab a medkit before you go.", rowClass: "story", origin: "trader_relations" } }),
    // Meta docs (lore_kind === "doc") do not count as in-game story
    entity({ id: "doc:AUDIT", kind: "lore", display: "AUDIT", source: src, data: { text: "Silent Bolt appears in audit.", lore_kind: "doc" } }),
  ];
  const f15 = runAll(ents).filter((f) => f.check === "#15");
  assert.deepEqual(f15.map((f) => f.entityRef.id), ["silent_bolt"]);
  assert.equal(f15[0].severity, "info");
});

test("buildItemIndex tracks both entity links and adapter node_sources/extra_uses", () => {
  const reg = makeRegistry([
    item("wood_plank", "Wood Plank", { node_sources: [{ kind: "camp", id: "saw_pit", label: "Saw Pit" }] }),
    entity({ id: "r1", kind: "recipe", display: "Crate", source: src, links: [{ rel: "ingredient", kind: "item", id: "wood_plank" }] }),
  ]);
  const entry = buildItemIndex(reg).get("wood_plank");
  assert.equal(entry.sources.length, 1);
  assert.equal(entry.uses.length, 1);
});
