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
import { Runner, CONTINUE_PROMPT } from "../runner/runner.mjs";
import { createServer as createRunnerServer } from "../runner/server.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";
import { parseArgs, restartRuntime } from "../scripts/restart-runtime.mjs";
import { RunnerBackend, readRunnerAgentSync } from "../server/backend/runner-backend.mjs";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-rrs-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out"); await tick(10); } };
const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

/**
 * Fake adapter: `ready` per start (a never-settling one models an ACP handshake that hangs). Each start records the texts
 * sent to it. acpLike: `running` only once `ready` resolves (the ACP adapter pumps prompts after its handshake).
 */
function fakeAdapter({ readyFor = () => undefined, acpLike = false } = {}) {
  const starts = [];
  const adapter = {
    canPark: true,
    start({ id, emit, resume }) {
      const rec = { id, resume, emit, killed: 0, sends: [] };
      starts.push(rec);
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      const ready = readyFor(rec);
      const send = (text) => { rec.sends.push(text); if (acpLike) Promise.resolve(ready).then(() => emit("status", { status: "running" }), () => {}); else emit("status", { status: "running" }); };
      return { pid: 4000 + starts.length, ready, send, cancel() {}, kill() { rec.killed += 1; } };
    },
  };
  return { adapter, starts };
}

/** A runner process that died without a shutdown (crash, hard kill): it writes nothing more to the log. */
function crash(r) {
  r._shutDown = true; // its park timers return without logging
  clearInterval(r._quietSweep);
  for (const e of r.live.values()) clearTimeout(e.parkTimer);
}

/**
 * A runner with one agent that reads `lost` in a second runner on the same dir. cut: the turn was still running when a
 * keep-resumable shutdown stopped the first runner (idea-126: that resume continues the turn). Otherwise the turn ended and
 * the runner died in the park grace, so the agent is lost between turns (a prompt-less resume).
 */
async function lostAgent(adapterOpts, runnerOpts = {}, dir = tmp(), { cut = false, meta = {} } = {}) {
  const a1 = fakeAdapter();
  const r1 = new Runner({ dir, adapters: { claude: a1.adapter } });
  const id = r1.create({ provider: "claude", cwd: process.cwd(), prompt: "work", meta });
  await tick(30);
  if (cut) r1.shutdown({ keepResumable: true });
  else { a1.starts[0].emit("status", { status: "idle" }); crash(r1); }
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

// ---- Tier A review R1 (review-restart-resume.md) ----------------------------------------------------------------------

test("R1 H1: an idle agent counts as held from the moment its turn ends until its first background probe comes back clean", async () => {
  let answer = null; // the probe stays pending until the test says what it sees
  const waiters = [];
  const bgProbe = () => new Promise((r) => { const go = () => r(answer); if (answer !== null) go(); else waiters.push(go); });
  const settle = (work) => { answer = work; for (const go of waiters.splice(0)) go(); };
  const { adapter, starts } = fakeAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 80, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe });
  const srv = createRunnerServer(runner, { token: "t0k", hash: "h" });
  const port = await listen(srv);
  const health = () => fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: "Bearer t0k" } }).then((r) => r.json());
  try {
    const id = runner.create({ provider: "claude", cwd: process.cwd(), prompt: "start the suite in the background, then end the turn", meta: {} });
    await tick(20);
    starts[0].emit("status", { status: "idle" }); // the turn ends; its suite keeps running under the CLI
    assert.deepEqual(runner.heldIds(), [id], "inside the park grace, before any probe: a restart must not see running:0 held:0");
    const h = await health();
    assert.deepEqual([h.running, h.held, h.heldAgents], [0, 1, [id]]);
    await tick(120); // grace over, probe pending
    assert.deepEqual(runner.heldIds(), [id], "while the probe runs");
    settle([{ pid: 9000, name: "bash", cmd: "npm test" }]);
    await until(() => runner.timeline(id).some((e) => e.type === "park-held"), 1000);
    assert.deepEqual(runner.heldIds(), [id], "held park");
    answer = []; // the suite exits: the next probe is clean, the agent is woken to read it (idea-112), then parks
    await until(() => runner.status(id).status === "running", 2000);
    assert.equal(starts[0].sends.at(-1).startsWith("[VibeSquad runtime] Background work"), true, "the bg-wake");
    assert.deepEqual(runner.heldIds(), [], "a running turn is not held: the restart counts it as running");
    starts[0].emit("status", { status: "idle" }); // the woken turn reports and ends
    await until(() => runner.status(id).status === "parked", 2000);
    assert.deepEqual(runner.heldIds(), []);
    const fresh = await lostAgent();
    fresh.runner.resume(fresh.id);
    await until(() => fresh.runner.status(fresh.id).status === "idle", 1000);
    assert.deepEqual(fresh.runner.heldIds(), [], "a prompt-less resume ran no turn: nothing to hold");
    fresh.runner.shutdown();
  } finally { await close(srv); runner.shutdown(); }
});

