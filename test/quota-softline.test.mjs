// @per PLAN_PER_QUOTA_FIT_1126 C: per-family soft quota line (default 70%, configurable per family).
// >= soft & < hard: only interruptible work (stakes=mechanical, or kind/role in docs, audit, spike, Pre-check) routes there.
// Non-interruptible work skips to the next family under its soft line; if every family is past soft, falls back to first under hard.
import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGY_CLAUDE_FAILOVER_THRESHOLD,
  QUOTA_FAILOVER_THRESHOLD,
  QUOTA_SOFT_THRESHOLD,
  isInterruptibleWork,
  isProviderOverQuota,
  resolveProfileWithFailover,
  resolveSoftQuotaThreshold,
} from "../server/provider-failover.mjs";
import { AGY_CLAUDE_FAMILY } from "../server/model-ids.mjs";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";
import { ROLE_TABLE, resolveRoute } from "../server/role-route.mjs";
import { DEFAULT_TIER_LADDER } from "../server/stakes-ladder.mjs";
import { cappedFamilies, roleSpawnConfig, roleSpawnProfile, softCappedFamilies } from "../server/spawn-route.mjs";
import { decideArm, readArmCaps } from "../server/exp6-arm.mjs";
import { resolveLeadProfile } from "../server/lead-handoff.mjs";
import { seedDefaultPack } from "../server/vibesquad-api.mjs";
import { createPlugin, ROUTE_LABEL } from "../server/hooks/agent-duties.ts";
import { isInterruptibleRole, landingPick } from "../src/roleSpawn.ts";

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const row = (id, usedPct) => ({ id, status: "ok", usedPct, remainingPct: 100 - usedPct });

test("1. constants and hard lines remain unchanged (hard 95/85, soft default 70)", () => {
  assert.equal(QUOTA_FAILOVER_THRESHOLD, 95);
  assert.equal(AGY_CLAUDE_FAILOVER_THRESHOLD, 85);
  assert.equal(QUOTA_SOFT_THRESHOLD, 70);

  // Hard line boundaries: 94/84 are NOT hard over-quota, 95/85 ARE hard over-quota.
  const c94 = isProviderOverQuota("claude", [row("claude", 94)]);
  assert.deepEqual([c94.overQuota, c94.softOverQuota, c94.softThreshold], [false, true, 70]);
  const c95 = isProviderOverQuota("claude", [row("claude", 95)]);
  assert.deepEqual([c95.overQuota, c95.softOverQuota], [true, false]);

  const a84 = isProviderOverQuota(AGY_CLAUDE_FAMILY, [row(AGY_CLAUDE_FAMILY, 84)]);
  assert.deepEqual([a84.overQuota, a84.softOverQuota, a84.softThreshold], [false, true, 70]);
  const a85 = isProviderOverQuota(AGY_CLAUDE_FAMILY, [row(AGY_CLAUDE_FAMILY, 85)]);
  assert.deepEqual([a85.overQuota, a85.softOverQuota], [true, false]);

  // Interruptible work still fails over at hard line 95/85.
  assert.equal(isProviderOverQuota("claude", [row("claude", 95)], undefined, { stakes: "mechanical" }).overQuota, true);
  assert.equal(isProviderOverQuota("antigravity-cli", [row("antigravity-cli", 95)], undefined, { role: "Pre-check" }).overQuota, true);
  assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, [row(AGY_CLAUDE_FAMILY, 85)], undefined, { kind: "docs" }).overQuota, true);
});

