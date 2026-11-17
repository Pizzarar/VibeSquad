import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";
import { LEGACY_ROUTES, ROLE_TABLE, lookupRole, resolveRoute } from "../server/role-route.mjs";
import {
  DEFAULT_STAKES_LADDER,
  DEFAULT_TIER_LADDER,
  STAKES_VALUES,
  TIERS,
  loadTierLadder,
  resolveStakesRoute,
  stakesTier,
} from "../server/stakes-ladder.mjs";

// Golden table: the 12 profiles in ~/.vibesquad/profiles.json on 2026-11-17 and the provider/model/effort/mode each one
// spawns with today at normal stakes (profile fields; the stakes ladder does not apply at normal). 11 of them are also
// shipped in DEFAULT_PACK_PROFILES (checked below); "Implement - Gemini (trial)" exists only in the user file.
const GOLDEN = [
  ["Lead - Claude", "claude", "claude-opus-5-5", "medium", "auto"],
  ["Lead - Gemini", "antigravity-cli", "gemini-4-argon", "medium", "accept-edits"],
  ["Brainstorm - Claude", "claude", "claude-opus-5-5", "medium", "auto"],
  ["Brainstorm - Gemini", "antigravity-cli", "gemini-4-argon", "medium", "accept-edits"],
  ["Implement - Sonnet", "claude", "claude-sonnet-5-5", "medium", "auto"],
  ["Work Order - DSP", "opencode", "deepseek/deepseek-v4-pro", "high", "build"],
  ["Review - Gemini", "antigravity-cli", "gemini-4-argon", "medium", "default"],
  ["Review - Sonnet", "claude", "claude-sonnet-5-5", "medium", "auto"],
  ["Pre-check - Flash", "antigravity-cli", "gemini-3.8-flash", "low", "default"],
  ["Art Director - Gemini", "antigravity-cli", "gemini-4-argon", "medium", "accept-edits"],
  ["Art Painter - Opus", "claude", "claude-opus-5-5", "medium", "auto"],
  ["Implement - Gemini (trial)", "antigravity-cli", "gemini-4-argon", "medium", "accept-edits"],
].map(([name, provider, model, effort, modeId]) => ({ name, provider, model, effort, modeId }));

const pick = (r) => r && { provider: r.provider, model: r.model, effort: r.effort, modeId: r.modeId };

test("golden: the 12 current profile names resolve to exactly today's provider/model/effort/mode", () => {
  assert.equal(GOLDEN.length, 12);
  assert.deepEqual(Object.keys(LEGACY_ROUTES).sort(), GOLDEN.map((g) => g.name).sort());
  for (const g of GOLDEN) {
    const r = resolveRoute({ role: g.name, stakes: "normal" });
    assert.deepEqual(pick(r), { provider: g.provider, model: g.model, effort: g.effort, modeId: g.modeId }, g.name);
    assert.equal(r.reason, "legacy-name", g.name);
    assert.equal(r.legacy, g.name);
  }
});

test("golden rows match the shipped profile definitions (today's source of truth in code)", () => {
  for (const g of GOLDEN) {
    const p = DEFAULT_PACK_PROFILES.find((x) => x.name === g.name);
    if (g.name === "Implement - Gemini (trial)") {
      assert.equal(p, undefined); // user-file only
      continue;
    }
    assert.ok(p, g.name);
    assert.deepEqual(
      { provider: p.provider, model: p.model, effort: p.thinkingOptionId, modeId: p.modeId },
      { provider: g.provider, model: g.model, effort: g.effort, modeId: g.modeId },
      g.name,
    );
  }
});

