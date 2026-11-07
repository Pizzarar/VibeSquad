import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSpawnTimer, performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { RunnerBackend, SPAWN_TIMING } from "../server/backend/runner-backend.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

test("spawn timer lists each marked step and a total", () => {
  const t = createSpawnTimer("new-buddy");
  t.mark("connect");
  t.mark("createAgent");
  assert.match(t.summary(), /^new-buddy: connect=\d+ms createAgent=\d+ms total=\d+ms loopLagMax=\d+ms$/);
});

test("spawn timer prints createAgent sub-parts from a marked sub-string", () => {
  const t = createSpawnTimer("buddy-restart");
  t.mark("connect");
  t.mark("createAgent", "req=0,hh=1,hk=120,pfx=3,post=251000,get=4,whos=2");
  assert.match(t.summary(), /createAgent=\d+ms\(req=0,hh=1,hk=120,pfx=3,post=251000,get=4,whos=2\)/);
});

test("worst-case createAgent sub-parts (6-digit ms in every part) keep the metric under the 240-char limit", () => {
  const t = createSpawnTimer("buddy-restart");
  t.mark("connect");
  t.mark("fetchAgent");
  t.mark("prep");
  t.mark("inFlight");
  t.mark("createAgent", "req=999999,hh=999999,hk=999999,pfx=999999,post=999999,get=999999,whos=999999");
  const line = `spawn-timing ${t.summary()}`;
  assert.ok(line.length <= 240, `metric line is ${line.length} chars (must be <= 240): ${line}`);
  // Absolute worst case: 6-digit ms for every outer step AND total/loopLagMax, built literally.
  const worst = "spawn-timing buddy-restart: connect=999999ms fetchAgent=999999ms prep=999999ms inFlight=999999ms createAgent=999999ms(req=999999,hh=999999,hk=999999,pfx=999999,post=999999,get=999999,whos=999999) total=999999ms loopLagMax=999999ms";
  assert.ok(worst.length <= 240, `worst-case metric length ${worst.length} (must be <= 240)`);
});

test("a RunnerBackend.createAgent with a slow hook/post shows the parts in the metric line", async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const backend = new RunnerBackend({
    client: {
      async requireRunning() {},
      async request(method, route) {
        if (method === "POST" && route === "/agents") { await delay(30); return { id: "rn-x" }; }
        if (method === "GET" && route === "/agents/rn-x") return { id: "rn-x", provider: "claude", cwd: ".", status: "idle", meta: { title: "T" } };
        throw new Error(`unexpected ${method} ${route}`);
      },
    },
    buildPrefix: async () => "",
    whosHere: async () => {},
    lanes: () => new Set(),
    hooks: { before: async () => { await delay(15); return undefined; } },
  });
  const created = await backend.createAgent({ config: { provider: "claude", cwd: "." }, labels: {}, env: {} });
  const t = createSpawnTimer("buddy-restart");
  t.mark("connect");
  t.mark("createAgent", Object.entries(created[SPAWN_TIMING]).map(([k, v]) => `${k}=${v}`).join(","));
  assert.match(t.summary(), /createAgent=\d+ms\(req=\d+,hh=\d+,hk=\d+,pfx=\d+,post=\d+,get=\d+,whos=\d+\)/);
});

