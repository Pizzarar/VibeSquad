import test from "node:test";
import assert from "node:assert/strict";
import { cohortValueText, COHORT_METRICS, deltaText, deltaTrend, floorSegments, lowCostCoverage, sortWorkflows, speedupText, tokText, usdText } from "../src/usageHelpers.ts";
import { bugInboxCards, inboxLaneBadge, isTriageCard, buildProfiles, buildRows, filterInbox, humanizeProfile, inboxBucket, inboxCounts, inboxFrom, laneSummary, profileSummary, workflowSummary, rolesSummary, efficiencySummary, usageOpenKey, dur, etaText, limitTooltip, providerLabel, successText, successTooltip, foldRoles, pctText, relTime, reviewBullets, sortProfiles, sortRows, splitBullets, stormText, usageReviewStatus, USAGE_REVIEW_INTERVALS, USAGE_REVIEW_LABELS, withUsageReview, workIdlePct } from "../src/usageHelpers.ts";

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

test("dur: human durations and missing fallback", () => {
  assert.equal(dur(42 * 60_000), "42m");
  assert.equal(dur(3.1 * 3600_000), "3.1h");
  assert.equal(dur(2 * 24 * 3600_000), "2.0d");
  assert.equal(dur(45_000), "45s");
  assert.equal(dur(null), "—");
  assert.equal(dur(undefined), "—");
  assert.equal(dur(-5), "—");
});

test("pctText / workIdlePct: fraction -> %, missing -> —", () => {
  assert.equal(pctText(0.625), "63%");
  assert.equal(pctText(0), "0%");
  assert.equal(pctText(null), "—");
  assert.equal(pctText(undefined), "—");
  assert.equal(workIdlePct(0.67), "67% / 33%");
  assert.equal(workIdlePct(0), "0% / 100%");
  assert.equal(workIdlePct(null), "—");
});

test("stormText: spawn burst vs zero-turn exits", () => {
  const burst = { lane: "usage", role: "worker", count: 3, windowMs: 60_000, firstAt: "x", lastAt: "y", zeroTurnExits: 0 };
  assert.equal(stormText(burst), "usage · worker · 3 spawns in 1m");
  assert.equal(stormText({ ...burst, role: "lead", windowMs: 300_000, zeroTurnExits: 3 }), "usage · lead · 3 zero-turn exits");
});

const v2data = {
  limits: [],
  lanes: [
    { lane: "a", ...st(10, 5, 900, 100), agents: 2, restarts: 1, handoffs: 0, coordinationShare: 0.25, workPct: 0.625, avgUnitCycleMs: 60_000, planCycleMs: 120_000, fixAfterMergeRate: 0.2 },
    { lane: "b", ...st(4, 9, 400, 0), agents: 1, restarts: 0, handoffs: 2, coordinationShare: 0.5 },
    { lane: "c", ...st(2, 1, 50, 50), agents: 1, restarts: 0, handoffs: 0, coordinationShare: 0, workPct: 0, avgUnitCycleMs: null, planCycleMs: null, fixAfterMergeRate: 0 },
  ],
  byRole: [],
  merged: { perLane: [
    { lane: "a", mergedUnits: 2, reviewRounds: 5, avgReviewRounds: 2.5, costPerMergedUnit: 2.5, avgUnitCycleMs: 60_000, fixAfterMergeRate: 0.2 },
    { lane: "b", mergedUnits: 1, reviewRounds: 2, avgReviewRounds: 2, costPerMergedUnit: 9, avgUnitCycleMs: 90_000, fixAfterMergeRate: 0.5 },
  ] },
  loops: { threshold: 40, flagged: [] },
};

test("buildRows: v2 columns fall back to merged.perLane when the lane lacks them", () => {
  const rows = buildRows(v2data);
  const a = rows.find((r) => r.lane === "a");
  assert.equal(a.workPct, 0.625);
  assert.equal(a.unitCycleMs, 60_000);
  assert.equal(a.planCycleMs, 120_000);
  assert.equal(a.fixRate, 0.2);
  const b = rows.find((r) => r.lane === "b");
  assert.equal(b.workPct, null, "no workPct on lane, none in perLane");
  assert.equal(b.unitCycleMs, 90_000, "falls back to perLane.avgUnitCycleMs");
  assert.equal(b.planCycleMs, null, "plan cycle has no perLane fallback");
  assert.equal(b.fixRate, 0.5, "falls back to perLane.fixAfterMergeRate");
  const c = rows.find((r) => r.lane === "c");
  assert.equal(c.workPct, 0, "explicit zero work is preserved");
  assert.equal(c.fixRate, 0, "explicit zero fix rate is preserved (not null)");
});

