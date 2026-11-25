// idea-631: a worker whose turn ended while its own background shell still holds its park is waiting-bg, never a no-verdict done.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyItem } from "../server/watch-sets.mjs";
import { newFoldState, feedFoldLine, finishFold } from "../server/backend/runner-backend.mjs";
import { WORKER_PACK } from "../server/hooks/agent-duties.ts";

const T = Date.parse("2026-11-25T12:00:00.000Z");
const set = { createdAt: new Date(T - 3_600_000).toISOString(), stallMin: 20 };
const item = { kind: "agent", ref: "w1" };
const ctx = (o) => ({ now: T, startedAt: T - 3_600_000, agents: new Map([["w1", o]]), reports: new Map() });
const idle = { status: "idle", finalText: "The audit is still running, ending the turn", activeAt: T - 60_000, progressAtMs: T - 60_000 };

test("idle worker with a final message but a held background shell is waiting-bg, not done", () => {
  const r = classifyItem(item, set, ctx({ ...idle, bgHeld: true }));
  assert.equal(r.state, "waiting");
  assert.equal(r.phase, "waiting-bg");
});

test("without a hold the same final message is still a done report", () => {
  const r = classifyItem(item, set, ctx({ ...idle, bgHeld: false }));
  assert.equal(r.state, "done");
});

test("a hold older than the stall window stalls as bg-held (never an eternal wait)", () => {
  const since = new Date(T - 30 * 60_000).toISOString();
  const r = classifyItem({ ...item, phase: "waiting-bg", phaseSince: since }, set, ctx({ ...idle, bgHeld: true }));
  assert.equal(r.state, "stalled");
  assert.equal(r.reason, "bg-held");
});

test("a woken (running) worker is not waiting-bg", () => {
  const r = classifyItem(item, set, ctx({ status: "running", bgHeld: true, activeAt: T }));
  assert.notEqual(r.phase, "waiting-bg");
});

const fold = (events) => {
  const st = newFoldState();
  for (const e of events) feedFoldLine(st, JSON.stringify({ ts: T, ...e }));
  return finishFold("a1", st, "/nonexistent-home", {}, { alive: true, startedAt: 0 });
};
const base = [{ type: "created", provider: "claude", model: "m", cwd: "/x" }, { type: "status", status: "running" }, { type: "status", status: "idle" }];

test("fold: park-held after idle marks bgHeld; a new running status, park-forced, parked or exit clear it", () => {
  assert.equal(fold([...base, { type: "park-held", work: [{ pid: 1 }] }]).bgHeld, true);
  assert.equal(fold([...base, { type: "park-held" }, { type: "status", status: "running" }]).bgHeld, undefined);
  assert.equal(fold([...base, { type: "park-held" }, { type: "park-forced" }]).bgHeld, undefined);
  assert.equal(fold([...base, { type: "park-held" }, { type: "parked" }, { type: "status", status: "parked" }]).bgHeld, undefined);
  assert.equal(fold([...base, { type: "park-held" }, { type: "exit" }]).bgHeld, undefined);
});

test("worker duties forbid a background run and ending the turn on it", () => {
  assert.match(WORKER_PACK, /FOREGROUND/);
  assert.match(WORKER_PACK, /run_in_background/);
  assert.match(WORKER_PACK, /never end your turn while one is still running/);
});