test("2. configurable per-family soft line via env and opts; whitespace/unparseable falls back to 70", () => {
  // Default
  assert.equal(resolveSoftQuotaThreshold("claude", { env: {} }), 70);
  // Global env
  assert.equal(resolveSoftQuotaThreshold("claude", { env: { VS_QUOTA_SOFT_PCT: "80" } }), 80);
  // Per-family env overrides global env
  const famEnv = { VS_QUOTA_SOFT_PCT: "80", VS_QUOTA_SOFT_PCT_CLAUDE: "60", VS_QUOTA_SOFT_PCT_AGY_CLAUDE: "55" };
  assert.equal(resolveSoftQuotaThreshold("claude", { env: famEnv }), 60);
  assert.equal(resolveSoftQuotaThreshold(AGY_CLAUDE_FAMILY, { env: famEnv }), 55);
  assert.equal(resolveSoftQuotaThreshold("antigravity-cli", { env: famEnv }), 80);
  // opts.softThreshold / opts.softThresholds override env
  assert.equal(resolveSoftQuotaThreshold("claude", { env: famEnv, softThreshold: 72 }), 72);
  assert.equal(resolveSoftQuotaThreshold("claude", { env: famEnv, softThresholds: { claude: 62, "agy-claude": 58 } }), 62);
  assert.equal(resolveSoftQuotaThreshold(AGY_CLAUDE_FAMILY, { env: famEnv, softThresholds: { claude: 62, "agy-claude": 58 } }), 58);

  // Whitespace, empty, unparseable, negative, >100 all fall back to 70.
  for (const bad of ["", "   ", "\t\n", "abc", "70%", "-5", "101", "NaN", "Infinity"]) {
    assert.equal(resolveSoftQuotaThreshold("claude", { env: { VS_QUOTA_SOFT_PCT: bad } }), 70, `bad=${JSON.stringify(bad)}`);
    assert.equal(resolveSoftQuotaThreshold("claude", { env: { VS_QUOTA_SOFT_PCT_CLAUDE: bad } }), 70, `fam bad=${JSON.stringify(bad)}`);
    assert.equal(resolveSoftQuotaThreshold("claude", { env: {}, softThreshold: bad }), 70, `opt bad=${JSON.stringify(bad)}`);
  }

  // Per-family threshold actually governs softOverQuota.
  const q65 = isProviderOverQuota("claude", [row("claude", 65)], undefined, { softThresholds: { claude: 60 } });
  assert.equal(q65.softOverQuota, true);
  assert.equal(q65.softReason, "pool 65% >= soft 60: interruptible only");
  const q75 = isProviderOverQuota("claude", [row("claude", 75)], undefined, { softThresholds: { claude: 80 } });
  assert.equal(q75.softOverQuota, false);
});

test("3. normal & tierA-* Implement at 75% claude pool route to next family and name the soft line", () => {
  // Both agy-claude and claude at 75%, antigravity-cli at 20% -> Implement routes to antigravity-cli.
  const usage = [row(AGY_CLAUDE_FAMILY, 75), row("claude", 75), row("antigravity-cli", 20)];
  const caps = cappedFamilies(usage, [], { ignoreDiskCaps: true });
  const softCaps = softCappedFamilies(usage, [], { ignoreDiskCaps: true, stakes: "normal", role: "Implement" });
  assert.deepEqual(caps, []);
  assert.equal(softCaps.claude, "pool 75% >= soft 70: interruptible only");
  assert.equal(softCaps[AGY_CLAUDE_FAMILY], "pool 75% >= soft 70: interruptible only");

  const hit = roleSpawnProfile("Implement", { stakes: "normal", caps, softCaps });
  assert.equal(hit.route.provider, "antigravity-cli");
  assert.equal(hit.route.softFailover, true);
  assert.equal(hit.route.softReason, "pool 75% >= soft 70: interruptible only -> antigravity-cli");
  assert.ok(hit.route.reasons.includes("failover"));

  // tierA-invariant also skips soft-capped pools.
  const tierA = roleSpawnProfile("Implement", { stakes: "tierA-invariant", caps, softCaps });
  assert.equal(tierA.route.provider, "antigravity-cli");
  assert.equal(tierA.route.softFailover, true);
  assert.equal(tierA.route.softReason, "pool 75% >= soft 70: interruptible only -> antigravity-cli");

  // Only agy-claude at 78%, direct claude at 20% -> routes to direct claude (next family in chain).
  const agyOnly = roleSpawnConfig("Implement", {
    stakes: "normal",
    usageList: [row(AGY_CLAUDE_FAMILY, 78), row("claude", 20), row("antigravity-cli", 20)],
  });
  assert.equal(agyOnly.route.provider, "claude");
  assert.equal(agyOnly.route.softFailover, true);
  assert.equal(agyOnly.route.softReason, "pool 78% >= soft 70: interruptible only -> claude");

  // Legacy profile resolveProfileWithFailover: Implement - Sonnet at 78% claude -> Lead - Gemini with soft reason.
  const fo = resolveProfileWithFailover("Implement - Sonnet", DEFAULT_PACK_PROFILES, [row("claude", 78), row("antigravity-cli", 20)], { stakes: "normal" });
  assert.equal(fo.failedOver, true);
  assert.equal(fo.softFailover, true);
  assert.equal(fo.profile.name, "Lead - Gemini");
  assert.equal(fo.reason, "pool 78% >= soft 70: interruptible only -> antigravity-cli");
});

