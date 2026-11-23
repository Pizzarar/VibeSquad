// idea-476 + idea-474: (1) while a server-side restart request is open the runner refuses NEW background shells (a request
// drain, kept apart from vs restart's own drain, always lapsing or cleared); (2) a lead's 'drained restart' log is refused
// while its lane still holds background work; (3) a lane lead may stop its retired predecessor lead's background work.
// Temp homes only: a real Runner + runner HTTP server + VS middleware with fake adapters, nothing touches ~/.vibesquad.
import "./helpers/clean-env.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-bghold-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = tmp("vs-bghold-home-");
const ROOT = tmp("vs-bghold-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VS_AGENT_ID;
delete process.env.PASEO_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", name: "Hub", hub: true }, { id: "art", name: "Art" }, { id: "ui", name: "UI" }] }] }), "utf8");

const { budget } = await import("./helpers/load-budget.mjs");
const { Runner, agentMay, drainNoticeText } = await import("../runner/runner.mjs");
const { createServer: createRunnerServer, writeDiscovery } = await import("../runner/server.mjs");
const { drainRefusalText, drainHookDecision, readDrain } = await import("../runner/drain-hook.mjs");
const { DRAIN_HOOK_SCRIPT } = await import("../runner/adapters/claude.mjs");
const { RunnerClient } = await import("../server/backend/runner-client.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { createVibesquadMiddleware, drainedFeedbackGate } = await import("../server/vibesquad-api.mjs");
const { drainedLogRefusal, isDrainedFeedback } = await import("../server/restart-coord.mjs");
const rr = await import("../server/restart-request.mjs");
const { superviseRunner } = await import("../server/runner-supervisor.mjs");

const ADMIN = "adm1n-bghold";
const until = async (fn, ms = 3000) => { const end = Date.now() + budget(ms); while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await sleep(10); } };

// ---------------------------------------------------------------------------------------------- (1) runner request drain

/** Parkable fake agents whose background probe answers from `work` (pid -> shells), as in runner-drain.test.mjs. */
function harness({ dir = path.join(tmp(), "agents"), ...opts } = {}) {
  const work = new Map();
  const kills = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, send() { emit("status", { status: "running" }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const runner = new Runner({ dir, adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe: async (pid) => work.get(pid) ?? [], ...opts });
  const create = (meta) => { const id = runner.create({ provider: "fake", cwd: os.tmpdir(), prompt: "go", ...(meta ? { meta } : {}) }); ems.get(id)("session", { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em("turn_done", {}); em("status", { status: "idle" }); };
  const shell = (id, createdMs) => work.set(runner.live.get(id)?.handle.pid, [{ pid: 9000, name: "bash", cmd: "eval 'npm test'", createdMs }]);
  return { runner, kills, create, endTurn, shell };
}
const types = (runner, id) => runner.timeline(id).map((e) => e.type);

test("(1) setRequestDrain: id + TTL validated, kind request, a refresh of the same id keeps `since`, a new id restarts it", async () => {
  const { runner } = harness();
  try {
    for (const bad of [undefined, "", "x", "rr-", "rr-a b", `rr-${"a".repeat(61)}`]) assert.throws(() => runner.setRequestDrain({ id: bad, ttlMs: 60_000 }), (e) => e.status === 400, `id ${bad}`);
    for (const bad of [undefined, 999, 2 * 3600_000 + 1]) assert.throws(() => runner.setRequestDrain({ id: "rr-1", ttlMs: bad }), (e) => e.status === 400, `ttl ${bad}`);
    assert.equal(runner.drainState(), null);
    const a = runner.setRequestDrain({ id: "rr-1", tip: "abc1234", ttlMs: 60_000, reason: "restart request rr-1" });
    assert.equal(a.kind, "request");
    assert.deepEqual(a.request, { id: "rr-1", tip: "abc1234" });
    await sleep(15);
    const b = runner.setRequestDrain({ id: "rr-1", tip: "abc1234", ttlMs: 120_000 });
    assert.equal(b.since, a.since, "a refresh keeps the window");
    assert.ok(b.until > a.until);
    await sleep(15);
    const c = runner.setRequestDrain({ id: "rr-2", ttlMs: 60_000 });
    assert.ok(c.since > a.since, "another request starts its own window");
  } finally { runner.shutdown(); }
});

test("(1) the two drains never clear each other; the merged state and drain.json follow both", () => {
  const drainFile = path.join(tmp(), "drain.json");
  const { runner } = harness({ drainFile });
  try {
    runner.setRequestDrain({ id: "rr-1", ttlMs: 60_000, reason: "req" });
    const both = runner.setDrain({ ttlMs: 30_000, reason: "vs restart" });
    assert.equal(both.kind, "restart", "vs restart's drain wins the kind and reason");
    assert.equal(both.reason, "vs restart");
    assert.equal(both.request.id, "rr-1");
    assert.deepEqual(JSON.parse(readFileSync(drainFile, "utf8")), both);
    assert.equal(runner.clearDrain(), true);
    const left = runner.drainState();
    assert.equal(left.kind, "request", "DELETE /drain (vs restart's finally) leaves the request's drain");
    assert.equal(JSON.parse(readFileSync(drainFile, "utf8")).kind, "request", "the hook still sees it");
    assert.equal(runner.clearRequestDrain({ id: "rr-other" }), false, "another request's id clears nothing");
    assert.equal(runner.drainState().kind, "request");
    runner.setDrain({ ttlMs: 30_000, reason: "vs restart" });
    assert.equal(runner.clearRequestDrain({ id: "rr-1" }), true);
    assert.equal(runner.drainState().kind, "restart", "the request's clear leaves vs restart's drain");
    assert.equal(runner.drainState().request, undefined);
    runner.clearDrain();
    assert.equal(runner.drainState(), null);
    assert.ok(!existsSync(drainFile), "removed once neither drain is active");
  } finally { runner.shutdown(); }
});

test("(1) a stale request drain expires on its own (TTL: a dead server stops refreshing) and refusals stop with it", async () => {
  const drainFile = path.join(tmp(), "drain.json");
  const h = harness({ drainFile });
  try {
    h.runner.setRequestDrain({ id: "rr-ttl", ttlMs: 1000 });
    assert.ok(existsSync(drainFile));
    await until(() => !existsSync(drainFile), 2500);
    assert.equal(h.runner.drainState(), null);
    const id = h.create();
    h.shell(id, Date.now());
    h.endTurn(id);
    await until(() => types(h.runner, id).includes("park-held"));
    assert.ok(!types(h.runner, id).includes("park-drain-refused"));
  } finally { h.runner.shutdown(); }
});

test("(1) drainState() treats a request drain past `until` as ended even before its timer fires", () => {
  const { runner } = harness();
  try {
    runner.setRequestDrain({ id: "rr-x", ttlMs: 60_000 });
    runner._reqDrain.until = Date.now() - 1;
    assert.equal(runner.drainState(), null);
    assert.equal(runner._drainRefusesHold([{ pid: 1, createdMs: Date.now() }]), false);
  } finally { runner.shutdown(); }
});

test("(1) during a request drain a NEW hold is refused (parked, notice names the request), older work keeps holding", async () => {
  const h = harness();
  try {
    const before = h.create();
    h.shell(before, Date.now() - 60_000); // started before the request opened
    const d = h.runner.setRequestDrain({ id: "rr-hold", tip: "abc1234", ttlMs: 60_000, reason: "restart request rr-hold for abc1234 (draining)" });
    const fresh = h.create();
    h.shell(fresh, d.since + 5);
    h.endTurn(fresh);
    h.endTurn(before);
    await until(() => h.kills.includes(fresh));
    await until(() => types(h.runner, before).includes("park-held"));
    const refused = h.runner.timeline(fresh).find((e) => e.type === "park-drain-refused");
    assert.equal(refused.drain.kind, "request");
    assert.ok(!h.kills.includes(before), "already-running background work is untouched");
    const notice = drainNoticeText(refused.drain, refused.work);
    assert.match(notice, /restart drain was open \(restart request rr-hold/);
    assert.match(notice, /run it in the foreground, or rerun it in the background after restart-done/);
  } finally { h.runner.shutdown(); }
});

test("(1) a runner start drops a request drain file a crashed runner left; shutdown ends both drains", () => {
  const drainFile = path.join(tmp(), "drain.json");
  writeFileSync(drainFile, JSON.stringify({ since: Date.now(), until: Date.now() + 3_600_000, kind: "request", request: { id: "rr-old" } }));
  const { runner } = harness({ drainFile });
  assert.ok(!existsSync(drainFile));
  runner.setRequestDrain({ id: "rr-1", ttlMs: 60_000 });
  runner.setDrain({ ttlMs: 60_000 });
  runner.shutdown();
  assert.equal(runner.drainState(), null);
  assert.ok(!existsSync(drainFile));
});

test("(1) POST/DELETE /drain/request: admin only (agent 403, no auth 401), validated, scoped by id; /health shows it", async () => {
  const drainFile = path.join(tmp(), "drain.json");
  const h = harness({ drainFile });
  const srv = createRunnerServer(h.runner, { token: ADMIN, hash: "h", onShutdown() {} });
  const port = await listen(srv);
  const call = async (headers, method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const id = h.create({ team: "sq", lane: "art", role: "lead", labels: {} });
    const agent = { "x-vs-agent-id": id, "x-vs-agent-token": h.runner.tokensById.get(id) };
    const admin = { authorization: `Bearer ${ADMIN}` };
    for (const method of ["POST", "DELETE"]) assert.equal((await call(agent, method, "/drain/request", { id: "rr-1", ttlMs: 60_000 })).status, 403, `agent ${method}`);
    assert.equal((await call({}, "POST", "/drain/request", { id: "rr-1", ttlMs: 60_000 })).status, 401);
    assert.equal(h.runner.drainState(), null, "nobody but the admin set it");
    assert.equal((await call(admin, "POST", "/drain/request", { id: "nope", ttlMs: 60_000 })).status, 400);
    assert.equal((await call(admin, "POST", "/drain/request", { id: "rr-1", ttlMs: 5 })).status, 400);
    const set = await call(admin, "POST", "/drain/request", { id: "rr-1", tip: "abc1234", ttlMs: 60_000, reason: "req" });
    assert.equal(set.status, 200);
    assert.equal(set.body.drain.kind, "request");
    assert.equal((await call(admin, "GET", "/health")).body.drain.request.id, "rr-1");
    // vs restart's own drain on top; its DELETE /drain leaves the request's, and reports what is left
    assert.equal((await call(admin, "POST", "/drain", { ttlMs: 60_000, reason: "vs restart" })).status, 200);
    const del = await call(admin, "DELETE", "/drain");
    assert.equal(del.body.cleared, true);
    assert.equal(del.body.drain.kind, "request");
    const other = await call(admin, "DELETE", "/drain/request", { id: "rr-2" });
    assert.equal(other.body.cleared, false, "another request's id");
    assert.ok(existsSync(drainFile));
    const mine = await call(admin, "DELETE", "/drain/request", { id: "rr-1" });
    assert.equal(mine.body.cleared, true);
    assert.equal(mine.body.drain, null);
    assert.equal((await call(admin, "GET", "/health")).body.drain, null);
    assert.ok(!existsSync(drainFile));
    // DELETE without an id: whatever request drain is held (a restarted VS server does not know the id it set)
    await call(admin, "POST", "/drain/request", { id: "rr-3", ttlMs: 60_000 });
    assert.equal((await call(admin, "DELETE", "/drain/request", {})).body.cleared, true);
  } finally { await close(srv); h.runner.shutdown(); }
});

test("(1) drain hook: a request drain refuses background Bash with the request's text; foreground passes", () => {
  const drain = { since: Date.now() - 1000, until: Date.now() + 60_000, kind: "request", request: { id: "rr-9", tip: "abc1234" } };
  const bg = { tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } };
  const text = drainHookDecision(bg, drain);
  assert.equal(text, drainRefusalText(drain));
  assert.match(text, /restart request rr-9, tip abc1234/);
  assert.match(text, /Run it in the foreground, or wait for restart-done/);
  assert.equal(drainHookDecision({ tool_name: "Bash", tool_input: { command: "npm test" } }, drain), null, "foreground untouched");
  const file = path.join(tmp(), "drain.json");
  writeFileSync(file, JSON.stringify(drain));
  const r = spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, file], { input: JSON.stringify(bg), encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /restart request rr-9/);
});

test("(1) drain hook end-to-end: drain.json present + background Bash exits 2 with the message; no drain.json passes (exit 0, silent)", () => {
  const dir = tmp();
  const bg = { tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } };
  const drain = { since: Date.now() - 1000, until: Date.now() + 60_000, kind: "restart", reason: "vs restart" };
  const file = path.join(dir, "drain.json");
  writeFileSync(file, JSON.stringify(drain));
  const refused = spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, file], { input: JSON.stringify(bg), encoding: "utf8", timeout: 10_000 });
  assert.equal(refused.status, 2, `expected exit 2, got ${refused.status}: ${refused.stderr}`);
  assert.match(refused.stderr, /VibeSquad is draining for a runtime restart/);
  assert.match(refused.stderr, /new background commands are refused/);
  // No drain file: the hook exits 0 without reading stdin (the common case) and stays silent.
  const absent = path.join(dir, "no-drain.json");
  const pass = spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, absent], { input: JSON.stringify(bg), encoding: "utf8", timeout: 10_000 });
  assert.equal(pass.status, 0, `expected exit 0, got ${pass.status}: ${pass.stderr}`);
  assert.equal(pass.stderr, "", "no drain is silent");
});

