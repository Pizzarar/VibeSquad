// C2b G6: big faces filling the sky zones, Overlord expands over Riff (Riff scared), faces.json `scared`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { OVERLORD_EXPAND_PCT, faceBg, faceContain, hasFaceMode, riffMinWidth, skyColumns, skyLayout } from "../src/skyZonesLogic.ts";
import { faceFrame, validateFaces } from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const base = { overlordLive: true, overlordFocused: false, overlordTalking: false, riffFocused: false, riffHasScared: true };

test("at rest: 50/50, Riff plays its normal faces (no forced mode)", () => {
  assert.deepEqual(skyLayout(base), { expanded: false, widths: { riffbot: 50, overlord: 50 }, riffMode: null });
});

test("Overlord focused → 70/30 and Riff scared", () => {
  const l = skyLayout({ ...base, overlordFocused: true });
  assert.equal(OVERLORD_EXPAND_PCT, 70);
  assert.deepEqual(l, { expanded: true, widths: { riffbot: 30, overlord: 70 }, riffMode: "scared" });
});

test("Overlord talking (running) → expands too; focus on Riff keeps 50/50 so Riff stays usable", () => {
  assert.equal(skyLayout({ ...base, overlordTalking: true }).expanded, true);
  assert.equal(skyLayout({ ...base, overlordTalking: true, riffFocused: true }).expanded, false);
  assert.equal(skyLayout({ ...base, overlordTalking: true, overlordFocused: true, riffFocused: false }).expanded, true);
});

test("scared absent from faces.json → the squeezed Riff plays idle", () => {
  const l = skyLayout({ ...base, overlordFocused: true, riffHasScared: false });
  assert.equal(l.expanded, true);
  assert.equal(l.riffMode, "idle");
});

test("no Overlord → never expands, whatever else is true", () => {
  for (const f of [{}, { overlordFocused: true }, { overlordTalking: true }, { overlordFocused: true, overlordTalking: true }]) {
    assert.deepEqual(skyLayout({ ...base, overlordLive: false, ...f }), { expanded: false, widths: { riffbot: 50, overlord: 50 }, riffMode: null });
  }
});

test("RiffBot active (focused or talking) never expands Riff over the Overlord", () => {
  const l = skyLayout({ ...base, riffFocused: true });
  assert.equal(l.expanded, false);
  assert.ok(l.widths.riffbot <= l.widths.overlord);
});

test("faceContain: integer scale, whole cell fits (never cropped), centred sideways, anchored to the bottom", () => {
  const cell = { w: 48, h: 48 };
  assert.deepEqual(faceContain(cell, { w: 700, h: 400 }), { k: 8, left: 158, top: 16 }); // wide box: height decides, side gutters, slack (16) at the top
  assert.deepEqual(faceContain(cell, { w: 200, h: 500 }), { k: 4, left: 4, top: 308 }); // squeezed/tall: width decides, the gap is at the TOP only
  assert.deepEqual(faceContain(cell, { w: 480, h: 480 }), { k: 10, left: 0, top: 0 }); // square
  assert.deepEqual(faceContain({ w: 128, h: 96 }, { w: 500, h: 300 }), { k: 3, left: 58, top: 12 }); // cell from faces.json, never hardcoded
  assert.equal(faceContain(cell, { w: 0, h: 0 }).k, 0); // not measured yet
  assert.equal(faceContain(cell, { w: 30, h: 30 }).k, 1); // smaller than one cell: min 1 (the only crop case)
  for (const box of [{ w: 700, h: 400 }, { w: 200, h: 500 }, { w: 560, h: 497 }, { w: 1306, h: 497 }, { w: 96, h: 96 }, { w: 143, h: 400 }]) {
    const c = faceContain(cell, box);
    assert.ok(Number.isInteger(c.k) && Number.isInteger(c.left) && Number.isInteger(c.top));
    assert.ok(c.left >= 0 && c.top >= 0 && c.left + cell.w * c.k <= box.w && c.top + cell.h * c.k <= box.h, `face fits inside ${JSON.stringify(box)}`);
  }
});

