// scripts/restart-runtime.mjs against stub runner/server processes (loopback http servers + a fake process table).
// Nothing here touches the real runner, server, desktop config dir or ~/.vibesquad: VIBESQUAD_HOME / config dir are temp dirs.
// Also covers the runner's POST /shutdown auth (same token gate as POST /agents).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createRunnerServer } from "../runner/server.mjs";
import { Runner } from "../runner/runner.mjs";
import { parseArgs, bootDefault, restartRuntime, httpCall, drainTtlMs } from "../scripts/restart-runtime.mjs";

const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const call = (port, method, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
    let s = ""; res.on("data", (c) => { s += c; }); res.on("end", () => resolve({ status: res.statusCode, body: s }));
  });
  req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
});

test("runner POST /shutdown: no token 401, wrong token 401, right token 202 + stop once; unconfigured token 403", async () => {
  let stops = 0;
  const runner = { live: new Map(), list: () => [] };
  const srv = createRunnerServer(runner, { token: "secret", hash: "h", onShutdown: () => { stops += 1; } });
  const port = await listen(srv);
  try {
    assert.equal((await call(port, "POST", "/shutdown")).status, 401);
    assert.equal((await call(port, "POST", "/shutdown", { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await call(port, "POST", "/shutdown", { authorization: "secret" })).status, 401, "needs the Bearer scheme");
    assert.equal((await call(port, "GET", "/shutdown", { authorization: "Bearer secret" })).status, 404, "POST only");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stops, 0, "rejected calls never stop the runner");
    const ok = await call(port, "POST", "/shutdown", { authorization: "Bearer secret" });
    assert.equal(ok.status, 202);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stops, 1);
  } finally { await close(srv); }
  const open = createRunnerServer(runner, { hash: "h", onShutdown: () => { stops += 1; } }); // no token configured: loopback alone is not enough
  const p2 = await listen(open);
  try {
    assert.equal((await call(p2, "POST", "/shutdown")).status, 403);
    assert.equal(stops, 1);
  } finally { await close(open); }
  const noHook = createRunnerServer(runner, { token: "secret", hash: "h" });
  const p3 = await listen(noHook);
  try { assert.equal((await call(p3, "POST", "/shutdown", { authorization: "Bearer secret" })).status, 403); } finally { await close(noHook); }
});

// Real Runner + real runner HTTP server (only the provider child is fake). Fail-first: with a plain runner.shutdown() every agent
// reads "exited" and cannot be resumed; the /shutdown path must leave a cut agent "lost" and an idle one "parked", both resumable.
test("runner POST /shutdown keeps agents resumable: cut agent reads lost, idle reads parked, both resume; the exit handler's second shutdown is a no-op", async () => {
  const starts = [];
  const adapter = {
    canPark: true,
    start({ id, emit, resume }) {
      const rec = { id, resume, emit, killed: 0 };
      starts.push(rec);
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { send() { emit("status", { status: "running" }); }, cancel() {}, kill() { rec.killed += 1; } };
    },
  };
  const runner = new Runner({ dir: mkdtempSync(path.join(os.tmpdir(), "vs-rs-")), adapters: { claude: adapter } });
  let shutdownDone;
  const stopped = new Promise((r) => { shutdownDone = r; });
  const srv = createRunnerServer(runner, { token: "t0k", hash: "h", onShutdown: () => { runner.shutdown({ keepResumable: true }); shutdownDone(); } });
  const port = await listen(srv);
  const auth = { authorization: "Bearer t0k" };
  const status = async (id) => JSON.parse((await call(port, "GET", `/agents/${id}`, auth)).body).status;
  try {
    const cut = runner.create({ provider: "claude", cwd: process.cwd(), prompt: "work", meta: {} }); // mid-turn
    const idle = runner.create({ provider: "claude", cwd: process.cwd(), meta: {} });
    await new Promise((r) => setTimeout(r, 30));
    starts.find((x) => x.id === idle).emit("status", { status: "idle" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await status(cut), "running");
    assert.equal(await status(idle), "idle");
    assert.equal((await call(port, "POST", "/shutdown")).status, 401);
    assert.equal((await call(port, "POST", "/shutdown", auth)).status, 202);
    await stopped;
    runner.shutdown(); // process.on('exit') runs this afterwards: must not write exit events now
    assert.equal(await status(cut), "lost", "cut agent is resumable, not exited");
    assert.equal(await status(idle), "parked");
    for (const id of [cut, idle]) assert.ok(runner.timeline(id).every((e) => e.type !== "exit"), `${id} has no exit event`);
    assert.ok(starts.every((x) => x.killed === 1), "every child stopped exactly once");
    const resumeFrom = starts.length;
    for (const id of [cut, idle]) assert.equal((await call(port, "POST", `/agents/${id}/resume`, auth)).status, 202, `resume ${id}`);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(starts.slice(resumeFrom).map((x) => x.resume).sort(), [`sess-${cut}`, `sess-${idle}`].sort(), "resumed from their saved sessions");
    assert.equal(await status(cut), "running", "the cut agent continues its turn (idea-126), never `starting` forever");
    assert.equal(await status(idle), "idle", "a prompt-less resume settles to idle once the adapter is up (never `starting` forever: idea-109)");
  } finally { await close(srv); }
  // Contrast (the old behaviour this replaces): a plain shutdown() exits every agent for good.
  const r2 = new Runner({ dir: mkdtempSync(path.join(os.tmpdir(), "vs-rs-")), adapters: { claude: adapter } });
  const id2 = r2.create({ provider: "claude", cwd: process.cwd(), prompt: "work", meta: {} });
  await new Promise((r) => setTimeout(r, 30));
  r2.shutdown();
  assert.equal(r2.status(id2).status, "exited");
  assert.equal(r2.resume(id2), false);
});

/** Fake machine: a stub runner + stub server, a fake process table, and deps for restartRuntime. */
async function world({ running = [0], held = null, supportsShutdown = true, serverBootsRunner = true, serveCmd = true, treeKill = false, strayAfterServerStop = false, swapRunnerOnFirstSleep = false, spoofAfterVerify = false, runnerRecycled = null, agentStatus = null, envExtra = {}, extraAgents = [], teams = null, supportsDrain = true } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vs-restart-"));
  const home = path.join(tmp, "runner");
  const configDir = path.join(tmp, "config");
  const outDir = path.join(tmp, "vs");
  mkdirSync(home, { recursive: true });
  const w = { tmp, home, configDir, outDir, calls: [], alive: new Set(), hardKills: [], spawned: [], markerSeenAtSpawn: [], pidSeq: 1000, shutdownAuth: [], serverInfoCalls: 0, allSrvs: [], runnerInfoCalls: 0, unwedgeBodies: [], spawnEnvs: [], vsCalls: [], drainCalls: [] };
  const agents = { current: [
    { id: "rn-old-lost", status: "lost" }, { id: "rn-busy", status: "running" }, { id: "rn-idle", status: "idle" }, ...extraAgents,
  ] };
  let runnerSrv = null;
  let runnerState = null;
  const startRunner = async (hash) => {
    const token = `tok-${w.pidSeq}`;
    const pid = ++w.pidSeq;
    const polls = [...running];
    const heldPolls = held ? [...held] : null; // each entry: the heldAgents ids /health reports on that poll
    const st = { pid, token, hash, srv: null, dead: false };
    st.srv = http.createServer((req, res) => {
      const json = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
      const url = req.url.split("?")[0];
      if (url === "/health") {
        const h = heldPolls ? (heldPolls.length > 1 ? heldPolls.shift() : heldPolls[0]) : undefined;
        return json(200, { ok: true, running: polls.length > 1 ? polls.shift() : polls[0], ...(h ? { held: h.length, heldAgents: h } : {}), pid, hash });
      }
      const one = /^\/agents\/([^/]+)$/.exec(url);
      if (one && req.method === "GET" && agentStatus) { // agentStatus(id) -> the agent's status right now (per-id GET)
        const s = agentStatus(one[1]);
        return s ? json(200, { id: one[1], status: s }) : json(404, { error: "no such agent" });
      }
      const uw = /^\/agents\/([^/]+)\/unwedge$/.exec(url);
      if (uw && req.method === "POST") {
        let b = ""; req.on("data", (c) => { b += c; });
        req.on("end", () => { const body = JSON.parse(b || "{}"); w.calls.push(`unwedge ${uw[1]} ${body.retry ? "retry" : "fail"}`); w.unwedgeBodies.push(body); json(200, { ok: true, action: body.retry ? "retried" : "failed" }); });
        return;
      }
      if (url === "/agents") return json(200, { agents: agents.current });
      if (url === "/shutdown" && req.method === "POST") {
        w.shutdownAuth.push(req.headers.authorization);
        if (!supportsShutdown) return json(404, { error: "not found" });
        json(202, { ok: true });
        setImmediate(() => { st.dead = true; w.alive.delete(pid); rmSync(path.join(home, "runner.json"), { force: true }); close(st.srv); });
        return;
      }
      if (url === "/drain") { // restart drain (ideas 198 + 186): records { pid, method, body }; st.drain mirrors the runner's state
        let b = ""; req.on("data", (c) => { b += c; });
        req.on("end", () => {
          const body = b ? JSON.parse(b) : null;
          w.drainCalls.push({ pid, method: req.method, body });
          if (!supportsDrain) return json(404, { error: "not found" });
          if (req.method === "POST") { st.drain = { since: Date.now(), until: Date.now() + body.ttlMs, reason: body.reason }; return json(200, { ok: true, drain: st.drain }); }
          if (req.method === "DELETE") { const was = !!st.drain; st.drain = null; return json(200, { ok: true, cleared: was, drain: null }); }
          return json(404, {});
        });
        return;
      }
      const m = /^\/agents\/([^/]+)\/resume$/.exec(url);
      if (m && req.method === "POST") { w.calls.push(`resume ${m[1]}`); return json(202, { ok: true }); }
      return json(404, {});
    });
    const port = await listen(st.srv);
    writeFileSync(path.join(home, "token"), token);
    writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port, pid, startedAt: Date.now() }));
    w.alive.add(pid);
    runnerState = st; runnerSrv = st.srv; w.allSrvs.push(st.srv);
    return st;
  };
  let serverSrv = null;
  let serverPid = null;
  const startServer = async (port) => {
    serverPid = ++w.pidSeq;
    serverSrv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
    await listen(serverSrv, port);
    w.alive.add(serverPid);
    return serverPid;
  };
  const sp = http.createServer(); const serverPort = await listen(sp); await close(sp);
  await startServer(serverPort);
  await startRunner("old-hash");
  agents.current[1].status = "running";

  w.lookups = [];
  const deps = {
    // coordinated drain: the real helpers over a test teams registry; `vs` calls are recorded, never run
    coord: async () => { const m = await import("../server/restart-coord.mjs"); return teams ? { ...m, holderLeads: (h, a) => m.holderLeads(h, a, teams) } : m; },
    runVs: (args) => { w.vsCalls.push(args); return { ok: true }; },
    // fakes only: no test may reach the real reg.exe / where.exe / filesystem for the shell-env repair (Bug19 M2)
    regQuery: (key, name = "Path") => { w.lookups.push(`reg ${key} ${name}`); if (name !== "Path") throw new Error("no such value"); return { type: "REG_SZ", value: String.raw`C:\Windows\system32` }; },
    exists: (p) => { w.lookups.push(`exists ${p}`); return false; },
    which: () => { w.lookups.push("which"); return ""; },
    serverStopMode: treeKill ? "tree-kill" : "graceful",
    sleep: async (ms) => {
      if (swapRunnerOnFirstSleep && !w.swapped) { // the runner restarted on its own while we waited: new pid, port and token
        w.swapped = true;
        const old = runnerState; w.alive.delete(old.pid); await close(old.srv);
        await startRunner("swapped-hash");
      }
      await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    },
    pidAlive: (pid) => w.alive.has(pid),
    procInfo: (pid) => {
      if (!w.alive.has(pid)) return null;
      if (pid !== serverPid) {
        w.runnerInfoCalls += 1;
        // runnerRecycled "detect": the pid in runner.json already belongs to something else; "late": it is recycled after detection
        const recycled = runnerRecycled === "detect" || (runnerRecycled === "late" && w.runnerInfoCalls > 2);
        return { pid, ppid: 1, cmd: recycled ? "notepad.exe" : "node runner/server.mjs" };
      }
      w.serverInfoCalls += 1;
      const spoof = spoofAfterVerify && w.serverInfoCalls > 3; // the pid was reused between the check and the kill
      return { pid, ppid: 1, cmd: spoof || !serveCmd ? "something-else.exe" : "\"C:\\rt\\node.exe\" server/serve.mjs" };
    },
    listenerPid: () => (serverSrv?.listening ? serverPid : null),
    termGracefully: (pid) => { w.calls.push(`term ${pid}`); if (pid === serverPid) { w.alive.delete(pid); close(serverSrv); if (strayAfterServerStop) startRunner("stray-hash"); } },
    killHard: (pid) => {
      w.hardKills.push(pid); w.alive.delete(pid);
      if (pid === serverPid) { close(serverSrv); if (strayAfterServerStop) startRunner("stray-hash"); }
      if (runnerState?.pid === pid) { runnerState.dead = true; close(runnerSrv); }
    },
    spawnDetached: (cmd, args, o) => {
      w.spawnEnvs.push(o?.env);
      w.markerSeenAtSpawn.push(existsSync(path.join(configDir, "server.restarting")));
      const isServer = args.some((a) => /serve\.mjs/.test(a));
      w.spawned.push(isServer ? "server" : "runner");
      const pid = isServer ? null : w.pidSeq + 1;
      if (isServer) {
        startServer(serverPort).then(async () => { agents.current[1].status = "lost"; if (serverBootsRunner) await startRunner("new-hash"); });
        return w.pidSeq + 1;
      }
      agents.current[1].status = "lost";
      startRunner("new-hash");
      return pid;
    },
  };
  w.deps = deps;
  const env = { ...process.env, VIBESQUAD_HOME: outDir, VIBESQUAD_DESKTOP_CONFIG_DIR: configDir, ...envExtra };
  w.opts = (extra = {}) => ({ ...parseArgs(["--stop-timeout", "2", "--wait-timeout", "5"]), home, port: serverPort, configDir, outDir, runtimeDir: tmp, node: process.execPath, ...extra });
  w.run = (extra, logs = [], depsOver = {}) => restartRuntime(w.opts(extra), { ...deps, ...depsOver }, env, (l) => logs.push(l));
  w.cleanup = async () => { for (const s of [...w.allSrvs, serverSrv]) if (s?.listening) await close(s); rmSync(tmp, { recursive: true, force: true }); };
  w.runner = () => runnerState;
  return w;
}

