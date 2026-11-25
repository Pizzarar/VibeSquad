import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PACK_PROFILES, LEGACY_PROFILE_ALIASES } from "../server/profiles.mjs";
import { COUNTERPART_PROFILES, ROLE_FAILOVER_CHAINS, ROLE_PROVIDER_CHAINS } from "../server/provider-failover.mjs";
import { LEGACY_HOP_PROFILES, LEGACY_ROUTES, ROLE_TABLE, lookupRole, resolveRoute } from "../server/role-route.mjs";
import {
  DEFAULT_TIER_LADDER,
  STAKES_VALUES,
  TIERS,
  loadTierLadder,
  routeProviderFamily,
  stakesTier,
} from "../server/stakes-ladder.mjs";
import { A, C, CAP_SETS, GOLDEN, O, TODAY_FIXTURE, USER_PROFILES, pick, row, today } from "./helpers/route-golden.mjs";

const OPUS_MED = row(C, "claude-opus-5-5", "medium", "auto");
const SONNET_MED = row(C, "claude-sonnet-5-5", "medium", "auto");
const NEON_AE = row(A, "gemini-4-neon", "medium", "accept-edits");
const NEON_DEF = row(A, "gemini-4-neon", "medium", "default");
const DSP = row(O, "deepseek/deepseek-v4-pro", "high", "build");
const AGY = "agy-claude"; // R10: Claude on agy, walked just before direct claude by worker roles

// Failover golden (normal stakes): [name, caps, expected]. Own provider capped, then own + the first hop's provider.
const FAILOVER_GOLDEN = [
  ["Lead - Claude", [C], NEON_AE],
  ["Lead - Claude", [C, A], DSP],
  ["Lead - Gemini", [A], OPUS_MED],
  ["Lead - Gemini", [A, C], DSP],
  ["Brainstorm - Claude", [C], NEON_AE],
  ["Brainstorm - Claude", [C, A], DSP],
  ["Brainstorm - Gemini", [A], OPUS_MED],
  ["Brainstorm - Gemini", [A, C], DSP],
  ["Implement - Sonnet", [C], NEON_AE],
  ["Implement - Sonnet", [C, A], DSP],
  ["Work Order - DSP", [O], SONNET_MED],
  ["Work Order - DSP", [O, C], NEON_AE],
  ["Review - Gemini", [A], SONNET_MED],
  ["Review - Gemini", [A, C], DSP],
  ["Review - Sonnet", [C], NEON_DEF],
  ["Review - Sonnet", [C, A], DSP],
  ["Pre-check - Flash", [A], row(C, "claude-haiku-5-5", "low", "auto")],
  ["Pre-check - Flash", [A, C], row(O, "deepseek/deepseek-flash", "default", "plan")],
  ["Art Director - Gemini", [A], OPUS_MED],
  ["Art Director - Gemini", [A, C], DSP],
  ["Art Painter - Opus", [C], NEON_AE],
  ["Art Painter - Opus", [C, A], DSP],
  ["Implement - Gemini (trial)", [A], SONNET_MED],
  ["Implement - Gemini (trial)", [A, C], DSP],
];

test("golden: the 12 current profile names resolve to exactly today's provider/model/effort/mode", () => {
  assert.equal(GOLDEN.length, 12);
  // P5b adds more legacy names (role labels), so the 12 golden names are a subset of the table, not all of it.
  const tableNames = new Set(Object.keys(LEGACY_ROUTES));
  for (const g of GOLDEN) assert.ok(tableNames.has(g.name), `golden name missing from LEGACY_ROUTES: ${g.name}`);
  for (const g of GOLDEN) {
    const r = resolveRoute({ role: g.name, stakes: "normal" });
    assert.deepEqual(pick(r), row(g.provider, g.model, g.effort, g.modeId), g.name);
    assert.deepEqual([r.reason, r.legacy, r.capped], ["legacy-name", g.name, false], g.name);
  }
});

test("golden failover: 24 rows (each name with its own provider capped, then two providers capped)", () => {
  assert.equal(FAILOVER_GOLDEN.length, 24);
  for (const [name, caps, want] of FAILOVER_GOLDEN) {
    const r = resolveRoute({ role: name, caps });
    assert.deepEqual(pick(r), want, `${name} caps=${caps}`);
    assert.deepEqual(r.reasons, ["legacy-name", "failover"], `${name} caps=${caps}`);
    assert.deepEqual(pick(r), today(name, caps, "normal"), `${name} caps=${caps} vs today`);
  }
});

