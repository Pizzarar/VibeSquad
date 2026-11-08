// G8f: the left TV ends on the Overlord's face while his chat is open; sky chat panels drop the agent header.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { skyLeftBot, takeoverLanded, skyFaceClick, skyExit, validateTakeoverLabel, takeoverLabelStyle, TAKEOVER_LABEL_URL, takeoverVisible } from "../src/skyZonesLogic.ts";

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
  assert.match(z, /const shown = skyLeftBot\(landed\)/);
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
  assert.match(z, /labelArt \? <span className=\{`sky-label-scrawl is-art/);
  assert.match(z, /sky-label-scrawl\$\{struck \? " is-on" : ""\}[^>]*>OVERLORD</);
  const css = src("styles.css");
  assert.match(css, /\.sky-crt-name\.is-struck:not\(\.has-art\) \.sky-crt-name-text \{ text-decoration: line-through/);
  assert.match(css, /\.sky-crt-name\.is-still \.sky-label-scrawl \{ transition: none; \}/);
  // the face-overlay clock is the same one (hook lives in Zone)
  assert.match(z, /function useTakeoverState/);
});

test("T1 takeover-label.json: size + anchor, flat or nested; invalid -> no sticker", () => {
  assert.deepEqual(validateTakeoverLabel({ w: 60, h: 20 }), { ok: true, value: { w: 60, h: 20, x: 0, y: 0 } });
  assert.deepEqual(validateTakeoverLabel({ w: 60, h: 20, x: -4, y: 2 }).value, { w: 60, h: 20, x: -4, y: 2 });
  assert.deepEqual(validateTakeoverLabel({ size: { w: 70, h: 24 }, anchor: { x: 1, y: -3 } }).value, { w: 70, h: 24, x: 1, y: -3 });
  for (const bad of [null, 5, {}, { w: 0, h: 10 }, { w: 10, h: -1 }, { w: 10, h: 10, x: "a" }]) assert.equal(validateTakeoverLabel(bad).ok, false, JSON.stringify(bad));
});

test("T1 sticker style: json box when given, else the chip box; URL per theme", () => {
  assert.equal(TAKEOVER_LABEL_URL("dark"), "/office/takeover-label-dark.png");
  assert.equal(TAKEOVER_LABEL_URL("light"), "/office/takeover-label-light.png");
  const u = TAKEOVER_LABEL_URL("dark");
  assert.deepEqual(takeoverLabelStyle(null, u), { backgroundImage: `url(${u})` });
  assert.deepEqual(takeoverLabelStyle({ w: 60, h: 20, x: -4, y: 2 }, u), { backgroundImage: `url(${u})`, left: -4, top: 2, width: 60, height: 20, right: "auto", bottom: "auto" });
});

test("T1 gate: the label follows takeoverVisible (in while playing/expanded, out once reversed, never under reduced motion's clock)", () => {
  assert.equal(takeoverVisible(0, true, false), true);
  assert.equal(takeoverVisible(5, false, false), true); // reversing
  assert.equal(takeoverVisible(0, false, false), false);
  assert.equal(takeoverVisible(0, true, true), false); // reduced: the label uses `taken` directly (end state at once)
});
