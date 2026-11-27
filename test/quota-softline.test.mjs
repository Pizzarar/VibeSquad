// @per PLAN_PER_QUOTA_FIT_1126 C: per-family soft quota line (default 70%, configurable per family).
// >= soft & < hard: only interruptible work (stakes=mechanical, or kind/role in docs, audit, spike, Pre-check) routes there.
// Non-interruptible work skips to the next family under its soft line; if every family is past soft, falls back to first under hard.
import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { cappedFamilies, roleSpawnConfig, roleSpawnProfile, softCappedFamilies, unknownQuotaFamilies } from "../server/spawn-route.mjs";
import { getRolesState } from "../server/roles-api.mjs";
import { QUOTA_READING_MAX_AGE_MS, usageFromLimits } from "../server/limits-read.mjs";
import { decideArm, readArmCaps } from "../server/exp6-arm.mjs";
import { resolveLeadProfile } from "../server/lead-handoff.mjs";
import { seedDefaultPack } from "../server/vibesquad-api.mjs";
import { createPlugin, ROUTE_LABEL } from "../server/hooks/agent-duties.ts";
import { SPAWN_REASON, formatSoftReason } from "../server/spawn-reason.mjs";
import { SPAWN_REASON_GLOSS, drawerSoftReason, drawerSpawnWhy, isInterruptibleRole, landingPick, roleLandingPick, spawnChipTitle } from "../src/roleSpawn.ts";

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
  assert.equal(q65.softReason, "claude pool 65% >= soft 60: interruptible only");
  const q75 = isProviderOverQuota("claude", [row("claude", 75)], undefined, { softThresholds: { claude: 80 } });
  assert.equal(q75.softOverQuota, false);
});