test("full restart: marker held while working, graceful stops, server boots the runner, only restart-lost agents resumed, result file", async () => {
  const w = await world({ running: [2, 1, 0] });
  try {
    const logs = [];
    const r = await w.run({}, logs);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const names = r.steps.map((s) => s.step);
    const order = ["marker touched", "waiting for runner idle", "runner idle", "snapshot before stop", "runner stopped gracefully", "server stopped gracefully", "server started", "server healthy", "verified", "resumed lost agents", "marker cleared"];
    let last = -1;
    for (const n of order) { const i = names.indexOf(n); assert.ok(i > last, `${n} after ${order[order.indexOf(n) - 1]} (got ${names.join(" | ")})`); last = i; }
    assert.ok(logs.every((l) => /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]|^result:/.test(l)), "every step line is timestamped");
    assert.deepEqual(w.hardKills, [], "no force kill on the graceful path");
    assert.deepEqual(w.shutdownAuth.length, 1);
    assert.match(w.shutdownAuth[0], /^Bearer tok-/, "shutdown sent with the runner token");
    assert.deepEqual(w.markerSeenAtSpawn, [true], "desktop marker present when the server is started");
    assert.equal(existsSync(path.join(w.configDir, "server.restarting")), false, "marker cleared at the end");
    assert.equal(existsSync(path.join(w.outDir, "restart-runtime.lock")), false, "lock released");
    assert.equal(r.oldHash, "old-hash");
    assert.equal(r.newHash, "new-hash");
    assert.deepEqual(r.resumedAgents.map((a) => a.id), ["rn-busy"], "the 238-style historic lost roster is not woken");
    assert.deepEqual(w.calls.filter((c) => c.startsWith("resume")), ["resume rn-busy"]);
    const file = readdirSync(w.outDir).find((f) => /^restart-.*\.json$/.test(f));
    const saved = JSON.parse(readFileSync(path.join(w.outDir, file), "utf8"));
    assert.equal(saved.ok, true);
    assert.ok(saved.steps.length >= order.length);
    assert.equal(readFileSync(path.join(w.configDir, "server.pid"), "utf8").length > 0, true, "server.pid written like the desktop launcher");
  } finally { await w.cleanup(); }
});

test("runner not booted by the server: started directly after the grace window; wait timeout proceeds and records cut agents", async () => {
  const w = await world({ running: [1], serverBootsRunner: false });
  try {
    const r = await w.run({ waitTimeoutSec: 0.02, runnerBootMs: 300 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.cutAgents.map((a) => a.id), ["rn-busy"]);
    assert.deepEqual(w.spawned, ["server", "runner"]);
    assert.equal(r.steps.some((s) => s.step === "wait timed out, proceeding"), true);
  } finally { await w.cleanup(); }
});

test("runner without /shutdown: forced only because graceful is unavailable, recorded; --no-force refuses and kills nothing", async () => {
  const w = await world({ supportsShutdown: false });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.forced.map((f) => f.label), ["runner"]);
    assert.match(r.forced[0].reason, /no \/shutdown/);
  } finally { await w.cleanup(); }
  const w2 = await world({ supportsShutdown: false });
  try {
    const r = await w2.run({ force: false });
    assert.equal(r.ok, false);
    assert.deepEqual(w2.hardKills, []);
    assert.equal(existsSync(path.join(w2.configDir, "server.restarting")), false, "marker cleared even on failure");
    assert.ok(r.errors.some((e) => /--no-force/.test(e)));
  } finally { await w2.cleanup(); }
});

test("idempotent: a live holder makes a second run a no-op; a dead holder's lock is taken over", async () => {
  const w = await world();
  try {
    mkdirSync(w.outDir, { recursive: true });
    writeFileSync(path.join(w.outDir, "restart-runtime.lock"), JSON.stringify({ pid: w.runner().pid, at: Date.now() })); // alive in the fake table
    const r = await w.run({});
    assert.equal(r.alreadyRunning, true);
    assert.equal(r.ok, false);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.shutdownAuth, [], "nothing was stopped");
    assert.equal(existsSync(path.join(w.outDir, "restart-runtime.lock")), true, "the holder's lock is left alone");
    writeFileSync(path.join(w.outDir, "restart-runtime.lock"), JSON.stringify({ pid: 424242, at: Date.now() })); // dead
    const r2 = await w.run({});
    assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  } finally { await w.cleanup(); }
});

test("refuses to stop a process on the server port that is not serve.mjs", async () => {
  const w = await world({ serveCmd: false });
  try {
    const r = await w.run({});
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /not serve\.mjs/.test(e)));
    assert.deepEqual(w.hardKills, []);
    assert.deepEqual(w.shutdownAuth, [], "preflight refuses before the runner is stopped");
  } finally { await w.cleanup(); }
});

