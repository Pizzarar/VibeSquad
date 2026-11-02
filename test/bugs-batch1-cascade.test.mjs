// docs/PLAN_BUGS_BATCH1.md block 0 (a Buddy restart cascade-archived its lead + workers) and
// block 0b (new Buddies got the vibesquad brief instead of their own lane's).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../plugin/index.server.ts";
import { archiveBuddyKeepingChildren, performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { detachLiveChildren, PARENT_LABEL } from "../server/detach-children.mjs";

/** A daemon that archives like Paseo: archiving a parent archives every unarchived child labelled with it, recursively. */
function cascadingDaemon(list) {
  const agents = new Map(list.map((a) => [a.id, { status: "idle", ...a, labels: { ...(a.labels ?? {}) } }]));
  const calls = { archive: [], detach: [] };
  const archive = (id) => {
    const a = agents.get(id);
    if (!a || a.archivedAt) return;
    a.archivedAt = "2026-11-02T04:25:53Z";
    for (const c of agents.values()) if (!c.archivedAt && c.labels[PARENT_LABEL] === id) archive(c.id);
  };
  return {
    agents,
    calls,
    async fetchAgents() {
      return { entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
    },
    async fetchAgent(id) {
      return { agent: agents.get(id) ?? null };
    },
    async detachAgent(id) {
      calls.detach.push(id);
      delete agents.get(id).labels[PARENT_LABEL];
    },
    async archiveAgent(id) {
      calls.archive.push(id);
      archive(id);
      return { archivedAt: "x" };
    },
    async cancelAgent() {},
    async updateAgent(id, { name, labels }) {
      const a = agents.get(id);
      if (a) Object.assign(a, name ? { title: name } : {}, { labels: { ...a.labels, ...labels } });
    },
    async createAgent(req) {
      const id = `new-bs-${agents.size}`;
      agents.set(id, { id, status: "idle", labels: { ...(req.labels ?? {}) } });
      return { id, labels: { ...(req.labels ?? {}) } };
    },
  };
}

// The 04:25Z shape: old Buddy → its lead (MCP child) → the lead's workers (children of the lead).
const fleet = () => [
  { id: "bs-old", title: "BRAINSTORM · BASIC ADE", labels: { team: "sq", lane: "ade", role: "brainstorm" } },
  { id: "lead1", title: "★ BASIC ADE ord1", labels: { team: "sq", lane: "ade", role: "lead", ord: "1", [PARENT_LABEL]: "bs-old" } },
  { id: "w1", labels: { team: "sq", lane: "ade", role: "worker", [PARENT_LABEL]: "lead1" }, status: "running" },
  { id: "w2", labels: { team: "sq", lane: "ade", role: "worker", [PARENT_LABEL]: "lead1" } },
  { id: "probe", labels: { team: "sq", lane: "ade", role: "worker", [PARENT_LABEL]: "bs-old" }, status: "closed" },
];

test("without the fix the fake daemon reproduces the cascade (lead + workers archived)", async () => {
  const d = cascadingDaemon(fleet());
  await d.archiveAgent("bs-old");
  assert.ok(["lead1", "w1", "w2"].every((id) => d.agents.get(id).archivedAt));
});

test("archiving a retired Buddy detaches its live children first: lead + grandchild workers survive", async () => {
  const d = cascadingDaemon(fleet());
  const r = await archiveBuddyKeepingChildren(d, "bs-old");
  assert.equal(r.archived, true);
  assert.deepEqual(r.detached, ["lead1"], "only the live direct child; workers hang off the lead");
  assert.ok(d.agents.get("bs-old").archivedAt);
  for (const id of ["lead1", "w1", "w2"]) assert.equal(d.agents.get(id).archivedAt, undefined, `${id} not archived`);
  assert.equal(d.agents.get("lead1").labels[PARENT_LABEL], undefined, "lead has no parent");
  assert.equal(d.agents.get("w1").labels[PARENT_LABEL], "lead1", "workers stay with their lead");
  assert.ok(d.agents.get("probe").archivedAt, "a closed child still goes with the Buddy");
});

test("a failed detach keeps the Buddy unarchived instead of risking the cascade", async () => {
  const d = cascadingDaemon(fleet());
  d.detachAgent = async () => {
    throw new Error("daemon busy");
  };
  const r = await archiveBuddyKeepingChildren(d, "bs-old");
  assert.equal(r.archived, false);
  assert.deepEqual(d.calls.archive, []);
  assert.equal(d.agents.get("lead1").archivedAt, undefined);
});

test("detachLiveChildren ignores archived, closed and unrelated agents", async () => {
  const seen = [];
  const r = await detachLiveChildren("p", {
    list: async () => [
      { id: "a", labels: { [PARENT_LABEL]: "p" } },
      { id: "b", labels: { [PARENT_LABEL]: "p" }, archivedAt: "x" },
      { id: "c", labels: { [PARENT_LABEL]: "p" }, status: "closed" },
      { id: "d", labels: { [PARENT_LABEL]: "q" } },
      { id: "e", parentAgentId: "p", labels: {} },
    ],
    detach: async (id) => void seen.push(id),
  });
  assert.deepEqual(seen, ["a", "e"]);
  assert.deepEqual(r, { detached: ["a", "e"], failed: [] });
});

async function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-cascade-"));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  mkdirSync(process.env.VIBESQUAD_HOME, { recursive: true });
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

const waitFor = async (pred, ms = 3000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
};

test("Buddy restart (server/brainstorm.mjs) leaves the old Buddy's lead and workers running", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const d = cascadingDaemon(fleet());
    const r = await performBrainstormRestart({ agentId: "bs-old", reason: "manual", teamId: "sq", laneId: "ade", daemonClient: d }, dir);
    assert.ok(r.ok !== false, JSON.stringify(r));
    assert.ok(await waitFor(() => d.calls.archive.includes("bs-old")), "old Buddy archived (background retire)");
    for (const id of ["lead1", "w1", "w2"]) assert.equal(d.agents.get(id).archivedAt, undefined, `${id} survived the restart`);
    assert.equal(d.agents.get("lead1").labels[PARENT_LABEL], undefined);
  }));

