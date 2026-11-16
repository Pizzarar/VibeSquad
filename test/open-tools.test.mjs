// R4-1 option (a) (docs/UX_REVIEW_R4.md): the server reports each agent's oldest open tool call. Covers the pure reducer
// (runner/open-tools.mjs), the runner's own status fold, the backend's sync log fold (vs who), toAgent's payload fields, the live
// `tools` delta (incl. replay / reconnect / archive) and the client roster reducer that merges the delta.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_OPEN_TOOLS, applyToolEvent, clearsOpenTools, oldestOpenTool, toolTimeoutMs } from "../runner/open-tools.mjs";
import { Runner } from "../runner/runner.mjs";
import { RunnerBackend, openToolFields, readRunnerAgentSync, toAgent } from "../server/backend/runner-backend.mjs";
import { reduceRunnerRoster } from "../src/runnerBridge.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "vs-opentools-"));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout");
};
const call = (id, ts, extra = {}) => ({ type: "tool", phase: "call", id, name: "Bash", ts, ...extra });
const fold = (events) => { const open = new Map(); for (const e of events) applyToolEvent(open, e); return open; };

// ---- pure reducer -------------------------------------------------------------------------------------------------------------

test("reducer: a call opens, its claude result closes; oldest is the first still-open call", () => {
  const open = new Map();
  assert.equal(applyToolEvent(open, call("a", 100, { input: { timeout: 120000 } })), true, "opening changes the oldest");
  assert.equal(applyToolEvent(open, call("b", 200, { name: "Read" })), false, "a second call leaves the oldest alone");
  assert.deepEqual(oldestOpenTool(open), { id: "a", since: 100, name: "Bash", timeoutMs: 120000 });
  assert.equal(applyToolEvent(open, { type: "tool", phase: "result", id: "a" }), true);
  assert.deepEqual(oldestOpenTool(open), { id: "b", since: 200, name: "Read", timeoutMs: null });
  assert.equal(applyToolEvent(open, { type: "tool", phase: "result", id: "b" }), true);
  assert.equal(oldestOpenTool(open), null);
  assert.equal(applyToolEvent(open, { type: "tool", phase: "result", id: "zzz" }), false, "a stray result is a no-op");
});

test("reducer: ACP update closes only on a terminal status; isError closes; unnamed call reads 'tool'", () => {
  const open = fold([{ type: "tool", phase: "call", id: "x", ts: 5, name: "" }, { type: "tool", phase: "update", id: "x", status: "in_progress" }]);
  assert.deepEqual(oldestOpenTool(open), { id: "x", since: 5, name: "tool", timeoutMs: null });
  for (const status of ["completed", "failed", "cancelled", "canceled", "error"]) {
    const o = fold([call("x", 5), { type: "tool", phase: "update", id: "x", status }]);
    assert.equal(o.size, 0, `ACP ${status} closes`);
  }
  assert.equal(fold([call("x", 5), { type: "tool", phase: "result", id: "x", isError: true }]).size, 0);
  assert.equal(fold([call("x", 5), { type: "tool", phase: "update", id: "x", isError: true }]).size, 0);
});

test("reducer: turn end, error, cancel, agent idle / parked / queued / restart, exit, archive and created clear every open call", () => {
  const clears = [
    { type: "turn_done" }, { type: "error", message: "boom" }, { type: "cancel" }, { type: "exit", code: 0 }, { type: "archive" },
    { type: "unarchive" }, { type: "created" }, { type: "parked" },
    ...["idle", "parked", "queued", "starting", "resuming", "lost", "exited"].map((status) => ({ type: "status", status })),
  ];
  for (const e of clears) {
    const open = fold([call("a", 1), call("b", 2)]);
    assert.equal(clearsOpenTools(e), true, JSON.stringify(e));
    assert.equal(applyToolEvent(open, e), true, `${JSON.stringify(e)} reports a change`);
    assert.equal(open.size, 0, `${JSON.stringify(e)} clears`);
  }
  for (const e of [{ type: "status", status: "running" }, { type: "output", text: "x" }, { type: "usage" }, { type: "thought" }, { type: "input" }, { type: "permission", phase: "request" }]) {
    const open = fold([call("a", 1)]);
    assert.equal(applyToolEvent(open, e), false, `${JSON.stringify(e)} keeps the call`);
    assert.equal(open.size, 1);
  }
});