test("dry run: prints the plan with detections and changes nothing", async () => {
  const w = await world();
  try {
    const r = await w.run({ dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan.detected.runner.alive, true);
    assert.equal(r.plan.detected.server.isServe, true);
    assert.deepEqual(r.plan.detected.runningAgents.map((a) => a.id), ["rn-busy"]);
    assert.deepEqual(r.plan.detected.lostAgents.map((a) => a.id), ["rn-old-lost"]);
    assert.ok(r.plan.steps.length >= 8);
    assert.equal(existsSync(path.join(w.configDir, "server.restarting")), false);
    assert.equal(existsSync(path.join(w.outDir, "restart-runtime.lock")), false);
    assert.deepEqual([w.calls, w.shutdownAuth, w.spawned, w.hardKills], [[], [], [], []]);
  } finally { await w.cleanup(); }
});

test("parseArgs: defaults and overrides; unknown flag throws", () => {
  const d = parseArgs([]);
  assert.deepEqual([d.waitTimeoutSec, d.force, d.resume, d.wait, d.dryRun], [600, true, true, true, false]);
  const o = parseArgs(["--dry-run", "--wait-timeout", "30", "--no-force", "--no-resume", "--no-wait", "--port", "9"]);
  assert.deepEqual([o.waitTimeoutSec, o.force, o.resume, o.wait, o.dryRun, o.port], [30, false, false, false, true, 9]);
  assert.throws(() => parseArgs(["--bogus"]));
});


test("Windows-style server stop: one tree kill (no graceful attempt, no 30s burn), --no-force does not make it fail; pid identity re-verified before the kill", async () => {
  const w = await world({ treeKill: true });
  try {
    const r = await w.run({ force: false, stopTimeoutSec: 2 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.serverStop, "tree-kill");
    assert.equal(w.calls.some((c) => c.startsWith("term")), false, "no plain taskkill attempt");
    assert.equal(w.hardKills.length, 1);
    const names = r.steps.map((s) => s.step);
    assert.ok(names.indexOf("runner stopped gracefully") < names.indexOf("server tree-killed"), "runner first");
  } finally { await w.cleanup(); }
  const w2 = await world({ treeKill: true, spoofAfterVerify: true });
  try {
    const r = await w2.run({});
    assert.equal(r.ok, false);
    assert.deepEqual(w2.hardKills, [], "a pid that stopped being serve.mjs is never killed");
    assert.ok(r.errors.some((e) => /changed identity/.test(e)));
  } finally { await w2.cleanup(); }
});

test("a runner the old server respawned in the gap is swept before our start", async () => {
  const w = await world({ treeKill: true, strayAfterServerStop: true });
  try {
    const r = await w.run({ runnerBootMs: 300 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.steps.some((s) => s.step === "stray runner found after server stop"));
    assert.equal(w.shutdownAuth.length, 2, "original + stray both shut down");
  } finally { await w.cleanup(); }
});

test("runner pid/port/token re-detected right before /shutdown (it restarted during the wait)", async () => {
  const w = await world({ running: [3], swapRunnerOnFirstSleep: true });
  try {
    const first = w.runner().token;
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(w.shutdownAuth.length, 1);
    assert.notEqual(w.shutdownAuth[0], `Bearer ${first}`, "the old token was not reused");
    assert.equal(r.steps.filter((s) => s.step === "runner stopped gracefully").length, 1);
  } finally { await w.cleanup(); }
});

test("detection runs under the lock: a refused second run never reads or touches anything", async () => {
  const w = await world();
  try {
    mkdirSync(w.outDir, { recursive: true });
    writeFileSync(path.join(w.outDir, "restart-runtime.lock"), JSON.stringify({ pid: w.runner().pid, at: Date.now() }));
    const before = w.serverInfoCalls;
    const r = await w.run({});
    assert.equal(r.alreadyRunning, true);
    assert.equal(w.serverInfoCalls, before, "no detection happened before the lock was won");
    assert.equal(existsSync(path.join(w.configDir, "server.restarting")), false);
  } finally { await w.cleanup(); }
});

test("vs restart: --timeout must be a positive integer; unsafe launch args rejected; caller gate; env passed as flags", async () => {
  const { commandRestart, assertRestartCaller } = await import("../cli/vs.mjs");
  const teams = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }] }];
  const owner = { hasOwnerProof: () => true }; // the owner's shell: no agent id + a readable local token (X1b)
  const run = async (flags, opts = {}) => {
    const seen = [];
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => { out.push(String(c)); return true; };
    try { return { code: await commandRestart(flags, { spawnFn: (exe, args) => { seen.push(args); return 4321; }, env: {}, teams, ...owner, drainGuard: () => ({ pending: [] }), ...opts }), seen, out: out.join("") }; } finally { process.stdout.write = orig; }
  };
  const ok = await run({ timeout: "90", noForce: true });
  assert.equal(ok.code, 0);
  assert.ok(ok.seen[0][0].split(path.sep).join("/").endsWith("scripts/restart-runtime.mjs"));
  assert.deepEqual(ok.seen[0].slice(3), ["--no-force", "--wait-timeout", "90"]);
  assert.match(ok.out, /restart launched \(pid 4321\)/);
  assert.deepEqual((await run({ killBackground: true })).seen[0].slice(3), ["--kill-background"], "background work is only killed when asked (idea-88)");
  for (const bad of ["0", "-5", "1.5", "abc", "10 --no-wait", "1e3", ""]) await assert.rejects(run({ timeout: bad }), /positive integer/, bad);
  // WMI CommandLine: a quote or control char in any path (e.g. VIBESQUAD_HOME) is refused, never escaped into the string
  await assert.rejects(run({}, { env: { VIBESQUAD_HOME: 'C:\\x" --evil "' } }), /quote or control/);
  await assert.rejects(run({}, { env: { VIBESQUAD_HOME: "C:\\x\ny" } }), /quote or control/);
  // WMI drops our env, so the values travel as flags
  const home = path.join(os.tmpdir(), "vs-home-x");
  const env = await run({}, { env: { VIBESQUAD_HOME: home, VIBESQUAD_DESKTOP_CONFIG_DIR: path.join(os.tmpdir(), "cfg-x"), VIBESQUAD_PORT: "4999" } });
  const a = env.seen[0];
  for (const f of ["--vs-home", "--home", "--out-dir", "--config-dir", "--port"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--port") + 1], "4999");
  assert.equal(a[a.indexOf("--home") + 1], path.join(home, "runner"));
  // caller gate (X1b guard): no agent id needs owner proof; an empty env has none (no home, no local token)
  const as = (role, lane) => ({ role, lane, team: { id: "vibesquad" } });
  const agentEnv = { VS_AGENT_ID: "rn-abcdef123456" };
  await assert.rejects(assertRestartCaller(null, teams, {}), /no owner proof/, "a scrubbed shell is not the owner");
  await assert.rejects(run({}, { hasOwnerProof: undefined, env: {} }), /no owner proof/);
  const ownerHome = mkdtempSync(path.join(os.tmpdir(), "vs-owner-"));
  writeFileSync(path.join(ownerHome, "local-token"), "a".repeat(64) + "\n");
  await assert.doesNotReject(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome }), "owner shell: the local token is the proof");
  await assert.rejects(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome, VS_AGENT_ID: "rn-abcdef123456" }), /403/, "an agent id is never the owner, whatever it can read; without a token it is refused outright (X1d)");
  rmSync(ownerHome, { recursive: true, force: true });
  await assert.rejects(assertRestartCaller(as("worker", "bug-chaser"), teams, agentEnv), /only the owner or the Overlord/);
  await assert.rejects(assertRestartCaller(as("lead", "bug-chaser"), teams, agentEnv), /only the owner or the Overlord/, "a non-hub lead");
  await assert.rejects(assertRestartCaller(as("brainstorm", "vibesquad"), teams, agentEnv), /only the owner/);
  await assert.doesNotReject(assertRestartCaller(as("lead", "vibesquad"), teams, agentEnv), "hub lead = Overlord");
  // X1d guard: an rn- id without a token is a 403 before the runner is asked, even if VS_ROLE/VS_LANE/VS_TEAM claim to be
  // the Overlord; the disk record is never consulted (the X1a-X1b rollout fallback and its flag are gone).
  const spoof = { VS_AGENT_ID: "rn-deadbeef0000", VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" };
  const verifyNever = async () => { throw new Error("verify must not be called without a token"); };
  await assert.rejects(assertRestartCaller(null, teams, spoof, { verify: verifyNever }), /403/, "no token: 403, no runner call");
  await assert.rejects(run({}, { env: spoof, verify: verifyNever }), /403/);
  await assert.rejects(assertRestartCaller(null, teams, { ...spoof, VS_AGENT_TOKEN_REQUIRED: "0" }, { verify: verifyNever }), /403/, "the old flag does not bring the record-based fallback back");
  await assert.rejects(run({}, { identity: as("worker", "bug-chaser"), env: agentEnv }), /only the owner/);
  assert.equal((await run({}, { identity: as("lead", "vibesquad"), env: agentEnv })).code, 0);
  // X1b: with a token the runner decides (GET /verify-agent). A wrong token is 403.
  const tokenEnv = { ...spoof, VS_AGENT_TOKEN: "t0k" };
  const verifyOk = async ({ id, token }) => { assert.deepEqual([id, token], ["rn-deadbeef0000", "t0k"]); return { id, role: "lead", lane: "vibesquad", team: "vibesquad", overlord: true }; };
  const verify403 = async () => { throw Object.assign(new Error("agent token invalid"), { status: 403 }); };
  await assert.doesNotReject(assertRestartCaller(null, teams, tokenEnv, { verify: verifyOk }), "verified Overlord");
  await assert.rejects(assertRestartCaller(null, teams, tokenEnv, { verify: verify403 }), /403/, "a wrong token is refused whatever the env claims");
  await assert.rejects(assertRestartCaller(null, teams, tokenEnv, { verify: async ({ id }) => ({ id, role: "worker", lane: "bug-chaser", team: "vibesquad" }) }), /only the owner/, "the runner's record decides the role");
  await assert.rejects(run({}, { env: tokenEnv, verify: verify403 }), /403/);
});

test("X1b: a restart launched from an env with an agent id/token starts the server and runner without them", async () => {
  const w = await world({ serverBootsRunner: false, envExtra: { VS_AGENT_ID: "rn-lead-shell", PASEO_AGENT_ID: "rn-lead-shell", VS_AGENT_TOKEN: "s3cret-agent-token" } });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(w.spawned, ["server", "runner"], "both children were launched by the restart");
    assert.equal(w.spawnEnvs.length, 2);
    for (const e of w.spawnEnvs) {
      assert.ok(e && typeof e === "object", "a launch env was passed");
      for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN"]) assert.equal(k in e, false, `${k} must not reach the child`);
      assert.equal(e.VIBESQUAD_HOME, w.outDir, "the rest of the env still passes through");
    }
    assert.equal(JSON.stringify(w.spawnEnvs).includes("s3cret-agent-token"), false, "the token string never reaches a child");
  } finally {
    await w.cleanup();
  }
});

test("recycled runner pid: never killed (cmdline must be the runner) at detect time or right before the kill", async () => {
  // runner.json names a pid that is now an unrelated process, and /shutdown would 404 -> the force path
  const w = await world({ supportsShutdown: false, runnerRecycled: "detect" });
  try {
    const r = await w.run({ runnerBootMs: 300 });
    assert.equal(w.hardKills.includes(w.runner().pid), false, "the recycled pid was not killed");
    assert.equal(w.shutdownAuth.length, 0, "no shutdown sent to a non-runner");
    assert.ok(r.steps.some((s) => s.step === "runner not running" && /recycled/.test(s.note ?? "")));
    assert.equal(r.forced.some((f) => f.label === "runner"), false);
  } finally { await w.cleanup(); }
  // recycled between detection and the kill
  const w2 = await world({ supportsShutdown: false, runnerRecycled: "late" });
  try {
    const r = await w2.run({});
    assert.equal(r.ok, false);
    assert.deepEqual(w2.hardKills, [], "nothing killed");
    assert.ok(r.errors.some((e) => /no longer the runner/.test(e)));
  } finally { await w2.cleanup(); }
});

