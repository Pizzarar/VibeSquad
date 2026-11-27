// R10 (@per, docs/PLAN_PER_ROLES_LADDER_1125.md): agy-claude as a quota family on the antigravity-cli runner.
// Temp homes only: never reads or writes the host's ~/.vibesquad.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAcpAdapter, pickModel } from "../runner/adapters/acp.mjs";
import { Runner } from "../runner/runner.mjs";
import { RunnerBackend, capFamilyOf, capProviderOnUpstreamExit } from "../server/backend/runner-backend.mjs";
import { createRunnerHookHost } from "../server/backend/runner-hooks.mjs";
import { countArms } from "../server/exp6-arm.mjs";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { QUOTA_READING_MAX_AGE_MS, usageFromLimits } from "../server/limits-read.mjs";
import { AGY_CLAUDE_FAMILY, AGY_CLAUDE_MID_MODEL, AGY_CLAUDE_TOP_MODEL } from "../server/model-ids.mjs";
import {
  AGY_CLAUDE_FAILOVER_THRESHOLD,
  isProviderOverQuota,
  readCappedProviders,
  setProviderCapped,
} from "../server/provider-failover.mjs";
import { clearUsageCache, getUsage } from "../server/providers-catalog.mjs";
import { resolveRoute } from "../server/role-route.mjs";
import { isForeignModel } from "../server/route-override.mjs";
import { ROUTE_OVERRIDE_LABEL, cappedFamilies, roleSpawnProfile } from "../server/spawn-route.mjs";
import { deriveWfArm } from "../server/wf-label.mjs";
import { A, C, USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const ISOLATED_HOME = join(tmpdir(), `vs-r10-missing-${process.pid}-${Date.now()}`);
process.env.VIBESQUAD_HOME = ISOLATED_HOME;
process.env.VIBESQUAD_PROFILES_PATH = join(ISOLATED_HOME, "profiles.json");
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(ISOLATED_HOME, "capped-providers.json");
delete process.env.VIBESQUAD_TEAMS_FILE;

const CWD = "/projects/VibeSquad/.worktrees/r10-agy-claude-test";
const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
const NOW = Date.parse("2026-11-25T16:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const limitRow = (provider, usedPct, { window = "5h", ageMs = 2 * MIN, resetInMs = 3 * 3600_000, checkedAgeMs } = {}) => ({
  provider,
  window,
  usedPct,
  resetsAt: resetInMs === null ? null : iso(NOW + resetInMs),
  source: "provider",
  at: iso(NOW - ageMs),
  checkedAt: iso(NOW - (checkedAgeMs ?? ageMs)),
});

