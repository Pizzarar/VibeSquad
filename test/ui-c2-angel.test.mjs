// Chips C2 (PLAN_PROJECT_CHIPS_WORKFLOWS): the Perfection angel in a shared SkyZones bezel at the top of the Usage panel.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { faceFrame, validateFaces } from "../src/squadFloorLogic.ts";
import { cloudStripStyle, SKY_CLOUDS_URL, validateSkyClouds } from "../src/skyZonesLogic.ts";
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

test("css: compact strip height from the angel scale, no massive scroll", () => {
  const css = src("styles.css");
  assert.match(css, /\.angel-strip\b/);
  assert.match(css, /--angel-k:\s*5/);
  assert.match(css, /--angel-k:\s*7/);
  assert.match(css, /image-rendering: pixelated/);
});