test("4. mechanical, Pre-check, docs, audit, spike at 75% still route to that family (interruptible)", () => {
  for (const ok of [
    { stakes: "mechanical" },
    { role: "Pre-check" },
    { role: "pre-check" },
    { role: "Pre-check - Flash" },
    { kind: "docs" },
    { kind: "audit" },
    { kind: "spike" },
  ]) {
    assert.equal(isInterruptibleWork(ok), true, JSON.stringify(ok));
  }
  for (const no of [{ stakes: "normal", role: "Implement" }, { stakes: "tierA-security", role: "Implement" }, { role: "lead" }, { role: "Review" }]) {
    assert.equal(isInterruptibleWork(no), false, JSON.stringify(no));
  }

  // Mechanical Implement: cheap chain is [antigravity-cli, claude, opencode]. At 75% antigravity-cli, stays on antigravity-cli.
  const mech = roleSpawnConfig("Implement", {
    stakes: "mechanical",
    usageList: [row("antigravity-cli", 75), row("claude", 10)],
  });
  assert.equal(mech.route.provider, "antigravity-cli");
  assert.equal(mech.route.softFailover, false);
  assert.equal(mech.route.softReason, null);

  // Pre-check at 75% antigravity-cli: stays on antigravity-cli.
  const pc = roleSpawnConfig("Pre-check", {
    stakes: "normal",
    usageList: [row("antigravity-cli", 75), row("claude", 10)],
  });
  assert.equal(pc.route.provider, "antigravity-cli");
  assert.equal(pc.route.softFailover, false);

  // Legacy Pre-check - Flash at 75% antigravity-cli: stays on Pre-check - Flash.
  const legacyPc = resolveProfileWithFailover("Pre-check - Flash", DEFAULT_PACK_PROFILES, [row("antigravity-cli", 75), row("claude", 10)]);
  assert.equal(legacyPc.failedOver, false);
  assert.equal(legacyPc.profile.name, "Pre-check - Flash");

  // Implement with kind=docs / audit / spike at 75% agy-claude: stays on agy-claude.
  for (const kind of ["docs", "audit", "spike"]) {
    const r = roleSpawnConfig("Implement", {
      stakes: "normal",
      kind,
      usageList: [row(AGY_CLAUDE_FAMILY, 75), row("claude", 75), row("antigravity-cli", 10)],
    });
    assert.equal(r.route.provider, AGY_CLAUDE_FAMILY, `kind=${kind}`);
    assert.equal(r.route.softFailover, false, `kind=${kind}`);
  }
});

test("5. all families >= soft -> use first family under hard (never strands)", () => {
  // All 4 families past soft (70%), all under hard (85/95): stays on first (agy-claude), no failover.
  const allSoft = roleSpawnConfig("Implement", {
    stakes: "normal",
    usageList: [row(AGY_CLAUDE_FAMILY, 75), row("claude", 78), row("antigravity-cli", 80), row("opencode", 72)],
  });
  assert.equal(allSoft.route.provider, AGY_CLAUDE_FAMILY);
  assert.equal(allSoft.route.softFailover, false);
  assert.equal(allSoft.route.capped, false);

  // agy-claude is over HARD (90% >= 85%), all others are past soft (under hard): lands on direct claude (first under hard).
  const agyHardRestSoft = roleSpawnConfig("Implement", {
    stakes: "normal",
    usageList: [row(AGY_CLAUDE_FAMILY, 90), row("claude", 78), row("antigravity-cli", 80), row("opencode", 72)],
  });
  assert.equal(agyHardRestSoft.route.provider, "claude");
  assert.equal(agyHardRestSoft.route.softFailover, false);
  assert.ok(agyHardRestSoft.route.reasons.includes("failover"));

  // Legacy resolveProfileWithFailover: primary hard (96%), others soft (80%) -> fails over to first under hard with hard reason.
  const legacyHard = resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, [
    row("claude", 96),
    row("antigravity-cli", 80),
    row("opencode", 80),
  ]);
  assert.equal(legacyHard.failedOver, true);
  assert.equal(legacyHard.profile.name, "Lead - Gemini");
  assert.match(legacyHard.reason, /claude usage 96% >= 95%/);
});