test("3. normal & tierA-* Implement at 75% claude pool route to next family and name the soft line", () => {
  // Both agy-claude and claude at 75%, antigravity-cli at 20% -> Implement routes to antigravity-cli.
  const usage = [row(AGY_CLAUDE_FAMILY, 75), row("claude", 75), row("antigravity-cli", 20)];
  const caps = cappedFamilies(usage, [], { ignoreDiskCaps: true });
  const softCaps = softCappedFamilies(usage, [], { ignoreDiskCaps: true, stakes: "normal", role: "Implement" });
  assert.deepEqual(caps, []);
  assert.equal(softCaps.claude, "claude pool 75% >= soft 70: interruptible only");
  assert.equal(softCaps[AGY_CLAUDE_FAMILY], "agy-claude pool 75% >= soft 70: interruptible only");

  const hit = roleSpawnProfile("Implement", { stakes: "normal", caps, softCaps });
  assert.equal(hit.route.provider, "antigravity-cli");
  assert.equal(hit.route.softFailover, true);
  assert.equal(hit.route.softReason, "agy-claude pool 75% >= soft 70: interruptible only -> antigravity-cli");
  assert.ok(hit.route.reasons.includes("failover"));

  // tierA-invariant also skips soft-capped pools.
  const tierA = roleSpawnProfile("Implement", { stakes: "tierA-invariant", caps, softCaps });
  assert.equal(tierA.route.provider, "antigravity-cli");
  assert.equal(tierA.route.softFailover, true);
  assert.equal(tierA.route.softReason, "agy-claude pool 75% >= soft 70: interruptible only -> antigravity-cli");

  // Only agy-claude at 78%, direct claude at 20% -> routes to direct claude (next family in chain).
  const agyOnly = roleSpawnConfig("Implement", {
    stakes: "normal",
    usageList: [row(AGY_CLAUDE_FAMILY, 78), row("claude", 20), row("antigravity-cli", 20)],
  });
  assert.equal(agyOnly.route.provider, "claude");
  assert.equal(agyOnly.route.softFailover, true);
  assert.equal(agyOnly.route.softReason, "agy-claude pool 78% >= soft 70: interruptible only -> claude");

  // Legacy profile resolveProfileWithFailover: Implement - Sonnet at 78% claude -> Lead - Gemini with soft reason.
  const fo = resolveProfileWithFailover("Implement - Sonnet", DEFAULT_PACK_PROFILES, [row("claude", 78), row("antigravity-cli", 20)], { stakes: "normal" });
  assert.equal(fo.failedOver, true);
  assert.equal(fo.softFailover, true);
  assert.equal(fo.profile.name, "Lead - Gemini");
  assert.equal(fo.reason, "claude pool 78% >= soft 70: interruptible only -> antigravity-cli");
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
    assert.equal(pick.reason, "agy-claude pool 75% >= soft 70: interruptible only -> antigravity-cli");

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
    assert.equal(roleSoft.failover?.reason, "claude pool 78% >= soft 70: interruptible only -> antigravity-cli");

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
      assert.match(normal.labels[ROUTE_LABEL], /agy-claude pool 78% >= soft 70: interruptible only -> antigravity-cli/);
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

// ---- C fu1 (@per PLAN_PER_QUOTA_FIT_1126): the five lows of the Opus review (PASS 0/0/5), one test each ----

test("fu1 L1: legacy Check - Haiku (and Scout - Flash, Audit - DSF) count as interruptible on the server and the badge", () => {
  for (const role of ["Check - Haiku", "check_haiku", "Check  -  Haiku", "Scout - Flash", "Audit - DSF", "Pre-check - Flash"]) {
    assert.equal(isInterruptibleWork({ stakes: "normal", role }), true, role);
    assert.equal(isInterruptibleRole({ stakes: "normal", role }), true, `UI ${role}`);
  }
  assert.equal(isInterruptibleRole, isInterruptibleWork, "one definition: the badge imports the server's");
  for (const role of ["Review - Sonnet", "UX Reviewer - Opus", "Implement - Sonnet", "Lead - Claude"]) {
    assert.equal(isInterruptibleWork({ stakes: "normal", role }), false, role);
  }
  // The legacy failover keeps Check - Haiku on its pool past the soft line (under hard), as it does Pre-check - Flash.
  const haiku = DEFAULT_PACK_PROFILES.find((p) => p.name === "Check - Haiku");
  assert.ok(haiku, "Check - Haiku is in the default pack");
  const fam = haiku.provider;
  const fo = resolveProfileWithFailover("Check - Haiku", DEFAULT_PACK_PROFILES, [row(fam, 78), row("antigravity-cli", 10), row("claude", 10)]);
  assert.equal(fo.failedOver, false);
  assert.equal(fo.profile.name, "Check - Haiku");
});

test("fu1 L2: the New Agent badge (roles GET capped + softCapped + quotaUnknown) lands where the server routes at soft", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-badge-"));
  const prev = process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
  process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(dir, "none.json");
  try {
    const paths = { profilesPath: join(dir, "nope.json"), ladderPath: join(dir, "nol.json") };
    const cases = [
      [row(AGY_CLAUDE_FAMILY, 78), row("claude", 78), row("antigravity-cli", 20)], // soft Claude pools -> Gemini
      [row("claude", 75), row("antigravity-cli", 75), row("opencode", 30)], // agy-claude no row: known opencode first (L4)
      [row(AGY_CLAUDE_FAMILY, 50), row("claude", 96), row("antigravity-cli", 20)], // claude past hard
      [row(AGY_CLAUDE_FAMILY, 75), row("claude", 78), row("antigravity-cli", 80), row("opencode", 72)], // all past soft
    ];
    for (const usage of cases) {
      const body = getRolesState({ ...paths, usage });
      for (const stakes of ["normal", "tierA-invariant", "mechanical"]) {
        for (const roleKey of ["implement", "review", "planner", "pre-check"]) {
          const badge = roleLandingPick(roleKey, body.roles[roleKey], body.ladder, stakes, null, body);
          const srv = roleSpawnConfig(roleKey, { stakes, usageList: usage });
          assert.equal(badge.provider, srv.route.provider, `${roleKey} ${stakes} ${JSON.stringify(usage)}`);
        }
      }
    }
    const soft = getRolesState({ ...paths, usage: cases[0] });
    assert.equal(soft.softCapped.claude, "claude pool 78% >= soft 70: interruptible only");
    assert.deepEqual(soft.quotaUnknown, ["opencode"]);
    assert.ok(getRolesState({ ...paths, usage: cases[2] }).capped.includes("claude"), "a family past its hard line is capped on the badge too");
    const badge = roleLandingPick("implement", soft.roles.implement, soft.ladder, "normal", null, soft);
    assert.equal(badge.via, "soft"); // C fu2 m2: short badge label, no repeated route text
    assert.equal(badge.detail, "Claude (AGY) pool at 78%, soft line 70%; Claude pool at 78%, soft line 70%. Runs on Gemini.");
    // The dialog feeds the badge from that same GET (useProfiles), not the bare capped list.
    const tsx = readFileSync(new URL("../src/TeamActions.tsx", import.meta.url), "utf8");
    assert.match(tsx, /roleLandingPick\(roleKey, roleDef, ladder, stakes, override, quota\)/);
    assert.equal((tsx.match(/const quota: QuotaCaps = \{ capped, softCapped, quotaUnknown \};/g) ?? []).length, 2, "New Agent + Add Buddy");
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    else process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fu1 L3: the soft reason is its own reason (result, drawer, tooltip) and a soft skip is never reported as capped", async () => {
  // Arm picks: the alternation and the opt-in branch report soft, never capped.
  const softCaps = { claude: { reason: "pool 75% >= soft 70: interruptible only", quota: true, soft: true }, [AGY_CLAUDE_FAMILY]: { reason: "pool 75% >= soft 70: interruptible only", quota: true, soft: true } };
  const alt = await decideArm({ profile: "Implement", stakes: "normal", lane: "feat", team: "mx", listAgents: async () => [], capProbe: async () => softCaps });
  assert.equal(alt.arm, "neon");
  assert.equal(alt.soft, true);
  assert.equal(alt.capped, undefined, "soft is not capped");
  const gemSoft = { "antigravity-cli": { reason: "pool 80% >= soft 70: interruptible only", quota: true, soft: true } };
  const optIn = await decideArm({ profile: "Implement", stakes: "normal", labels: { ab: "flash" }, lane: "feat", team: "mx", listAgents: async () => [], capProbe: async () => gemSoft });
  assert.match(optIn.reason, /^antigravity-cli pool 80% >= soft 70: interruptible only -> /);
  assert.equal(optIn.soft, true);
  assert.equal(optIn.capped, undefined, "opt-in soft branch is not capped");
  const hard = await decideArm({ profile: "Implement", stakes: "normal", lane: "feat", team: "mx", listAgents: async () => [], capProbe: async () => ({ claude: { reason: "x", quota: true }, [AGY_CLAUDE_FAMILY]: { reason: "x", quota: true } }) });
  assert.equal(hard.capped, true, "a real cap still reports capped");

  // spawn_worker end to end over the real spawn hook: result.spawned says soft, result.soft names the line, ab never capped.
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-res-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const TEAMS = [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"], lanes: [{ id: "vibesquad", name: "Hub", hub: true, paths: ["VibeSquad"] }, { id: "feat", name: "Feat" }] }];
  writeFileSync(join(vsHome, "teams.json"), JSON.stringify({ teams: TEAMS }));
  writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: DEFAULT_PACK_PROFILES }));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH", "VS_DEFAULT_BACKEND", "VIBESQUAD_IGNORE_HOME_TEAMS", "VS_BACKEND"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { VIBESQUAD_HOME: vsHome, VIBESQUAD_TEAMS_FILE: join(vsHome, "teams.json"), VIBESQUAD_PROFILES_PATH: join(vsHome, "profiles.json"), VIBESQUAD_CAPPED_PROVIDERS_PATH: join(vsHome, "capped-providers.json"), VS_DEFAULT_BACKEND: "paseo", VIBESQUAD_IGNORE_HOME_TEAMS: "1" });
  delete process.env.VS_BACKEND;
  const before = new Map();
  const server = { before: (n, fn) => (before.set(n, fn), () => before.delete(n)), on: () => () => {} };
  const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {}, cappedProviders: {}, usageProviders: [row(AGY_CLAUDE_FAMILY, 78), row("claude", 78), row("antigravity-cli", 20)] })(server);
  try {
    const { callTool, createContext } = await import("../server/mcp/tools.mjs");
    const { verifiedIdentity } = await import("./helpers/agent-token.mjs");
    const agents = [];
    const ctxFor = (readCaps) => {
      const backend = {
        createAgent: async ({ config, labels, env }) => {
          const req = { config: { ...config, cwd: "/projects/VibeSquad/.worktrees/soft-res" }, labels: { ...labels }, env: { ...env } };
          const out = (await before.get("agent.create")({ request: req })) ?? req;
          const agent = { id: `rn-soft-${agents.length + 1}`, title: out.config.title, provider: out.config.provider, model: out.config.model, labels: out.labels };
          agents.push(agent);
          return agent;
        },
        sendAgentPrompt: async () => {},
        fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      };
      return createContext({
        env: { VIBESQUAD_HOME: vsHome },
        ...verifiedIdentity({ agentId: "rn-bud1", team: "vibesquad", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
        cwd: "/projects/VibeSquad/.worktrees/soft-res",
        teams: TEAMS,
        loadProfiles: async () => DEFAULT_PACK_PROFILES,
        readCaps,
        withBackend: async (_t, fn) => fn(backend),
        findLiveLeads: async () => [],
        writeLog: async () => {},
      });
    };
    // Hook route skips both Claude pools for their soft line.
    const res = await callTool(ctxFor(async () => ({})), "spawn_worker", { title: "t", prompt: "go", profile: "Implement", stakes: "normal", labels: { ab: "pin" } });
    assert.match(res.spawned, / · soft$/);
    assert.equal(res.soft, "Claude (AGY) pool at 78%, soft line 70%");
    assert.equal(res.ab?.capped, undefined);
    // Arm pick skipped the soft Claude arm: result.ab.soft, never capped, and the soft line named in the result.
    const armRes = await callTool(ctxFor(async () => softCaps), "spawn_worker", { title: "t2", prompt: "go", profile: "Implement", stakes: "normal" });
    assert.equal(armRes.ab.soft, true);
    assert.equal(armRes.ab.capped, undefined);
    assert.equal(armRes.soft, "Claude (AGY) pool at 75%, soft line 70%");
    assert.match(armRes.spawned, / · soft$/, "C fu2 L1: arm soft skip shows soft, not capped");
    // Drawer badge + tooltip read the same label.
    const labels = agents[0].labels;
    assert.equal(drawerSpawnWhy(labels, agents[0].model, false), "soft");
    assert.equal(drawerSoftReason(labels), "agy-claude pool 78% >= soft 70: interruptible only -> antigravity-cli");
    const title = spawnChipTitle({ role: "Implement", model: agents[0].model, reason: "soft", provider: "Gemini", softReason: drawerSoftReason(labels) });
    assert.equal(title, `Implement · ${agents[0].model}. Soft line: Claude (AGY) pool at 78% (line 70%), so a fallback ran. Runs on Gemini.`);
    assert.doesNotMatch(title, />=|->/);
    assert.doesNotMatch(title, /capped/);
  } finally {
    stop?.();
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fu1 L4: no-row (or stale) families rank after known-under-soft; capped stays skipped; none = first under hard", () => {
  // Claude + Gemini past soft, agy-claude has no row, opencode known at 30%: opencode, not the unread agy pool.
  const known = roleSpawnConfig("Implement", { stakes: "normal", usageList: [row("claude", 75), row("antigravity-cli", 75), row("opencode", 30)] });
  assert.equal(known.route.provider, "opencode");
  assert.equal(known.route.softFailover, true);
  assert.equal(known.route.softReason, "claude pool 75% >= soft 70: interruptible only -> opencode");
  // Same with opencode unread too: no known family under soft, so the first unread one in walk order (agy-claude).
  const unread = roleSpawnConfig("Implement", { stakes: "tierA-invariant", usageList: [row("claude", 75), row("antigravity-cli", 75)] });
  assert.equal(unread.route.provider, AGY_CLAUDE_FAMILY);
  // A capped family stays skipped (exhausted row = vs cap / disk cap), even when it is the only "known" one.
  const capped = roleSpawnConfig("Implement", { stakes: "normal", usageList: [{ id: "opencode", status: "exhausted", usedPct: 100 }, row("claude", 75), row("antigravity-cli", 75)] });
  assert.equal(capped.route.provider, AGY_CLAUDE_FAMILY);
  // No family past soft: walk order exactly as before C (an unread agy-claude is still first).
  const calm = roleSpawnConfig("Implement", { stakes: "normal", usageList: [row("claude", 20), row("antigravity-cli", 20)] });
  assert.equal(calm.route.provider, AGY_CLAUDE_FAMILY);
  assert.equal(calm.route.softFailover, false);
  // A no-row family ahead of a known one in the walk is ranked after it (reason names the unread family).
  const ahead = resolveRoute({ role: "implement", stakes: "normal", caps: [], softCaps: { "antigravity-cli": "pool 80% >= soft 70: interruptible only" }, unknown: [AGY_CLAUDE_FAMILY] });
  assert.equal(ahead.provider, "claude");
  assert.equal(ahead.softReason, `no quota row for ${AGY_CLAUDE_FAMILY}: ranked after known under soft -> claude`);
  // Interruptible work never ranks: walk order.
  assert.equal(resolveRoute({ role: "implement", stakes: "mechanical", softCaps: { claude: true }, unknown: [AGY_CLAUDE_FAMILY] }).provider, ladderFirst("implement", "mechanical"));
  // The stale cutoff is the usage reader's own (limits-read QUOTA_READING_MAX_AGE_MS): a stale row never reaches routing.
  const stale = usageFromLimits([{ at: iso(Date.now() - QUOTA_READING_MAX_AGE_MS - MIN), provider: "opencode", window: "5h", usedPct: 10, resetsAt: iso(Date.now() + 3600_000), source: "provider" }]);
  assert.deepEqual(unknownQuotaFamilies([...stale, row("claude", 75)]).sort(), ["agy-claude", "antigravity-cli", "opencode"]);
  // Legacy profile failover ranks the same way: known opencode before an unread Gemini.
  const fo = resolveProfileWithFailover("Implement - Sonnet", DEFAULT_PACK_PROFILES, [row("claude", 78), row("opencode", 30)], { stakes: "normal" });
  assert.equal(fo.failedOver, true);
  assert.equal(fo.softFailover, true);
  assert.equal(fo.profile.provider, "opencode", fo.profile.name);
  // UI mirror parity with unread families.
  for (const unknown of [[], [AGY_CLAUDE_FAMILY], [AGY_CLAUDE_FAMILY, "opencode"], ["opencode"]]) {
    for (const softCapped of [{}, { claude: "x" }, { claude: "x", "antigravity-cli": "y" }, { [AGY_CLAUDE_FAMILY]: "z" }]) {
      for (const stakes of ["normal", "tierA-invariant", "mechanical"]) {
        for (const roleKey of ["implement", "review", "lead", "planner"]) {
          const ui = landingPick(ROLE_TABLE[roleKey], DEFAULT_TIER_LADDER, stakes, { capped: [], softCapped, unknown, roleKey });
          const srv = resolveRoute({ role: roleKey, stakes, caps: [], softCaps: softCapped, unknown });
          assert.equal(ui.provider, srv.provider, `${roleKey} ${stakes} soft=${JSON.stringify(softCapped)} unknown=${unknown}`);
        }
      }
    }
  }
});

test("fu1 L5: a kind=docs worker respawned after a quota death stays interruptible (lands on its soft pool)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-respawn-"));
  const vsHome = join(dir, ".vibesquad");
  const cwd = join(dir, "VibeSquad");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(vsHome, "teams.json"), JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
  const caps = join(vsHome, "capped-providers.json");
  writeFileSync(caps, JSON.stringify({ capped: {} }));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_ROOT", "VIBESQUAD_CAPPED_PROVIDERS_PATH", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { VIBESQUAD_HOME: vsHome, VIBESQUAD_ROOT: join(dir, "root"), VIBESQUAD_CAPPED_PROVIDERS_PATH: caps });
  delete process.env.VIBESQUAD_TEAMS_FILE;
  delete process.env.VIBESQUAD_PROFILES_PATH;
  const { createRunnerHookHost } = await import("../server/backend/runner-hooks.mjs");
  const { spawnFamily } = await import("../server/provider-failover.mjs");
  const NOTICE = "⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h45m18s.";
  const respawn = async (id, extra) => {
    const agents = new Map();
    const created = [];
    const tl = [{ item: { type: "user_message", text: "Unit fu1: write the docs." } }, { item: { type: "assistant_message", text: NOTICE }, turnEnd: true }];
    const backend = {
      async getAgent(aid) { const a = agents.get(aid); if (!a) throw new Error(`no agent ${aid}`); return { ...a, labels: { ...a.labels } }; },
      async fetchAgentTimeline() { return { entries: tl.map((r, i) => ({ ...r, seqStart: i + 1, seqEnd: i + 1 })) }; },
      async listAgents() { return [...agents.values()].map((a) => ({ ...a, labels: { ...a.labels } })); },
      async createAgent({ config, prompt, labels: l }) {
        const a = { id: `rn-new-${id}-${created.length + 1}`, provider: config.provider, model: config.model, status: "running", labels: { ...l }, archivedAt: null };
        agents.set(a.id, a);
        created.push({ ...a, prompt });
        return { ...a };
      },
      async sendAgentPrompt() { return { queued: false }; },
      async archiveAgent() {},
      async updateAgent(aid, { labels: l } = {}) { const a = agents.get(aid); if (a && l) a.labels = { ...a.labels, ...l }; },
      async cancelAgent() {},
      async deleteHeartbeat() {},
    };
    const labels = { team: "vibesquad", lane: "bug-chaser", role: "worker", profile: "Implement", job: "fu1", ord: "1", stakes: "normal", "vs.parent": "rn-lead1", provider: "antigravity-cli", model: "claude-sonnet-5-5", ...extra };
    agents.set(id, { id, title: "fu1 · docs", cwd, provider: "antigravity-cli", model: "claude-sonnet-5-5", status: "idle", labels, archivedAt: null });
    // agy-claude died on its quota (capped); direct claude is past its soft line, Gemini has room.
    const host = await createRunnerHookHost(backend, { startWatcher: false, deps: { cappedProviders: [AGY_CLAUDE_FAMILY], usageProviders: [row("claude", 78), row("antigravity-cli", 20)], retryBaseMs: 30 }, pollMs: 20 });
    try {
      const agent = await backend.getAgent(id);
      await host.emit("agent.turn_ended", { agent, turnId: "2", outcome: { kind: "failed", error: { message: NOTICE } } });
      await host.emit("agent.upstream_exit", { agent, error: NOTICE, ts: Date.now(), quota: true });
    } finally {
      host.dispose();
    }
    return created;
  };
  try {
    const docs = await respawn("rn-fu1-docs", { kind: "docs" });
    assert.equal(docs.length, 1);
    assert.equal(spawnFamily(docs[0].provider, docs[0].model), "claude", "kind=docs is interruptible: its soft Claude pool still takes it");
    const normal = await respawn("rn-fu1-normal", {});
    assert.equal(normal.length, 1);
    assert.equal(spawnFamily(normal[0].provider, normal[0].model), "antigravity-cli", "normal work skips the soft Claude pool");
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});

