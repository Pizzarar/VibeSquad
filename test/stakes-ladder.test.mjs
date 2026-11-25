import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_STAKES_LADDER, loadStakesLadder, normalizeStakes, resolveStakesRoute } from "../server/stakes-ladder.mjs";

const claudeProfile = { model: "claude-sonnet-5-5", thinkingOptionId: "medium" };

test("tierA-security on claude -> opus-5-5 / high", () => {
  const r = resolveStakesRoute("claude", claudeProfile, "tierA-security", false);
  assert.deepEqual([r.model, r.effort, r.reason, r.apply], ["claude-opus-5-5", "high", "ladder", true]);
});

test("tierA-invariant claude -> opus high; mechanical -> haiku low (A2 idea-986, was sonnet low)", () => {
  assert.equal(resolveStakesRoute("claude", claudeProfile, "tierA-invariant", false).model, "claude-opus-5-5");
  const m = resolveStakesRoute("claude", claudeProfile, "mechanical", false);
  assert.deepEqual([m.model, m.effort], ["claude-haiku-5-5", "low"]);
});

test("gemini rungs and opencode keeps the profile model", () => {
  const g = resolveStakesRoute("antigravity-cli", { model: "x" }, "tierA-security", false);
  assert.deepEqual([g.model, g.effort], ["gemini-4-neon", "high"]);
  assert.equal(resolveStakesRoute("antigravity-cli", { model: "x", thinkingOptionId: "medium" }, "mechanical", false).model, "gemini-3.8-flash");
  const o = resolveStakesRoute("opencode", { model: "deepseek/deepseek-v4-pro", thinkingOptionId: "default" }, "tierA-invariant", false);
  assert.deepEqual([o.model, o.effort], [undefined, "high"]); // rung without a model leaves the spawn's model alone
});

test("R7: mechanical opencode spawn runs DeepSeek Flash; tierA keeps the profile model; claude mechanical = Haiku (A2); gemini rung unchanged", () => {
  const ladder = DEFAULT_STAKES_LADDER; // not the machine's override file
  const dsp = { model: "deepseek/deepseek-v4-pro", thinkingOptionId: "high" };
  const m = resolveStakesRoute("opencode", dsp, "mechanical", false, { ladder });
  assert.deepEqual([m.model, m.effort, m.reason, m.apply], ["deepseek/deepseek-flash", undefined, "ladder", true]); // effort: profile's
  const t = resolveStakesRoute("opencode", dsp, "tierA-invariant", false, { ladder });
  assert.deepEqual([t.model, t.effort], [undefined, "high"]);
  assert.equal(resolveStakesRoute("opencode", dsp, "normal", false, { ladder }).model, "deepseek/deepseek-v4-pro");
  assert.equal(resolveStakesRoute("opencode", dsp, "mechanical", { model: true }, { ladder }).apply, false); // explicit model wins
  assert.deepEqual(DEFAULT_STAKES_LADDER.claude.mechanical, { model: "claude-haiku-5-5", effort: "low" }); // A2: was sonnet/low
  assert.deepEqual(DEFAULT_STAKES_LADDER["antigravity-cli"].mechanical, { model: "gemini-3.8-flash" });
});

test("missing / unknown stakes = normal = profile unchanged", () => {
  for (const s of [undefined, "", "bogus", "normal"]) {
    const r = resolveStakesRoute("claude", claudeProfile, s, false);
    assert.equal(r.apply, false);
    assert.equal(r.stakes, "normal");
    assert.equal(r.model, "claude-sonnet-5-5");
    assert.equal(r.reason, "default");
  }
  assert.equal(normalizeStakes("bogus"), "normal");
});

test("explicit wins and is reported", () => {
  const r = resolveStakesRoute("claude", claudeProfile, "tierA-security", true);
  assert.deepEqual([r.apply, r.reason, r.model], [false, "explicit", "claude-sonnet-5-5"]);
});

test("unknown provider has no rung -> default", () => {
  assert.equal(resolveStakesRoute("codex", { model: "m" }, "tierA-security", false).apply, false);
});

test("override file merges rungs; bad file falls back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-stakes-"));
  try {
    const f = join(dir, "stakes-ladder.json");
    writeFileSync(f, JSON.stringify({ claude: { "tierA-security": { model: "claude-x", effort: "max" }, normal: { model: "no" } } }));
    const l = loadStakesLadder(f);
    assert.deepEqual(l.claude["tierA-security"], { model: "claude-x", effort: "max" });
    assert.deepEqual(l.claude["tierA-invariant"], DEFAULT_STAKES_LADDER.claude["tierA-invariant"]);
    assert.equal(l.claude.normal, undefined);
    writeFileSync(f, "{nope");
    assert.deepEqual(loadStakesLadder(f), DEFAULT_STAKES_LADDER);
    assert.deepEqual(loadStakesLadder(join(dir, "missing.json")), DEFAULT_STAKES_LADDER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