test("golden aliases: bare Lead / Brainstorm stay today's Lead - Claude / Brainstorm - Claude (opus/medium)", () => {
  for (const [alias, target] of [["Lead", "Lead - Claude"], ["Brainstorm", "Brainstorm - Claude"]]) {
    const r = resolveRoute({ role: alias, stakes: "normal" });
    assert.deepEqual(pick(r), OPUS_MED, alias);
    assert.deepEqual([r.reason, r.legacy, r.alias], ["legacy-name", target, alias]);
  }
  // other spellings reach the new role and follow the ladder
  const lr = resolveRoute({ role: "lead" });
  assert.deepEqual([lr.model, lr.effort, lr.reason, lr.legacy], ["claude-opus-5-5", "high", "default", null]);
});

test("pinned today() fixture (b634cc9a, Sonnet L3) covers every old name + alias x cap set x stakes value, nothing else", () => {
  const names = [...GOLDEN.map((g) => g.name), ...Object.keys(LEGACY_PROFILE_ALIASES)];
  assert.deepEqual(Object.keys(TODAY_FIXTURE.index).sort(), [...names].sort());
  const capKeys = CAP_SETS.map((c) => [C, A, O].filter((f) => c.includes(f)).join(",")).sort();
  const stakesKeys = [...STAKES_VALUES, "(none)", "bogus"].sort();
  for (const name of names) {
    assert.deepEqual(Object.keys(TODAY_FIXTURE.index[name]).sort(), capKeys, name);
    for (const ck of capKeys) {
      const byStakes = TODAY_FIXTURE.index[name][ck];
      assert.deepEqual(Object.keys(byStakes).sort(), stakesKeys, `${name} caps=${ck}`);
      for (const i of Object.values(byStakes)) assert.ok(Array.isArray(TODAY_FIXTURE.rows[i]) && TODAY_FIXTURE.rows[i].length === 4, `${name} caps=${ck} row ${i}`);
    }
  }
  // No cap: each golden name lands on its own profile at normal stakes.
  for (const g of GOLDEN) assert.deepEqual(today(g.name, [], "normal"), row(g.provider, g.model, g.effort, g.modeId), g.name);
});

test("exhaustive: every legacy name and alias x every cap set x every stakes value == today's code", () => {
  const names = [...GOLDEN.map((g) => g.name), ...Object.keys(LEGACY_PROFILE_ALIASES)];
  let n = 0;
  for (const name of names) {
    for (const caps of CAP_SETS) {
      for (const s of [...STAKES_VALUES, undefined, "bogus"]) {
        const r = resolveRoute({ role: name, stakes: s, caps });
        assert.deepEqual(pick(r), today(name, caps, s), `${name} caps=[${caps}] stakes=${s}`);
        assert.equal(r.capped, caps.length === 3, `${name} caps=[${caps}]`);
        n++;
      }
    }
  }
  assert.equal(n, names.length * 8 * 6);
});

test("golden rows and hop pins match the shipped profile definitions", () => {
  for (const [name, hop] of Object.entries(LEGACY_HOP_PROFILES)) {
    const p = DEFAULT_PACK_PROFILES.find((x) => x.name === name);
    if (name === "Implement - Gemini (trial)") {
      assert.equal(p, undefined); // user-file only
      const g = GOLDEN.find((x) => x.name === name);
      assert.deepEqual(hop, row(g.provider, g.model, g.effort, g.modeId));
      continue;
    }
    assert.ok(p, name);
    assert.deepEqual(hop, row(p.provider, p.model, p.thinkingOptionId, p.modeId), name);
  }
  for (const g of GOLDEN) assert.deepEqual(LEGACY_HOP_PROFILES[g.name], row(g.provider, g.model, g.effort, g.modeId), g.name);
});

test("done check: Implement + tierA-invariant -> agy-claude opus-5-5-high (R10), direct claude opus-5-5/high when agy-claude is capped", () => {
  const r = resolveRoute({ role: "Implement", stakes: "tierA-invariant" });
  assert.deepEqual([r.provider, r.model, r.effort, r.modeId, r.tier, r.reason], [AGY, "claude-opus-5-5-high", "high", "accept-edits", "top", "stakes"]);
  const d = resolveRoute({ role: "Implement", stakes: "tierA-invariant", caps: [AGY] });
  assert.deepEqual([d.provider, d.model, d.effort, d.modeId, d.tier, d.reasons], [C, "claude-opus-5-5", "high", "auto", "top", ["failover", "stakes"]]);
});

