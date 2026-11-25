// G2 (idea-1012, docs/PLAN_PER_ROLES_LADDER_1125.md): spawn-time failover reads LIVE quota (runner/limits.jsonl, the
// usage panel's source) instead of only `vs cap`. Fresh >=95% fails over; 94%, stale, rolled-over (resetsAt passed) or a
// throwing source never do; `vs cap` still wins; the lead successor goes through the same failover and says so.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin, ROUTE_LABEL } from "../server/hooks/agent-duties.ts";
import { liveQuotaUsage, QUOTA_READING_MAX_AGE_MS, usageFromLimits } from "../server/limits-read.mjs";
import { isProviderOverQuota, resolveProfileWithFailover } from "../server/provider-failover.mjs";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";
import { createLeadHandoffCoordinator, resolveLeadProfile } from "../server/lead-handoff.mjs";
import { seedDefaultPack } from "../server/vibesquad-api.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const NOW = Date.parse("2026-11-25T13:50:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
/** A readLimits row (the shape readLimits returns). */
const row = (provider, usedPct, { window = "5h", ageMs = 2 * MIN, resetInMs = 3 * 3600_000, checkedAgeMs } = {}) => ({
  provider,
  window,
  usedPct,
  resetsAt: resetInMs === null ? null : iso(NOW + resetInMs),
  source: "provider",
  at: iso(NOW - ageMs),
  checkedAt: iso(NOW - (checkedAgeMs ?? ageMs)),
});
const usage = (rows) => usageFromLimits(rows, { now: NOW });
const leadFo = (u) => resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, u);

test("G2: fresh claude 5h >= 95% fails Lead - Claude over to Lead - Gemini", () => {
  const u = usage([row("claude", 96), row("antigravity-cli", 12)]);
  assert.equal(isProviderOverQuota("claude", u).overQuota, true);
  const fo = leadFo(u);
  assert.equal(fo.failedOver, true);
  assert.equal(fo.profile.name, "Lead - Gemini");
  assert.match(fo.reason, /claude usage 96% >= 95%/);
});

test("G2: claude at 94% does not fail over", () => {
  const u = usage([row("claude", 94), row("antigravity-cli", 12)]);
  assert.equal(u.find((e) => e.id === "claude").windows[0].usedPct, 94, "the reading is kept");
  assert.equal(leadFo(u).failedOver, false);
});

test("G2: a stale reading (last check older than the 5h bound) never triggers a switch", () => {
  assert.equal(QUOTA_READING_MAX_AGE_MS, 5 * 3600_000);
  const stale = row("claude", 100, { ageMs: QUOTA_READING_MAX_AGE_MS + MIN, resetInMs: 3600_000 });
  assert.deepEqual(usage([stale]), []);
  assert.equal(leadFo(usage([stale])).failedOver, false);
  // A recent sidecar check keeps an unchanged sample fresh (the jsonl only holds changes).
  const rechecked = row("claude", 100, { ageMs: QUOTA_READING_MAX_AGE_MS + MIN, checkedAgeMs: MIN, resetInMs: 3600_000 });
  assert.equal(leadFo(usage([rechecked])).failedOver, true);
});

test("G2: a reading whose resetsAt has passed (window rolled over) never triggers a switch", () => {
  // 11-25 shape: 100% at 13:42Z, resetsAt 17:20Z; read at 17:21Z.
  const rolled = row("claude", 100, { ageMs: 10 * MIN, resetInMs: -MIN });
  assert.deepEqual(usage([rolled]), []);
  assert.equal(leadFo(usage([rolled])).failedOver, false);
});

test("G2: the Antigravity Claude/GPT pool row never marks Gemini over quota; missing data = no switch", () => {
  const u = usage([row("antigravity-cli/claude-gpt", 100), row("claude", 99)]);
  // R10: the pool row feeds the agy-claude family (its own id), never antigravity-cli.
  assert.deepEqual(u.map((e) => e.id), ["agy-claude", "claude"]);
  assert.equal(isProviderOverQuota("antigravity-cli", u).overQuota, false);
  assert.equal(isProviderOverQuota("agy-claude", u).overQuota, true);
  assert.equal(leadFo(u).profile.name, "Lead - Gemini");
  assert.deepEqual(usage([]), []);
  assert.deepEqual(usage(undefined), []);
  assert.equal(leadFo(usage([])).failedOver, false);
});