/** A cut agent in <home>/agents plus a RunnerBackend whose catch-up baseline was taken before the resume. */
async function cutAgentWithBackend(runnerOpts = {}, fixture = {}, adapterOpts = {}) {
  const home = tmp("vs-rrs-h2-");
  const dir = path.join(home, "agents");
  mkdirSync(dir, { recursive: true });
  const lost = await lostAgent(adapterOpts, runnerOpts, dir, fixture);
  const backend = backendFor(home);
  await backend.enableCatchUp();
  const ended = [];
  backend.listeners.add((e) => { if (e.kind === "turn_ended") ended.push(e.outcome?.kind); });
  const feed = async () => { for (const event of lost.runner.timeline(lost.id).filter((e) => e.seq > (backend.live.hwm.get(lost.id) ?? -1))) await backend.handleLogEvent({ id: lost.id, event }); };
  return { ...lost, home, backend, ended, feed };
}

test("R1 H2: a prompt-less resume (settle to idle, then park) never reads as a completed turn on the server; a real turn after it ends once", async () => {
  // A cut turn too old to continue (idea-126: older than the queue max age) resumes prompt-less over an open server turn.
  const c = await cutAgentWithBackend({ parkGraceMs: 30, queueMaxAgeMs: 1 }, { cut: true });
  assert.equal(c.backend.live.turn.get(c.id).status, "running", "the baseline knows the turn the restart cut");
  c.runner.resume(c.id);
  await until(() => c.runner.status(c.id).status === "parked", 1000);
  await c.feed();
  assert.deepEqual(c.ended, [], "no turn_ended for a turn that never ran (it would spawn a digest / confirm a takeover)");
  const resumeStatuses = c.runner.timeline(c.id).filter((e) => e.type === "status" && e.resume === true).map((e) => e.status);
  assert.deepEqual(resumeStatuses, ["starting", "idle"], "the lifecycle statuses are tagged");
  c.runner.send(c.id, "next");
  await until(() => c.starts.length === 2 && c.runner.status(c.id).status === "running", 1000);
  c.starts[1].emit("status", { status: "idle" });
  await c.feed();
  assert.deepEqual(c.ended, ["completed"], "the real turn ends exactly once");
  c.runner.shutdown();
});

