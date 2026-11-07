import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { placePinMenu } from "../src/pinMenuPlace.ts";

const ROOT = resolve(import.meta.dirname, "..");
const view = { w: 500, h: 800 };
const size = { w: 180, h: 200 };
const box = (left, top, w = 24, h = 20) => ({ left, top, right: left + w, bottom: top + h });

test("placePinMenu right-aligns to the button and opens below", () => {
  assert.deepEqual(placePinMenu(box(400, 100), size, view), { top: 124, left: 244 });
});

test("placePinMenu keeps the list >=8px inside the viewport (rail button near the left edge)", () => {
  const p = placePinMenu(box(60, 100), size, view);
  assert.equal(p.left, 8);
  const r = placePinMenu(box(490, 100, 24), size, view);
  assert.ok(r.left + size.w <= view.w - 8);
});

test("placePinMenu flips above when there is no room below", () => {
  const p = placePinMenu(box(300, 700), size, view);
  assert.equal(p.top, 700 - 4 - size.h);
});

test("placePinMenu clamps into a tiny viewport when neither side fits", () => {
  const p = placePinMenu(box(100, 150), size, { w: 500, h: 300 });
  assert.ok(p.top >= 8 && p.top + size.h <= 300 - 8 + 0.001);
});

test("PinMenu portals the list to body, treats it as inside for outside-click, closes on resize/scroll", () => {
  const src = fs.readFileSync(resolve(ROOT, "src/PinMenu.tsx"), "utf8");
  assert.match(src, /createPortal\(/);
  assert.match(src, /document\.body/);
  assert.match(src, /list\.current\.contains/);
  assert.match(src, /addEventListener\("resize"/);
  assert.match(src, /addEventListener\("scroll", \w+, true\)/);
  assert.match(src, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/, "root keeps stopPropagation (React bubbles through portals)");
  const css = fs.readFileSync(resolve(ROOT, "src/styles.css"), "utf8");
  const rule = css.match(/\.pin-menu-list \{[^}]*\}/)[0];
  assert.match(rule, /position: fixed/);
  assert.doesNotMatch(rule, /position: absolute/);
});
