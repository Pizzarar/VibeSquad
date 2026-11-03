import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import {
  COUNTERPART_PROFILES,
  QUOTA_FAILOVER_THRESHOLD,
  counterpartProfileName,
  isProviderOverQuota,
  resolveProfileWithFailover,
} from "../server/provider-failover.mjs";
import {
  DEFAULT_PACK_PROFILES,
  LEGACY_PROFILE_ALIASES,
  findProfile,
  toPaseoSpawnConfig,
} from "../server/profiles.mjs";
import { spawnEnvFor } from "../src/spawn-env.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("1. QUOTA_FAILOVER_THRESHOLD and COUNTERPART_PROFILES mappings", () => {
  assert.equal(QUOTA_FAILOVER_THRESHOLD, 95);
  assert.equal(counterpartProfileName("Lead - Claude"), "Lead - Gemini");
  assert.equal(counterpartProfileName("Lead - Gemini"), "Lead - Claude");
  assert.equal(counterpartProfileName("Brainstorm - Claude"), "Brainstorm - Gemini");
  assert.equal(counterpartProfileName("Brainstorm - Gemini"), "Brainstorm - Claude");
  assert.equal(counterpartProfileName("Review - Sonnet"), "Review - Gemini");
  assert.equal(counterpartProfileName("Review - Gemini"), "Review - Sonnet");
  assert.equal(counterpartProfileName("Check - Haiku"), "Pre-check - Flash");
  assert.equal(counterpartProfileName("Pre-check - Flash"), "Check - Haiku");
  assert.equal(counterpartProfileName("Art Painter - Opus"), "Art Director - Gemini");
  assert.equal(counterpartProfileName("Art Director - Gemini"), "Art Painter - Opus");
  assert.equal(counterpartProfileName("Implement - Sonnet"), "Lead - Gemini");
  assert.equal(counterpartProfileName("Implement - Opus"), "Lead - Gemini");
  assert.equal(counterpartProfileName("Planner - Sonnet"), "Lead - Gemini");
  assert.equal(counterpartProfileName("Spec - Opus"), "Lead - Gemini");

  // Generic suffix replacement
  assert.equal(counterpartProfileName("Custom - Claude"), "Custom - Gemini");
  assert.equal(counterpartProfileName("Custom - Gemini"), "Custom - Claude");
  assert.equal(counterpartProfileName("Custom-Claude"), "Custom-Gemini");
  assert.equal(counterpartProfileName("Custom-Gemini"), "Custom-Claude");
  assert.ok(COUNTERPART_PROFILES["Lead - Claude"]);
});

test("2. isProviderOverQuota at 94%, 95%, 99% (remainingPct: 1), and status: unavailable", () => {
  // 94% -> not over quota
  const at94 = isProviderOverQuota("claude", [{ id: "claude", status: "ok", usedPct: 94, remainingPct: 6 }]);
  assert.equal(at94.overQuota, false);
  assert.equal(at94.reason, null);
  assert.equal(at94.usedPct, 94);

  // 95% -> over quota
  const at95 = isProviderOverQuota("claude", [{ id: "claude", status: "ok", usedPct: 95, remainingPct: 5 }]);
  assert.equal(at95.overQuota, true);
  assert.equal(at95.usedPct, 95);
  assert.match(at95.reason, /95%/);

  // 99% via remainingPct: 1 -> over quota
  const at99 = isProviderOverQuota("claude/claude-opus-5-5", [{ id: "claude", status: "ok", remainingPct: 1 }]);
  assert.equal(at99.overQuota, true);
  assert.equal(at99.usedPct, 99);

  // UsageReportLike window shape at 96% -> over quota
  const win96 = isProviderOverQuota("antigravity-cli", [
    { id: "gemini", report: { status: "ok", windows: [{ usedPct: 96, remainingPct: 4 }] } },
  ]);
  assert.equal(win96.overQuota, true);
  assert.equal(win96.usedPct, 96);

  // status: "unavailable" -> over quota even when usedPct is null/low
  const unavail = isProviderOverQuota("claude", [{ id: "claude", status: "unavailable", usedPct: null }]);
  assert.equal(unavail.overQuota, true);
  assert.match(unavail.reason, /unavailable/);
});

