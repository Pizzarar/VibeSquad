// start-brainstorm's duplicate-Buddy guard through a real RoutingBackend (fake Paseo + fake runner), under the shipping
// cutover default and under the rollback. Each test sets the env it needs; none relies on the suite preload.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaseoBackend } from "../server/backend/paseo-backend.mjs";
import { RoutingBackend, runnerLanes } from "../server/backend/lane-routing.mjs";
import { performBrainstormRestart, resetBrainstormRestartState, seedDefaultPack } from "../server/vibesquad-api.mjs";

function makeEnv(laneExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vs-dup-guard-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "docs", "brainstorm", "pin-test.md"), "# Brief\n\n## Decided\n- We chose blue.\n", "utf8");
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", lanes: [{ id: "pin-test", name: "Pin Test", ...laneExtra }], paths: ["sq"] }] }), "utf8");
  seedDefaultPack(profilesPath);
  return { dir, vsHome, profilesPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakePaseo({ failList = false } = {}) {
  const calls = [];
  return {
    calls,
    connect: async () => { calls.push("connect"); },
    close: async () => {},
    fetchAgents: async () => {
      calls.push("fetchAgents");
      if (failList) throw new Error("socket closed");
      return { entries: [] };
    },
    createAgent: async (req) => { calls.push("createAgent"); return { id: "paseo-new", labels: req.labels }; },
    updateAgent: async () => {},
    cancelAgent: async () => {},
    archiveAgent: async () => {},
  };
}

function fakeRunner({ existing = [], cold = false } = {}) {
  const created = [];
  let up = !cold;
  let ensured = 0;
  return {
    created,
    get ensured() { return ensured; },
    async ensureRunningOnce() { ensured += 1; up = true; },
    async fetchAgents() {
      if (!up) throw new Error("runner not running");
      return { entries: existing.map((agent) => ({ agent })) };
    },
    async listAgents() { return (await this.fetchAgents()).entries.map((e) => e.agent); },
    async createAgent(req) {
      if (!up) throw new Error("runner not running");
      created.push(req);
      return { id: `rn-new-${created.length}`, labels: req.labels ?? {} };
    },
    async fetchAgent(id) { return { agent: existing.find((a) => a.id === id) ?? { id, labels: {} } }; },
    async updateAgent() {},
    async cancelAgent() {},
    async archiveAgent() {},
  };
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function startBody(env, backend) {
  return {
    reason: "start-brainstorm",
    mode: "quick-start",
    teamId: "sq",
    laneId: "pin-test",
    laneName: "Pin Test",
    profile: "Brainstorm - Claude",
    clientFactory: () => backend, // not injected: connect() runs, so the Paseo probe decides `down`
    profilesPath: env.profilesPath,
  };
}

const rnBuddy = { id: "rn-existing", status: "idle", labels: { team: "sq", lane: "pin-test", role: "brainstorm" }, title: "Buddy" };

async function run({ laneExtra, vars, paseo, runner, alive = async () => false }) {
  const env = makeEnv(laneExtra);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    return await withEnv(vars, async () => {
      const lanes = () => runnerLanes({ teamsFile: join(env.dir, "teams.json") });
      const backend = new RoutingBackend(new PaseoBackend(paseo), runner, { lanes, paseoAlive: alive });
      const res = await performBrainstormRestart(startBody(env, backend), env.dir);
      return { res, backend };
    });
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
}

test("Paseo-pinned lane + Paseo down: fail closed, nothing spawned (probe says down)", async () => {
  const paseo = fakePaseo();
  const runner = fakeRunner();
  const { res } = await run({ laneExtra: { backend: "paseo" }, vars: { VS_DEFAULT_BACKEND: "runner", VS_BACKEND: undefined }, paseo, runner });
  assert.equal(res.ok, false);
  assert.equal(res.spawned, false);
  assert.equal(res.reason, "agent-list-unavailable");
  assert.equal(runner.created.length, 0);
  assert.equal(paseo.calls.includes("createAgent"), false);
});

test("Paseo-pinned lane + Paseo dies mid-flight (probe cache still says alive): same fail-closed answer", async () => {
  const paseo = fakePaseo({ failList: true });
  const runner = fakeRunner();
  const { res } = await run({ laneExtra: { backend: "paseo" }, vars: { VS_DEFAULT_BACKEND: "runner", VS_BACKEND: undefined }, paseo, runner, alive: async () => true });
  assert.equal(res.reason, "agent-list-unavailable");
  assert.equal(runner.created.length, 0);
});

test("rollback (VS_DEFAULT_BACKEND=paseo or VS_BACKEND=paseo) + Paseo down: every lane fails closed", async () => {
  for (const vars of [{ VS_DEFAULT_BACKEND: "paseo", VS_BACKEND: undefined }, { VS_DEFAULT_BACKEND: undefined, VS_BACKEND: "paseo" }]) {
    const paseo = fakePaseo();
    const runner = fakeRunner();
    const { res } = await run({ vars, paseo, runner });
    assert.equal(res.reason, "agent-list-unavailable", JSON.stringify(vars));
    assert.equal(runner.created.length, 0);
    assert.equal(paseo.calls.includes("createAgent"), false);
  }
});

test("runner lane + Paseo down + a live runner Buddy: no second Buddy is spawned", async () => {
  const paseo = fakePaseo();
  const runner = fakeRunner({ existing: [rnBuddy] });
  const { res } = await run({ vars: { VS_DEFAULT_BACKEND: "runner", VS_BACKEND: undefined }, paseo, runner });
  assert.equal(runner.created.length, 0, JSON.stringify(res));
  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(res.newAgentId ?? res.agentId, "rn-existing");
});

test("runner lane + Paseo down + cold runner: the runner is booted and exactly one rn- Buddy is spawned", async () => {
  const paseo = fakePaseo();
  const runner = fakeRunner({ cold: true });
  const { res } = await run({ vars: { VS_DEFAULT_BACKEND: "runner", VS_BACKEND: undefined }, paseo, runner });
  assert.equal(runner.ensured >= 1, true, "ensureRunningOnce was called");
  assert.equal(runner.created.length, 1, JSON.stringify(res));
  assert.match(res.newAgentId, /^rn-new-/);
  assert.equal(paseo.calls.includes("createAgent"), false);
});
