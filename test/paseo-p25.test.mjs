import assert from "node:assert/strict";
import { test } from "node:test";
import { sortProviders, providerState, formatContextWindow, describeModel } from "../src/paseoProvidersLogic.ts";

test("providers sort available first then alpha", () => {
  const r = sortProviders([{ provider: "z", available: true }, { provider: "a", available: false }, { provider: "b", available: true }]);
  assert.deepEqual(r.map((x) => x.provider), ["b", "z", "a"]);
});
test("provider state", () => {
  assert.equal(providerState({ provider: "x", available: true }).tone, "ok");
  assert.equal(providerState({ provider: "x", available: false, error: "boom" }).label, "error");
  assert.equal(providerState({ provider: "x", available: false }).label, "unavailable");
});
test("context window + model description", () => {
  assert.equal(formatContextWindow(200000), "200k ctx");
  assert.equal(formatContextWindow(1000000), "1M ctx");
  assert.equal(formatContextWindow(undefined), "");
  assert.equal(describeModel({ id: "m", label: "M", isDefault: true, contextWindowMaxTokens: 128000, thinkingOptions: [{ id: "a", label: "A" }] }), "128k ctx · 1 thinking level · default");
});
