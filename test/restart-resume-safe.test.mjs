// ideas 88 + 109: restarts must not cut or wedge agents.
// 109: a prompt-less resume (the restart script's POST /agents/:id/resume) read `starting` forever: no adapter reports a turn
//      it never ran. It must settle to idle once the adapter is ready, and a resume that stays stuck must be retried once,
//      then made visibly lost (runner unwedge + restart-runtime verify).
// 88:  the server's RR1 supervisor must not hard-restart the runner while an idle agent holds background work (a suite);
//      `vs restart` must defer instead of killing it; the server's boot baseline must replay events that landed while
//      no server was running (a worker's turn_ended in the restart gap went undigested and unwoken).
// Fake adapters / stub processes and temp homes only: nothing here touches a real runner, server or ~/.vibesquad.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { createServer as createRunnerServer } from "../runner/server.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";
import { parseArgs, restartRuntime } from "../scripts/restart-runtime.mjs";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";
import { RunnerClient } from "../server/backend/runner-client.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-rrs-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out"); await tick(10); } };
const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

/** Fake adapter: `ready` per start (a never-settling one models an ACP handshake that hangs). */
function fakeAdapter({ readyFor = () => undefined } = {}) {
  const starts = [];
  const adapter = {
    canPark: true,
    start({ id, emit, resume }) {
      const rec = { id, resume, emit, killed: 0 };
      starts.push(rec);
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { pid: 4000 + starts.length, ready: readyFor(rec), send() { emit("status", { status: "running" }); }, cancel() {}, kill() { rec.killed += 1; } };
    },
  };
  return { adapter, starts };
}

/** A runner with one agent that was cut mid-turn by a keep-resumable shutdown: reads `lost` in a second runner on the same dir. */
async function lostAgent(adapterOpts, runnerOpts = {}) {
  const dir = tmp();
  const a1 = fakeAdapter();
  const r1 = new Runner({ dir, adapters: { claude: a1.adapter } });
  const id = r1.create({ provider: "claude", cwd: process.cwd(), prompt: "work", meta: {} });
  await tick(30);
  r1.shutdown({ keepResumable: true });
  const a2 = fakeAdapter(adapterOpts);
  const runner = new Runner({ dir, adapters: { claude: a2.adapter }, parkGraceMs: 60_000, ...runnerOpts });
  assert.equal(runner.status(id).status, "lost");
  return { id, runner, starts: a2.starts };
}

test("109: a prompt-less resume settles to idle once the adapter is ready (not `starting` forever), then parks after the grace", async () => {
  const { id, runner, starts } = await lostAgent({}, { parkGraceMs: 40 });
  assert.equal(runner.resume(id), true);
  await until(() => runner.status(id).status === "idle", 1000);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].resume, `sess-${id}`, "resumed from its saved session");
  await until(() => runner.status(id).status === "parked", 1000); // the normal after-turn park: no live slot held forever
  assert.equal(starts[0].killed, 1);
  runner.shutdown();
});

test("109: an ACP-style resume stays `starting` until its handshake resolves, and a send during the handshake owns the status", async () => {
  let release;
  const { id, runner } = await lostAgent({ readyFor: () => new Promise((r) => { release = r; }) });
  runner.resume(id);
  await tick(30);
  assert.equal(runner.status(id).status, "starting", "handshake still pending");
  release();
  await until(() => runner.status(id).status === "idle", 1000);

  let release2;
  const b = await lostAgent({ readyFor: () => new Promise((r) => { release2 = r; }) });
  b.runner.resume(b.id);
  await tick(20);
  b.runner.send(b.id, "go");
  await until(() => b.runner.status(b.id).status === "running", 1000);
  release2();
  await tick(30);
  assert.equal(b.runner.status(b.id).status, "running", "a turn that started meanwhile is not overwritten with idle");
  runner.shutdown(); b.runner.shutdown();
});

