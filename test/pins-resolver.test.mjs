import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState, seedDefaultPack } from "../server/vibesquad-api.mjs";
import { briefDiffSummary, patchLane } from "../src/pins.ts";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-pins-resolver-test-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "docs", "PLAN_PINS_TEST.md"), "# Plan\n", "utf8");
  writeFileSync(join(dir, "docs", "brainstorm", "pin-test.md"), "# Brief\n\n## Decided\n- We chose blue.\n", "utf8");
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify({ teams: [{ id: "sq", name: "Squad", lanes: [{ id: "pin-test", name: "Pin Test" }], paths: ["sq"] }] }),
    "utf8",
  );
  seedDefaultPack(profilesPath);
  return { dir, vsHome, profilesPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockDaemon(existing = []) {
  const created = [];
  const archived = [];
  return {
    created,
    archived,
    async fetchAgents() {
      return existing;
    },
    async createAgent(req) {
      // Make the spawn slow enough that a second call overlaps it.
      await new Promise((r) => setTimeout(r, 20));
      created.push(req);
      return { id: `new-${created.length}`, labels: {} };
    },
    async archiveAgent(id) {
      archived.push(id);
    },
    async updateAgent() {},
    async cancelAgent() {},
  };
}

test("quick start spawns one Brainstorm from the brief, labelled for lane integrity, without archiving", async () => {
  const env = makeEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    // An archived former Brainstorm must not be reused.
    const daemon = mockDaemon([
      { id: "old-bs", status: "idle", archivedAt: "2026-10-30T00:00:00Z", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } },
    ]);
    const body = {
      reason: "start-brainstorm",
      mode: "quick-start",
      teamId: "sq",
      laneId: "pin-test",
      laneName: "Pin Test",
      profile: "Brainstorm - Claude",
      daemonClient: daemon,
      profilesPath: env.profilesPath,
    };
    const [a, b] = await Promise.all([performBrainstormRestart(body, env.dir), performBrainstormRestart(body, env.dir)]);
    assert.equal(daemon.created.length, 1, "double-click must spawn once");
    assert.equal(a.newAgentId, "new-1");
    assert.equal(b.newAgentId, "new-1");
    assert.equal(b.reused, true);
    assert.equal(a.profile, "Brainstorm - Claude");
    assert.deepEqual(daemon.archived, []);

    const req = daemon.created[0];
    assert.equal(req.labels.role, "brainstorm");
    assert.equal(req.labels.lane, "pin-test");
    assert.equal(req.labels.team, "sq");
    assert.equal(req.labels["vs.fresh-session"], "brief");
    assert.equal(req.labels["vs.restarted-from"], "start-brainstorm");
    assert.match(req.initialPrompt, /We chose blue\./);
    assert.match(req.initialPrompt, /docs\/PLAN_PINS_TEST\.md/);

    // Once settled, the lock is released: a later call spawns again (the daemon has no live one here).
    await performBrainstormRestart(body, env.dir);
    assert.equal(daemon.created.length, 2);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("quick start opens a live Brainstorm instead of spawning", async () => {
  const env = makeEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    const daemon = mockDaemon([{ id: "live-bs", status: "idle", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } }]);
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", mode: "quick-start", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath },
      env.dir,
    );
    assert.equal(res.reused, true);
    assert.equal(res.newAgentId, "live-bs");
    assert.equal(daemon.created.length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("briefDiffSummary names the changed sections", () => {
  const before = "# Brief\n\n## Decided\n- a\n- b\n\n## Open\n- q\n";
  const after = "# Brief\n\n## Decided\n- a\n- c\n- d\n\n## Open\n- q\n\n## Done when\n- shipped\n";
  assert.equal(briefDiffSummary(before, after), "Decided +2 −1, new section Done when");
  assert.equal(briefDiffSummary(before, before), "no content changes");
  // Swapping the last open item for a "None." placeholder is a removal only.
  assert.equal(briefDiffSummary("## Open\n- q\n", "## Open\n- None.\n"), "Open −1");
  assert.equal(briefDiffSummary("## Open\n- (none recorded yet)\n", "## Open\n- q\n"), "Open +1");
});

test("patchLane renames a lane and records lastProfile", () => {
  const teams = [{ id: "sq", name: "Squad", lanes: [{ id: "x", name: "X" }], paths: [] }];
  const next = patchLane(teams, "sq", "x", { name: "Renamed", lastProfile: "Brainstorm - Gemini" });
  assert.equal(next[0].lanes[0].name, "Renamed");
  assert.equal(next[0].lanes[0].lastProfile, "Brainstorm - Gemini");
  assert.equal(teams[0].lanes[0].name, "X");
});

// ---- Block 4: first pin click yields a visible live Buddy; a closed match is reopened or replaced ----
const withEnv = async (fn) => {
  const env = makeEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    await fn(env);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
};

test("new pin first click: spawns a live Buddy carrying the brief, with the agent in the reply", () =>
  withEnv(async (env) => {
    const daemon = mockDaemon([]);
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", mode: "quick-start", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath },
      env.dir,
    );
    assert.equal(res.ok, true);
    assert.equal(daemon.created.length, 1);
    assert.match(daemon.created[0].initialPrompt, /We chose blue\./);
    assert.equal(res.newAgentId, "new-1");
  }));

test("closed match: reopened and returned as an idle agent so the UI can show it", () =>
  withEnv(async (env) => {
    const daemon = mockDaemon([{ id: "bs-closed", status: "closed", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } }]);
    const refreshed = [];
    daemon.refreshAgent = async (id) => void refreshed.push(id);
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath },
      env.dir,
    );
    assert.equal(res.reopened, true);
    assert.deepEqual(refreshed, ["bs-closed"]);
    assert.equal(res.agent.id, "bs-closed");
    assert.equal(res.agent.status, "idle");
    assert.equal(daemon.created.length, 0);
  }));

test("closed match that will not reopen is replaced by a fresh spawn, not silently reused", () =>
  withEnv(async (env) => {
    const daemon = mockDaemon([{ id: "bs-closed", status: "closed", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } }]);
    daemon.refreshAgent = async () => {
      throw new Error("session gone");
    };
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath, backstopDelayMs: 0 },
      env.dir,
    );
    assert.equal(res.ok, true);
    assert.notEqual(res.reused, true);
    assert.equal(res.newAgentId, "new-1");
    assert.equal(daemon.created.length, 1);
  }));

test("closed match whose refresh returns it still closed is replaced, not reused", () =>
  withEnv(async (env) => {
    const daemon = mockDaemon([{ id: "bs-closed", status: "closed", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } }]);
    daemon.refreshAgent = async (id) => ({ id, status: "closed" });
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath, backstopDelayMs: 0 },
      env.dir,
    );
    assert.notEqual(res.reused, true);
    assert.equal(res.newAgentId, "new-1");
  }));

test("closed match on a backend that cannot reopen is replaced, not reused", () =>
  withEnv(async (env) => {
    const daemon = mockDaemon([{ id: "bs-closed", status: "closed", labels: { team: "sq", lane: "pin-test", role: "brainstorm" } }]);
    const res = await performBrainstormRestart(
      { reason: "start-brainstorm", teamId: "sq", laneId: "pin-test", daemonClient: daemon, profilesPath: env.profilesPath, backstopDelayMs: 0 },
      env.dir,
    );
    assert.notEqual(res.reused, true);
    assert.equal(daemon.created.length, 1);
  }));
