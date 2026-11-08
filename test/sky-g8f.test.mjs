// G8f: the left TV ends on the Overlord's face while his chat is open; sky chat panels drop the agent header.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { skyLeftBot, takeoverLanded, skyFaceClick, skyExit, validateTakeoverLabel, takeoverLabelGeom, TAKEOVER_LABEL_URL, takeoverVisible } from "../src/skyZonesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const can = { riffbot: true, overlord: true };

test("left TV bot: riffbot at rest and mid-takeover, overlord once landed, riffbot again after close", () => {
  const n = 12;
  let open = null;
  assert.equal(skyLeftBot(takeoverLanded(0, open === "overlord", n, false)), "riffbot");
  open = skyFaceClick(open, "overlord", can);
  assert.equal(open, "overlord");
  assert.equal(skyLeftBot(takeoverLanded(5, true, n, false)), "riffbot", "mid-takeover: still Riff (scared) under the overlay");
  assert.equal(skyLeftBot(takeoverLanded(n, true, n, false)), "overlord", "settled: Overlord's face");
  // close: expanded flips off, pos starts reversing from n → Riff straight away, overlay plays out
  open = skyExit(open);
  assert.equal(skyLeftBot(takeoverLanded(n, open === "overlord", n, false)), "riffbot");
  assert.equal(skyLeftBot(takeoverLanded(0, false, n, false)), "riffbot");
});

test("reduced motion: instant swap, no overlay in between", () => {
  assert.equal(skyLeftBot(takeoverLanded(0, true, 12, true)), "overlord");
  assert.equal(skyLeftBot(takeoverLanded(0, false, 12, true)), "riffbot");
  assert.equal(skyLeftBot(takeoverLanded(0, true, 0, true)), "overlord");
});

test("Riff open never lands the Overlord on the left TV", () => {
  assert.equal(skyLeftBot(takeoverLanded(0, "riffbot" === "overlord", 12, false)), "riffbot");
});

