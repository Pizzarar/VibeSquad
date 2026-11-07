import { test } from "node:test";
import assert from "node:assert/strict";

const { shouldSuperviseRunner } = await import("../server/runner-supervisor.mjs");

test("the server boots (and supervises) the runner unless VIBESQUAD_START_RUNNER opts out", () => {
  assert.equal(shouldSuperviseRunner({}), true);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "1" }), true);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "0" }), false);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "false" }), false);
});