test("done check: Review + normal -> gemini-4-neon (antigravity first)", () => {
  const r = resolveRoute({ role: "Review", stakes: "normal" });
  assert.deepEqual(pick(r), NEON_DEF);
  assert.deepEqual([r.tier, r.reason], ["mid", "default"]);
  assert.equal(resolveRoute({ role: "review" }).provider, A); // missing stakes = normal
});

test("done check: capped claude + Lead -> antigravity top rung", () => {
  for (const caps of [[C], new Set(["anthropic"]), { claude: true, opencode: false }]) {
    const r = resolveRoute({ role: "lead", stakes: "normal", caps });
    assert.deepEqual(pick(r), row(A, "gemini-4-neon", "high", "accept-edits"));
    assert.deepEqual([r.tier, r.reason, r.capped], ["top", "failover", false]);
  }
});

test("role names keep today's third failover hop (two providers capped)", () => {
  const cases = [
    ["lead", [C, A], row(O, "deepseek/deepseek-v4-pro", "high", "build")],
    // R10: worker roles also walk agy-claude (before claude), so it is capped too to reach the third hop.
    ["Implement", [AGY, C, A], row(O, "deepseek/deepseek-v4-pro", "high", "build")],
    ["Work Order", [O, AGY, C], row(A, "gemini-4-neon", "medium", "accept-edits")],
    ["Review", [A, AGY, C], row(O, "deepseek/deepseek-v4-pro", "high", "build")],
    ["Pre-check", [A, C], row(O, "deepseek/deepseek-flash", "default", "plan")], // cheap tier on opencode = Flash (R7); no agy rung
    ["Art Director", [A, AGY, C], row(O, "deepseek/deepseek-v4-pro", "high", "build")],
    ["Art Painter", [AGY, C, A], row(O, "deepseek/deepseek-v4-pro", "high", "build")],
  ];
  for (const [role, caps, want] of cases) {
    const r = resolveRoute({ role, caps });
    assert.deepEqual(pick(r), want, role);
    assert.deepEqual(r.reasons, ["failover"], role);
  }
  for (const [k, r] of Object.entries(ROLE_TABLE)) assert.equal(r.providers.length, 3, k);
});

test("explicit wins; explicit on a capped provider is reported (capped + explicit-capped)", () => {
  const r = resolveRoute({ role: "Implement", stakes: "tierA-invariant", explicit: { model: "claude-sonnet-5-5" } });
  assert.deepEqual([r.provider, r.model, r.effort, r.reason, r.capped], [C, "claude-sonnet-5-5", "high", "explicit", false]);
  assert.deepEqual(r.reasons, ["explicit", "stakes"]);
  const all = resolveRoute({
    role: "Review",
    stakes: "mechanical",
    caps: [C],
    explicit: { provider: "claude", model: "claude-fable-5-2", thinkingOptionId: "max", modeId: "plan" },
  });
  assert.deepEqual(pick(all), row(C, "claude-fable-5-2", "max", "plan"));
  assert.deepEqual([all.reason, all.capped], ["explicit-capped", true]);
  assert.deepEqual(all.reasons, ["explicit-capped", "explicit", "stakes"]);
  // a model naming its own family moves the provider with it; on a capped family it is flagged, not rerouted
  const m = resolveRoute({ role: "Review", explicit: { model: "claude-opus-5-5" } });
  assert.deepEqual([m.provider, m.model, m.effort, m.modeId, m.capped], [C, "claude-opus-5-5", "medium", "auto", false]);
  const mc = resolveRoute({ role: "Review - Gemini", caps: ["anthropic"], explicit: { model: "claude-opus-5-5" } });
  assert.deepEqual([mc.provider, mc.model, mc.reason, mc.capped], [C, "claude-opus-5-5", "explicit-capped", true]);
  assert.deepEqual(mc.reasons, ["explicit-capped", "explicit", "legacy-name"]);
});