test("sortRows: v2 keys workPct/cycle/fixRate sort with nulls last", () => {
  const rows = buildRows(v2data);
  assert.deepEqual(sortRows(rows, "workPct", -1).map((r) => r.lane), ["a", "c", "b"]);
  assert.deepEqual(sortRows(rows, "cycle", -1).map((r) => r.lane), ["b", "a", "c"]);
  assert.deepEqual(sortRows(rows, "fixRate", -1).map((r) => r.lane), ["b", "a", "c"]);
});

test("buildProfiles + sortProfiles: implementers first by mergedUnits desc, work% normalised", () => {
  const d = {
    limits: [], lanes: [], byRole: [],
    byProfile: [
      { provider: "claude", profile: "Lead", role: "lead", runs: 2, turns: 20, avgTurnsPerRun: 10, inputTokens: 1, outputTokens: 1, costUsd: 5, workingMs: 1000, idleMs: 1000, passCount: 2, passRate: 1, loopCount: 0, mergedUnits: 3, reviewRounds: 6, avgReviewRounds: 2, costPerMergedUnit: 1.5, fixAfterMergeCount: 0, fixAfterMergeRate: 0, avgUnitCycleMs: 1000 },
      { provider: "claude", profile: "Implement - Sonnet", role: "worker", runs: 3, turns: 30, avgTurnsPerRun: 10, inputTokens: 1, outputTokens: 1, costUsd: 6, workingMs: 3000, idleMs: 1000, passCount: 3, passRate: 1, loopCount: 0, mergedUnits: 2, reviewRounds: 4, avgReviewRounds: 2, costPerMergedUnit: 3, fixAfterMergeCount: 1, fixAfterMergeRate: 0.5, avgUnitCycleMs: 2000 },
      { provider: "antigravity-cli", profile: "Implement - Gemini", role: "worker", runs: 1, turns: 10, avgTurnsPerRun: 10, inputTokens: 1, outputTokens: 1, costUsd: 4, workingMs: 2000, idleMs: 2000, passCount: 1, passRate: 1, loopCount: 0, mergedUnits: 5, reviewRounds: 10, avgReviewRounds: 2, costPerMergedUnit: 0.8, fixAfterMergeCount: 0, fixAfterMergeRate: 0, avgUnitCycleMs: 1000 },
    ],
  };
  const sorted = sortProfiles(buildProfiles(d));
  assert.deepEqual(sorted.map((p) => p.profile), ["Implement - Gemini", "Implement - Sonnet", "Lead"], "implementers first, then mergedUnits desc");
  const gemini = sorted[0];
  assert.equal(gemini.mergedUnits, 5);
  assert.equal(gemini.workPct, 0.5);
  assert.equal(gemini.fixRate, 0);
  const sonnet = sorted[1];
  assert.equal(sonnet.workPct, 0.75);
  assert.equal(sonnet.fixRate, 0.5);
});

// ---- usa-8: usage review section helpers

test("usageReviewStatus: off / waiting for new turns / never reviewed / last reviewed · next in / due", () => {
  const now = 1_000_000_000_000;
  const base = { interval: "1d", inFlight: false, last: null, nextAt: null, waitingForTurns: false, history: [] };
  assert.equal(usageReviewStatus({ ...base, interval: "off" }, now), "off");
  assert.equal(usageReviewStatus({ ...base, waitingForTurns: true }, now), "waiting for new turns");
  assert.equal(usageReviewStatus(base, now), "never reviewed");
  assert.equal(usageReviewStatus(null, now), "");
  const last = {
    at: new Date(now - 90 * 60_000).toISOString(),
    trigger: "scheduled",
    interval: "1d",
    turnsAtRun: 5,
    opus: { ok: true, text: "a" },
    gemini: { ok: true, text: "b" },
  };
  const nextAt = new Date(now + 6 * 3600_000).toISOString();
  assert.equal(usageReviewStatus({ ...base, last, nextAt }, now), "last reviewed 1h 30m ago · next in 6.0h");
  assert.equal(usageReviewStatus({ ...base, last, nextAt: new Date(now - 1000).toISOString() }, now), "last reviewed 1h 30m ago · due");
});

test("splitBullets: strips -/*/• markers and numbered lines, drops blanks", () => {
  assert.deepEqual(splitBullets("- routing tip\n- handoff idea\n\n* tool friction\n3. cycle time"), ["routing tip", "handoff idea", "tool friction", "cycle time"]);
  assert.deepEqual(splitBullets("  1) first\n2) second"), ["first", "second"]);
  assert.deepEqual(splitBullets(null), []);
  assert.deepEqual(splitBullets(""), []);
});

