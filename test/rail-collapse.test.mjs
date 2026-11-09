import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isNarrowViewport, parseOverride, railCollapsed, RAIL_NARROW_CSS_PX } from "../src/railCollapseLogic.ts";
import { floorFitScale } from "../src/squadFloorLogic.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("narrow = layout width (window / UI zoom) under 1600 css px", () => {
  assert.equal(RAIL_NARROW_CSS_PX, 1600);
  assert.equal(isNarrowViewport(1280), true);
  assert.equal(isNarrowViewport(1599), true);
  assert.equal(isNarrowViewport(1600), false);
  assert.equal(isNarrowViewport(1920, 1.25), true); // 1536 layout px
  assert.equal(isNarrowViewport(3840, 1.25), false);
  assert.equal(isNarrowViewport(NaN), false);
  assert.equal(isNarrowViewport(1280, 0), true);
});

test("narrow starts collapsed, a session override wins, wide keeps the saved preference", () => {
  assert.equal(railCollapsed(true, null, false), true);
  assert.equal(railCollapsed(true, false, true), false);
  assert.equal(railCollapsed(true, true, false), true);
  assert.equal(railCollapsed(false, null, false), false);
  assert.equal(railCollapsed(false, false, true), true);
  assert.equal(parseOverride("1"), true);
  assert.equal(parseOverride("0"), false);
  assert.equal(parseOverride(null), null);
  assert.equal(parseOverride("x"), null);
});

test("collapsed rails give the 960px floor a whole 1x at 1280 and 1440; the open layout does not", () => {
  const stage = (vw, side, rail) => vw - side - rail;
  assert.equal(floorFitScale(stage(1280, 56, 64), 520, 1, 960, 498), 1);
  assert.equal(floorFitScale(stage(1440, 56, 64), 520, 1, 960, 498), 1);
  assert.ok(floorFitScale(stage(1280, 170, 300), 520, 1, 960, 498) < 1);
});

test("rail collapse wiring: App owns the state, the rail has a toggle, CSS has the 64px strip", () => {
  const app = read("src/App.tsx");
  const rail = read("src/PinRail.tsx");
  const css = read("src/styles.css");
  assert.match(app, /railCollapsed\(narrow, sidebarOverride, sidebarPref\)/);
  assert.match(app, /pin-rail-collapsed/);
  assert.match(rail, /data-testid="pin-rail-collapse-toggle"/);
  assert.match(css, /\.app\.pin-focus\.hub-focus\.pin-rail-collapsed\.sidebar-collapsed\s*\{[^}]*56px[^}]*64px/);
  assert.match(css, /\.pin-rail\.compact \.pin-rail-active-buddy/);
});
