// FF-ui (docs/PLAN_FLOOR_FACES.md): the floor is never rendered under 1x; the sky TVs band yields; derived-from-json numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLOOR_DESIGN_WIDTH, floorFitScale, floorKitScale, floorNeedCssPx, riderSpot, deskRowMate, spreadNeighbours, floorNativeSize, validateFloor } from "../src/squadFloorLogic.ts";

const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const floorJson = JSON.parse(rd("../public/office/floor.json"));
const floor = validateFloor(floorJson).value;
const native = floorNativeSize(floor);
const css = rd("../src/styles.css");
const comp = rd("../src/SquadFloor.tsx");
const hub = rd("../src/HubPages.tsx");

/**
 * The hub column the way the CSS lays it out. `vw`/`vh` are the CSS viewport (device px / dpr). The page is (vh - chrome) / zoom root-zoomed css px
 * tall, but `36vh` is not zoomed. The TVs band asks for clamp(260, 36vh, 440) and shrinks to the slim strip (112) so the floor box keeps its need.
 */
function layout({ vw, vh, dpr, zoom, chrome = 67, strip = 14, sidebar = 265, rail = 300, yields = true }) {
  const colW = vw / zoom - sidebar - rail; // sidebar + the right queue rail
  const pageH = (vh - chrome) / zoom;
  const ask = Math.min(440, Math.max(260, 0.36 * vh));
  const need = floorNeedCssPx(native.h, dpr, zoom, colW, native.w);
  const sky = yields ? Math.max(112, Math.min(ask, pageH - strip - need)) : ask;
  const boxH = yields ? Math.max(need, pageH - strip - sky) : pageH - strip - sky;
  return { colW, need, sky, boxH, scale: floorFitScale(colW, boxH, dpr, native.w, native.h, zoom) };
}

const CASES = [
  { name: "1080 UI100", vw: 1920, vh: 1080, dpr: 1, zoom: 1 },
  { name: "1080 UI150", vw: 1920, vh: 1080, dpr: 1, zoom: 1.5 },
  { name: "4K@1.2 UI100", vw: 3200, vh: 1800, dpr: 1.2, zoom: 1 },
  { name: "4K@1.2 UI150", vw: 3200, vh: 1800, dpr: 1.2, zoom: 1.5 },
];

test("floor kit scale and need come from floor.json (960x444 -> x2 of the 480 design grid; 444 device px)", () => {
  assert.equal(native.w, floorJson.w);
  assert.equal(floorKitScale(native), floorJson.w / FLOOR_DESIGN_WIDTH);
  assert.equal(floorKitScale(native), 2);
  assert.equal(JSON.parse(rd("../public/office/cast.json")).cell, 32 * floorKitScale(native)); // cast cell = 32 x kit
  assert.equal(floorNeedCssPx(native.h, 1, 1), native.h);
  assert.equal(floorNeedCssPx(native.h, 1, 1.5), Math.ceil(native.h / 1.5));
  assert.equal(floorNeedCssPx(native.h, 1.2, 1.5), Math.ceil(native.h / 1.8));
  // a column narrower than the native floor cannot hold 1x sideways: the need follows the width it will be drawn at
  assert.ok(floorNeedCssPx(native.h, 1, 1, 715, native.w) < native.h);
});

test("floor is >= 1x and a whole device-px multiple at 1080 UI 100/150 and 4K@1.2 UI 100/150 once the TVs band yields", () => {
  for (const c of CASES) {
    const l = layout(c);
    const dev = l.scale * c.dpr * c.zoom;
    assert.ok(dev >= 1 - 1e-9, `${c.name}: ${dev} device px per art px`);
    assert.ok(Math.abs(dev - Math.round(dev)) < 1e-9, `${c.name}: ${dev} is whole`);
    assert.ok(l.boxH * c.dpr * c.zoom >= native.h - 1e-6, `${c.name}: box ${l.boxH} css px`);
  }
});

test("1080 UI 150: without yielding the floor drops under 1x; the yielding band keeps its native height in device px", () => {
  const stuck = layout({ vw: 1920, vh: 1080, dpr: 1, zoom: 1.5, yields: false });
  assert.ok(stuck.scale * 1.5 < 1, `unyielding band: ${stuck.scale * 1.5} device px per art px`);
  const l = layout({ vw: 1920, vh: 1080, dpr: 1, zoom: 1.5 });
  assert.ok(l.sky < 0.36 * 1080 && l.sky >= 112, `band shrank to ${l.sky}`);
  assert.ok(l.boxH * 1.5 >= native.h);
});

