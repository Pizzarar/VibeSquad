// docs/PLAN_BUGS_BATCH2.md block 0: two live role=brainstorm Buddies in one lane. (a) a real Buddy spawn
// retires every other Buddy in (team, lane, topic), (b) `vs who brainstorm` prints CONFLICT, (c) the pin's
// "Keep this one" retires the others without archiving. Fake clients only, no live daemon.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState, retireOtherLaneBuddies } from "../server/brainstorm.mjs";
import { PARENT_LABEL } from "../server/detach-children.mjs";
import { keepBuddy, liveBuddyDupes, pinsForSquad } from "../src/pins.ts";
import { buildTeamViews, resolve as resolveMembers } from "../src/teams.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");

/** A daemon that archives like Paseo (children go with the parent) and records every write. */
function fakeDaemon(list) {
  const agents = new Map(list.map((a) => [a.id, { status: "idle", ...a, labels: { ...(a.labels ?? {}) } }]));
  const calls = { archive: [], detach: [], cancel: [], update: [], create: [], refresh: [] };
  const archive = (id) => {
    const a = agents.get(id);
    if (!a || a.archivedAt) return;
    a.archivedAt = "2026-11-02T15:00:00Z";
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
    },
    async cancelAgent(id) {
      calls.cancel.push(id);
    },
    async refreshAgent(id) {
      calls.refresh.push(id);
    },
    async updateAgent(id, { name, labels }) {
      calls.update.push(id);
      const a = agents.get(id);
      if (a) Object.assign(a, name ? { title: name } : {}, { labels: { ...a.labels, ...labels } });
    },
    async createAgent(req) {
      const id = `bs-new-${calls.create.length + 1}`;
      calls.create.push(id);
      agents.set(id, { id, status: "idle", title: req.config?.title, labels: { ...(req.labels ?? {}) } });
      return { id, labels: { ...(req.labels ?? {}) } };
    },
  };
}

async function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-bs-dupes-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  mkdirSync(process.env.VIBESQUAD_HOME, { recursive: true });
  try {
    await fn(dir);
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
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

const bs = (id, over = {}) => ({ id, title: `Bug Buddy ${id}`, updatedAt: "2026-11-02T10:00:00Z", labels: { team: "sq", lane: "bug", role: "brainstorm" }, ...over });
const liveBrainstorms = (d) => [...d.agents.values()].filter((a) => !a.archivedAt && a.labels.role === "brainstorm").map((a) => a.id);

// ---- (a) server backstop ----

test("(a) a fresh Buddy spawn with an existing closed + idle Buddy in the lane leaves exactly one role=brainstorm", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const d = fakeDaemon([
      bs("bs-closed", { status: "closed" }),
      bs("bs-idle"),
      { id: "lead1", labels: { team: "sq", lane: "bug", role: "lead", ord: "1", [PARENT_LABEL]: "bs-closed" } },
      // Other lanes and topic Buddies are other seats: untouched.
      bs("bs-other-lane", { labels: { team: "sq", lane: "art", role: "brainstorm" } }),
      bs("bs-topic", { labels: { team: "sq", lane: "bug", role: "brainstorm", topic: "icons" } }),
    ]);
    const r = await performBrainstormRestart({ reason: "start-brainstorm", forceNew: true, teamId: "sq", laneId: "bug", daemonClient: d, backstopDelayMs: 0 }, dir);
    assert.equal(r.ok, true);
    assert.equal(r.newAgentId, "bs-new-1");
    assert.ok(await waitFor(() => d.calls.archive.length === 2), JSON.stringify(d.calls));
    assert.deepEqual(liveBrainstorms(d).sort(), ["bs-new-1", "bs-other-lane", "bs-topic"]);
    for (const id of ["bs-closed", "bs-idle"]) {
      const a = d.agents.get(id);
      assert.equal(a.labels.role, "former-brainstorm", id);
      assert.equal(a.labels["vs.restarted-into"], "bs-new-1", id);
      assert.match(a.title, /^\(old\) Bug Buddy/, id);
    }
    assert.deepEqual(d.calls.cancel, ["bs-idle"], "only the live one is cancelled");
    assert.equal(d.agents.get("lead1").archivedAt, undefined, "the closed Buddy's lead was detached, not archived");
    assert.equal(d.agents.get("lead1").labels[PARENT_LABEL], undefined);
  }));

