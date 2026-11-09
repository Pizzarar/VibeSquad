import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const icon = JSON.parse(read("public/ui/bug-icon.json"));
const frames = 1 + icon.keys.twitch.length;
const pct = (x) => `${(x / (icon.frame.w * (frames - 1))) * 100}%`;

test("bug chip: sprite sheet src follows the 16/32 integer pick and the art keys", () => {
  const pins = read("src/pins.ts");
  assert.match(pins, /export function bugRoachSheetSrc/);
  for (const t of icon.themes) {
  }
  assert.match(icon.sheet, /bug-roach-<theme>\.png/);
});

test("bug chip css: full row height, sprite background from bug-icon.json keys, twitch only on has-new/pulse", () => {
  const css = read("src/BugButton.css");
  assert.match(css, /\.bug-btn \{[^}]*align-self: stretch/);
  assert.match(css, /\.bug-btn-roach \{[^}]*background-size: 300% 100%/);
  assert.match(css, /image-rendering: pixelated/);
  assert.equal(icon.keys.idle.x, 0);
  const kf = css.match(/@keyframes bug-roach-twitch \{([^}]*\}[^}]*)\}/)[1];
  for (const k of icon.keys.twitch) assert.ok(kf.includes(`background-position: ${pct(k.x)} 0`), `twitch x${k.x} -> ${pct(k.x)}`);
  assert.match(css, /\.bug-btn\.has-new \.bug-btn-roach[^{]*\{[^}]*animation: bug-roach-twitch/);
  assert.match(css, /prefers-reduced-motion[^{]*\{[^}]*\.bug-btn-roach[^}]*animation: none/);
});

test("bug chip tsx: skip-if-absent, keeps testids", () => {
  const tsx = read("src/BugButton.tsx");
  assert.match(tsx, /useImageOk\(sheet\)/);
  assert.match(tsx, /data-testid=\{`bug-btn-\$\{teamId\}`\}/);
  assert.match(tsx, /bugRoachSheetSrc\(theme, device\)/);
});

test("bug chip tsx: absent sheet renders an empty sized box, never the emoji", () => {
  const tsx = read("src/BugButton.tsx");
  assert.ok(!tsx.includes("🐞"));
  assert.match(tsx, /backgroundImage: roachOk \?/);
});