test("reducer: idempotent per call id (re-applied call keeps its first since) and bounded at MAX_OPEN_TOOLS", () => {
  const open = fold([call("a", 100), call("a", 999)]);
  assert.equal(open.size, 1);
  assert.equal(oldestOpenTool(open).since, 100);
  const many = fold(Array.from({ length: MAX_OPEN_TOOLS * 3 }, (_, i) => call(`t${i}`, i + 1)));
  assert.equal(many.size, MAX_OPEN_TOOLS, "a turn that loses its results stays bounded");
  assert.equal(oldestOpenTool(many).id, "t0");
  applyToolEvent(many, { type: "turn_done" });
  assert.equal(many.size, 0);
  // garbage in: no throw, no change
  for (const e of [null, undefined, 1, "x", { type: "tool" }, { type: "tool", phase: "call" }]) assert.equal(applyToolEvent(open, e), false);
});

test("reducer: tool timeout only from a positive finite number; oldest skips entries with no timestamp", () => {
  assert.equal(toolTimeoutMs({ input: { timeout: 600000 } }), 600000);
  for (const t of [0, -1, "600000", NaN, Infinity, null]) assert.equal(toolTimeoutMs({ input: { timeout: t } }), null, String(t));
  const open = fold([{ type: "tool", phase: "call", id: "nots", name: "A" }, call("b", 7)]);
  assert.equal(oldestOpenTool(open).id, "b");
});

// ---- payload: toAgent + sync fold -----------------------------------------------------------------------------------------------

test("toAgent: openTool fields are always present, null unless running with an open call", () => {
  const base = { id: "rn-1", provider: "claude", model: "m", cwd: ".", meta: { title: "T" }, createdAt: 1, updatedAt: 2 };
  const t = { id: "a", since: 1234, name: "Bash", timeoutMs: 120000 };
  assert.deepEqual(pick(toAgent({ ...base, status: "running", openTool: t })), { openToolSince: 1234, openToolName: "Bash", openToolTimeoutMs: 120000 });
  for (const status of ["idle", "parked", "lost", "exited", "queued"]) {
    assert.deepEqual(pick(toAgent({ ...base, status, openTool: t })), { openToolSince: null, openToolName: null, openToolTimeoutMs: null }, status);
  }
  assert.deepEqual(pick(toAgent({ ...base, status: "running" })), { openToolSince: null, openToolName: null, openToolTimeoutMs: null }, "no openTool = null, not missing");
  assert.deepEqual(openToolFields({ since: 5, name: "X", timeoutMs: null }), { openToolSince: 5, openToolName: "X", openToolTimeoutMs: null });
  assert.deepEqual(openToolFields({ since: null, name: "X" }), { openToolSince: null, openToolName: null, openToolTimeoutMs: null });
});
const pick = (a) => ({ openToolSince: a.openToolSince, openToolName: a.openToolName, openToolTimeoutMs: a.openToolTimeoutMs });

test("readRunnerAgentSync (vs who): same fold from the log; the turn ending clears it", () => {
  const home = tmp();
  mkdirSync(path.join(home, "agents"));
  const ev = (o, seq) => JSON.stringify({ seq, ts: 1000 + seq, ...o });
  const lines = [
    ev({ type: "created", provider: "claude", model: "m", cwd: ".", meta: { title: "W" } }, 1),
    ev({ type: "input", text: "go" }, 2),
    ev({ type: "status", status: "running" }, 3),
    ev({ type: "tool", phase: "call", id: "t1", name: "Bash", input: { timeout: 300000 } }, 4),
    ev({ type: "tool", phase: "call", id: "t2", name: "Read" }, 5),
    ev({ type: "tool", phase: "result", id: "t1" }, 6),
  ];
  writeFileSync(path.join(home, "agents", "rn-sync.jsonl"), lines.join("\n") + "\n");
  assert.deepEqual(pick(readRunnerAgentSync("rn-sync", { home, liveness: null })), { openToolSince: 1005, openToolName: "Read", openToolTimeoutMs: null });
  writeFileSync(path.join(home, "agents", "rn-sync.jsonl"), [...lines, ev({ type: "turn_done" }, 7), ev({ type: "status", status: "running" }, 8)].join("\n") + "\n");
  assert.deepEqual(pick(readRunnerAgentSync("rn-sync", { home, liveness: null })), { openToolSince: null, openToolName: null, openToolTimeoutMs: null });
});

// ---- runner's own status fold ---------------------------------------------------------------------------------------------------

function fakeAdapter() {
  const a = {
    start({ emit }) {
      a.emit = emit;
      return { send() { emit("status", { status: "running" }); }, cancel() {}, kill() {} };
    },
  };
  return a;
}