function ladderFirst(roleKey, stakes) {
  return resolveRoute({ role: roleKey, stakes }).provider;
}

test("C fu2 m1/m3/L1: shared soft formatter, short soft gloss, arm soft-skip label distinct from cap", async () => {
  // Explicit family in text -> names the skipped family accurately (never guessed backwards from `-> target`).
  assert.equal(formatSoftReason("claude pool 78% >= soft 70: interruptible only -> antigravity-cli"), "Claude pool at 78%, soft line 70%");
  assert.equal(formatSoftReason("agy-claude pool 78% >= soft 70: interruptible only -> antigravity-cli"), "Claude (AGY) pool at 78%, soft line 70%");
  assert.equal(formatSoftReason("agy-claude pool 78% >= soft 70: interruptible only -> claude"), "Claude (AGY) pool at 78%, soft line 70%");
  assert.equal(formatSoftReason("antigravity-cli pool 80% >= soft 70: interruptible only -> claude"), "Gemini pool at 80%, soft line 70%");
  assert.equal(formatSoftReason("claude pool 75% >= soft 70: interruptible only -> opencode"), "Claude pool at 75%, soft line 70%");
  assert.equal(formatSoftReason("pool 61% >= soft 55: interruptible only", { family: "antigravity-cli" }), "Gemini pool at 61%, soft line 55%");
  assert.equal(formatSoftReason("no quota row for opencode: ranked after known under soft -> claude"), "No quota row for OpenCode");
  // Unknown family (unprefixed text, no opts.family) -> generic "Pool", never a guess from the landing target.
  assert.equal(formatSoftReason("pool 78% >= soft 70: interruptible only -> claude"), "Pool at 78%, soft line 70%");
  assert.equal(formatSoftReason("pool 78% >= soft 70: interruptible only -> antigravity-cli"), "Pool at 78%, soft line 70%");
  assert.equal(formatSoftReason("soft quota: interruptible only -> claude"), "Pool past its soft line");
  assert.equal(formatSoftReason("antigravity-cli soft quota: interruptible only -> claude"), "Gemini pool past its soft line");
  // Empty soft message with explicit family produces a clean sentence (not empty/malformed detail).
  assert.equal(formatSoftReason(""), "");
  assert.equal(formatSoftReason("", { family: "claude" }), "Claude pool past its soft line");
  assert.equal(formatSoftReason("", { family: "antigravity-cli" }), "Gemini pool past its soft line");
  for (const t of [formatSoftReason("claude pool 78% >= soft 70: x -> antigravity-cli"), formatSoftReason("soft quota: interruptible only -> claude")]) assert.doesNotMatch(t, />=|->/);
  const words = (t) => t.trim().split(/\s+/).length;
  assert.ok(words(SPAWN_REASON_GLOSS[SPAWN_REASON.SOFT]) <= 13, SPAWN_REASON_GLOSS[SPAWN_REASON.SOFT]);
  // same provider wording as failover gloss
  assert.match(SPAWN_REASON_GLOSS[SPAWN_REASON.SOFT], /preferred provider/);
  assert.match(SPAWN_REASON_GLOSS[SPAWN_REASON.FAILOVER], /preferred provider/);

  // neon -> sonnet arm soft skip names Gemini (never Claude (AGY)).
  const neonTurnAgents = [{ labels: { lane: "feat", team: "mx", role: "worker", stakes: "normal", "vs.arm": "sonnet" } }];
  const gemSoftCaps = { "antigravity-cli": { reason: "antigravity-cli pool 80% >= soft 70: interruptible only", quota: true, soft: true } };
  const neonToSonnet = await decideArm({ profile: "Implement", stakes: "normal", lane: "feat", team: "mx", listAgents: async () => neonTurnAgents, capProbe: async () => gemSoftCaps });
  assert.equal(neonToSonnet.arm, "sonnet");
  assert.equal(neonToSonnet.soft, true);
  assert.equal(neonToSonnet.reason, "antigravity-cli pool 80% >= soft 70: interruptible only -> claude");
  assert.equal(formatSoftReason(neonToSonnet.reason), "Gemini pool at 80%, soft line 70%");
  const neonTitle = spawnChipTitle({ role: "Implement", model: "claude-sonnet-5-5", reason: "soft", provider: "Claude", softReason: neonToSonnet.reason });
  assert.equal(neonTitle, "Implement · claude-sonnet-5-5. Soft line: Gemini pool at 80% (line 70%), so a fallback ran. Runs on Claude.");

  // Gemini-first role (Review) soft hop to Claude names Gemini.
  const reviewSoft = roleSpawnConfig("Review", { stakes: "normal", usageList: [row("antigravity-cli", 82), row(AGY_CLAUDE_FAMILY, 20), row("claude", 20)] });
  assert.equal(reviewSoft.route.softFailover, true);
  assert.equal(reviewSoft.route.softReason, "antigravity-cli pool 82% >= soft 70: interruptible only -> agy-claude");
  assert.equal(formatSoftReason(reviewSoft.route.softReason), "Gemini pool at 82%, soft line 70%");

  // agy-claude -> Gemini soft hop names Claude (AGY).
  const agyToGem = roleSpawnConfig("Implement", { stakes: "normal", usageList: [row(AGY_CLAUDE_FAMILY, 78), row("claude", 78), row("antigravity-cli", 20)] });
  assert.equal(agyToGem.route.provider, "antigravity-cli");
  assert.equal(formatSoftReason(agyToGem.route.softReason), "Claude (AGY) pool at 78%, soft line 70%");

  // -> opencode target names the skipped family.
  const toOpencode = roleSpawnConfig("Implement", { stakes: "normal", usageList: [row("claude", 75), row("antigravity-cli", 75), row("opencode", 30)] });
  assert.equal(toOpencode.route.provider, "opencode");
  assert.equal(formatSoftReason(toOpencode.route.softReason), "Claude pool at 75%, soft line 70%");

  // drawer: arm soft skip (no hook soft= text) reads soft; a hard cap skip does not; post-spawn model switch overrides soft.
  const armSoft = { "vs.model": "claude-sonnet-5-5", "vs.route": "reason=default why=arm", "vs.arm-reason": "antigravity-cli pool 80% >= soft 70: interruptible only -> claude" };
  assert.equal(drawerSpawnWhy(armSoft, "claude-sonnet-5-5", false), "soft");
  assert.equal(drawerSpawnWhy(armSoft, "claude-opus-5-5", false), "override", "post-spawn model switch overrides arm soft skip");
  assert.equal(drawerSoftReason(armSoft), "antigravity-cli pool 80% >= soft 70: interruptible only -> claude");
  const armCap = { "vs.route": "reason=default why=arm", "vs.arm-reason": "capped:claude" };
  assert.equal(drawerSpawnWhy(armCap, "m", false), "arm");
  assert.equal(drawerSoftReason(armCap), "");

  // landingPick with boolean/array softCapped (empty message) does not produce malformed ". Runs on ..." detail.
  const emptySoftArr = landingPick(ROLE_TABLE.lead, DEFAULT_TIER_LADDER, "normal", { softCapped: ["claude"], roleKey: "lead" });
  assert.equal(emptySoftArr.via, "soft");
  assert.equal(emptySoftArr.detail, "Claude pool past its soft line. Runs on Gemini.");
  const emptySoftBool = landingPick(ROLE_TABLE.lead, DEFAULT_TIER_LADDER, "normal", { softCapped: { claude: true }, roleKey: "lead" });
  assert.equal(emptySoftBool.detail, "Claude pool past its soft line. Runs on Gemini.");

  // Tooltip order: cause before result, "soft line" at most once per tooltip.
  const countSoftLine = (s) => (s.match(/soft line/gi) ?? []).length;
  for (const t of [
    spawnChipTitle({ role: "Implement", model: "gemini-4-neon", reason: "soft", provider: "Gemini", softReason: "claude pool 78% >= soft 70: interruptible only -> antigravity-cli" }),
    spawnChipTitle({ role: "Implement", model: "claude-sonnet-5-5", reason: "soft", provider: "Claude", softReason: "antigravity-cli soft quota: interruptible only -> claude" }),
    spawnChipTitle({ role: "Implement", model: "claude-sonnet-5-5", reason: "soft", provider: "Claude", softReason: "no quota row for agy-claude: ranked after known under soft -> claude" }),
    spawnChipTitle({ role: "Implement", model: "gemini-4-neon", reason: "soft", provider: "Gemini" }),
  ]) {
    assert.ok(countSoftLine(t) <= 1, `expected <=1 "soft line" in: ${t}`);
    assert.ok(t.endsWith("Runs on Gemini.") || t.endsWith("Runs on Claude."), `cause must precede result in: ${t}`);
  }
});