test("R1 M1: unwedge without retry leaves a terminal lost status: vs who (readRunnerAgentSync) and the server turn state read closed/lost, not initializing", async () => {
  const c = await cutAgentWithBackend();
  const never = fakeAdapter({ readyFor: () => new Promise(() => {}) });
  c.runner.adapters.claude = never.adapter; // the resumed child never finishes its handshake
  writeFileSync(path.join(c.home, "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: Date.now() - 1000 })); // a live runner wrote these events
  c.runner.resume(c.id);
  await tick(30);
  assert.equal(c.runner.unwedge(c.id, { reason: "still starting" }).action, "failed");
  const last = c.runner.timeline(c.id).filter((e) => e.type === "status").at(-1);
  assert.equal(last.status, "lost", "a terminal status event, not just an error");
  const who = readRunnerAgentSync(c.id, { home: c.home });
  assert.deepEqual([who.status, who.lost, who.resumable], ["closed", true, true]);
  await c.feed();
  assert.equal(c.backend.live.turn.get(c.id).status, "closed", "server turn state is not left initializing");
  assert.deepEqual(c.ended, [], "giving up is not a completed turn either");
  assert.equal(c.runner.resume(c.id), true, "a send/resume can still bring it back");
  c.runner.shutdown();
});

test("R1 M2: a send queued behind the turn cap during a resume handshake keeps `queued` as the last status; no park, the prompt survives a restart", async () => {
  let release;
  const caps = { claude: 1, gemini: 1, antigravity: 1, other: 1 };
  const { id, runner } = await lostAgent({ readyFor: (rec) => (rec.resume ? new Promise((r) => { release = r; }) : undefined) }, { parkGraceMs: 20, turnCaps: caps });
  runner.create({ provider: "claude", cwd: process.cwd(), prompt: "hold the only claude turn slot", meta: {} });
  runner.resume(id);
  await tick(20);
  runner.send(id, "queued behind the cap");
  assert.equal(runner.timeline(id).filter((e) => e.type === "status").at(-1).status, "queued");
  release();
  await tick(80);
  assert.equal(runner.timeline(id).filter((e) => e.type === "status").at(-1).status, "queued", "not overwritten with idle");
  assert.ok(runner.live.has(id), "not parked while its send waits");
  assert.ok(runner.queue.some((j) => j.id === id), "still queued in memory");
  const r2 = new Runner({ dir: runner.store.dir, adapters: { claude: fakeAdapter().adapter }, turnCaps: caps }); // a runner restart now re-enqueues it
  assert.deepEqual(r2.recoverQueued(), [id]);
  runner.shutdown(); r2.shutdown();
});

/** Fake claude child for the real claude adapter. */
function fakeClaudeSpawn({ exitAfterMs = null } = {}) {
  const impl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 7000;
    child.kill = () => child.emit("exit", null, "SIGTERM");
    if (exitAfterMs !== null) setTimeout(() => child.emit("exit", 1, null), exitAfterMs);
    return child;
  };
  return impl;
}

test("R1 M3a: the claude adapter has a ready promise: it resolves after the settle window, and rejects when the CLI exits first", async () => {
  const promptsDir = tmp("vs-rrs-cl-");
  const ok = createClaudeAdapter({ spawnImpl: fakeClaudeSpawn(), command: process.execPath, mcp: false, promptsDir, readySettleMs: 40 })
    .start({ id: "rn-a", cwd: promptsDir, emit() {}, onExit() {}, resume: "sess-a" });
  assert.ok(ok.ready && typeof ok.ready.then === "function", "a prompt-less resume has something to wait on");
  let state = "pending";
  ok.ready.then(() => { state = "ready"; }, () => { state = "rejected"; });
  await tick(15);
  assert.equal(state, "pending", "not ready the instant it is spawned");
  await tick(60);
  assert.equal(state, "ready");
  const bad = createClaudeAdapter({ spawnImpl: fakeClaudeSpawn({ exitAfterMs: 5 }), command: process.execPath, mcp: false, promptsDir, readySettleMs: 200 })
    .start({ id: "rn-b", cwd: promptsDir, emit() {}, onExit() {}, resume: "sess-b" });
  await assert.rejects(bad.ready, /exited before it was ready/);
});

test("R1 M3b: a turn-edge event is persisted before its lifecycle reaches the hooks, so a kill right after a digest cannot replay it", async () => {
  const now = Date.now();
  const { home, t0 } = gapHome({ seen: "fresh", now });
  const b = backendFor(home);
  await b.enableCatchUp({ now });
  let savedAtEmit = null;
  b.listeners.add((e) => { if (e.kind === "turn_ended") savedAtEmit = JSON.parse(readFileSync(path.join(home, "server-seen.json"), "utf8")).ts; });
  await b.handleLogEvent({ id: "rn-worker", event: { seq: 3, ts: t0 + 60_000, type: "turn_done" } });
  await b.handleLogEvent({ id: "rn-worker", event: { seq: 4, ts: t0 + 60_001, type: "status", status: "idle" } });
  assert.equal(savedAtEmit, t0 + 60_001, "server-seen.json already names the idle when turn_ended is dispatched (no 1s window)");
  // A hard kill right after the dispatch: the next boot treats that idle as history, so no second turn_ended / digest.
  const b2 = backendFor(home);
  await b2.enableCatchUp({ now: Date.now() });
  assert.equal(b2.live.hwm.get("rn-worker"), 4, "history includes the dispatched idle");
  assert.equal(b2.live.turn.get("rn-worker").status, "idle", "no open turn left to end again");
});

test("R2: a turn-edge event in the same millisecond as a throttled one is still written at once (cold-start restart replayed its turn_ended)", async () => {
  const now = Date.now();
  const { home, t0 } = gapHome({ seen: "fresh", now });
  const b = backendFor(home);
  await b.enableCatchUp({ now });
  const T = t0 + 60_000;
  const log = path.join(home, "agents", "rn-worker.jsonl"); // same-ms turn_done + idle on disk too (the fake adapter emits both back to back)
  writeFileSync(log, readFileSync(log, "utf8").replace(`"ts":${t0 + 60_001}`, `"ts":${T}`));
  await b.handleLogEvent({ id: "rn-worker", event: { seq: 3, ts: T, type: "turn_done" } }); // throttled: arms the 1s timer, seenTs = T
  await b.handleLogEvent({ id: "rn-worker", event: { seq: 4, ts: T, type: "status", status: "idle" } }); // same ms: must still flush now
  assert.equal(JSON.parse(readFileSync(path.join(home, "server-seen.json"), "utf8")).ts, T, "the idle is on disk before the 1s timer");
  const b2 = backendFor(home); // a lifecycle restart right now
  await b2.enableCatchUp({ now: Date.now() });
  assert.equal(b2.live.hwm.get("rn-worker"), 4, "the idle is history: no second turn_ended");
});

// ---- Follow-ups (idea-126 / idea-122 / idea-124) ------------------------------------------------------------------------

const statuses = (runner, id) => runner.timeline(id).filter((e) => e.type === "status");

test("idea-126: resuming an agent the restart cut mid-turn continues the turn (a continue prompt through the resume path); the server sees one real turn", async () => {
  const c = await cutAgentWithBackend({ parkGraceMs: 30, bgProbe: null }, { cut: true });
  assert.equal(c.backend.live.turn.get(c.id).status, "running", "the baseline knows the turn the restart cut");
  assert.equal(c.runner.resume(c.id), true);
  await until(() => c.runner.status(c.id).status === "running", 1000);
  assert.equal(c.starts.length, 1);
  assert.equal(c.starts[0].resume, `sess-${c.id}`, "resumed from its saved session");
  assert.deepEqual(c.starts[0].sends, [CONTINUE_PROMPT], "the turn continues instead of idling");
  const tail = c.runner.timeline(c.id).filter((e) => ["status", "input"].includes(e.type)).slice(-4).map((e) => [e.type, e.status ?? e.text, e.resume ?? null]);
  assert.deepEqual(tail, [["status", "lost", true], ["input", CONTINUE_PROMPT, true], ["status", "starting", null], ["status", "running", null]], "the cut turn is closed in the log before the continue input");
  assert.equal(c.runner.resume(c.id), true, "a second resume (restart script + UI) is a no-op");
  assert.equal(c.runner.timeline(c.id).filter((e) => e.type === "input" && e.text === CONTINUE_PROMPT).length, 1, "one continue, never two");
  c.starts[0].emit("status", { status: "idle" });
  await c.feed();
  assert.deepEqual(c.ended, ["completed"], "the continued turn ends exactly once; the cut one is never reported completed");
  await until(() => c.runner.status(c.id).status === "parked", 1000);
  c.runner.shutdown();
});

test("idea-126: only a cut turn continues: lost-between-turns, parked, retired, superseded and stale cut agents resume prompt-less", async () => {
  const check = async (label, lost) => {
    assert.equal(lost.runner.resume(lost.id), true, label);
    await until(() => lost.runner.status(lost.id).status === "idle", 1000);
    assert.deepEqual(lost.starts.map((s) => s.sends.length), [0], `${label}: nothing sent`);
    assert.ok(!lost.runner.timeline(lost.id).some((e) => e.type === "input" && e.text === CONTINUE_PROMPT), `${label}: no continue input`);
    lost.runner.shutdown();
  };
  await check("lost between turns", await lostAgent());
  await check("retired lead", await lostAgent({}, {}, tmp(), { cut: true, meta: { role: "former-lead", lane: "l1", team: "t" } }));
  await check("stale cut", await lostAgent({}, { queueMaxAgeMs: 1 }, tmp(), { cut: true }));
  const dir = tmp();
  const sup = await lostAgent({}, {}, dir, { cut: true, meta: { role: "lead", lane: "l1", team: "t" } });
  sup.runner.shutdown();
  const succ = new Runner({ dir, adapters: { claude: fakeAdapter().adapter } });
  succ.create({ provider: "claude", cwd: process.cwd(), meta: { role: "lead", lane: "l1", team: "t" } }); // its replacement lead
  succ.shutdown({ keepResumable: true });
  const a = fakeAdapter();
  await check("superseded lead", { id: sup.id, runner: new Runner({ dir, adapters: { claude: a.adapter }, parkGraceMs: 60_000 }), starts: a.starts });

  const { id, runner, starts } = await lostAgent({}, { parkGraceMs: 20 }); // parked: settles, parks, then a second resume
  runner.resume(id);
  await until(() => runner.status(id).status === "parked", 1000);
  runner.resume(id);
  await until(() => runner.status(id).status === "idle", 1000);
  assert.deepEqual(starts.map((s) => s.sends.length), [0, 0], "parked: nothing sent");
  runner.shutdown();
});

test("idea-126: a continue queued behind the turn cap survives a runner restart once, with its own text only (steers delivered into the cut turn are never replayed)", async () => {
  const dir = tmp();
  const a1 = fakeAdapter();
  const r1 = new Runner({ dir, adapters: { claude: a1.adapter } });
  const id = r1.create({ provider: "claude", cwd: process.cwd(), prompt: "work", meta: {} });
  await tick(30);
  r1.send(id, "a steer into the running turn");
  r1.shutdown({ keepResumable: true });
  const caps = { claude: 1, gemini: 1, antigravity: 1, other: 1 };
  const r2 = new Runner({ dir, adapters: { claude: fakeAdapter().adapter }, turnCaps: caps });
  r2.create({ provider: "claude", cwd: process.cwd(), prompt: "hold the only claude turn slot", meta: {} });
  assert.equal(r2.resume(id), true);
  assert.equal(statuses(r2, id).at(-1).status, "queued");
  assert.equal(r2.resume(id), true);
  assert.equal(r2.queue.filter((j) => j.id === id).length, 1, "a second resume adds no second job");
  r2.send(id, "owner line"); // coalesces into the queued continue
  r2.shutdown({ keepResumable: true });
  const a3 = fakeAdapter();
  const r3 = new Runner({ dir, adapters: { claude: a3.adapter } });
  assert.deepEqual(r3.recoverQueued(), [id]);
  assert.equal(r3.resume(id), true, "the restart script's resume after recoverQueued: no second job");
  await until(() => a3.starts.some((s) => s.id === id && s.sends.length), 1000);
  const sent = a3.starts.filter((s) => s.id === id).flatMap((s) => s.sends);
  assert.deepEqual(sent, [`${CONTINUE_PROMPT}\n\nowner line`], "continue + the coalesced line, once; the cut turn's steer is not replayed");
  r3.shutdown();
});

test("idea-126: a continue whose resume handshake hangs is unwedged: the retry re-delivers the same text, the failure leaves it lost (never `starting`)", async () => {
  const c = await cutAgentWithBackend({}, { cut: true }, { readyFor: () => new Promise(() => {}), acpLike: true });
  c.runner.resume(c.id);
  await tick(30);
  assert.equal(c.runner.status(c.id).status, "starting");
  assert.deepEqual(c.runner.unwedge(c.id, { retry: true }), { action: "retried" });
  await tick(30);
  assert.equal(c.starts.length, 2);
  assert.equal(c.starts[0].killed, 1);
  assert.deepEqual(c.starts[1].sends, [CONTINUE_PROMPT], "the retry carries the continue");
  assert.equal(c.runner.timeline(c.id).filter((e) => e.type === "input" && e.text === CONTINUE_PROMPT).length, 1, "no second continue input");
  assert.equal(c.runner.unwedge(c.id, { reason: "still starting" }).action, "failed");
  assert.equal(c.runner.status(c.id).status, "lost");
  assert.ok(!c.runner.live.has(c.id), "no live slot held");
  await c.feed();
  assert.equal(c.backend.live.turn.get(c.id).status, "closed", "server turn state is not left initializing");
  assert.deepEqual(c.ended, []);
  c.runner.shutdown();
});

test("idea-122: a claude agent resumed without a prompt is marked parked (no process); the next send resumes it with --resume; a cut one still continues", async () => {
  const promptsDir = tmp("vs-rrs-cl-");
  const spawned = [];
  const spawnImpl = (file, args) => {
    const child = fakeClaudeSpawn()();
    const rec = { args, stdin: "" };
    child.stdin.on("data", (d) => { rec.stdin += d; });
    spawned.push(rec);
    return child;
  };
  const dir = tmp();
  const seed = (id, last) => {
    const r = new Runner({ dir, adapters: { claude: fakeAdapter().adapter } });
    r.store.append(id, "created", { provider: "claude", model: null, cwd: promptsDir, meta: {}, systemPrompt: "role" });
    r.store.append(id, "input", { text: "work" });
    r.store.append(id, "session", { sessionId: `sess-${id}` });
    for (const st of last) r.store.append(id, "status", st);
    clearInterval(r._quietSweep);
  };
  seed("rn-idle", [{ status: "running" }, { status: "idle" }]);
  seed("rn-wedged", [{ status: "running" }, { status: "idle" }, { status: "starting", resume: true }]); // a restart resume cut in its settle window
  seed("rn-cut", [{ status: "running" }]);
  const runner = new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir }) } });
  for (const id of ["rn-idle", "rn-wedged"]) {
    assert.equal(runner.resume(id), true);
    assert.equal(runner.status(id).status, "parked", `${id}: parked, not starting`);
    assert.ok(!runner.live.has(id), `${id}: no live process`);
    assert.equal(statuses(runner, id).at(-1).resume, true, "tagged: never a completed turn on the server");
    assert.equal(runner.resume(id), true, "resuming a parked one again is a no-op");
    assert.equal(runner.timeline(id).filter((e) => e.type === "parked").length, 1, "one parked event");
  }
  assert.equal(spawned.length, 0, "no claude process for a prompt-less resume");
  runner.send("rn-idle", "next");
  await until(() => spawned.length === 1, 1000);
  assert.ok(spawned[0].args.includes("--resume") && spawned[0].args.includes("sess-rn-idle"), spawned[0].args.join(" "));
  assert.ok(spawned[0].args.includes("--append-system-prompt-file"), "the role prompt comes back");
  runner.resume("rn-cut");
  await until(() => spawned.length === 2 && spawned[1].stdin.includes("\n"), 1000);
  assert.ok(spawned[1].args.includes("sess-rn-cut"));
  assert.equal(JSON.parse(spawned[1].stdin.trim()).message.content, CONTINUE_PROMPT);
  runner.shutdown();
});

test("idea-124: enableCatchUp on the same RunnerBackend instance resets the seen state: no stale throttle timer, and the next sync write is not skipped", async () => {
  const now = Date.now();
  const { home, t0 } = gapHome({ seen: "fresh", now });
  const b = backendFor(home);
  await b.enableCatchUp({ now });
  b.noteSeen(t0 + 80_000); // throttled: arms the 1s timer
  assert.ok(b.live.seenTimer, "timer armed");
  rmSync(path.join(home, "server-seen.json"));
  rmSync(path.join(home, "agents"), { recursive: true, force: true });
  b.flushSeen(); // the previous run's last write
  rmSync(path.join(home, "server-seen.json"));
  await b.enableCatchUp({ now: Date.now() }); // stop + startRunnerLifecycle in-process, on a wiped home
  assert.equal(b.live.seenTimer, null, "the previous run's throttle timer is cleared");
  b.noteSeen(t0 + 5, { sync: true });
  assert.equal(JSON.parse(readFileSync(path.join(home, "server-seen.json"), "utf8")).ts, t0 + 5, "written: not compared with the previous run's flush");
  clearTimeout(b.live.seenTimer); clearInterval(b.live.seenAlive);
});
