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

test("PinMenu Esc is consumed in the capture phase (before the focus bar's bubble listener) and the list re-places on resize", () => {
  const src = fs.readFileSync(resolve(ROOT, "src/PinMenu.tsx"), "utf8");
  assert.match(src, /addEventListener\("keydown", esc, true\)/);
  assert.match(src, /removeEventListener\("keydown", esc, true\)/);
  const esc = src.match(/const esc = \(e: KeyboardEvent\) => \{[\s\S]*?\n    \};/)[0];
  assert.match(esc, /renaming/);
  assert.match(esc, /preventDefault\(\)/);
  assert.match(esc, /stopPropagation\(\)/);
  const rail = fs.readFileSync(resolve(ROOT, "src/PinRail.tsx"), "utf8");
  assert.match(rail, /window\.addEventListener\("keydown", onKey\)/, "focus bar Esc stays a bubble-phase window listener");
  assert.match(src, /new ResizeObserver\(/);
  assert.match(src, /ro\.disconnect\(\)/);
});

test("placePinMenuZoomed divides viewport px by the root zoom (4K html zoom 1.25)", async () => {
  const { placePinMenuZoomed } = await import("../src/pinMenuPlace.ts");
  const z = 1.25;
  // Same layout as the 500x800 case, measured in viewport px under zoom 1.25.
  const a = box(400 * z, 100 * z, 24 * z, 20 * z);
  assert.deepEqual(placePinMenuZoomed(a, { w: size.w * z, h: size.h * z }, { w: view.w * z, h: view.h * z }, z), { top: 124, left: 244 });
  assert.deepEqual(placePinMenuZoomed(box(400, 100), size, view, 1), { top: 124, left: 244 });
});

test("PinMenu and AttentionList place through the root zoom", () => {
  for (const f of ["PinMenu", "AttentionList"]) {
    assert.match(fs.readFileSync(resolve(ROOT, `src/${f}.tsx`), "utf8"), /rootZoom\(\)/, f);
  }
});
