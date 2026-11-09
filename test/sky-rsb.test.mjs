// RS-b/RS-c: Riff's chat window swings on a hinge into the Overlord (docs/PLAN_RIFF_SWING.md), then squash / shake / puff / SMACK star / smacked -> dizzy.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SLAM,
  SLAM_IDLE_VIEW,
  SLAM_REST,
  SLAM_SHAKE_DX,
  SLAM_SQUASH,
  SWING_BOUNCE_DEG,
  SWING_FROM_DEG,
  SWING_SMEAR,
  slamAdvance,
  slamFaceForce,
  slamFxMs,
  slamFxTiming,
  slamKey,
  slamPuffBox,
  slamPuffPoints,
  slamPuffScale,
  slamRiffForce,
  slamStart,
  slamTotalMs,
  slamTransform,
  slamView,
  swingAngleClose,
  swingAngleOpen,
  swingTransform,
  validateSlamPuff,
} from "../src/skyZonesLogic.ts";
import { validateFaces } from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const fx = { frames: 4, ms: 60, smackFrames: 2, smackMs: 90 };
const at = (dir, t, reduced = false, p = fx) => slamView({ dir, t }, reduced, p);

test("open swing: hinged rotateY, ease-in from edge-on to flat over ~300ms, no zoom steps, Riff shoves, Overlord not yet smacked", () => {
  assert.ok(SLAM.swingMs >= 250 && SLAM.swingMs <= 350);
  assert.equal(swingAngleOpen(0), SWING_FROM_DEG);
  let prev = swingAngleOpen(0);
  let prevStep = 0;
  for (let t = 10; t < SLAM.swingMs; t += 10) {
    const a = swingAngleOpen(t);
    assert.ok(a > prev, "monotonic toward flat");
    const step = a - prev;
    assert.ok(step >= prevStep - 1e-9, "ease-in: each 10ms step is at least as big as the last (accelerates to the hit)");
    prev = a;
    prevStep = step;
    const v = at("open", t);
    assert.equal(v.swinging, true);
    assert.equal(v.swing, a);
    assert.equal(v.shove, true);
    assert.equal(v.face, null, "the Overlord is hit at the end of the swing, not before");
    assert.equal(v.squash, false);
    assert.equal(v.shakeDx, 0);
    assert.equal(v.puffFrame, null);
    assert.equal(v.smackFrame, null);
    assert.equal(v.closing, false);
  }
  assert.ok(Math.abs(prev) < 15, "just before the hit it is almost flat");
  assert.ok(Math.abs(swingAngleOpen(SLAM.swingMs / 2)) > Math.abs(SWING_FROM_DEG) * 0.8, "ease-in: still mostly open at half time (the speed is in the last part)");
});

test("smear: only the fast late slice of the swing", () => {
  const seen = [];
  for (let t = 0; t < SLAM.swingMs; t += 5) {
    const v = at("open", t);
    if (seen.at(-1) !== v.smear) seen.push(v.smear);
    assert.equal(v.smear, t / SLAM.swingMs >= SWING_SMEAR[0] && t / SLAM.swingMs < SWING_SMEAR[1]);
  }
  assert.deepEqual(seen, [false, true]);
  assert.equal(at("open", SLAM.swingMs).smear, false);
});

