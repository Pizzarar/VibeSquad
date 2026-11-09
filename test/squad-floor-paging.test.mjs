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
  assert.match(css, /\.sq-floor-arrow\.has-needs \{[^}]*background: var\(--pink-fill\)/); // HP6: the call plate lights up (no corner dot)
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
  assert.ok(Math.abs(floorFitScale(3000, 100, 1) - 100 / 360) < 1e-9); // FF-ui: no 1/n branch; the hub keeps the box >= 1x, so under 1x is only the last-resort fractional fit (never 0, never clipped)
  assert.ok(Math.abs(floorFitScale(3000, 60, 1) - 60 / 360) < 1e-9);
  assert.equal(floorFitScale(0, 800, 1), 0); // unmeasured only
});

test("hotfix2: a narrow hub pane (the owner's ~1140px window, then x1.2 UI-scale zoom) never blanks the tower", () => {
  // 1370 physical px at dpr 1.2 = ~1140 css; after the 120% zoom and the gutters the stage is well under the 640 native width.
  for (const w of [950, 950 / 1.2, 790, 640 / 1.2, 600, 480, 320, 100]) {
    const s = floorFitScale(w, 500, 1.2);
    assert.ok(s > 0 && s < 1.0001 && Number.isFinite(s), `stage ${w}: scale ${s}`);
    assert.ok(640 * s <= w + 0.001, `stage ${w}: fits width`);
    assert.ok(360 * s <= 500 + 0.001, `stage ${w}: fits height`);
  }
  assert.equal(floorFitScale(1300, 800, 1), 2); // crisp integer scale kept wherever >=1 fits
  assert.match(comp, /scale > 0 && \(/); // drawn for any positive fit, not just >= 1
  assert.match(comp, /scale !== 1 \?/); // fractional fits get the transform too
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
  assert.deepEqual(v.value, { cell: cursorJson.cell, frames: cursorJson.frames, fps: cursorJson.fps, anchor: cursorJson.anchor });
  assert.equal(validateFloorCursor(undefined).ok, false);
  assert.equal(validateFloorCursor({ ...cursorJson, frames: 0 }).ok, false);
  assert.equal(validateFloorCursor({ ...cursorJson, cell: { w: 13 } }).ok, false);
});

test("FS-b placement: tip lands on seat.x, cell sits 1.5 cell-heights above the sprite cell (clear of tall hair; read from the json)", () => {
  const cursor = validateFloorCursor(cursorJson).value;
  const cast = { cell: castJson.cell };
  const lift = Math.round(cursor.cell.h * 1.5);
  assert.deepEqual(cursorOffset(cast, cursor), { x: -cursor.anchor.x, y: -castJson.cell - lift });
  const o = cursorOffset(cast, cursor);
  // in the seat button's own box the cell top is -(1.5 x cell.h) = -18 for the 13x12 arrow (it was -12 and touched tall hair)
  assert.deepEqual(cursorInButton(cast, cursor), { left: o.x + castJson.cell / 2, top: -lift });
  assert.ok(cursorInButton(cast, cursor).top <= -cursor.cell.h - 4, "at least 4 art px of air above the sprite cell");
  // follows the json values, not constants
  assert.deepEqual(cursorOffset({ cell: 20 }, { ...cursor, cell: { w: 4, h: 8 }, anchor: { x: 2, y: 1 } }), { x: -2, y: -32 });
});

test("FS-b wiring: skip-if-absent, hover + keyboard focus, drawn above the front overlay, reduced motion static", () => {
  assert.match(comp, /useImageOk\(cursorModel \? CURSOR_URL\(theme\) : null\)/);
  assert.match(comp, /cast && cursorModel && cursorImgOk \? \{/);
  assert.match(comp, /pointedItem && cast && cursor && <SeatCursor /); // drawn in the bubbles layer, above the front overlay
  assert.match(comp, /onMouseEnter=\{\(\) => onPoint\("hover", agent\.agentId\)\}/); // hover shows it
  assert.match(comp, /e\.currentTarget\.matches\(":focus-visible"\) && onPoint/); // keyboard focus shows it, pointer focus does not
  assert.match(comp, /const pointed = hoveredId \?\? focusedId;/); // hover and focus tracked apart
  assert.match(comp, /cursor\.reduced \? \{ animation: "none" \}/);
  assert.match(css, /\.sq-floor-front \{ position: absolute; z-index: 2;/);
  assert.match(css, /\.sq-floor-cursor \{ display: block; z-index: 3;[^}]*image-rendering: pixelated/);
  assert.match(css, /\.sq-floor-bubble \{ position: absolute; z-index: 3;/);
  assert.doesNotMatch(css, /\.sq-floor-char:focus-visible \{ z-index/); // a focused seat must not paint its legs over the desk panel
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.sq-floor-cursor \{ animation: none; \} \}/);
});
