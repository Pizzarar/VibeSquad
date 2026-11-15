// idea-233 (d): roster read coalescing (rosterGet, refreshLaneWhosHere) keyed only on the in-process rc.writeSeq missed writes
// from another process (an agent sidecar or a CLI with its own RunnerClient): a reader arriving after such a write could join
// a read that started before it and answer stale. The runner now reports its own settled-write count, so a joiner checks it.
// Real runner HTTP server (createServer) over a fake Runner; client B is the "other process" stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../runner/server.mjs";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";

const rec = (id, lane = "own") => ({ id, provider: "claude", cwd: ".", status: "idle", meta: { title: id, labels: { lane, role: "worker" } } });
const tick = () => new Promise((r) => setTimeout(r, 20));
/** Wait (capped) until cond() holds: fixed ticks are not enough when the suite runs files in parallel. */
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Fake Runner: holds the first `holdScans` roster scans until release() (snapshot taken when the scan starts, like the real one). */
function fakeRunner({ holdScans = 1 } = {}) {
  const gates = [];
  const r = {
    roster: [rec("rn-a")],
    scans: 0,
    live: new Map(),
    list: () => r.roster.map((a) => a.id),
    status: (id) => r.roster.find((a) => a.id === id) ?? null,
    create: () => {
      const id = `rn-${r.roster.length}`;
      r.roster = [...r.roster, rec(id)];
      return id;
    },
    queuePosition: () => ({}),
    async statusAllAsync() {
      r.scans += 1;
      const snapshot = r.roster;
      if (r.scans <= holdScans) await new Promise((res) => gates.push(res));
      return { ids: snapshot.map((a) => a.id), agents: snapshot };
    },
    release() {
      for (const g of gates.splice(0)) g();
    },
  };
  return r;
}

async function rig(opts) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-roster-seq-"));
  const home = path.join(dir, "runner");
  mkdirSync(home, { recursive: true });
  const runner = fakeRunner(opts);
  const token = "t0k";
  const server = createServer(runner, { token, hash: "h" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: server.address().port, pid: process.pid }));
  writeFileSync(path.join(home, "token"), token);
  const a = new RunnerClient({ home, caller: null });
  const b = new RunnerClient({ home, caller: null }); // another process: its writes never touch a.writeSeq
  const briefs = [];
  const backend = new RunnerBackend({ client: a, buildPrefix: async () => "", whosHere: ({ laneId, agents }) => briefs.push({ laneId, ids: agents.map((x) => x.id) }), lanes: () => new Set(["own"]) });
  const cleanup = async () => {
    runner.release();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  };
  return { runner, a, b, backend, briefs, cleanup };
}

test("runner reports its settled-write count: GET /write-seq and the full roster carry { boot, seq }", async () => {
  const r = await rig({ holdScans: 0 });
  try {
    const s0 = await r.a.request("GET", "/write-seq");
    assert.equal(typeof s0.boot, "string");
    assert.equal(s0.seq, 0);
    await r.b.request("POST", "/agents", { provider: "claude", cwd: "." });
    const s1 = await r.a.request("GET", "/write-seq");
    assert.deepEqual(s1, { boot: s0.boot, seq: 1 }, "another client's write counts");
    const roster = await r.a.request("GET", "/agents?full=1");
    assert.deepEqual(roster.writeSeq, { boot: s0.boot, seq: 1 });
  } finally {
    await r.cleanup();
  }
});

test("rosterGet: a reader after another process's write does not join the read that started before it", async () => {
  const r = await rig({ holdScans: 1 });
  try {
    const before = r.backend.listAgents();
    await until(() => r.runner.scans === 1);
    await r.b.request("POST", "/agents", { provider: "claude", cwd: "." }); // settles; a.writeSeq is unchanged
    assert.equal(r.a.writeSeq, 0);
    const after = r.backend.listAgents();
    await tick();
    r.runner.release();
    assert.deepEqual((await before).map((x) => x.id), ["rn-a"]);
    assert.deepEqual((await after).map((x) => x.id), ["rn-a", "rn-1"], "the post-write reader sees the other process's write");
  } finally {
    await r.cleanup();
  }
});

test("rosterGet: with no write anywhere, concurrent readers still share one roster scan", async () => {
  const r = await rig({ holdScans: 1 });
  try {
    const all = Promise.all([r.backend.listAgents(), r.backend.listAgents(), r.backend.listAgents()]);
    await until(() => r.runner.scans === 1);
    await tick();
    r.runner.release();
    const res = await all;
    for (const x of res) assert.deepEqual(x.map((y) => y.id), ["rn-a"]);
    assert.equal(r.runner.scans, 1, "three readers, one scan");
  } finally {
    await r.cleanup();
  }
});

test("refreshLaneWhosHere: a refresh asked for after another process's write ends with a brief that shows it", async () => {
  const r = await rig({ holdScans: 1 });
  try {
    const first = r.backend.refreshLaneWhosHere("own");
    await until(() => r.runner.scans === 1);
    await r.b.request("POST", "/agents", { provider: "claude", cwd: "." });
    const second = r.backend.refreshLaneWhosHere("own");
    await tick();
    r.runner.release();
    await Promise.all([first, second]);
    assert.deepEqual(r.briefs.at(-1), { laneId: "own", ids: ["rn-a", "rn-1"] });
  } finally {
    await r.cleanup();
  }
});
