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

test("face box = stage minus the chat's height, whole face above the chat; squeezed Riff uses the whole stage", () => {
  const css = src("styles.css");
  assert.match(css, /--sky-chat-h: 58%/);
  assert.match(css, /\.sky-crt-body \{[^}]*height: var\(--sky-chat-h\)/);
  assert.match(css, /\.sky-face-area \{[^}]*bottom: var\(--sky-chat-h\)/);
  assert.match(css, /\.sky-zones\.is-expanded \.sky-zone-riffbot \.sky-face-area \{ bottom: 0; \}/);
  assert.match(src("SkyZones.tsx"), /ref=\{stage\} className="sky-face-area"/);
  // 4K@120% zone ~ 1200x640 css px: face box is the top 42%, the face fits whole inside it, bottom-anchored at the chat edge.
  const zone = { w: 1200, h: 640 };
  const box = { w: zone.w, h: Math.round(zone.h * 0.42) };
  const { k, top } = faceContain({ w: 48, h: 48 }, box);
  assert.ok(48 * k <= box.h && top + 48 * k === box.h, "never reaches under the chat");
});
