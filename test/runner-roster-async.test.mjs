import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerBackend, listRunnerAgents, listRunnerAgentsSync } from "../server/backend/index.mjs";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { _navRootsForTest, _liveRunnerAgentsForTest, _runnerRosterReady, _resetLaneAgentsCache } from "../server/vibesquad-api.mjs";

// D1a: 2000 synthetic runner logs must never hold the event loop (the desktop ping gives up at 1.8s).
const N = 2000;
const LAG_BUDGET_MS = 50;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-roster-"));
const vsHome = path.join(home, "vs");
const dir = path.join(vsHome, "runner", "agents");
fs.mkdirSync(dir, { recursive: true });
const cwds = [];
for (let i = 0; i < N; i++) {
  const cwd = path.join(home, "wt", `w${i}`);
  fs.mkdirSync(cwd, { recursive: true });
  cwds.push(cwd);
  const lines = [JSON.stringify({ seq: 0, ts: 1000, type: "created", provider: "claude", cwd, meta: { labels: { team: "t", lane: `l${i % 7}` } } })];
  for (let s = 1; s < 120; s++) lines.push(JSON.stringify({ seq: s, ts: 1000 + s, type: s % 2 ? "output" : "tool", text: "x".repeat(300) }));
  if (i % 10 === 0) lines.push(JSON.stringify({ seq: 120, ts: 2000, type: "archive" }));
  lines.push(JSON.stringify({ seq: 121, ts: 2001, type: "status", status: "idle" }));
  fs.writeFileSync(path.join(dir, `rn-${String(i).padStart(4, "0")}.jsonl`), lines.join("\n") + "\n");
}
process.env.VIBESQUAD_HOME = vsHome;

/** Max gap between 5ms timer ticks while `fn` runs = how long the loop was blocked. */
async function maxLag(fn) {
  let max = 0;
  let last = performance.now();
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 5); last = n; }, 5);
  try { await fn(); } finally { clearInterval(t); }
  return max;
}

test("before: the sync scan blocks the loop (reference timing)", () => {
  const t0 = performance.now();
  const all = listRunnerAgentsSync();
  const ms = performance.now() - t0;
  console.log(`listRunnerAgentsSync: ${all.length} agents blocked the loop for ${ms.toFixed(0)}ms`);
  assert.equal(all.length, N);
});

test("listRunnerAgents is async, equal to the sync scan, and never blocks the loop", async () => {
  let out;
  const lag = await maxLag(async () => { out = await listRunnerAgents(); });
  console.log(`listRunnerAgents: max loop lag ${lag.toFixed(1)}ms`);
  assert.deepEqual(out.sort((a, b) => (a.id < b.id ? -1 : 1)), listRunnerAgentsSync().sort((a, b) => (a.id < b.id ? -1 : 1)));
  assert.ok(lag < LAG_BUDGET_MS, `lag ${lag}`);
});

test("navRoots / liveRunnerAgents answer from cache without blocking, then include runner cwds", async () => {
  _resetLaneAgentsCache();
  const getRoots = _navRootsForTest(home, {});
  let first;
  const lag = await maxLag(async () => {
    first = getRoots(false); // sync call: must not scan
    _liveRunnerAgentsForTest();
    await _runnerRosterReady();
  });
  console.log(`navRoots+liveRunnerAgents: max loop lag ${lag.toFixed(1)}ms`);
  assert.ok(lag < LAG_BUDGET_MS, `lag ${lag}`);
  assert.ok(Array.isArray(first));
  const live = _liveRunnerAgentsForTest();
  assert.equal(live.length, N - N / 10, "archived agents are excluded");
  assert.ok(getRoots(false).includes(fs.realpathSync(cwds[1])));
  assert.ok(!getRoots(false).includes(fs.realpathSync(cwds[0])), "archived agent's cwd is not a root");
});

test("enableCatchUp baseline is async and complete", async () => {
  const backend = new RunnerBackend({ client: new RunnerClient({ home: path.join(vsHome, "runner") }), rootDir: home, hooks: false });
  let p;
  const lag = await maxLag(async () => { p = backend.enableCatchUp(); await p; });
  console.log(`enableCatchUp: max loop lag ${lag.toFixed(1)}ms`);
  assert.ok(lag < LAG_BUDGET_MS, `lag ${lag}`);
  assert.equal(backend.live.hwm.size, N);
  assert.equal(backend.live.archived.size, N / 10);
  assert.equal(backend.live.hwm.get("rn-0001"), 121);
});
