// G8f: the left TV ends on the Overlord's face while his chat is open; sky chat panels drop the agent header.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { skyLeftBot, takeoverLanded, skyFaceClick, skyExit } from "../src/skyZonesLogic.ts";

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
  assert.match(z, /className="sky-crt-name"/);
  assert.match(z, /sky-chat-close/);
});