function withEnv(fn, profiles = USER_PROFILES) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-r10-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
      "utf8",
    );
    const profilesPath = join(vsHome, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles }), "utf8");
    const cappedProvidersPath = join(vsHome, "capped-providers.json");
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesPath;
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = cappedProvidersPath;
    try {
      await fn({ dir, vsHome, profilesPath, cappedProvidersPath });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(overrides = {}) {
  const before = new Map();
  const on = new Map();
  const server = {
    before: (name, fn) => (before.set(name, fn), () => before.delete(name)),
    on: (name, fn) => (on.set(name, fn), () => on.delete(name)),
  };
  const stop = createPlugin({
    startWatcher: false,
    cappedProviders: {},
    setLabels: async () => {},
    archiveAgent: async () => {},
    applyAgentSettings: async () => {},
    refuseAgent: async () => {},
    ...overrides,
  })(server);
  const spawn = async (config = {}, extra = {}) => {
    const req = { config: { cwd: CWD, ...config }, ...extra };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, spawn };
}

const LABELS = (profile, extra = {}) => ({ profile, team: "vibesquad", lane: "vibesquad", role: "worker", ...extra });
const OV = (provider, model) => ({
  [ROUTE_OVERRIDE_LABEL]: [provider && `provider=${provider}`, model && `model=${model}`].filter(Boolean).join(" "),
});
const landed = (out) => ({
  provider: out.config.provider,
  model: out.config.model,
  effort: out.config.thinkingOptionId,
  modeId: out.config.modeId,
});

// Case 1: fresh claude-gpt pool row under soft (<70%) -> agy-claude (normal -> sonnet-medium, tierA -> opus-high), vs.route has family=agy-claude.
// At 84% (<85% hard, >=70% soft), hard overQuota is still false (85% hard line unchanged), while non-interruptible spawns prefer claude under soft.
test(
  "R10-1: fresh claude-gpt pool row <70% routes Implement normal to agy-claude sonnet-medium and tierA to opus-high with family=agy-claude; 84% is under hard (85%)",
  withEnv(async () => {
    const u84 = usageFromLimits([limitRow("antigravity-cli/claude-gpt", 84)], { now: NOW });
    assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, u84).overQuota, false, "hard line stays at 85%");
    const u = usageFromLimits([limitRow("antigravity-cli/claude-gpt", 69)], { now: NOW });
    assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, u).overQuota, false);
    const h = harness({ usageProviders: u });
    try {
      const normal = await h.spawn({ provider: C }, { labels: LABELS("Implement") });
      assert.deepEqual(landed(normal), { provider: A, model: AGY_CLAUDE_MID_MODEL, effort: "medium", modeId: "accept-edits" });
      assert.match(normal.labels[ROUTE_LABEL], /\bfamily=agy-claude\b/);

      const tierA = await h.spawn({ provider: C }, { labels: LABELS("Implement", { stakes: "tierA-invariant" }) });
      assert.deepEqual(landed(tierA), { provider: A, model: AGY_CLAUDE_TOP_MODEL, effort: "high", modeId: "accept-edits" });
      assert.match(tierA.labels[ROUTE_LABEL], /\bfamily=agy-claude\b/);
    } finally {
      h.stop?.();
    }
  }),
);

// Case 2: pool >=85% (including exact boundary 85) -> direct claude with why=failover and family=claude.
test(
  "R10-2: claude-gpt pool >=85% (and boundary exactly 85%) fails over to direct claude with why=failover",
  withEnv(async () => {
    assert.equal(AGY_CLAUDE_FAILOVER_THRESHOLD, 85);
    for (const pct of [85, 92]) {
      const u = usageFromLimits([limitRow("antigravity-cli/claude-gpt", pct)], { now: NOW });
      assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, u).overQuota, true, `pct=${pct}`);
      const h = harness({ usageProviders: u });
      try {
        const out = await h.spawn({ provider: C }, { labels: LABELS("Implement") });
        assert.equal(out.config.provider, C, `pct=${pct}`);
        assert.equal(out.config.model, "claude-sonnet-5-5", `pct=${pct}`);
        assert.match(out.labels[ROUTE_LABEL], /\bfamily=claude\b/, `pct=${pct}`);
        assert.match(out.labels[ROUTE_LABEL], /\bwhy=failover\b/, `pct=${pct}`);
      } finally {
        h.stop?.();
      }
    }
  }),
);

// Case 3: claude-gpt pool 99% never caps Gemini; Gemini 99% never caps agy-claude.
test(
  "R10-3: claude-gpt 99% never caps Gemini spawns, and Gemini 99% never caps agy-claude",
  withEnv(async () => {
    const poolHot = usageFromLimits([limitRow("antigravity-cli/claude-gpt", 99)], { now: NOW });
    assert.equal(isProviderOverQuota(A, poolHot).overQuota, false);
    assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, poolHot).overQuota, true);
    const hPoolHot = harness({ usageProviders: poolHot });
    try {
      const rev = await hPoolHot.spawn({ provider: C }, { labels: LABELS("Review") });
      assert.equal(rev.config.provider, A);
      assert.equal(rev.config.model, "gemini-4-neon");
    } finally {
      hPoolHot.stop?.();
    }

    const geminiHot = usageFromLimits([limitRow(A, 99)], { now: NOW });
    assert.equal(isProviderOverQuota(A, geminiHot).overQuota, true);
    assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, geminiHot).overQuota, false);
    const hGemHot = harness({ usageProviders: geminiHot });
    try {
      const impl = await hGemHot.spawn({ provider: C }, { labels: LABELS("Implement") });
      assert.equal(impl.config.provider, A);
      assert.equal(impl.config.model, AGY_CLAUDE_MID_MODEL);
      assert.match(impl.labels[ROUTE_LABEL], /\bfamily=agy-claude\b/);
    } finally {
      hGemHot.stop?.();
    }
  }),
);