test("stakes shift the tier: tierA-* -> top, mechanical -> cheap, normal -> role default", () => {
  assert.equal(stakesTier("tierA-security"), "top");
  assert.equal(stakesTier("tierA-invariant"), "top");
  assert.equal(stakesTier("mechanical"), "cheap");
  for (const s of ["normal", undefined, "", "bogus"]) assert.equal(stakesTier(s), null);
  const tiers = Object.fromEntries(Object.keys(ROLE_TABLE).map((k) => [k, resolveRoute({ role: k }).tier]));
  assert.deepEqual(tiers, {
    lead: "top",
    brainstorm: "top",
    planner: "mid",
    implement: "mid",
    "work-order": "mid",
    review: "mid",
    "pre-check": "cheap",
    "art-director": "mid",
    "art-painter": "top",
  });
  assert.equal(resolveRoute({ role: "Pre-check", stakes: "tierA-security" }).model, "gemini-4-neon");
  // A2 (idea-986): mechanical walks the cheap order (Gemini Flash > Claude Haiku > opencode), also for a claude-first role.
  const lm = resolveRoute({ role: "lead", stakes: "mechanical" });
  assert.deepEqual([lm.provider, lm.model, lm.effort, lm.tier], [A, "gemini-3.8-flash", "medium", "cheap"]);
  const lmA = resolveRoute({ role: "lead", stakes: "mechanical", caps: [A] });
  assert.deepEqual([lmA.provider, lmA.model, lmA.effort, lmA.tier], [C, "claude-haiku-5-5", "low", "cheap"]);
});

test("R7: opencode cheap rung is DeepSeek Flash (mechanical + cheap-tier roles); top/mid stay v4-pro; claude cheap = Haiku (A2); gemini rungs unchanged", () => {
  assert.deepEqual(DEFAULT_TIER_LADDER.opencode, {
    top: { model: "deepseek/deepseek-v4-pro", effort: "high" },
    mid: { model: "deepseek/deepseek-v4-pro" },
    cheap: { model: "deepseek/deepseek-flash" },
  });
  assert.deepEqual(DEFAULT_TIER_LADDER.claude, {
    top: { model: "claude-opus-5-5", effort: "high" },
    mid: { model: "claude-sonnet-5-5", effort: "medium" },
    cheap: { model: "claude-haiku-5-5", effort: "low" }, // A2 idea-986: was sonnet/low
  });
  assert.deepEqual(DEFAULT_TIER_LADDER[A], {
    top: { model: "gemini-4-neon", effort: "high" },
    mid: { model: "gemini-4-neon" },
    cheap: { model: "gemini-3.8-flash" },
  });
  const wo = (stakes) => resolveRoute({ role: "work-order", stakes, caps: [] });
  // A2 (idea-986): mechanical walks Gemini Flash > Claude Haiku > opencode, so the DeepSeek Flash rung is reached only
  // when both others are capped (cheap tier never resolves to DeepSeek by default).
  assert.deepEqual([wo("mechanical").provider, wo("mechanical").model, wo("mechanical").tier], [A, "gemini-3.8-flash", "cheap"]);
  const woLast = resolveRoute({ role: "work-order", stakes: "mechanical", caps: [A, C] });
  assert.deepEqual([woLast.provider, woLast.model, woLast.tier], [O, "deepseek/deepseek-flash", "cheap"]);
  assert.deepEqual([wo("normal").model, wo("normal").tier], ["deepseek/deepseek-v4-pro", "mid"]);
  assert.deepEqual([wo("tierA-invariant").model, wo("tierA-invariant").effort, wo("tierA-invariant").tier], ["deepseek/deepseek-v4-pro", "high", "top"]);
  // legacy name Work Order - DSP + mechanical lands on Flash too (the 38 mechanical DSP spawns in EXP6.md)
  const legacy = resolveRoute({ role: "Work Order - DSP", stakes: "mechanical", caps: [] });
  assert.deepEqual([legacy.provider, legacy.model], [O, "deepseek/deepseek-flash"]);
});

test("role table: 9 roles, every preferred provider has a ladder and a mode; lookup order", () => {
  assert.equal(Object.keys(ROLE_TABLE).length, 9);
  for (const [k, r] of Object.entries(ROLE_TABLE)) {
    assert.ok(TIERS.includes(r.tier), k);
    for (const p of r.providers) {
      assert.ok(DEFAULT_TIER_LADDER[p], `${k}/${p} ladder`);
      assert.ok(r.modes[p]?.modeId, `${k}/${p} mode`);
    }
  }
  assert.deepEqual(ROLE_TABLE.review.providers, [A, C, O]);
  for (const n of ["Work Order", "work-order", "WORK_ORDER", " work order "]) assert.equal(lookupRole(n)?.key, "work-order", n);
  assert.equal(lookupRole("review - gemini")?.legacy?.name, "Review - Gemini");
  assert.equal(lookupRole("Art Painter")?.key, "art-painter");
  assert.equal(lookupRole("Lead")?.legacy?.name, "Lead - Claude");
  assert.equal(lookupRole("Reviewer")?.legacy?.name, "Review - Gemini");
  assert.equal(lookupRole("lead")?.legacy, null);
});

