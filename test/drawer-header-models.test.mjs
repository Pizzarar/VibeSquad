import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

async function loadDrawerModelHelpers() {
  const drawerSrc = readFileSync(resolve(ROOT, "src", "DrawerHeader.tsx"), "utf8");
  const startIdx = drawerSrc.indexOf("export const PROVIDER_MODEL_HINTS");
  const endIdx = drawerSrc.indexOf("const providerModelsCache");
  assert.ok(startIdx >= 0 && endIdx > startIdx, "Could not locate PROVIDER_MODEL_HINTS and buildProviderModelOptions in DrawerHeader.tsx");
  const tsSnippet = drawerSrc.slice(startIdx, endIdx);
  const jsSnippet = stripTypeScriptTypes(tsSnippet);
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(jsSnippet)}`);
  return { mod, drawerSrc };
}

test("1. PROVIDER_MODEL_HINTS includes claude, antigravity-cli, antigravity, gemini, codex, openai, opencode, codewhale", async () => {
  const { mod } = await loadDrawerModelHelpers();
  const hints = mod.PROVIDER_MODEL_HINTS;
  for (const key of ["claude", "antigravity-cli", "antigravity", "gemini", "codex", "openai", "opencode", "codewhale"]) {
    assert.ok(Array.isArray(hints[key]) && hints[key].length >= 2, `Expected multiple hints for provider ${key}`);
  }
});

test("2. buildProviderModelOptions returns multiple options for claude, antigravity-cli, codex, opencode even when currentModel is set", async () => {
  const { mod } = await loadDrawerModelHelpers();
  const { buildProviderModelOptions } = mod;

  const claudeOpts = buildProviderModelOptions("claude", "claude-opus-5-5");
  assert.ok(claudeOpts.length >= 5, `Expected >= 5 claude options, got ${claudeOpts.length}`);
  assert.equal(claudeOpts[0], "claude-opus-5-5");
  assert.ok(claudeOpts.includes("claude-sonnet-5-5"));
  assert.ok(claudeOpts.includes("claude-haiku-5-5"));

  const agyOpts = buildProviderModelOptions("antigravity-cli", "gemini-4-argon");
  assert.ok(agyOpts.length >= 4, `Expected >= 4 antigravity-cli options, got ${agyOpts.length}`);
  assert.equal(agyOpts[0], "gemini-4-argon");
  assert.ok(agyOpts.includes("gemini-3.8-flash"));

  const codexOpts = buildProviderModelOptions("codex", "gpt-5.4");
  assert.ok(codexOpts.length >= 4, `Expected >= 4 codex options, got ${codexOpts.length}`);
  assert.ok(codexOpts.includes("gpt-5.3-codex"));

  const opencodeOpts = buildProviderModelOptions("opencode", "deepseek/deepseek-v4-pro");
  assert.ok(opencodeOpts.length >= 2, `Expected >= 2 opencode options, got ${opencodeOpts.length}`);
  assert.ok(opencodeOpts.includes("deepseek/deepseek-flash"));
});

test("3. buildProviderModelOptions merges and deduplicates currentModel, liveModels, and PROVIDER_MODEL_HINTS in order", async () => {
  const { mod } = await loadDrawerModelHelpers();
  const { buildProviderModelOptions } = mod;

  const merged = buildProviderModelOptions(
    "claude",
    " custom-claude-exp ",
    [
      { id: "claude-live-1" },
      { id: "claude-opus-5-5" },
      { id: "custom-claude-exp" },
      { id: "  " },
    ],
  );

  assert.equal(merged[0], "custom-claude-exp", "currentModel should come first");
  assert.equal(merged[1], "claude-live-1", "unique live model should follow currentModel");
  assert.equal(merged[2], "claude-opus-5-5", "live model matching a hint is deduplicated");
  assert.equal(new Set(merged).size, merged.length, "options must be deduplicated");
  assert.ok(merged.includes("claude-sonnet-5-5"), "fallback hints must still be included");
});

test("4. DrawerHeader renders drawer-model-select, fetches listProviderModels, and avoids static global drawer-model-list id", async () => {
  const { drawerSrc } = await loadDrawerModelHelpers();

  assert.match(drawerSrc, /data-testid="drawer-model-select"/, "Should render <select data-testid=\"drawer-model-select\">");
  assert.match(drawerSrc, /data-testid="drawer-model-input"/, "Should support custom model input mode");
  assert.match(drawerSrc, /listProviderModels\((?:agent\.provider|effectiveProvider)\)/, "Should fetch live provider models for agent.provider");
  assert.match(drawerSrc, /aria-label="Model"/, "Model control should include aria-label=\"Model\"");
  assert.doesNotMatch(drawerSrc, /id="drawer-model-list"/, "Must not use static global datalist id=\"drawer-model-list\"");
  assert.doesNotMatch(drawerSrc, /list="drawer-model-list"/, "Must not bind input to static global list=\"drawer-model-list\"");
  assert.match(drawerSrc, /drawer-model-list-\$\{agent\.id\}/, "Datalist ID should be scoped per agent.id");
});