test("1280x720 (sidebar 265): the column is narrower than the native plate, so only the last-resort fit applies and the TVs keep what the floor cannot use; with room sideways (1600x720) it is 1x", () => {
  const l = layout({ vw: 1280, vh: 720, dpr: 1, zoom: 1 });
  assert.ok(l.colW < native.w);
  assert.ok(l.scale > 0 && l.scale < 1 && native.w * l.scale <= l.colW + 1e-6);
  assert.ok(l.need < native.h && l.sky > 112, "need shrinks with the width so the band is not starved for nothing");
  const w = layout({ vw: 1600, vh: 720, dpr: 1, zoom: 1 }); // a 1600x720 window: 1035 css px of column
  assert.equal(w.scale, 1);
  assert.ok(w.boxH >= native.h && w.sky >= 112);
});

test("CSS + wiring: the band yields (shrinks to a slim strip), the box keeps --floor-need, HubPages sets it from floor.json", () => {
  assert.match(css, /\.hub-sky-page \{ flex: 0 1 clamp\(260px, 36vh, 440px\); min-height: var\(--sky-slim, 112px\);/);
  assert.match(css, /\.hub-tower-box \{ flex: 1 0 var\(--floor-need, 125px\); min-height: var\(--floor-need, 125px\);/);
  assert.match(hub, /floorNeedCssPx\(native\.h, useDpr\(\), (?:useUiScale\(\)|uiScale), width, native\.w\)/);
  assert.match(hub, /"--floor-need": `\$\{floorNeed\}px`/);
  assert.match(hub, /fetch\("\/office\/floor\.json"\)/);
  assert.doesNotMatch(css, /\.hub-sky-page[^{]*\{[^}]*transition/);
});

test("hit 4: rider centre, lift-open height and ride rise derive from floor.json (kit scale), not constants", () => {
  const car = floor.elevator.car, kit = floorKitScale(native);
  assert.equal(riderSpot(car, 0, kit).left, car.x + car.w / 2);
  assert.equal(riderSpot(car, 0, kit).left, 480);
  assert.equal(riderSpot(car, 0, kit).rise, 12 * kit);
  assert.equal(riderSpot(car, 0, kit).rise, 24); // was 18 at x1.5
  assert.ok(riderSpot(car, 1, kit).left > riderSpot(car, 0, kit).left && riderSpot(car, 2, kit).left < riderSpot(car, 0, kit).left, "extra riders step either side");
  // the open-lift cover is the whole door rect: no 6px closed-door strip left under it
  assert.doesNotMatch(comp, /doorA\.h - 6|car\.h - 6/);
  assert.match(comp, /width: w, height: doorA\.h \}\}/);
  assert.match(comp, /height: car\.h \}\}/);
  assert.match(css, /--ride-rise: 12px;/); // only the fallback; SquadFloor sets it per floor from the kit scale
  assert.match(comp, /"--ride-rise": `\$\{spot\.rise\}px`/);
});

test("hit 5: the cursor shows on hover as well as keyboard focus", () => {
  assert.match(comp, /onMouseEnter/);
  assert.match(comp, /matches\(":focus-visible"\)/);
});

test("FT: 11 desks per team in rows 4/3/4 by y; spreadNeighbours follows the floor rows, not a fixed 3", () => {
  for (const t of [floor.teamA, floor.teamB]) {
    assert.equal(t.desks.length, 11);
    const rows = [];
    for (const d of t.desks) (rows.at(-1)?.y === d.y ? rows.at(-1) : rows[rows.push({ y: d.y, n: 0 }) - 1]).n++;
    assert.deepEqual(rows.map((r) => r.n), [4, 3, 4]);
    assert.ok(t.desks.every((d) => d.w === 64 && d.h === 64));
  }
  const mate = deskRowMate(floor.teamA.desks);
  assert.deepEqual([0, 1, 3, 4, 6, 7, 10].map(mate), [false, true, true, false, true, false, true]);
  const key = (x) => x.k;
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i, k: "a" }));
  items[4].k = "b";
  // slot 1 shares slot 0's row, so the lone "b" is pulled up beside the first "a"
  assert.deepEqual(spreadNeighbours(items, key, mate).map((x) => x.id), [0, 4, 1, 2, 3]);
});