test("reviewBullets: empty / error / ok states", () => {
  assert.deepEqual(reviewBullets(null), []);
  assert.deepEqual(reviewBullets(undefined), []);
  assert.deepEqual(reviewBullets({ ok: false, error: "boom" }), ["error: boom"]);
  assert.deepEqual(reviewBullets({ ok: false }), ["error: review failed"]);
  assert.deepEqual(reviewBullets({ ok: true, text: "- a\n- b" }), ["a", "b"]);
});

test("USAGE_REVIEW_INTERVALS / LABELS: the 7 options in select order", () => {
  assert.deepEqual([...USAGE_REVIEW_INTERVALS], ["off", "6h", "12h", "1d", "3d", "5d", "2w"]);
  assert.equal(USAGE_REVIEW_LABELS.off, "Off");
  assert.equal(USAGE_REVIEW_LABELS["6h"], "6h");
  assert.equal(USAGE_REVIEW_LABELS["2w"], "2w");
});

test("withUsageReview: merges review onto data, keeps other fields, no-op when absent", () => {
  const d = { limits: [], lanes: [], byRole: [], loops: { threshold: 40, flagged: [] } };
  const review = { interval: "6h", inFlight: true, last: null, nextAt: null, waitingForTurns: false, history: [] };
  const out = withUsageReview(d, review);
  assert.equal(out.usageReview, review);
  assert.equal(out.loops, d.loops);
  assert.equal(out.limits, d.limits);
  assert.equal(withUsageReview(d, null), d);
  assert.equal(withUsageReview(d, undefined), d);
});

test("deltaTrend: direction depends on metric polarity", () => {
  assert.deepEqual(deltaTrend(0.2, true), { dir: "up", trend: "good" });
  assert.deepEqual(deltaTrend(-0.2, true), { dir: "down", trend: "bad" });
  assert.deepEqual(deltaTrend(-1, false), { dir: "down", trend: "good" });
  assert.deepEqual(deltaTrend(1, false), { dir: "up", trend: "bad" });
  assert.deepEqual(deltaTrend(0, false), { dir: "flat", trend: "flat" });
  assert.deepEqual(deltaTrend(null, true), { dir: "none", trend: "none" });
  assert.deepEqual(deltaTrend(NaN, true), { dir: "none", trend: "none" });
  assert.equal(COHORT_METRICS.find((m) => m.key === "firstTryPassRate").higherIsBetter, true);
  assert.ok(COHORT_METRICS.filter((m) => m.key !== "firstTryPassRate").every((m) => !m.higherIsBetter));
});

test("deltaText / cohortValueText: arrows, units, em-dash for null", () => {
  assert.equal(deltaText("pct", 0.12), "▲ +12%");
  assert.equal(deltaText("usd", -0.4), "▼ -$0.40");
  assert.equal(deltaText("rounds", 0.5), "▲ +0.5");
  assert.equal(deltaText("dur", -3_600_000), "▼ -1.0h");
  assert.equal(deltaText("pct", null), "— no prior");
  assert.equal(deltaText("pct", 0), "• no change");
  assert.equal(cohortValueText("pct", 0.5), "50%");
  assert.equal(cohortValueText("rounds", 1.25), "1.3");
  assert.equal(cohortValueText("usd", null), "—");
  assert.equal(cohortValueText("dur", 90 * 60_000), "1.5h");
});

test("usdText / tokText / speedupText: raw floats, null -> em-dash", () => {
  assert.equal(usdText(null), "—");
  assert.equal(usdText(undefined), "—");
  assert.equal(usdText(0.0456), "$0.046");
  assert.equal(usdText(1.234), "$1.23");
  assert.equal(usdText(250.4), "$250");
  assert.equal(usdText(0), "$0.00");
  assert.equal(tokText(null), "—");
  assert.equal(tokText(1500), "1.5k");
  assert.equal(tokText(2_500_000), "2.5M");
  assert.equal(speedupText(1.84), "1.8x");
  assert.equal(speedupText(null), "—");
});

test("floorSegments: shares sum to 1, empty/missing handled", () => {
  const f = { cleanCostUsd: 6, cleanShare: 0.6, wasteShare: 0.4, cleanCostPerUnit: 1, cleanTokensPerUnit: 100, reworkCostUsd: 2, loopAndAbandonedCostUsd: 1, fixAfterMergeCostUsd: 1, restartOverheadCostUsd: 0 };
  const segs = floorSegments(f);
  assert.deepEqual(segs.map((s) => s.key), ["clean", "rework", "loops", "fixes", "restarts"]);
  assert.equal(segs[0].share, 0.6);
  assert.ok(Math.abs(segs.reduce((s, g) => s + g.share, 0) - 1) < 1e-9);
  assert.ok(floorSegments({ ...f, cleanCostUsd: 0, reworkCostUsd: 0, loopAndAbandonedCostUsd: 0, fixAfterMergeCostUsd: 0 }).every((s) => s.share === 0));
  assert.deepEqual(floorSegments(null), []);
});

