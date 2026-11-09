// Chips C2 (PLAN_PROJECT_CHIPS_WORKFLOWS): the Perfection angel in a shared SkyZones bezel at the top of the Usage panel.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { faceFrame, validateFaces } from "../src/squadFloorLogic.ts";
import { crispScale, faceContain, angelCssScale, angelDeviceScale, cloudStripStyle, SKY_CLOUDS_URL, validateSkyClouds } from "../src/skyZonesLogic.ts";
import { perfectionPin } from "../src/pins.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const pub = (f) => JSON.parse(readFileSync(new URL(`../public/office/${f}`, import.meta.url), "utf8"));

test("faces.json: angel validates (keys read from json), hover mode is parsed", () => {
  const raw = pub("faces.json");
  const v = validateFaces(raw);
  assert.ok(v.ok, v.error);
  const a = v.value.bots.angel;
  assert.equal(a.idle.length, raw.angel.idle.length);
  assert.equal(a.hover.length, raw.angel.hover.length);
  assert.deepEqual(faceFrame(v.value, "angel", "hover", 1), raw.angel.hover[1]);
  assert.deepEqual(faceFrame(v.value, "angel", "idle", 0), raw.angel.idle[0]);
  assert.deepEqual(v.value.bg.angel, raw.angel.bg);
});

test("sky-clouds.json: validates, cloud strip is x-repeat, bottom-aligned, at the face's integer scale on the top colour", () => {
  const raw = pub("sky-clouds.json");
  const v = validateSkyClouds(raw);
  assert.ok(v.ok, v.error);
  assert.equal(validateSkyClouds({ w: 0, h: 4 }).ok, false);
  assert.equal(SKY_CLOUDS_URL("dark"), "/office/sky-clouds-dark.png");
  const s = cloudStripStyle(v.value, "light", 5, "/office/sky-clouds-light.png");
  assert.equal(s.backgroundColor, raw.top.light);
  assert.equal(s.backgroundSize, `${raw.w * 5}px ${raw.h * 5}px`);
  assert.equal(s.backgroundRepeat, "repeat-x");
  assert.equal(s.backgroundPosition, "left bottom");
  assert.equal(s.imageRendering, "pixelated");
  assert.equal(cloudStripStyle(v.value, "dark", 5, null).backgroundImage, undefined, "skip-if-absent: colour only");
});

test("perfectionPin: the audit lane pin of the first Squad that has one (hidden lanes included), else null", () => {
  const lane = (id, kind) => ({ lane: { id, name: id, kind }, members: [], brainstorm: null, lead: null });
  const view = (id, lanes) => ({ team: { id, name: id, lanes: lanes.map((l) => l.lane) }, lanes, members: [] });
  const views = [view("a", [lane("main")]), view("vs", [lane("main"), lane("perfection", "audit")])];
  const p = perfectionPin(views);
  assert.equal(p?.lane.id, "perfection");
  assert.equal(p?.squad.id, "vs");
  assert.equal(perfectionPin([views[0]]), null);
  assert.equal(perfectionPin([]), null);
});

test("extraction: SkyZones keeps its Riff/Overlord line verbatim and shares FaceStage + the bezel hook with the angel", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("const shown = isRiff ? skyLeftBot(landed) : zone.bot;"));
  assert.match(sky, /export function FaceStage\(/);
  assert.match(sky, /export function useSkyBezel\(/);
  assert.match(sky, /<FaceStage\b/);
  const angel = src("AngelBezel.tsx");
  assert.match(angel, /from "\.\/SkyZones"/);
  assert.match(angel, /<FaceStage /);
  assert.match(angel, /useSkyBezel\(/);
});

test("angel button: a real button with an aria-label, hover mode, reduced-motion safe; mounted above the Usage panel", () => {
  const a = src("AngelBezel.tsx");
  assert.match(a, /<button[^>]*type="button"[^>]*data-testid="angel-hit"/s);
  assert.match(a, /aria-label=/);
  assert.match(a, /"hover"/);
  assert.match(a, /onClick=/);
  const u = src("UsageDashboard.tsx");
  assert.match(u, /<AngelBezel /);
  assert.ok(u.indexOf("<AngelBezel ") < u.indexOf("<TriageCrt "), "angel sits above the triage CRT / usage");
  assert.match(src("PinGrid.tsx"), /perfectionPin\(views\)/);
});

test("angel scale is in DEVICE px: 6 at 4K@1.2, 4 at 1080, 2 at 720; css = device / dpr", () => {
  assert.equal(angelDeviceScale(2667, 1500, 1.2), 6);
  assert.equal(angelCssScale(2667, 1500, 1.2), 5);
  assert.equal(angelDeviceScale(1920, 1080, 1), 4);
  assert.equal(angelCssScale(1920, 1080, 1), 4);
  assert.equal(angelDeviceScale(1280, 720, 1), 2);
  // compact strips: 49 art px (1 px headroom) + 2px borders
  assert.ok(49 * 5 + 4 <= 260 && 49 * 4 + 4 <= 200);
  const css = src("styles.css");
  assert.ok(css.includes("height: calc(49px * var(--angel-k))"));
  assert.doesNotMatch(css, /@media[^{]*\{ \.angel-strip \{ --angel-k/, "scale comes from device px, not css media queries");
  assert.ok(src("AngelBezel.tsx").includes("useAngelScale(dpr, zoom)"));
});

test("angel scale snaps to whole DEVICE px under the root UI zoom (UI 100/125/150 x dpr 1/1.2)", () => {
  for (const zoom of [1, 1.25, 1.5]) for (const dpr of [1, 1.2]) {
    const eff = dpr * zoom; // html zoom: 1 css px = dpr x zoom device px
    for (const [w, h] of [[2667, 1500], [1920, 1080], [1280, 720]]) {
      const dev = angelDeviceScale(w, h, dpr);
      assert.equal(Number.isInteger(dev), true);
      const css = angelCssScale(w, h, dpr, zoom);
      assert.ok(Math.abs(css * eff - dev) < 1e-9, `${w}x${h} dpr ${dpr} UI ${zoom}: ${css * eff} device px per art px`);
    }
    // the face inside a width-clamped stage and the scale-1 bezel border snap with the same effective ratio
    const { k } = faceContain({ w: 80, h: 48 }, { w: 330, h: 49 * 4 }, eff);
    assert.ok(Math.abs(Math.round(k * eff) - k * eff) < 1e-9, `face k ${k} at ratio ${eff}`);
    assert.ok(Math.abs(crispScale(1, eff) * eff - 1) < 1e-9, "border is exactly 1 device px per art px");
  }
  const a = src("AngelBezel.tsx");
  assert.ok(a.includes("useUiScale()") && a.includes("useSkyBezel(1, ratio)") && a.includes("ratio={ratio}"));
});

test("css: the strip defines its own sky vars + light fallback bg (they are scoped to .sky-zones otherwise)", () => {
  const css = src("styles.css");
  assert.match(css, /\.angel-strip \{[^}]*--sky-face-bg-dark: #2a1b6b; --sky-face-bg-light: #95d3f2;/);
  assert.ok(css.includes(':root[data-theme="light"] .angel-strip { background-color: var(--sky-face-bg-light)'));
});
