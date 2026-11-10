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

/** Fake machine: a stub runner + stub server, a fake process table, and deps for restartRuntime. */
async function world({ running = [0], supportsShutdown = true, serverBootsRunner = true, serveCmd = true } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vs-restart-"));
  const home = path.join(tmp, "runner");
  const configDir = path.join(tmp, "config");
  const outDir = path.join(tmp, "vs");
  mkdirSync(home, { recursive: true });
  const w = { tmp, home, configDir, outDir, calls: [], alive: new Set(), hardKills: [], spawned: [], markerSeenAtSpawn: [], pidSeq: 1000, shutdownAuth: [] };
  const agents = { current: [
    { id: "rn-old-lost", status: "lost" }, { id: "rn-busy", status: "running" }, { id: "rn-idle", status: "idle" },
  ] };
  let runnerSrv = null;
  let runnerState = null;
  const startRunner = async (hash) => {
    const token = `tok-${w.pidSeq}`;
    const pid = ++w.pidSeq;
    const polls = [...running];
    const st = { pid, token, hash, srv: null, dead: false };
    st.srv = http.createServer((req, res) => {
      const json = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
      const url = req.url.split("?")[0];
      if (url === "/health") return json(200, { ok: true, running: polls.length > 1 ? polls.shift() : polls[0], pid, hash });
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
    runnerState = st; runnerSrv = st.srv;
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
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    pidAlive: (pid) => w.alive.has(pid),
    procInfo: (pid) => (w.alive.has(pid) ? { pid, ppid: 1, cmd: pid === serverPid ? (serveCmd ? `"C:\\rt\\node.exe" server/serve.mjs` : "something-else.exe") : "node runner/server.mjs" } : null),
    listenerPid: () => (serverSrv?.listening ? serverPid : null),
    termGracefully: (pid) => { w.calls.push(`term ${pid}`); if (pid === serverPid) { w.alive.delete(pid); close(serverSrv); } },
    killHard: (pid) => {
      w.hardKills.push(pid); w.alive.delete(pid);
      if (pid === serverPid) close(serverSrv);
      if (runnerState?.pid === pid) { runnerState.dead = true; close(runnerSrv); }
    },
    spawnDetached: (cmd, args) => {
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
  const env = { ...process.env, VIBESQUAD_HOME: outDir, VIBESQUAD_DESKTOP_CONFIG_DIR: configDir };
  w.opts = (extra = {}) => ({ ...parseArgs(["--stop-timeout", "2", "--wait-timeout", "5"]), home, port: serverPort, configDir, outDir, runtimeDir: tmp, node: process.execPath, ...extra });
  w.run = (extra, logs = []) => restartRuntime(w.opts(extra), deps, env, (l) => logs.push(l));
  w.cleanup = async () => { for (const s of [runnerSrv, serverSrv]) if (s?.listening) await close(s); rmSync(tmp, { recursive: true, force: true }); };
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
    const order = ["marker touched", "waiting for runner idle", "runner idle", "snapshot before stop", "server stopped gracefully", "runner stopped gracefully", "server started", "server healthy", "verified", "resumed lost agents", "marker cleared"];
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
    assert.deepEqual(w.shutdownAuth, [], "runner untouched");
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

test("vs restart launches the script detached with its flags (and never runs it inline)", async () => {
  const { commandRestart } = await import("../cli/vs.mjs");
  const seen = [];
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  try { assert.equal(commandRestart({ timeout: "90", noForce: true }, { spawnFn: (exe, args) => { seen.push(args); return 4321; } }), 0); } finally { process.stdout.write = orig; }
  assert.equal(seen.length, 1);
  assert.ok(seen[0][0].split(path.sep).join("/").endsWith("scripts/restart-runtime.mjs"));
  assert.deepEqual(seen[0].slice(3), ["--no-force", "--wait-timeout", "90"]);
  assert.match(out.join(""), /restart launched \(pid 4321\)/);
});
