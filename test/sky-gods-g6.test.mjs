// C2b G6: big faces filling the sky zones, Overlord expands over Riff (Riff scared), faces.json `scared`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { OVERLORD_EXPAND_PCT, faceCover, hasFaceMode, skyLayout } from "../src/skyZonesLogic.ts";
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

test("faceCover: integer scale covers the box, centred, cropped evenly, whole-px offsets", () => {
  const c = faceCover({ w: 48, h: 48 }, { w: 700, h: 400 });
  assert.deepEqual(c, { k: 15, left: -10, top: -160 }); // 720x720 over 700x400
  assert.ok(Number.isInteger(c.k) && Number.isInteger(c.left) && Number.isInteger(c.top));
  assert.deepEqual(faceCover({ w: 48, h: 48 }, { w: 48, h: 48 }), { k: 1, left: 0, top: 0 });
  assert.deepEqual(faceCover({ w: 128, h: 96 }, { w: 500, h: 300 }), { k: 4, left: -6, top: -42 }); // cell from faces.json, never hardcoded
  assert.equal(faceCover({ w: 48, h: 48 }, { w: 0, h: 0 }).k, 0); // not measured yet
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
  assert.ok(sky.includes("faceCover(cell, box)"));
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