// Case 4: upstream quota exit on an agy-claude agent caps ONLY agy-claude (not antigravity-cli, not claude).
test(
  "R10-4: upstream quota exit on an agy-claude agent caps only agy-claude",
  withEnv(async ({ cappedProvidersPath }) => {
    const fam = capFamilyOf({ provider: A, model: AGY_CLAUDE_MID_MODEL });
    assert.equal(fam, AGY_CLAUDE_FAMILY);
    assert.equal(capFamilyOf({ provider: A, model: "gemini-4-neon" }), A);

    capProviderOnUpstreamExit(
      fam,
      { type: "exit", upstream: true, error: "HTTP 503 service unavailable" },
      {
        cap: (p, v, o) => setProviderCapped(p, v, { ...o, cappedProvidersPath }),
        readCaps: null,
        log() {},
      },
    );
    const caps = readCappedProviders({ cappedProvidersPath, useDiskCaps: true });
    assert.deepEqual(Object.keys(caps), [AGY_CLAUDE_FAMILY]);
    assert.equal(caps[A], undefined);
    assert.equal(caps[C], undefined);
  }),
);

// Case 5: Leads and Buddies stay direct claude even with the pool at 0%.
test(
  "R10-5: Leads and Buddies stay direct claude even with claude-gpt pool at 0%",
  withEnv(async () => {
    const u = usageFromLimits([limitRow("antigravity-cli/claude-gpt", 0)], { now: NOW });
    const caps = cappedFamilies(u);
    for (const roleKey of ["lead", "brainstorm"]) {
      const rp = roleSpawnProfile(roleKey, { caps });
      assert.equal(rp.profile.provider, C, roleKey);
      assert.equal(rp.route.provider, C, roleKey);
      assert.ok(!rp.route.walk.includes(AGY_CLAUDE_FAMILY), `${roleKey} walk must exclude agy-claude`);
    }
    const h = harness({ usageProviders: u });
    try {
      const lead = await h.spawn({ provider: C }, { labels: LABELS("lead", { role: "lead" }) });
      assert.equal(lead.config.provider, C);
      assert.doesNotMatch(lead.labels[ROUTE_LABEL], /family=agy-claude/);

      const buddy = await h.spawn({ provider: C }, { labels: LABELS("Brainstorm", { role: "brainstorm" }) });
      assert.equal(buddy.config.provider, C);
      assert.doesNotMatch(buddy.labels[ROUTE_LABEL], /family=agy-claude/);
    } finally {
      h.stop?.();
    }
  }),
);

// Case 6: explicit provider/model override is unchanged (including pinDirectClaude for explicit claude-opus-5-5).
test(
  "R10-6: explicit provider/model override and explicit caller claude-opus-5-5 (pinDirectClaude) stay unchanged",
  withEnv(async () => {
    const h = harness({ usageProviders: usageFromLimits([limitRow("antigravity-cli/claude-gpt", 0)], { now: NOW }) });
    try {
      // Explicit route override to direct claude + opus: unchanged, no family= label.
      const ov = await h.spawn({ provider: C }, { labels: LABELS("Implement", OV(C, "claude-opus-5-5")) });
      assert.equal(ov.config.provider, C);
      assert.equal(ov.config.model, "claude-opus-5-5");
      assert.doesNotMatch(ov.labels[ROUTE_LABEL], /\bfamily=/);

      // Explicit caller config model (pinDirectClaude): not spawn_worker-derived, pins direct claude.
      const pin = await h.spawn({ provider: C, model: "claude-opus-5-5", thinkingOptionId: "high" }, { labels: LABELS("Implement") });
      assert.equal(pin.config.provider, C);
      assert.equal(pin.config.model, "claude-opus-5-5");
      assert.equal(pin.config.thinkingOptionId, "high");

      // Explicit override of antigravity-cli + suffixed Claude id is not foreign and lands on agy-claude.
      assert.equal(isForeignModel(A, AGY_CLAUDE_TOP_MODEL), false);
      const agyOv = await h.spawn({ provider: C }, { labels: LABELS("Implement", OV(A, AGY_CLAUDE_TOP_MODEL)) });
      assert.equal(agyOv.config.provider, A);
      assert.equal(agyOv.config.model, AGY_CLAUDE_TOP_MODEL);
    } finally {
      h.stop?.();
    }
  }),
);