test("golden x every stakes value: same result as today's profile + resolveStakesRoute", () => {
  for (const g of GOLDEN) {
    const profile = { model: g.model, thinkingOptionId: g.effort };
    for (const s of [...STAKES_VALUES, undefined, "bogus"]) {
      const today = resolveStakesRoute(g.provider, profile, s, false, { ladder: DEFAULT_STAKES_LADDER });
      const want = {
        provider: g.provider,
        model: (today.apply && today.model) || g.model,
        effort: (today.apply && today.effort) || g.effort,
        modeId: g.modeId,
      };
      assert.deepEqual(pick(resolveRoute({ role: g.name, stakes: s })), want, `${g.name} @ ${s}`);
    }
  }
});

test("done check: Implement + tierA-invariant -> claude opus-5-5/high", () => {
  const r = resolveRoute({ role: "Implement", stakes: "tierA-invariant" });
  assert.deepEqual([r.provider, r.model, r.effort, r.modeId, r.tier, r.reason], ["claude", "claude-opus-5-5", "high", "auto", "top", "stakes"]);
});

test("done check: Review + normal -> gemini-4-argon (antigravity first)", () => {
  const r = resolveRoute({ role: "Review", stakes: "normal" });
  assert.deepEqual(pick(r), { provider: "antigravity-cli", model: "gemini-4-argon", effort: "medium", modeId: "default" });
  assert.deepEqual([r.tier, r.reason], ["mid", "default"]);
  assert.equal(resolveRoute({ role: "review" }).provider, "antigravity-cli"); // missing stakes = normal
});

test("done check: capped claude + Lead -> antigravity top rung", () => {
  for (const caps of [["claude"], new Set(["anthropic"]), { claude: true, opencode: false }]) {
    const r = resolveRoute({ role: "Lead", stakes: "normal", caps });
    assert.deepEqual(pick(r), { provider: "antigravity-cli", model: "gemini-4-argon", effort: "high", modeId: "accept-edits" });
    assert.deepEqual([r.tier, r.reason], ["top", "failover"]);
  }
  // capped claude + antigravity -> opencode top
  const r2 = resolveRoute({ role: "Lead", caps: ["claude", "gemini"] });
  assert.deepEqual(pick(r2), { provider: "opencode", model: "deepseek/deepseek-v4-pro", effort: "high", modeId: "build" });
});

test("done check: explicit model kept (and every explicit field wins)", () => {
  const r = resolveRoute({ role: "Implement", stakes: "tierA-invariant", explicit: { model: "claude-sonnet-5-5" } });
  assert.deepEqual([r.provider, r.model, r.effort, r.reason], ["claude", "claude-sonnet-5-5", "high", "explicit"]);
  assert.deepEqual(r.reasons, ["explicit", "stakes"]);
  const all = resolveRoute({
    role: "Review",
    stakes: "mechanical",
    caps: ["claude"],
    explicit: { provider: "claude", model: "claude-fable-5-2", thinkingOptionId: "max", modeId: "plan" },
  });
  assert.deepEqual(pick(all), { provider: "claude", model: "claude-fable-5-2", effort: "max", modeId: "plan" });
  assert.equal(all.reason, "explicit");
  // a model naming its own family moves the provider with it, even past a cap
  const m = resolveRoute({ role: "Review", explicit: { model: "claude-opus-5-5" } });
  assert.deepEqual([m.provider, m.model, m.effort, m.modeId], ["claude", "claude-opus-5-5", "medium", "auto"]);
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
    implement: "mid",
    "work-order": "mid",
    review: "mid",
    "pre-check": "cheap",
    "art-director": "mid",
    "art-painter": "top",
  });
  assert.equal(resolveRoute({ role: "Pre-check", stakes: "tierA-security" }).model, "gemini-4-argon");
  const lm = resolveRoute({ role: "Lead", stakes: "mechanical" });
  assert.deepEqual([lm.model, lm.effort, lm.tier], ["claude-sonnet-5-5", "low", "cheap"]);
});

