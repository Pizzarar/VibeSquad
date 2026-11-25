// R10 fu2 (@per): routing follow-ups after agy-claude landed (docs/PLAN_PER_ROLES_LADDER_1125.md).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGY_CLAUDE_MIN_CAP_TTL_MS, capProviderOnUpstreamExit } from "../server/backend/runner-backend.mjs";
import { armCapped, armCapKey } from "../server/exp6-arm.mjs";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { usageFromLimits } from "../server/limits-read.mjs";
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

// 2. The sonnet arm lands on agy-claude first, then direct claude: capped only when both are.
test("fu2-2: sonnet arm is capped only when BOTH agy-claude and claude are capped", () => {
  assert.equal(armCapped("sonnet", { claude: { reason: "x" } }), false, "direct claude alone leaves agy-claude");
  assert.equal(armCapped("sonnet", { "agy-claude": { reason: "x" } }), false, "agy-claude alone leaves direct claude");
  assert.equal(armCapped("sonnet", { claude: {}, "agy-claude": {} }), true);
  assert.equal(armCapKey("sonnet", { claude: {}, "agy-claude": {} }), "claude");
  assert.equal(armCapped("neon", { "antigravity-cli": {} }), true, "other arms unchanged");
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
