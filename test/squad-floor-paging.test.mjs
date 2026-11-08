import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  clampFloorIndex,
  floorCounterText,
  floorFitScale,
  isTypingTarget,
  needsYouArrows,
  pagingDir,
  parseStoredFloor,
  stepFloorIndex,
} from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const comp = src("SquadFloor.tsx");
const css = src("styles.css");
const floors = (...needs) => needs.map((n, index) => ({ index, needsYou: n }));

test("HP4 index clamp and step stop at the ends (no wrap)", () => {
  assert.equal(clampFloorIndex(-3, 5), 0);
  assert.equal(clampFloorIndex(9, 5), 4);
  assert.equal(clampFloorIndex(2.7, 5), 2);
  assert.equal(clampFloorIndex(NaN, 5), 0);
  assert.equal(clampFloorIndex(3, 0), 0);
  assert.equal(stepFloorIndex(0, -1, 5), 0);
  assert.equal(stepFloorIndex(4, 1, 5), 4);
  assert.equal(stepFloorIndex(1, 1, 5), 2);
  assert.equal(stepFloorIndex(9, -1, 5), 3);
});

test("HP4 persisted floor parses, clamps and survives junk", () => {
  assert.equal(parseStoredFloor("3", 5), 3);
  assert.equal(parseStoredFloor("40", 5), 4);
  assert.equal(parseStoredFloor(null, 5), 0);
  assert.equal(parseStoredFloor("abc", 5), 0);
  assert.equal(parseStoredFloor("", 5), 0);
  assert.match(comp, /localStorage\.getItem\(FLOOR_INDEX_KEY\)/);
  assert.match(comp, /localStorage\.setItem\(FLOOR_INDEX_KEY, String\(next\)\)/);
});

test("HP4 lift counter is 1-based, two digits", () => {
  assert.equal(floorCounterText(0), "01");
  assert.equal(floorCounterText(6), "07");
  assert.equal(floorCounterText(11), "12");
});

test("HP4 arrow/key paging: arrows, PgUp/PgDn, never modified", () => {
  assert.equal(pagingDir({ key: "ArrowLeft" }), -1);
  assert.equal(pagingDir({ key: "PageUp" }), -1);
  assert.equal(pagingDir({ key: "ArrowRight" }), 1);
  assert.equal(pagingDir({ key: "PageDown" }), 1);
  assert.equal(pagingDir({ key: "ArrowRight", ctrlKey: true }), 0);
  assert.equal(pagingDir({ key: "ArrowLeft", shiftKey: true }), 0);
  assert.equal(pagingDir({ key: "a" }), 0);
  assert.match(comp, /goRef\.current\(-1\)/);
  assert.match(comp, /goRef\.current\(1\)/);
});

test("HP4 keys do not fire while typing", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
  assert.match(comp, /isTypingTarget\(e\.target/);
});

test("HP4 needs-you dot lands on the arrow toward that floor", () => {
  const f = floors(false, true, false, false, true);
  assert.deepEqual(needsYouArrows(f, 0), { prev: false, next: true });
  assert.deepEqual(needsYouArrows(f, 1), { prev: false, next: true });
  assert.deepEqual(needsYouArrows(f, 2), { prev: true, next: true });
  assert.deepEqual(needsYouArrows(f, 4), { prev: true, next: false });
  assert.deepEqual(needsYouArrows(floors(false, false), 0), { prev: false, next: false });
  assert.match(comp, /has-needs/);
  assert.match(css, /\.sq-floor-arrow\.has-needs::after/);
});

test("HP4 reduced motion is instant: no blink state, no animation", () => {
  assert.match(comp, /if \(reduced\) return commit\(\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.sq-floor-band-wrap\.is-blink-out, \.sq-floor-band-wrap\.is-blink-in \{ animation: none; \} \}/);
});

test("HP4 the floor never scrolls: fixed box, fit scale, one floor rendered", () => {
  assert.match(css, /\.sq-floor \{[^}]*overflow: hidden;/);
  assert.doesNotMatch(css, /\.hub-body \.sq-floor \{[^}]*overflow: auto/);
  assert.match(comp, /tower\.floors\.slice\(current, current \+ 1\)/);
  assert.doesNotMatch(comp, /scrollIntoView/);
  assert.equal(floorFitScale(1300, 800, 1), 2);
  assert.equal(floorFitScale(3000, 400, 1), 1);
  assert.equal(floorFitScale(3000, 100, 1), 1);
  assert.equal(floorFitScale(600, 800, 1), 0);
});

