import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sweepTestScratch, TEST_SCRATCH_PREFIX } from "../scripts/test-child-env.mjs";

test("idea-977: hermetic.mjs points os.tmpdir() at a per-process vs-t- scratch dir", () => {
  assert.ok(tmpdir().split(/[\\/]/).pop().startsWith(TEST_SCRATCH_PREFIX), tmpdir());
});

test("idea-977: sweepTestScratch removes only old vs-t- dirs", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-base-"));
  const old = join(base, `${TEST_SCRATCH_PREFIX}old111`);
  const young = join(base, `${TEST_SCRATCH_PREFIX}new222`);
  const other = join(base, "vs-other-abcdef");
  for (const d of [old, young, other]) mkdirSync(d);
  const t = (Date.now() - 4 * 3_600_000) / 1000;
  utimesSync(old, t, t);
  utimesSync(other, t, t);
  assert.equal(sweepTestScratch(base), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(other), true, "other prefixes belong to the 3-day TTL");
  assert.equal(sweepTestScratch(join(base, "missing")), 0);
});
