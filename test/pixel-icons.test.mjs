// Portrait painter: the props and propless casts both render, and the toggle stays a 1-liner.
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

test("SHIP_PROPLESS is a single boolean toggle", () => {
  assert.equal(typeof SHIP_PROPLESS, "boolean");
  assert.match(src, /^export const SHIP_PROPLESS = (true|false);$/m);
});

test("every archetype paints a full 28x28 sprite in both variants", () => {
  for (const t of TYPES)
    for (const propless of [false, true]) {
      const px = paintPixels(`t-${t}`, t, NEON, 0, propless);
      assert.equal(px.length, S * S);
      assert.ok(px.filter(Boolean).length > 300, `${t} propless=${propless} too sparse`);
    }
});

test("propless differs from props for every archetype that holds a prop", () => {
  for (const t of TYPES.filter((t) => t !== "unknown")) {
    const a = paintPixels(`t-${t}`, t, NEON, 0, false).join();
    const b = paintPixels(`t-${t}`, t, NEON, 0, true).join();
    assert.notEqual(a, b, t);
  }
});

test("default variant follows SHIP_PROPLESS", () => {
  assert.equal(paintPixels("x", "spec", NEON).join(), paintPixels("x", "spec", NEON, undefined, SHIP_PROPLESS).join());
});

test("implement and mechanical torsos are dominated by different colours", () => {
  const dominant = (t, propless) => {
    const n = new Map();
    for (const c of paintPixels(`t-${t}`, t, NEON, 0, propless).slice(23 * S).filter(Boolean)) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0][0];
  };
  for (const propless of [false, true]) assert.notEqual(dominant("implement", propless), dominant("mechanical", propless));
});