test("3. resolveProfileWithFailover auto-switches Claude <-> Gemini when usage >= 95%", () => {
  const claudeOver = [
    { id: "claude", status: "ok", usedPct: 99, remainingPct: 1 },
    { id: "antigravity-cli", status: "ok", usedPct: 20, remainingPct: 80 },
  ];

  const leadRes = resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, claudeOver);
  assert.equal(leadRes.failedOver, true);
  assert.equal(leadRes.fromProfile, "Lead - Claude");
  assert.equal(leadRes.toProfile, "Lead - Gemini");
  assert.equal(leadRes.profile.name, "Lead - Gemini");
  assert.equal(leadRes.profile.provider, "antigravity-cli");

  const bsRes = resolveProfileWithFailover("Brainstorm - Claude", DEFAULT_PACK_PROFILES, claudeOver);
  assert.equal(bsRes.failedOver, true);
  assert.equal(bsRes.fromProfile, "Brainstorm - Claude");
  assert.equal(bsRes.toProfile, "Brainstorm - Gemini");
  assert.equal(bsRes.profile.name, "Brainstorm - Gemini");

  const revRes = resolveProfileWithFailover("Review - Sonnet", DEFAULT_PACK_PROFILES, claudeOver);
  assert.equal(revRes.failedOver, true);
  assert.equal(revRes.fromProfile, "Review - Sonnet");
  assert.equal(revRes.toProfile, "Review - Gemini");
  assert.equal(revRes.profile.name, "Review - Gemini");

  const impRes = resolveProfileWithFailover("Implement - Sonnet", DEFAULT_PACK_PROFILES, claudeOver);
  assert.equal(impRes.failedOver, true);
  assert.equal(impRes.fromProfile, "Implement - Sonnet");
  assert.equal(impRes.toProfile, "Lead - Gemini");
  assert.equal(impRes.profile.name, "Lead - Gemini");

  // Vice-versa when Gemini is >= 95% and Claude has headroom
  const geminiOver = [
    { id: "claude", status: "ok", usedPct: 30, remainingPct: 70 },
    { id: "gemini", status: "ok", usedPct: 96, remainingPct: 4 },
  ];

  const leadRev = resolveProfileWithFailover("Lead - Gemini", DEFAULT_PACK_PROFILES, geminiOver);
  assert.equal(leadRev.failedOver, true);
  assert.equal(leadRev.fromProfile, "Lead - Gemini");
  assert.equal(leadRev.toProfile, "Lead - Claude");
  assert.equal(leadRev.profile.name, "Lead - Claude");
  assert.equal(leadRev.profile.provider, "claude");

  const bsRev = resolveProfileWithFailover("Brainstorm - Gemini", DEFAULT_PACK_PROFILES, geminiOver);
  assert.equal(bsRev.failedOver, true);
  assert.equal(bsRev.toProfile, "Brainstorm - Claude");

  const revRev = resolveProfileWithFailover("Review - Gemini", DEFAULT_PACK_PROFILES, geminiOver);
  assert.equal(revRev.failedOver, true);
  assert.equal(revRev.toProfile, "Review - Sonnet");

  // When both are over quota, does not fail over to an exhausted counterpart
  const bothOver = [
    { id: "claude", status: "ok", usedPct: 99 },
    { id: "antigravity-cli", status: "ok", usedPct: 98 },
  ];
  const stuckRes = resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, bothOver);
  assert.equal(stuckRes.failedOver, false);
  assert.equal(stuckRes.profile.name, "Lead - Claude");
});

test("4. toPaseoSpawnConfig with usageProviders fails over automatically and preserves 19 default profiles + aliases", () => {
  assert.equal(DEFAULT_PACK_PROFILES.length, 19);
  assert.equal(LEGACY_PROFILE_ALIASES["Builder - Gemini"], "Lead - Gemini");
  assert.equal(LEGACY_PROFILE_ALIASES["Reviewer - Gemini"], "Review - Gemini");
  assert.equal(findProfile("Builder - Gemini", DEFAULT_PACK_PROFILES)?.name, "Lead - Gemini");
  assert.equal(findProfile("Reviewer - Gemini", DEFAULT_PACK_PROFILES)?.name, "Review - Gemini");

  const usageProviders = [
    { id: "claude", status: "ok", usedPct: 99, remainingPct: 1 },
    { id: "antigravity-cli", status: "ok", usedPct: 15, remainingPct: 85 },
  ];
  const cfg = toPaseoSpawnConfig("Lead - Claude", { usageProviders }, DEFAULT_PACK_PROFILES);
  assert.equal(cfg.provider, "antigravity-cli");
  assert.equal(cfg.model, "gemini-4-argon");
  assert.equal(cfg.modeId, "accept-edits");
  assert.deepEqual(cfg.failover, {
    failedOver: true,
    fromProfile: "Lead - Claude",
    toProfile: "Lead - Gemini",
    reason: "claude usage 99% >= 95%",
  });

  // When under quota, no failover metadata is attached
  const okUsage = [{ id: "claude", status: "ok", usedPct: 50, remainingPct: 50 }];
  const normalCfg = toPaseoSpawnConfig("Lead - Claude", { usageProviders: okUsage }, DEFAULT_PACK_PROFILES);
  assert.equal(normalCfg.provider, "claude");
  assert.equal(normalCfg.model, "claude-opus-5-5");
  assert.equal(normalCfg.failover, undefined);
});