test("Buddy hard-limit retire (auto, no successor) also leaves the lead running", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const d = cascadingDaemon(fleet());
    await performBrainstormRestart({ agentId: "bs-old", reason: "auto-hard-limit", teamId: "sq", laneId: "ade", daemonClient: d, usedTokens: 200000 }, dir);
    assert.ok(d.agents.get("bs-old").archivedAt);
    assert.equal(d.agents.get("lead1").archivedAt, undefined);
    assert.equal(d.agents.get("w1").archivedAt, undefined);
  }));

// ---- plugin side: (b) a new lead starts detached; the delayed Buddy archive detaches children ----

function pluginHarness() {
  const handlers = new Map();
  const server = { before: () => () => {}, on: (n, f) => (handlers.set(n, f), () => {}) };
  const timers = [];
  return { handlers, server, timers };
}

function fakePaseo(list) {
  const agents = new Map(list.map((a) => [a.id, { status: "idle", ...a, labels: { ...(a.labels ?? {}) } }]));
  const calls = { detach: [], archive: [] };
  return {
    agents,
    calls,
    get api() {
      return {
        agents: {
          list: async () => ({ entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })) }),
          get: async (id) => agents.get(id) ?? null,
          ref: (id) => ({
            refresh: async () => ({ agent: agents.get(id) ? { ...agents.get(id), labels: { ...agents.get(id).labels } } : null }),
            detach: async () => {
              calls.detach.push(id);
              delete agents.get(id).labels[PARENT_LABEL];
            },
            archive: async () => {
              calls.archive.push(id);
              agents.get(id).archivedAt = "x";
            },
            send: async () => {},
            timeline: async () => ({ items: [] }),
          }),
        },
      };
    },
  };
}