test("the hit (hotfix2): squash one beat, visible shake, puff + SMACK star, Overlord smacked, the window bounces back 10-15 deg and settles flat", () => {
  const hit = SLAM.swingMs;
  const v0 = at("open", hit);
  assert.equal(v0.face, "smacked");
  assert.equal(v0.squash, true);
  assert.equal(v0.shove, true);
  assert.equal(v0.swinging, true);
  assert.equal(at("open", hit + SLAM.squashMs - 1).squash, true);
  assert.equal(at("open", hit + SLAM.squashMs).squash, false, "squash is one beat");
  const peak = Math.max(...SLAM_SHAKE_DX.map(Math.abs));
  assert.ok(peak >= 8 && peak <= 12, "a visible shake (was 3px: read as no slam)");
  assert.ok(SLAM_SQUASH.x >= 1.06 && SLAM_SQUASH.y <= 0.94);
  assert.equal(SLAM_SHAKE_DX.length * SLAM.shakeStepMs, SLAM.shakeMs);
  assert.equal(v0.shakeDx, SLAM_SHAKE_DX[0]);
  assert.equal(at("open", hit + SLAM.shakeMs - 1).shakeDx, SLAM_SHAKE_DX.at(-1));
  let bounce = 0;
  for (let d = 0; d < SLAM.shakeMs; d += 5) bounce = Math.max(bounce, Math.abs(swingAngleOpen(hit + d)));
  assert.ok(bounce >= Math.abs(SWING_BOUNCE_DEG) * 0.7 && bounce <= 15, `bounce peaks ${bounce} deg`);
  assert.ok(Math.abs(SWING_BOUNCE_DEG) >= 10 && Math.abs(SWING_BOUNCE_DEG) <= 15);
  assert.equal(swingAngleOpen(hit), 0, "flat at the instant of the hit");
  assert.equal(swingAngleOpen(hit + SLAM.shakeMs), 0, "flat when settled");
  const settled = at("open", hit + SLAM.shakeMs);
  assert.equal(settled.swing, null, "nothing applied once settled: the chat is a plain window");
  assert.equal(settled.swinging, false);
  assert.equal(settled.shakeDx, 0);
  assert.equal(settled.shove, false);
  assert.equal(settled.face, "smacked", "smacked until the clock rests");
  assert.deepEqual([0, 59, 60, 119, 120, 180, 239, 240].map((d) => at("open", hit + d).puffFrame), [0, 0, 1, 1, 2, 3, 3, null]);
  assert.deepEqual([0, 89, 90, 179, 180].map((d) => at("open", hit + d).smackFrame), [0, 0, 1, 1, null], "2 SMACK frames at 90ms");
});

test("no art: the swing + hit still play, just without the burst / star", () => {
  const v = at("open", SLAM.swingMs + 10, false, null);
  assert.equal(v.puffFrame, null);
  assert.equal(v.smackFrame, null);
  assert.equal(v.squash, true);
  assert.equal(slamTotalMs("open", 0), SLAM.swingMs + SLAM.shakeMs);
  const noStar = at("open", SLAM.swingMs + 10, false, { frames: 4, ms: 60 });
  assert.equal(noStar.smackFrame, null);
  assert.equal(noStar.puffFrame, 0);
});

test("open timeline ends at the longer of shake and puff/star, then rests", () => {
  assert.equal(slamFxMs(fx), 240);
  assert.equal(slamFxMs({ frames: 1, ms: 10, smackFrames: 4, smackMs: 100 }), 400);
  assert.equal(slamFxMs(null), 0);
  const total = slamTotalMs("open", 240);
  assert.equal(total, SLAM.swingMs + 240);
  let s = slamStart(true, false);
  s = slamAdvance(s, total - 1, 240);
  assert.equal(s.dir, "open");
  s = slamAdvance(s, 1, 240);
  assert.deepEqual(s, SLAM_REST);
  assert.deepEqual(slamView(s, false, fx), SLAM_IDLE_VIEW);
});

test("close: a gentle ease-in-out swing shut (panel kept up while it closes), no hit, dizzy ~1s, then idle", () => {
  assert.equal(swingAngleClose(0), 0);
  assert.equal(swingAngleClose(SLAM.closeMs), SWING_FROM_DEG);
  let prev = 0;
  for (let t = 10; t < SLAM.closeMs; t += 10) {
    const v = at("close", t);
    assert.equal(v.closing, true, "the panel stays mounted until it has swung shut");
    assert.equal(v.swinging, true);
    assert.ok(v.swing < prev, "swings away monotonically");
    prev = v.swing;
    assert.equal(v.face, "dizzy");
    assert.equal(v.squash, false);
    assert.equal(v.shakeDx, 0);
    assert.equal(v.puffFrame, null);
    assert.equal(v.smackFrame, null);
    assert.equal(v.smear, false);
  }
  const shut = at("close", SLAM.closeMs);
  assert.equal(shut.closing, false);
  assert.equal(shut.swing, null);
  assert.equal(shut.face, "dizzy");
  assert.equal(at("close", SLAM.dizzyMs - 1).face, "dizzy");
  assert.equal(at("close", SLAM.dizzyMs).face, null);
  assert.equal(slamTotalMs("close"), SLAM.dizzyMs);
  assert.deepEqual(slamAdvance({ dir: "close", t: SLAM.dizzyMs - 1 }, 5), SLAM_REST);
});