test("Runner.status: openTool follows call / result / turn end; idle and archive leave nothing", async () => {
  const adapter = fakeAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter } });
  const id = runner.create({ provider: "claude", cwd: process.cwd(), prompt: "hi", meta: { lane: "own" } });
  await until(() => runner.status(id)?.status === "running");
  assert.equal(runner.status(id).openTool, null);
  adapter.emit("tool", { phase: "call", id: "t1", name: "Bash", input: { timeout: 120000 } });
  const s1 = runner.status(id).openTool;
  assert.equal(s1.name, "Bash");
  assert.equal(s1.timeoutMs, 120000);
  assert.ok(Number.isFinite(s1.since));
  assert.deepEqual(pick(toAgent(runner.status(id))), { openToolSince: s1.since, openToolName: "Bash", openToolTimeoutMs: 120000 }, "summary payload carries the fields");
  adapter.emit("tool", { phase: "call", id: "t2", name: "Grep" });
  adapter.emit("tool", { phase: "result", id: "t1" });
  assert.equal(runner.status(id).openTool.name, "Grep");
  adapter.emit("turn_done", {});
  assert.equal(runner.status(id).openTool, null, "turn end clears a call whose result never came");
  adapter.emit("tool", { phase: "call", id: "t3", name: "Bash" });
  assert.equal(runner.status(id).openTool.name, "Bash");
  adapter.emit("status", { status: "idle" });
  assert.equal(runner.status(id).openTool, null, "idle clears");
  adapter.emit("status", { status: "running" });
  adapter.emit("tool", { phase: "call", id: "t4", name: "Bash" });
  runner.archive(id);
  assert.equal(runner.status(id)?.openTool ?? null, null, "archive clears");
  assert.equal(runner.folds.get(id)?.tools?.size ?? 0, 0, "no tracker left behind on archive");
});

// ---- live delta ---------------------------------------------------------------------------------------------------------------

