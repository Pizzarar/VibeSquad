import test from "node:test";
import assert from "node:assert/strict";
import { crunchPaletteItems } from "../src/crunchMode.ts";

const filterPalette = (items, q) => { const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean); return items.filter((it) => terms.every((t) => `${it.label} ${it.hint}`.toLowerCase().includes(t))); }; // mirrors CommandPalette.filterPalette

// UX R26b M1: Ctrl+K "crunch" + Enter must act on the CURRENT Squad, never the first in sidebar order.
const squads = [
  { id: "escape", name: "Escape From Idle", on: false },
  { id: "vs", name: "VibeSquad", on: true },
  { id: "efi", name: "EFI", on: false },
];
const pick = (cur, q) => filterPalette(crunchPaletteItems(squads, cur, q), q).map((i) => i.id);

test("bare 'crunch' offers only the current Squad, as the first row", () => {
  assert.deepEqual(pick("vs", "crunch"), ["action:crunch:vs"]);
  assert.deepEqual(pick("vs", ""), ["action:crunch:vs"]);
});
test("label names the action and the state you will get", () => {
  assert.equal(crunchPaletteItems(squads, "vs", "")[0].label, "Turn Crunch off · VibeSquad");
  assert.equal(crunchPaletteItems(squads, "efi", "")[0].label, "Turn Crunch on · EFI");
});
test("other Squads appear only when the query also matches their name", () => {
  assert.deepEqual(pick("vs", "crunch escape"), ["action:crunch:escape"]);
  assert.deepEqual(pick("vs", "crunch efi"), ["action:crunch:efi"]);
  assert.ok(!pick("vs", "crunch").includes("action:crunch:escape"));
});
test("no current Squad: nothing for bare 'crunch', a typed name still finds its command", () => {
  assert.deepEqual(pick(null, "crunch"), []);
  assert.deepEqual(pick(null, "crunch idle"), ["action:crunch:escape"]);
});
