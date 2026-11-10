import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spriteFrame, validateCast } from "../src/squadFloorLogic.ts";

// F2 (src/SquadFloor.tsx) is a React component that imports pinFocus (which has module-level
// side effects), so we assert on its source and on the pure model it consumes, not by importing it.
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const app = src("App.tsx");
const floor = src("SquadFloor.tsx");
const css = src("styles.css");

test("App imports SquadFloor and renders it only on the hub page", () => {
  assert.match(app, /import \{ SquadFloor \} from "\.\/SquadFloor";/);
  // Rendered exactly once, inside the hubFocused .hub-body branch (next to the Needs-you queue).
  assert.equal((app.match(/<SquadFloor /g) || []).length, 1);
  assert.match(app, /hubFocused \? \(/);
  assert.ok(app.includes('<SquadQueue view={pinFocusView} variant="strip" />'));
});

test("SquadFloor opens a character's chat with openPinMember", () => {
  assert.match(floor, /import \{ openPinMember \} from "\.\/pinFocus";/);
  assert.match(floor, /openPinMember\(pin, agentId\)/);
});

test("SquadFloor reads frames from cast.json, not hardcoded constants", () => {
  assert.match(floor, /spriteFrame/);
  assert.match(floor, /validateCast/);
  assert.match(floor, /cast\.cell/);
  assert.match(floor, /cast\.bubble/);
  assert.doesNotMatch(floor, /cell:\s*32/);
  assert.doesNotMatch(floor, /\{\s*x:\s*0,\s*y:\s*0\s*\}/);
});

test("SquadFloor has a reduced-motion branch (freeze on frame 0, no ride)", () => {
  assert.match(floor + src("useBotFace.ts"), /prefers-reduced-motion: reduce/);
  assert.match(floor + src("useBotFace.ts"), /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(floor, /reduced \? 0 : tick/);
  assert.match(floor, /reduced\s*\?\s*\[\]/);
});

test("SquadFloor falls back to the F1 placeholder when art fetch fails", () => {
  assert.match(floor, /floorOrPlaceholder\(floorJson\)/);
  assert.match(floor, /placeholderFloor/);
  assert.match(floor, /\.catch\(\(\) => undefined\)/);
  assert.match(floor, /r\.ok \? r\.json\(\) : undefined/);
  assert.match(floor + src("useBotFace.ts"), /new Image\(\)/);
});

test("SquadFloor reuses the F1 tower model, not a duplicate", () => {
  assert.match(floor, /buildTower\(/);
  assert.match(floor, /transitionRiders\(/);
  assert.match(floor, /floorFitScale\(box\.w, box\.h, dpr, native\.w, native\.h, uiZoom\)/);
  assert.match(floor, /sliceAnchor\(/);
});

test("scoped sq-floor-* styles live in styles.css with pixelated rendering", () => {
  assert.match(css, /\.sq-floor \{/);
  assert.match(css, /\.sq-floor-mark \{/);
  assert.match(css, /image-rendering: pixelated/);
});

test("hub page nests the floor in .hub-body — no app-grid row override (banner-safe)", () => {
  // App wraps the chat + queue + floor in a nested .hub-body grid item.
  assert.match(app, /data-testid="hub-body"/);
  assert.match(css, /\.hub-body \{/);
  // The app-level hub-focus grid must not define its own rows (that clashed with :has([role="alert"])).
  assert.doesNotMatch(css, /\.app\.pin-focus\.hub-focus[^{]*\{[^}]*grid-template-rows/);
  // .hub-body itself must not pin an explicit app-grid row (mirror master: column only, auto row).
  assert.doesNotMatch(css, /\.hub-body\s*\{[^}]*grid-row/);
  assert.doesNotMatch(css, /grid-row:\s*1\s*\/\s*3/);
  // The floor, queue and chat are positioned inside the nested grid.
  assert.match(css, /\.hub-body \.sq-floor/);
  assert.match(css, /\.hub-body \.sq-panel/);
  assert.match(css, /\.hub-body \.agent-panes/);
});

test("sprite frames for the shipped cast.json resolve from the json (no constants)", () => {
  const castJson = JSON.parse(readFileSync(new URL("../public/office/cast.json", import.meta.url), "utf8"));
  const cast = validateCast(castJson);
  assert.equal(cast.ok, true);
  const c = cast.value;
  // The lead's needs cell comes straight off the sheet, and the bubble sits left of the anchor.
  const needs = spriteFrame(c, "lead", "needs", 0);
  assert.deepEqual(needs, c.roles.lead.needs[0]);
  assert.ok(needs.x % c.cell === 0);
  assert.ok(c.bubble.offset.x < 0);
});

test("C2b G2: tower has no top band / CRT screens; faces live in the shared useBotFace hook", () => {
  for (const gone of ["floor.screens", "topBand", "ROOF_", "<Crt", "sq-floor-crt", "sq-floor-" + "lounge", "faces.json", "onOpenRiffBot"]) {
    assert.ok(!floor.includes(gone), gone);
  }
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes("export function useBotFace("));
  assert.ok(hook.includes("faces.json"));
  assert.ok(hook.includes("reduced"));
});

test("floor placeholders: no boxes while the art loads, boxes only on error; front/cursor start with the JSON; floor.json fetched once", () => {
  assert.match(floor, /const floorArt = useImageState\(FLOOR_URL\(theme\)\);/);
  assert.match(floor, /floorArt === "ok" \? \([\s\S]*?\) : floorArt === "error" \? \(\s*floorBoxes\s*\) : null/);
  assert.ok(!/floorImgOk/.test(floor), "no loading-time fallback boxes");
  assert.match(floor, /img\.onerror = \(\) => alive && setState\(\{ url, s: "error" \}\)/);
  // theme URLs probed unconditionally: no JSON -> image waterfall
  assert.match(floor, /useImageOk\(FLOOR_FRONT_URL\(theme\)\)/);
  assert.match(floor, /const floorFrontOk = floorFrontImgOk && !!floor\.front;/);
  assert.match(floor, /useImageOk\(CURSOR_URL\(theme\)\)/);
  // one shared floor.json promise
  const logic = src("squadFloorLogic.ts");
  assert.equal((logic.match(/fetch\("\/office\/floor\.json"\)/g) || []).length, 1);
  assert.ok(!/fetch\("\/office\/floor\.json"\)/.test(floor) && !/fetch\("\/office\/floor\.json"\)/.test(src("HubPages.tsx")));
  assert.match(floor, /fetchFloorJson\(\),/);
  assert.match(src("HubPages.tsx"), /fetchFloorJson\(\)\.then/);
});

test("fetchFloorJson dedupes concurrent calls and retries after a failure", async () => {
  const { fetchFloorJson } = await import("../src/squadFloorLogic.ts");
  const orig = globalThis.fetch;
  let calls = 0;
  let ok = false;
  globalThis.fetch = async () => {
    calls++;
    return ok ? { ok: true, json: async () => ({ a: 1 }) } : { ok: false };
  };
  try {
    const [a, b] = await Promise.all([fetchFloorJson(), fetchFloorJson()]);
    assert.equal(calls, 1);
    assert.equal(a, undefined);
    assert.equal(b, undefined);
    await Promise.resolve();
    ok = true;
    assert.deepEqual(await fetchFloorJson(), { a: 1 });
    await fetchFloorJson();
    assert.equal(calls, 2, "success cached");
  } finally {
    globalThis.fetch = orig;
  }
});

test("floor first paint: no cast fallback while loading (error only), stage hidden until floor.json known, cached remount sizes synchronously", async () => {
  assert.match(floor, /const castArt = useImageState\(CAST_URL\(theme\)\);/);
  assert.match(floor, /const charsReady = jsonDone && castArt !== "loading";/);
  assert.match(floor, /items=\{!charsReady \? \[\] : \[/); // seats (and their .sq-floor-sprite-fallback) only once settled
  assert.match(floor, /!charsReady \? null : riders/);
  assert.match(floor, /useState<FloorModel>\(\(\) => floorOrPlaceholder\(peekFloorJson\(\)\.json\)\)/);
  assert.match(floor, /useState\(\(\) => peekFloorJson\(\)\.settled\)/);
  assert.match(floor, /className="sq-floor-stage" ref=\{stageRef\} style=\{floorKnown \? undefined : \{ visibility: "hidden" \}\}/);
  assert.match(src("HubPages.tsx"), /floorOrPlaceholder\(peekFloorJson\(\)\.json\)/);
  assert.match(floor, /scale > 0 &&/); // SS5 integer device-px scale untouched
  const { fetchFloorJson, peekFloorJson, floorNativeSize, floorOrPlaceholder } = await import("../src/squadFloorLogic.ts");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ plate: { w: 960, h: 444 } }) });
  try {
    await fetchFloorJson();
    const peek = peekFloorJson();
    assert.equal(peek.settled, true);
    assert.deepEqual(floorNativeSize(floorOrPlaceholder(peek.json)), floorNativeSize(floorOrPlaceholder(await fetchFloorJson())), "remount native size == settled size from first render");
  } finally {
    globalThis.fetch = orig;
  }
});
