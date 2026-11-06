import { test } from "node:test";
import assert from "node:assert/strict";

const { shouldStartRunnerAtBoot } = await import("../server/serve.mjs");

test("login entry (--background or VIBESQUAD_START_RUNNER) boots the runner; a normal launch does not", () => {
  const argv = (...a) => ["node", "serve.mjs", ...a];
  assert.equal(shouldStartRunnerAtBoot({}, argv("--background")), true);
  assert.equal(shouldStartRunnerAtBoot({ VIBESQUAD_START_RUNNER: "1" }, argv()), true);
  assert.equal(shouldStartRunnerAtBoot({ VIBESQUAD_START_RUNNER: "true" }, argv()), true);
  assert.equal(shouldStartRunnerAtBoot({}, argv()), false);
  assert.equal(shouldStartRunnerAtBoot({ VIBESQUAD_START_RUNNER: "0" }, argv("--open")), false);
});
