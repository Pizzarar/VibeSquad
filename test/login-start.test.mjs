import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { runnerLanes } from "../server/backend/index.mjs";

const { shouldSuperviseRunner } = await import("../server/runner-supervisor.mjs");

test("the server boots (and supervises) the runner whenever it is enabled; opt-out and Paseo rollback disable it", () => {
  const on = () => new Set(["x"]);
  assert.equal(shouldSuperviseRunner({}, on), true);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "1" }, on), true);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "0" }, on), false);
  assert.equal(shouldSuperviseRunner({ VIBESQUAD_START_RUNNER: "false" }, on), false);
  assert.equal(shouldSuperviseRunner({}, () => new Set()), false, "no runner lanes (rollback): nothing to supervise");
  assert.equal(shouldSuperviseRunner({ VS_DEFAULT_BACKEND: "paseo" }, () => runnerLanes({ env: { VS_DEFAULT_BACKEND: "paseo" }, teamsFile: path.join(os.tmpdir(), "vs-no-such-teams.json") })), false, "rollback default with no runner lanes");
});
