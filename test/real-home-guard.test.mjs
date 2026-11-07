// Under a test runner nothing reads the developer's real ~/.vibesquad teams.json or talks to the real runner,
// even when a test forgot to set VIBESQUAD_HOME / VIBESQUAD_IGNORE_HOME_TEAMS.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { isForbiddenRealHome, underTestRunner } from "../server/test-guard.mjs";
import { homeTeamsFilePath, resolveTeamsFilePath } from "../server/teams-file.mjs";
import { RunnerClient, readDiscovery, runnerHome } from "../server/backend/runner-client.mjs";

const real = path.join(os.homedir(), ".vibesquad");

test("guard: real home is forbidden under the test runner, temp homes are not, VS_ALLOW_REAL_HOME opts out", () => {
  assert.ok(underTestRunner());
  assert.ok(isForbiddenRealHome(real));
  assert.ok(isForbiddenRealHome(path.join(real, "runner")));
  assert.ok(!isForbiddenRealHome(path.join(os.tmpdir(), "x", ".vibesquad")));
  assert.ok(!isForbiddenRealHome(real, { NODE_TEST_CONTEXT: "child-v8", VS_ALLOW_REAL_HOME: "1" }));
  assert.ok(!isForbiddenRealHome(real, {}));
});

test("teams-file never resolves to the real home teams.json when VIBESQUAD_HOME is unset", () => {
  const prev = { h: process.env.VIBESQUAD_HOME, i: process.env.VIBESQUAD_IGNORE_HOME_TEAMS, t: process.env.VIBESQUAD_TEAMS_FILE };
  delete process.env.VIBESQUAD_HOME;
  delete process.env.VIBESQUAD_IGNORE_HOME_TEAMS;
  delete process.env.VIBESQUAD_TEAMS_FILE;
  try {
    assert.equal(homeTeamsFilePath(), path.join(path.resolve(real), "teams.json"));
    assert.notEqual(resolveTeamsFilePath(path.join(os.tmpdir(), "no-such-root")), homeTeamsFilePath());
  } finally {
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_IGNORE_HOME_TEAMS", prev.i], ["VIBESQUAD_TEAMS_FILE", prev.t]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("runner client on the real home: no discovery, no request, no start", async () => {
  assert.equal(readDiscovery(path.join(real, "runner")), null);
  const prev = process.env.VIBESQUAD_HOME;
  delete process.env.VIBESQUAD_HOME;
  try {
    assert.equal(runnerHome(), path.join(real, "runner"));
    let fetched = 0;
    let spawned = 0;
    const rc = new RunnerClient({ fetchImpl: async () => (fetched++, { ok: true, json: async () => ({}) }), spawnImpl: () => (spawned++, { unref() {} }) });
    await assert.rejects(rc.requireRunning(), { code: "RUNNER_DOWN" });
    await assert.rejects(rc.request("GET", "/agents"), { message: /not running/ });
    await assert.rejects(rc.startOwned(), /real home/);
    assert.deepEqual([fetched, spawned], [0, 0]);
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
  }
});
