// R10 fu2 (@per): routing follow-ups after agy-claude landed (docs/PLAN_PER_ROLES_LADDER_1125.md).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGY_CLAUDE_MIN_CAP_TTL_MS, capProviderOnUpstreamExit } from "../server/backend/runner-backend.mjs";
import { armCapped, armCapKey, decideArm } from "../server/exp6-arm.mjs";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { QUOTA_WINDOW_MS, usageFromLimits } from "../server/limits-read.mjs";
import { AGY_CLAUDE_FAMILY } from "../server/model-ids.mjs";
import { resolveRoute } from "../server/role-route.mjs";

const NOW = Date.parse("2026-11-25T16:00:00.000Z");
const MIN = 60_000;
const upstreamExit = { type: "exit", upstream: true, error: "HTTP 503 service unavailable" };

// 1. Re-die loop: the agy pool is polled every 30 min; the fault cap must outlive that.
test("fu2-1: an agy-claude upstream exit caps for at least one pool poll interval (35 min), not 10", () => {
  const calls = [];
  const cap = (p, v, o) => (calls.push({ p, v, ...o }), { [AGY_CLAUDE_FAMILY]: { reason: o.reason, resetsAt: o.now + o.ttlMs } });
  const out = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, upstreamExit, { cap, readCaps: null, log() {}, now: NOW, pool: () => [] });
  assert.ok(out, "capped");
  assert.equal(AGY_CLAUDE_MIN_CAP_TTL_MS, 35 * MIN);
  assert.equal(calls[0].ttlMs, 35 * MIN);
  // other families keep the short 10 min TTL
  const other = capProviderOnUpstreamExit("claude", upstreamExit, { cap, readCaps: null, log() {}, now: NOW, pool: () => [] });
  assert.equal(other.ttlMs, 10 * MIN);
});

test("fu2-1b: the cap holds to the pool row's resetsAt while the pool still reads over the threshold", () => {
  const rows = [{ provider: "antigravity-cli/claude-gpt", window: "5h", usedPct: 97, resetsAt: new Date(NOW + 3 * 3600_000).toISOString(), source: "provider", at: new Date(NOW - 5 * MIN).toISOString(), checkedAt: new Date(NOW - 5 * MIN).toISOString() }];
  const cap = (p, v, o) => ({ [AGY_CLAUDE_FAMILY]: { reason: o.reason, resetsAt: o.now + o.ttlMs } });
  const out = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, upstreamExit, { cap, readCaps: null, log() {}, now: NOW, pool: () => usageFromLimits(rows, { now: NOW }) });
  assert.equal(out.ttlMs, 3 * 3600_000);
  // a pool row under the threshold gives no extension
  rows[0].usedPct = 40;
  const low = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, upstreamExit, { cap, readCaps: null, log() {}, now: NOW, pool: () => usageFromLimits(rows, { now: NOW }) });
  assert.equal(low.ttlMs, 35 * MIN);
});

test("fu2-1c (M1): a far-future resetsAt is clamped to the quota window length (weekly max for unknown windows)", () => {
  const cap = (p, v, o) => ({ [AGY_CLAUDE_FAMILY]: { reason: o.reason, resetsAt: o.now + o.ttlMs } });
  const farFuture = new Date(NOW + 365 * 24 * 3600_000).toISOString();
  for (const [window, expectedMax] of [["5h", QUOTA_WINDOW_MS["5h"]], ["weekly", QUOTA_WINDOW_MS.weekly], ["mystery", QUOTA_WINDOW_MS.weekly]]) {
    const rows = [{ provider: "antigravity-cli/claude-gpt", window, usedPct: 97, resetsAt: farFuture, source: "provider", at: new Date(NOW - 5 * MIN).toISOString(), checkedAt: new Date(NOW - 5 * MIN).toISOString() }];
    const out = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, upstreamExit, { cap, readCaps: null, log() {}, now: NOW, pool: () => usageFromLimits(rows, { now: NOW }) });
    assert.ok(out, `capped (${window})`);
    assert.equal(out.ttlMs, expectedMax, `clamped to window (${window})`);
  }
});

test("fu2-1d (L1): a replayed exit older than 35 min writes no cap even when the pool is >=85%", () => {
  let capCalls = 0;
  const cap = (p, v, o) => { capCalls++; return { [AGY_CLAUDE_FAMILY]: { reason: o.reason, resetsAt: o.now + o.ttlMs } }; };
  const rows = [{ provider: "antigravity-cli/claude-gpt", window: "5h", usedPct: 95, resetsAt: new Date(NOW + 3 * 3600_000).toISOString(), source: "provider", at: new Date(NOW - 5 * MIN).toISOString(), checkedAt: new Date(NOW - 5 * MIN).toISOString() }];
  const replayed = { ...upstreamExit, ts: NOW - 40 * MIN };
  const out = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, replayed, { cap, readCaps: null, log() {}, now: NOW, pool: () => usageFromLimits(rows, { now: NOW }) });
  assert.equal(out, null, "old replayed exit must not write a cap");
  assert.equal(capCalls, 0);
  // A live exit (5 min old, within 35 min) still gets the full now-relative pool hold (not reduced by ageMs).
  const live = { ...upstreamExit, ts: NOW - 5 * MIN };
  const liveOut = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, live, { cap, readCaps: null, log() {}, now: NOW, pool: () => usageFromLimits(rows, { now: NOW }) });
  assert.equal(liveOut.ttlMs, 3 * 3600_000);
});