test("R1: ROLE_TABLE.providers reads the role-keyed failover chains; old-name chains stay as they were", () => {
  assert.deepEqual(Object.keys(ROLE_PROVIDER_CHAINS).sort(), Object.keys(ROLE_TABLE).sort());
  for (const [k, r] of Object.entries(ROLE_TABLE)) {
    assert.deepEqual(r.providers, [...ROLE_PROVIDER_CHAINS[k]], k);
    assert.notEqual(r.providers, ROLE_PROVIDER_CHAINS[k], `${k}: a copy, not the shared array`);
    assert.ok(Object.isFrozen(ROLE_PROVIDER_CHAINS[k]), k);
  }
  assert.deepEqual(ROLE_PROVIDER_CHAINS["work-order"], [O, C, A]);
  // Old names keep their own hop tables (read-only until R5): unchanged by the role table.
  assert.equal(COUNTERPART_PROFILES["Work Order - DSP"], "Implement - Sonnet");
  assert.deepEqual(ROLE_FAILOVER_CHAINS["Implement - Sonnet"], ["Lead - Gemini", "Work Order - DSP"]);
});

test("unknown role -> null; unknown role with an explicit provider still routes", () => {
  assert.equal(resolveRoute({ role: "Nope" }), null);
  assert.equal(resolveRoute({}), null);
  const r = resolveRoute({ role: "Nope", explicit: { provider: "codex", model: "gpt-x" } });
  assert.deepEqual([r.provider, r.model, r.effort, r.modeId, r.reason, r.role], ["codex", "gpt-x", undefined, undefined, "explicit", null]);
});

test("all providers capped -> first preference kept, reason all-capped, capped=true", () => {
  const r = resolveRoute({ role: "review", caps: [A, AGY, C, O] });
  assert.deepEqual([r.provider, r.model, r.reason, r.capped], [A, "gemini-4-neon", "all-capped", true]);
  const l = resolveRoute({ role: "Lead - Gemini", caps: [A, C, O] });
  assert.deepEqual([pick(l), l.reasons, l.capped], [NEON_AE, ["legacy-name", "all-capped"], true]);
});

test("ladder inputs are honoured and the resolver never mutates them", () => {
  const ladder = loadTierLadder(join(tmpdir(), "vs-role-route-missing.json"));
  ladder.claude.mid = { model: "claude-x", effort: "max" };
  const snapshot = JSON.stringify(ladder);
  const r = resolveRoute({ role: "Implement", ladder, caps: [AGY] });
  assert.deepEqual([r.model, r.effort], ["claude-x", "max"]);
  assert.equal(JSON.stringify(ladder), snapshot);
  // the tier ladder does not touch legacy names; the old stakes ladder does
  assert.equal(resolveRoute({ role: "Implement - Sonnet", ladder }).model, "claude-sonnet-5-5");
  const stakesLadder = { claude: { "tierA-invariant": { model: "claude-y", effort: "max" } } };
  const lr = resolveRoute({ role: "Implement - Sonnet", stakes: "tierA-invariant", stakesLadder });
  assert.deepEqual([lr.model, lr.effort, lr.modeId], ["claude-y", "max", "auto"]);
  assert.ok(Object.isFrozen(DEFAULT_TIER_LADDER.claude.top));
  assert.ok(Object.isFrozen(ROLE_TABLE.lead.modes.claude));
  assert.ok(Object.isFrozen(LEGACY_ROUTES["Lead - Claude"].via));
});