test("(1) unreadable drain.json fails OPEN with a warning (the runner's turn-end refusal is the backstop); no file is silent", () => {
  const dir = tmp();
  const warns = [];
  assert.equal(readDrain(path.join(dir, "none.json"), (m) => warns.push(m)), null);
  assert.equal(warns.length, 0, "no drain is the common case");
  writeFileSync(path.join(dir, "bad.json"), "{\"until\":");
  assert.equal(readDrain(path.join(dir, "bad.json"), (m) => warns.push(m)), null);
  assert.match(warns.at(-1), /not valid JSON.*allowed/);
  mkdirSync(path.join(dir, "adir"));
  assert.equal(readDrain(path.join(dir, "adir"), (m) => warns.push(m)), null);
  assert.match(warns.at(-1), /unreadable.*allowed/);
  const bg = { tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } };
  const r = spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, path.join(dir, "bad.json")], { input: JSON.stringify(bg), encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /drain file is not valid JSON/);
});

// ------------------------------------------------------------------------------- (1) the restart request loop holds it

const TEAMS = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }] }];
const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const MIN = 60_000;
const TIP = "abc1234def";
const ag = (id, lane, role, extra = {}) => ({ id, title: `${id} · t`, status: "idle", cwd: "", labels: { team: "vibesquad", lane, role, ...extra }, createdAt: "2026-11-19T00:00:00Z" });