test("(a) a Buddy restart also retires a third duplicate, and the old Buddy is retired once (no double retire)", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const d = fakeDaemon([bs("bs-old"), bs("bs-dupe", { status: "closed" })]);
    await performBrainstormRestart({ agentId: "bs-old", reason: "manual", teamId: "sq", laneId: "bug", daemonClient: d, backstopDelayMs: 0 }, dir);
    assert.ok(await waitFor(() => d.calls.archive.length === 2));
    assert.deepEqual(liveBrainstorms(d), ["bs-new-1"]);
    assert.equal(d.calls.update.filter((id) => id === "bs-old").length, 1, "restart path retires bs-old; the backstop skips it");
    assert.equal(d.agents.get("bs-dupe").labels["vs.restarted-into"], "bs-new-1");
  }));

test("(a) the reopen rule stays: a pin click on a closed Buddy reopens it, spawns nothing and retires nobody", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const d = fakeDaemon([bs("bs-closed", { status: "closed" })]);
    const r = await performBrainstormRestart({ reason: "start-brainstorm", teamId: "sq", laneId: "bug", daemonClient: d, backstopDelayMs: 0 }, dir);
    assert.equal(r.reopened, true);
    assert.equal(r.existingAgentId, "bs-closed");
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(d.calls.create, []);
    assert.deepEqual(d.calls.update, []);
    assert.deepEqual(d.calls.archive, []);
  }));

test("(a) the backstop skips Buddies the plugin already retired", async () => {
  resetBrainstormRestartState();
  const d = fakeDaemon([bs("new"), bs("done-by-plugin", { labels: { team: "sq", lane: "bug", role: "former-brainstorm" } }), bs("other-team", { labels: { team: "efi", lane: "bug", role: "brainstorm" } })]);
  const retired = await retireOtherLaneBuddies(d, { newId: "new", teamId: "sq", laneId: "bug" });
  assert.deepEqual(retired, []);
  assert.deepEqual(d.calls.update, []);
});

// ---- (b) vs who brainstorm CONFLICT ----

function mockVsEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-who-bs-"));
  const vsHome = join(dir, ".vibesquad");
  const paseoHome = join(dir, ".paseo");
  const agentsDir = join(paseoHome, "agents", "srv_test");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  const teams = { teams: [{ id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "bug-chaser", name: "Bug Chaser" }] }] };
  writeFileSync(join(vsHome, "teams.json"), JSON.stringify(teams) + "\n", "utf8");
  return {
    write: (rec) => writeFileSync(join(agentsDir, `${rec.id}.json`), JSON.stringify(rec), "utf8"),
    run: (args) =>
      spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, VIBESQUAD_HOME: vsHome, PASEO_HOME: paseoHome } }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("(b) vs who brainstorm prints CONFLICT + both ids (exit 2) for two live Buddies; a topic Buddy is not a conflict", () => {
  const env = mockVsEnv();
  try {
    const labels = { team: "vibesquad", lane: "bug-chaser", role: "brainstorm" };
    env.write({ id: "bs-a", title: "BC Buddy", lastStatus: "idle", cwd: REPO_ROOT, labels });
    env.write({ id: "bs-topic", title: "BC Buddy · icons", lastStatus: "idle", cwd: REPO_ROOT, labels: { ...labels, topic: "icons" } });
    const ok = env.run(["who", "brainstorm", "--team", "vibesquad", "--lane", "bug-chaser"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /CONFLICT/);

    env.write({ id: "bs-b", title: "Bug Buddy", lastStatus: "running", cwd: REPO_ROOT, labels });
    const res = env.run(["who", "brainstorm", "--team", "vibesquad", "--lane", "bug-chaser"]);
    assert.equal(res.status, 2, res.stderr);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], "CONFLICT");
    assert.ok(lines.some((l) => l.includes("bs-a")) && lines.some((l) => l.includes("bs-b")), res.stdout);

    const buddy = env.run(["who", "buddy", "--team", "vibesquad", "--lane", "bug-chaser", "--json"]);
    assert.equal(buddy.status, 2);
    assert.equal(JSON.parse(buddy.stdout).status, "conflict");
  } finally {
    env.cleanup();
  }
});

