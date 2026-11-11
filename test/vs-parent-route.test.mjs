// idea-136: after X1c `vs.parent` is the one parent key (server/identity.mjs); the detach helper, the agent.created parent
// lookup and the UI readers still read paseo.parent-agent-id. idea-87: the `route:` metric is written before the agent id
// exists (refs=[]), so agent.created pairs it with the spawned agent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detachLiveChildren, parentOf, PARENT_LABEL } from "../server/detach-children.mjs";
import { createPlugin, ROUTE_LABEL } from "../server/hooks/agent-duties.ts";
import { buildTree, chainedLeads } from "../src/teams.ts";
import { resolveAgentIdentity } from "../src/identity.ts";

const CWD = "/projects/VibeSquad/.worktrees/parent-test";

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-parent-route-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
    writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: [{ name: "Implement - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" }] }));
    const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    try {
      await fn({ vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness() {
  const before = new Map();
  const on = new Map();
  const server = {
    before: (name, fn) => (before.set(name, fn), () => before.delete(name)),
    on: (name, fn) => (on.set(name, fn), () => on.delete(name)),
  };
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, refuseAgent: async () => {} })(server);
  const agents = new Map();
  const paseo = {
    agents: {
      ref: (id) => ({ refresh: async () => (agents.has(id) ? { agent: agents.get(id) } : null), archive: async () => {} }),
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
    },
  };
  return { stop, agents, paseo, spawn: (request) => before.get("agent.create")({ request }), created: (agent) => on.get("agent.created")({ agent }, { paseo }) };
}

const teamLog = (vsHome) => {
  try {
    return readFileSync(join(vsHome, "teams", "vibesquad", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test("idea-136: detach-children reads vs.parent", async () => {
  assert.equal(PARENT_LABEL, "vs.parent");
  assert.equal(parentOf({ labels: { "vs.parent": "p" } }), "p");
  assert.equal(parentOf({ labels: {}, parentAgentId: "q" }), "q", "a Paseo snapshot's parentAgentId still counts");
  const detached = [];
  const r = await detachLiveChildren("p", {
    list: () => [{ id: "a", labels: { "vs.parent": "p" } }, { id: "b", labels: { "paseo.parent-agent-id": "p" } }],
    detach: async (id) => void detached.push(id),
  });
  assert.deepEqual(r.detached, ["a"]);
});

test(
  "idea-136: agent.created finds the parent lead from the vs.parent label (first-dispatch metric)",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      h.agents.set("rn-lead", { id: "rn-lead", title: "★ VIBESQUAD ord1", cwd: CWD, status: "running", labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" } });
      const child = { id: "rn-kid", title: "Implement - x", cwd: CWD, status: "running", labels: { team: "vibesquad", lane: "vibesquad", role: "worker", job: "x", "vs.parent": "rn-lead" } };
      h.agents.set(child.id, child);
      await h.created(child);
      const m = teamLog(vsHome).find((e) => /^first-dispatch context:/.test(e.text));
      assert.ok(m, "first-dispatch metric written for the vs.parent lead");
      assert.match(m.text, /lead=rn-lead/);
    } finally {
      h.stop?.();
    }
  }),
);

test("idea-136: the UI tree and identity chain read vs.parent; CHAINED stays the Paseo cascade label", () => {
  const team = { id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad" }] };
  const m = (id, kind, labels, extra = {}) => ({ kind, team, laneId: "vibesquad", agent: { id, title: id, status: "running", labels, ...extra } });
  const members = [
    m("L", "lead", { role: "lead", "vs.parent": "B" }),
    m("W", "worker", { role: "worker", "vs.parent": "L" }),
    m("P", "lead", { role: "lead", "paseo.parent-agent-id": "B" }),
  ];
  assert.deepEqual(buildTree(members).childrenOf("L").map((x) => x.agent.id), ["W"]);
  assert.deepEqual(chainedLeads(members).map((x) => x.agent.id), ["P"], "a runner-stamped vs.parent is not a Paseo cascade chain");
  const r = resolveAgentIdentity(
    { id: "W", labels: { role: "worker", "vs.parent": "L" } },
    { teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", name: "Bug Chaser" }] }], agentsById: { L: { id: "L", labels: { team: "vibesquad", lane: "bug-chaser", role: "lead" } } } },
  );
  assert.equal(r.laneId, "bug-chaser", "lane inherited through vs.parent");
});

test(
  "idea-87: the route rides the spawn labels and agent.created logs route-agent with the agent id",
  withEnv(async ({ vsHome }) => {
    const h = harness();
    try {
      const labels = { profile: "Implement - Sonnet", team: "vibesquad", lane: "vibesquad", role: "worker", job: "x", stakes: "tierA-security" };
      const out = await h.spawn({ config: { cwd: CWD, provider: "claude" }, labels });
      assert.equal(out.labels[ROUTE_LABEL], "stakes=tierA-security model=claude-fable-5-1 effort=high reason=ladder");
      const agent = { id: "rn-routed", title: "Implement - x", cwd: CWD, status: "running", provider: "claude", model: out.config.model, thinkingOptionId: out.config.thinkingOptionId, labels: out.labels };
      h.agents.set(agent.id, agent);
      await h.created(agent);
      await h.created(agent); // a second created event logs nothing new
      const paired = teamLog(vsHome).filter((e) => e.text.startsWith("route-agent:"));
      assert.equal(paired.length, 1);
      assert.equal(paired[0].text, "route-agent: id=rn-routed stakes=tierA-security model=claude-fable-5-1 effort=high reason=ladder");
      assert.deepEqual(paired[0].refs, ["rn-routed"]);
      assert.equal(teamLog(vsHome).filter((e) => e.text.startsWith("route:")).length, 1, "the before() route metric is unchanged");
    } finally {
      h.stop?.();
    }
  }),
);