test("lowCostCoverage / sortWorkflows", () => {
  assert.equal(lowCostCoverage(0.5), true);
  assert.equal(lowCostCoverage(0.8), false);
  assert.equal(lowCostCoverage(1), false);
  assert.equal(lowCostCoverage(undefined), false);
  const rows = [{ workflowMode: "b", units: 1 }, { workflowMode: "a", units: 1 }, { workflowMode: "z", units: 5 }];
  assert.deepEqual(sortWorkflows(rows).map((r) => r.workflowMode), ["z", "a", "b"]);
  assert.deepEqual(sortWorkflows(undefined), []);
});

test("humanizeProfile + buildProfiles fold raw agent_profile_* ids into one row", () => {
  const base = { provider: "claude", role: "worker", workingMs: 0, idleMs: 0, passRate: 1, avgReviewRounds: 2, costPerMergedUnit: 2, fixAfterMergeRate: 0 };
  const d = {
    limits: [], lanes: [], byRole: [],
    byProfile: [
      { ...base, profile: "agent_profile_aaa", runs: 1, turns: 10, mergedUnits: 1 },
      { ...base, profile: "agent_profile_bbb", runs: 3, turns: 20, mergedUnits: 3, costPerMergedUnit: 4 },
      { ...base, profile: "Implement - Sonnet", runs: 1, turns: 5, mergedUnits: 1 },
    ],
  };
  assert.equal(humanizeProfile("agent_profile_xyz"), "(unlabelled profile)");
  assert.equal(humanizeProfile("Lead"), "Lead");
  const rows = buildProfiles(d);
  assert.equal(rows.length, 2);
  const orphan = rows.find((r) => r.profile === "(unlabelled profile)");
  assert.equal(orphan.runs, 4);
  assert.equal(orphan.turns, 30);
  assert.equal(orphan.mergedUnits, 4);
  assert.equal(orphan.costPerMergedUnit, 3.5);
});

test("bug inbox helpers: lane filter, buckets, counts, source badges", () => {
  const mk = (id, status, extra = {}) => ({ id, text: id, title: id, teamId: "vibesquad", laneId: "bug-chaser", scope: "infra", status, createdAt: `2026-11-0${id.length}T00:00:00Z`, updatedAt: "", ...extra });
  const cards = [
    mk("a", "parked", { source: "usage-review:opus" }),
    mk("bb", "parked", { topicAgentId: "ag1", source: "usage-review:gemini" }),
    mk("ccc", "accepted"),
    mk("dddd", "rejected"),
    mk("eeeee", "archived"),
    mk("f", "handed-off"),
    { ...mk("x", "parked"), laneId: "other-lane" },
  ];
  const bug = bugInboxCards(cards);
  assert.equal(bug.length, 6, "other lanes excluded");
  assert.equal(isTriageCard({ laneId: "perfection" }), true);
  assert.equal(isTriageCard({ laneId: "ui-lab", source: "usage-review:opus" }), true, "usage-review source included from any lane");
  assert.equal(isTriageCard({ laneId: "ui-lab", source: "cli" }), false);
  assert.deepEqual(inboxLaneBadge("bug-chaser"), { key: "bug", label: "Bug" });
  assert.deepEqual(inboxLaneBadge("Perfection"), { key: "perfection", label: "Perfection" });
  assert.deepEqual(inboxCounts(bug), { all: 6, queue: 1, accepted: 3, closed: 2 });
  assert.equal(inboxBucket(cards[1]), "accepted", "topicAgentId counts as in flight");
  assert.deepEqual(filterInbox(bug, "closed").map((c) => c.id).sort(), ["dddd", "eeeee"]);
  assert.equal(filterInbox(bug, "all").length, 6);
  assert.deepEqual(inboxFrom({ source: "usage-review:opus", laneId: "bug-chaser" }), { key: "opus", label: "OPUS" });
  assert.deepEqual(inboxFrom({ source: "usage-review:gemini" }), { key: "gemini", label: "GEM" });
  assert.deepEqual(inboxFrom({ source: "cli", laneId: "bug-chaser" }), { key: "bug", label: "BUG" });
  assert.deepEqual(inboxFrom({ laneId: "perfection" }), { key: "perfection", label: "PERF" });
  assert.deepEqual(inboxFrom({ laneId: "ui-lab" }), { key: "other", label: "UI-LAB" });
});