// ---- (c) pin warning + Keep this one ----

function pinFor(list) {
  const agents = new Map(list.map((a) => [a.id, { cwd: "/p/VibeSquad", ...a }]));
  const view = buildTeamViews(resolveMembers(agents)).find((v) => v.team.id === "vibesquad");
  return pinsForSquad(view).pinned.find((p) => p.lane.id === "vibesquad");
}

const vsBs = (id, over = {}) => ({ id, title: `VS Buddy ${id}`, status: "idle", updatedAt: "2026-11-02T10:00:00Z", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" }, ...over });

test("(c) the pin lists every live Buddy when there are 2+, and none for one live + one closed", () => {
  const two = pinFor([vsBs("a"), vsBs("b", { updatedAt: "2026-11-02T11:00:00Z" })]);
  assert.deepEqual(liveBuddyDupes(two).map((m) => m.agent.id).sort(), ["a", "b"]);
  const one = pinFor([vsBs("a"), vsBs("c", { status: "closed" })]);
  assert.deepEqual(liveBuddyDupes(one), []);
});

test("(c) Keep this one retires the other live Buddies (detach, (old), former-brainstorm, restarted-into) and archives nothing", async () => {
  const pin = pinFor([vsBs("a"), vsBs("b", { updatedAt: "2026-11-02T11:00:00Z" }), vsBs("c", { updatedAt: "2026-11-02T12:00:00Z", title: "(old) VS Buddy c" })]);
  const log = [];
  const r = await keepBuddy(pin, "a", {
    detachChildren: async (id) => void log.push(["detach", id]),
    update: async (id, u) => void log.push(["update", id, u]),
  });
  assert.deepEqual(r.retired.sort(), ["b", "c"]);
  assert.deepEqual(r.failed, []);
  const upd = Object.fromEntries(log.filter((e) => e[0] === "update").map((e) => [e[1], e[2]]));
  assert.deepEqual(upd.b, { name: "(old) VS Buddy b", labels: { role: "former-brainstorm", "vs.restarted-into": "a" } });
  assert.deepEqual(upd.c, { labels: { role: "former-brainstorm", "vs.restarted-into": "a" } }, "no double (old)");
  for (const id of ["b", "c"]) assert.ok(log.findIndex((e) => e[0] === "detach" && e[1] === id) < log.findIndex((e) => e[0] === "update" && e[1] === id), `${id} detached first`);
  assert.equal(log.some((e) => e[1] === "a"), false, "the kept Buddy is untouched");

  // A stale click (kept id is no longer a live dupe) does nothing.
  const none = await keepBuddy(pin, "zzz", { detachChildren: async () => assert.fail(), update: async () => assert.fail() });
  assert.deepEqual(none, { retired: [], failed: [] });
});

test("(c) a failed detach leaves that Buddy unretired and still retires the rest", async () => {
  const pin = pinFor([vsBs("a"), vsBs("b"), vsBs("c")]);
  const updated = [];
  const r = await keepBuddy(pin, "a", {
    detachChildren: async (id) => {
      if (id === "b") throw new Error("busy");
    },
    update: async (id) => void updated.push(id),
  });
  assert.deepEqual(r, { retired: ["c"], failed: ["b"] });
  assert.deepEqual(updated, ["c"]);
});