test("faceContain bottom anchoring: the face's bottom edge is the box's bottom edge, never a gap below", () => {
  const cell = { w: 48, h: 48 };
  for (const box of [{ w: 700, h: 400 }, { w: 1306, h: 497 }, { w: 560, h: 497 }, { w: 368, h: 497 }, { w: 216, h: 497 }, { w: 143, h: 400 }, { w: 480, h: 481 }, { w: 481, h: 999 }]) {
    const c = faceContain(cell, box);
    assert.equal(c.top + cell.h * c.k, box.h, `no gap below at ${JSON.stringify(box)}`);
  }
  // Height-driven (normal) case: the slack at the top is under one scale step.
  const c = faceContain(cell, { w: 1306, h: 497 });
  assert.ok(c.top >= 0 && c.top < cell.h);
  // Width-forced (squeezed Riff): the gap goes to the top, larger than a step, still nothing below.
  const sq = faceContain(cell, { w: 100, h: 497 });
  assert.equal(sq.k, 2);
  assert.ok(sq.top > cell.h);
  assert.equal(sq.top + cell.h * sq.k, 497);
});

// ── faces.json `scared` ──
const frames = (...xs) => xs.map((x) => ({ x, y: 0 }));
const faces = (extra = {}) => ({
  cell: { w: 48, h: 48 },
  fps: 3,
  riffbot: { idle: frames(0), ...extra },
  overlord: { idle: frames(0) },
});

test("validateFaces: scared is optional and parsed when present", () => {
  const without = validateFaces(faces());
  assert.equal(without.ok, true);
  assert.equal(hasFaceMode(without.value, "riffbot", "scared"), false);
  const withS = validateFaces(faces({ scared: frames(48, 96) }));
  assert.equal(withS.ok, true);
  assert.equal(hasFaceMode(withS.value, "riffbot", "scared"), true);
  assert.deepEqual(faceFrame(withS.value, "riffbot", "scared", 1), { x: 96, y: 0 });
  assert.deepEqual(faceFrame(without.value, "riffbot", "scared", 1), { x: 0, y: 0 }); // missing mode → idle
  assert.equal(hasFaceMode(null, "riffbot", "scared"), false);
});

test("validateFaces: idle stays required, an unknown extra mode is ignored, a malformed scared is rejected", () => {
  assert.equal(validateFaces({ ...faces(), riffbot: { scared: frames(0) } }).ok, false);
  const extra = validateFaces(faces({ scared: frames(0), wobble: frames(5) }));
  assert.equal(extra.ok, true);
  assert.equal("wobble" in extra.value.bots.riffbot, false);
  assert.equal(validateFaces(faces({ scared: [] })).ok, false);
});

test("wiring: the face is a zone background, the thumbnail is gone, Riff gets the forced mode, no new loader", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("faceContain(cell, box)") && !sky.includes("faceCover"));
  assert.ok(!sky.includes("sky-face-box") && !sky.includes("sky-crt-head"));
  assert.ok(sky.includes("force={layout.riffMode}"));
  assert.ok(sky.includes("skyLayout({"));
  assert.equal((sky.match(/<DrawerSlot/g) || []).length, 1); // sky bots still mounted once
  assert.ok(src("useBotFace.ts").includes("force ?? ("));
  const css = src("styles.css");
  assert.ok(/\.sky-zones \{[^}]*transition: grid-template-columns/.test(css));
  assert.ok(/prefers-reduced-motion: reduce\) \{\s*\.sky-zones,[^}]*transition: none/.test(css));
  assert.ok(/--sky-cols/.test(css));
});

test("a11y: squeezed Riff is tabbable, labelled, and Enter/Space/focus hand the sky back (riffFocused → 50/50)", () => {
  // The pure side: once Riff is focused, even a talking Overlord no longer expands.
  assert.equal(skyLayout({ ...base, overlordFocused: true }).expanded, true);
  assert.equal(skyLayout({ ...base, overlordTalking: true, riffFocused: true }).expanded, false);
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("tabIndex={onReclaim ? (squeezed ? 0 : -1) : undefined}"));
  assert.ok(sky.includes("press to expand"));
  assert.ok(sky.includes("squeezed && e.target === e.currentTarget && onReclaim?.()")); // focus
  assert.ok(sky.includes('e.key === "Enter" || e.key === " "')); // Enter / Space
  assert.ok(sky.includes('setFocus("riffbot")'));
  assert.ok(sky.includes("squeezed={layout.expanded} onReclaim={reclaimRiff}"));
  assert.ok(!sky.includes("onReclaim={reclaimRiff}") || !/<Zone zone=\{zones\.overlord\}[^>]*onReclaim/.test(sky)); // Overlord never gets it
});

