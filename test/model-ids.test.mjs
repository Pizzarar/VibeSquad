// N1 (2026-11-21): gemini-4-argon -> gemini-4-neon. One constant (server/model-ids.mjs) + the profiles.json load-time
// migration, run on a temp copy of the real 2026-11-17 user file (5 Argon profiles).
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GEMINI_CHEAP_MODEL, GEMINI_TOP_MODEL, RETIRED_MODEL_IDS, migrateModelId } from "../server/model-ids.mjs";
import { DEFAULT_PACK_PROFILES, loadProfiles, migrateRetiredProfileModels } from "../server/profiles.mjs";
import { DEFAULT_STAKES_LADDER, DEFAULT_TIER_LADDER, loadStakesLadder, loadTierLadder } from "../server/stakes-ladder.mjs";

const FIXTURE = new URL("./fixtures/profiles-v1-2026-11-17.json", import.meta.url);

test("constants: Neon is the top Gemini, 3.8 Flash stays cheap, Argon is retired to Neon", () => {
  assert.equal(GEMINI_TOP_MODEL, "gemini-4-neon");
  assert.equal(GEMINI_CHEAP_MODEL, "gemini-3.8-flash");
  assert.deepEqual({ ...RETIRED_MODEL_IDS }, { "gemini-4-argon": "gemini-4-neon" });
  assert.equal(DEFAULT_TIER_LADDER["antigravity-cli"].top.model, "gemini-4-neon");
  assert.equal(DEFAULT_TIER_LADDER["antigravity-cli"].mid.model, "gemini-4-neon");
  assert.equal(DEFAULT_TIER_LADDER["antigravity-cli"].cheap.model, "gemini-3.8-flash");
  assert.equal(DEFAULT_STAKES_LADDER["antigravity-cli"]["tierA-invariant"].model, "gemini-4-neon");
  assert.equal(DEFAULT_STAKES_LADDER["antigravity-cli"].mechanical.model, "gemini-3.8-flash");
  const shipped = DEFAULT_PACK_PROFILES.map((p) => p.model);
  assert.ok(!shipped.some((m) => /argon/i.test(m)), "no shipped profile names Argon");
  assert.ok(shipped.includes("gemini-3.8-flash"), "Flash profiles stay");
});

test("migrateModelId: bare id, effort variants, provider prefix; everything else untouched (idempotent)", () => {
  const cases = [
    ["gemini-4-argon", "gemini-4-neon"],
    ["gemini-4-argon-low", "gemini-4-neon-low"],
    ["gemini-4-argon-medium", "gemini-4-neon-medium"],
    ["gemini-4-argon-high", "gemini-4-neon-high"],
    ["Gemini-4-Argon", "gemini-4-neon"],
    ["antigravity-cli/gemini-4-argon", "antigravity-cli/gemini-4-neon"],
    ["gemini-4-neon", "gemini-4-neon"],
    ["gemini-4-neon-xhigh", "gemini-4-neon-xhigh"],
    ["gemini-3.8-flash", "gemini-3.8-flash"],
    ["gemini-pro-orchestrator-argon", "gemini-pro-orchestrator-argon"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
    ["", ""],
  ];
  for (const [input, want] of cases) {
    assert.equal(migrateModelId(input), want, input);
    assert.equal(migrateModelId(migrateModelId(input)), want, `${input} twice`);
  }
  assert.equal(migrateModelId(undefined), undefined);
  assert.equal(migrateModelId(null), null);
});

test("migrateRetiredProfileModels: rewrites only retired models, reports change once", () => {
  const list = [
    { name: "Lead - Gemini", model: "gemini-4-argon" },
    { name: "Pre-check - Flash", model: "gemini-3.8-flash" },
    { name: "Lead - Claude", model: "claude-opus-5-5" },
  ];
  assert.equal(migrateRetiredProfileModels(list), true);
  assert.deepEqual(list.map((p) => p.model), ["gemini-4-neon", "gemini-3.8-flash", "claude-opus-5-5"]);
  assert.equal(migrateRetiredProfileModels(list), false);
});

test("loadProfiles migrates the 2026-11-17 user file (temp copy): 5 Argon -> Neon, rest byte-for-byte, idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-n1-"));
  try {
    const file = join(dir, "profiles.json");
    copyFileSync(FIXTURE, file);
    const before = JSON.parse(readFileSync(file, "utf8"));
    const argon = before.profiles.filter((p) => p.model === "gemini-4-argon").map((p) => p.name);
    assert.deepEqual(argon, ["Lead - Gemini", "Brainstorm - Gemini", "Review - Gemini", "Art Director - Gemini", "Implement - Gemini (trial)"]);

    const res = loadProfiles(file, { paseoProfiles: [] });
    assert.equal(res.source, "vibesquad");
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.profiles.length, before.profiles.length);
    for (let i = 0; i < before.profiles.length; i++) {
      const b = before.profiles[i];
      const a = after.profiles[i];
      const want = argon.includes(b.name) ? { ...b, model: "gemini-4-neon" } : b;
      assert.deepEqual({ ...a, notes: undefined }, { ...want, notes: undefined }, b.name);
    }
    assert.ok(!readFileSync(file, "utf8").includes("gemini-4-argon"));
    assert.deepEqual(res.profiles.filter((p) => argon.includes(p.name)).map((p) => p.model), argon.map(() => "gemini-4-neon"));
    // Thinking/mode/featureValues kept: the effort still rides on thinkingOptionId.
    const lead = after.profiles.find((p) => p.name === "Lead - Gemini");
    assert.deepEqual([lead.provider, lead.thinkingOptionId, lead.modeId], ["antigravity-cli", "medium", "accept-edits"]);

    // Second load: nothing to migrate, file bytes unchanged.
    const bytes = readFileSync(file, "utf8");
    loadProfiles(file, { paseoProfiles: [] });
    assert.equal(readFileSync(file, "utf8"), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stakes-ladder.json overrides naming Argon read as Neon (tier + per-stakes views); the file is not rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-n1-ladder-"));
  try {
    const file = join(dir, "stakes-ladder.json");
    const body = JSON.stringify({ "antigravity-cli": { "tierA-security": { model: "gemini-4-argon-high" }, mid: { model: "gemini-4-argon" } } });
    writeFileSync(file, body, "utf8");
    assert.equal(loadTierLadder(file)["antigravity-cli"].top.model, "gemini-4-neon-high");
    assert.equal(loadTierLadder(file)["antigravity-cli"].mid.model, "gemini-4-neon");
    assert.equal(loadStakesLadder(file)["antigravity-cli"]["tierA-security"].model, "gemini-4-neon-high");
    assert.equal(readFileSync(file, "utf8"), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
