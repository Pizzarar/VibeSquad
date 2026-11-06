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
const { initials } = await import(pathToFileURL(join(dir, "pixel.mjs")).href);

test("initials: multi-word, camelCase and separators", () => {
  assert.equal(initials("Escape From Idle"), "EF");
  assert.equal(initials("VibeSquad"), "VS");
  assert.equal(initials("paseo-agent-board"), "PA");
  assert.equal(initials("snake_case_name"), "SC");
});

test("initials: single word, empty, small size", () => {
  assert.equal(initials("Pillbille"), "P");
  assert.equal(initials(""), "?");
  assert.equal(initials("  - "), "?");
  assert.equal(initials("Escape From Idle", 14), "E");
});

test("NeonEmblem is gone", () => {
  assert.ok(!/NeonEmblem|neon-emblem/.test(readFileSync(join(srcDir, "pixel.tsx"), "utf8")));
});