// Case 7: Sonnet arm on agy is labelled arm=sonnet (and wf=sonnet), and countArms counts it as sonnet.
test(
  "R10-7: Sonnet arm on agy is labelled vs.arm=sonnet / wf=sonnet and countArms counts it as sonnet",
  withEnv(async () => {
    assert.equal(deriveWfArm({ provider: A, model: AGY_CLAUDE_MID_MODEL }), "sonnet");
    assert.equal(deriveWfArm({ provider: A, model: AGY_CLAUDE_TOP_MODEL }), "opus");

    const h = harness({ usageProviders: usageFromLimits([limitRow("antigravity-cli/claude-gpt", 10)], { now: NOW }) });
    try {
      const out = await h.spawn({ provider: C }, { labels: LABELS("Implement", { "vs.arm": "sonnet" }) });
      assert.equal(out.config.provider, A);
      assert.equal(out.config.model, AGY_CLAUDE_MID_MODEL);
      assert.equal(out.labels["vs.arm"], "sonnet");
      assert.equal(out.labels.wf, "sonnet");
      assert.match(out.labels[ROUTE_LABEL], /\bfamily=agy-claude\b/);

      const counts = countArms([{ labels: out.labels }], { lane: "vibesquad" });
      assert.deepEqual(counts, { sonnet: 1, neon: 0, carbon: 0 });
    } finally {
      h.stop?.();
    }
  }),
);

