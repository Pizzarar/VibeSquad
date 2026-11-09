import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { paletteWindow, PALETTE_COMPACT } from "../src/paletteWindow.ts";

const ROOT = resolve(import.meta.dirname, "..");
const items = Array.from({ length: 40 }, (_, i) => i);

test("empty query shows the top 12 plus a Show-all row for the rest", () => {
  const w = paletteWindow(items, "", false);
  assert.equal(w.rows.length, PALETTE_COMPACT);
  assert.equal(w.hidden, 28);
  assert.equal(w.count, 13);
  assert.equal(paletteWindow(items, "   ", false).rows.length, PALETTE_COMPACT);
});

test("expanding or typing shows everything (capped at 60), no Show-all row", () => {
  assert.equal(paletteWindow(items, "", true).rows.length, 40);
  const t = paletteWindow(items, "a", false);
  assert.equal(t.rows.length, 40);
  assert.equal(t.hidden, 0);
  assert.equal(t.count, 40);
  assert.equal(paletteWindow(Array.from({ length: 90 }, (_, i) => i), "x", false).rows.length, 60);
});

test("short lists never get a Show-all row", () => {
  const w = paletteWindow([1, 2, 3], "", false);
  assert.deepEqual([w.rows.length, w.hidden, w.count], [3, 0, 3]);
});

test("CommandPalette wires Show all into arrow nav and Enter", () => {
  const src = fs.readFileSync(resolve(ROOT, "src/CommandPalette.tsx"), "utf8");
  assert.match(src, /paletteWindow\(/);
  assert.match(src, /data-testid="command-palette-show-all"/);
  assert.match(src, /setSel\(\(s\) => Math\.min\(win\.count - 1, s \+ 1\)\)/);
});
