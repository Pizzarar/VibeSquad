import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COUNTERPART_PROFILES,
  QUOTA_FAILOVER_THRESHOLD,
  ROLE_FAILOVER_CHAINS,
  counterpartProfileName,
  isProviderOverQuota,
  readCappedProviders,
  resolveCappedProvidersPath,
  resolveProfileWithFailover,
  setProviderCapped,
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

  // When both claude and gemini are over quota, fails over to DeepSeek (multi-hop)
  const bothOver = [
    { id: "claude", status: "ok", usedPct: 99 },
    { id: "antigravity-cli", status: "ok", usedPct: 98 },
  ];
  const stuckRes = resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, bothOver);
  assert.equal(stuckRes.failedOver, true);
  assert.equal(stuckRes.fromProfile, "Lead - Claude");
  assert.equal(stuckRes.toProfile, "Senior Reasoning - DSP");
  assert.equal(stuckRes.profile.name, "Senior Reasoning - DSP");
  assert.equal(stuckRes.profile.provider, "opencode");
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

test("7. canonical role/tier names resolve to their primary profiles", () => {
  assert.equal(resolveProfileWithFailover("Lead", DEFAULT_PACK_PROFILES, []).profile.name, "Lead - Claude");
  assert.equal(resolveProfileWithFailover("Brainstorm", DEFAULT_PACK_PROFILES, []).profile.name, "Brainstorm - Claude");
  assert.equal(resolveProfileWithFailover("Worker", DEFAULT_PACK_PROFILES, []).profile.name, "Implement - Sonnet");
  assert.equal(resolveProfileWithFailover("Buddy", DEFAULT_PACK_PROFILES, []).profile.name, "Brainstorm - Claude");
  assert.equal(resolveProfileWithFailover("RiffBot", DEFAULT_PACK_PROFILES, []).profile.name, "Brainstorm - Claude");
  assert.equal(resolveProfileWithFailover("Reviewer", DEFAULT_PACK_PROFILES, []).profile.name, "Review - Gemini");
  assert.equal(resolveProfileWithFailover("Fast", DEFAULT_PACK_PROFILES, []).profile.name, "Pre-check - Flash");
  assert.equal(resolveProfileWithFailover("Coder", DEFAULT_PACK_PROFILES, []).profile.name, "Work Order - DSP");

  // Also via findProfile in server/profiles.mjs and when stored profiles list is trimmed
  assert.equal(findProfile("Lead", DEFAULT_PACK_PROFILES)?.name, "Lead - Claude");
  assert.equal(findProfile("Worker", DEFAULT_PACK_PROFILES)?.name, "Implement - Sonnet");
  assert.equal(findProfile("Reviewer", DEFAULT_PACK_PROFILES)?.name, "Review - Gemini");
  const trimmedList = DEFAULT_PACK_PROFILES.filter((p) => p.name === "Lead - Claude");
  const failoverFromTrimmed = resolveProfileWithFailover("Lead", trimmedList, [
    { id: "claude", status: "ok", usedPct: 99 },
    { id: "antigravity-cli", status: "ok", usedPct: 10 },
  ]);
  assert.equal(failoverFromTrimmed.failedOver, true);
  assert.equal(failoverFromTrimmed.toProfile, "Lead - Gemini");
});

test("8. multi-hop failover to DeepSeek when both claude and gemini are over quota", () => {
  const bothCapped = [
    { id: "claude", status: "ok", usedPct: 99 },
    { id: "antigravity-cli", status: "ok", usedPct: 98 },
  ];

  const imp = resolveProfileWithFailover("Implement - Sonnet", DEFAULT_PACK_PROFILES, bothCapped);
  assert.equal(imp.failedOver, true);
  assert.equal(imp.fromProfile, "Implement - Sonnet");
  assert.equal(imp.toProfile, "Work Order - DSP");
  assert.equal(imp.profile.name, "Work Order - DSP");
  assert.equal(imp.profile.provider, "opencode");

  const lead = resolveProfileWithFailover("Lead - Claude", DEFAULT_PACK_PROFILES, bothCapped);
  assert.equal(lead.failedOver, true);
  assert.equal(lead.fromProfile, "Lead - Claude");
  assert.equal(lead.toProfile, "Senior Reasoning - DSP");
  assert.equal(lead.profile.name, "Senior Reasoning - DSP");
  assert.equal(lead.profile.provider, "opencode");
});

