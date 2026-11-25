// F1: Shared Entity Registry. Kind table (one file per kind), extension by a test-only dummy kind, studio IDs,
// per-slot production, cross-lane links, and the Storybook re-export staying the same objects.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as reg from "../server/registry/index.mjs";
import * as sb from "../server/storybook/schema.mjs";

const { KIND_TABLE, DEFAULT_KINDS_DIR, loadKindTable, buildKindTable, makeSchema, studioId, parseStudioId, isStudioId, entityStudioId, linkStudioId, entity } = reg;
const src = { path: "data/x.json", line: 3 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-f1-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("default kind table: one file per kind, SB1 order, v1 + reserved", () => {
  const files = fs.readdirSync(DEFAULT_KINDS_DIR).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(files, [...KIND_TABLE.ALL_KINDS].sort());
  assert.deepEqual(Object.keys(reg.KINDS), ["trader", "squad", "enemy", "location", "room", "item", "skill", "contract", "recipe", "quest_step", "line", "voice_card", "lore", "art_slot"]);
  assert.deepEqual([...reg.RESERVED_KINDS], ["faction", "dialogue_node", "dialogue_choice", "cutscene", "ability", "audio_cue", "map_graph"]);
  for (const d of KIND_TABLE.defs) {
    assert.ok(Object.isFrozen(d) && d.slots.length >= 1, d.kind);
    assert.equal(d.lane, d.reserved ? null : "storybook", d.kind);
  }
});

test("storybook schema.mjs re-exports the registry (same objects, every SB1 name)", () => {
  for (const k of ["SCHEMA_VERSION", "KINDS", "RESERVED_KINDS", "ALL_KINDS", "PRODUCTION_STATES", "SEVERITIES", "CHECK_IDS", "validateEntity", "validateFinding", "validateSnapshot", "entityKey", "makeRegistry", "makeSnapshot", "entity"]) {
    assert.ok(k in sb, k);
    assert.equal(sb[k], reg[k], k);
  }
});

test("extension: a dummy kind file added in the test only shows up in the table", async () => {
  const dir = path.join(tmp, "kinds");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "dummy_widget.mjs"), 'export default { kind: "dummy_widget", label: "Dummy widget", order: 500, reserved: false, lane: "test-lane", required: ["size"], slots: ["text", "icon"] };\n');
  const ext = await loadKindTable([DEFAULT_KINDS_DIR, dir]);
  // dummy_widget (order 500) sorts between the v1 kinds (order <= 130) and art_slot (order 1060)
  assert.deepEqual(ext.ALL_KINDS, [...Object.keys(reg.KINDS).slice(0, -1), "dummy_widget", "art_slot", ...reg.RESERVED_KINDS]);
  assert.deepEqual(ext.KINDS.dummy_widget, { label: "Dummy widget", required: ["size"] });
  assert.equal(ext.byKind.get("dummy_widget").lane, "test-lane");
  // the default table (and so Storybook) never sees it
  assert.equal(KIND_TABLE.ALL_KINDS.includes("dummy_widget"), false);
  assert.equal(reg.ALL_KINDS.length, 21);
  // validators bound to the extended table know the new kind and its required data
  const s = makeSchema(ext);
  const w = entity({ id: "w1", kind: "dummy_widget", display: "W", source: src, data: { size: 2 } });
  assert.deepEqual(s.validateEntity(w), { ok: true, errors: [] });
  assert.match(s.validateEntity({ ...w, data: {} }).errors.join(), /missing "size"/);
  assert.match(reg.validateEntity(w).errors.join(), /unknown kind "dummy_widget"/);
  assert.equal(s.productionOf({ ...w, productionSlots: { icon: "ai-draft" } }, "icon"), "ai-draft");
  // link from storybook trader to the dummy kind crosses lanes
  const t = entity({ id: "doc", kind: "trader", display: "Doc", source: src, links: [{ rel: "owns", kind: "dummy_widget", id: "w1" }, { rel: "sells", kind: "item", id: "bandage" }] });
  assert.deepEqual(s.crossLaneLinks(t).map((l) => l.kind), ["dummy_widget"]);
});

