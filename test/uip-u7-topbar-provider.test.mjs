import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../src/DrawerHeader.tsx", import.meta.url), "utf8");
const pin = readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");

test("provider dropdown offers the four canonical providers", () => {
  for (const l of ["◆ Gemini", "✶ Claude", "▲ OpenCode", "● Codex"]) assert.ok(src.includes(`"${l}"`), l);
  assert.match(src, /data-testid="drawer-provider-select"/);
});

test("resolveProviderSwitchTarget resolves provider/model/mode and skips the current provider", async (t) => {
  const { stripTypeScriptTypes } = await import("node:module");
  if (typeof stripTypeScriptTypes !== "function") return t.skip("node:module.stripTypeScriptTypes is unavailable on this Node");
  const grab = (re, what) => {
    const m = src.match(re);
    assert.ok(m, `could not locate ${what} in DrawerHeader.tsx`);
    return m[0];
  };
  const counter = grab(/const COUNTERPART_PROFILE_MAP[\s\S]*?\r?\n};\r?\n/, "COUNTERPART_PROFILE_MAP");
  const opposite = grab(/export type OppositeProviderTarget[\s\S]*?(?=export type DrawerHeaderProps)/, "oppositeProviderTarget");
  const js = stripTypeScriptTypes(counter + opposite, { mode: "strip" });
  const mod = await import("data:text/javascript," + encodeURIComponent(js));
  assert.equal(mod.normalizeProviderId("gemini"), "antigravity-cli");
  assert.equal(mod.normalizeProviderId("anthropic"), "claude");
  assert.equal(mod.normalizeProviderId("openai"), "codex");
  assert.equal(mod.resolveProviderSwitchTarget("claude", "claude"), null);
  const g = mod.resolveProviderSwitchTarget("claude", "antigravity-cli", "Lead - Claude", "lead");
  assert.equal(g.provider, "antigravity-cli");
  assert.equal(g.profile, "Lead - Gemini");
  const c = mod.resolveProviderSwitchTarget("opencode", "codex");
  assert.deepEqual([c.provider, c.model, c.profile], ["codex", "gpt-5.4", undefined]);
});

test("compact bar order: provider, model, thinking, mode, working chip", () => {
  const i = src.indexOf('data-testid="drawer-head-compact"');
  const blk = src.slice(i, i + 900);
  const order = ["{providerSelect}", "{modelControl}", "{thinkingSelect}", "{modeSelect}", "<WorkingChip"].map((k) => blk.indexOf(k));
  assert.ok(order.every((n) => n > 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.doesNotMatch(blk, /agent\.provider\}\//);
  assert.doesNotMatch(blk, /providerSwitchBtn/);
});

test("lane handle sits right after the breadcrumb", () => {
  assert.ok(pin.indexOf("<TopBreadcrumb") < pin.indexOf('data-testid="pin-focus-handle"'));
  assert.ok(pin.indexOf('data-testid="pin-focus-handle"') < pin.indexOf('ref={slotRef("bar")}'));
});