test("5. spawnEnvFor injects CLAUDE_CODE_ENTRYPOINT=Paseo for Claude provider while keeping label-only behavior intact", () => {
  assert.deepEqual(
    spawnEnvFor({ role: "brainstorm", lane: "x", profile: "Brainstorm - Claude" }),
    { VS_ROLE: "brainstorm", VS_PROFILE: "Brainstorm - Claude" },
  );
  assert.deepEqual(
    spawnEnvFor({ role: "lead", profile: "Lead - Claude" }, "claude/claude-opus-5-5"),
    { VS_ROLE: "lead", VS_PROFILE: "Lead - Claude", CLAUDE_CODE_ENTRYPOINT: "Paseo" },
  );
  assert.deepEqual(
    spawnEnvFor({ role: "worker", provider: "claude" }),
    { VS_ROLE: "worker", CLAUDE_CODE_ENTRYPOINT: "Paseo" },
  );
  assert.deepEqual(
    spawnEnvFor({ role: "lead", profile: "Lead - Gemini" }, "antigravity-cli/gemini-4-argon"),
    { VS_ROLE: "lead", VS_PROFILE: "Lead - Gemini" },
  );
});

test("6. oppositeProviderTarget and switch buttons in DrawerHeader.tsx and HandoffModal.tsx", async () => {
  const drawerSrc = readFileSync(resolve(ROOT, "src", "DrawerHeader.tsx"), "utf8");
  const handoffSrc = readFileSync(resolve(ROOT, "src", "HandoffModal.tsx"), "utf8");

  assert.match(drawerSrc, /data-testid="drawer-switch-provider-btn"/);
  assert.match(drawerSrc, /⇄ Switch to Gemini/);
  assert.match(drawerSrc, /⇄ Switch to Claude/);
  assert.match(drawerSrc, /export function oppositeProviderTarget/);

  assert.match(handoffSrc, /data-testid="handoff-switch-provider-btn"/);
  assert.match(handoffSrc, /Switch Provider \(Claude ↔ Gemini\)/);

  // Extract and execute oppositeProviderTarget directly from DrawerHeader.tsx
  const startIdx = drawerSrc.indexOf("const COUNTERPART_PROFILE_MAP");
  const endMarker = "export type DrawerHeaderProps";
  const endIdx = drawerSrc.indexOf(endMarker);
  assert.ok(startIdx > 0 && endIdx > startIdx, "Could not locate oppositeProviderTarget block in DrawerHeader.tsx");
  const tsSnippet = drawerSrc.slice(startIdx, endIdx);
  const jsSnippet = stripTypeScriptTypes(tsSnippet);
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(jsSnippet)}`);

  const toGemini = mod.oppositeProviderTarget("claude", "Lead - Claude");
  assert.deepEqual(toGemini, {
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    providerSpec: "antigravity-cli/gemini-4-argon",
    modeId: "accept-edits",
    label: "⇄ Switch to Gemini",
    profile: "Lead - Gemini",
  });

  const toClaude = mod.oppositeProviderTarget("antigravity-cli", "Brainstorm - Gemini");
  assert.deepEqual(toClaude, {
    provider: "claude",
    model: "claude-opus-5-5",
    providerSpec: "claude/claude-opus-5-5",
    modeId: "auto",
    label: "⇄ Switch to Claude",
    profile: "Brainstorm - Claude",
  });

  assert.equal(mod.oppositeProviderTarget("opencode", "Mechanical - DSF"), null);
});
