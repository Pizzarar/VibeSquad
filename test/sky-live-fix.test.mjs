// C2b live-fix: the sky zone is chat-only (no dock tabs) and the face is measured above the chat, not under it.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { faceContain } from "../src/skyZonesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("chat-only: SkyZones mounts DrawerSlot with chatOnly, which reaches AgentDrawer", () => {
  assert.match(src("SkyZones.tsx"), /<DrawerSlot [^>]*\bchatOnly\b/);
  assert.match(src("AgentPanes.tsx"), /chatOnly\??: boolean/);
  assert.match(src("AgentPanes.tsx"), /<AgentDrawer [^>]*chatOnly=\{chatOnly\}/);
  assert.doesNotMatch(src("AgentPanes.tsx").split("export const AgentPanes")[1], /chatOnly/, "the normal agent view stays full");
});

test("chat-only: AgentDrawer never opens, persists or listens for the right dock", () => {
  const d = src("AgentDrawer.tsx");
  assert.match(d, /useState\(\(\) => !chatOnly && localStorage\.getItem\("vs\.right-dock\.open"\) === "true"\)/);
  assert.match(d, /if \(!chatOnly\) localStorage\.setItem\("vs\.right-dock\.open"/);
  assert.match(d, /if \(chatOnly\) return;\s*\n\s*const onOpenDock/);
  assert.match(d, /\{dockOpen && !chatOnly && \(/);
});

test("G8: the face box is the whole TV screen (no chat-height cut); the chat lives in its own panel over the right TV", () => {
  const css = src("styles.css");
  assert.doesNotMatch(css, /--sky-chat-h/);
  assert.match(css, /.sky-face-area { position: absolute; inset: 0; }/);
  assert.match(src("SkyZones.tsx"), /ref={stage} className="sky-face-area"/);
  // 4K@120% TV ~ 1200x640 css px: the whole screen is the box, so the face scales to the height (k=13 of 640), bottom-anchored.
  const box = { w: 1200, h: 640 };
  const { k, top } = faceContain({ w: 48, h: 48 }, box);
  assert.equal(k, 13);
  assert.ok(48 * k <= box.h && top + 48 * k === box.h);
  const old = faceContain({ w: 48, h: 48 }, { w: 1200, h: Math.round(640 * 0.42) });
  assert.ok(k > old.k, "bigger than the old chat-cut box");
});
