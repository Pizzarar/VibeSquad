import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const icon = JSON.parse(read("public/ui/bug-icon.json"));
const frames = 1 + icon.keys.twitch.length;
const pct = (x) => `${(x / (icon.frame.w * (frames - 1))) * 100}%`;

test("bug chip: sheet files exist for every theme at 16px and 32px native", () => {
  for (const t of icon.themes) {
    for (const [f, w] of [[`bug-roach-${t}.png`, icon.frame.w * frames], [`bug-roach-${t}@2x.png`, icon.frame.w2x * frames]]) {
      assert.equal(readFileSync(resolve(ROOT, "public/ui", f)).readUInt32BE(16), w, f);
    }
  }
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(resolve(ROOT, "src")).href)) {
      const ts = resolve(dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
      if (fs.existsSync(ts)) return nextResolve(pathToFileURL(ts).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { bugRoachSheetSrc, chipIconSrc } = await import("../src/pins.ts");

test("sheet pick: native size divides the device target by a whole integer (32/48/64/80/96), roach and chip share the rule", () => {
  for (const [dev, at2x] of [[16, false], [32, true], [48, false], [64, true], [80, false], [96, true]]) {
    const roach = bugRoachSheetSrc("dark", dev);
    const chip = chipIconSrc("bugs", "dark", dev).src;
    assert.equal(roach.includes("@2x"), at2x, `roach ${dev}`);
    assert.equal(chip.includes("@2x"), at2x, `chip ${dev}`);
    assert.equal(dev % (roach.includes("@2x") ? 32 : 16), 0);
  }
  assert.equal(bugRoachSheetSrc("light", 48), "/ui/bug-roach-light.png");
  assert.equal(bugRoachSheetSrc("dark", 64), "/ui/bug-roach-dark@2x.png");
});

test("bug chip css: compact padding and gap", () => {
  const css = read("src/BugButton.css");
  assert.match(css, /\.bug-btn \{[^}]*gap: 4px[^}]*padding: 0 6px/);
});

test("bug chip tsx: count hidden at 0 (aria-label keeps the number), shown from 1", () => {
  const tsx = read("src/BugButton.tsx");
  assert.match(tsx, /counts\.total > 0 && <span className="bug-btn-n">\{counts\.total\}<\/span>/);
  assert.match(tsx, /aria-label=\{`Bug Runner, \$\{counts\.total\} open, \$\{counts\.unseen\} new`\}/);
});