test("a Buddy restart writes one spawn-timing metric with every step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-timing-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const daemon = {
      async createAgent() { return { id: "new-1" }; },
      async cancelAgent() {},
      async updateAgent() {},
      async archiveAgent() {},
    };
    const r = await performBrainstormRestart(
      {
        agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual",
        oldAgent: { id: "bs-1", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
        daemonClient: daemon,
      },
      dir,
    );
    assert.equal(r.newAgentId, "new-1");
    const lines = readFileSync(join(dir, ".vibesquad", "teams", "site", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const timing = lines.filter((e) => e.text.startsWith("spawn-timing buddy-restart:"));
    assert.equal(timing.length, 1);
    assert.equal(timing[0].type, "metric");
    for (const step of ["prep=", "createAgent=", "total="]) assert.ok(timing[0].text.includes(step), step);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-retire-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  return {
    dir,
    done() {
      if (prev === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function gatedClient({ failArchive = false } = {}) {
  const calls = [];
  const gates = {};
  const gate = (name) => new Promise((r) => (gates[name] = r));
  const cancelGate = gate("cancel");
  const archiveGate = gate("archive");
  const client = {
    closes: 0,
    async connect() {},
    async createAgent() { return { id: "new-2" }; },
    async cancelAgent(id) { await cancelGate; calls.push(["cancel", id]); },
    async updateAgent(id) { calls.push(["update", id]); },
    async archiveAgent(id) {
      await archiveGate;
      calls.push(["archive", id]);
      if (failArchive) throw new Error("archive failed");
    },
    async close() { client.closes++; calls.push(["close"]); },
  };
  return { client, calls, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

for (const failArchive of [false, true]) {
  test(`restart replies before retire finishes, then closes the client once after it settles (archive ${failArchive ? "fails" : "ok"})`, async () => {
    const sb = sandbox();
    try {
      const { client, calls, gates } = gatedClient({ failArchive });
      const r = await performBrainstormRestart(
        {
          agentId: "bs-2", teamId: "site", laneId: "pinned", reason: "manual",
          oldAgent: { id: "bs-2", title: "BRAINSTORM · PINNED", cwd: sb.dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
          clientFactory: () => client,
        },
        sb.dir,
      );
      assert.equal(r.newAgentId, "new-2");
      assert.deepEqual(calls, [], "reply must not wait for cancel/update/archive");
      assert.equal(client.closes, 0);
      gates.cancel();
      await tick();
      assert.deepEqual(calls, [["cancel", "bs-2"], ["update", "bs-2"]]);
      assert.equal(client.closes, 0, "client stays open until archive settles");
      gates.archive();
      await tick();
      assert.deepEqual(calls, [["cancel", "bs-2"], ["update", "bs-2"], ["archive", "bs-2"], ["close"]]);
      assert.equal(client.closes, 1);
    } finally {
      sb.done();
    }
  });
}

test("start-brainstorm during a pending retire returns the new Buddy, not the retiring one", async () => {
  const sb = sandbox();
  try {
    const { client } = gatedClient();
    const oldBuddy = { id: "bs-2", title: "BRAINSTORM · PINNED", cwd: sb.dir, updatedAt: "2026-11-02T03:00:00Z", labels: { team: "site", lane: "pinned", role: "brainstorm" } };
    await performBrainstormRestart(
      { agentId: "bs-2", teamId: "site", laneId: "pinned", reason: "manual", oldAgent: { ...oldBuddy }, clientFactory: () => client },
      sb.dir,
    );
    // The daemon still lists the old Buddy as a live brainstorm (retire pending) and it looks newer.
    const newBuddy = { id: "new-2", title: "BRAINSTORM · PINNED", cwd: sb.dir, updatedAt: "2026-11-02T02:00:00Z", labels: { team: "site", lane: "pinned", role: "brainstorm" } };
    const r = await performBrainstormRestart(
      { agentId: "start-brainstorm", reason: "start-brainstorm", teamId: "site", laneId: "pinned", agents: [oldBuddy, newBuddy], skipDaemon: true },
      sb.dir,
    );
    assert.equal(r.reused, true);
    assert.equal(r.existingAgentId, "new-2");
  } finally {
    sb.done();
  }
});

test("spawn timer reports the worst event-loop stall as loopLagMax on the same metric", async () => {
  const t = createSpawnTimer("new-buddy");
  await new Promise((r) => setTimeout(r, 10));
  const end = Date.now() + 250;
  while (Date.now() < end); // block our own loop
  await new Promise((r) => setTimeout(r, 120));
  const lag = Number(/loopLagMax=(\d+)ms/.exec(t.summary())?.[1]);
  assert.ok(lag >= 150, `loopLagMax=${lag}`);
});