// idea-88 (c): an idle agent whose park is held by background work (a suite it left running) never counts as running, so the
// old wait proceeded at once and the runner stop killed the suite. It must be waited for, and past the timeout the restart
// defers (nothing stopped) unless --kill-background.
test("held background work outlasting the wait defers the restart: nothing stopped, marker + lock cleared, holders named", async () => {
  const w = await world({ running: [0], held: [["rn-suite"]] });
  try {
    const r = await w.run({ waitTimeoutSec: 0.05 });
    assert.equal(r.ok, false);
    assert.deepEqual(r.deferred, { held: 1, heldAgents: ["rn-suite"], running: 0, leads: [], unresolved: [{ agentId: "rn-suite", reason: "not in the runner's agent list" }] });
    assert.ok(r.errors.some((e) => /deferred: 1 agent\(s\) still hold background work .*rn-suite.*No lead resolved for: rn-suite/.test(e)), JSON.stringify(r.errors));
    assert.ok(!r.errors.some((e) => /rerun later|pass --kill-background/.test(e)), "the deferral never suggests a timer retry or --kill-background");
    assert.equal(w.shutdownAuth.length, 0, "runner never told to stop");
    assert.deepEqual(w.hardKills, [], "nothing killed");
    assert.deepEqual(w.spawned, [], "nothing started");
    assert.equal(w.calls.some((c) => c.startsWith("term")), false, "server left alone");
    assert.equal(existsSync(path.join(w.configDir, "server.restarting")), false, "marker cleared");
    assert.equal(existsSync(path.join(w.outDir, "restart-runtime.lock")), false, "lock released");
    assert.ok(r.resultFile && existsSync(r.resultFile), "result file says why");
  } finally { await w.cleanup(); }
});

test("held background work that finishes during the wait: the restart proceeds normally; --kill-background proceeds and records it", async () => {
  const w = await world({ running: [0], held: [["rn-suite"], ["rn-suite"], []] });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.deferred, undefined);
    assert.ok(r.steps.some((s) => s.step === "runner idle"));
    assert.equal(w.shutdownAuth.length, 1);
  } finally { await w.cleanup(); }
  const w2 = await world({ running: [0], held: [["rn-suite"]] });
  try {
    const r = await w2.run({ waitTimeoutSec: 0.05, killBackground: true });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.killedBackground, ["rn-suite"]);
    assert.equal(w2.shutdownAuth.length, 1);
  } finally { await w2.cleanup(); }
});

// idea-109: a 202 from /resume was the only check, so an agent stuck in `starting` stayed "initializing" for 40+ min.
test("resumed agent stuck in starting: retried once, then stopped and recorded as failed (ok=false), never left silently wedged", async () => {
  const w = await world({ running: [0], agentStatus: () => "starting" });
  try {
    const r = await w.run({ resumeVerifySec: 0.05 });
    assert.equal(r.ok, false);
    assert.deepEqual(r.resumeFailed, [{ id: "rn-busy", action: "failed" }]);
    assert.deepEqual(w.calls.filter((c) => /^(resume|unwedge)/.test(c)), ["resume rn-busy", "unwedge rn-busy retry", "unwedge rn-busy fail"]);
    assert.match(w.unwedgeBodies[1].reason, /still starting 0.05s after a restart resume and one retry/);
    assert.ok(r.errors.some((e) => /resume verify: 1 agent\(s\) never left 'starting': rn-busy/.test(e)), JSON.stringify(r.errors));
    assert.ok(r.steps.some((s) => s.step === "resume stuck in starting, retried once"));
    assert.equal(existsSync(path.join(w.configDir, "server.restarting")), false, "marker still cleared");
  } finally { await w.cleanup(); }
});

test("resumed agent that starts after the retry: ok, no failure; one that starts at once: no unwedge at all", async () => {
  let wref;
  const w = await world({ running: [0], agentStatus: (id) => (wref.calls.includes(`unwedge ${id} retry`) ? "idle" : "starting") });
  wref = w;
  try {
    const r = await w.run({ resumeVerifySec: 0.05 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.resumeFailed, []);
    assert.deepEqual(w.calls.filter((c) => c.startsWith("unwedge")), ["unwedge rn-busy retry"]);
    assert.ok(r.steps.some((s) => s.step === "resumed agents started after retry"));
  } finally { await w.cleanup(); }
  const w2 = await world({ running: [0], agentStatus: () => "idle" });
  try {
    const r = await w2.run({ resumeVerifySec: 0.05 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(w2.calls.some((c) => c.startsWith("unwedge")), false);
    assert.ok(r.steps.some((s) => s.step === "resumed agents started"));
  } finally { await w2.cleanup(); }
});

test("parseArgs: --kill-background and --resume-verify", () => {
  const d = parseArgs([]);
  assert.deepEqual([d.killBackground, d.resumeVerifySec], [false, 90]);
  const o = parseArgs(["--kill-background", "--resume-verify", "15"]);
  assert.deepEqual([o.killBackground, o.resumeVerifySec], [true, 15]);
  assert.throws(() => parseArgs(["--resume-verify", "-1"]));
});

test("X1b R1 M1/L1: a leftover VS_AGENT_TOKEN is never owner proof; owner verbs refuse it; both launch paths strip every VS_* identity key", async () => {
  const { assertRestartCaller, assertOwnerShell, AGENT_ENV_KEYS: CLI_KEYS, stripAgentEnv: cliStrip } = await import("../cli/vs.mjs");
  const { AGENT_ENV_KEYS } = await import("../scripts/restart-runtime.mjs");
  const teams = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }] }];
  const ownerHome = mkdtempSync(path.join(os.tmpdir(), "vs-owner-"));
  writeFileSync(path.join(ownerHome, "local-token"), "a".repeat(64) + "\n");
  try {
    await assert.doesNotReject(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome }));
    await assert.rejects(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome, VS_AGENT_TOKEN: "leftover" }), /no owner proof/, "a token with the id cleared is not the owner");
    await assert.rejects(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome, VS_AGENT_ID: "", PASEO_AGENT_ID: "", VS_AGENT_TOKEN: "leftover" }), /no owner proof/);
    assert.throws(() => assertOwnerShell("vs pair", { VS_AGENT_TOKEN: "leftover" }), /owner verb/);
    assert.throws(() => assertOwnerShell("vs pair", { PASEO_AGENT_ID: "", VS_AGENT_ID: "rn-x" }), /owner verb/, "an empty PASEO_AGENT_ID does not mask VS_AGENT_ID");
    assert.doesNotThrow(() => assertOwnerShell("vs pair", { VIBESQUAD_HOME: ownerHome }));
  } finally {
    rmSync(ownerHome, { recursive: true, force: true });
  }
  const all = ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_ROLE", "VS_LANE", "VS_TEAM", "VS_ORD", "VS_PROFILE"];
  for (const k of all) {
    assert.ok(AGENT_ENV_KEYS.includes(k), `restart-runtime strips ${k}`);
    assert.ok(CLI_KEYS.includes(k), `cli strips ${k}`);
  }
  const full = Object.fromEntries(all.map((k) => [k, "x"]));
  assert.deepEqual(Object.keys(cliStrip({ ...full, KEEP: "1" })), ["KEEP"]);
  const w = await world({ serverBootsRunner: false, envExtra: { ...full, VS_AGENT_TOKEN: "s3cret-agent-token" } });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(w.spawnEnvs.length, 2);
    for (const e of w.spawnEnvs) for (const k of all) assert.equal(k in e, false, `${k} must not reach the child`);
  } finally {
    await w.cleanup();
  }
});

// idea-178: a runtime relaunched from an agent tool shell must get a repaired shell env (registry PATH, no empty HOME).
test("repairShellEnv (win32): registry PATH first, inherited extras kept, dedupe, expansion, one Path key, empty HOME/SHELL dropped", async () => {
  const { repairShellEnv, stripAgentEnv } = await import("../scripts/restart-runtime.mjs");
  const BS = String.fromCharCode(92);
  const reg = { HKLM: { type: "REG_EXPAND_SZ", value: String.raw`%SystemRoot%\system32;C:\Program Files\Git\usr\bin;C:\Tools` + BS }, HKCU: { type: "REG_SZ", value: String.raw`C:\Users\u\bin` } };
  const regQuery = (key) => reg[key.startsWith("HKLM") ? "HKLM" : "HKCU"];
  const env = { PATH: String.raw`c:\tools;C:\Program Files\Git\cmd;C:\Users\u\bin` + BS, SystemRoot: String.raw`C:\Windows`, Path: "ignored", HOME: "", SHELL: "", FOO: "" };
  const out = repairShellEnv(env, { regQuery, platform: "win32" });
  assert.deepEqual(out.Path.split(";"), [String.raw`C:\Windows\system32`, String.raw`C:\Program Files\Git\usr\bin`, String.raw`C:\Tools` + BS, String.raw`C:\Users\u\bin`, String.raw`C:\Program Files\Git\cmd`]);
  assert.deepEqual(Object.keys(out).filter((k) => k.toLowerCase() === "path"), ["Path"]);
  assert.ok(!("HOME" in out) && !("SHELL" in out)); assert.equal(out.FOO, "");
  assert.equal(env.HOME, "", "input not mutated");
  const lines = [];
  const bad = repairShellEnv({ PATH: "C:/a", HOME: "" }, { regQuery: () => { throw new Error("boom"); }, platform: "win32", log: (l) => lines.push(l) });
  assert.equal(bad.PATH, "C:/a"); assert.ok(!("HOME" in bad)); assert.equal(lines.length, 1);
  const posix = { PATH: "/bin", HOME: "" };
  assert.equal(repairShellEnv(posix, { platform: "linux", regQuery }), posix);
  assert.deepEqual(stripAgentEnv({ VS_AGENT_ID: "x", VS_AGENT_TOKEN: "t", KEEP: "1" }), { KEEP: "1" });
});

