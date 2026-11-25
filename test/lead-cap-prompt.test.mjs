// @per G2 L1 (Sonnet review rn-9d3f8a588837): a `vs cap` alone (capped-providers.json, no quota row) on the stored-profile
// lead successor path used to keep the Claude profile + a Claude-built prompt and let the spawn hook swap the provider to
// Gemini underneath. Now the cap feeds the same failover as live quota: profile, prompt (NON_CLAUDE_LEAD_CAP_RULES),
// labels (vs.failover, vs.failover-from), env VS_FAILOVER and res.failover all match the provider that runs.
// Temp homes only: VIBESQUAD_HOME + the cap file point into a mkdtemp dir; the real ~/.vibesquad is never read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLeadHandoffCoordinator, NON_CLAUDE_LEAD_CAP_RULES, resolveLeadProfile } from "../server/lead-handoff.mjs";
import { setProviderCapped } from "../server/provider-failover.mjs";
import { seedDefaultPack } from "../server/vibesquad-api.mjs";

function capEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-lead-cap-"));
    const vsHome = join(dir, ".vibesquad");
    const profilesPath = join(vsHome, "profiles.json");
    const capFile = join(vsHome, "capped-providers.json");
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "site", name: "example.dev", lanes: [{ id: "site-polish", name: "Site Polish" }], paths: ["example.dev"] }] }));
    seedDefaultPack(profilesPath);
    const prevHome = process.env.VIBESQUAD_HOME;
    const prevCaps = process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    process.env.VIBESQUAD_HOME = vsHome;
    delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    try {
      await fn({ dir, vsHome, profilesPath, capFile });
    } finally {
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prevHome;
      if (prevCaps === undefined) delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
      else process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = prevCaps;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** `vs cap claude` / `vs cap claude --off`, through the same writer the CLI uses, into the temp cap file. */
const vsCap = (capFile, provider, on = true) => setProviderCapped(provider, on, { reason: "manual cap", cappedProvidersPath: capFile });

/** One self-handoff of a site-polish lead; no quota rows (usageProviders: []), caps from disk only (no in-memory caps). */
async function runHandoff({ dir, vsHome, profilesPath, capFile }, over = {}) {
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
    cappedProvidersPath: capFile,
    usageProviders: [],
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
  "L1: `vs cap claude` with no quota row -> Gemini successor with the non-Claude prompt rules + failover labels/env/result; no cap -> Claude",
  capEnv(async (env) => {
    // No cap, no quota: the stored Claude lead stays Claude, Claude prompt, no failover anywhere.
    const plain = await runHandoff(env);
    assert.equal(plain.payload.config.provider, "claude");
    assert.equal(plain.payload.labels.profile, "Lead - Claude");
    assert.ok(!plain.payload.initialPrompt.includes(NON_CLAUDE_LEAD_CAP_RULES), "Claude lead gets no non-Claude rules");
    assert.equal(plain.payload.labels["vs.failover"], undefined);
    assert.equal(plain.payload.labels["vs.failover-from"], undefined);
    assert.equal(plain.payload.env.VS_FAILOVER, undefined);
    assert.equal(plain.res.failover, undefined);

    // `vs cap claude` on disk, no quota rows: the successor is built for Gemini end to end.
    vsCap(env.capFile, "claude");
    const { res, payload } = await runHandoff(env);
    assert.equal(payload.config.provider, "antigravity-cli");
    assert.equal(payload.labels.profile, "Lead - Gemini");
    assert.equal(payload.env.VS_PROFILE, "Lead - Gemini");
    assert.ok(payload.initialPrompt.includes(NON_CLAUDE_LEAD_CAP_RULES), "Gemini successor prompt carries the non-Claude cap rules");
    assert.equal(payload.prompt, payload.initialPrompt);
    assert.equal(payload.labels["vs.failover"], "Lead - Claude -> Lead - Gemini (claude status is exhausted)");
    assert.equal(payload.labels["vs.failover-from"], "Lead - Claude");
    assert.equal(payload.env.VS_FAILOVER, payload.labels["vs.failover"]);
    assert.deepEqual(res.failover, { from: "Lead - Claude", to: "Lead - Gemini", reason: "claude status is exhausted" });
    assert.equal(res.successor.provider, "antigravity-cli");
  }),
);

test(
  "L1: resolveLeadProfile honors a `vs cap` (disk or in-memory) on a stored lead profile; capped counterpart is never picked",
  capEnv(async ({ profilesPath, capFile }) => {
    const old = { provider: "claude", model: "claude-opus-5-5", labels: { profile: "Lead - Claude" } };
    // In-memory caps (the deps.cappedProviders shape) with no quota.
    const mem = resolveLeadProfile(old, profilesPath, { cappedProvidersPath: capFile, cappedProviders: ["claude"], usageProviders: [] });
    assert.deepEqual([mem.profileName, mem.spawnCfg.provider, mem.failover?.from, mem.failover?.to], ["Lead - Gemini", "antigravity-cli", "Lead - Claude", "Lead - Gemini"]);
    // Disk cap, usageProviders omitted entirely (no quota list at all).
    vsCap(capFile, "claude");
    const disk = resolveLeadProfile(old, profilesPath, { cappedProvidersPath: capFile });
    assert.deepEqual([disk.profileName, disk.spawnCfg.provider], ["Lead - Gemini", "antigravity-cli"]);
    // Claude + Gemini capped: never hop onto the capped Gemini lead.
    vsCap(capFile, "antigravity-cli");
    const both = resolveLeadProfile(old, profilesPath, { cappedProvidersPath: capFile });
    assert.notEqual(both.spawnCfg.provider, "antigravity-cli");
  }),
);

test(
  "L1 + L2: a cap-failed-over lead stays on Gemini while the cap holds, returns to Claude once `vs cap --off` clears it",
  capEnv(async (env) => {
    vsCap(env.capFile, "claude");
    const hop1 = await runHandoff(env);
    assert.equal(hop1.payload.labels.profile, "Lead - Gemini");
    assert.equal(hop1.payload.labels["vs.failover-from"], "Lead - Claude");
    const fromGemini = { provider: "antigravity-cli", labels: { profile: hop1.payload.labels.profile, "vs.failover-from": hop1.payload.labels["vs.failover-from"] } };

    // Cap still on: stays on Gemini, still remembers Claude, still the non-Claude prompt.
    const still = await runHandoff(env, fromGemini);
    assert.equal(still.payload.config.provider, "antigravity-cli");
    assert.equal(still.payload.labels.profile, "Lead - Gemini");
    assert.equal(still.payload.labels["vs.failover-from"], "Lead - Claude");
    assert.ok(still.payload.initialPrompt.includes(NON_CLAUDE_LEAD_CAP_RULES));

    // Cap cleared: back to Lead - Claude, Claude prompt, no failover labels left.
    vsCap(env.capFile, "claude", false);
    const back = await runHandoff(env, fromGemini);
    assert.equal(back.payload.config.provider, "claude");
    assert.equal(back.payload.labels.profile, "Lead - Claude");
    assert.ok(!back.payload.initialPrompt.includes(NON_CLAUDE_LEAD_CAP_RULES));
    assert.equal(back.payload.labels["vs.failover-from"], undefined);
    assert.equal(back.payload.labels["vs.failover"], undefined);
    assert.equal(back.res.failover, undefined);
  }),
);
