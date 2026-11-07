import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, etaText, foldRoles, relTime, sortRows } from "../src/usageHelpers.ts";

const st = (turns, costUsd, i, o) => ({ turns, costUsd, inputTokens: i, outputTokens: o, avgTokensPerTurn: turns ? Math.round((i + o) / turns) : 0 });

test("relTime: future, past, units", () => {
  const now = 1_000_000_000_000;
  assert.equal(relTime(now + 5 * 60_000, now), "in 5m");
  assert.equal(relTime(now + 125 * 60_000, now), "in 2h 5m");
  assert.equal(relTime(now - 30 * 60_000, now), "30m ago");
  assert.equal(relTime(now + 3 * 86_400_000, now), "in 3d");
});

test("etaText: hits cap / won't cap / idle", () => {
  const base = { provider: "claude", window: "weekly", usedPct: 50, resetsAt: null, burnPctPerHour: 1, etaToCap: null };
  assert.match(etaText({ ...base, etaToCap: "2026-11-05T14:00:00.000Z" }), /^hits cap ~(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
  assert.equal(etaText(base), "won't cap before reset");
  assert.equal(etaText({ ...base, burnPctPerHour: 0 }), "idle · no burn");
});

const data = {
  limits: [],
  lanes: [
    { lane: "a", ...st(10, 5, 900, 100), agents: 2, restarts: 1, handoffs: 0, coordinationShare: 0.25 },
    { lane: "b", ...st(4, 9, 400, 0), agents: 1, restarts: 0, handoffs: 2, coordinationShare: 0.5 },
    { lane: "c", ...st(2, 1, 50, 50), agents: 1, restarts: 0, handoffs: 0, coordinationShare: 0 },
  ],
  byRole: [],
  merged: { perLane: [{ lane: "a", mergedUnits: 2, reviewRounds: 5, avgReviewRounds: 2.5, costPerMergedUnit: 2.5 }] },
  loops: { threshold: 40, flagged: [{ agentId: "x", lane: "b", role: "worker", turns: 50 }] },
};

test("buildRows: joins merged + loop flags, nulls when unmerged", () => {
  const rows = buildRows(data);
  const a = rows.find((r) => r.lane === "a");
  assert.equal(a.tokens, 1000);
  assert.equal(a.rounds, 2.5);
  assert.equal(a.costUnit, 2.5);
  assert.equal(a.merged, 2);
  assert.equal(rows.find((r) => r.lane === "b").looped, 1);
  assert.equal(rows.find((r) => r.lane === "c").rounds, null);
});

test("sortRows: numeric desc/asc, nulls last, lane tiebreak", () => {
  const rows = buildRows(data);
  assert.deepEqual(sortRows(rows, "costUsd", -1).map((r) => r.lane), ["b", "a", "c"]);
  assert.deepEqual(sortRows(rows, "tokens", 1).map((r) => r.lane), ["c", "b", "a"]);
  assert.deepEqual(sortRows(rows, "rounds", 1).map((r) => r.lane), ["a", "b", "c"]);
  assert.deepEqual(sortRows(rows, "rounds", -1).map((r) => r.lane), ["a", "b", "c"]);
  assert.deepEqual(sortRows(rows, "lane", -1).map((r) => r.lane), ["c", "b", "a"]);
});

test("foldRoles: former-brainstorm/lead fold into live roles, ordered brainstorm/lead/worker", () => {
  const out = foldRoles([
    { role: "worker", ...st(10, 3, 100, 0) },
    { role: "former-lead", ...st(2, 1, 40, 0) },
    { role: "lead", ...st(2, 2, 60, 0) },
    { role: "former-brainstorm", ...st(1, 1, 10, 0) },
  ]);
  assert.deepEqual(out.map((r) => r.role), ["brainstorm", "lead", "worker"]);
  const lead = out[1];
  assert.equal(lead.turns, 4);
  assert.equal(lead.costUsd, 3);
  assert.equal(lead.inputTokens, 100);
  assert.equal(lead.avgTokensPerTurn, 25);
});