test("repairShellEnv git bin: ahead of System32; root from registry or git.exe path; none = no change; HKCU missing keeps HKLM; failure path one Path key", async () => {
  const { repairShellEnv } = await import("../scripts/restart-runtime.mjs");
  const root = String.raw`C:\Program Files\Git`;
  const sys = String.raw`C:\Windows\system32`;
  const tools = String.raw`C:\Tools`;
  const x = String.raw`C:\x`;
  const files = new Set([String.raw`C:\Program Files\Git\bin\bash.exe`.toLowerCase(), String.raw`C:\Program Files\Git\cmd\git.exe`.toLowerCase()]);
  const exists = (p) => files.has(String(p).toLowerCase());
  // one registry fake: Path values by hive, InstallPath by key (missing = throws, like reg.exe exit 1)
  const mkReg = ({ hklm = null, hkcu = null, install = {} } = {}) => (key, name = "Path") => {
    const hit = name === "InstallPath" ? install[key] : (key.startsWith("HKLM") ? hklm : hkcu);
    if (!hit) throw new Error(`no ${name} in ${key}`);
    return { type: "REG_SZ", value: hit };
  };
  const hklm = [sys, `${root}\\cmd`, tools].join(";");
  const base = { platform: "win32", exists, which: () => "" };
  const env = { PATH: x, HOME: "" };
  let out = repairShellEnv(env, { ...base, regQuery: mkReg({ hklm, install: { "HKLM\\SOFTWARE\\GitForWindows": root } }) });
  assert.deepEqual(out.Path.split(";"), [`${root}\\bin`, `${root}\\usr\\bin`, sys, `${root}\\cmd`, tools, x], "registry root; HKLM kept without HKCU");
  out = repairShellEnv(env, { ...base, regQuery: mkReg({ hklm }) });
  assert.deepEqual(out.Path.split(";").slice(0, 3), [`${root}\\bin`, `${root}\\usr\\bin`, sys], "root derived from git.exe on PATH");
  out = repairShellEnv({ PATH: "" }, { ...base, regQuery: mkReg({ hklm: sys }), which: () => `${root}\\cmd\\git.exe` });
  assert.deepEqual(out.Path.split(";"), [`${root}\\bin`, `${root}\\usr\\bin`, sys], "root from where git");
  out = repairShellEnv(env, { ...base, regQuery: mkReg({ hklm }), exists: () => false });
  assert.deepEqual(out.Path.split(";"), [sys, `${root}\\cmd`, tools, x], "no git: unchanged");
  const lines = [];
  out = repairShellEnv({ PATH: "C:/a", Path: "C:/b" }, { regQuery: () => { throw new Error("boom"); }, platform: "win32", log: (m) => lines.push(m) });
  assert.deepEqual(Object.keys(out).filter((k) => k.toLowerCase() === "path"), ["Path"]);
  assert.equal(out.Path, "C:/a"); assert.equal(lines.length, 1);

  // M1: quoted InstallPath / PATH entries / git.exe path / System32
  const q = (s) => `"${s}"`;
  out = repairShellEnv({ PATH: q(tools) }, { ...base, regQuery: mkReg({ hklm: [q(sys), tools].join(";"), install: { "HKLM\\SOFTWARE\\GitForWindows": q(root) } }) });
  assert.deepEqual(out.Path.split(";"), [`${root}\\bin`, `${root}\\usr\\bin`, sys, tools], "quoted InstallPath + quoted System32 handled, entries unquoted, deduped");
  out = repairShellEnv({ PATH: "" }, { ...base, regQuery: mkReg({ hklm: sys }), which: () => q(`${root}\\cmd\\git.exe`) });
  assert.deepEqual(out.Path.split(";").slice(0, 2), [`${root}\\bin`, `${root}\\usr\\bin`], "quoted where-git result");
  out = repairShellEnv({ PATH: q(`${root}\\cmd`) }, { ...base, regQuery: mkReg({ hklm: sys }), which: () => "" });
  assert.deepEqual(out.Path.split(";").slice(0, 2), [`${root}\\bin`, `${root}\\usr\\bin`], "quoted git\\cmd PATH entry");

  // L1: only known layouts; mingw64 ok; scoop shim gets no root even if something bash-like sits nearby
  const mg = String.raw`C:\Program Files\Git\mingw64\bin`;
  out = repairShellEnv({ PATH: "" }, { ...base, regQuery: mkReg({ hklm: sys }), which: () => `${mg}\\git.exe` });
  assert.deepEqual(out.Path.split(";"), [`${root}\\bin`, `${root}\\usr\\bin`, sys], "mingw64\\bin\\git.exe -> Git root");
  const scoop = String.raw`C:\Users\u\scoop\shims`;
  const sfiles = new Set([`${scoop}\\git.exe`, String.raw`C:\Users\u\scoop\bin\bash.exe`, String.raw`C:\Users\u\bash.exe`, String.raw`C:\Users\bin\bash.exe`].map((s) => s.toLowerCase()));
  out = repairShellEnv({ PATH: scoop }, { ...base, regQuery: mkReg({ hklm: sys }), exists: (p) => sfiles.has(String(p).toLowerCase()), which: () => `${scoop}\\git.exe` });
  assert.deepEqual(out.Path.split(";"), [sys, scoop], "scoop shim: no root, PATH unchanged");
});

test("shell-env repair: the restart only uses injected lookups; no deps means no lookups (Bug19 M2)", async () => {
  const { repairShellEnv } = await import("../scripts/restart-runtime.mjs");
  const w = await world({ serverBootsRunner: false });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r));
    if (process.platform === "win32") {
      assert.ok(w.lookups.some((l) => l.startsWith("reg HKLM")), "the restart read the registry through the injected fake");
      assert.ok(w.spawnEnvs.every((e) => typeof (e.Path ?? e.PATH) === "string"));
    }
  } finally {
    await w.cleanup();
  }
  // a missing dep is "unavailable", never the real reg.exe / where.exe / fs
  const out = repairShellEnv({ PATH: "C:\\keep" }, { platform: "win32" });
  assert.equal(out.PATH ?? out.Path, "C:\\keep");
});

// ---- coordinated drain (docs/PLAN_COORDINATED_DRAIN.md D1-D3) -------------------------------------------------------
const EFI_TEAMS = [{ id: "efi", name: "EFI", lanes: [{ id: "godot" }, { id: "ui" }] }];
const holderAgents = [
  { id: "rn-suite", status: "idle", labels: { team: "efi", lane: "godot", role: "worker" } },
  { id: "rn-suite2", status: "idle", labels: { team: "efi", lane: "godot", role: "worker" } },
  { id: "rn-lead-godot", status: "idle", title: "★ God3 · Godot", labels: { team: "efi", lane: "godot", role: "lead", ord: "3" } },
  { id: "rn-ui-worker", status: "idle", labels: { team: "efi", lane: "ui", role: "worker" } }, // lane ui has no lead
];

