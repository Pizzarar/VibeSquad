import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fitSignText, signTextWidth, validateFloor, floorCounterText } from "../src/squadFloorLogic.ts";
import { CHROME_FONT_SMALL, chromeSmallAdvance, chromeSmallGlyphStyle } from "../src/chromeFont.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const comp = read("src/SquadFloor.tsx");
const css = read("src/styles.css");
const floorJson = JSON.parse(read("public/office/floor.json"));
const adv = chromeSmallAdvance;
const SIGN_W = 74;

test("HP6 floor.json slots parse generically and are skip-if-absent", () => {
  const v = validateFloor(floorJson);
  assert.ok(v.ok);
  // FF: the values come from floor.json (x1.5 art), not constants here
  assert.deepEqual(v.value.teamA.sign, floorJson.teamA.sign);
  assert.deepEqual(v.value.teamB.sign, floorJson.teamB.sign);
  assert.deepEqual(v.value.elevator.counter, floorJson.elevator.counter);
  assert.deepEqual(v.value.elevator.callPrev, floorJson.elevator.callPrev);
  assert.deepEqual(v.value.elevator.callNext, floorJson.elevator.callNext);
  assert.equal(v.value.elevator.car.y, floorJson.elevator.car.y);
  const bare = structuredClone(floorJson);
  delete bare.teamA.sign;
  delete bare.elevator.counter;
  bare.elevator.callPrev = { x: 1, y: 1, w: 0, h: 0 };
  const w = validateFloor(bare);
  assert.ok(w.ok);
  assert.equal(w.value.teamA.sign, undefined);
  assert.equal(w.value.elevator.counter, undefined);
  assert.equal(w.value.elevator.callPrev, undefined);
});

test("HP6 counter text goes into the elevator.counter slot, one number on screen", () => {
  assert.match(comp, /\{floorCounterText\(current\)\}/);
  assert.equal((comp.match(/floorCounterText\(current\)\}\n/g) ?? []).length, 1);
  assert.match(comp, /data-testid="sq-floor-counter"[^>]*style=\{at\(counter\)\}/);
  assert.match(comp, /const at = \(r: Rect\): CSSProperties => \(\{ left: r\.x, top: r\.y, width: r\.w, height: r\.h \}\)/);
  assert.equal(floorCounterText(6), "07");
  assert.doesNotMatch(comp, /className="sq-floor-lift"[^>]*style=/); // no floating box
});

test("HP6 call buttons sit on the callPrev/callNext slots and keep testids, aria, keys, goRef, has-needs", () => {
  assert.match(comp, /data-testid="sq-floor-prev"[\s\S]*?style=\{at\(callPrev\)\}/);
  assert.match(comp, /data-testid="sq-floor-next"[\s\S]*?style=\{at\(callNext\)\}/);
  assert.match(comp, /onPrev=\{\(\) => goRef\.current\(-1\)\} onNext=\{\(\) => goRef\.current\(1\)\}/);
  assert.match(comp, /arrows\.prev \? " has-needs"/);
  assert.match(comp, /aria-label=\{arrows\.next \? "Next floor \(someone needs you down there\)" : "Next floor"\}/);
  assert.match(css, /\.sq-floor-arrow \{[^}]*position: absolute;/);
  assert.match(css, /\.sq-floor-arrow\.has-needs \{[^}]*animation: sq-floor-call-lit/);
});

test("HP6 sign fit: short name natural, long name tightens one step then ellipsis, empty is empty", () => {
  const short = fitSignText("Riff", SIGN_W, adv);
  assert.deepEqual(short, { text: "RIFF", track: 0, ellipsis: false });
  const full = fitSignText("VibeSquad", SIGN_W, adv);
  assert.equal(full.ellipsis, false);
  assert.ok(signTextWidth(full.text, adv, full.track) <= SIGN_W - 4);
  const tight = fitSignText("HYPERDESKS", SIGN_W, adv); // 70px natural-ish: needs the tighter step
  assert.equal(tight.ellipsis, false);
  assert.equal(tight.track, -1);
  const long = fitSignText("The Very Long Team Name Of Doom", SIGN_W, adv);
  assert.equal(long.ellipsis, true);
  assert.equal(long.track, -1);
  assert.match(long.text, /^[A-Z ]+\.\.\.$/);
  assert.ok(signTextWidth(long.text, adv, long.track) <= SIGN_W - 4);
  assert.deepEqual(fitSignText("   ", SIGN_W, adv), { text: "", track: 0, ellipsis: false });
  assert.deepEqual(fitSignText("", SIGN_W, adv), { text: "", track: 0, ellipsis: false });
  assert.equal(fitSignText("VACANT", SIGN_W, adv).ellipsis, false);
  assert.equal(fitSignText("x".repeat(60), 20, adv).text.endsWith("..."), true); // never empty on a tiny plate
});

test("HP6 signs: full name in the tooltip, empty B shows VACANT, glyphs are integer plate px", () => {
  assert.match(comp, /title=\{vacant \? "No team on this side" : name\}/);
  assert.match(comp, /name=\{f\.teamB \? f\.teamB\.name : null\}/);
  assert.match(comp, /const label = vacant \? "VACANT" : name;/);
  for (const ch of "AW I-.?") {
    const st = chromeSmallGlyphStyle(ch, -1);
    assert.ok(Number.isInteger(st.width) && Number.isInteger(st.height) && Number.isInteger(st.marginRight));
  }
  assert.equal(CHROME_FONT_SMALL.glyphs.A.length, 5);
  const j = JSON.parse(read("public/ui/u3/font-chrome-small.json"));
  for (const [k, g] of Object.entries(j.glyphs)) assert.deepEqual(CHROME_FONT_SMALL.glyphs[k], [g.x, g.y, g.w, g.h, g.advance], k);
  assert.match(css, /\.sq-floor-sign-glyph \{[^}]*image-rendering: pixelated/);
});

test("HP6 lift opens while someone rides, and the rider starts at the car's new bottom", () => {
  assert.match(comp, /riders\.some\(\(r\) => r\.floor === f\.index\) && <LiftOpen /);
  assert.match(comp, /top: elevator\.y \+ elevator\.h - 2/);
  assert.match(comp, /ridersOn\(f\.index, floor\.elevator\.car\)/);
  assert.match(css, /\.sq-floor-lift-open \{[^}]*position: absolute/);
  assert.match(css, /to \{ transform: translate\(-50%, calc\(-100% - 12px\)\); opacity: 0\.2; \}/); // stays inside the doorway
  assert.ok(floorJson.elevator.car.y > 0);
  // the open doors sit under the sprites (wall slot), the jambs + threshold front layer stays on top
  assert.match(comp, /wall=\{[\s\S]*?<LiftOpen[\s\S]*?\}\n\s+extras=/);
});