test("FS-a the square outline is gone; silhouette + stepped hop replace it", () => {
  assert.doesNotMatch(css, /\.sq-floor-char:(hover|focus-visible) \.sq-floor-sprite \{ outline/);
  assert.doesNotMatch(css, /\.sq-floor-char[^{]*\{[^}]*outline: 1px solid var\(--cyan\)/);
  assert.match(css, /button\.sq-floor-char:focus-visible \{ outline: none !important; box-shadow: none !important; \}/);
  const drop = css.match(/\.sq-floor-char:hover \.sq-floor-sprite,\n\.sq-floor-char:focus-visible \.sq-floor-sprite \{([^}]*)\}/);
  assert.ok(drop, "hover+focus silhouette rule");
  assert.equal((drop[1].match(/drop-shadow\([^)]*\)/g) || []).length, 4);
  assert.doesNotMatch(drop[1], /drop-shadow\(\S+ \S+ [1-9]\d*px/); // blur radius is 0
  assert.match(css, /sq-floor-hop 120ms steps\(1, end\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.sq-floor-char:hover \.sq-floor-sprite \{ animation: none; \} \}/);
});

// ── FS-b wire ──────────────────────────────────────────────────────────────────
import { cursorInButton, cursorOffset, validateFloorCursor } from "../src/squadFloorLogic.ts";
const cursorJson = JSON.parse(readFileSync(new URL("../public/office/floor-cursor.json", import.meta.url), "utf8"));
const castJson = JSON.parse(readFileSync(new URL("../public/office/cast.json", import.meta.url), "utf8"));

test("FS-b json validates; bad json is rejected (skip-if-absent)", () => {
  const v = validateFloorCursor(cursorJson);
  assert.ok(v.ok);
  assert.deepEqual(v.value, { cell: { w: 9, h: 8 }, frames: 2, fps: 3, anchor: { x: 4, y: 6 } });
  assert.equal(validateFloorCursor(undefined).ok, false);
  assert.equal(validateFloorCursor({ ...cursorJson, frames: 0 }).ok, false);
  assert.equal(validateFloorCursor({ ...cursorJson, cell: { w: 9 } }).ok, false);
});

test("FS-b placement: tip lands on seat.x, cell top rides bubble.offset.y (Art9: seat-4, seat-40)", () => {
  const cursor = validateFloorCursor(cursorJson).value;
  const cast = { cell: 32, bubble: { offset: { x: -18, y: -40 } } };
  assert.deepEqual(cursorOffset(cast, cursor), { x: -4, y: -40 });
  // tip = cell origin + anchor = (seat.x, seat.y-34)
  const o = cursorOffset(cast, cursor);
  assert.deepEqual({ x: o.x + cursor.anchor.x, y: o.y + cursor.anchor.y }, { x: 0, y: -34 });
  assert.deepEqual(cursorInButton(cast, cursor), { left: 12, top: -8 });
  // follows the json values, not constants
  assert.deepEqual(cursorOffset({ bubble: { offset: { x: 0, y: -10 } } }, { ...cursor, anchor: { x: 2, y: 1 } }), { x: -2, y: -10 });
  assert.equal(castJson.bubble.offset.y, -40);
});

test("FS-b wiring: skip-if-absent, focus-only, reduced motion static", () => {
  assert.match(comp, /useImageOk\(cursorModel \? CURSOR_URL\(theme\) : null\)/);
  assert.match(comp, /cast && cursorModel && cursorImgOk \? \{/);
  assert.match(comp, /cursor && at && \(/);
  assert.match(comp, /cursor\.reduced \? \{ animation: "none" \}/);
  assert.match(css, /\.sq-floor-cursor \{ display: none;[^}]*image-rendering: pixelated/);
  assert.match(css, /\.sq-floor-char:focus-visible \.sq-floor-cursor \{ display: block; \}/);
  assert.doesNotMatch(css, /\.sq-floor-char:hover \.sq-floor-cursor/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.sq-floor-cursor \{ animation: none; \} \}/);
});