test("109: unwedge retries a stuck `starting` resume once, then fails it visibly (lost + error), never touching a healthy agent", async () => {
  const { id, runner, starts } = await lostAgent({ readyFor: () => new Promise(() => {}) }); // the handshake never finishes
  runner.resume(id);
  await tick(30);
  assert.equal(runner.status(id).status, "starting");
  assert.deepEqual(runner.unwedge(id, { retry: true }), { action: "retried" });
  await tick(30);
  assert.equal(starts.length, 2, "one fresh start");
  assert.equal(starts[0].killed, 1, "the stuck child was stopped");
  assert.equal(starts[1].resume, `sess-${id}`);
  assert.equal(runner.status(id).status, "starting", "still stuck after the retry");
  const r = runner.unwedge(id, { reason: "still starting 90s after resume" });
  assert.equal(r.action, "failed");
  assert.equal(starts[1].killed, 1);
  const s = runner.status(id);
  assert.equal(s.status, "lost", "visibly lost, not initializing");
  assert.equal(s.resumable, true, "the next send can still bring it back");
  assert.ok(!runner.live.has(id), "no live slot held");
  assert.match(runner.timeline(id).filter((e) => e.type === "error").at(-1).message, /resume did not finish starting: still starting 90s/);
  assert.ok(runner.timeline(id).every((e) => e.type !== "exit"), "no exit: still resumable");

  const ok = await lostAgent();
  ok.runner.resume(ok.id);
  await until(() => ok.runner.status(ok.id).status === "idle", 1000);
  assert.equal(ok.runner.unwedge(ok.id, { retry: true }).action, "not-wedged");
  assert.equal(ok.starts[0].killed, 0, "a healthy agent is left alone");
  runner.shutdown(); ok.runner.shutdown();
});

test("109: runner HTTP: POST /agents/:id/unwedge (token-gated), /health reports held agents", async () => {
  const { id, runner } = await lostAgent({ readyFor: () => new Promise(() => {}) });
  const srv = createRunnerServer(runner, { token: "t0k", hash: "h" });
  const port = await listen(srv);
  const call = (method, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: "Bearer t0k", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    runner.resume(id);
    await tick(30);
    assert.equal((await fetch(`http://127.0.0.1:${port}/agents/${id}/unwedge`, { method: "POST" })).status, 401);
    assert.equal((await call("POST", "/agents/rn-nope/unwedge", {})).status, 404);
    const r = await call("POST", `/agents/${id}/unwedge`, { retry: false, reason: "x".repeat(500) });
    assert.equal(r.status, 200);
    assert.equal(r.body.action, "failed");
    assert.equal(r.body.status, "lost");
    const h = await call("GET", "/health");
    assert.equal(h.body.held, 0);
    assert.deepEqual(h.body.heldAgents, []);
    runner.live.set("rn-held", { inflight: 0, quiet: false, heldSince: Date.now() }); // shape of an idle agent whose park is held
    const h2 = await call("GET", "/health");
    assert.equal(h2.body.held, 1);
    assert.equal(h2.body.running, 0, "held work is not a running turn");
    assert.deepEqual(h2.body.heldAgents, ["rn-held"]);
    runner.live.delete("rn-held");
  } finally { await close(srv); runner.shutdown(); }
});

/** Supervisor with a fake healthy runner; each next() advances one tick. */
function supervisor(state) {
  const logs = [];
  let restarts = 0;
  const pending = [];
  const sup = superviseRunner({ rc: { healthy: async () => true } }, {
    healthInfo: async () => state.health, diskHash: () => state.disk, restart: async () => { restarts += 1; },
    log: (m) => logs.push(m), setTimer: (fn) => { pending.push(fn); return { unref() {} }; }, clearTimer() {},
  });
  return { sup, logs, restarts: () => restarts, next: async () => { const fn = pending.shift(); if (fn) await fn(); } };
}

test("88: a server boot with new runner code never hard-restarts the runner while an idle agent holds background work", async () => {
  const state = { disk: "new", health: { hash: "old", running: 0, held: 1 } };
  const h = supervisor(state);
  await h.sup.ready;
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.restarts(), 0, "a background suite under an idle agent is not cut");
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /restart pending: 1 agent\(s\) holding background work/);
  state.health = { hash: "old", running: 0, held: 0 };
  await h.next();
  assert.equal(h.restarts(), 1, "restarts once the work is done");
  h.sup.stop();
});

