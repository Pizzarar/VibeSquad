import test from "node:test";
import assert from "node:assert/strict";
import { crunchPaletteItems } from "../src/crunchMode.ts";
import { resolveCurrentSquad } from "../src/currentSquad.ts";
import { flashSettingTarget } from "../src/prefs.ts";

// Gemini M1 / UX R26b M1: Ctrl+K Crunch commands must never reach a Squad the user did not name.
// Mirrors CommandPalette.filterPalette (every term is a substring of label + hint) after crunchPaletteItems.
const filterPalette = (items, q) => { const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean); return items.filter((it) => terms.every((t) => `${it.label} ${it.hint}`.toLowerCase().includes(t))); };
const squads = (vsOn) => [
  { id: "efi", name: "Escape From Idle", on: false },
  { id: "vs", name: "VibeSquad", on: vsOn },
  { id: "horizon", name: "Horizon", on: false },
  { id: "rf", name: "RedFrontier", on: true },
];
const ids = (cur, q, vsOn = false) => filterPalette(crunchPaletteItems(squads(vsOn), cur, q), q).map((i) => i.id.replace("action:crunch:", ""));

const TABLE = [
  ["", ["vs"]], ["c", ["vs"]], ["cr", ["vs"]], ["crunch", ["vs"]], ["crunch o", ["vs"]], ["crunch on", ["vs"]],
  ["crunch m", ["vs"]], ["crunch e", ["vs"]], ["crunch s", ["vs"]],
  ["crunch esc", ["efi"]], // current VibeSquad does not contain "esc" so the final label filter drops it; Escape From Idle is named
  ["crunch efi", ["efi"]], ["crunch horizon", ["horizon"]],
];
for (const vsOn of [false, true]) {
  for (const [q, want] of TABLE) {
    test(`current=VibeSquad(${vsOn ? "on" : "off"}) q=${JSON.stringify(q)}`, () => {
      assert.deepEqual(ids("vs", q, vsOn), want);
    });
  }
}
test("never offers another Squad for bare/partial command words", () => {
  for (const q of ["", "c", "cr", "crunch", "crunch o", "crunch on", "crunch off", "crunch m", "crunch mode", "turn crunch on", "crunch e", "crunch s", "crunch r", "crunch h"]) {
    assert.deepEqual(ids("vs", q), ["vs"], q);
  }
});
test("current Squad is first when others also match", () => {
  const raw = crunchPaletteItems(squads(false), "vs", "efi vibe");
  assert.deepEqual(raw.map((i) => i.id), ["action:crunch:vs", "action:crunch:efi"]);
});
test("labels name the action and the state you will get", () => {
  assert.equal(crunchPaletteItems(squads(true), "vs", "")[0].label, "Turn Crunch off · VibeSquad");
  assert.equal(crunchPaletteItems(squads(false), "vs", "")[0].label, "Turn Crunch on · VibeSquad");
});
test("no current Squad: nothing for command words, a named Squad is found", () => {
  for (const q of ["", "c", "crunch", "crunch on", "crunch e", "crunch s"]) assert.deepEqual(ids(null, q), [], q);
  assert.deepEqual(ids(null, "crunch esc"), ["efi"]);
  assert.deepEqual(ids(null, "crunch efi"), ["efi"]);
  assert.deepEqual(ids(null, "crunch horizon"), ["horizon"]);
});

test("M2: Storybook target wins over the cockpit Squad, except on a bug-tester device", () => {
  assert.equal(resolveCurrentSquad("A", "B", "desktop"), "B");
  assert.equal(resolveCurrentSquad("A", null, "desktop"), "A");
  assert.equal(resolveCurrentSquad("A", "B", "bug-tester"), "A");
  assert.equal(resolveCurrentSquad(undefined, "B", null), "B");
});

test("n2: Settings jump focuses the Crunch checkbox inside the flashed row", () => {
  const log = [];
  const box = { focus: (o) => log.push(["focus", o]) };
  const row = { getAttribute: () => null, setAttribute: (k) => log.push(["set", k]), removeAttribute() {}, click() {}, scrollIntoView: () => log.push(["scroll"]), querySelector: (s) => (s === "[data-crunch-check]" ? box : null) };
  assert.equal(flashSettingTarget({ querySelector: () => row }, "crunch-mode", 1), true);
  assert.deepEqual(log.map((l) => l[0]), ["scroll", "focus", "set"]);
  // a row without the checkbox (every other setting) is untouched
  const plain = { ...row, querySelector: () => null };
  assert.equal(flashSettingTarget({ querySelector: () => plain }, "lan", 1), true);
});
