import assert from "node:assert/strict";
import { test } from "node:test";
import { isDigestNoise, statesVerdict } from "../plugin/index.server.ts";

test("digest skips workers with no job label", () => {
  assert.equal(isDigestNoise({ role: "worker" }, "Bug1"), true);
  assert.equal(isDigestNoise({ role: "worker", job: "  " }, "Bug1"), true);
});

test("digest skips probes by job or title", () => {
  assert.equal(isDigestNoise({ job: "probe the daemon" }, "Bug1"), true);
  assert.equal(isDigestNoise({ job: "bug batch 2" }, "Probe: ports"), true);
});

test("digest keeps real jobs", () => {
  assert.equal(isDigestNoise({ job: "bug batch 2" }, "Bug2 · hygiene"), false);
  assert.equal(isDigestNoise({ job: "improbable fixes" }, "Bug3"), false);
});

test("[done] needs an explicit PASS or FAIL", () => {
  assert.equal(statesVerdict("Block 5: PASS, 12 tests"), true);
  assert.equal(statesVerdict("FAIL: suite red"), true);
  assert.equal(statesVerdict("looked around, nothing to report"), false);
  assert.equal(statesVerdict("bypassed the failing check"), false);
  assert.equal(statesVerdict(""), false);
});