test("reduced motion: no clock, instant end state, no swing / shake / puff / star / smacked / dizzy", () => {
  assert.deepEqual(slamStart(true, true), SLAM_REST);
  assert.deepEqual(slamStart(false, true), SLAM_REST);
  for (const dir of ["open", "close"]) for (const t of [0, 100, 300, 900]) assert.deepEqual(slamView({ dir, t }, true, fx), SLAM_IDLE_VIEW);
  assert.equal(SLAM_IDLE_VIEW.swing, null);
  assert.equal(SLAM_IDLE_VIEW.closing, false);
  assert.equal(SLAM_IDLE_VIEW.face, null);
});

test("advance ignores backwards time; rest stays rest", () => {
  assert.deepEqual(slamAdvance({ dir: "open", t: 40 }, -30), { dir: "open", t: 40 });
  assert.equal(slamAdvance(SLAM_REST, 999), SLAM_REST);
});

test("slamKey changes only on coarse changes, never on the per-frame angle (the chat re-renders ~15 times, not per frame)", () => {
  const keys = new Set();
  for (let t = 0; t < 700; t++) keys.add(slamKey(at("open", t)));
  assert.ok(keys.size <= 20, `keys ${keys.size}`);
  assert.equal(slamKey(at("open", 1)), slamKey(at("open", 100)), "early swing frames share a key until the smear starts");
  assert.notEqual(slamKey(at("open", 1)), slamKey(at("open", SLAM.swingMs + 10)));
  assert.notEqual(slamKey(at("open", 200)), slamKey(at("open", 20)), "the smear toggles the key");
});

test("a missing smacked / dizzy / shove key is skipped (the face stays on its normal mode)", () => {
  const base = { cell: { w: 80, h: 48 }, fps: 3, overlord: { idle: [{ x: 0, y: 0 }] }, riffbot: { idle: [{ x: 0, y: 0 }] } };
  const none = validateFaces(base).value;
  assert.equal(slamFaceForce(at("open", SLAM.swingMs + 10), none), null);
  assert.equal(slamFaceForce(at("close", 10), none), null);
  assert.equal(slamRiffForce(at("open", 10), none), null);
  const some = validateFaces({ ...base, overlord: { ...base.overlord, smacked: [{ x: 1, y: 0 }], dizzy: [{ x: 2, y: 0 }] }, riffbot: { ...base.riffbot, shove: [{ x: 5, y: 0 }] } }).value;
  assert.equal(slamFaceForce(at("open", SLAM.swingMs + 10), some), "smacked");
  assert.equal(slamFaceForce(at("open", 10), some), null, "not smacked before the hit");
  assert.equal(slamFaceForce(at("close", 10), some), "dizzy");
  assert.equal(slamFaceForce(at("close", SLAM.dizzyMs), some), null);
  assert.equal(slamRiffForce(at("open", 10), some), "shove");
  assert.equal(slamRiffForce(at("open", SLAM.swingMs + SLAM.shakeMs), some), null, "Riff relaxes once the window settles");
  assert.equal(slamRiffForce(at("close", 10), some), null);
  assert.equal(slamFaceForce(at("open", 10), null), null);
  assert.equal(slamRiffForce(at("open", 10), null), null);
  const onlySmacked = validateFaces({ ...base, overlord: { ...base.overlord, smacked: [{ x: 1, y: 0 }] } }).value;
  assert.equal(slamFaceForce(at("close", 10), onlySmacked), null);
});

test("shipped faces.json: overlord smacked + dizzy (2 frames each), riffbot shove (1 frame, x800)", () => {
  const f = validateFaces(JSON.parse(readFileSync(new URL("../public/office/faces.json", import.meta.url), "utf8"))).value;
  assert.equal(f.bots.overlord.smacked.length, 2);
  assert.equal(f.bots.overlord.dizzy.length, 2);
  assert.equal(f.bots.riffbot.smacked, undefined);
  assert.deepEqual(f.bots.riffbot.shove, [{ x: 800, y: 0 }]);
});