test("ZoneFace wires it: the shown bot drives useBotFace + the bg, Overlord's pose when landed, overlay hidden once landed", () => {
  const z = src("SkyZones.tsx");
  assert.match(z, /const shown = isRiff \? skyLeftBot\(landed\) : zone\.bot/);
  assert.match(z, /useBotFace\(shown, shownZone\.pose/);
  assert.match(z, /faceBg\(faces, shown, theme\)/);
  assert.match(z, /showSheet && !landed && sheet/);
  assert.match(z, /lander=\{zones\.overlord\}/);
});

test("sky panels strip the agent header; the normal view keeps it", () => {
  const h = src("DrawerHeader.tsx");
  assert.match(h, /if \(chatOnly\) return null;\s*\n\s*return \(\s*\n\s*<>\s*\n\s*\{header\}\s*\n\s*\{inspector\}/);
  assert.match(src("AgentDrawer.tsx"), /chatOnly=\{chatOnly\}\s*\n\s*\/>/);
  assert.doesNotMatch(src("AgentPanes.tsx").split("export const AgentPanes")[1], /chatOnly/);
  // the zone still owns name + close
  const z = src("SkyZones.tsx");
  assert.match(z, /className={`sky-crt-name/);
  assert.match(z, /sky-chat-close/);
});

test("T1 label: struck through + OVERLORD scrawled while the takeover is on (same clock), aria-label, art path and CSS fallback", () => {
  const z = src("SkyZones.tsx");
  // on = in with the takeover (clock-gated via takeoverVisible), reversed when it ends; reduced motion shows the end state at once
  assert.match(z, /const struck = scrawl && \(reduced \? taken : takeoverVisible\(tks\.clock\.pos, taken, reduced\)\)/);
  assert.match(z, /aria-label=\{scrawl \? \(struck \? "Overlord \(takeover\)" : label\) : undefined\}/);
  assert.match(z, /sky-crt-name-text/);
  // image-present path: sticker overlay from the PNG, sized by takeover-label.json; absent PNG/json -> CSS scrawl text
  assert.match(z, /useImageOk\(scrawl && labelModel \? TAKEOVER_LABEL_URL\(theme\) : null\)/);
    assert.match(z, /sky-label-scrawl\$\{struck \? " is-on" : ""\}[^>]*>OVERLORD</);
  const css = src("styles.css");
  assert.match(css, /\.sky-crt-name\.is-struck:not\(\.has-art\) \.sky-crt-name-text \{ text-decoration: line-through/);
  assert.match(css, /\.sky-crt-name\.is-still \.sky-label-scrawl \{ transition: none; \}/);
  // the face-overlay clock is the same one (hook lives in Zone)
  assert.match(z, /function useTakeoverState/);
});

const ART_JSON = {"version":1,"w":118,"h":16,"scale":2,"anchor":{"chip":[0,0.5],"at":[2,10]},"chip":{"w":80,"h":22}};
const CHIP = { left: 12, top: 8, width: 80, height: 22 }; // the chip's offset box in the zone (offsetLeft/Top, size)

test("T1 takeover-label.json (@art shipped schema): parsed; defaults; invalid -> no sticker", () => {
  const r = validateTakeoverLabel(ART_JSON);
  assert.deepEqual(r.value, { w: 118, h: 16, scale: 2, chip: [0, 0.5], at: [2, 10] });
  assert.deepEqual(validateTakeoverLabel({ w: 10, h: 4 }).value, { w: 10, h: 4, scale: 1, chip: [0, 0.5], at: [0, 0] });
  for (const bad of [null, 5, {}, { w: 0, h: 10 }, { w: 10, h: 10, scale: 0 }, { w: 10, h: 10, anchor: { at: [1] } }, { w: 10, h: 10, anchor: 3 }]) assert.equal(validateTakeoverLabel(bad).ok, false, JSON.stringify(bad));
  assert.equal(JSON.stringify(JSON.parse(readFileSync(new URL("../public/office/takeover-label.json", import.meta.url), "utf8")).anchor), JSON.stringify(ART_JSON.anchor));
});

test("T1 sticker geometry (@art): 1080p -> left 8, top -1, 236x32; 4K@120% -> left 8.33, top 2.5, 196.67x26.67", () => {
  const m = validateTakeoverLabel(ART_JSON).value;
  const g1 = takeoverLabelGeom(m, CHIP, 1);
  assert.deepEqual(g1, { left: 8, top: -1, width: 236, height: 32 });
  const g12 = takeoverLabelGeom(m, CHIP, 1.2);
  assert.equal(g12.left.toFixed(2), "8.33");
  assert.equal(g12.top.toFixed(2), "2.50");
  assert.equal(g12.width.toFixed(2), "196.67");
  assert.equal(g12.height.toFixed(2), "26.67");
  // both snapped to whole device px
  assert.ok(Math.abs(g12.left * 1.2 - Math.round(g12.left * 1.2)) < 1e-9 && Math.abs(g12.top * 1.2 - Math.round(g12.top * 1.2)) < 1e-9);
  assert.equal(TAKEOVER_LABEL_URL("dark"), "/office/takeover-label-dark.png");
  assert.equal(TAKEOVER_LABEL_URL("light"), "/office/takeover-label-light.png");
});

test("T1 sticker wiring: sibling of the chip (same parent, above it), measured chip box, pixelated, inert, gated on struck", () => {
  const z = src("SkyZones.tsx");
  assert.match(z, /takeoverLabelGeom\(labelModel, chipBox, dpr\)/);
  assert.match(z, /\{scrawl && labelArt && geom && \(\s*<span className=\{`sky-label-art\$\{struck \? " is-on" : ""\}/);
  assert.match(z, /!\(labelArt && geom\) && <span className=\{`sky-label-scrawl/); // CSS fallback when json/png missing
  const css = src("styles.css");
  assert.match(css, /\.sky-label-art \{ position: absolute; z-index: 3; pointer-events: none;[^}]*image-rendering: pixelated/);
  assert.match(css, /\.sky-label-art\.is-still \{ transition: none; \}/);
});

test("T1 gate: the label follows takeoverVisible (in while playing/expanded, out once reversed, never under reduced motion's clock)", () => {
  assert.equal(takeoverVisible(0, true, false), true);
  assert.equal(takeoverVisible(5, false, false), true); // reversing
  assert.equal(takeoverVisible(0, false, false), false);
  assert.equal(takeoverVisible(0, true, true), false); // reduced: the label uses `taken` directly (end state at once)
});

test("hotfix: the Overlord's own TV always shows the Overlord (landed is Riff-only, so skyLeftBot must not run for it)", () => {
  const z = src("SkyZones.tsx");
  assert.match(z, /const landed = isRiff && !!lander/, "landed is false for the Overlord zone, which is why skyLeftBot(false) = riffbot leaked");
  assert.match(z, /const shown = isRiff \? skyLeftBot\(landed\) : zone\.bot/, "overlord zone: shown = zone.bot, idle and while the Riff chat is open");
  assert.match(z, /const shownZone = landed && lander \? lander : zone/, "shownZone stays the zone itself unless Riff's TV has landed");
  assert.match(z, /data-face-bot=\{shown\}/);
  assert.match(z, /faceBg\(faces, shown, theme\)/);
});

test("hotfix: the left TV still lands on the Overlord during the takeover", () => {
  assert.equal(skyLeftBot(takeoverLanded(12, true, 12, false)), "overlord");
  assert.equal(skyLeftBot(takeoverLanded(0, true, 12, true)), "overlord");
});
