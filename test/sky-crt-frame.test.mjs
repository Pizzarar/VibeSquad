// C2b G5: the sky-CRT bezel is a CSS border-image driven by sky-crt.json. Stub json lives here only (no art in public/).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SKY_FRAME_URL, skyAssets, skyCrtStyle, validateSkyCrt } from "../src/skyZonesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const stub = { slice: { top: 12, right: 10, bottom: 14, left: 10 }, scale: 3 };

test("valid json → model; repeat defaults to stretch", () => {
  const r = validateSkyCrt(stub);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { slice: stub.slice, scale: 3, repeat: "stretch" });
  assert.equal(validateSkyCrt({ ...stub, repeat: "round" }).value.repeat, "round");
  assert.equal(validateSkyCrt({ ...stub, scale: 1.5 }).value.scale, 1.5);
});

test("json → style: slice + fill, border-width = slice × scale per side, repeat, pixelated", () => {
  const st = skyCrtStyle(validateSkyCrt(stub).value, "/office/sky-crt-dark.png");
  assert.equal(st.borderImageSource, "url(/office/sky-crt-dark.png)");
  assert.equal(st.borderImageSlice, "12 10 14 10 fill");
  assert.equal(st.borderWidth, "36px 30px 42px 30px");
  assert.equal(st.borderImageRepeat, "stretch");
  assert.equal(st.borderStyle, "solid");
  assert.equal(st.imageRendering, "pixelated");
  assert.equal(skyCrtStyle(validateSkyCrt({ ...stub, repeat: "round" }).value, "x.png").borderImageRepeat, "round");
});

test("invalid json is rejected", () => {
  for (const bad of [null, undefined, 5, "x", [], {}, { scale: 2 }, { slice: stub.slice }, { slice: stub.slice, scale: 0 }, { slice: stub.slice, scale: -1 }, { slice: stub.slice, scale: NaN }, { slice: stub.slice, scale: "3" },
    { slice: { ...stub.slice, top: 0 }, scale: 2 }, { slice: { ...stub.slice, left: -4 }, scale: 2 }, { slice: { ...stub.slice, right: 2.5 }, scale: 2 }, { slice: { top: 1, right: 1, bottom: 1 }, scale: 2 },
    { ...stub, repeat: "space" }]) {
    assert.equal(validateSkyCrt(bad).ok, false, JSON.stringify(bad));
  }
});

test("missing/invalid json → fallback (no frameUrl, no style); missing PNG → fallback", () => {
  const model = validateSkyCrt(stub).value;
  const none = { skyUrl: null, frameUrl: null, frameStyle: null };
  assert.deepEqual(skyAssets("dark", { sky: false, frame: true }, null), { ...none });
  assert.deepEqual(skyAssets("dark", { sky: false, frame: true }), { ...none });
  assert.deepEqual(skyAssets("dark", { sky: false, frame: false }, model), { ...none });
  const ok = skyAssets("light", { sky: true, frame: true }, model);
  assert.equal(ok.frameUrl, SKY_FRAME_URL("light"));
  assert.equal(ok.frameStyle.borderImageSource, "url(/office/sky-crt-light.png)");
  assert.equal(ok.skyUrl, "/office/sky-light.png");
});

test("wiring: no stretched <img> frame, border-image via inline style, CSS bezel stays as fallback", () => {
  const tsx = src("SkyZones.tsx");
  assert.ok(!/sky-crt-frame/.test(tsx) && !/<img/.test(tsx));
  assert.match(tsx, /style=\{frameStyle \?\? undefined\}/);
  const css = src("styles.css");
  assert.ok(!/sky-crt-frame/.test(css) && !/object-fit: fill/.test(css.slice(css.indexOf(".sky-zone {"), css.indexOf(".sky-zone {") + 3000)));
  assert.match(css, /\.sky-zone \{[^}]*border: 7px solid #272a3c/);
});

test("has-frame drops the CSS ring for every zone and theme (overlord/light rules would otherwise win)", () => {
  assert.match(src("styles.css"), /:root \.sky-zone\.has-frame, :root\[data-theme="light"\] \.sky-zone\.has-frame \{ box-shadow: none; \}/);
});