test("D1 deferral names each holder's lane lead (vs who lead resolution) with a ready-to-send drain ask; no timer-retry or --kill-background advice", async () => {
  const w = await world({ running: [0], held: [["rn-suite", "rn-suite2", "rn-ui-worker", "rn-ghost"]], extraAgents: holderAgents, teams: EFI_TEAMS });
  try {
    const logs = [];
    const r = await w.run({ waitTimeoutSec: 0.05 }, logs);
    assert.equal(r.ok, false);
    assert.equal(r.deferred.leads.length, 1, JSON.stringify(r.deferred));
    const [l] = r.deferred.leads;
    assert.deepEqual({ team: l.team, lane: l.lane, leadId: l.leadId, leadTitle: l.leadTitle, heldAgents: l.heldAgents }, { team: "efi", lane: "godot", leadId: "rn-lead-godot", leadTitle: "★ God3", heldAgents: ["rn-suite", "rn-suite2"] });
    assert.match(l.ask, /drain/);
    assert.match(l.ask, /vs log restart-feedback 'drained restart'/);
    assert.match(l.ask, /restart-done/);
    assert.ok(!/["`]/.test(l.ask), "the ask pastes into vs send \"...\" in any shell");
    assert.deepEqual(r.deferred.unresolved, [{ agentId: "rn-ui-worker", reason: "no live lead in efi/ui" }, { agentId: "rn-ghost", reason: "not in the runner's agent list" }]);
    const err = r.errors.find((e) => e.startsWith("deferred:"));
    assert.match(err, /Ask these leads to drain and hold background suites: godot lead rn-lead-godot \(★ God3\) holds rn-suite, rn-suite2/);
    assert.match(err, /No lead resolved for: rn-ui-worker \(no live lead in efi\/ui\); rn-ghost/);
    assert.match(err, /Wait for each lead's vs log restart-feedback 'drained restart', then rerun vs restart/);
    assert.match(err, /No timer retries; --kill-background needs the owner's per-run OK/);
    assert.ok(!/rerun later|pass --kill-background/.test(err));
    assert.ok(logs.some((x) => x.startsWith('drain ask -> vs send rn-lead-godot "Restart pending')), "stdout carries the ready-to-send ask");
    assert.ok(logs.some((x) => /no lead resolved for rn-ui-worker/.test(x)));
    const saved = JSON.parse(readFileSync(r.resultFile, "utf8"));
    assert.deepEqual(saved.deferred.leads, r.deferred.leads, "restart-<ts>.json carries the leads + asks");
    assert.deepEqual(w.vsCalls, [], "a deferral sends nothing on its own");
    assert.equal(w.shutdownAuth.length, 0);
  } finally { await w.cleanup(); }
});

test("D1: a lead lookup that fails still defers cleanly and names every holder as unresolved", async () => {
  const w = await world({ running: [0], held: [["rn-suite"]], extraAgents: holderAgents, teams: EFI_TEAMS });
  try {
    const r = await w.run({ waitTimeoutSec: 0.05 }, [], { coord: async () => { throw new Error("boom"); } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.deferred.unresolved, [{ agentId: "rn-suite", reason: "lead lookup failed: boom" }]);
    assert.ok(r.errors.some((e) => /ask the holders' leads to drain, wait for each 'drained', then rerun vs restart\. No timer retries; --kill-background needs the owner's per-run OK/.test(e)), JSON.stringify(r.errors));
    assert.equal(w.shutdownAuth.length, 0);
  } finally { await w.cleanup(); }
});

test("D2 guard: a rerun within 30 min of a deferral is refused, listing the pending leads, until each logged restart-feedback 'drained restart'", async () => {
  const { commandRestart } = await import("../cli/vs.mjs");
  const { drainGuard } = await import("../server/restart-coord.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-drain-"));
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const lead = (leadId, lane, heldAgents) => ({ team: "efi", lane, leadId, leadTitle: null, heldAgents, ask: "x" });
  const writeResult = (msAgo, body) => writeFileSync(path.join(home, `restart-${iso(msAgo).replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: iso(msAgo), finishedAt: iso(msAgo - 1000), dryRun: false, ok: false, errors: [], ...body }));
  const logDrain = (agent, msAgo, text = "restart-feedback: drained restart") => {
    mkdirSync(path.join(home, "teams", "efi"), { recursive: true });
    writeFileSync(path.join(home, "teams", "efi", "log.jsonl"), JSON.stringify({ ts: iso(msAgo), agent, lane: "godot", type: "metric", text, refs: [] }) + "\n", { flag: "a" });
  };
  const teams = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }] }];
  const run = async (flags = {}) => {
    const seen = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try { return { code: await commandRestart(flags, { spawnFn: (exe, args) => { seen.push(args); return 7; }, env: { VIBESQUAD_HOME: home }, teams, hasOwnerProof: () => true, now: () => now }), seen }; } finally { process.stdout.write = orig; }
  };
  try {
    assert.deepEqual(drainGuard(home, { now }).pending, [], "no restart history: go");
    writeResult(10 * 60000, { deferred: { held: 2, heldAgents: ["rn-a", "rn-b"], running: 0, leads: [lead("rn-lead-godot", "godot", ["rn-a"]), lead("rn-lead-ui", "ui", ["rn-b"])], unresolved: [] } });
    await assert.rejects(run(), (e) => /refused: the last restart deferred 10 min ago/.test(e.message) && /godot lead rn-lead-godot \[holds rn-a\]; ui lead rn-lead-ui \[holds rn-b\]/.test(e.message) && /No timer retries/.test(e.message), "both leads pending");
    logDrain("rn-lead-godot", 20 * 60000); // before the deferral: does not count
    logDrain("rn-lead-godot", 5 * 60000, "restart-feedback: restart-done"); // not a drain
    logDrain("rn-someone-else", 4 * 60000);
    await assert.rejects(run(), /rn-lead-godot \[holds rn-a\]; ui lead rn-lead-ui/, "a stale drain, another text or another agent never counts");
    logDrain("rn-lead-godot", 3 * 60000);
    await assert.rejects(run(), (e) => !/rn-lead-godot/.test(e.message) && /ui lead rn-lead-ui \[holds rn-b\]/.test(e.message), "only the still-pending lead is listed");
    logDrain("rn-lead-ui", 2 * 60000);
    const ok = await run();
    assert.equal(ok.code, 0, "every named lead drained: proceeds");
    assert.equal(ok.seen.length, 1);
    // the window: 30 min after the deferral the guard lapses (history, not a live ask)
    rmSync(path.join(home, "teams"), { recursive: true, force: true });
    assert.equal(drainGuard(home, { now }).pending.length, 2);
    assert.deepEqual(drainGuard(home, { now: now + 21 * 60000 }).pending, [], "older than 30 min");
    // a successful restart after the deferral settles it
    writeResult(60000, { ok: true });
    assert.deepEqual(drainGuard(home, { now }).pending, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("D2 guard R2 M1: a drain counts only after the LATEST deferral ended, not the chain's first start or mid-wait", async () => {
  const { drainGuard } = await import("../server/restart-coord.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-drain-m1-"));
  const at = (hhmm, s = 0) => `2026-11-12T${hhmm}:${String(s).padStart(2, "0")}.000Z`;
  const L = { team: "efi", lane: "godot", leadId: "rn-lead-godot", leadTitle: null, heldAgents: ["rn-a"], ask: "x" };
  const put = (start, end) => writeFileSync(path.join(home, `restart-${start.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: start, finishedAt: end, dryRun: false, ok: false, errors: [], deferred: { held: 1, heldAgents: ["rn-a"], running: 0, leads: [L], unresolved: [] } }));
  const drain = (ts) => { mkdirSync(path.join(home, "teams", "efi"), { recursive: true }); writeFileSync(path.join(home, "teams", "efi", "log.jsonl"), JSON.stringify({ ts, agent: "rn-lead-godot", lane: "godot", type: "metric", text: "restart-feedback: drained restart", refs: [] }) + "\n", { flag: "a" }); };
  try {
    put(at("10:00"), at("10:10"));
    drain(at("10:02")); // logged while deferral #1 was still waiting
    assert.deepEqual(drainGuard(home, { now: Date.parse(at("10:11")) }).pending.map((l) => l.leadId), ["rn-lead-godot"], "a mid-wait drain does not satisfy a deferral that ended later");
    drain(at("10:12"));
    assert.deepEqual(drainGuard(home, { now: Date.parse(at("10:12", 30)) }).pending, [], "drained after #1 ended: go");
    put(at("10:13"), at("10:15")); // retry #2 defers again on the same lead
    const g = drainGuard(home, { now: Date.parse(at("10:16")) });
    assert.deepEqual(g.pending.map((l) => l.leadId), ["rn-lead-godot"], "the 10:12 drain predates deferral #2: retry #3 is refused");
    assert.equal(g.since, at("10:15"));
    drain(at("10:15", 30));
    assert.deepEqual(drainGuard(home, { now: Date.parse(at("10:16")) }).pending, [], "drained after #2 ended: go");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("D2 guard R2 M2: a drain by the lane's CURRENT live lead counts (named lead handed off); a lane with no live lead is skipped and listed; no agent list fails closed", async () => {
  const { commandRestart } = await import("../cli/vs.mjs");
  const { drainGuard, drainGuardMessage } = await import("../server/restart-coord.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-drain-m2-"));
  const now = Date.parse("2026-11-12T10:20:00.000Z");
  const iso = (min) => new Date(now - min * 60000).toISOString();
  const L = (leadId, lane, held) => ({ team: "efi", lane, leadId, leadTitle: null, heldAgents: held, ask: "x" });
  writeFileSync(path.join(home, `restart-${iso(10).replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: iso(10), finishedAt: iso(9), dryRun: false, ok: false, errors: [],
    deferred: { held: 2, heldAgents: ["rn-a", "rn-b"], running: 0, leads: [L("rn-lead-old", "godot", ["rn-a"]), L("rn-lead-ui", "ui", ["rn-b"])], unresolved: [] } }));
  const drain = (agent, min) => { mkdirSync(path.join(home, "teams", "efi"), { recursive: true }); writeFileSync(path.join(home, "teams", "efi", "log.jsonl"), JSON.stringify({ ts: iso(min), agent, lane: "godot", type: "metric", text: "restart-feedback: drained restart", refs: [] }) + "\n", { flag: "a" }); };
  const agents = [
    { id: "rn-lead-old", status: "idle", title: "★ God2 · Godot", labels: { team: "efi", lane: "godot", role: "former-lead" } }, // handed off
    { id: "rn-lead-new", status: "idle", title: "★ God3 · Godot", labels: { team: "efi", lane: "godot", role: "lead", ord: "3" } },
    { id: "rn-godot-worker", status: "idle", labels: { team: "efi", lane: "godot", role: "worker" } },
    // lane ui: its named lead retired, nobody took the seat
  ];
  const guard = (o = {}) => drainGuard(home, { now, teams: EFI_TEAMS, agents, ...o });
  try {
    let g = guard();
    assert.deepEqual(g.pending.map((l) => l.leadId), ["rn-lead-old"], "godot pending until its current lead drains");
    assert.deepEqual(g.skipped.map((l) => `${l.lane}:${l.leadId}`), ["ui:rn-lead-ui"], "ui has no live lead any more: skipped");
    const msg = drainGuardMessage(g, now);
    assert.match(msg, /godot lead rn-lead-old \(now rn-lead-new\) \[holds rn-a\]/);
    assert.match(msg, /Skipped \(no live lead in the lane any more\): efi\/ui \(named lead rn-lead-ui, held rn-b\)/);
    assert.ok(!/ui lead rn-lead-ui \[/.test(msg), "a skipped lane is not listed as pending");
    // fail closed: no agent list (or an empty one) -> only the named leads count, nothing is skipped
    for (const a of [null, [], () => [], () => { throw new Error("runner down"); }]) {
      const f = guard({ agents: a });
      assert.deepEqual(f.pending.map((l) => l.leadId), ["rn-lead-old", "rn-lead-ui"]);
      assert.deepEqual(f.skipped, []);
    }
    drain("rn-godot-worker", 5);
    assert.deepEqual(guard().pending.map((l) => l.leadId), ["rn-lead-old"], "a worker's drain never counts");
    drain("rn-lead-new", 4);
    g = guard();
    assert.deepEqual(g.pending, [], "the lane's current lead drained: go");
    assert.deepEqual(g.skipped.map((l) => l.lane), ["ui"]);
    assert.deepEqual(guard({ agents: null }).pending.map((l) => l.leadId), ["rn-lead-old", "rn-lead-ui"], "without the agent list the successor's drain is not provable");
    // through vs restart: the runner list is read lazily from the restart's home; it proceeds and prints the skipped lane
    const out = [];
    const seenEnv = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    let code;
    try {
      code = await commandRestart({}, { spawnFn: () => 7, env: { VIBESQUAD_HOME: home }, teams: [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }] }], hasOwnerProof: () => true, now: () => now,
        listAgents: (env) => { seenEnv.push(env.VIBESQUAD_HOME); return agents; }, drainGuard: (h, o) => drainGuard(h, { ...o, teams: EFI_TEAMS }) });
    } finally { process.stdout.write = orig; }
    assert.equal(code, 0);
    assert.deepEqual(seenEnv, [home], "the agent list is read from the restart's own VibeSquad home");
    assert.ok(out.some((s) => /drain guard skipped \(no live lead in the lane any more\): efi\/ui/.test(s)), out.join(""));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("R2 L1: a blank VS_AGENT_ID never masks PASEO_AGENT_ID or VS_AGENT_TOKEN (owner proof, owner shell, restart caller, --kill-background)", async () => {
  const { assertKillBackgroundOwner, assertOwnerShell, ownerProofFromEnv, assertRestartCaller } = await import("../cli/vs.mjs");
  const { ensureLocalToken, localTokenPath } = await import("../server/local-token.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-l1-"));
  try {
    ensureLocalToken(localTokenPath(home));
    assert.equal(ownerProofFromEnv({ VIBESQUAD_HOME: home }), true, "control: the owner's shell has proof");
    assert.equal(ownerProofFromEnv({ VIBESQUAD_HOME: home, VS_AGENT_ID: " ", PASEO_AGENT_ID: "rn-abcdef123456" }), false);
    assert.throws(() => assertKillBackgroundOwner({ VS_AGENT_ID: " ", VS_AGENT_TOKEN: "t" }, () => true), /owner's per-run OK/);
    assert.throws(() => assertKillBackgroundOwner({ VS_AGENT_ID: " ", PASEO_AGENT_ID: "rn-abcdef123456" }, () => true), /owner's per-run OK/);
    assert.doesNotThrow(() => assertKillBackgroundOwner({ VS_AGENT_ID: " ", PASEO_AGENT_ID: "  " }, () => true), "all blank: the owner's shell");
    assert.throws(() => assertOwnerShell("vs pair", { VS_AGENT_ID: " ", PASEO_AGENT_ID: "rn-abcdef123456" }), /never runs from an agent shell \(VS_AGENT_ID=rn-abcdef123456\)/);
    const teams = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }] }];
    const verified = [];
    await assert.rejects(assertRestartCaller(null, teams, { VS_AGENT_ID: " ", PASEO_AGENT_ID: "rn-abcdef123456", VS_AGENT_TOKEN: "tok" }, {
      hasOwnerProof: () => true,
      verify: async (c) => { verified.push(c.id); return { id: "rn-abcdef123456", role: "worker", team: "vibesquad", lane: "bug-chaser" }; },
    }), /is a worker; restarting the runtime cuts every agent's turn/, "verified as the PASEO_AGENT_ID agent, not waved through as the owner");
    assert.deepEqual(verified, ["rn-abcdef123456"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("R2 L2: the WMI child restores VIBESQUAD_PORT from --port, and D3's vs log/send run with restartRuntime's env", async () => {
  const { applyLaunchEnv } = await import("../scripts/restart-runtime.mjs");
  const env = {};
  applyLaunchEnv(parseArgs(["--vs-home", "C:\\vsh", "--port", "4290"]), env);
  assert.deepEqual(env, { VIBESQUAD_HOME: "C:\\vsh", VIBESQUAD_PORT: "4290" });
  const bare = { VIBESQUAD_PORT: "4180" };
  applyLaunchEnv(parseArgs([]), bare);
  assert.deepEqual(bare, { VIBESQUAD_PORT: "4180" }, "no flags: env untouched");
  const w = await world({ running: [0], envExtra: { VIBESQUAD_PORT: "4290" } });
  try {
    mkdirSync(w.outDir, { recursive: true });
    const at = new Date(Date.now() - 5 * 60000).toISOString();
    writeFileSync(path.join(w.outDir, `restart-${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: at, finishedAt: at, ok: false, deferred: { held: 1, heldAgents: ["rn-a"], running: 0, leads: [{ team: "efi", lane: "godot", leadId: "rn-lead-godot", heldAgents: ["rn-a"] }], unresolved: [] } }));
    const envs = [];
    const r = await w.run({}, [], { runVs: (args, env) => { envs.push(env); return { ok: true }; } });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(envs.length, 2, "one log + one send");
    assert.ok(envs.every((e) => e && e.VIBESQUAD_HOME === w.outDir && e.VIBESQUAD_PORT === "4290"), JSON.stringify(envs.map((e) => e && { h: e.VIBESQUAD_HOME, p: e.VIBESQUAD_PORT })));
  } finally { await w.cleanup(); }
});

test("--kill-background needs the owner's per-run OK: an Overlord or any agent shell is refused; the owner's shell passes and overrides the drain guard", async () => {
  const { commandRestart, assertKillBackgroundOwner } = await import("../cli/vs.mjs");
  const teams = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }] }];
  const pending = () => ({ pending: [{ team: "efi", lane: "godot", leadId: "rn-l", leadTitle: null, heldAgents: ["rn-a"] }], deferral: { finishedAt: new Date().toISOString() } });
  const none = () => ({ pending: [] });
  const run = async (flags, opts) => {
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try { return await commandRestart(flags, { spawnFn: () => 9, teams, ...opts }); } finally { process.stdout.write = orig; }
  };
  const overlord = { identity: { role: "lead", lane: "vibesquad", team: { id: "vibesquad" } }, env: { VS_AGENT_ID: "rn-abcdef123456" } };
  assert.equal(await run({}, { ...overlord, hasOwnerProof: () => false, drainGuard: none }), 0, "the Overlord may restart");
  await assert.rejects(run({ killBackground: true }, { ...overlord, hasOwnerProof: () => false, drainGuard: none }), /--kill-background: needs the owner's per-run OK; only the owner's shell may pass it \(an Overlord may not\)/);
  await assert.rejects(run({ killBackground: true }, { ...overlord, hasOwnerProof: () => true, drainGuard: none }), /owner's per-run OK/, "an agent shell is never the owner, whatever the proof says");
  assert.equal(await run({ killBackground: true }, { env: {}, hasOwnerProof: () => true, drainGuard: pending }), 0, "owner's shell: allowed, and it overrides a pending drain");
  await assert.rejects(run({}, { env: {}, hasOwnerProof: () => true, drainGuard: pending }), /refused/, "without it the owner is guarded too");
  assert.doesNotThrow(() => assertKillBackgroundOwner({}, () => true));
  assert.throws(() => assertKillBackgroundOwner({}, () => false), /owner's per-run OK/);
  assert.throws(() => assertKillBackgroundOwner({ VS_AGENT_TOKEN: "t" }, () => true), /owner's per-run OK/);
});

test("D3 done broadcast: a successful restart after a deferral logs restart-feedback 'restart-done' per asked lane and sends each asked lead; then nothing more", async () => {
  const w = await world({ running: [0] });
  try {
    mkdirSync(w.outDir, { recursive: true });
    const old = (min) => new Date(Date.now() - min * 60000).toISOString();
    const put = (min, body) => writeFileSync(path.join(w.outDir, `restart-${old(min).replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: old(min), finishedAt: old(min), dryRun: false, ok: false, ...body }));
    const L = (leadId, lane, held) => ({ team: "efi", lane, leadId, leadTitle: null, heldAgents: held, ask: "x" });
    put(200, { ok: true });
    put(150, { deferred: { held: 1, heldAgents: ["rn-z"], running: 0, leads: [L("rn-lead-old", "old", ["rn-z"])], unresolved: [] } }); // before a success: settled
    put(100, { ok: true });
    put(40, { deferred: { held: 1, heldAgents: ["rn-a"], running: 0, leads: [L("rn-lead-godot", "godot", ["rn-a"])], unresolved: [] } });
    put(30, { errors: ["server start: not healthy"] }); // a failed non-deferred run keeps the asked leads holding
    put(20, { deferred: { held: 2, heldAgents: ["rn-a", "rn-b"], running: 0, leads: [L("rn-lead-godot", "godot", ["rn-a"]), L("rn-lead-ui", "ui", ["rn-b"])], unresolved: [] } });
    put(19, { dryRun: true, ok: true }); // a dry run is not a restart
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.doneBroadcast.leads, ["rn-lead-godot", "rn-lead-ui"], "every lead asked since the last successful restart, once each");
    assert.deepEqual(w.vsCalls.filter((c) => c[0] === "log"), [["log", "restart-feedback", "restart-done", "--team", "efi", "--lane", "godot"], ["log", "restart-feedback", "restart-done", "--team", "efi", "--lane", "ui"]]);
    const sends = w.vsCalls.filter((c) => c[0] === "send");
    assert.deepEqual(sends.map((c) => c[1]), ["rn-lead-godot", "rn-lead-ui"]);
    assert.ok(sends.every((c) => /^restart-done: the VS restart finished .*Lift your background-suite hold\.$/.test(c[2])), JSON.stringify(sends));
    assert.ok(r.steps.some((s) => s.step === "done broadcast"));
    assert.ok(r.doneBroadcast.sent.every((x) => x.ok) && r.doneBroadcast.logged.every((x) => x.ok));
    w.vsCalls.length = 0;
    const r2 = await w.run({});
    assert.equal(r2.ok, true);
    assert.equal(r2.doneBroadcast, undefined, "the next restart has nothing to announce");
    assert.deepEqual(w.vsCalls, []);
  } finally { await w.cleanup(); }
});

test("D3: a failed send is recorded, never turns a good restart into a failure", async () => {
  const w = await world({ running: [0] });
  try {
    mkdirSync(w.outDir, { recursive: true });
    const at = new Date(Date.now() - 5 * 60000).toISOString();
    writeFileSync(path.join(w.outDir, `restart-${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: at, finishedAt: at, ok: false, deferred: { held: 1, heldAgents: ["rn-a"], running: 0, leads: [{ team: "efi", lane: "godot", leadId: "rn-lead-godot", heldAgents: ["rn-a"] }], unresolved: [] } }));
    const r = await w.run({}, [], { runVs: (args) => (args[0] === "send" ? { ok: false, error: "server busy" } : { ok: true }) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.doneBroadcast.sent, [{ leadId: "rn-lead-godot", lane: "godot", ok: false, error: "server busy" }]);
  } finally { await w.cleanup(); }
});

// ideas 199/200: the post-start health wait outlasts a slow boot (runner resumes the cut agents) on a fake clock, no real sleeps.
function fakeClock() {
  const c = { t: 1_000_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; await new Promise((r) => setImmediate(r)); };
  return c;
}
/** httpCall that fails `matches` URLs until `delayMs` of fake time after the server was started (post-start window only). */
const gated = (w, clock, delayMs, matches) => { let armed = null; return (url, o) => { if (armed == null && w.spawned.length) armed = clock.t; return matches(url) && armed != null && clock.t < armed + delayMs ? Promise.reject(new Error("ECONNREFUSED")) : httpCall(url, o); }; };
const runnerHealth = (u) => u.endsWith("/health") && !u.includes("api/health");

test("slow runner start (/health up only ~80s after start): reports slow start (N s), then succeeds", async () => {
  const w = await world();
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const r = await w.run({}, [], { now: clock.now, sleep: clock.sleep, httpCall: gated(w, clock, 80_000, runnerHealth) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const slow = r.steps.filter((s) => /^runner slow start \(\d+ s\)$/.test(s.step));
    assert.ok(slow.length >= 1, "reported slow start while waiting");
    assert.ok(Math.max(...clock.sleeps) <= 5000 && clock.sleeps.some((m) => m > 500), "polls with backoff, capped at 5s");
  } finally { await w.cleanup(); }
});

test("runner never healthy: fails only after the --boot-timeout deadline, with the deadline in the message", async () => {
  const w = await world();
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const r = await w.run({ bootTimeoutSec: 120 }, [], { now: clock.now, sleep: clock.sleep, httpCall: gated(w, clock, Infinity, runnerHealth) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /runner start: no healthy runner after start \(120s\)/.test(e)), JSON.stringify(r.errors));
    assert.ok(clock.t - t0 >= 120_000, "waited the full window before failing");
  } finally { await w.cleanup(); }
});

test("runner process died during start: fails immediately, not after the deadline", async () => {
  const w = await world();
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const r = await w.run({ bootTimeoutSec: 120 }, [], {
      now: clock.now, sleep: async (ms) => { await clock.sleep(ms); if (clock.t > t0 + 5000 && w.runner()) w.alive.delete(w.runner().pid); },
      httpCall: gated(w, clock, Infinity, runnerHealth),
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /runner start: runner process \d+ died during start/.test(e)), JSON.stringify(r.errors));
    assert.ok(clock.t - t0 < 120_000, "did not wait out the deadline");
  } finally { await w.cleanup(); }
});

test("slow server start: server /api/health polled with the same window, slow start reported, no 90s cliff", async () => {
  const w = await world();
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const r = await w.run({}, [], { now: clock.now, sleep: clock.sleep, httpCall: gated(w, clock, 100_000, (u) => u.includes("api/health")) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.steps.some((s) => /^server slow start \(\d+ s\)$/.test(s.step)));
  } finally { await w.cleanup(); }
});

test("--boot-timeout / VS_RESTART_BOOT_TIMEOUT configure the window", () => {
  assert.equal(parseArgs([]).bootTimeoutSec, 120);
  assert.equal(parseArgs(["--boot-timeout", "200"]).bootTimeoutSec, 200);
  assert.throws(() => parseArgs(["--boot-timeout", "-1"]), /bad bootTimeoutSec/);
});

// review fixes (H1/M1/M2)
test("restartRuntime without bootTimeoutSec/runnerBootMs defaults to 120s (never NaN / forever)", async () => {
  const w = await world();
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const r = await w.run({ bootTimeoutSec: undefined }, [], { now: clock.now, sleep: clock.sleep, httpCall: gated(w, clock, Infinity, runnerHealth) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("no healthy runner after start (120s)")), JSON.stringify(r.errors));
    assert.ok(clock.t - t0 >= 120_000);
  } finally { await w.cleanup(); }
});

test("boot timeout parsing: blank/zero/negative/non-numeric env falls back to 120; flag must be a finite value > 0", () => {
  for (const v of [undefined, "", "  ", "0", "-5", "abc", "NaN"]) assert.equal(bootDefault(v), 120, JSON.stringify(v));
  assert.equal(bootDefault("45"), 45);
  const saved = process.env.VS_RESTART_BOOT_TIMEOUT;
  try {
    process.env.VS_RESTART_BOOT_TIMEOUT = "";
    assert.equal(parseArgs([]).bootTimeoutSec, 120);
    process.env.VS_RESTART_BOOT_TIMEOUT = "0";
    assert.equal(parseArgs([]).bootTimeoutSec, 120);
    process.env.VS_RESTART_BOOT_TIMEOUT = "30";
    assert.equal(parseArgs([]).bootTimeoutSec, 30);
  } finally { if (saved === undefined) delete process.env.VS_RESTART_BOOT_TIMEOUT; else process.env.VS_RESTART_BOOT_TIMEOUT = saved; }
  for (const v of ["0", "", "  ", "-1", "abc"]) assert.throws(() => parseArgs(["--boot-timeout", v]), /bad bootTimeoutSec/, JSON.stringify(v));
  assert.equal(parseArgs(["--boot-timeout", "0.5"]).bootTimeoutSec, 0.5);
});

for (const reuse of [false, true]) {
  test(`stale runner.json left by a tree-killed stray (${reuse ? "pid reused from the old runner" : "dead pid"}) is not adopted: the new runner is still found`, async () => {
    const w = await world({ treeKill: true });
    try {
      const oldPid = w.runner().pid;
      const clock = fakeClock();
      const killHard = (pid) => {
        w.deps.killHard(pid);
        if (pid !== oldPid) writeFileSync(path.join(w.home, "runner.json"), JSON.stringify({ port: 1, pid: reuse ? oldPid : 4242, startedAt: 1 })); // the server's kill leaves the stray's file behind
      };
      const r = await w.run({ bootTimeoutSec: 120 }, [], { now: clock.now, sleep: clock.sleep, killHard });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal(r.newHash, "new-hash");
    } finally { await w.cleanup(); }
  });
}

test("direct-started runner that dies before writing runner.json fails fast (its pid is checked)", async () => {
  const w = await world({ serverBootsRunner: false });
  try {
    const clock = fakeClock(); const t0 = clock.t;
    const spawnDetached = (cmd, args, o) => (args.some((a) => /serve.mjs/.test(a)) ? w.deps.spawnDetached(cmd, args, o) : 987654); // runner "starts" but its pid is dead and no runner.json appears
    const r = await w.run({ bootTimeoutSec: 120 }, [], { now: clock.now, sleep: clock.sleep, spawnDetached });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /runner start: runner process 987654 died during start/.test(e)), JSON.stringify(r.errors));
    assert.ok(clock.t - t0 < 120_000, "did not wait out the deadline");
  } finally { await w.cleanup(); }
});