test("kind table rejects malformed or duplicate kinds and misnamed files", async () => {
  const good = { kind: "x", label: "X", order: 1, reserved: false, lane: null, required: [], slots: ["text"] };
  assert.throws(() => buildKindTable([good, good]), /defined twice/);
  assert.throws(() => buildKindTable([{ ...good, kind: "Bad-Kind" }]), /kind must match/);
  assert.throws(() => buildKindTable([{ ...good, slots: [] }]), /slots/);
  assert.throws(() => buildKindTable([{ ...good, reserved: true, required: ["a"] }]), /reserved kind cannot require/);
  assert.throws(() => buildKindTable([{ ...good, lane: "" }]), /lane/);
  const dir = path.join(tmp, "misnamed");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "foo.mjs"), 'export default { kind: "bar", label: "Bar", order: 1, reserved: false, lane: null, required: [], slots: ["text"] };\n');
  await assert.rejects(loadKindTable([dir]), /default export kind must be "foo"/);
  const dupDir = path.join(tmp, "dup");
  fs.mkdirSync(dupDir);
  fs.writeFileSync(path.join(dupDir, "trader.mjs"), 'export default { kind: "trader", label: "T2", order: 1, reserved: false, lane: null, required: [], slots: ["text"] };\n');
  await assert.rejects(loadKindTable([DEFAULT_KINDS_DIR, dupDir]), /trader: defined twice/);
});

test("studio IDs: <project>:<kind>:<id>, ids with colons round-trip, malformed rejected", () => {
  assert.equal(studioId("efi", "trader", "doc"), "efi:trader:doc");
  assert.notEqual(studioId("efi", "trader", "doc"), studioId("efi", "squad", "doc")); // identity is (project,kind,id)
  assert.deepEqual(parseStudioId("efi:line:rel:doc:friendly"), { project: "efi", kind: "line", id: "rel:doc:friendly" });
  assert.equal(studioId("efi", "line", "rel:doc:friendly"), "efi:line:rel:doc:friendly");
  for (const bad of ["", "efi", "efi:trader", "efi:trader:", "EFI:trader:doc", ":trader:doc", "efi:Trader:doc", "efi::doc", null, 7]) assert.equal(parseStudioId(bad), null, String(bad));
  assert.equal(isStudioId("efi:dummy:x"), true);
  assert.equal(isStudioId("efi:dummy:x", reg.ALL_KINDS), false);
  assert.throws(() => studioId("efi", "trader", ""), TypeError);
  assert.throws(() => studioId("e fi", "trader", "doc"), TypeError);
  const e = entity({ id: "scav", kind: "enemy", display: "Scav", source: src, data: { boss: false } });
  assert.equal(entityStudioId("efi", e), "efi:enemy:scav");
  assert.equal(linkStudioId("efi", { rel: "spawns", kind: "enemy", id: "scav" }), "efi:enemy:scav");
  assert.equal(linkStudioId("efi", { rel: "sequel", kind: "trader", id: "doc", project: "efi2" }), "efi2:trader:doc");
});

test("production per slot: primary slot falls back to `production`; bad slots/states fail validation", () => {
  const e = entity({ id: "doc", kind: "trader", display: "Doc", source: src, production: "placeholder" });
  assert.equal(reg.productionOf(e, "text"), "placeholder"); // text is the trader's primary slot
  assert.equal(reg.productionOf(e, "portrait"), null);
  assert.equal(reg.productionOf(e, "nope"), null);
  const slotted = { ...e, productionSlots: { portrait: "ai-draft", voice: "missing", text: "final" } };
  assert.deepEqual(reg.validateEntity(slotted), { ok: true, errors: [] });
  assert.equal(reg.productionOf(slotted, "portrait"), "ai-draft");
  assert.equal(reg.productionOf(slotted, "text"), "final");
  assert.match(reg.validateEntity({ ...e, productionSlots: { icon: "final" } }).errors.join(), /trader has no such slot/);
  assert.match(reg.validateEntity({ ...e, productionSlots: { portrait: "done" } }).errors.join(), /productionSlots.portrait must be/);
  assert.match(reg.validateEntity({ ...e, productionSlots: [] }).errors.join(), /productionSlots must be an object/);
  // entity() never adds productionSlots, so SB1 snapshots are unchanged
  assert.equal("productionSlots" in e, false);
});

test("cross-lane / cross-project links", () => {
  const t = entity({ id: "doc", kind: "trader", display: "Doc", source: src, links: [
    { rel: "sells", kind: "item", id: "bandage" },
    { rel: "member_of", kind: "faction", id: "traders_union" },
    { rel: "sequel", kind: "trader", id: "doc", project: "efi2" },
  ] });
  assert.deepEqual(reg.validateEntity(t), { ok: true, errors: [] });
  assert.deepEqual(reg.crossLaneLinks(t).map((l) => l.rel), ["member_of", "sequel"]);
  assert.match(reg.validateEntity({ ...t, links: [{ rel: "x", kind: "item", id: "a", project: "Bad Key" }] }).errors.join(), /links\[0\]\.project/);
});