function loopWorld(home, { setFails = false } = {}) {
  const w = { now: T0, agents: [ag("rn-ove", "vibesquad", "lead"), ag("rn-bug", "bug-chaser", "lead")], held: null, sets: [], clears: [], logs: [], fireResult: { ok: true }, setFails };
  w.loop = () => rr.createRestartRequestLoop({
    home,
    teams: () => TEAMS,
    now: () => w.now,
    log: (l) => w.logs.push(l),
    listAgents: async () => w.agents,
    heldList: async () => w.held,
    runVs: async () => ({ ok: true }),
    fire: async () => w.fireResult,
    drain: {
      set: async (req) => { if (w.setFails) throw new Error("runner down"); w.sets.push(rr.requestDrainBody(req)); },
      clear: async (id) => { w.clears.push(id); },
    },
  });
  return w;
}
const openRequest = (home, extra = {}) => rr.createRestartRequest(home, { tip: TIP, requestedBy: "rn-ove", team: "vibesquad", lane: "vibesquad", urgent: true, now: T0, ...extra }); // idea-674: immediate (urgent) path
function writeResult(home, startMs, rec) {
  const at = new Date(startMs).toISOString();
  writeFileSync(path.join(home, `restart-${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: at, finishedAt: at, dryRun: false, errors: [], ...rec }));
}

test("(1) loop: holds the drain every tick while open (5 min TTL), releases it once on abort", async () => {
  const home = tmp();
  const w = loopWorld(home);
  const req = openRequest(home);
  const loop = w.loop();
  await loop.tick();
  await loop.tick();
  assert.equal(w.sets.length, 2, "refreshed every tick");
  assert.deepEqual(w.sets[0], { id: req.id, tip: TIP, ttlMs: rr.REQUEST_DRAIN_TTL_MS, reason: `restart request ${req.id} for ${TIP} (draining)` });
  assert.ok(rr.REQUEST_DRAIN_TTL_MS <= 5 * MIN && rr.REQUEST_DRAIN_TTL_MS > rr.TICK_MS * 4, "lapses soon after the last refresh, survives missed ticks");
  rr.abortRestartRequest(home, { reason: "test", now: T0 + MIN });
  w.now = T0 + MIN;
  await loop.tick();
  assert.deepEqual(w.clears, [req.id]);
  await loop.tick();
  await loop.tick();
  assert.deepEqual(w.clears, [req.id], "released once, no DELETE every tick");
  assert.equal(w.sets.length, 2, "never re-held for a finished request");
});

test("(1) loop: deadline -> fire -> released once vs restart launched (its own drain takes over); done stays released", async () => {
  const home = tmp();
  const w = loopWorld(home);
  const req = openRequest(home, { deadlineMin: 5 });
  const loop = w.loop();
  await loop.tick();
  assert.equal(w.sets.length, 1);
  w.now = T0 + 6 * MIN;
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(rr.readRestartRequest(home).launch.ok, true);
  w.now += MIN;
  await loop.tick();
  assert.deepEqual(w.clears, [req.id], "launched: the request drain is released");
  writeResult(home, w.now, { ok: true });
  w.now += MIN;
  assert.equal((await loop.tick()).state, "done");
  assert.deepEqual(w.clears, [req.id]);
});

test("(1) requestHoldsDrain: open yes; firing only until launch and never past the cap; terminal or none no", () => {
  const now = T0;
  assert.equal(rr.requestHoldsDrain(null, now), false);
  for (const state of ["requested", "draining", "ready"]) assert.equal(rr.requestHoldsDrain({ state }, now), true, state);
  assert.equal(rr.requestHoldsDrain({ state: "queued", windowAt: new Date(now - 1).toISOString() }, now), false, "idea-674: queued never holds, even past its window");
  for (const state of ["done", "aborted"]) assert.equal(rr.requestHoldsDrain({ state }, now), false, state);
  const fired = { state: "firing", firedAt: new Date(now).toISOString() };
  assert.equal(rr.requestHoldsDrain(fired, now + MIN), true, "fired, launch not recorded yet");
  assert.equal(rr.requestHoldsDrain({ ...fired, launch: { ok: true } }, now + MIN), false, "vs restart launched");
  assert.equal(rr.requestHoldsDrain(fired, now + rr.FIRING_DRAIN_MAX_MS), false, "a fire that never launched stops holding at the cap");
  assert.ok(rr.FIRING_DRAIN_MAX_MS < rr.FIRING_TIMEOUT_MS);
  assert.equal(rr.requestHoldsDrain({ state: "firing" }, now), false, "no firedAt: nothing to bound it by");
});

test("(1) loop: a server restarted mid-request clears a drain an earlier process set (once), even with nothing open", async () => {
  const home = tmp();
  const w = loopWorld(home);
  openRequest(home);
  rr.abortRestartRequest(home, { reason: "aborted while the server was down", now: T0 });
  const fresh = w.loop(); // a new server process: it never set the drain itself
  await fresh.tick();
  assert.deepEqual(w.clears, [null], "DELETE without an id: whatever request drain the runner holds");
  await fresh.tick();
  assert.deepEqual(w.clears, [null]);
  const empty = tmp();
  const w2 = loopWorld(empty);
  const l2 = w2.loop();
  await l2.tick();
  await l2.tick();
  assert.deepEqual(w2.clears, [null], "no request file at all: one clear at start, then quiet");
});

test("(1) loop: an unreadable request file releases the drain (background allowed), steps nothing, logs why", async () => {
  const home = tmp();
  const w = loopWorld(home);
  const req = openRequest(home);
  const loop = w.loop();
  await loop.tick();
  assert.equal(w.sets.length, 1);
  writeFileSync(rr.requestPath(home), "{ not json");
  const r = await loop.tick();
  assert.equal(r.unreadable, true);
  assert.deepEqual(w.clears, [req.id]);
  assert.ok(w.logs.some((l) => /unreadable.*runner drain released, background starts allowed, no lead marked drained, nothing fired/.test(l)));
});

test("(1) loop: a failed drain set is logged and retried next tick; the request still steps", async () => {
  const home = tmp();
  const w = loopWorld(home, { setFails: true });
  openRequest(home);
  const loop = w.loop();
  assert.equal((await loop.tick()).state, "draining");
  assert.ok(w.logs.some((l) => /runner drain not set \(runner down\); new background work is not refused/.test(l)));
  w.setFails = false;
  await loop.tick();
  assert.equal(w.sets.length, 1);
});

test("(1) supervisor: a request drain does not defer the stale-runner restart; vs restart's drain (both open) still does", async () => {
  const run = async (drain) => {
    let restarts = 0;
    const logs = [];
    const sup = superviseRunner({ rc: { healthy: async () => true } }, {
      checkMs: 5000, minBackoffMs: 100, maxBackoffMs: 400,
      healthInfo: async () => ({ hash: "old", running: 0, held: 0, drain }), diskHash: () => "disk", restart: async () => { restarts += 1; },
      log: (m) => logs.push(m), setTimer: () => ({ unref() {} }), clearTimer() {},
    });
    await sup.ready;
    sup.stop();
    return { restarts, logs };
  };
  const req = await run({ since: 1, until: 2, reason: "req", kind: "request", request: { id: "rr-1" } });
  assert.equal(req.restarts, 1, req.logs.join("\n"));
  assert.ok(!req.logs.some((l) => /deferred/.test(l)));
  const both = await run({ since: 1, until: 2, reason: "vs restart pid 1", kind: "restart", request: { id: "rr-1" } });
  assert.equal(both.restarts, 0);
  assert.ok(both.logs.some((l) => /deferred: vs restart drain active \(vs restart pid 1\)/.test(l)), both.logs.join("\n"));
});

// -------------------------------------------------------------------------- (2) 'drained restart' gated on held work

const SQT = [{ id: "sq", name: "Squad", lanes: [{ id: "sq", hub: true }, { id: "art" }, { id: "ui" }] }];
const sa = (id, lane, role, extra = {}) => ({ id, title: id, status: "idle", cwd: "", labels: { team: "sq", lane, role, ...extra } });
const LEAD = sa("rn-lead", "art", "lead");
const OLD = sa("rn-old", "art", "former-lead");
const W = sa("rn-w", "art", "worker", { "vs.parent": "rn-lead" });
const OW = sa("rn-ow", "art", "worker", { "vs.parent": "rn-old" });
const UIL = sa("rn-uil", "ui", "lead");
const UIW = sa("rn-uiw", "ui", "worker", { "vs.parent": "rn-uil" });
const XCHILD = sa("rn-xc", "ui", "worker", { "vs.parent": "rn-lead" });
const ROSTER = [LEAD, OLD, W, OW, UIL, UIW, XCHILD];
const held = (ids) => ({ ids, work: Object.fromEntries(ids.map((id, i) => [id, [{ pid: 7000 + i, name: "bash", cmd: "npm test" }]])) });

test("(2) isDrainedFeedback matches the stored restart-feedback drained line only", () => {
  assert.equal(isDrainedFeedback("restart-feedback: drained restart abc1234"), true);
  assert.equal(isDrainedFeedback("restart-feedback: drained restart"), true);
  assert.equal(isDrainedFeedback("restart-feedback: not drained yet"), false);
  assert.equal(isDrainedFeedback("drained restart abc"), false, "only the restart-feedback subtype");
});

test("(2) drainedLogRefusal: refused (naming agent + pid) for a lane worker, a retired predecessor, its workers, self, a cross-lane child", () => {
  const opt = (ids) => ({ held: held(ids), agents: ROSTER, teams: SQT, callerTeam: "sq", callerLane: "art" });
  for (const id of ["rn-w", "rn-old", "rn-ow", "rn-lead", "rn-xc"]) {
    const why = drainedLogRefusal("rn-lead", opt([id]));
    assert.ok(why, id);
    assert.match(why, new RegExp(`${id} \\(pid 7000`), why);
    assert.match(why, new RegExp(`vs stop ${id} --background`));
  }
  assert.equal(drainedLogRefusal("rn-lead", opt([])), null, "nothing held");
  assert.equal(drainedLogRefusal("rn-lead", opt(["rn-uiw", "rn-uil"])), null, "only another lane holds work");
  assert.ok(drainedLogRefusal("rn-uil", opt(["rn-uiw"])), "that lane's own lead is refused");
  // an unregistered lane still resolves by its labels (never reads as nobody's)
  assert.ok(drainedLogRefusal("rn-lead", { ...opt(["rn-w"]), teams: [] }));
});

test("(2) drainedLogRefusal fails closed: unreadable held list, or held work with an unreadable roster", () => {
  assert.match(drainedLogRefusal("rn-lead", { held: null, agents: ROSTER, teams: SQT }), /could not be read/);
  assert.match(drainedLogRefusal("rn-lead", { held: { ids: "x" }, agents: ROSTER, teams: SQT }), /could not be read/);
  assert.match(drainedLogRefusal("rn-lead", { held: held(["rn-w"]), agents: null, teams: SQT }), /agent list could not be read/);
  assert.equal(drainedLogRefusal("rn-lead", { held: held([]), agents: null, teams: SQT }), null, "nothing held: the roster is not needed");
});

test("(2) drainedFeedbackGate: 409 while held, passes other entries and the owner's shell, fails closed on a dead runner", async () => {
  const caller = { id: "rn-lead", role: "lead", team: "sq", lane: "art" };
  let h = held(["rn-w"]);
  let healthFails = false;
  const b = { rc: { request: async () => { if (healthFails) throw new Error("ECONNREFUSED"); return { heldAgents: h.ids, heldWork: h.work }; } }, listAgents: async () => ROSTER };
  await assert.rejects(drainedFeedbackGate(caller, "metric", "restart-feedback: drained restart abc", b, SQT), (e) => e.status === 409 && /rn-w \(pid 7000/.test(e.message));
  await drainedFeedbackGate(caller, "metric", "restart-feedback: still holding a suite", b, SQT);
  await drainedFeedbackGate(caller, "done", "restart-feedback: drained restart abc", b, SQT);
  await drainedFeedbackGate(null, "metric", "restart-feedback: drained restart abc", b, SQT);
  h = held([]);
  await drainedFeedbackGate(caller, "metric", "restart-feedback: drained restart abc", b, SQT);
  healthFails = true;
  await assert.rejects(drainedFeedbackGate(caller, "metric", "restart-feedback: drained restart abc", b, SQT), (e) => e.status === 409 && /could not be read/.test(e.message));
});

// ------------------------------------------------------- (2) + (3) end to end: real runner, runner HTTP and VS middleware

function fakeAdapter() {
  return {
    canPark: true,
    start({ id, emit }) {
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { pid: 5000, ready: Promise.resolve(), send() { emit("status", { status: "running" }); emit("status", { status: "idle" }); }, cancel() {}, kill() {} };
    },
  };
}
const runnerHome = path.join(HOME, "runner");
const runner = new Runner({ dir: path.join(runnerHome, "agents"), adapters: { claude: fakeAdapter() }, parkGraceMs: 60_000, bgProbe: null });
const runnerSrv = createRunnerServer(runner, { token: ADMIN, hash: "h" });
runnerSrv.keepAliveTimeout = 0;
const runnerPort = await listen(runnerSrv);
writeDiscovery(runnerHome, { port: runnerPort, token: ADMIN });
const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome, env: {}, requestTimeoutMs: budget(15000) }), hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
const api = createVibesquadMiddleware(ROOT, { backend });
const vsSrv = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end("no"); }));
const vsPort = await listen(vsSrv);
after(async () => { await close(vsSrv); await close(runnerSrv); runner.shutdown(); });

const mk = (team, lane, role, labels = {}) => runner.create({ provider: "claude", cwd: ROOT, meta: { team, lane, role, labels } });
const lead = mk("sq", "art", "lead");
const old = mk("sq", "art", "former-lead");
const oldWorker = mk("sq", "art", "worker", { "vs.parent": old });
const live = mk("sq", "art", "lead"); // a second live lead in the lane (not retired): stays out of reach
const uiOld = mk("sq", "ui", "former-lead");
const otherOld = mk("other", "art", "former-lead");
const worker = mk("sq", "art", "worker", { "vs.parent": lead });
const asAgent = (id) => ({ "x-vs-agent-id": id, "x-vs-agent-token": runner.tokensById.get(id) });

async function vsLog(id, text) {
  const r = await fetch(`http://127.0.0.1:${vsPort}/__vibesquad/vs-log`, {
    method: "POST",
    headers: { ...asAgent(id), "content-type": "application/json" },
    body: JSON.stringify({ team: "sq", lane: "art", type: "metric", text, refs: [] }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("(2) e2e /vs-log: 'drained restart' is 409 naming the predecessor's held pid; logs once the lane holds nothing", async () => {
  const realIds = runner.heldIds;
  const realWork = runner.heldWork;
  try {
    runner.heldIds = () => [oldWorker];
    runner.heldWork = () => ({ [oldWorker]: [{ pid: 4242, name: "bash", cmd: "npm test" }] });
    const refused = await vsLog(lead, "restart-feedback: drained restart abc1234");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, new RegExp(`${oldWorker} \\(pid 4242`));
    const other = await vsLog(lead, "restart-feedback: holding npm test, will drain");
    assert.equal(other.status, 200, "any other restart-feedback passes");
    runner.heldIds = () => [];
    runner.heldWork = () => ({});
    const ok = await vsLog(lead, "restart-feedback: drained restart abc1234");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.entry.text, /drained restart abc1234/);
  } finally { runner.heldIds = realIds; runner.heldWork = realWork; }
});

// ---------------------------------------------------------------------------------- (3) stop a predecessor's background

test("(3) agentMay 'stop-background': lead over its retired predecessor (same Squad + lane) only; cancel unchanged", () => {
  const leadC = { id: "rn-lead", role: "lead", team: "sq", lane: "art", overlord: false };
  const workerC = { id: "rn-w", role: "worker", team: "sq", lane: "art", overlord: false };
  const buddyC = { id: "rn-b", role: "brainstorm", team: "sq", lane: "art", overlord: false };
  const t = (id, meta) => ({ id, meta });
  const retired = t("rn-old", { team: "sq", lane: "art", role: "former-lead", labels: {} });
  assert.equal(agentMay(leadC, "stop-background", retired), true);
  assert.equal(agentMay(leadC, "stop-background", t("rn-o2", { labels: { team: "sq", lane: "art", role: "old-lead" } })), true, "older spelling, labels-only");
  assert.equal(agentMay(leadC, "cancel", retired), false, "cancel scope is not widened");
  assert.equal(agentMay(leadC, "stop-background", t("rn-x", { team: "sq", lane: "ui", role: "former-lead", labels: {} })), false, "another lane");
  assert.equal(agentMay(leadC, "stop-background", t("rn-y", { team: "other", lane: "art", role: "former-lead", labels: {} })), false, "another Squad");
  assert.equal(agentMay(leadC, "stop-background", t("rn-z", { team: "sq", lane: "art", role: "lead", labels: {} })), false, "a live lead");
  assert.equal(agentMay(leadC, "stop-background", t("rn-fb", { team: "sq", lane: "art", role: "former-brainstorm", labels: {} })), false, "a retired Buddy");
  assert.equal(agentMay(workerC, "stop-background", retired), false, "a worker");
  assert.equal(agentMay(buddyC, "stop-background", retired), false, "a Buddy");
  assert.equal(agentMay(leadC, "stop-background", t("rn-ow", { team: "sq", lane: "art", role: "worker", labels: { "vs.parent": "rn-old" } })), true, "the predecessor's workers: lane workers");
  assert.equal(agentMay(leadC, "stop-background", t("rn-uw", { team: "sq", lane: "ui", role: "worker", labels: {} })), false, "another lane's worker");
});

test("(3) e2e runner POST /agents/:id/stop-background: predecessor + its workers allowed, other lane / Squad / live lead 403", async () => {
  const realStop = runner.stopBackground;
  const stopped = [];
  runner.stopBackground = async (id) => { stopped.push(id); return { stopped: [] }; };
  const post = async (caller, target) => {
    const r = await fetch(`http://127.0.0.1:${runnerPort}/agents/${target}/stop-background`, { method: "POST", headers: { ...asAgent(caller), "content-type": "application/json" }, body: "{}" });
    return r.status;
  };
  try {
    assert.equal(await post(lead, old), 200, "retired predecessor lead");
    assert.equal(await post(lead, oldWorker), 200, "the predecessor's worker");
    assert.equal(await post(lead, uiOld), 403, "another lane's retired lead");
    assert.equal(await post(lead, otherOld), 403, "another Squad's retired lead");
    assert.equal(await post(lead, live), 403, "a live lead of the same lane");
    assert.equal(await post(worker, old), 403, "a worker may not");
    assert.deepEqual(stopped, [old, oldWorker], "only the allowed calls reached stopBackground");
  } finally { runner.stopBackground = realStop; }
});