// Case 8: cross-provider reviewer for agy-claude work is Gemini; catalog attributes agy-claude reviewer as claude-review.
test(
  "R10-8: cross-provider reviewer for agy-claude work is Gemini, and catalog providerFamily treats agy-claude as claude",
  withEnv(async ({ vsHome }) => {
    const h = harness({ usageProviders: usageFromLimits([limitRow("antigravity-cli/claude-gpt", 10)], { now: NOW }) });
    try {
      const rev = await h.spawn({ provider: C }, { labels: LABELS("Review") });
      assert.equal(rev.config.provider, A);
      assert.equal(rev.config.model, "gemini-4-neon");
      assert.doesNotMatch(rev.labels[ROUTE_LABEL], /family=agy-claude/);
    } finally {
      h.stop?.();
    }

    // Catalog attribution: an antigravity-cli reviewer running a Claude model is classified as claude-review, not gemini-review.
    clearUsageCache();
    const agentsDir = join(vsHome, "runner", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const T0 = Date.UTC(2026, 10, 25, 12);
    const writeAgent = (id, events) => writeFileSync(join(agentsDir, `${id}.jsonl`), events.map((e, seq) => JSON.stringify({ seq, ...e })).join("\n") + "\n");
    writeAgent("rn-impl-agy", [
      { ts: T0, type: "created", provider: A, model: AGY_CLAUDE_MID_MODEL, cwd: "/worktrees/unit-r10", meta: { lane: "perfection", role: "worker", profile: "Implement", stakes: "normal" } },
      { ts: T0 + 1000, type: "turn_done", costUsd: 0 },
    ]);
    writeAgent("rn-rev-agy-claude", [
      { ts: T0 + 2000, type: "created", provider: A, model: AGY_CLAUDE_MID_MODEL, cwd: "/worktrees/unit-r10", meta: { lane: "perfection", role: "worker", profile: "Review - Sonnet" } },
      { ts: T0 + 2500, type: "turn_done", costUsd: 0 },
    ]);
    const L = (hash, parents, ts, subj) => `${hash}\x1f${parents}\x1f${ts}\x1f${subj}`;
    const git = (args) => {
      if (args[0] === "rev-parse") return "m1\n";
      if (args[0] === "log") {
        return [
          L("m1", "a1 b1", String(Math.floor((T0 + 100_000) / 1000)), "Merge branch 'unit-r10' (@per)"),
          L("b1", "a1", String(Math.floor((T0 + 90_000) / 1000)), "feat (@per) review r1"),
          L("a1", "root", String(Math.floor(T0 / 1000)), "mainline"),
          L("root", "", "0", "init"),
        ].join("\n");
      }
      return "";
    };
    const u = getUsage({ home: vsHome, git, laneCodes: { per: "perfection" } });
    assert.equal(u.merged.units.find((x) => x.unit === "unit-r10")?.reviewerFamily, "claude-review");
  }),
);

// Case 9: stale pool row (>5h old or past resetsAt) is ignored, so agy-claude is used.
test(
  "R10-9: stale (>5h old) or rolled-over (past resetsAt) claude-gpt pool rows are ignored so agy-claude is used",
  withEnv(async () => {
    const staleAge = limitRow("antigravity-cli/claude-gpt", 100, { ageMs: QUOTA_READING_MAX_AGE_MS + MIN, resetInMs: 3600_000 });
    const pastReset = limitRow("antigravity-cli/claude-gpt", 100, { ageMs: 10 * MIN, resetInMs: -MIN });
    for (const [label, r] of [["stale-age", staleAge], ["past-resetsAt", pastReset]]) {
      const u = usageFromLimits([r], { now: NOW });
      assert.deepEqual(u, [], label);
      const h = harness({ usageProviders: u });
      try {
        const out = await h.spawn({ provider: C }, { labels: LABELS("Implement") });
        assert.equal(out.config.provider, A, label);
        assert.equal(out.config.model, AGY_CLAUDE_MID_MODEL, label);
        assert.match(out.labels[ROUTE_LABEL], /\bfamily=agy-claude\b/, label);
      } finally {
        h.stop?.();
      }
    }
  }),
);

// Case 10: runner/acp pickModel sets the exact suffixed id (claude-opus-5-5-high is not downgraded to -medium).
function fakeChild(onLine) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  child.push = (o) => child.stdout.write(JSON.stringify(o) + "\n");
  let buf = "";
  child.stdin.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) {
        try {
          onLine(JSON.parse(l), child);
        } catch {
          /* ignore non-json */
        }
      }
    }
  });
  return child;
}

test(
  "R10-10: runner/acp pickModel preserves exact suffixed claude-opus-5-5-high without downgrading to -medium",
  withEnv(async ({ dir }) => {
    const advertised = [
      { modelId: "claude-opus-5-5-low" },
      { modelId: "claude-opus-5-5-medium" },
      { modelId: "claude-opus-5-5-high" },
    ];
    // Bare id downgrades to -medium; exact suffixed id from the agy-claude ladder stays -high.
    assert.equal(pickModel("claude-opus-5-5", advertised), "claude-opus-5-5-medium");
    assert.equal(pickModel(AGY_CLAUDE_TOP_MODEL, advertised), "claude-opus-5-5-high");

    const h = harness({ usageProviders: [] });
    let routed;
    try {
      routed = await h.spawn({ provider: C }, { labels: LABELS("Implement", { stakes: "tierA-invariant" }) });
    } finally {
      h.stop?.();
    }
    assert.equal(routed.config.provider, A);
    assert.equal(routed.config.model, "claude-opus-5-5-high");

    const procs = [];
    const spawnImpl = () => {
      const proc = { calls: [] };
      procs.push(proc);
      return fakeChild((m, child) => {
        if (!m.method) return;
        proc.calls.push({ method: m.method, params: m.params });
        const reply = (result) => child.push({ jsonrpc: "2.0", id: m.id, result });
        const session = {
          sessionId: "S-r10",
          models: { currentModelId: "gemini-4-neon-medium", availableModels: advertised },
          modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }] },
        };
        if (m.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
        else if (m.method === "session/new") reply(session);
        else if (m.method === "session/prompt") reply({ stopReason: "end_turn" });
        else reply({});
      });
    };

    const adapter = createAcpAdapter({ spawnImpl, provider: A, mcp: false, resolved: { file: "/bin/fake", args: [] } });
    const runner = new Runner({ dir: join(dir, "runner"), adapters: { [A]: adapter }, parkGraceMs: 60_000 });
    const id = runner.create({ provider: routed.config.provider, model: routed.config.model, cwd: ".", prompt: "hi" });
    for (let i = 0; i < 12 && runner.status(id).status !== "idle"; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(runner.status(id).status, "idle");
    const setModel = procs[0].calls.find((c) => c.method === "session/set_model");
    assert.ok(setModel, "session/set_model must be sent");
    assert.equal(setModel.params.modelId, "claude-opus-5-5-high");
    runner.kill(id);
  }),
);

