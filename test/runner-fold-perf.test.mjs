// Bug24 perf guard: the runner's boot pass folds EVERY event of EVERY agent log (~1.4M events, ~440 MB on a live home), and the
// R4-1 open-tool reducer (runner/open-tools.mjs) runs on each one. A per-event cost that grows with the log (a scan of the open set
// per event, a quadratic re-read) turns a ~10 s boot into minutes, so fold 50k synthetic events under a generous wall-clock bound:
// linear code takes tens of ms here, a quadratic regression takes far longer than the bound. Temp homes only.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { MAX_OPEN_TOOLS, applyToolEvent, oldestOpenTool } from "../runner/open-tools.mjs";

const N = 50_000;
const BOUND_MS = 2000; // generous: shared CI / a loaded dev box; the linear fold is ~20-50x under it

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-foldperf-")); tmpDirs.push(d); return d; };

// One long-lived agent: turns of tool call / output / result, a turn edge every ~600 events, and the worst case for the reducer
// in every turn: MAX_OPEN_TOOLS - 1 timestamp-less calls that never get a result (oldestOpenId walks past all of them).
function syntheticEvents(n) {
  const ev = [{ seq: 0, ts: 1_000, type: "created", provider: "claude", model: "m", cwd: "/x", meta: { title: "perf" } }];
  const push = (e) => ev.push({ seq: ev.length, ts: 1_000 + ev.length, ...e });
  let call = 0;
  while (ev.length < n - 4) {
    push({ type: "input", text: "go" });
    push({ type: "status", status: "running" });
    for (let i = 0; i < MAX_OPEN_TOOLS - 1 && ev.length < n - 4; i++) ev.push({ seq: ev.length, type: "tool", phase: "call", id: `nots-${call++}`, name: "Bash" });
    for (let i = 0; i < 180 && ev.length < n - 4; i++) {
      const id = `c-${call++}`;
      push({ type: "tool", phase: "call", id, name: "Read", input: { timeout: 60_000 } });
      push({ type: "text", text: "x".repeat(120) });
      push({ type: "tool", phase: "result", id });
    }
    if (ev.length < n - 4) { push({ type: "turn_done" }); push({ type: "status", status: "idle" }); }
  }
  push({ type: "input", text: "last" });
  push({ type: "status", status: "running" });
  push({ type: "tool", phase: "call", id: "final", name: "Grep" }); // the log ends mid-call: the fold must report it
  return ev;
}

test(`perf guard: the open-tool reducer folds ${N} events well under ${BOUND_MS} ms`, () => {
  const events = syntheticEvents(N);
  assert.ok(events.length >= N - 5, `fixture has ${events.length} events`);
  const open = new Map();
  let changes = 0;
  const t0 = performance.now();
  for (const e of events) if (applyToolEvent(open, e)) changes++;
  const ms = performance.now() - t0;
  assert.ok(ms < BOUND_MS, `applyToolEvent over ${events.length} events took ${Math.round(ms)} ms (bound ${BOUND_MS})`);
  assert.equal(oldestOpenTool(open)?.id, "final");
  assert.ok(changes > 2 * 180, `oldest changed ${changes} times`);
});

test(`perf guard: Runner._fold (the boot pass) over a ${N}-event log well under ${BOUND_MS} ms, open tool correct`, () => {
  const dir = path.join(tmp(), "agents");
  mkdirSync(dir, { recursive: true });
  const events = syntheticEvents(N);
  writeFileSync(path.join(dir, "rn-perf.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = new Runner({ dir, adapters: {}, maxLive: 4 });
  const t0 = performance.now();
  const st = r._fold("rn-perf");
  const ms = performance.now() - t0;
  assert.ok(ms < BOUND_MS, `_fold over ${events.length} events took ${Math.round(ms)} ms (bound ${BOUND_MS})`);
  assert.equal(st.status, "running");
  assert.deepEqual(st.rec.openTool, { id: "final", since: events.at(-1).ts, name: "Grep", timeoutMs: null });
  assert.equal(st.rec.lastSeq, events.length - 1);
});
