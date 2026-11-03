import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { transformSync } from "rolldown/utils";
import { loadProfiles, saveProfiles } from "../server/vibesquad-api.mjs";

// pixel.tsx is TypeScript + JSX: transpile it once to a temp .mjs and import that.
const src = readFileSync(resolve(import.meta.dirname, "..", "src", "pixel.tsx"), "utf8");
const code = transformSync("pixel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } }).code;
const dir = mkdtempSync(join(tmpdir(), "vs-provider-icons-"));
const file = join(dir, "pixel.mjs");
writeFileSync(file, code);
const {
  providerSpec,
  setProviderOverrides,
  getProviderOverrides,
  GENERIC_HUES,
  DEDICATED_PROVIDER_KEYS,
  listDedicatedProviders,
} = await import(pathToFileURL(file).href);

const DEDICATED = ["claude", "codex", "antigravity-cli", "opencode", "cursor", "copilot", "codewhale", "pi"];

test.afterEach(() => setProviderOverrides(null));

test("8 dedicated providers have distinct keys, colors and symbols", () => {
  const specs = DEDICATED.map((p) => providerSpec(p));
  assert.equal(new Set(specs.map((s) => s.key)).size, 8);
  assert.equal(new Set(specs.map((s) => s.color)).size, 8);
  assert.deepEqual(
    specs.map((s) => s.symbol),
    ["✶", "●", "◆", "▲", "▸", "❖", "≈", "π"],
  );
  assert.equal(providerSpec("gemini").key, "gemini");
});

test("listDedicatedProviders returns all 8 dedicated provider specs with distinct keys, hues and glyphs", () => {
  const dedicated = listDedicatedProviders();
  assert.equal(dedicated.length, 8);
  assert.deepEqual(
    dedicated.map((s) => s.key),
    ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "codewhale", "pi"],
  );
  assert.deepEqual(DEDICATED_PROVIDER_KEYS, ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "codewhale", "pi"]);
  assert.equal(new Set(dedicated.map((s) => s.color)).size, 8);
  assert.deepEqual(
    dedicated.map((s) => s.symbol),
    ["✶", "●", "◆", "▲", "▸", "❖", "≈", "π"],
  );
});

test("keyed by source, not model", () => {
  const s = providerSpec("opencode/deepseek/deepseek-v4-pro");
  assert.equal(s.key, "opencode");
  assert.equal(s.name, "OpenCode");
  const d = providerSpec("deepseek");
  assert.equal(d.key, "deepseek");
  assert.equal(d.symbol, "D");
  assert.ok(GENERIC_HUES.includes(d.color));
});

test("cut providers fall through to a stable generic spec", () => {
  for (const [p, initial] of [["aider", "A"], ["goose", "G"], ["kilo", "K"], ["openhands", "O"]]) {
    const a = providerSpec(p);
    assert.equal(a.symbol, initial);
    assert.ok(GENERIC_HUES.includes(a.color));
    assert.deepEqual(providerSpec(p), a);
  }
  assert.equal(providerSpec("custom-acp", "Zed Agent").symbol, "Z");
  assert.equal(providerSpec("custom-acp", "Zed Agent").name, "Zed Agent");
  assert.equal(providerSpec("").symbol, "◈");
});

test("setProviderOverrides changes color, dim, symbol and name", () => {
  setProviderOverrides({ aider: { color: "#123456", symbol: "★", name: "Aider!" } });
  const s = providerSpec("aider");
  assert.equal(s.color, "#123456");
  assert.equal(s.dim, "#071421");
  assert.equal(s.symbol, "★");
  assert.equal(s.name, "Aider!");
  setProviderOverrides({ claude: { color: "#00ff00", dim: "#003300" } });
  assert.equal(providerSpec("claude/opus").dim, "#003300");
  assert.equal(providerSpec("claude-code/sonnet").dim, "#003300");
  setProviderOverrides({ gemini: { color: "#112233", symbol: "✦", name: "AGY" } });
  assert.equal(providerSpec("antigravity-cli/gemini-pro").color, "#112233");
  assert.equal(providerSpec("antigravity-cli/gemini-pro").symbol, "✦");
  assert.equal(providerSpec("antigravity-cli/gemini-pro").name, "AGY");
  setProviderOverrides({ "antigravity-cli": { color: "#445566", symbol: "◈" } });
  assert.equal(providerSpec("antigravity-cli/gemini-pro").color, "#445566");
  assert.equal(providerSpec("antigravity-cli/gemini-pro").symbol, "◈");
  assert.deepEqual(getProviderOverrides(), { "antigravity-cli": { color: "#445566", symbol: "◈" } });
  setProviderOverrides(null);
  assert.equal(providerSpec("aider").symbol, "A");
});

test("profiles.json providers block is loaded and survives saves", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-provider-profiles-"));
  const path = join(root, ".vibesquad", "profiles.json");
  mkdirSync(join(root, ".vibesquad"), { recursive: true });
  const profile = { name: "Impl - Test", provider: "claude", model: "m", modeId: "default", notes: "" };
  writeFileSync(
    path,
    JSON.stringify({ version: 1, providers: { Aider: { color: "#00ffaa", symbol: "Å", name: "Aider", bogus: 1 }, bad: { color: "red" } }, profiles: [profile] }),
  );
  const state = loadProfiles(path, { paseoProfiles: [], autoSeed: false });
  assert.deepEqual(state.providerOverrides, { aider: { color: "#00ffaa", symbol: "Å", name: "Aider" } });

  saveProfiles({ profile: { ...profile, model: "m2" } }, path);
  saveProfiles({ profile: { name: "Other", provider: "codex", model: "x", modeId: "default", notes: "" } }, path);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.providers.Aider.symbol, "Å");
  const again = loadProfiles(path, { paseoProfiles: [], autoSeed: false });
  assert.equal(again.providerOverrides.aider.color, "#00ffaa");

  setProviderOverrides(again.providerOverrides);
  const s = providerSpec("aider");
  assert.equal(s.color, "#00ffaa");
  assert.equal(s.symbol, "Å");
});
