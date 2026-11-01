// Portrait painter: propless cast is the only cast; held props are retired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const src = readFileSync(join(root, "src", "pixel.tsx"), "utf8");
const tmp = join(mkdtempSync(join(tmpdir(), "vs-pixel-")), "pixel.mjs");
writeFileSync(tmp, transformSync("pixel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } }).code);
const { paintPixels, SHIP_PROPLESS, S } = await import(pathToFileURL(tmp).href);

const TYPES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];
const NEON = "#ff9a3c";

test("SHIP_PROPLESS is true", () => {
  assert.equal(SHIP_PROPLESS, true);
  assert.match(src, /^export const SHIP_PROPLESS = true;$/m);
});

test("every archetype paints a full 28x28 sprite", () => {
  for (const t of TYPES) {
    const px = paintPixels(`t-${t}`, t, NEON, 0);
    assert.equal(px.length, S * S);
    assert.ok(px.filter(Boolean).length > 300, `${t} too sparse`);
  }
});

test("implement and mechanical torsos are dominated by different colours", () => {
  const dominant = (t) => {
    const n = new Map();
    for (const c of paintPixels(`t-${t}`, t, NEON, 0).slice(23 * S).filter(Boolean)) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0][0];
  };
  assert.notEqual(dominant("implement"), dominant("mechanical"));
});

test("retired-lead and review do not share monocle/loupe eye pixels", () => {
  const eyeRegion = (t) => {
    const px = paintPixels(`t-${t}`, t, NEON, 0);
    const pixels = [];
    for (let y = 9; y <= 15; y++)
      for (let x = 16; x <= 21; x++) pixels.push(px[y * S + x]);
    return pixels;
  };
  const retiredEye = eyeRegion("retired-lead");
  const reviewEye = eyeRegion("review");
  // The retired-lead has a gold monocle; review has no face gear.
  // They must not produce the same pixel pattern in the monocle zone.
  assert.notDeepEqual(retiredEye, reviewEye, "retired-lead and review share monocle eye pixels");
});
