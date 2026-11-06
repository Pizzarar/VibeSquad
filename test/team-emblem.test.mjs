import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { transformSync } from "rolldown/utils";

// pixel.tsx is TypeScript + JSX: transpile it once to a temp .mjs and import that.
const srcDir = resolve(import.meta.dirname, "..", "src");
const code = transformSync("pixel.tsx", readFileSync(join(srcDir, "pixel.tsx"), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } }).code.replace('"./cast"', '"./cast.mjs"');
const dir = mkdtempSync(join(tmpdir(), "vs-team-emblem-"));
writeFileSync(join(dir, "pixel.mjs"), code);
writeFileSync(join(dir, "cast.mjs"), transformSync("cast.ts", readFileSync(join(srcDir, "cast.ts"), "utf8"), { lang: "ts" }).code);
const { initials, inkFor } = await import(pathToFileURL(join(dir, "pixel.mjs")).href);

test("initials: one letter from the first part", () => {
  assert.equal(initials("Escape From Idle"), "E");
  assert.equal(initials("VibeSquad"), "V");
  assert.equal(initials("paseo-agent-board"), "P");
  assert.equal(initials("--foo"), "F");
  assert.equal(initials("Pillbille"), "P");
});

test("initials: empty or separator-only gives ?", () => {
  assert.equal(initials(""), "?");
  assert.equal(initials("  "), "?");
  assert.equal(initials(" - "), "?");
});

test("NeonEmblem is gone", () => {
  assert.ok(!/NeonEmblem|neon-emblem/.test(readFileSync(join(srcDir, "pixel.tsx"), "utf8")));
});

test("inkFor picks the higher-contrast text colour, incl. #rgb", () => {
  assert.equal(inkFor("#777"), "#fff"); // 4.49:1 vs white, 4.07:1 vs #080814
  assert.equal(inkFor("#fff"), "#080814");
  assert.equal(inkFor("#080814"), "#fff");
  assert.equal(inkFor("#e8a33d"), "#080814");
});