function liveBackend(agentFor = () => ({ id: "rn-1", status: "running" })) {
  const backend = new RunnerBackend({ client: { stream: (h) => { queueMicrotask(() => h.onOpen()); return { close() {} }; } } });
  let fetches = 0;
  backend.listAgents = async () => [{ id: "rn-1", status: "running" }];
  backend.fetchAgent = async (id) => { fetches++; return { agent: { ...agentFor(id), id } }; };
  const evs = [];
  const off = backend.subscribeEvents((e) => evs.push(e));
  const feed = (event, id = "rn-1") => backend.enqueue((gen) => backend.handleLogEvent({ id, event }, gen));
  const tools = () => evs.filter((e) => e.kind === "tools");
  return { backend, evs, off, feed, tools, fetches: () => fetches };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test("live: a known agent's tool events go out as `tools` deltas only when the oldest open call changes", async () => {
  const L = liveBackend();
  await until(() => L.evs.some((e) => e.kind === "connected"));
  L.feed({ type: "turn_done", seq: 1, ts: 10 }); // a clearing event makes the agent's open set KNOWN
  L.feed({ type: "tool", phase: "call", id: "a", name: "Bash", input: { timeout: 60000 }, seq: 2, ts: 1000 });
  L.feed({ type: "tool", phase: "call", id: "b", name: "Read", seq: 3, ts: 2000 });
  L.feed({ type: "tool", phase: "result", id: "a", seq: 4, ts: 3000 });
  L.feed({ type: "tool", phase: "result", id: "b", seq: 5, ts: 4000 });
  await until(() => L.tools().length === 3);
  await settle();
  assert.deepEqual(L.tools().map(({ kind, agentId, openToolSince, openToolName, openToolTimeoutMs }) => ({ kind, agentId, openToolSince, openToolName, openToolTimeoutMs })), [
    { kind: "tools", agentId: "rn-1", openToolSince: 1000, openToolName: "Bash", openToolTimeoutMs: 60000 },
    { kind: "tools", agentId: "rn-1", openToolSince: 2000, openToolName: "Read", openToolTimeoutMs: null },
    { kind: "tools", agentId: "rn-1", openToolSince: null, openToolName: null, openToolTimeoutMs: null },
  ]);
  assert.equal(L.tools()[0].updatedAt, new Date(1000).toISOString(), "delta carries the event time as updatedAt");
  assert.equal(L.fetches(), 0, "known agents need no fetch per tool event");
  L.off();
});

test("live: an agent first seen mid-turn reads the runner's fold; a clearing event then makes it known", async () => {
  const L = liveBackend(() => ({ status: "running", openToolSince: 500, openToolName: "Bash", openToolTimeoutMs: null }));
  await until(() => L.evs.some((e) => e.kind === "connected"));
  L.feed({ type: "tool", phase: "call", id: "a", name: "Bash", seq: 1, ts: 1000 });
  await until(() => L.tools().length === 1);
  assert.equal(L.tools()[0].openToolSince, 500, "unknown agent: the runner's authoritative fold, not a guess from one event");
  assert.equal(L.fetches(), 1);
  L.feed({ type: "error", seq: 2, ts: 1100 });
  L.feed({ type: "tool", phase: "call", id: "c", name: "Edit", seq: 3, ts: 1200 });
  await until(() => L.tools().length === 2);
  assert.equal(L.tools()[1].openToolName, "Edit");
  assert.equal(L.fetches(), 1, "known from the error on: no more fetches");
  L.off();
});

test("live: a known open set that a roster event clears (idle) emits no delta (the agent upsert carries the fields); archive drops the tracker", async () => {
  const L = liveBackend(() => ({ status: "idle", openToolSince: null, openToolName: null, openToolTimeoutMs: null }));
  await until(() => L.evs.some((e) => e.kind === "connected"));
  L.feed({ type: "turn_done", seq: 1, ts: 1 });
  L.feed({ type: "tool", phase: "call", id: "a", name: "Bash", seq: 2, ts: 2 });
  await until(() => L.tools().length === 1);
  L.feed({ type: "status", status: "idle", seq: 3, ts: 3 });
  await until(() => L.evs.some((e) => e.kind === "agent" && e.agent.status === "idle"));
  await settle();
  assert.equal(L.tools().length, 1, "no extra tools delta for a roster event");
  assert.equal(L.evs.filter((e) => e.kind === "agent").at(-1).agent.openToolSince, null, "the upsert says no tool");
  assert.ok(L.backend.live.tools.has("rn-1"));
  L.feed({ type: "archive", seq: 4, ts: 4 });
  await until(() => !L.backend.live.tools.has("rn-1"));
  // many agents archived: nothing accumulates
  for (let i = 0; i < 50; i++) { L.feed({ type: "created", seq: 1, ts: 1 }, `rn-x${i}`); L.feed({ type: "archive", seq: 2, ts: 2 }, `rn-x${i}`); }
  await until(() => L.evs.filter((e) => e.kind === "timeline").length >= 104);
  await settle();
  assert.equal(L.backend.live.tools.size, 0, "archived agents leave no tracker behind");
  L.off();
});

test("live replay (catch-up hwm): a replayed seq is handled once, so tool calls never double-count; reconnect without replay forgets", async () => {
  const L = liveBackend();
  await until(() => L.evs.some((e) => e.kind === "connected"));
  L.backend.live.hwm = new Map(); // lifecycle mode: every seq handled at most once
  const evs = [
    { type: "turn_done", seq: 1, ts: 1 },
    { type: "tool", phase: "call", id: "a", name: "Bash", seq: 2, ts: 100 },
    { type: "tool", phase: "call", id: "b", name: "Read", seq: 3, ts: 200 },
  ];
  for (const e of evs) L.feed(e);
  for (const e of evs) L.feed(e); // replayed after a reconnect
  L.feed({ type: "tool", phase: "result", id: "a", seq: 4, ts: 300 });
  L.feed({ type: "tool", phase: "result", id: "a", seq: 4, ts: 300 }); // dup
  await until(() => L.tools().length >= 2);
  await settle();
  assert.deepEqual(L.tools().map((e) => e.openToolSince), [100, 200]);
  assert.equal(L.backend.live.tools.get("rn-1").size, 1);
  // non-lifecycle mode: a stream close drops every tracker (the gap's events are gone)
  L.backend.live.hwm = null;
  L.backend.live.stream?.close?.();
  L.off();
  assert.equal(L.backend.live.tools.size, 0, "last unsubscribe / close leaves no tracker");
});

// ---- client roster reducer ----------------------------------------------------------------------------------------------------

test("client reduceRunnerRoster: a `tools` delta merges the three fields and moves updatedAt forward only", () => {
  const a = { id: "rn-1", status: "running", updatedAt: new Date(5000).toISOString(), title: "W" };
  const roster = new Map([["rn-1", a]]);
  const next = reduceRunnerRoster(roster, { kind: "tools", agentId: "rn-1", openToolSince: 4000, openToolName: "Bash", openToolTimeoutMs: 60000, updatedAt: new Date(6000).toISOString() });
  assert.deepEqual(pick(next.get("rn-1")), { openToolSince: 4000, openToolName: "Bash", openToolTimeoutMs: 60000 });
  assert.equal(next.get("rn-1").updatedAt, new Date(6000).toISOString());
  assert.equal(next.get("rn-1").title, "W");
  const late = reduceRunnerRoster(next, { kind: "tools", agentId: "rn-1", openToolSince: null, openToolName: null, openToolTimeoutMs: null, updatedAt: new Date(1000).toISOString() });
  assert.equal(late.get("rn-1").openToolSince, null);
  assert.equal(late.get("rn-1").updatedAt, new Date(6000).toISOString(), "an older delta never moves updatedAt back");
  assert.equal(reduceRunnerRoster(roster, { kind: "tools", agentId: "nope", openToolSince: 1, openToolName: "x", openToolTimeoutMs: null }), null, "unknown agent: no change");
});