test("fu3: spawn_worker result.ab.provider reports the landed provider (soft hop, hard-cap failover, and non-soft unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-soft-fu3-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const TEAMS = [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"], lanes: [{ id: "vibesquad", name: "Hub", hub: true, paths: ["VibeSquad"] }, { id: "feat", name: "Feat" }] }];
  writeFileSync(join(vsHome, "teams.json"), JSON.stringify({ teams: TEAMS }));
  writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: DEFAULT_PACK_PROFILES }));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH", "VIBESQUAD_CAPPED_PROVIDERS_PATH", "VS_DEFAULT_BACKEND", "VIBESQUAD_IGNORE_HOME_TEAMS", "VS_BACKEND"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { VIBESQUAD_HOME: vsHome, VIBESQUAD_TEAMS_FILE: join(vsHome, "teams.json"), VIBESQUAD_PROFILES_PATH: join(vsHome, "profiles.json"), VIBESQUAD_CAPPED_PROVIDERS_PATH: join(vsHome, "capped-providers.json"), VS_DEFAULT_BACKEND: "paseo", VIBESQUAD_IGNORE_HOME_TEAMS: "1" });
  delete process.env.VS_BACKEND;
  try {
    const { callTool, createContext } = await import("../server/mcp/tools.mjs");
    const { verifiedIdentity } = await import("./helpers/agent-token.mjs");
    const runScenario = async ({ usageProviders = [], cappedProviders = {}, seedAgents = [] }) => {
      const before = new Map();
      const server = { before: (n, fn) => (before.set(n, fn), () => before.delete(n)), on: () => () => {} };
      const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {}, applyAgentSettings: async () => {}, refuseAgent: async () => {}, cappedProviders, usageProviders })(server);
      const agents = [...seedAgents];
      const logs = [];
      const backend = {
        createAgent: async ({ config, labels, env }) => {
          const req = { config: { ...config, cwd: "/projects/VibeSquad/.worktrees/soft-fu3" }, labels: { ...labels }, env: { ...env } };
          const out = (await before.get("agent.create")({ request: req })) ?? req;
          const agent = { id: `rn-fu3-${agents.length + 1}`, title: out.config.title, provider: out.config.provider, model: out.config.model, labels: out.labels };
          agents.push(agent);
          return agent;
        },
        sendAgentPrompt: async () => {},
        fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      };
      const ctx = createContext({
        env: { VIBESQUAD_HOME: vsHome },
        ...verifiedIdentity({ agentId: "rn-bud1", team: "vibesquad", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
        cwd: "/projects/VibeSquad/.worktrees/soft-fu3",
        teams: TEAMS,
        loadProfiles: async () => DEFAULT_PACK_PROFILES,
        readCaps: async () => ({}),
        withBackend: async (_t, fn) => fn(backend),
        findLiveLeads: async () => [],
        writeLog: async (e) => { logs.push(e); },
      });
      try {
        const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement", stakes: "normal" });
        return { res, agent: agents[agents.length - 1], logs };
      } finally {
        stop?.();
      }
    };

    // 1. Soft-capped agy-claude: sonnet arm lands on claude direct -> ab.provider === "claude".
    const soft = await runScenario({ usageProviders: [row(AGY_CLAUDE_FAMILY, 83), row("claude", 20), row("antigravity-cli", 20)] });
    assert.equal(soft.agent.provider, "claude");
    assert.equal(soft.res.ab.arm, "sonnet");
    assert.equal(soft.res.ab.provider, "claude");
    assert.equal(soft.res.ab.model, "claude-sonnet-5-5");
    assert.equal(soft.res.spawned, "Implement · claude-sonnet-5-5 · soft");
    assert.equal(soft.res.soft, "Claude (AGY) pool at 83%, soft line 70%");
    assert.match(soft.logs[0].text, /Implement@claude\b/);

    // 2. Hard-cap failover in hook: neon arm lands on claude direct -> ab.provider === "claude" and route shows -> claude.
    const hard = await runScenario({
      cappedProviders: { "antigravity-cli": { capped: true }, [AGY_CLAUDE_FAMILY]: { capped: true } },
      seedAgents: [{ createdAt: "2026-11-27T00:00:00Z", labels: { team: "vibesquad", lane: "feat", role: "worker", "vs.arm": "sonnet" } }],
    });
    assert.equal(hard.agent.provider, "claude");
    assert.equal(hard.res.ab.arm, "neon");
    assert.equal(hard.res.ab.provider, "claude");
    assert.match(hard.res.route, /\(Implement -> claude\)$/);
    assert.match(hard.logs[0].text, /Implement@claude\b/);

    // 3. Non-soft plain alternation: sonnet arm lands on agy-claude (antigravity-cli) -> unchanged.
    const plain = await runScenario({ usageProviders: [row(AGY_CLAUDE_FAMILY, 20), row("claude", 20), row("antigravity-cli", 20)] });
    assert.equal(plain.agent.provider, "antigravity-cli");
    assert.equal(plain.res.ab.arm, "sonnet");
    assert.equal(plain.res.ab.provider, "antigravity-cli");
    assert.equal(plain.res.ab.model, "claude-sonnet-5-5-medium");
    assert.equal(plain.res.spawned, "Implement · claude-sonnet-5-5-medium · arm");
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});