// ---- Restart drain (ideas 198 + 186): the restart flow sets the runner drain before the idle wait and clears it after ----

test("drain: a restart sets the runner drain (TTL = wait + stop + margin) before waiting; success ends it with the stopped runner", async () => {
  const w = await world({ running: [1, 0] });
  try {
    const oldPid = w.runner().pid;
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const names = r.steps.map((s) => s.step);
    assert.ok(names.indexOf("drain set") > names.indexOf("marker touched") && names.indexOf("drain set") < names.indexOf("waiting for runner idle"), names.join(" | "));
    const set = w.drainCalls.filter((c) => c.method === "POST");
    assert.deepEqual(set.map((c) => c.pid), [oldPid], "set once, on the runner being restarted");
    assert.equal(set[0].body.ttlMs, (5 + 2 + 120) * 1000, "wait-timeout 5 + stop-timeout 2 + 120 s margin");
    assert.match(set[0].body.reason, /^vs restart pid \d+$/);
    assert.ok(names.includes("drain clear skipped"), "the drained runner was stopped: nothing left to clear");
    assert.equal(w.drainCalls.filter((c) => c.method === "DELETE" && c.pid !== oldPid).length, 0, "never touches the new runner");
    assert.equal(w.runner().drain ?? null, null, "the new runner is not draining");
  } finally { await w.cleanup(); }
});

