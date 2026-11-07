// start-brainstorm's duplicate-Buddy guard against a fake runner backend.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

function fakeRunner({ existing = [], cold = false } = {}) {
  const created = [];
  let up = !cold;
  let ensured = 0;
  return {
    created,
    get ensured() { return ensured; },
    async connect() {},
    async close() {},
    async requireRunning() { ensured += 1; if (!up) throw new Error("RUNNER_DOWN"); },
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
    clientFactory: () => backend, 
    profilesPath: env.profilesPath,
  };
}

async function run({ laneExtra, vars = {}, runner }) {
  const env = makeEnv(laneExtra);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    return await withEnv(vars, async () => {
      const res = await performBrainstormRestart(startBody(env, runner), env.dir);
      return { res, backend: runner };
    });
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
}

const rnBuddy = { id: "rn-existing", status: "idle", labels: { team: "sq", lane: "pin-test", role: "brainstorm" }, title: "Buddy" };

test("a live runner Buddy exists: no second Buddy is spawned", async () => {
  const runner = fakeRunner({ existing: [rnBuddy] });
  const { res } = await run({ runner });
  assert.equal(runner.created.length, 0, JSON.stringify(res));
  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(res.newAgentId ?? res.agentId, "rn-existing");
});

test("cold runner: nothing is spawned (the VS server owns starting the runner)", async () => {
  const runner = fakeRunner({ cold: true });
  const { res } = await run({ runner });
  assert.equal(runner.ensured >= 1, true, "requireRunning was consulted");
  assert.equal(runner.created.length, 0, JSON.stringify(res));
});