test("swingTransform: perspective + rotateY, hinge origin set in CSS", () => {
  assert.match(swingTransform(-40), /^perspective\(\d+px\) rotateY\(-40deg\)$/);
  assert.match(swingTransform(-12.3456), /rotateY\(-12\.35deg\)/);
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
  const z = src("SkyZones.tsx");
  assert.match(z, /const tvTf = slamTransform\(slam\.shakeDx, slam\.squash, dpr\);/);
  assert.doesNotMatch(z, /const tvTf = slamTransform\(slam\.shakeDx, false, dpr\);/);
  const css = src("styles.css");
  assert.match(css, /\.sky-zone\.is-slam-fx \{ transform: var\(--slam-tv-tf, none\); transform-origin: 50% 100%; \}/);
});

test("validateSlamPuff: the shipped json (puff + RS-c smack/smear keys), and bad input is rejected / defaulted", () => {
  const j = JSON.parse(readFileSync(new URL("../public/office/slam-puff.json", import.meta.url), "utf8"));
  const v = validateSlamPuff(j);
  assert.equal(v.ok, true);
  assert.deepEqual([v.value.frameW, v.value.frameH, v.value.frames.length, v.value.scale, v.value.ms], [32, 32, 4, 3, 60]);
  assert.deepEqual(v.value.smack, { frameW: 64, frameH: 48, frames: [{ x: 0, y: 32 }, { x: 64, y: 32 }], ms: 90 });
  assert.deepEqual(v.value.smear, { frameW: 40, frameH: 96, frame: { x: 0, y: 80 }, edgeX: 36, slice: { top: 16, bottom: 16 } });
  assert.deepEqual(slamFxTiming(v.value), { frames: 4, ms: 60, smackFrames: 2, smackMs: 90 });
  assert.equal(validateSlamPuff(null).ok, false);
  assert.equal(validateSlamPuff({ frameW: 32 }).ok, false);
  const bare = validateSlamPuff({ frameW: 32, frameH: 32, frames: 3 }).value;
  assert.equal(bare.frames.length, 3);
  assert.equal(bare.smack, undefined, "RS-a sheets without the RS-c keys still load");
  assert.equal(bare.smear, undefined);
  const bad = validateSlamPuff({ frameW: 32, frameH: 32, frames: 3, smack: { frameW: 0 }, smear: { frameW: 40, frameH: 30, frameList: [{ x: 0, y: 0 }], slice: { top: 16, bottom: 16 } } }).value;
  assert.equal(bad.smack, undefined, "a bad optional key is dropped, not fatal");
  assert.equal(bad.smear, undefined);
});

test("wiring: clock, Overlord face force, Riff shove force, swing var, kept-open closing panel, SlamFx, smear; the old slide is the Overlord's chat only; zoom-rect is gone", () => {
  const z = src("SkyZones.tsx");
  assert.match(z, /useSlamClock\(open === "riffbot", reduced, puff, initialOpen === "riffbot", root\)/);
  assert.match(z, /force=\{slamFaceForce\(slam, faces\)\}/);
  assert.match(z, /slamRiffForce\(slam, faces\)/);
  assert.match(z, /<SlamFx root=\{root\}/);
  assert.match(z, /hidden=\{panel && !isOpen && !fx\?\.closing\}/);
  assert.match(z, /<SwingSmear/);
  assert.match(z, /const shown = isRiff \? skyLeftBot\(landed\) : zone\.bot;/);
  assert.doesNotMatch(z, /zoom-rect|SLAM_STEPS|slamRect|is-slam-held/);
  const css = src("styles.css");
  assert.match(css, /\.sky-chat-panel:not\(\[hidden\]\):not\(\.sky-zone-riffbot\) \{ animation: sky-chat-slam/);
  assert.doesNotMatch(css, /sky-zoom-rect|is-slam-held/);
  assert.match(css, /\.sky-zone\.sky-chat-panel\.is-slam-fx \{ transform: var\(--slam-swing, translateX\(0\)\) var\(--slam-panel-tf, translateX\(0\)\); transform-origin: 0 100%;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^@]*\.sky-slam-fx \{ display: none; \}/);
  const h = src("useBotFace.ts");
  assert.match(h, /export function useSlamClock/);
  assert.match(h, /setProperty\("--slam-swing"/);
  assert.match(h, /requestAnimationFrame\(tick\)/);
});
