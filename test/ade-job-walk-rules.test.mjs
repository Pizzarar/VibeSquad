import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../docs/ADE_JOB_WALK.md", import.meta.url), "utf8");

test("UX rows never pass on control-present", () => {
  assert.match(doc, /UX rows \(75\+\) pass only when the walker actually completes the job/);
  assert.match(doc, /records the click count and the result/);
  assert.match(doc, /control-present[^\n]*is a FAIL on these rows/);
});

test("multi-step attention rows 75-78 exist with pass bars", () => {
  for (const n of [75, 76, 77, 78]) assert.match(doc, new RegExp(`^\| ${n} \|`, "m"));
  assert.match(doc, /≤1 click/);
});

test("run matrix and fresh-eyes rule are stated", () => {
  assert.match(doc, /3200×1800/);
  assert.match(doc, /1920×1080/);
  assert.match(doc, /dark and light/);
  assert.match(doc, /walker does NOT read the batch's plan/);
});
