// HP1-HP5 (docs/PLAN_HUB_PAGES.md): one hub view (TVs band + one full-height floor) over a shared skyline backdrop.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { backdropScale, backdropStyle, validateHubBackdrop } from "../src/hubPagesLogic.ts";
import { floorFitScale, floorNativeSize, validateFloor } from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const json = JSON.parse(readFileSync(new URL("../public/office/hub-backdrop.json", import.meta.url), "utf8"));
const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v) };
};

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("HP5: no tabs, no mini faces, no page state: the dead code is gone", () => {
  const hp = src("HubPages.tsx");
  const logic = src("hubPagesLogic.ts");
  for (const dead of [/hub-tab/, /tablist/, /MiniFace|hub-mini/, /miniFaceJump|parseHubPage|readHubPage|writeHubPage|HUB_PAGE_KEY|HUB_PAGES/, /useState<HubPage>|setJump|sky\(jump\)/]) {
    assert.doesNotMatch(hp, dead);
    assert.doesNotMatch(logic, dead);
  }
  assert.doesNotMatch(css, /\.hub-(tab|mini|tower-sky|tower-page)/);
  assert.doesNotMatch(src("App.tsx"), /initialOpen=\{open\}/);
});

test("HP5: one view = TVs band, strip, then the floor box that takes the rest of the height", () => {
  const hp = src("HubPages.tsx");
  const order = ["hub-sky-page", "{strip}", "hub-tower-box"].map((k) => hp.indexOf(k, hp.indexOf('data-testid="hub-pages"')));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "TVs, strip, floor in that order");
  assert.equal((hp.match(/\{strip\}/g) || []).length, 2); // the view + the agent-open fallback
  assert.match(hp, /const PLATE_INSET = 0;/); // floor flush on the page bottom, no gap for the backdrop to offset
  assert.match(css, /\.hub-sky-page \{ flex: none;/); // the TVs band keeps its HP2 height
  assert.match(css, /\.hub-tower-box \{ flex: 1; min-height: 0; overflow: hidden/);
  assert.match(css, /\.hub-pages \.hub-tower-box \.sq-floor \{[^}]*height: auto;[^}]*overflow: hidden;[^}]*background: transparent;[^}]*border-top: 0/); // .sq-floor's own navy + cyan border would paint over the skyline gutters
  assert.match(css, /\.hub-tower-box \.sq-floor-stage \{ align-items: flex-end; \}/); // bottom edge flush
  assert.match(css, /\.hub-sky-page \.sky-zones \{ flex: none; height: clamp\(/); // HP2 cap
  assert.doesNotMatch(css, /\.hub-(pages|backdrop)[^{]*\{[^}]*(transition|animation)/);
});

test("HP5: the < n > pager rides the shaft: absolute, centred on the lift car from floor.json, above it", () => {
  const sf = src("SquadFloor.tsx");
  assert.match(sf, /left: \(car\.x \+ car\.w \/ 2\) \* scale, top: car\.y \* scale/);
  assert.match(sf, /data-testid="sq-floor-lift"[^>]*style=\{liftStyle\}/);
  assert.match(css, /\.sq-floor-lift \{ position: absolute;[^}]*translate\(-50%, calc\(-100% - 4px\)\)/);
  assert.match(css, /\.sq-floor-tower \{ position: relative;/);
  assert.doesNotMatch(sf, /FLOOR_NATIVE_(WIDTH|HEIGHT)/); // plate size is read from floor.json (floorNativeSize), not hardcoded
});

test("HP5: plate size comes from floor.json w/h (ground strip cropped), the 640x360 contract when absent; fit never 0", () => {
  const f = JSON.parse(readFileSync(new URL("../public/office/floor.json", import.meta.url), "utf8"));
  const v = validateFloor(f);
  assert.ok(v.ok);
  assert.deepEqual(floorNativeSize(v.value), { w: f.w, h: f.h });
  assert.deepEqual(floorNativeSize({}), { w: 640, h: 360 });
  assert.deepEqual(floorNativeSize(validateFloor({ ...f, w: 0, h: "x" }).value), { w: 640, h: 360 });
  assert.deepEqual(floorNativeSize(validateFloor({ ...f, w: 640, h: 300 }).value), { w: 640, h: 300 });
  // a shorter plate fits a bigger scale into the same box: 1500 css px tall at dpr 1 -> 5x of 300 vs 4x of 360 (width 3200 -> 5x)
  assert.equal(floorFitScale(3200, 1500, 1, 640, 300), 5);
  assert.equal(floorFitScale(3200, 1500, 1), 4);
  for (const [w, h, d] of [[1000, 400, 1.2], [700, 300, 1.2], [3500, 1200, 1.2], [300, 200, 1.2]]) assert.ok(floorFitScale(w, h, d, 640, 300) > 0);
  assert.equal(floorFitScale(0, 400, 1.2, 640, 300), 0);
});

test("backdrop: A1 json validates; tile centre under the tower, bottom row on the plate, repeat-x", () => {
  const m = validateHubBackdrop(json);
  assert.ok(m);
  assert.equal(m.w, 640);
  const st = backdropStyle(m, 1600, "dark", 1, 6);
  assert.equal(st.backgroundRepeat, "repeat-x");
  assert.equal(st.backgroundSize, "1280px 720px"); // 640 native * integer scale 2 (1600 / 640 = 2.5 -> 2)
  assert.equal(st.backgroundPosition, "160px calc(100% - 6px)"); // (1600 - 1280) / 2: tile x=320 sits at the centre line
  assert.equal(st.backgroundColor, json.top.dark);
  assert.equal(backdropStyle(m, 1600, "light").backgroundColor, json.top.light);
  assert.equal(backdropScale(3200, 640, 1.2), Math.floor((3200 * 1.2) / 640) / 1.2);
  assert.equal(backdropScale(500, 640, 1), 1);
});

test("backdrop absent or malformed: validate says null and the fallback band + gradient takes over", () => {
  assert.equal(validateHubBackdrop(undefined), null);
  assert.equal(validateHubBackdrop({ w: 640 }), null);
  assert.equal(validateHubBackdrop({ ...json, repeat: "none" }), null);
  const hp = src("HubPages.tsx");
  assert.match(hp, /if \(model && artOk\) return/);
  assert.match(hp, /hub-backdrop is-fallback/);
  assert.match(hp, /useImageOk\(!artOk \? SKY_URL\(theme\) : null\)/);
  assert.match(css, /\.hub-backdrop\.is-fallback \{ background-image: linear-gradient/);
});

test("regression guard: Riff's TV face swap line is untouched", () => {
  assert.match(src("SkyZones.tsx"), /const shown = isRiff \? skyLeftBot\(landed\) : zone\.bot;/);
  assert.match(src("skyZonesLogic.ts"), /export const SKY_COLUMNS = "minmax\(0, 1fr\) minmax\(0, 1fr\)"/); // fixed 50/50
});
