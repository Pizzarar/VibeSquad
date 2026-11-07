// C2b G7: virus takeover overlay. json parse, fallback when absent, reduced-motion skip, reverse (incl. mid-play). Stub json only (no art in public/).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  TAKEOVER_FALLBACK,
  TAKEOVER_FALLBACK_MS,
  TAKEOVER_URL,
  takeoverAdvance,
  takeoverDurationMs,
  takeoverFrameAt,
  takeoverSettled,
  takeoverVisible,
  validateTakeover,
} from "../src/skyZonesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const objs = Array.from({ length: 8 }, (_, i) => ({ x: i * 48, y: 0 }));
const stub = { version: 1, cell: { w: 48, h: 48 }, fps: 13, frames: objs };

test("json → frames + duration (8 frames @ 13fps ≈ 615ms)", () => {
  const r = validateTakeover(stub);
  assert.ok(r.ok);
  assert.deepEqual(r.value.cell, { w: 48, h: 48 });
  assert.equal(r.value.frames.length, 8);
  assert.deepEqual(r.value.frames[7], { x: 336, y: 0 });
  assert.equal(Math.round(takeoverDurationMs(r.value)), 615);
  assert.equal(TAKEOVER_FALLBACK_MS, 615);
});

test("frames accept {x,y} objects and bare numbers (= x, y 0)", () => {
  const r = validateTakeover({ ...stub, frames: [0, { x: 48, y: 48 }, 96] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.frames, [{ x: 0, y: 0 }, { x: 48, y: 48 }, { x: 96, y: 0 }]);
});

test("invalid json → the whole overlay is absent", () => {
  const bad = [
    null, undefined, 5, "x", [], {},
    { ...stub, cell: undefined }, { ...stub, cell: { w: 0, h: 48 } }, { ...stub, cell: { w: 48, h: -1 } }, { ...stub, cell: { w: "48", h: 48 } },
    { ...stub, fps: 0 }, { ...stub, fps: -3 }, { ...stub, fps: "13" }, { ...stub, fps: NaN },
    { ...stub, frames: [] }, { ...stub, frames: undefined }, { ...stub, frames: "x" },
    { ...stub, frames: [{ x: 0, y: 0 }, { x: "a", y: 0 }] }, { ...stub, frames: [{ x: 0 }] }, { ...stub, frames: [null] }, { ...stub, frames: [-1] },
  ];
  for (const b of bad) assert.equal(validateTakeover(b).ok, false, JSON.stringify(b));
});

test("expand plays once then holds the last frame; settles", () => {
  const n = 8, fps = 13;
  let pos = 0;
  assert.equal(takeoverFrameAt(pos, n), 0);
  assert.ok(takeoverVisible(pos, true, false));
  const seen = [];
  for (let t = 0; t < 700; t += 16) {
    pos = takeoverAdvance(pos, true, 16, fps, n);
    seen.push(takeoverFrameAt(pos, n));
  }
  assert.deepEqual([...new Set(seen)], [0, 1, 2, 3, 4, 5, 6, 7]); // every frame once, stepped, in order
  assert.ok(seen.every((f, i) => i === 0 || f >= seen[i - 1]));
  assert.equal(takeoverFrameAt(pos, n), 7);
  assert.ok(takeoverSettled(pos, true, n));
  assert.ok(takeoverVisible(pos, true, false)); // held while expanded
});

test("collapse plays in reverse, then the overlay is gone (Riff idle)", () => {
  const n = 8, fps = 13;
  let pos = n;
  const seen = [];
  while (!takeoverSettled(pos, false, n)) {
    pos = takeoverAdvance(pos, false, 16, fps, n);
    seen.push(takeoverFrameAt(pos, n));
  }
  assert.equal(seen[0], 7);
  assert.ok(seen.every((f, i) => i === 0 || f <= seen[i - 1]));
  assert.equal(pos, 0);
  assert.equal(takeoverVisible(pos, false, false), false);
  assert.ok(takeoverVisible(3.5, false, false)); // still reversing
});

test("flip mid-play reverses from the current frame, not from the start", () => {
  const n = 8, fps = 13;
  let pos = 0;
  for (let i = 0; i < 12; i++) pos = takeoverAdvance(pos, true, 16, fps, n); // ~192ms → frame 2
  const at = takeoverFrameAt(pos, n);
  assert.equal(at, 2);
  pos = takeoverAdvance(pos, false, 16, fps, n);
  assert.ok(takeoverFrameAt(pos, n) <= at && takeoverFrameAt(pos, n) >= at - 1); // went back one step at most
  // and flips back mid-reverse continue forward from here
  const p2 = takeoverAdvance(pos, true, 16, fps, n);
  assert.ok(p2 > pos && p2 < n);
});

test("reduced motion never draws the overlay", () => {
  assert.equal(takeoverVisible(0, true, true), false);
  assert.equal(takeoverVisible(5, true, true), false);
  assert.equal(takeoverVisible(5, false, true), false);
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes("if (reduced || n < 1)")); // clock parked at 0
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("isRiff && !sheet && !reduced")); // no CSS dissolve either
});

test("absent json or PNG → CSS stepped dissolve; sheet only when both load", () => {
  assert.equal(TAKEOVER_FALLBACK.steps, 8);
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("useImageOk(isRiff && takeover ? TAKEOVER_URL(theme) : null)"));
  assert.ok(sky.includes("const sheet = sheetOk ? takeover : null"));
  assert.ok(sky.includes("sky-takeover-fallback"));
  const css = src("styles.css");
  assert.ok(/\.sky-takeover-fallback \{[^}]*steps\(8, end\)/.test(css));
  assert.ok(css.includes(".sky-takeover-fallback.is-on { clip-path: inset(0 0 0 0); }"));
  assert.equal(TAKEOVER_URL("light"), "/office/takeover-light.png");
  // reuses the shared fetch + image probe; no second loader
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes("useJsonModel(SKY_CRT_JSON_URL") && hook.includes("useJsonModel(TAKEOVER_JSON_URL"));
  assert.equal((hook.match(/new Image\(\)/g) ?? []).length, 1);
});

test("overlay is inert and aligned: pointer-events none, aria-hidden stage, faceContain geometry; sky bots stay mounted", () => {
  const css = src("styles.css");
  assert.ok(/\.sky-takeover \{[^}]*pointer-events: none/.test(css));
  assert.ok(/\.sky-takeover-fallback \{[^}]*pointer-events: none/.test(css));
  assert.ok(/\.sky-takeover \{[^}]*image-rendering: pixelated/.test(css));
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('className="sky-face-stage" aria-hidden="true"'));
  assert.ok(sky.includes("faceContain(sheet.cell, box)"));
  assert.ok(sky.includes("onReclaim={reclaimRiff}")); // keyboard reclaim kept on the zone
  assert.equal((sky.match(/<Zone /g) ?? []).length, 2); // still exactly two mounted zones
});
