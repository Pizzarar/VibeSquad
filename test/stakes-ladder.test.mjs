import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_STAKES_LADDER, loadStakesLadder, normalizeStakes, resolveStakesRoute } from "../server/stakes-ladder.mjs";

const claudeProfile = { model: "claude-sonnet-5-5", thinkingOptionId: "medium" };

test("tierA-security on claude -> fable-5-1 / high", () => {
  const r = resolveStakesRoute("claude", claudeProfile, "tierA-security", false);
  assert.deepEqual([r.model, r.effort, r.reason, r.apply], ["claude-fable-5-1", "high", "ladder", true]);
});

test("tierA-invariant claude -> opus high; mechanical -> sonnet low", () => {
  assert.equal(resolveStakesRoute("claude", claudeProfile, "tierA-invariant", false).model, "claude-opus-5-5");
  const m = resolveStakesRoute("claude", claudeProfile, "mechanical", false);
  assert.deepEqual([m.model, m.effort], ["claude-sonnet-5-5", "low"]);
});

test("gemini rungs and opencode keeps the profile model", () => {
  const g = resolveStakesRoute("antigravity-cli", { model: "x" }, "tierA-security", false);
  assert.deepEqual([g.model, g.effort], ["gemini-4-argon", "high"]);
  assert.equal(resolveStakesRoute("antigravity-cli", { model: "x", thinkingOptionId: "medium" }, "mechanical", false).model, "gemini-3.8-flash");
  const o = resolveStakesRoute("opencode", { model: "deepseek/deepseek-v4-pro", thinkingOptionId: "default" }, "tierA-invariant", false);
  assert.deepEqual([o.model, o.effort], ["deepseek/deepseek-v4-pro", "high"]);
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
