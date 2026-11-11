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
import { parseArgs, restartRuntime } from "../scripts/restart-runtime.mjs";

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
    assert.equal(await status(cut), "idle", "a prompt-less resume settles to idle once the adapter is up (never `starting` forever: idea-109)");
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
async function world({ running = [0], held = null, supportsShutdown = true, serverBootsRunner = true, serveCmd = true, treeKill = false, strayAfterServerStop = false, swapRunnerOnFirstSleep = false, spoofAfterVerify = false, runnerRecycled = null, agentStatus = null, envExtra = {} } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vs-restart-"));
  const home = path.join(tmp, "runner");
  const configDir = path.join(tmp, "config");
  const outDir = path.join(tmp, "vs");
  mkdirSync(home, { recursive: true });
  const w = { tmp, home, configDir, outDir, calls: [], alive: new Set(), hardKills: [], spawned: [], markerSeenAtSpawn: [], pidSeq: 1000, shutdownAuth: [], serverInfoCalls: 0, allSrvs: [], runnerInfoCalls: 0, unwedgeBodies: [], spawnEnvs: [] };
  const agents = { current: [
    { id: "rn-old-lost", status: "lost" }, { id: "rn-busy", status: "running" }, { id: "rn-idle", status: "idle" },
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

  const deps = {
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
  const env = { ...process.env, VIBESQUAD_HOME: outDir, VIBESQUAD_DESKTOP_CONFIG_DIR: configDir, ...envExtra };
  w.opts = (extra = {}) => ({ ...parseArgs(["--stop-timeout", "2", "--wait-timeout", "5"]), home, port: serverPort, configDir, outDir, runtimeDir: tmp, node: process.execPath, ...extra });
  w.run = (extra, logs = []) => restartRuntime(w.opts(extra), deps, env, (l) => logs.push(l));
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
    try { return { code: await commandRestart(flags, { spawnFn: (exe, args) => { seen.push(args); return 4321; }, env: {}, teams, ...owner, ...opts }), seen, out: out.join("") }; } finally { process.stdout.write = orig; }
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
  await assert.rejects(assertRestartCaller(null, teams, { VIBESQUAD_HOME: ownerHome, VS_AGENT_ID: "rn-abcdef123456" }, () => null), /no runner record/, "an agent id is never the owner, whatever it can read");
  rmSync(ownerHome, { recursive: true, force: true });
  await assert.rejects(assertRestartCaller(as("worker", "bug-chaser"), teams, agentEnv), /only the owner or the Overlord/);
  await assert.rejects(assertRestartCaller(as("lead", "bug-chaser"), teams, agentEnv), /only the owner or the Overlord/, "a non-hub lead");
  await assert.rejects(assertRestartCaller(as("brainstorm", "vibesquad"), teams, agentEnv), /only the owner/);
  await assert.doesNotReject(assertRestartCaller(as("lead", "vibesquad"), teams, agentEnv), "hub lead = Overlord");
  // fail closed: an rn- id with no runner record is refused even if VS_ROLE/VS_LANE/VS_TEAM claim to be the Overlord
  const spoof = { VS_AGENT_ID: "rn-deadbeef0000", VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" };
  await assert.rejects(assertRestartCaller(null, teams, spoof, () => null), /no runner record/);
  await assert.rejects(run({}, { env: spoof, readRecord: () => null }), /no runner record/);
  const rec = (labels) => () => ({ labels });
  await assert.doesNotReject(assertRestartCaller(null, teams, spoof, rec({ role: "lead", team: "vibesquad", lane: "vibesquad" })), "the record, not env, decides (rollout fallback: no token)");
  await assert.rejects(assertRestartCaller(null, teams, spoof, rec({ role: "worker", team: "vibesquad", lane: "bug-chaser" })), /only the owner/, "env claiming lead is ignored when the record says worker");
  await assert.rejects(run({}, { identity: as("worker", "bug-chaser"), env: agentEnv }), /only the owner/);
  assert.equal((await run({}, { identity: as("lead", "vibesquad"), env: agentEnv })).code, 0);
  // X1b: with a token the runner decides (GET /verify-agent); the disk record is not consulted. A wrong token is 403.
  const tokenEnv = { ...spoof, VS_AGENT_TOKEN: "t0k" };
  const verifyOk = async ({ id, token }) => { assert.deepEqual([id, token], ["rn-deadbeef0000", "t0k"]); return { id, role: "lead", lane: "vibesquad", team: "vibesquad", overlord: true }; };
  const verify403 = async () => { throw Object.assign(new Error("agent token invalid"), { status: 403 }); };
  await assert.doesNotReject(assertRestartCaller(null, teams, tokenEnv, () => { throw new Error("disk record must not be read"); }, { verify: verifyOk }), "verified Overlord");
  await assert.rejects(assertRestartCaller(null, teams, tokenEnv, rec({ role: "lead", team: "vibesquad", lane: "vibesquad" }), { verify: verify403 }), /403/, "a wrong token is refused even when the disk record says Overlord");
  await assert.rejects(assertRestartCaller(null, teams, tokenEnv, () => null, { verify: async ({ id }) => ({ id, role: "worker", lane: "bug-chaser", team: "vibesquad" }) }), /only the owner/, "the runner's record decides the role");
  await assert.rejects(assertRestartCaller(null, teams, { ...spoof, VS_AGENT_TOKEN_REQUIRED: "1" }, rec({ role: "lead", team: "vibesquad", lane: "vibesquad" })), /403/, "flag on + no token: refused");
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
    assert.deepEqual(r.deferred, { held: 1, heldAgents: ["rn-suite"], running: 0 });
    assert.ok(r.errors.some((e) => /deferred: 1 agent\(s\) still hold background work .*rn-suite.*--kill-background/.test(e)), JSON.stringify(r.errors));
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
