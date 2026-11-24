import { test } from "node:test";
import assert from "node:assert/strict";
import { KINDS, RESERVED_KINDS, ALL_KINDS, validateEntity, validateFinding, validateSnapshot, makeRegistry, makeSnapshot, entity } from "../server/storybook/schema.mjs";

const src = { path: "data/x.json", line: 3 };
const mk = (o) => entity({ source: src, ...o });

test("v1 + reserved kinds", () => {
  assert.deepEqual(Object.keys(KINDS), ["trader", "squad", "enemy", "location", "room", "item", "skill", "contract", "recipe", "quest_step", "line", "voice_card", "lore"]);
  assert.deepEqual([...RESERVED_KINDS], ["faction", "dialogue_node", "dialogue_choice", "cutscene", "ability", "art_slot", "audio_cue", "map_graph"]);
  assert.equal(ALL_KINDS.length, 21);
});

test("validateEntity: good, bad, reserved must be empty", () => {
  assert.equal(validateEntity(mk({ id: "scav", kind: "enemy", display: "Scav", data: { boss: false } })).ok, true);
  const bad = validateEntity({ id: "", kind: "wat", display: 3, aliases: "x", source: { path: "" }, links: [{ rel: "r" }], production: "done", data: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 7);
  assert.match(validateEntity(mk({ id: "scav", kind: "enemy", display: "Scav" })).errors.join(), /missing "boss"/);
  assert.equal(validateEntity(mk({ id: "f1", kind: "faction", display: "F" })).ok, true);
  assert.equal(validateEntity(mk({ id: "f1", kind: "faction", display: "F", data: { x: 1 } })).ok, false);
  assert.equal(validateEntity(mk({ id: "a", kind: "item", display: "A", production: "final" })).ok, true);
  assert.equal(validateEntity({ ...mk({ id: "a", kind: "item", display: "A" }), source: { path: "p", line: null } }).ok, true);
});

test("registry: identity is (kind,id): doc is trader AND squad", () => {
  const trader = mk({ id: "doc", kind: "trader", display: "Doc", aliases: ["doc"] });
  const squad = mk({ id: "doc", kind: "squad", display: "Saint", aliases: ["doc", "Reyes"] });
  const reg = makeRegistry([trader, squad]);
  assert.equal(reg.duplicates.length, 0);
  assert.equal(reg.get("trader", "doc"), trader);
  assert.equal(reg.get("squad", "doc"), squad);
  assert.equal(reg.get("enemy", "doc"), null);
  assert.deepEqual(reg.sameId("doc").map((e) => e.kind).sort(), ["squad", "trader"]);
  assert.deepEqual(reg.findByName("SAINT").map((e) => e.kind), ["squad"]);
  assert.equal(reg.findByName("doc").length, 2);
  assert.equal(reg.findByName("reyes")[0], squad);
  assert.deepEqual(reg.counts(), { trader: 1, squad: 1 });
  // a true (kind,id) duplicate is recorded, first wins
  const dup = mk({ id: "doc", kind: "trader", display: "Other" });
  reg.add(dup);
  assert.equal(reg.duplicates[0], dup);
  assert.equal(reg.get("trader", "doc"), trader);
  assert.equal(reg.resolve({ kind: "squad", id: "doc" }), squad);
});

test("alias lookup spans kinds (Heavy Trooper / exo_trooper)", () => {
  const e = mk({ id: "exo_trooper", kind: "enemy", display: "Heavy Trooper", aliases: ["exo_trooper"], data: { boss: false } });
  const reg = makeRegistry([e]);
  assert.equal(reg.findByName("heavy trooper")[0], e);
  assert.equal(reg.findByName("exo_trooper")[0], e);
});

test("validateFinding shape", () => {
  const ok = { check: "#1", severity: "error", entityRef: { kind: "quest_step", id: "x_1" }, msg: "dangling", source: src };
  assert.equal(validateFinding(ok).ok, true);
  assert.equal(validateFinding({ ...ok, entityRef: null, source: null }).ok, true);
  assert.equal(validateFinding({ ...ok, check: "#13" }).ok, false);
  assert.equal(validateFinding({ ...ok, severity: "fatal" }).ok, false);
  assert.equal(validateFinding({ ...ok, msg: "" }).ok, false);
  assert.equal(validateFinding({ ...ok, entityRef: { kind: "item", id: "" } }).ok, false);
  assert.equal(validateFinding({ ...ok, entityRef: { kind: "", id: "x" } }).ok, false);
});

test("validateSnapshot: good, duplicate (kind,id), bad finding, bad version", () => {
  const e = mk({ id: "scav", kind: "enemy", display: "Scav", data: { boss: false } });
  const snap = makeSnapshot({ project: "p", ref: "origin/main", sha: "abcdef1234", entities: [e], generatedAt: "2026-01-01T00:00:00Z" });
  assert.equal(validateSnapshot(snap).ok, true);
  assert.equal(snap.schemaVersion, 1);
  assert.match(validateSnapshot({ ...snap, entities: [e, e] }).errors.join(), /duplicate/);
  assert.match(validateSnapshot({ ...snap, findings: [{ check: "x" }] }).errors.join(), /findings\[0\]/);
  assert.equal(validateSnapshot({ ...snap, schemaVersion: 2 }).ok, false);
  assert.equal(validateSnapshot({ ...snap, sha: "zzz" }).ok, false);
  assert.equal(validateSnapshot(null).ok, false);
});
