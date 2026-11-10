import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerBackend, readRunnerCwd, readRunnerCwdSync } from "../server/backend/index.mjs";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { startRunnerLifecycle, stopRunnerLifecycle } from "../server/backend/runner-lifecycle.mjs";
import { confineReq } from "../server/file-search.mjs";
import { _navRootsForTest, _runnerRosterReady, _resetLaneAgentsCache, _liveRunnerAgentsForTest, agentCwdFor, lookupAgentCwd } from "../server/vibesquad-api.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vs-rfix-")));
const vsHome = path.join(tmp, "vs");
const runnerHome = path.join(vsHome, "runner");
const dir = path.join(runnerHome, "agents");
fs.mkdirSync(dir, { recursive: true });
process.env.VIBESQUAD_HOME = vsHome;
const ev = (seq, type, o = {}) => JSON.stringify({ seq, ts: 1000 + seq, type, ...o }) + "\n";
const writeAgent = (id, cwd, extra = "") => fs.writeFileSync(path.join(dir, `${id}.jsonl`), ev(0, "created", { provider: "claude", cwd, meta: {} }) + ev(1, "status", { status: "idle" }) + extra);
const mkcwd = (n) => { const d = path.join(tmp, "wt", n); fs.mkdirSync(d, { recursive: true }); return d; };

test("H1: startRunnerLifecycle waits for the catch-up baseline before attaching hooks", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const runner = {
    enableCatchUp: () => gate.then(() => order.push("baseline")),
    subscribeEvents: () => () => {},
    attachHooks: async () => { order.push("attach"); return {}; },
    detachHooks() {},
  };
  const ready = startRunnerLifecycle({ runner, startWatcher: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [], "no attach while the baseline is pending");
  release();
  await ready;
  assert.deepEqual(order, ["baseline", "attach"]);
  await stopRunnerLifecycle();
});

test("H1: an event appended while the baseline runs is not folded into history (hwm bounded at start)", async () => {
  writeAgent("rn-live1", mkcwd("live1"));
  const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome }), rootDir: tmp, hooks: false });
  const p = backend.enableCatchUp();
  await new Promise((r) => setTimeout(r, 40)); // sizes are fixed within the first few ms; the rest of the scan can take seconds on a big roster
  fs.appendFileSync(path.join(dir, "rn-live1.jsonl"), ev(2, "status", { status: "running" }) + ev(3, "status", { status: "idle" })); // lands mid-baseline
  writeAgent("rn-late", mkcwd("late")); // created after the baseline began
  await p;
  assert.equal(backend.live.hwm.get("rn-live1"), 1, "seq 2/3 stay live events");
  assert.ok(!backend.live.hwm.has("rn-late"), "a log created after the start replays from seq 0");
});

test("H2/M1: a 403 on a worktree created after the last scan waits for a fresh scan and is allowed", async () => {
  _resetLaneAgentsCache();
  const base = path.join(tmp, "base");
  fs.mkdirSync(base, { recursive: true });
  const getter = _navRootsForTest(base, {});
  getter(false);
  await _runnerRosterReady(); // roster is warm (and has no new worktree)
  const slow = _runnerRosterReady(); // a scan listed the dir before the new agent existed
  const wt = mkcwd("brand-new");
  writeAgent("rn-new1", wt);
  const c = await confineReq(wt, getter, Date.now() + 10_000_000);
  assert.equal(c.error, undefined, "retry sees the new worktree");
  assert.equal(c.cwd, fs.realpathSync(wt));
  await slow;
});

test("M1: a reset invalidates a scan that was already in flight", async () => {
  _resetLaneAgentsCache();
  const base = path.join(tmp, "base2");
  fs.mkdirSync(base, { recursive: true });
  const getter = _navRootsForTest(base, {});
  const inflight = _runnerRosterReady();
  _resetLaneAgentsCache();
  await inflight;
  assert.equal(_liveRunnerAgentsForTest().length, 0, "stale scan did not repopulate after reset");
  assert.ok(getter);
});

test("L1: cwd comes from the first line only (async and sync), agentCwdFor / lookupAgentCwd use it", async () => {
  const wt = mkcwd("head");
  writeAgent("rn-head1", wt, ev(2, "output", { text: "x".repeat(200000) }));
  assert.equal(await readRunnerCwd("rn-head1"), wt);
  assert.equal(readRunnerCwdSync("rn-head1"), wt);
  assert.equal(await agentCwdFor("rn-head1", tmp), wt);
  assert.equal(lookupAgentCwd("rn-head1"), wt);
  assert.equal(await readRunnerCwd("rn-nope"), null);
});