// 2. The two-family rule applies only to the role-spawn (`Implement`) path; legacy `Implement - Sonnet` does not walk agy-claude.
test("fu2-2 (L3): role-spawn sonnet needs BOTH agy-claude and claude capped; legacy Implement - Sonnet caps on direct claude alone", async () => {
  // Role-spawn (`Implement` role): two-family rule
  assert.equal(armCapped("sonnet", { claude: { reason: "x" } }, { role: true }), false, "role: direct claude alone leaves agy-claude");
  assert.equal(armCapped("sonnet", { "agy-claude": { reason: "x" } }, { role: true }), false, "role: agy-claude alone leaves direct claude");
  assert.equal(armCapped("sonnet", { claude: {}, "agy-claude": {} }, { role: true }), true);
  assert.equal(armCapKey("sonnet", { claude: {}, "agy-claude": {} }, { role: true }), "claude");
  // Legacy `Implement - Sonnet`: direct claude alone caps it
  assert.equal(armCapped("sonnet", { claude: { reason: "x" } }), true, "legacy: direct claude alone caps sonnet");
  assert.equal(armCapKey("sonnet", { claude: { reason: "x" } }), "claude");
  assert.equal(armCapped("sonnet", { "agy-claude": { reason: "x" } }), false, "legacy: agy-claude alone does not cap direct claude");
  assert.equal(armCapped("neon", { "antigravity-cli": {} }), true, "other arms unchanged");
  // End-to-end decideArm for both paths with only direct claude capped
  const base = { stakes: "normal", lane: "perfection", team: "vibesquad", listAgents: async () => [], capProbe: async () => ({ claude: { reason: "cap" } }) };
  const rolePick = await decideArm({ ...base, profile: "Implement" });
  assert.equal(rolePick.arm, "sonnet", "role-spawn Implement still picks sonnet when only direct claude is capped");
  assert.equal(rolePick.reason, "alternation");
  const legacyPick = await decideArm({ ...base, profile: "Implement - Sonnet" });
  assert.equal(legacyPick.arm, "neon", "legacy Implement - Sonnet swaps to neon when direct claude is capped");
  assert.equal(legacyPick.reason, "capped:claude");
});

// 3. All capped: direct claude, not agy-claude.
test("fu2-3: all families capped falls back to direct claude, not agy-claude", () => {
  const r = resolveRoute({ role: "Implement", caps: ["antigravity-cli", "claude", AGY_CLAUDE_FAMILY, "opencode", "deepseek"] });
  assert.equal(r.walk[0], AGY_CLAUDE_FAMILY, "agy-claude leads the walk");
  assert.equal(r.provider, "claude");
  assert.ok(r.reasons.includes("all-capped"));
  assert.ok(r.model, "claude rung model");
  // not all capped: unchanged walk
  assert.equal(resolveRoute({ role: "Implement", caps: [] }).provider, AGY_CLAUDE_FAMILY);
});

// 4. Explicit model on a failover: metric and why agree.
test("fu2-4: explicit model/effort on a route that walked past capped agy-claude reads explicit+failover (why=failover)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-fu2-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const teamsFile = join(vsHome, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { VIBESQUAD_HOME: vsHome, VIBESQUAD_TEAMS_FILE: teamsFile, VIBESQUAD_PROFILES_PATH: join(vsHome, "profiles.json"), VIBESQUAD_CAPPED_PROVIDERS_PATH: join(vsHome, "capped.json") });
  const before = new Map();
  const stop = createPlugin({ startWatcher: false, cappedProviders: {}, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {},
    usageProviders: usageFromLimits([{ provider: "antigravity-cli/claude-gpt", window: "5h", usedPct: 90, resetsAt: new Date(NOW + 3 * 3600_000).toISOString(), source: "provider", at: new Date(NOW - MIN).toISOString(), checkedAt: new Date(NOW - MIN).toISOString() }], { now: NOW }) })({
    before: (n, f) => (before.set(n, f), () => {}), on: () => () => {} });
  try {
    const req = { config: { cwd: "/projects/VibeSquad/.worktrees/fu2", provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high" }, labels: { profile: "Implement", team: "vibesquad", lane: "vibesquad", role: "worker" } };
    const out = (await before.get("agent.create")({ request: req })) ?? req;
    const label = out.labels[ROUTE_LABEL];
    const why = /\bwhy=([a-z-]+)/.exec(label)?.[1];
    const reason = /\breason=(\S+)/.exec(label)?.[1];
    assert.equal(why, "failover", label);
    assert.equal(reason, "explicit+failover", `metric must agree with why: ${label}`);
  } finally {
    stop?.();
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});
