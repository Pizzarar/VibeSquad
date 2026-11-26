// R2 spawn transparency (docs/PLAN_PER_ROLES_LADDER_1125.md): every spawn shows `Role · model · reason`, read back from the
// agent the runner created AFTER the spawn hook ran, so the result names what actually runs. End to end: spawn_worker
// (server/mcp/tools.mjs) -> a backend whose createAgent runs the real before("agent.create") hook in-process -> the result.
// Also: `vs.model` is always the model actually run, opt-out arm picks log a metric with refs (idea-962), and the digest
// reviewer stamp names the model (`reviewer=<profile> · <model>`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROUTE_LABEL, createPlugin } from "../server/hooks/agent-duties.ts";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { SPAWN_REASON, SPAWN_REASONS, routeWhy, shownSpawnReason, spawnShownLine } from "../server/spawn-reason.mjs";
import { digestLogRecord } from "../server/vibesquad-api.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VS_BACKEND;
const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH"];
const CWD = "/projects/VibeSquad/.worktrees/r2-test";
const TEAMS = [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"], lanes: [{ id: "vibesquad", name: "Hub", hub: true, paths: ["VibeSquad"] }, { id: "feat", name: "Feat" }] }];

/** Isolated home: teams + USER_PROFILES on disk, nothing capped on disk (caps come from the hook's cappedProviders). */
function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-r2-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: TEAMS }), "utf8");
    const profilesPath = join(vsHome, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles: USER_PROFILES }), "utf8");
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesPath;
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(vsHome, "capped-providers.json");
    try {
      await fn({ vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * spawn_worker ctx whose backend runs the real spawn hook (like the runner's createAgent) and returns the created agent
 * the way the runner does: model + labels as they landed. `hookCaps` = what the hook sees capped; arm caps read `{}`, so
 * a hook-only cap is a real failover the arm pick did not know about.
 */
function rig({ hookCaps = {}, agents = [] } = {}) {
  const before = new Map();
  const server = { before: (n, fn) => (before.set(n, fn), () => before.delete(n)), on: () => () => {} };
  const stop = createPlugin({
    startWatcher: false,
    setLabels: async () => {},
    archiveAgent: async () => {},
    applyAgentSettings: async () => {},
    refuseAgent: async () => {},
    cappedProviders: hookCaps,
  })(server);
  const creates = [];
  const logs = [];
  let n = 0;
  const backend = {
    createAgent: async ({ config, labels, env }) => {
      const req = { config: { ...config, cwd: CWD }, labels: { ...labels }, env: { ...env } };
      const out = (await before.get("agent.create")({ request: req })) ?? req;
      const agent = { id: `rn-r2-${++n}`, title: out.config.title, provider: out.config.provider, model: out.config.model, labels: out.labels, createdAt: new Date().toISOString() };
      creates.push({ pre: { config, labels }, out, agent });
      agents.push(agent);
      return agent;
    },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
  };
  const ctx = createContext({
    env: { VIBESQUAD_HOME: process.env.VIBESQUAD_HOME },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "vibesquad", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: CWD,
    teams: TEAMS,
    loadProfiles: async () => USER_PROFILES,
    readCaps: async () => ({}),
    withBackend: async (_t, fn) => fn(backend),
    findLiveLeads: async () => [],
    writeLog: async (e) => { logs.push(e); },
  });
  const go = (args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });
  return { go, creates, logs, stop };
}

const last = (creates) => creates[creates.length - 1];
/** The invariant: the result line, the `vs.model` label and the config that runs all name the same model. */
function assertNoLabelDrift(res, c, at) {
  assert.ok(c.out.config.model, `${at}: a model runs`);
  assert.equal(c.out.labels["vs.model"], c.out.config.model, `${at}: vs.model = the model actually run`);
  assert.equal(res.spawned.split(" · ")[1], c.out.config.model, `${at}: the result names the model actually run`);
  assert.equal(routeWhy(c.out.labels[ROUTE_LABEL]), res.spawned.split(" · ")[2], `${at}: the result reason = the hook's why=`);
}

test("spawn-reason helpers: precedence soft > failover > override > all-capped > arm > legacy-name > ladder; why= read back; line drops blanks", () => {
  // C fu1 L3 (@per PLAN_PER_QUOTA_FIT_1126): `soft` = a family skipped for its soft quota line, never shown as a capped failover.
  assert.deepEqual(SPAWN_REASONS, ["ladder", "override", "arm", "failover", "soft", "legacy-name", "all-capped"]);
  assert.equal(shownSpawnReason({ soft: true, failover: true, hookReason: "failover" }), "soft");
  assert.equal(shownSpawnReason({ soft: true, override: true }), "soft");
  assert.equal(routeWhy('reason=failover tier=mid role=implement soft="pool 78% >= soft 70: interruptible only -> claude" why=soft'), "soft");
  assert.deepEqual(Object.values(SPAWN_REASON), [...SPAWN_REASONS], "named constants = the reason list");
  assert.equal(shownSpawnReason({}), "ladder");
  assert.equal(shownSpawnReason({ hookReason: "all-capped", arm: true }), "all-capped", "all-capped beats the arm");
  assert.equal(shownSpawnReason({ allCapped: true, legacyName: true }), "all-capped");
  assert.equal(shownSpawnReason({ hookReason: "all-capped", override: true }), "override");
  assert.equal(shownSpawnReason({ hookReason: "all-capped", failover: true }), "failover");
  assert.equal(shownSpawnReason({ hookReason: "ladder+legacy-name" }), "legacy-name");
  assert.equal(shownSpawnReason({ arm: true, legacyName: true }), "arm");
  assert.equal(shownSpawnReason({ arm: true, hookReason: "override" }), "override");
  assert.equal(shownSpawnReason({ arm: true, hookReason: "explicit+ladder" }), "override");
  assert.equal(shownSpawnReason({ hookReason: "override+failover", arm: true }), "failover");
  assert.equal(shownSpawnReason({ failover: true, override: true }), "failover");
  assert.equal(shownSpawnReason({ routed: false }), "override");
  assert.equal(routeWhy("stakes=normal model=m reason=default tier=mid role=implement why=arm"), "arm");
  assert.equal(routeWhy("stakes=normal model=m reason=default tier=mid role=implement"), "", "pre-R2 label");
  assert.equal(routeWhy("why=bogus"), "", "unknown reasons are not shown");
  assert.equal(routeWhy("stakes=normal reason=default tier=mid role=review why=rung"), "ladder", "old why=rung labels on live agents read as ladder");
  assert.equal(routeWhy("reason=all-capped tier=mid role=implement why=all-capped"), "all-capped");
  assert.equal(routeWhy(undefined), "");
  assert.equal(spawnShownLine({ role: "Implement", model: "claude-sonnet-5-5", reason: "arm" }), "Implement · claude-sonnet-5-5 · arm");
  assert.equal(spawnShownLine({ role: "", model: "m", reason: "override" }), "m · override");
});

test(
  "arm: role Implement at normal alternates and shows `Implement · <model> · arm`; metric carries refs",
  withEnv(async () => {
    const { go, creates, logs, stop } = rig();
    try {
      const a = await go({ profile: "Implement", stakes: "normal" });
      assert.equal(a.spawned, "Implement · claude-sonnet-5-5-medium · arm");
      assertNoLabelDrift(a, last(creates), "arm sonnet");
      const b = await go({ profile: "Implement", stakes: "normal" });
      assert.equal(b.spawned, "Implement · gemini-4-neon · arm");
      assertNoLabelDrift(b, last(creates), "arm neon");
      assert.equal(b.ab.model, "gemini-4-neon");
      assert.match(b.route, /model=gemini-4-neon/);
      assert.deepEqual(logs.map((l) => l.refs), [[a.id], [b.id]], "idea-962: the arm metric refs the new agent");
    } finally {
      stop?.();
    }
  }),
);

test(
  "ladder: a role spawn off the arm (tierA-invariant) shows the ladder pick",
  withEnv(async () => {
    const { go, creates, logs, stop } = rig();
    try {
      const res = await go({ profile: "Implement", stakes: "tierA-invariant" });
      assert.equal(res.spawned, "Implement · claude-opus-5-5-high · ladder");
      assertNoLabelDrift(res, last(creates), "ladder");
      assert.equal(res.ab, undefined);
      assert.equal(logs.length, 0, "no arm, no arm metric");
      const rv = await go({ profile: "Review" });
      assert.match(rv.spawned, /^Review · \S+ · ladder$/);
      assertNoLabelDrift(rv, last(creates), "review ladder");
    } finally {
      stop?.();
    }
  }),
);

test(
  "override: provider-only (no model from the caller) still stamps vs.model with the ladder model that ran; provider+model keeps the model",
  withEnv(async () => {
    const { go, creates, stop } = rig();
    try {
      const p = await go({ profile: "Review", provider: "antigravity-cli", stakes: "tierA-invariant" });
      const c = last(creates);
      assert.equal(c.out.config.provider, "antigravity-cli");
      assert.match(p.spawned, /^Review · gemini-\S+ · override$/);
      assertNoLabelDrift(p, c, "provider-only");
      const pm = await go({ profile: "Implement", provider: "claude", model: "claude-opus-5-5", stakes: "normal" });
      assert.equal(pm.spawned, "Implement · claude-opus-5-5 · override");
      assertNoLabelDrift(pm, last(creates), "provider+model");
      assert.equal(pm.ab.reason, "override");
    } finally {
      stop?.();
    }
  }),
);

test(
  "failover: the arm picked Neon but the hook found Gemini capped -> the result names the Claude model that runs, reason failover",
  withEnv(async () => {
    // One Sonnet already in the lane: the alternation picks Neon (arm caps read {}), the hook then hops off capped Gemini.
    const agents = [{ createdAt: "2026-11-25T00:00:00Z", labels: { team: "vibesquad", lane: "feat", role: "worker", "vs.arm": "sonnet" } }];
    const { go, creates, stop } = rig({ hookCaps: { "antigravity-cli": { capped: true } }, agents });
    try {
      const res = await go({ profile: "Implement", stakes: "normal" });
      const c = last(creates);
      assert.equal(res.ab.arm, "neon", "the pick did not know about the cap");
      assert.equal(c.pre.labels["vs.model"], "gemini-4-neon", "spawn_worker's pre-hook pick");
      assert.equal(c.out.config.provider, "antigravity-cli");
      assert.equal(c.out.config.model, "claude-sonnet-5-5-medium");
      assert.equal(res.spawned, `Implement · ${c.out.config.model} · failover`);
      assert.match(c.out.config.model, /^claude-/);
      assertNoLabelDrift(res, c, "failover");
      assert.equal(res.ab.model, c.out.config.model, "result.ab.model = the actual model");
      assert.match(res.route, new RegExp(`model=${c.out.config.model}`));
    } finally {
      stop?.();
    }
  }),
);

test(
  "legacy-name: an old stored profile name runs its stored profile (laddered) and says so",
  withEnv(async () => {
    const { go, creates, stop } = rig();
    try {
      const res = await go({ profile: "Implement - Sonnet", stakes: "tierA-security" });
      assert.equal(res.spawned, "Implement · claude-opus-5-5 · legacy-name");
      assertNoLabelDrift(res, last(creates), "legacy-name");
    } finally {
      stop?.();
    }
  }),
);

test(
  "idea-962: pin / wf / override opt-outs log an implementer-arm metric with refs; they still carry no vs.arm",
  withEnv(async () => {
    for (const [args, reason, prov, model] of [
      [{ labels: { ab: "pin" } }, "pin", "antigravity-cli", "claude-sonnet-5-5-medium"],
      [{ labels: { wf: "sonnet" } }, "wf", "antigravity-cli", "claude-sonnet-5-5-medium"],
      [{ provider: "claude", model: "claude-sonnet-5-5" }, "override", "claude", "claude-sonnet-5-5"],
    ]) {
      const { go, creates, logs, stop } = rig();
      try {
        const res = await go({ profile: "Implement", stakes: "normal", ...args });
        assert.equal(logs.length, 1, reason);
        assert.match(logs[0].text, new RegExp(`^implementer-arm: Implement -> Implement@${prov} arm=\\S+ reason=${reason} model=${model} `), reason);
        assert.deepEqual(logs[0].refs, [res.id], reason);
        assert.equal(last(creates).out.labels["vs.arm"], undefined, `${reason}: never alternation data`);
      } finally {
        stop?.();
      }
    }
  }),
);

test("hook: no final model drops a caller's stale vs.model; a respawn never inherits vs.model", async () => {
  const before = new Map();
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {} })({
    before: (n, fn) => (before.set(n, fn), () => before.delete(n)),
    on: () => () => {},
  });
  try {
    // A provider with no profile and no model: the provider's own default runs, so no vs.model may name another.
    const req = { config: { cwd: "/tmp/r2-none", provider: "codex" }, labels: { team: "x", lane: "y", role: "worker", "vs.model": "claude-sonnet-5-5" } };
    const out = (await before.get("agent.create")({ request: req })) ?? req;
    assert.equal(out.config.model ?? "", "");
    assert.equal(out.labels["vs.model"], undefined);
  } finally {
    stop?.();
  }
  const { respawnLabels } = await import("../server/hooks/agent-duties.ts");
  const next = respawnLabels({ team: "x", "vs.model": "gemini-4-neon", model: "gemini-4-neon" }, "Implement", "rn-dead");
  assert.deepEqual([next["vs.model"], next.model, next.team], [undefined, undefined, "x"]);
});

test("digest reviewer stamp names the model: `reviewer=<profile> · <actual model>`; the attested verdict keeps the bare profile", async () => {
  const mk = (labels, model) => ({
    fetchAgent: async () => ({ agent: { id: "rn-rev", title: "Review", model, labels: { role: "worker", ...labels } } }),
    fetchAgentTimeline: async () => ({ entries: [{ item: { type: "assistant_message", text: "PASS 0/0/1 abc1234\nlooks fine" } }] }),
  });
  const caller = { id: "rn-dig", digest: true, digestFor: "rn-rev" };
  const r = await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review", "vs.model": "gemini-4-pro" }, "gemini-4-pro"));
  assert.match(r.text, /^PASS 0\/0\/1 abc1234 reviewer=Review · gemini-4-pro — /);
  assert.equal(r.verdict?.profile, "Review");
  // L4: after a live model switch the record's model is the one that reviewed; the spawn-time vs.model must not win.
  const switched = await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review", "vs.model": "gemini-4-pro", model: "gemini-4-pro" }, "claude-opus-5-5"));
  assert.match(switched.text, /reviewer=Review · claude-opus-5-5 /);
  assert.doesNotMatch(switched.text, /gemini-4-pro/);
  // Fallbacks when the record carries no model: vs.model, then labels.model; none -> the bare profile (pre-R2 shape).
  assert.match((await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review", "vs.model": "gemini-4-pro", model: "stale" }))).text, /reviewer=Review · gemini-4-pro /);
  assert.match((await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review", model: "claude-sonnet-5-5" }))).text, /reviewer=Review · claude-sonnet-5-5 /);
  assert.match((await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review" }, "claude-opus-5-5"))).text, /reviewer=Review · claude-opus-5-5 /);
  assert.match((await digestLogRecord(caller, "done", "PASS: ok", mk({ profile: "Review" }))).text, /^PASS 0\/0\/1 abc1234 reviewer=Review — /);
});

test(
  "all-capped: Implement at normal with every provider capped shows `all-capped` (not arm) in vs.route why= and result.spawned",
  withEnv(async () => {
    const caps = Object.fromEntries(["claude", "agy-claude", "antigravity-cli", "opencode", "codex"].map((k) => [k, { capped: true }]));
    const { go, creates, stop } = rig({ hookCaps: caps });
    try {
      const res = await go({ profile: "Implement", stakes: "normal" });
      const c = last(creates);
      assert.match(String(c.out.labels[ROUTE_LABEL]), /reason=all-capped .*why=all-capped$/);
      assert.equal(res.spawned.split(" · ")[2], "all-capped");
      assertNoLabelDrift(res, c, "all-capped");
    } finally {
      stop?.();
    }
  }),
);

test(
  "L3: a raw spawn (not via spawn_worker, no pre-filled vs.model) gets vs.model from the hook alone",
  withEnv(async () => {
    const before = new Map();
    const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {}, cappedProviders: {} })({
      before: (n, fn) => (before.set(n, fn), () => before.delete(n)),
      on: () => () => {},
    });
    try {
      // Role-name raw spawn (UI / CLI / create_agent shape): the ladder picks the model; nothing named it beforehand.
      const role = { config: { cwd: CWD, provider: "claude", title: "raw" }, labels: { team: "vibesquad", lane: "feat", role: "worker", profile: "Review" } };
      const ro = (await before.get("agent.create")({ request: role })) ?? role;
      assert.ok(ro.config.model, "the ladder named a model");
      assert.equal(ro.labels["vs.model"], ro.config.model, "role raw spawn: vs.model stamped by the hook");
      // Plain raw spawn with its own model and no profile.
      const plain = { config: { cwd: CWD, provider: "claude", model: "claude-sonnet-5-5", title: "raw2" }, labels: { team: "vibesquad", lane: "feat", role: "worker" } };
      const po = (await before.get("agent.create")({ request: plain })) ?? plain;
      assert.equal(po.labels["vs.model"], "claude-sonnet-5-5", "plain raw spawn: vs.model stamped by the hook");
    } finally {
      stop?.();
    }
  }),
);

/** spawn_worker over a backend that returns a fixed created agent (the hook's work already done, or not run at all). */
function fixedRig(made) {
  const backend = {
    createAgent: async ({ config, labels }) => ({ id: "rn-fx", title: config.title, ...made({ config, labels }) }),
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: [] }),
  };
  const ctx = createContext({
    env: { VIBESQUAD_HOME: process.env.VIBESQUAD_HOME },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "vibesquad", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: CWD,
    teams: TEAMS,
    loadProfiles: async () => USER_PROFILES,
    readCaps: async () => ({}),
    withBackend: async (_t, fn) => fn(backend),
    findLiveLeads: async () => [],
    writeLog: async () => {},
  });
  return (args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });
}

test(
  "L2: the pre-hook model is a fallback only when the hook did not run; the local reason honours failover",
  withEnv(async () => {
    // Hook ran (why= on vs.route) and ended on the provider's own default: no model, vs.model dropped -> name no model.
    const ran = fixedRig(({ labels }) => {
      const { ["vs.model"]: _m, ...rest } = labels;
      return { provider: "codex", labels: { ...rest, [ROUTE_LABEL]: "stakes=tierA-invariant reason=failover tier=top role=implement why=failover" } };
    });
    const a = await ran({ profile: "Implement", stakes: "tierA-invariant" });
    assert.equal(a.spawned, "Implement · failover", "no stale pre-hook model after the hook ran");
    // Hook did not run (no why=): the pre-hook pick stands in, and a provider change still reads as a failover.
    const none = fixedRig(({ labels }) => ({ provider: "codex", labels: { ...labels } }));
    const b = await none({ profile: "Implement", stakes: "tierA-invariant" });
    assert.match(b.spawned, /^Implement · claude-\S+ · failover$/);
    // A pre-R2 hook ran (reason= but no why=), same provider: its reason=failover still shows as failover (tools.mjs hookReason).
    const preR2 = fixedRig(({ config, labels }) => ({ provider: config.provider, labels: { ...labels, [ROUTE_LABEL]: "stakes=tierA-invariant model=m reason=failover tier=top role=implement" } }));
    const d = await preR2({ profile: "Implement", stakes: "tierA-invariant" });
    assert.match(d.spawned, /^Implement · claude-\S+ · failover$/);
    // Hook did not run, same provider: the local ladder reason (not failover).
    const same = fixedRig(({ config, labels }) => ({ provider: config.provider, labels: { ...labels } }));
    const c = await same({ profile: "Implement", stakes: "tierA-invariant" });
    assert.match(c.spawned, /^Implement · claude-\S+ · ladder$/);
  }),
);