// ── G6-fix2: gutter colour + Riff's minimum strip ──
test("faces.json bg: {dark, light} per bot, both valid → used per theme; any other shape → whole field ignored (CSS variable)", () => {
  const bg = { dark: "#2a1b6b", light: "#95d3f2" };
  const ok = validateFaces({ ...faces(), riffbot: { idle: frames(0), bg }, overlord: { idle: frames(0), bg: { dark: "rgb(20, 30, 40)", light: "#fff" } } });
  assert.equal(ok.ok, true);
  assert.equal(faceBg(ok.value, "riffbot", "dark"), "#2a1b6b");
  assert.equal(faceBg(ok.value, "riffbot", "light"), "#95d3f2");
  assert.equal(faceBg(ok.value, "overlord", "dark"), "rgb(20, 30, 40)");
  assert.equal(faceBg(ok.value, "overlord", "light"), "#fff");
  const bad = [
    "#2a1b6b", // the old plain-string form is dropped
    { dark: "#2a1b6b" }, // a key missing
    { light: "#95d3f2" },
    { dark: "#2a1b6b", light: "url(x)" }, // one invalid → the whole field is invalid
    { dark: "red; x:y", light: "#95d3f2" },
    { dark: 5, light: "#95d3f2" },
    { dark: "#12", light: "#95d3f2" },
    {}, [], null, 5,
  ];
  for (const b of bad) {
    const v = validateFaces({ ...faces(), riffbot: { idle: frames(0), bg: b } });
    assert.equal(v.ok, true, `invalid bg ${JSON.stringify(b)} must not reject the file`);
    for (const t of ["dark", "light"]) assert.equal(faceBg(v.value, "riffbot", t), null);
  }
  assert.equal(faceBg(validateFaces(faces()).value, "riffbot", "dark"), null);
  assert.equal(faceBg(null, "riffbot", "light"), null);
  const css = src("styles.css");
  assert.ok(/--sky-face-bg-dark: #[0-9a-f]{6}/i.test(css) && /--sky-face-bg-light: #[0-9a-f]{6}/i.test(css));
  assert.ok(css.includes("var(--sky-face-bg-custom, var(--sky-face-bg-dark))"));
  assert.ok(src("SkyZones.tsx").includes("--sky-face-bg-custom") && src("SkyZones.tsx").includes("faceBg(faces, zone.bot, theme)"));
});

test("Riff's squeezed strip keeps two whole cells + bezel; at a 1280 hub the scared face is still scale >= 2", () => {
  const cell = { w: 48 };
  const bezel = (20 + 20) * 3; // sky-crt.json left+right × scale
  assert.equal(riffMinWidth(cell, bezel), 216);
  const exp = skyLayout({ ...base, overlordFocused: true });
  assert.equal(skyColumns(exp, cell, bezel), "minmax(216px, 30fr) minmax(0, 70fr)");
  assert.equal(skyColumns(skyLayout(base), cell, bezel), "minmax(0px, 50fr) minmax(0, 50fr)"); // at rest: plain 50/50
  // Narrow hub column (1280 viewport minus rail/sidebar ≈ 760): 30% is a sliver, the floor wins and the face still gets k >= 2.
  for (const hub of [760, 900, 1280]) {
    const riff = Math.max(Math.round((hub - 36) * 0.3), riffMinWidth(cell, bezel));
    assert.ok(riff >= 216);
    assert.ok(faceContain({ w: 48, h: 48 }, { w: riff - bezel, h: 400 }).k >= 2, `k>=2 at hub ${hub}`);
  }
});