// 88-B: a worker's turn_ended appended while no server ran (the restart gap) was baselined as history: no digest, no wake.
function gapHome({ seen, now }) {
  const home = tmp("vs-rrs-home-");
  const dir = path.join(home, "agents");
  mkdirSync(dir, { recursive: true });
  const t0 = now - 120_000;
  const line = (seq, ts, type, o = {}) => JSON.stringify({ seq, ts, type, ...o }) + "\n";
  // worker: turn running before the old server died (t0+10s), turn ends in the gap (t0+60s)
  writeFileSync(path.join(dir, "rn-worker.jsonl"),
    line(0, t0, "created", { provider: "claude", cwd: home, meta: { title: "w" } }) + line(1, t0 + 1, "input", { text: "go" }) +
    line(2, t0 + 2, "status", { status: "running" }) + line(3, t0 + 60_000, "turn_done", {}) + line(4, t0 + 60_001, "status", { status: "idle" }));
  // an agent created entirely inside the gap replays from seq 0
  writeFileSync(path.join(dir, "rn-new.jsonl"), line(0, t0 + 70_000, "created", { provider: "claude", cwd: home, meta: {} }));
  if (seen) writeFileSync(path.join(home, "server-seen.json"), JSON.stringify({ ts: t0 + 10_000, aliveAt: seen === "stale" ? now - 3 * 60 * 60_000 : t0 + 15_000 }));
  return { home, t0 };
}
const backendFor = (home) => new RunnerBackend({ client: new RunnerClient({ home }), rootDir: tmp("vs-rrs-root-"), hooks: false });

test("88: the boot baseline ends where the previous server stopped: a turn_ended from the restart gap replays once", async () => {
  const now = Date.now();
  const { home, t0 } = gapHome({ seen: "fresh", now });
  const b = backendFor(home);
  await b.enableCatchUp({ now });
  assert.equal(b.live.hwm.get("rn-worker"), 2, "history stops at the last event the old server handled");
  assert.equal(b.live.turn.get("rn-worker").status, "running", "the open turn is known");
  assert.equal(b.live.hwm.get("rn-new"), -1, "created in the gap: replays from seq 0");
  const ended = [];
  b.listeners.add((e) => { if (e.kind === "turn_ended") ended.push(e.agentId); });
  const ev = (seq, ts, type, o = {}) => ({ seq, ts, type, ...o });
  await b.handleLogEvent({ id: "rn-worker", event: ev(3, t0 + 60_000, "turn_done") });
  await b.handleLogEvent({ id: "rn-worker", event: ev(4, t0 + 60_001, "status", { status: "idle" }) });
  await b.handleLogEvent({ id: "rn-worker", event: ev(4, t0 + 60_001, "status", { status: "idle" }) }); // a second replay (reconnect)
  assert.deepEqual(ended, ["rn-worker"], "turn_ended fires exactly once for the gap event");
  b.flushSeen();
  const saved = JSON.parse(readFileSync(path.join(home, "server-seen.json"), "utf8"));
  assert.equal(saved.ts, t0 + 60_001, "the newest handled event is persisted for the next boot");
  assert.ok(saved.aliveAt >= now, "liveness refreshed on write");
});

test("88: no seen file, or an outage longer than the cap, keeps the old rule (everything logged is history); the baseline seeds the file", async () => {
  for (const seen of [null, "stale"]) {
    const now = Date.now();
    const { home, t0 } = gapHome({ seen, now });
    const b = backendFor(home);
    await b.enableCatchUp({ now });
    assert.equal(b.live.hwm.get("rn-worker"), 4, `${seen ?? "no file"}: whole log is history`);
    assert.equal(b.live.hwm.get("rn-new"), 0);
    const saved = JSON.parse(readFileSync(path.join(home, "server-seen.json"), "utf8"));
    assert.equal(saved.ts, t0 + 70_000, "seeded with the newest history event, so the next restart gap is covered");
  }
});
