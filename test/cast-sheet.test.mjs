// Cast sheet wiring: role -> row mapping and seed -> variant determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const tmp = join(mkdtempSync(join(tmpdir(), "vs-cast-")), "cast.mjs");
writeFileSync(tmp, transformSync("cast.ts", readFileSync(join(root, "src", "cast.ts"), "utf8"), { lang: "ts" }).code);
const { CAST_ROWS, CAST_VARIANTS, castRow, castVariant, castCell } = await import(pathToFileURL(tmp).href);

const ORDER = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];

test("roles map to sheet rows in sheet order", () => {
  assert.deepEqual(CAST_ROWS, ORDER);
  ORDER.forEach((t, i) => assert.equal(castRow(t), i));
});

test("unrecognised roles use the unknown row", () => {
  for (const t of [undefined, "", "wizard", "Lead"]) assert.equal(castRow(t), 9);
});

test("seed picks a stable variant column", () => {
  for (const id of ["a", "agent-1", "b9f2", "ünï"]) {
    const v = castVariant(id);
    assert.ok(v >= 0 && v < CAST_VARIANTS);
    assert.equal(castVariant(id), v);
  }
  const seen = new Set(Array.from({ length: 64 }, (_, i) => castVariant(`agent-${i}`)));
  assert.equal(seen.size, CAST_VARIANTS);
});

test("explicit variant ordinal wins and wraps", () => {
  assert.equal(castVariant("x", 2), 2);
  assert.equal(castVariant("x", 5), 1);
  assert.equal(castVariant("x", -1), 3);
});

test("cell is the top-left of the 32px cell", () => {
  assert.deepEqual(castCell("x", "review", 3), { x: 96, y: 160 });
});

test("public/cast.png is a 128x320 PNG", () => {
  const b = readFileSync(join(root, "public", "cast.png"));
  assert.equal(b.readUInt32BE(16), 128);
  assert.equal(b.readUInt32BE(20), 320);
  assert.ok(statSync(join(root, "public", "cast.png")).size > 0);
});