test("9. setProviderCapped / readCappedProviders mark claude capped and fail over to Gemini", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-caps-"));
  const cappedProvidersPath = join(dir, "capped-providers.json");

  const updated = setProviderCapped("claude", true, { reason: "test cap", cappedProvidersPath });
  assert.ok(updated.claude, "claude should be in the returned cap map");
  assert.equal(updated.claude.reason, "test cap");

  const read = readCappedProviders({ cappedProvidersPath, useDiskCaps: true });
  assert.ok(read.claude, "claude should be read back from disk");
  assert.equal(read.claude.reason, "test cap");

  // claude is capped on disk; Brainstorm - Claude should fail over to Brainstorm - Gemini
  const res = resolveProfileWithFailover("Brainstorm - Claude", DEFAULT_PACK_PROFILES, [], {
    cappedProvidersPath,
    useDiskCaps: true,
  });
  assert.equal(res.failedOver, true);
  assert.equal(res.fromProfile, "Brainstorm - Claude");
  assert.equal(res.toProfile, "Brainstorm - Gemini");
  assert.equal(res.profile.provider, "antigravity-cli");

  // Uncap claude and confirm the failover no longer happens
  setProviderCapped("claude", false, { cappedProvidersPath });
  const res2 = resolveProfileWithFailover("Brainstorm - Claude", DEFAULT_PACK_PROFILES, [], {
    cappedProvidersPath,
    useDiskCaps: true,
  });
  assert.equal(res2.failedOver, false);
  assert.equal(res2.profile.name, "Brainstorm - Claude");

  rmSync(dir, { recursive: true, force: true });
});

test("10. setProviderCapped throws on corrupt capped-providers.json without overwriting", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vs-caps-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cappedProvidersPath = join(dir, "capped-providers.json");

  writeFileSync(cappedProvidersPath, "{corrupt json", "utf8");
  assert.throws(() => setProviderCapped("claude", true, { cappedProvidersPath }), SyntaxError);
  assert.equal(readFileSync(cappedProvidersPath, "utf8"), "{corrupt json");
  assert.equal(existsSync(`${cappedProvidersPath}.lock`), false);
});

test("11. multi-process race: concurrent server setProviderCapped and vs cap CLI preserve all caps", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vs-caps-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vsHome = join(dir, ".vibesquad");
  const cappedProvidersPath = join(vsHome, "capped-providers.json");

  const modUrl = pathToFileURL(fileURLToPath(new URL("../server/provider-failover.mjs", import.meta.url))).href;
  const vsCli = resolve(ROOT, "cli", "vs.mjs");
  const env = { ...process.env, VIBESQUAD_HOME: vsHome };
  delete env.VIBESQUAD_CAPPED_PROVIDERS_PATH;

  const providers = ["claude", "antigravity-cli", "opencode", "openai", "mistral", "cohere"];
  const runChild = (args) =>
    new Promise((resolveProc, rejectProc) => {
      const c = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "inherit"] });
      c.on("exit", (rc) => (rc === 0 ? resolveProc() : rejectProc(new Error(`child exit ${rc}`))));
      c.on("error", rejectProc);
    });

  await Promise.all(
    providers.map((prov, idx) => {
      if (idx % 2 === 0) {
        const code = `import(${JSON.stringify(modUrl)}).then(m=>{for(let i=0;i<15;i++){m.setProviderCapped(${JSON.stringify(prov)},false,{timeoutMs:20000});m.setProviderCapped(${JSON.stringify(prov)},true,{reason:"race-"+i,timeoutMs:20000});}})`;
        return runChild(["-e", code]);
      }
      return runChild([vsCli, "cap", "add", prov]);
    }),
  );

  const doc = JSON.parse(readFileSync(cappedProvidersPath, "utf8"));
  for (const prov of providers) {
    assert.ok(doc.capped[prov], `expected ${prov} cap to be present after concurrent writes`);
  }
  assert.equal(existsSync(`${cappedProvidersPath}.lock`), false);
});