test("collapsed-section rollup summaries", () => {
  assert.equal(laneSummary([{ costUsd: 1.5, merged: 2, looped: 1 }, { costUsd: 2, merged: 1 }]), "Lane breakdown · 2 lanes · $3.50 · 3 merged · 1 loop");
  assert.equal(profileSummary([{}]), "Implementer / Profile comparison · 1 profile");
  assert.equal(workflowSummary({ routingSavingsUsd: 120, parallelSpeedup: 2.5 }, 3), "Savings & Workflow Era · saved $120 vs Opus · 2.5x speedup · 3 modes");
  assert.equal(workflowSummary(null, 1), "Savings & Workflow Era · 1 mode");
  assert.equal(rolesSummary(0.25, 2, 0), "Roles, Loops & Storms · coord 25% / exec 75% · 2 loops · 0 storms");
  assert.equal(rolesSummary(null, 0, 1), "Roles, Loops & Storms · coord — / exec — · 0 loops · 1 storm");
  assert.equal(efficiencySummary({ recent: { firstTryPassRate: 0.8 } }, { cleanShare: 0.6, cleanCostPerUnit: 1.5 }), "Efficiency & Clean-Run Floor · 1st-try PASS 80% · clean 60% ($1.50/unit)");
  assert.equal(efficiencySummary(null, null), "Efficiency & Clean-Run Floor");
  assert.equal(usageOpenKey("roles"), "vs.usage.open.roles");
});


test("buildProfiles fold weights workPct by working+idle ms across 3 orphan rows", () => {
  const base = { provider: "claude", role: "worker", runs: 1, turns: 1, passRate: 1, avgReviewRounds: 0, costPerMergedUnit: null, mergedUnits: 0, fixAfterMergeRate: 0 };
  const d = { limits: [], lanes: [], byRole: [], byProfile: [
    { ...base, profile: "agent_profile_a", workingMs: 100, idleMs: 0 },
    { ...base, profile: "agent_profile_b", workingMs: 0, idleMs: 100 },
    { ...base, profile: "agent_profile_c", workingMs: 0, idleMs: 100 },
  ] };
  const rows = buildProfiles(d);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].workPct - 1 / 3) < 1e-9, "1/3 working, not pairwise-halved 0.25");
});

test("usa-14: providerLabel names the Antigravity 3rd-party pool; limitTooltip explains it and attributes agents", () => {
  assert.equal(providerLabel("antigravity-cli/claude-gpt"), "Gemini plan · 3rd-party models (Claude/GPT)");
  assert.equal(providerLabel("claude"), "Claude");
  assert.equal(limitTooltip({ provider: "claude" }), undefined);
  assert.match(limitTooltip({ provider: "antigravity-cli/claude-gpt" }), /built-in 3rd-party model pool.*separate from the Anthropic Claude subscription.*0 VibeSquad agents \(used outside VibeSquad\)/);
  assert.match(limitTooltip({ provider: "antigravity-cli/claude-gpt", poolAgents: { count: 2, agentIds: [], text: "2 VibeSquad agents" } }), /2 VibeSquad agents/);
});

test("usa-12 fix1: buildProfiles carries successRate/basis; no-signal renders — not 0%; old servers fall back to passRate", () => {
  const base = { provider: "claude", runs: 2, turns: 4, avgTurnsPerRun: 2, workingMs: 0, idleMs: 0, passRate: 0, avgReviewRounds: 0, costPerMergedUnit: null, mergedUnits: 0, fixAfterMergeRate: 0 };
  const d = { limits: [], lanes: [], byRole: [], byProfile: [
    { ...base, profile: "Lead - Claude", role: "lead", successRate: null, successBasis: "no-signal" },
    { ...base, profile: "Implement - Sonnet", role: "worker", mergedUnits: 4, successRate: 0.75, successBasis: "implementer-first-try-pass" },
    { ...base, profile: "Review - Old", role: "worker", passRate: 0.5 },
  ] };
  const by = Object.fromEntries(buildProfiles(d).map((p) => [p.profile, p]));
  assert.equal(by["Lead - Claude"].successRate, null);
  assert.equal(successText(by["Lead - Claude"]), "—");
  assert.match(successTooltip(by["Lead - Claude"]), /No reliable log signal/);
  assert.equal(successText(by["Implement - Sonnet"]), "75%");
  assert.match(successTooltip(by["Implement - Sonnet"]), /first try/);
  assert.equal(successText(by["Review - Old"]), "50%", "older server: passRate fallback");
});