test("tier ladder override: old stakes keys migrate onto top/cheap, tier keys win, fields merge, fable dropped, bad file = defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-tier-"));
  try {
    const f = join(dir, "stakes-ladder.json");
    writeFileSync(
      f,
      JSON.stringify({
        claude: { "tierA-invariant": { model: "claude-a" }, "tierA-security": { model: "claude-b" }, mechanical: { effort: "minimal" } },
        gemini: { "tierA-security": { model: "gemini-z" }, top: { effort: "max" }, cheap: { model: "claude-fable-5-2" } },
        opencode: { mid: { effort: "low" }, normal: { model: "ignored" } },
      }),
    );
    const l = loadTierLadder(f);
    assert.deepEqual(l.claude.top, { model: "claude-b", effort: "high" }); // tierA-security beats tierA-invariant, effort kept
    assert.deepEqual(l.claude.cheap, { model: "claude-haiku-5-5", effort: "minimal" }); // A2: default cheap model is Haiku
    assert.deepEqual(l.claude.mid, DEFAULT_TIER_LADDER.claude.mid);
    assert.deepEqual(l[A].top, { model: "gemini-z", effort: "max" });
    assert.deepEqual(l[A].cheap, DEFAULT_TIER_LADDER[A].cheap); // fable never a rung
    assert.deepEqual(l.opencode.mid, { model: "deepseek/deepseek-v4-pro", effort: "low" });
    // the user's real override shape today (claude tierA-security) lands on top unchanged
    writeFileSync(f, "﻿" + JSON.stringify({ ladder: { claude: { "tierA-security": { model: "claude-opus-5-5", effort: "high" } } } }));
    assert.deepEqual(loadTierLadder(f), DEFAULT_TIER_LADDER);
    writeFileSync(f, "{nope");
    assert.deepEqual(loadTierLadder(f), DEFAULT_TIER_LADDER);
    assert.deepEqual(loadTierLadder(join(dir, "missing.json")), DEFAULT_TIER_LADDER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deepseek key in the ladder file maps to opencode", () => {
  assert.equal(routeProviderFamily("deepseek"), O);
  assert.equal(routeProviderFamily("deepseek/deepseek-v4-pro"), O);
  assert.equal(routeProviderFamily("gemini"), A);
  const dir = mkdtempSync(join(tmpdir(), "vs-tier-ds-"));
  try {
    const f = join(dir, "stakes-ladder.json");
    writeFileSync(f, JSON.stringify({ deepseek: { top: { model: "deepseek/deepseek-v5" }, mechanical: { effort: "low" } } }));
    const l = loadTierLadder(f);
    assert.deepEqual(l.opencode.top, { model: "deepseek/deepseek-v5", effort: "high" });
    assert.deepEqual(l.opencode.cheap, { model: "deepseek/deepseek-flash", effort: "low" }); // legacy mechanical key folds onto cheap, model kept
    assert.equal(l.deepseek, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1: planner role (mid, claude first) and work-order hidden from listings but still routing DSP-first", async () => {
  const { isHiddenRole, listedRoleKeys } = await import("../server/role-route.mjs");
  assert.deepEqual([ROLE_TABLE.planner.tier, ROLE_TABLE.planner.providers], ["mid", [C, A, O]]);
  for (const n of ["Planner", "planner", " PLANNER "]) assert.equal(lookupRole(n)?.key, "planner", n);
  const r = resolveRoute({ role: "Planner" });
  assert.deepEqual([r.provider, r.model, r.reason], [AGY, "claude-sonnet-5-5-medium", "default"]); // R10
  assert.deepEqual([resolveRoute({ role: "Planner", caps: [AGY] }).provider, resolveRoute({ role: "Planner", caps: [AGY] }).model], [C, "claude-sonnet-5-5"]);
  assert.equal(resolveRoute({ role: "Planner", caps: [AGY, C] }).provider, A);
  // old names keep their exact routing; only the role stamp moved implement -> planner
  assert.equal(resolveRoute({ role: "Spec - Opus" }).role, "planner");
  assert.equal(resolveRoute({ role: "Spec - Opus" }).model, "claude-opus-5-5");
  assert.equal(resolveRoute({ role: "Planner - Sonnet", caps: [C] }).hop, "Lead - Gemini");
  // work-order: still resolves opencode-first, but a listing leaves it out
  assert.equal(resolveRoute({ role: "Work Order" }).provider, O);
  assert.equal(isHiddenRole("work-order"), true);
  assert.equal(isHiddenRole("implement"), false);
  assert.deepEqual(listedRoleKeys(), Object.keys(ROLE_TABLE).filter((k) => k !== "work-order"));
  assert.equal(isHiddenRole("work-order", { "work-order": { name: "Work Order" } }), true, "a stored role keeps the shipped flag");
});