test("drain: a deferral (failure) clears the drain on the runner it left up; a preflight refusal does too", async () => {
  const w = await world({ running: [0], held: [["rn-suite"]] });
  try {
    const r = await w.run({ waitTimeoutSec: 0.05 });
    assert.equal(r.ok, false);
    assert.ok(r.deferred);
    assert.deepEqual(w.drainCalls.map((c) => c.method), ["POST", "DELETE"]);
    assert.equal(w.runner().drain, null, "drain cleared on the still-running runner");
    const names = r.steps.map((s) => s.step);
    assert.ok(names.indexOf("drain cleared") > names.indexOf("deferred: background work still running"));
    assert.equal(r.steps.find((s) => s.step === "drain cleared").wasActive, true);
  } finally { await w.cleanup(); }
  const w2 = await world({ serveCmd: false });
  try {
    const r = await w2.run({});
    assert.equal(r.ok, false);
    assert.deepEqual(w2.drainCalls.map((c) => c.method), ["POST", "DELETE"]);
    assert.equal(w2.runner().drain, null);
  } finally { await w2.cleanup(); }
});

test("drain: a runner without /drain (404) or --no-wait never fails the restart; dry run sets nothing", async () => {
  const w = await world({ running: [0], supportsDrain: false });
  try {
    const r = await w.run({});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const ns = r.steps.find((s) => s.step === "drain not set");
    assert.equal(ns.status, 404);
    assert.match(ns.error, /predates \/drain/);
    assert.deepEqual(w.drainCalls.map((c) => c.method), ["POST"], "no clear for a drain never set");
  } finally { await w.cleanup(); }
  const w2 = await world({ running: [0] });
  try {
    const r = await w2.run({ wait: false });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(w2.drainCalls, [], "nothing to drain without a wait");
    const d = await w2.run({ dryRun: true });
    assert.ok(d.plan.steps.some((x) => /^drain: runner POST \/drain/.test(x)));
    assert.deepEqual(w2.drainCalls, []);
  } finally { await w2.cleanup(); }
});

test("drainTtlMs: wait + stop + 120 s, floored at 1 s, capped at the runner's 2 h ceiling", () => {
  assert.equal(drainTtlMs({ waitTimeoutSec: 600, stopTimeoutSec: 30 }), 750_000);
  assert.equal(drainTtlMs({ waitTimeoutSec: 0, stopTimeoutSec: 0 }), 120_000);
  assert.equal(drainTtlMs({ waitTimeoutSec: 99_999, stopTimeoutSec: 30 }), 2 * 3600_000);
});

// Real Runner + real runner HTTP server + the real restart flow's /drain calls against it (only the provider is fake).
test("drain end to end: the restart's POST/DELETE against a real runner server set and clear Runner.drainState and /health", async () => {
  const runner = new Runner({ dir: mkdtempSync(path.join(os.tmpdir(), "vs-rs-")), adapters: { claude: { canPark: true, start() { return { send() {}, cancel() {}, kill() {} }; } } } });
  const srv = createRunnerServer(runner, { token: "t0k", hash: "h" });
  const port = await listen(srv);
  try {
    const auth = { authorization: "Bearer t0k" };
    const set = await httpCall(`http://127.0.0.1:${port}/drain`, { method: "POST", headers: auth, body: { ttlMs: 60_000, reason: "vs restart pid 1" } });
    assert.equal(set.status, 200);
    assert.equal(runner.drainState().reason, "vs restart pid 1");
    const h = await httpCall(`http://127.0.0.1:${port}/health`, { headers: auth });
    assert.equal(h.body.drain.reason, "vs restart pid 1");
    assert.ok(h.body.drain.until > Date.now());
    const del = await httpCall(`http://127.0.0.1:${port}/drain`, { method: "DELETE", headers: auth });
    assert.deepEqual([del.status, del.body.cleared], [200, true]);
    assert.equal(runner.drainState(), null);
    assert.equal((await httpCall(`http://127.0.0.1:${port}/health`, { headers: auth })).body.drain, null);
  } finally { runner.shutdown(); await close(srv); }
});