test("plugin agent.created: a lead spawned by a Buddy is detached at once", () =>
  withHome(async () => {
    const h = pluginHarness();
    createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {} })(h.server);
    const p = fakePaseo([
      { id: "bs", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" } },
      { id: "lead9", cwd: "/projects/VibeSquad", labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "9", [PARENT_LABEL]: "bs" } },
      { id: "wk", cwd: "/projects/VibeSquad", labels: { team: "vibesquad", lane: "vibesquad", role: "worker", [PARENT_LABEL]: "lead9" } },
    ]);
    const created = h.handlers.get("agent.created");
    await created({ agent: { ...p.agents.get("lead9") } }, { paseo: p.api });
    assert.deepEqual(p.calls.detach, ["lead9"]);
    assert.equal(p.agents.get("lead9").labels[PARENT_LABEL], undefined);
    // Workers are not leads: they stay chained to their lead.
    await created({ agent: { ...p.agents.get("wk") } }, { paseo: p.api });
    assert.deepEqual(p.calls.detach, ["lead9"]);
  }));

// ---- block 0b: a Buddy for lane bug-chaser gets docs/brainstorm/bug-chaser.md, not vibesquad.md ----

test("0b: start-brainstorm for bug-chaser from the VibeSquad folder embeds bug-chaser.md end to end", () =>
  withHome(async (dir) => {
    const briefRoot = join(dir, "repo");
    mkdirSync(join(briefRoot, "docs", "brainstorm"), { recursive: true });
    const teamsFile = join(process.env.VIBESQUAD_HOME, "teams.json");
    const lanes = [
      { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] },
      { id: "bug-chaser", name: "Bug Chaser" },
    ];
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes, paths: ["VibeSquad"] }] }), "utf8");
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    for (const l of ["vibesquad", "bug-chaser"]) writeFileSync(join(briefRoot, "docs", "brainstorm", `${l}.md`), `# ${l}\n\n## Done when\n- ${l}-marker\n`, "utf8");
    assert.ok(existsSync(join(briefRoot, "docs", "brainstorm", "bug-chaser.md")));

    // 1. VS's Buddy spawn (the pin quick-start path that made 4503b264).
    resetBrainstormRestartState();
    const reqs = [];
    const d = cascadingDaemon([]);
    d.createAgent = async (req) => (reqs.push(req), { id: "bc-bs", labels: { ...req.labels } });
    await performBrainstormRestart({ reason: "start-brainstorm", teamId: "vibesquad", laneId: "bug-chaser", laneName: "Bug Chaser", daemonClient: d }, briefRoot);
    assert.equal(reqs.length, 1);
    const req = reqs[0];

    // 2. Through the plugin's before(agent.create) hook, with only env (labels never reach the hook).
    const before = new Map();
    createPlugin({ startWatcher: false, briefRoot, setLabels: async () => {}, archiveAgent: async () => {} })({
      before: (n, f) => (before.set(n, f), () => {}),
      on: () => () => {},
    });
    const request = { config: { ...(req.config ?? {}), cwd: briefRoot.replace(/repo$/, "VibeSquad") }, env: req.env, initialPrompt: req.initialPrompt, prompt: req.initialPrompt };
    const out = before.get("agent.create")({ request }) ?? request;
    const everything = `${out.config.systemPrompt ?? ""}\n${req.initialPrompt ?? ""}`;
    // VS inlines the lane brief (read from the VibeSquad repo's docs/brainstorm) and the hook adds no second one.
    assert.match(everything, /--- BEGIN docs\/brainstorm\/bug-chaser\.md ---/);
    assert.doesNotMatch(everything, /--- BEGIN docs\/brainstorm\/vibesquad\.md ---/);
    assert.doesNotMatch(everything, /Lane brief for `vibesquad`/);
  }));