test("G2: liveQuotaUsage reads runner/limits.jsonl (+ checked sidecar) and re-reads when it changes; a throwing source = []", () => {
  const home = mkdtempSync(join(tmpdir(), "vs-g2-limits-"));
  try {
    mkdirSync(join(home, "runner"), { recursive: true });
    const now = Date.now();
    const line = (usedPct) => JSON.stringify({ at: iso(now - MIN), provider: "claude", window: "5h", usedPct, resetsAt: iso(now + 3600_000), source: "provider" });
    writeFileSync(join(home, "runner", "limits.jsonl"), `${line(50)}\n`);
    assert.equal(isProviderOverQuota("claude", liveQuotaUsage({ home, now })).overQuota, false);
    writeFileSync(join(home, "runner", "limits.jsonl"), `${line(50)}\n${line(97)}\n${line(97)}\n`);
    const u = liveQuotaUsage({ home, now });
    assert.equal(u[0].windows[0].usedPct, 97);
    assert.equal(isProviderOverQuota("claude", u).overQuota, true);
    assert.deepEqual(liveQuotaUsage({ home, now, read: () => { throw new Error("disk gone"); } }), []);
    assert.deepEqual(liveQuotaUsage({ home: join(home, "nope"), now }), [], "no file = no data");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- spawn hook: production wiring (DEFAULT_DEPS.usageProviders) + the `vs.failover` reason carrier ----

const HOOK_PROFILES = DEFAULT_PACK_PROFILES.filter((p) => ["Lead - Claude", "Lead - Gemini"].includes(p.name));
const CWD = "/projects/VibeSquad/.worktrees/g2-test";

function withHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-g2-hook-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(join(vsHome, "runner"), { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
    writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: HOOK_PROFILES }));
    const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    try {
      await fn({ vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(overrides = {}) {
  const before = new Map();
  const server = { before: (name, fn) => (before.set(name, fn), () => before.delete(name)), on: () => () => {} };
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, ...overrides })(server);
  const spawn = async (config, labels, env) => {
    const req = { config: { cwd: CWD, ...config }, labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ...labels }, ...(env ? { env } : {}) };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  return { stop, spawn };
}

const writeLimits = (vsHome, usedPct, { resetInMs = 3 * 3600_000 } = {}) =>
  writeFileSync(
    join(vsHome, "runner", "limits.jsonl"),
    JSON.stringify({ at: iso(Date.now() - MIN), provider: "claude", window: "5h", usedPct, resetsAt: iso(Date.now() + resetInMs), source: "provider" }) + "\n",
  );

test(
  "G2 hook: with NO usageProviders override, a fresh 96% claude row in limits.jsonl fails Lead - Claude over (why=failover)",
  withHome(async ({ vsHome }) => {
    writeLimits(vsHome, 96);
    const h = harness({ cappedProviders: {} });
    try {
      const out = await h.spawn({ provider: "claude", model: "claude-opus-5-5" }, { profile: "Lead - Claude" });
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.labels.profile, "Lead - Gemini");
      assert.match(out.labels[ROUTE_LABEL], /why=failover$/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "G2 hook: 94%, rolled-over or a throwing source keep Lead - Claude",
  withHome(async ({ vsHome }) => {
    for (const [name, setup, overrides] of [
      ["94%", () => writeLimits(vsHome, 94), {}],
      ["resetsAt passed", () => writeLimits(vsHome, 100, { resetInMs: -MIN }), {}],
      ["source throws", () => writeLimits(vsHome, 100), { usageProviders: () => { throw new Error("boom"); } }],
    ]) {
      setup();
      const h = harness({ cappedProviders: {}, ...overrides });
      try {
        const out = await h.spawn({ provider: "claude", model: "claude-opus-5-5" }, { profile: "Lead - Claude" });
        assert.equal(out.config.provider, "claude", name);
        assert.doesNotMatch(out.labels[ROUTE_LABEL] ?? "", /why=failover/, name);
      } finally {
        h.stop?.();
      }
    }
  }),
);

test(
  "G2 hook: a spawn that already failed over upstream (`vs.failover` label or VS_FAILOVER env) shows why=failover",
  withHome(async () => {
    const h = harness({ cappedProviders: {}, usageProviders: [] });
    try {
      const gem = { provider: "antigravity-cli", model: "gemini-4-neon" };
      const plain = await h.spawn(gem, { profile: "Lead - Gemini" });
      assert.doesNotMatch(plain.labels[ROUTE_LABEL], /why=failover/);
      const byLabel = await h.spawn(gem, { profile: "Lead - Gemini", "vs.failover": "Lead - Claude -> Lead - Gemini (claude usage 96% >= 95%)" });
      assert.match(byLabel.labels[ROUTE_LABEL], /why=failover$/);
      const byEnv = await h.spawn(gem, { profile: "Lead - Gemini" }, { VS_PROFILE: "Lead - Gemini", VS_FAILOVER: "Lead - Claude -> Lead - Gemini" });
      assert.match(byEnv.labels[ROUTE_LABEL], /why=failover$/);
    } finally {
      h.stop?.();
    }
  }),
);

// ---- lead successor (lead-handoff.mjs) ----

function leadEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-g2-lead-"));
    const vsHome = join(dir, ".vibesquad");
    const profilesPath = join(vsHome, "profiles.json");
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "site", name: "example.dev", lanes: [{ id: "site-polish", name: "Site Polish" }], paths: ["example.dev"] }] }));
    seedDefaultPack(profilesPath);
    const prevHome = process.env.VIBESQUAD_HOME;
    process.env.VIBESQUAD_HOME = vsHome;
    try {
      await fn({ dir, vsHome, profilesPath, noDisk: { cappedProvidersPath: join(vsHome, "none.json") } });
    } finally {
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const oldClaudeLead = (profile = "Lead - Claude") => ({ provider: "claude", model: "claude-opus-5-5", labels: { profile } });
const freshClaude = (pct) => usageFromLimits([{ ...row("claude", pct), at: iso(Date.now() - MIN), checkedAt: iso(Date.now() - MIN), resetsAt: iso(Date.now() + 3600_000) }]);

test(
  "G2 lead successor: resolveLeadProfile fails a stored Lead - Claude over at >=95% (not at 94%); `vs cap` still wins",
  leadEnv(async ({ profilesPath, noDisk }) => {
    const over = resolveLeadProfile(oldClaudeLead(), profilesPath, { ...noDisk, cappedProviders: [], usageProviders: freshClaude(96) });
    assert.equal(over.profileName, "Lead - Gemini");
    assert.equal(over.spawnCfg.provider, "antigravity-cli");
    assert.deepEqual(over.failover, { from: "Lead - Claude", to: "Lead - Gemini", reason: "claude usage 96% >= 95%" });

    const under = resolveLeadProfile(oldClaudeLead(), profilesPath, { ...noDisk, cappedProviders: [], usageProviders: freshClaude(94) });
    assert.equal(under.profileName, "Lead - Claude");
    assert.equal(under.failover, null);

    // Gemini capped (`vs cap`) while Claude is >=95%: never hop onto the capped counterpart (the walk goes on, as the hook's).
    const gemCapped = resolveLeadProfile(oldClaudeLead(), profilesPath, { ...noDisk, cappedProviders: ["antigravity-cli"], usageProviders: freshClaude(99) });
    assert.notEqual(gemCapped.spawnCfg.provider, "antigravity-cli");
    // Every alternative capped: the requested Claude lead runs (no failover to report).
    const allCapped = resolveLeadProfile(oldClaudeLead(), profilesPath, { ...noDisk, cappedProviders: ["antigravity-cli", "opencode", "codex"], usageProviders: freshClaude(99) });
    assert.equal(allCapped.spawnCfg.provider, "claude");
    assert.equal(allCapped.failover, null);

    // Role-name lead: a `vs cap` on claude wins over a fresh claude quota row that says 10% (caps are read first).
    const role = resolveLeadProfile(oldClaudeLead("lead"), profilesPath, { ...noDisk, cappedProviders: ["claude"], usageProviders: freshClaude(10) });
    assert.equal(role.spawnCfg.provider, "antigravity-cli");
    assert.equal(role.failover?.to, "lead");
    assert.match(role.failover.reason, /^claude status is exhausted$/);
  }),
);

/** One self-handoff of a site-polish lead; `over` = { usageProviders?, labels?, provider? } (no usageProviders key = the live default). */
async function runHandoff({ dir, vsHome, profilesPath, noDisk }, over = {}) {
  const oldLead = {
    id: `lead-${Math.random().toString(36).slice(2, 8)}`,
    title: "★ SITE POLISH ord5",
    provider: over.provider ?? "claude",
    model: "claude-opus-5-5",
    cwd: dir,
    status: "idle",
    createdAt: "2026-11-01T00:00:00.000Z",
    labels: { team: "site", lane: "site-polish", role: "lead", ord: "5", profile: "Lead - Claude", ...over.labels },
  };
  const agents = new Map([[oldLead.id, oldLead]]);
  const payloads = [];
  const coordinator = createLeadHandoffCoordinator({
    rootDir: dir,
    baseHome: vsHome,
    profilesPath,
    ...noDisk,
    cappedProviders: [],
    ...("usageProviders" in over ? { usageProviders: over.usageProviders } : {}),
    listAgents: async () => [...agents.values()],
    getAgent: async (id) => agents.get(id) ?? null,
    setLabels: async (id, labels) => {
      const cur = agents.get(id);
      if (cur) cur.labels = { ...(cur.labels ?? {}), ...labels };
    },
    sendMessage: async () => {},
    createAgent: async (payload) => {
      payloads.push(payload);
      const created = { id: `succ-${payloads.length}-${oldLead.id}`, title: payload.title, provider: payload.config.provider, model: payload.config.model, cwd: payload.cwd, status: "running", labels: { ...payload.labels } };
      agents.set(created.id, created);
      return created;
    },
    deleteHeartbeat: async () => {},
    appendLog: () => {},
    reownWatches: async () => [],
  });
  const res = await coordinator.triggerSelfHandoff(oldLead);
  assert.equal(res?.ok, true, JSON.stringify(res));
  return { res, payload: payloads[0] };
}

test(
  "G2 lead successor: handoff at >=95% Claude spawns the Gemini lead with the failover reason on labels, env and result",
  leadEnv(async (env) => {
    const run = (usageProviders) => runHandoff(env, { usageProviders });
    const { res, payload } = await run(() => freshClaude(97));
    assert.equal(payload.config.provider, "antigravity-cli");
    assert.equal(payload.labels.profile, "Lead - Gemini");
    assert.equal(payload.labels["vs.failover"], "Lead - Claude -> Lead - Gemini (claude usage 97% >= 95%)");
    assert.equal(payload.env.VS_PROFILE, "Lead - Gemini");
    assert.equal(payload.env.VS_FAILOVER, payload.labels["vs.failover"]);
    assert.equal(res.failover?.to, "Lead - Gemini");
    assert.equal(res.successor.provider, "antigravity-cli");

    // A throwing source = no data = the requested Claude lead, no failover label.
    const thrown = await run(() => {
      throw new Error("limits read failed");
    });
    assert.equal(thrown.payload.config.provider, "claude");
    assert.equal(thrown.payload.labels.profile, "Lead - Claude");
    assert.equal(thrown.payload.labels["vs.failover"], undefined);
    assert.equal(thrown.res.failover, undefined);
  }),
);

// ---- r1 fixes (reviews Gemini rn-4497971971bf, Sonnet rn-9d3f8a588837) ----

test(
  "G2 r1 H1: a runner handoff with NO usageProviders reads live quota from the vs home and fails over (label, env, result)",
  leadEnv(async (env) => {
    mkdirSync(join(env.vsHome, "runner"), { recursive: true });
    writeLimits(env.vsHome, 96);
    const { res, payload } = await runHandoff(env, {});
    assert.equal(payload.config.provider, "antigravity-cli");
    assert.equal(payload.labels.profile, "Lead - Gemini");
    assert.equal(payload.labels["vs.failover"], "Lead - Claude -> Lead - Gemini (claude usage 96% >= 95%)");
    assert.equal(payload.env.VS_FAILOVER, payload.labels["vs.failover"]);
    assert.equal(res.failover?.to, "Lead - Gemini");
    // An explicit (empty) usageProviders still overrides the live default.
    const explicit = await runHandoff(env, { usageProviders: [] });
    assert.equal(explicit.payload.config.provider, "claude");
    assert.equal(explicit.res.failover, undefined);
  }),
);

test("G2 r1 M: a weekly >=95% row with resetsAt ahead outlives the 5h bound (up to its window); past resetsAt or a 5h row does not", () => {
  const H = 3600_000;
  const weeklyOld = row("claude", 97, { window: "weekly", ageMs: 6 * H, resetInMs: 3 * 24 * H });
  assert.equal(leadFo(usage([weeklyOld])).failedOver, true, "weekly 6h old, resets in 3d: kept");
  assert.deepEqual(usage([row("claude", 97, { window: "weekly", ageMs: 6 * H, resetInMs: -MIN })]), [], "weekly, resetsAt passed: dropped");
  assert.deepEqual(usage([row("claude", 97, { window: "weekly", ageMs: 6 * H, resetInMs: null })]), [], "weekly, no resetsAt: 5h bound");
  assert.deepEqual(usage([row("claude", 97, { window: "weekly", ageMs: 8 * 24 * H, resetInMs: H })]), [], "weekly older than its window: dropped");
  assert.deepEqual(usage([row("claude", 97, { window: "weekly", ageMs: 6 * H, resetInMs: 9 * 24 * H })]), [], "garbled resetsAt beyond one window: 5h bound");
  assert.deepEqual(usage([row("claude", 97, { window: "5h", ageMs: 6 * H, resetInMs: H })]), [], "5h row keeps the 5h bound");
});

test(
  "G2 r1 L: the stored-lead quota failover ignores disk caps when the caller passed in-memory caps (as the role path does)",
  leadEnv(async ({ vsHome, profilesPath, noDisk }) => {
    const capFile = join(vsHome, "env-caps.json");
    writeFileSync(capFile, JSON.stringify({ capped: { "antigravity-cli": { reason: "cap", updatedAt: new Date().toISOString() } } }));
    const prev = process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = capFile;
    try {
      const r = resolveLeadProfile(oldClaudeLead(), profilesPath, { ...noDisk, cappedProviders: [], usageProviders: freshClaude(96) });
      assert.equal(r.profileName, "Lead - Gemini");
      assert.equal(r.spawnCfg.provider, "antigravity-cli");
    } finally {
      if (prev === undefined) delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
      else process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = prev;
    }
  }),
);

test(
  "G2 r1 L2: a failed-over lead records vs.failover-from; the next handoff returns to it when quota is back, stays over while not",
  leadEnv(async (env) => {
    const hop1 = await runHandoff(env, { usageProviders: () => freshClaude(97) });
    assert.equal(hop1.payload.labels.profile, "Lead - Gemini");
    assert.equal(hop1.payload.labels["vs.failover-from"], "Lead - Claude");
    const fromGemini = { provider: "antigravity-cli", labels: { profile: hop1.payload.labels.profile, "vs.failover-from": hop1.payload.labels["vs.failover-from"] } };

    // Hop 2, Claude still >=95%: stays on Gemini, still remembers Claude.
    const still = await runHandoff(env, { ...fromGemini, usageProviders: () => freshClaude(98) });
    assert.equal(still.payload.labels.profile, "Lead - Gemini");
    assert.equal(still.payload.labels["vs.failover-from"], "Lead - Claude");
    assert.match(still.payload.labels["vs.failover"], /^Lead - Claude -> Lead - Gemini/);

    // Hop 2, Claude back under: returns to Lead - Claude, no failover labels left.
    const back = await runHandoff(env, { ...fromGemini, usageProviders: () => freshClaude(20) });
    assert.equal(back.payload.config.provider, "claude");
    assert.equal(back.payload.labels.profile, "Lead - Claude");
    assert.equal(back.payload.labels["vs.failover-from"], undefined);
    assert.equal(back.payload.labels["vs.failover"], undefined);

    // An explicit --profile still wins over the remembered one.
    const asked = resolveLeadProfile({ provider: "antigravity-cli", labels: fromGemini.labels }, env.profilesPath, { ...env.noDisk, requestedProfile: "Lead - Gemini", cappedProviders: [], usageProviders: freshClaude(20) });
    assert.equal(asked.profileName, "Lead - Gemini");
  }),
);

test("G2 r1 M1: at claude >=95% live quota a plain Implement spawn picks the Neon arm (capped:claude); labels match the model run", async () => {
  const { callTool, createContext } = await import("../server/mcp/tools.mjs");
  const { verifiedIdentity } = await import("./helpers/agent-token.mjs");
  const { USER_PROFILES } = await import("./helpers/route-golden.mjs");
  const { readArmCaps } = await import("../server/exp6-arm.mjs");
  const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }] }];
  const spawnOnce = async (pct, poolPct = null) => {
    const h = mkdtempSync(join(tmpdir(), "vs-g2-arm-"));
    try {
      mkdirSync(join(h, "runner"), { recursive: true });
      if (pct !== null) writeLimits(h, pct);
      if (poolPct !== null) writeFileSync(join(h, "runner", "limits.jsonl"), JSON.stringify({ at: iso(Date.now() - MIN), provider: "antigravity-cli/claude-gpt", window: "5h", usedPct: poolPct, resetsAt: iso(Date.now() + 3 * 3600_000), source: "provider" }) + "\n", { flag: "a" });
      const creates = [];
      const agents = [];
      const backend = {
        createAgent: async (req) => { creates.push(req); agents.push({ createdAt: new Date().toISOString(), labels: req.labels }); return { id: "a1", title: req.config.title }; },
        sendAgentPrompt: async () => {},
        fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      };
      const ctx = createContext({
        env: { VIBESQUAD_HOME: h },
        ...verifiedIdentity({ agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
        cwd: "/w", teams: TEAMS, loadProfiles: async () => USER_PROFILES,
        withBackend: async (_t, fn) => fn(backend), findLiveLeads: async () => [], writeLog: async () => {},
      });
      const caps = await readArmCaps({ env: { VIBESQUAD_HOME: h } });
      const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement", stakes: "normal" });
      return { res, c: creates[0], caps };
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  };
  // Baseline (no quota data): the first pick ties and keeps the requested Sonnet arm.
  const base = await spawnOnce(null);
  // R10: the sonnet arm runs Sonnet on agy (agy-claude: no pool rows = headroom).
  assert.deepEqual([base.res.ab.arm, base.res.ab.reason, base.c.config.provider, base.c.config.model], ["sonnet", "alternation", "antigravity-cli", "claude-sonnet-5-5-medium"]);
  // R10 fu2: 96% on direct claude alone leaves agy-claude, so the sonnet arm is NOT capped (it lands on agy-claude).
  const claudeOnly = await spawnOnce(96);
  assert.deepEqual(claudeOnly.caps.claude, { reason: "claude usage 96% >= 95%", quota: true });
  assert.deepEqual([claudeOnly.res.ab.arm, claudeOnly.res.ab.reason, claudeOnly.c.config.provider], ["sonnet", "alternation", "antigravity-cli"]);
  // 96% claude AND an exhausted agy-claude pool (>= 85%): the sonnet arm is capped by quota, the pick (and its labels) go to Neon on Gemini.
  const over = await spawnOnce(96, 90);
  assert.deepEqual(over.caps.claude, { reason: "claude usage 96% >= 95%", quota: true });
  assert.deepEqual([over.res.ab.arm, over.res.ab.reason, over.c.config.provider], ["neon", "capped:claude", "antigravity-cli"]);
  assert.deepEqual([over.c.labels["vs.arm"], over.c.labels["vs.arm-reason"], over.c.labels["vs.model"]], ["neon", "capped:claude", over.c.config.model]);
  assert.match(over.c.config.model, /^gemini-/);
  // 94%: no quota cap, Sonnet as before.
  const under = await spawnOnce(94);
  assert.deepEqual([under.res.ab.arm, under.res.ab.reason, under.c.config.provider], ["sonnet", "alternation", "antigravity-cli"]);
});