// Case 11: cheap/mechanical stays direct Haiku (never agy-claude, which has no cheap rung).
test(
  "R10-11: cheap/mechanical stays direct Haiku (never agy-claude)",
  withEnv(async () => {
    // Even uncapped, agy-claude is absent from the mechanical/cheap walk.
    const uncapped = resolveRoute({ role: "implement", stakes: "mechanical" });
    assert.ok(!uncapped.walk.includes(AGY_CLAUDE_FAMILY));

    // When Gemini Flash (antigravity-cli) is capped, the cheap tier walks to Claude -> direct Haiku (never agy-claude).
    const r = resolveRoute({ role: "implement", stakes: "mechanical", caps: [A] });
    assert.equal(r.provider, C);
    assert.equal(r.model, "claude-haiku-5-5");
    assert.ok(!r.walk.includes(AGY_CLAUDE_FAMILY));

    const h = harness({
      cappedProviders: { [A]: { capped: true } },
      usageProviders: usageFromLimits([limitRow("antigravity-cli/claude-gpt", 0)], { now: NOW }),
    });
    try {
      const out = await h.spawn({ provider: C }, { labels: LABELS("Implement", { stakes: "mechanical" }) });
      assert.equal(out.config.provider, C);
      assert.equal(out.config.model, "claude-haiku-5-5");
      assert.equal(out.config.thinkingOptionId, "low");
      assert.doesNotMatch(out.labels[ROUTE_LABEL], /family=agy-claude/);
    } finally {
      h.stop?.();
    }
  }),
);

// Case 12 (R10 review gap 1): RunnerBackend handleLogEvent (:1724) and capOnProviderError (:1734) call capFamilyOf(agent),
// so an agy-claude agent's upstream exit or provider error caps agy-claude only, never antigravity-cli (Gemini).
test(
  "R10-12: RunnerBackend handleLogEvent (:1724) and capOnProviderError (:1734) cap agy-claude, not antigravity-cli",
  withEnv(async ({ vsHome, cappedProvidersPath }) => {
    const agent = { id: "rn-agy-cap", provider: A, model: AGY_CLAUDE_MID_MODEL, cwd: CWD, status: "closed", labels: { role: "worker" } };
    const rc = { vs: vsHome, home: join(vsHome, "runner"), request: async () => { throw new Error("unused"); }, stream: () => ({ close() {} }) };
    const b = new RunnerBackend({ client: rc, buildPrefix: async () => "" });
    b.live.hwm = new Map();
    b.noteSeen = () => {};
    b.emitTimeline = () => {};
    b.refreshLaneWhosHere = async () => {};
    b.fetchAgent = async () => ({ agent });
    b.emitEvent = () => {};

    // Site 1: handleLogEvent exit (runner-backend.mjs:1724)
    await b.handleLogEvent({ id: agent.id, event: { seq: 1, ts: Date.now(), type: "exit", code: 1, upstream: true, error: "HTTP 503 service unavailable" } });
    const exitCaps = readCappedProviders({ cappedProvidersPath, useDiskCaps: true });
    assert.deepEqual(Object.keys(exitCaps), [AGY_CLAUDE_FAMILY], "handleLogEvent exit must cap agy-claude only");
    assert.equal(exitCaps[A], undefined);

    // Site 2: capOnProviderError (runner-backend.mjs:1734)
    writeFileSync(cappedProvidersPath, "{}", "utf8");
    await b.capOnProviderError(agent.id, { type: "error", ts: Date.now(), message: "exceeded your current quota" });
    const errCaps = readCappedProviders({ cappedProvidersPath, useDiskCaps: true });
    assert.deepEqual(Object.keys(errCaps), [AGY_CLAUDE_FAMILY], "capOnProviderError must cap agy-claude only");
    assert.equal(errCaps[A], undefined);
  }),
);