test("role table: 8 roles, every preferred provider has a ladder and a mode; names look up case-insensitively", () => {
  assert.equal(Object.keys(ROLE_TABLE).length, 8);
  for (const [k, r] of Object.entries(ROLE_TABLE)) {
    assert.ok(TIERS.includes(r.tier), k);
    for (const p of r.providers) {
      assert.ok(DEFAULT_TIER_LADDER[p], `${k}/${p} ladder`);
      assert.ok(r.modes[p]?.modeId, `${k}/${p} mode`);
    }
  }
  assert.deepEqual(ROLE_TABLE.review.providers, ["antigravity-cli", "claude"]);
  for (const n of ["Work Order", "work-order", "WORK_ORDER", " work order "]) assert.equal(lookupRole(n)?.key, "work-order", n);
  assert.equal(lookupRole("review - gemini")?.legacy?.name, "Review - Gemini");
  assert.equal(lookupRole("Art Painter")?.key, "art-painter");
});

test("unknown role -> null; unknown role with an explicit provider still routes", () => {
  assert.equal(resolveRoute({ role: "Nope" }), null);
  assert.equal(resolveRoute({}), null);
  const r = resolveRoute({ role: "Nope", explicit: { provider: "codex", model: "gpt-x" } });
  assert.deepEqual([r.provider, r.model, r.effort, r.modeId, r.reason, r.role], ["codex", "gpt-x", undefined, undefined, "explicit", null]);
});

test("all providers capped -> first preference, reason all-capped", () => {
  const r = resolveRoute({ role: "Review", caps: ["antigravity-cli", "claude"] });
  assert.deepEqual([r.provider, r.model, r.reason], ["antigravity-cli", "gemini-4-argon", "all-capped"]);
});

test("legacy name on a capped provider fails over along the role list and drops the provider-specific pin", () => {
  const r = resolveRoute({ role: "Lead - Claude", caps: ["claude"] });
  assert.deepEqual(pick(r), { provider: "antigravity-cli", model: "gemini-4-argon", effort: "high", modeId: "accept-edits" });
  assert.deepEqual(r.reasons, ["legacy-name", "failover"]);
  const w = resolveRoute({ role: "Work Order - DSP", caps: ["opencode"] });
  assert.deepEqual(pick(w), { provider: "claude", model: "claude-sonnet-5-5", effort: "medium", modeId: "auto" });
  // legacy tier override + model pin (P5b shape)
  const legacy = { "Implement - Opus": { role: "implement", provider: "claude", tier: "top", pin: { effort: "medium" } } };
  const io = resolveRoute({ role: "Implement - Opus" }, { legacy });
  assert.deepEqual([io.model, io.effort, io.tier], ["claude-opus-5-5", "medium", "top"]);
  const io2 = resolveRoute({ role: "Implement - Opus", stakes: "mechanical" }, { legacy });
  assert.deepEqual([io2.model, io2.effort, io2.tier], ["claude-sonnet-5-5", "low", "cheap"]);
});

test("ladder input is honoured and the resolver never mutates it", () => {
  const ladder = loadTierLadder(join(tmpdir(), "vs-role-route-missing.json"));
  ladder.claude.mid = { model: "claude-x", effort: "max" };
  const snapshot = JSON.stringify(ladder);
  const r = resolveRoute({ role: "Implement", ladder });
  assert.deepEqual([r.model, r.effort], ["claude-x", "max"]);
  assert.equal(JSON.stringify(ladder), snapshot);
  assert.ok(Object.isFrozen(DEFAULT_TIER_LADDER.claude.top));
  assert.ok(Object.isFrozen(ROLE_TABLE.lead.modes.claude));
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
    assert.deepEqual(l.claude.cheap, { model: "claude-sonnet-5-5", effort: "minimal" });
    assert.deepEqual(l.claude.mid, DEFAULT_TIER_LADDER.claude.mid);
    assert.deepEqual(l["antigravity-cli"].top, { model: "gemini-z", effort: "max" });
    assert.deepEqual(l["antigravity-cli"].cheap, DEFAULT_TIER_LADDER["antigravity-cli"].cheap); // fable never a rung
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
