import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../src/DrawerHeader.tsx", import.meta.url), "utf8");

test("compact header requires a focused agent so Spin Up never portals drawer-head-compact", () => {
  assert.match(src, /const compact = !!pinFocus && shownHere && inLane/);
});

test("switching provider on a Lead leaves its labels.profile intact before onSuccessor()", () => {
  assert.match(src, /if \(kindOf\(agent\) !== "lead"\) await updateAgent\(agent\.id, \{ labels: nextLabels \}\);/);
  assert.doesNotMatch(src, /^\s*await updateAgent\(agent\.id, \{ labels: nextLabels \}\);/m);
  assert.match(src, /kindOf\(agent\) === "lead" && onSuccessor\) \{\s*onSuccessor\(\);/);
});