test("6. exp6-arm decideArm respects soft line (and falls back when all arms >= soft)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-arm-"));
  try {
    mkdirSync(join(dir, "runner"), { recursive: true });
    const writeRows = (entries) =>
      writeFileSync(
        join(dir, "runner", "limits.jsonl"),
        entries
          .map(([provider, usedPct]) =>
            JSON.stringify({ at: iso(Date.now() - MIN), provider, window: "5h", usedPct, resetsAt: iso(Date.now() + 3 * 3600_000), source: "provider" }),
          )
          .join("\n") + "\n",
      );

    // Claude + agy-claude at 75% (soft), antigravity-cli at 20%: Sonnet's turn skips to Neon with soft reason.
    writeRows([
      ["claude", 75],
      ["antigravity-cli/claude-gpt", 75],
      ["antigravity-cli", 20],
    ]);
    const caps = await readArmCaps({ env: { VIBESQUAD_HOME: dir } });
    assert.equal(caps.claude?.soft, true);
    assert.equal(caps[AGY_CLAUDE_FAMILY]?.soft, true);
    assert.equal(caps["antigravity-cli"], undefined);

    const pick = await decideArm({
      profile: "Implement",
      stakes: "normal",
      lane: "feat",
      team: "mx",
      listAgents: async () => [],
      capProbe: async () => caps,
    });
    assert.equal(pick.arm, "neon");
    assert.equal(pick.provider, "antigravity-cli");
    assert.equal(pick.softFailover, true);
    assert.equal(pick.reason, "pool 75% >= soft 70: interruptible only -> antigravity-cli");

    // Interruptible kind=docs ignores soft cap and keeps Sonnet's turn.
    const docsPick = await decideArm({
      profile: "Implement",
      stakes: "normal",
      labels: { kind: "docs" },
      lane: "feat",
      team: "mx",
      listAgents: async () => [],
      capProbe: async () => caps,
    });
    assert.equal(docsPick.arm, "sonnet");
    assert.equal(docsPick.reason, "alternation");

    // Both arms past soft (75% / 78%), both under hard: keeps normal alternation (Sonnet's turn).
    writeRows([
      ["claude", 75],
      ["antigravity-cli/claude-gpt", 75],
      ["antigravity-cli", 78],
    ]);
    const bothSoftCaps = await readArmCaps({ env: { VIBESQUAD_HOME: dir } });
    const bothPick = await decideArm({
      profile: "Implement",
      stakes: "normal",
      lane: "feat",
      team: "mx",
      listAgents: async () => [],
      capProbe: async () => bothSoftCaps,
    });
    assert.equal(bothPick.arm, "sonnet");
    assert.equal(bothPick.reason, "alternation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7. lead-handoff prefers a family under its soft line and preserves G2 disk-cap precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-lead-"));
  try {
    const profilesPath = join(dir, "profiles.json");
    seedDefaultPack(profilesPath);
    const noDisk = { cappedProvidersPath: join(dir, "none.json") };
    const oldRoleLead = { provider: "claude", model: "claude-opus-5-5", labels: { profile: "lead" } };

    // Role-name lead: claude at 78% (soft), gemini at 20% -> hands off to Gemini with soft reason.
    const roleSoft = resolveLeadProfile(oldRoleLead, profilesPath, {
      ...noDisk,
      cappedProviders: [],
      usageProviders: [row("claude", 78), row("antigravity-cli", 20)],
    });
    assert.equal(roleSoft.spawnCfg.provider, "antigravity-cli");
    assert.equal(roleSoft.failover?.reason, "pool 78% >= soft 70: interruptible only -> antigravity-cli");

    // All families past soft (under hard): keeps Claude.
    const roleAllSoft = resolveLeadProfile(oldRoleLead, profilesPath, {
      ...noDisk,
      cappedProviders: [],
      usageProviders: [row("claude", 78), row("antigravity-cli", 80), row("opencode", 80)],
    });
    assert.equal(roleAllSoft.spawnCfg.provider, "claude");
    assert.equal(roleAllSoft.failover, null);

    // G2 disk-cap precedence: disk cap on claude wins over a 10% live quota row.
    const capPath = join(dir, "capped-providers.json");
    writeFileSync(capPath, JSON.stringify({ capped: { claude: { reason: "manual cap", updatedAt: new Date().toISOString() } } }));
    const diskCap = resolveLeadProfile(oldRoleLead, profilesPath, {
      cappedProvidersPath: capPath,
      usageProviders: [row("claude", 10), row("antigravity-cli", 10)],
    });
    assert.equal(diskCap.spawnCfg.provider, "antigravity-cli");
    assert.match(diskCap.failover?.reason ?? "", /claude status is exhausted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. spawn hook stamps soft line reason into vs.route label and shows why=soft (C fu1 L3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-hook-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const teamsFile = join(vsHome, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
  const profilesPath = join(vsHome, "profiles.json");
  writeFileSync(profilesPath, JSON.stringify({ profiles: DEFAULT_PACK_PROFILES }));
  const prev = { VIBESQUAD_HOME: process.env.VIBESQUAD_HOME, VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE, VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH };
  process.env.VIBESQUAD_HOME = vsHome;
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
  process.env.VIBESQUAD_PROFILES_PATH = profilesPath;
  try {
    const before = new Map();
    const server = { before: (name, fn) => (before.set(name, fn), () => before.delete(name)), on: () => () => {} };
    const stop = createPlugin({
      startWatcher: false,
      cappedProviders: {},
      usageProviders: [row(AGY_CLAUDE_FAMILY, 78), row("claude", 78), row("antigravity-cli", 20)],
      setLabels: async () => {},
      archiveAgent: async () => {},
    })(server);
    try {
      const spawn = async (labels) => {
        const req = { config: { cwd: "/projects/VibeSquad/.worktrees/soft-test", provider: "claude" }, labels: { team: "vibesquad", lane: "vibesquad", role: "worker", ...labels } };
        return (await before.get("agent.create")({ request: req })) ?? req;
      };
      // Normal Implement -> skips agy-claude & claude (78% >= 70%), lands on antigravity-cli (Gemini), names soft line in vs.route.
      const normal = await spawn({ profile: "Implement", stakes: "normal" });
      assert.equal(normal.config.provider, "antigravity-cli");
      assert.match(normal.config.model, /^gemini-/);
      assert.match(normal.labels[ROUTE_LABEL], /pool 78% >= soft 70: interruptible only -> antigravity-cli/);
      assert.match(normal.labels[ROUTE_LABEL], /why=soft$/);

      // Interruptible kind=docs -> stays on agy-claude (no soft failover).
      const docs = await spawn({ profile: "Implement", stakes: "normal", kind: "docs" });
      assert.equal(docs.config.provider, "antigravity-cli");
      assert.match(docs.config.model, /^claude-sonnet-/);
      assert.doesNotMatch(docs.labels[ROUTE_LABEL], /why=(failover|soft)$/);
    } finally {
      stop?.();
    }
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9. UI mirror parity: src/roleSpawn.ts landingPick + isInterruptibleRole match server resolveRoute + isInterruptibleWork", () => {
  const roles = ["implement", "review", "pre-check", "lead", "brainstorm", "planner"];
  const stakesList = ["normal", "tierA-invariant", "tierA-security", "mechanical"];
  const kinds = ["", "docs", "audit", "spike"];
  const capCases = [[], [AGY_CLAUDE_FAMILY], ["claude"], [AGY_CLAUDE_FAMILY, "claude"], [AGY_CLAUDE_FAMILY, "claude", "antigravity-cli", "opencode"]];
  const softCases = [
    {},
    { [AGY_CLAUDE_FAMILY]: "pool 75% >= soft 70: interruptible only" },
    { [AGY_CLAUDE_FAMILY]: "pool 75% >= soft 70: interruptible only", claude: "pool 75% >= soft 70: interruptible only" },
    { [AGY_CLAUDE_FAMILY]: true, claude: true, "antigravity-cli": true, opencode: true },
  ];

  let checked = 0;
  for (const roleKey of roles) {
    const roleDef = ROLE_TABLE[roleKey];
    for (const stakes of stakesList) {
      for (const kind of kinds) {
        assert.equal(
          isInterruptibleRole({ stakes, kind, role: roleKey }),
          isInterruptibleWork({ stakes, kind, role: roleKey }),
          `interruptible parity role=${roleKey} stakes=${stakes} kind=${kind}`,
        );
        for (const capped of capCases) {
          for (const softCapped of softCases) {
            const ui = landingPick(roleDef, DEFAULT_TIER_LADDER, stakes, { capped, softCapped, kind, roleKey });
            const srv = resolveRoute({ role: roleKey, stakes, kind, caps: capped, softCaps: softCapped });
            assert.equal(ui.provider, srv.provider, `provider parity role=${roleKey} stakes=${stakes} kind=${kind} capped=${capped} soft=${JSON.stringify(softCapped)}`);
            assert.equal(ui.allCapped, srv.capped, `allCapped parity role=${roleKey} stakes=${stakes} kind=${kind} capped=${capped} soft=${JSON.stringify(softCapped)}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `expected >1000 parity cases, ran ${checked}`);
});
