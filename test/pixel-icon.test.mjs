import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("PixelIcon wires theme-picked 1x/@2x srcset, glyph fallback", () => {
  const src = read("src/PixelIcon.tsx");
  assert.match(src, /srcSet: `\$\{base\}\.png 1x, \$\{base\}@2x\.png 2x`/);
  assert.match(src, /\/ui\/icon-\$\{name\}-\$\{theme\}/);
  assert.match(src, /useImageOk/);
  assert.match(src, /alt=\{alt\}/);
});

test("pixel-icon CSS is pixelated and kit-pixel sized; both call sites use it", () => {
  const css = read("src/styles.css");
  assert.match(css, /\.pixel-icon \{[^}]*image-rendering: pixelated/);
  assert.match(css, /\.pixel-icon \{[^}]*calc\(var\(--u3-px\) \* 8\)/);
  assert.match(read("src/PinRail.tsx"), /<PixelIcon name="squads"/);
  assert.match(read("src/AgentPanes.tsx"), /<PixelIcon name="teams"/);
});

test("all eight icon assets exist", () => {
  for (const n of ["squads", "teams"]) for (const t of ["dark", "light"]) for (const x of ["", "@2x"])
    assert.ok(existsSync(new URL(`../public/ui/icon-${n}-${t}${x}.png`, import.meta.url)), `${n}-${t}${x}`);
});
