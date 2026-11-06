// Single owner: only the VS server's supervisor starts the runner; MCP / API / lane-routing / CLI paths only connect (RUNNER_DOWN).
// Temp runner home only; everything started here is killed in after().
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient, readDiscovery } from "../server/backend/runner-client.mjs";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";
import { RoutingBackend } from "../server/backend/lane-routing.mjs";
import { handleRunnerApi } from "../server/runner-api.mjs";
import { superviseRunner } from "../server/runner-supervisor.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const homes = [];
const stops = [];
const mkHome = () => { const h = mkdtempSync(path.join(os.tmpdir(), "vs-owner-")); homes.push(h); return h; };
const killPid = (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); } };

after(async () => {
  for (const s of stops) s();
  for (const h of homes) {
    const pid = readDiscovery(h)?.pid;
    if (pid) killPid(pid);
    try { killPid(JSON.parse(readFileSync(path.join(h, "runner.lock"), "utf8")).pid); } catch { /* none */ }
  }
  await new Promise((r) => setTimeout(r, 600));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function downBackend() {
  const spawns = [];
  const spawnImpl = (...a) => { spawns.push(a); throw new Error("must not spawn"); };
  const rc = new RunnerClient({ home: mkHome(), spawnImpl, startTimeoutMs: 100 });
  const backend = new RunnerBackend({ client: rc, buildPrefix: async () => "", hooks: false });
  return { backend, rc, spawns };
}

test("runner down: createAgent, connect and requireRunning are RUNNER_DOWN and spawn nothing", async () => {
  const { backend, rc, spawns } = downBackend();
  await assert.rejects(backend.createAgent({ config: { provider: "claude", cwd: "." }, prompt: "x" }), { code: "RUNNER_DOWN" });
  await assert.rejects(backend.connect(), { code: "RUNNER_DOWN" });
  await assert.rejects(rc.requireRunning(), /RUNNER_DOWN/);
  assert.equal(spawns.length, 0);
});

test("runner down: lane-routing ensureRunner is RUNNER_DOWN; with no runner lanes it is a no-op", async () => {
  const { backend, spawns } = downBackend();
  const routed = new RoutingBackend({}, backend, { lanes: () => new Set(["own"]) });
  await assert.rejects(routed.ensureRunner(), { code: "RUNNER_DOWN" });
  await new RoutingBackend({}, backend, { lanes: () => new Set() }).ensureRunner();
  assert.equal(spawns.length, 0);
});

test("runner down: the MCP tools path (runner id and lane spawn) is RUNNER_DOWN and spawns nothing", async () => {
  const { sharedRunnerBackend } = await import("../server/backend/index.mjs");
  const { createContext } = await import("../server/mcp/tools.mjs");
  const shared = sharedRunnerBackend();
  const { backend, spawns } = downBackend();
  const saved = { require: shared.requireRunning, start: shared.startOwned };
  shared.requireRunning = () => backend.requireRunning();
  shared.startOwned = () => { spawns.push("owned"); return Promise.resolve(true); };
  try {
    const env = { ...process.env, VS_DEFAULT_BACKEND: "runner", VS_BACKEND: "" };
    const ctx = createContext({ env, identity: { agentId: "rn-caller", team: "", lane: "", role: "" } });
    await assert.rejects(ctx.withBackend({ id: "rn-abc123" }, async () => "ran"), { code: "RUNNER_DOWN" });
    assert.equal(spawns.length, 0);
  } finally {
    shared.requireRunning = saved.require;
    shared.startOwned = saved.start;
    if (!saved.require) delete shared.requireRunning;
    if (!saved.start) delete shared.startOwned;
  }
});

test("runner down: the runner API spawn route answers 503 RUNNER_DOWN and the events route does not start it", async () => {
  const { backend, spawns } = downBackend();
  backend.startOwned = () => { spawns.push("owned"); return Promise.resolve(true); };
  const out = {};
  const sendJson = (_res, status, body) => { out.status = status; out.body = body; };
  const lanes = () => Object.assign(new Set(["own"]), { has: () => true });
  const req = { url: "/__vibesquad/runner/spawn", method: "POST" };
  await handleRunnerApi(req, {}, { readBody: async () => ({ labels: { lane: "own" }, config: { provider: "claude", cwd: "." } }), sendJson, backend, lanes });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /RUNNER_DOWN/);
  assert.equal(spawns.length, 0);
});

test("the supervisor starts the runner at boot and respawns it after a kill (temp home)", { timeout: 90000 }, async () => {
  const home = mkHome();
  const owner = new RunnerBackend({ client: new RunnerClient({ home, startTimeoutMs: 20000 }), buildPrefix: async () => "", hooks: false });
  const sup = superviseRunner(owner, { checkMs: 300, minBackoffMs: 200, maxBackoffMs: 1000 });
  stops.push(() => sup.stop());
  await sup.ready;
  const first = await until(() => readDiscovery(home)?.pid);
  assert.ok(await owner.rc.healthy(), "runner is up after boot");
  killPid(first);
  const second = await until(async () => { const d = readDiscovery(home); return d && d.pid !== first && (await owner.rc.healthy()) ? d.pid : 0; }, 40000);
  assert.notEqual(second, first, "a new runner replaced the killed one");
  sup.stop();
  killPid(second);
});

test("the supervisor backs off after failed starts and stops cleanly", async () => {
  const delays = [];
  let starts = 0;
  const owner = { rc: { healthy: async () => false }, startOwned: async () => { starts += 1; return false; } };
  const pending = [];
  const sup = superviseRunner(owner, { checkMs: 5000, minBackoffMs: 100, maxBackoffMs: 400, setTimer: (fn, ms) => { delays.push(ms); pending.push(fn); return { unref() {} }; }, clearTimer() {} });
  await sup.ready;
  for (let i = 0; i < 4; i++) await pending.shift()();
  assert.deepEqual(delays, [100, 200, 400, 400, 400]);
  assert.equal(starts, 5);
  sup.stop();
});

test("grep: startOwned is reachable only from the supervisor, the backend/client that define it, and tests", () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "dist", ".git", "test", "docs", "target"].includes(name)) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|ts|tsx|js)$/.test(name) && /startOwned|ensureRunning/.test(readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p).replaceAll("\\", "/"));
    }
  };
  for (const d of ["server", "cli", "plugin", "runner", "src"]) walk(path.join(ROOT, d));
  assert.deepEqual(hits.sort(), ["server/backend/runner-backend.mjs", "server/backend/runner-client.mjs", "server/runner-supervisor.mjs"]);
});