// Case 13 (R10 review gap 2): upstream-respawn (agent-duties.ts ~3266) derives fromFam via spawnFamily(provider, model),
// so a dead agy-claude worker hops off agy-claude onto direct claude instead of respawning back onto agy-claude.
test(
  "R10-13: upstream-respawn on an agy-claude worker hops off agy-claude to direct claude",
  withEnv(async () => {
    const dead = {
      id: "rn-agy-dead",
      title: "Per3 · agy task",
      cwd: CWD,
      provider: A,
      model: AGY_CLAUDE_MID_MODEL,
      status: "closed",
      archivedAt: null,
      labels: LABELS("Implement", { stakes: "normal" }),
    };
    const agents = new Map([[dead.id, dead]]);
    const created = [];
    const backend = {
      async getAgent(aid) {
        const a = agents.get(aid);
        if (!a) throw new Error(`no agent ${aid}`);
        return { ...a, labels: { ...a.labels } };
      },
      async fetchAgentTimeline() {
        return {
          entries: [
            { item: { type: "user_message", text: "implement the change" }, seqStart: 1, seqEnd: 1 },
            { item: { type: "error", message: "HTTP 503 service unavailable" }, seqStart: 2, seqEnd: 2 },
          ],
        };
      },
      async listAgents() { return [...agents.values()].map((a) => ({ ...a, labels: { ...a.labels } })); },
      async createAgent({ config, prompt, labels }) {
        const a = { id: `rn-new-${created.length + 1}`, provider: config.provider, model: config.model, prompt, labels: { ...labels } };
        created.push(a);
        agents.set(a.id, a);
        return a;
      },
      async sendAgentPrompt() { return { queued: false }; },
      async archiveAgent() {},
      async updateAgent(aid, { labels } = {}) {
        const a = agents.get(aid);
        if (a && labels) a.labels = { ...a.labels, ...labels };
      },
      async cancelAgent() {},
      async deleteHeartbeat() {},
    };
    const host = await createRunnerHookHost(backend, { startWatcher: false, deps: { cappedProviders: [], retryBaseMs: 30 }, pollMs: 20 });
    try {
      await host.emit("agent.upstream_exit", { agent: await backend.getAgent(dead.id), error: "HTTP 503 service unavailable", ts: Date.now() });
      assert.equal(created.length, 1, "one respawn created");
      assert.equal(created[0].provider, C, "hops off agy-claude onto direct claude, not back onto agy-claude");
      assert.equal(created[0].model, "claude-sonnet-5-5");
    } finally {
      host.dispose();
    }
  }),
);

// Case 14 (R10 review gap 3 + fu1): callerFamily fix (agent-duties.ts ~2497) treats a bare Claude id inherited by a Gemini
// spawn as foreign (callerFamily=antigravity-cli), not agy-claude, so Lead - Gemini keeps an explicit thinkingOptionId
// that differs from the tierA-invariant top-tier rung default ("high").
test(
  "R10-14: Lead - Gemini inheriting bare claude-opus-5-5 keeps explicit thinkingOptionId different from top-tier rung default",
  withEnv(async () => {
    const h = harness({ usageProviders: [] });
    try {
      const out = await h.spawn(
        { provider: A, model: "claude-opus-5-5", thinkingOptionId: "low" },
        { labels: LABELS("Lead - Gemini", { role: "lead", stakes: "tierA-invariant" }) },
      );
      assert.equal(out.config.provider, A);
      assert.equal(out.config.model, "gemini-4-neon");
      assert.equal(out.config.thinkingOptionId, "low", "caller effort 'low' kept instead of overwritten by tierA top rung 'high'");
    } finally {
      h.stop?.();
    }
  }),
);
