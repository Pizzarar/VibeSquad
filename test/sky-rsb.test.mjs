// RS-b: Riff's chat window zooms out of his TV and slams into the Overlord (docs/PLAN_NEON_OFFICE.md RS).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SLAM,
  SLAM_IDLE_VIEW,
  SLAM_REST,
  SLAM_SHAKE_DX,
  SLAM_SQUASH,
  slamAdvance,
  slamFaceForce,
  slamKey,
  slamPuffBox,
  slamPuffPoints,
  slamPuffScale,
  slamRect,
  slamStart,
  slamTotalMs,
  slamTransform,
  slamView,
  validateSlamPuff,
} from "../src/skyZonesLogic.ts";
import { validateFaces } from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const puff = { frames: 4, ms: 60 };
const at = (dir, t, reduced = false, p = puff) => slamView({ dir, t }, reduced, p);

test("open: 4 zoom steps over 250ms, window held back, Overlord smacked", () => {
  const seen = [];
  for (let t = 0; t < SLAM.zoomMs; t += 10) {
    const v = at("open", t);
    assert.equal(v.windowShown, false);
    assert.equal(v.face, "smacked");
    assert.equal(v.squash, false);
    assert.equal(v.shakeDx, 0);
    assert.equal(v.puffFrame, null);
    if (seen.at(-1) !== v.zoomStep) seen.push(v.zoomStep);
  }
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test("landing (hotfix2 hit): the dotted box stays on the Overlord while it is smacked, the squash/shake/puff read big, and the chat settles after the hit", () => {
  const land = SLAM.zoomMs;
  const v0 = at("open", land);
  assert.equal(v0.windowShown, false, "the chat waits for the hit");
  assert.equal(v0.zoomStep, SLAM.zoomSteps, "the box sits on the Overlord TV through the impact");
  assert.equal(v0.face, "smacked");
  assert.equal(v0.squash, true);
  assert.equal(at("open", land + SLAM.squashMs - 1).squash, true);
  assert.equal(at("open", land + SLAM.squashMs).squash, false, "squash is one beat");
  const peak = Math.max(...SLAM_SHAKE_DX.map(Math.abs));
  assert.ok(peak >= 8 && peak <= 12, "a visible shake (was 3px: read as no slam)");
  assert.ok(SLAM_SQUASH.x >= 1.06 && SLAM_SQUASH.y <= 0.94);
  assert.equal(SLAM_SHAKE_DX.length * SLAM.shakeStepMs, SLAM.shakeMs);
  assert.equal(at("open", land).shakeDx, SLAM_SHAKE_DX[0]);
  assert.equal(at("open", land + SLAM.shakeMs - 1).shakeDx, SLAM_SHAKE_DX.at(-1));
  assert.equal(at("open", land + SLAM.shakeMs - 1).windowShown, false);
  const settled = at("open", land + SLAM.shakeMs);
  assert.equal(settled.shakeDx, 0);
  assert.equal(settled.windowShown, true, "then the Riff chat settles");
  assert.equal(settled.zoomStep, null);
  assert.deepEqual([0, 59, 60, 119, 120, 180, 239, 240].map((d) => at("open", land + d).puffFrame), [0, 0, 1, 1, 2, 3, 3, null]);
});

test("travel is a hard hit: whole steps, linear (no ease-out), landing exactly on the Overlord TV rect", () => {
  const from = { left: 0, top: 0, width: 100, height: 40 };
  const to = { left: 400, top: 0, width: 100, height: 40 };
  const lefts = [1, 2, 3, 4].map((n) => slamRect(from, to, n, 4).left);
  assert.deepEqual(lefts, [100, 200, 300, 400]);
});

test("no puff art: the slam still plays, just without the burst", () => {
  const v = at("open", SLAM.zoomMs + 10, false, null);
  assert.equal(v.puffFrame, null);
  assert.equal(v.squash, true);
  assert.equal(slamTotalMs("open", 0), SLAM.zoomMs + SLAM.shakeMs);
});

test("open timeline ends at the longer of shake and puff, then rests", () => {
  const total = slamTotalMs("open", 240);
  assert.equal(total, SLAM.zoomMs + 240);
  let s = slamStart(true, false);
  s = slamAdvance(s, total - 1, 240);
  assert.equal(s.dir, "open");
  s = slamAdvance(s, 1, 240);
  assert.deepEqual(s, SLAM_REST);
  assert.deepEqual(slamView(s, false, puff), SLAM_IDLE_VIEW);
});

test("close: the zoom-rect runs in reverse (N..1) with the window gone, dizzy ~1s, then idle", () => {
  const seen = [];
  for (let t = 0; t < SLAM.zoomMs; t += 10) {
    const v = at("close", t);
    assert.equal(v.windowShown, true, "the closed panel is hidden by isOpen, not by the clock");
    assert.equal(v.face, "dizzy");
    if (seen.at(-1) !== v.zoomStep) seen.push(v.zoomStep);
  }
  assert.deepEqual(seen, [4, 3, 2, 1]);
  assert.equal(at("close", SLAM.zoomMs).zoomStep, null);
  assert.equal(at("close", SLAM.dizzyMs - 1).face, "dizzy");
  assert.equal(at("close", SLAM.dizzyMs).face, null);
  assert.equal(slamTotalMs("close"), SLAM.dizzyMs);
  assert.deepEqual(slamAdvance({ dir: "close", t: SLAM.dizzyMs - 1 }, 5), SLAM_REST);
});

test("reduced motion: no clock, instant end state, no shake / puff / smacked / dizzy / zoom", () => {
  assert.deepEqual(slamStart(true, true), SLAM_REST);
  assert.deepEqual(slamStart(false, true), SLAM_REST);
  for (const dir of ["open", "close"]) for (const t of [0, 100, 300, 900]) assert.deepEqual(slamView({ dir, t }, true, puff), SLAM_IDLE_VIEW);
  assert.equal(SLAM_IDLE_VIEW.windowShown, true);
  assert.equal(SLAM_IDLE_VIEW.zoomStep, null);
  assert.equal(SLAM_IDLE_VIEW.face, null);
});

test("advance ignores backwards time; rest stays rest", () => {
  assert.deepEqual(slamAdvance({ dir: "open", t: 40 }, -30), { dir: "open", t: 40 });
  assert.equal(slamAdvance(SLAM_REST, 999), SLAM_REST);
});

test("slamKey changes exactly when something drawn changes (the chat re-renders ~15 times, not per frame)", () => {
  const keys = new Set();
  for (let t = 0; t < 600; t++) keys.add(slamKey(at("open", t)));
  assert.ok(keys.size <= 20, `keys ${keys.size}`);
  assert.notEqual(slamKey(at("open", 0)), slamKey(at("open", 70)));
  assert.equal(slamKey(at("open", 1)), slamKey(at("open", 2)));
});

test("a missing smacked / dizzy key is skipped (the face stays on its normal mode)", () => {
  const base = { cell: { w: 80, h: 48 }, fps: 3, overlord: { idle: [{ x: 0, y: 0 }] } };
  const none = validateFaces(base).value;
  assert.equal(slamFaceForce(at("open", 10), none), null);
  assert.equal(slamFaceForce(at("close", 10), none), null);
  const some = validateFaces({ ...base, overlord: { ...base.overlord, smacked: [{ x: 1, y: 0 }], dizzy: [{ x: 2, y: 0 }] } }).value;
  assert.equal(slamFaceForce(at("open", 10), some), "smacked");
  assert.equal(slamFaceForce(at("close", 10), some), "dizzy");
  assert.equal(slamFaceForce(at("close", SLAM.dizzyMs), some), null);
  assert.equal(slamFaceForce(at("open", 10), null), null);
  const onlySmacked = validateFaces({ ...base, overlord: { ...base.overlord, smacked: [{ x: 1, y: 0 }] } }).value;
  assert.equal(slamFaceForce(at("close", 10), onlySmacked), null);
});

test("shipped faces.json carries overlord smacked + dizzy (2 frames each); riffbot untouched", () => {
  const f = validateFaces(JSON.parse(readFileSync(new URL("../public/office/faces.json", import.meta.url), "utf8"))).value;
  assert.equal(f.bots.overlord.smacked.length, 2);
  assert.equal(f.bots.overlord.dizzy.length, 2);
  assert.equal(f.bots.riffbot.smacked, undefined);
});

test("zoom-rect grows from Riff's TV to the chat's rect, snapped to device px", () => {
  const from = { left: 0, top: 0, width: 400, height: 300 };
  const to = { left: 400, top: 0, width: 400, height: 300 };
  assert.deepEqual(slamRect(from, to, 4, 4), to);
  assert.deepEqual(slamRect(from, to, 2, 4), { left: 200, top: 0, width: 400, height: 300 });
  const r = slamRect({ left: 0, top: 0, width: 333, height: 250 }, { left: 401, top: 0, width: 333, height: 250 }, 1, 4, 1.2);
  for (const n of Object.values(r)) assert.ok(Math.abs(n * 1.2 - Math.round(n * 1.2)) < 1e-9, `${n} not on a device px`);
});

test("puff: 3 at the 1080 face k (7), grows with the face, whole device px at 4K@120%; centred on the corner, 4 corners", () => {
  assert.equal(slamPuffScale(3, 0, 1), 3, "no face box yet: the art's own scale");
  assert.equal(slamPuffScale(3, 7, 1), 3, "1080");
  const k = slamPuffScale(3, 13 / 1.2, 1.2); // 4K@120%: face is 13 device px per art px
  assert.ok(k > 3 && Math.abs(k * 1.2 - Math.round(k * 1.2)) < 1e-9, `k ${k}`);
  assert.equal(Math.round(k * 1.2), 5, "3 * 13/7 = 5.57 device px, floored to a whole one");
  const b = slamPuffBox({ x: 100, y: 50 }, { w: 32, h: 32 }, 3, 1);
  assert.deepEqual(b, { left: 52, top: 2, width: 96, height: 96 });
  assert.equal(slamPuffPoints({ left: 10, top: 20, width: 100, height: 60 }).length, 4);
});

test("slamTransform: shake + squash share one transform; none is null", () => {
  assert.equal(slamTransform(0, false), null);
  assert.equal(slamTransform(3, false), "translateX(3px)");
  assert.match(slamTransform(-2, true), /^translateX\(-2px\) scale\(/);
  assert.match(slamTransform(0, true), /^scale\(/);
});

test("landing squash rides the visible Overlord TV transform, pinned at the bottom (M1)", () => {
  // During the hit the chat panel is at opacity 0 (is-slam-held), so the squash must be on the Overlord TV's --slam-tv-tf.
  const z = src("SkyZones.tsx");
  assert.match(z, /const tvTf = slamTransform\(slam\.shakeDx, slam\.squash, dpr\);/);
  assert.doesNotMatch(z, /const tvTf = slamTransform\(slam\.shakeDx, false, dpr\);/);
  // The Overlord TV is the visible is-slam-fx element, anchored on its bottom edge so the squash thuds down.
  const css = src("styles.css");
  assert.match(css, /\.sky-zone\.is-slam-fx \{ transform: var\(--slam-tv-tf, none\); transform-origin: 50% 100%; \}/);
});

test("validateSlamPuff: the shipped json, and bad input is rejected / defaulted", () => {
  const j = JSON.parse(readFileSync(new URL("../public/office/slam-puff.json", import.meta.url), "utf8"));
  const v = validateSlamPuff(j);
  assert.equal(v.ok, true);
  assert.deepEqual([v.value.frameW, v.value.frameH, v.value.frames.length, v.value.scale, v.value.ms], [32, 32, 4, 3, 60]);
  assert.equal(validateSlamPuff(null).ok, false);
  assert.equal(validateSlamPuff({ frameW: 32 }).ok, false);
  assert.equal(validateSlamPuff({ frameW: 32, frameH: 32, frames: 3 }).value.frames.length, 3);
});

test("wiring: clock, Overlord face force, held chat, bezel fx, SlamFx; the old slide is the Overlord's chat only; reduced motion hides the fx", () => {
  const z = src("SkyZones.tsx");
  assert.match(z, /useSlamClock\(open === "riffbot", reduced, puff, initialOpen === "riffbot"\)/);
  assert.match(z, /force=\{slamFaceForce\(slam, faces\)\}/);
  assert.match(z, /<SlamFx root=\{root\}/);
  assert.match(z, /is-slam-held/);
  const css = src("styles.css");
  assert.match(css, /\.sky-chat-panel:not\(\[hidden\]\):not\(\.sky-zone-riffbot\) \{ animation: sky-chat-slam/);
  assert.match(css, /\.sky-zoom-rect/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^@]*\.sky-slam-fx \{ display: none; \}/);
  const h = src("useBotFace.ts");
  assert.match(h, /export function useSlamClock/);
  assert.match(h, /requestAnimationFrame\(tick\)/);
});
