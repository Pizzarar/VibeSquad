import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("New Squad saves the full absolute path next to the basename", () => {
  const s = src("newSquadDef.ts");
  assert.ok(s.includes("normalized !== folderSegment ? [normalized] : []"));
  assert.ok(s.includes("folderSegment || opts.folderPath.trim(),"));
});

test("disabled Spawn says what is needed; Task/Job marked required", () => {
  const s = src("TeamActions.tsx");
  assert.match(s, /data-testid="spawn-needs"/);
  assert.match(s, /Needs: /);
  assert.match(s, /TASK \(required\)/);
});

test("spawn closes when agent appears, times out readably, Cancel stays enabled", () => {
  const s = src("TeamActions.tsx");
  assert.match(s, /a\.title === spawnedTitle\.current/);
  assert.ok(s.includes("!existingIds.current.has(a.id) && a.title === spawnedTitle.current"));
  assert.ok(s.includes("existingIds.current = new Set(agents.keys())"));
  assert.match(s, /90000/);
  assert.match(s, /check the roster before retrying/);
  const i = s.indexOf("Spawn agent");
  const cancel = s.slice(s.lastIndexOf("Cancel", i) - 80, s.lastIndexOf("Cancel", i));
  assert.ok(!cancel.includes("disabled"));
});
