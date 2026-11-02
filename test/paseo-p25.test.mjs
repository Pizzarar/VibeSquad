import assert from "node:assert/strict";
import { test } from "node:test";
import { sortProviders, providerState, formatContextWindow, describeModel } from "../src/paseoProvidersLogic.ts";
import { isTakeable, toggleSelection, pruneSelection, selectedProposals, describeTarget, outcomeLabel, summarizeResults } from "../src/paseoPluginUpdatesLogic.ts";

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
const prev = [
  { id: "a", outcome: "update", proposal: { id: "a" }, target: { kind: "git", commit: "1234567890" }, current: { currentRevision: "abcdef0123" } },
  { id: "b", outcome: "current" },
  { id: "c", outcome: "update" },
];
test("takeable + selection", () => {
  assert.deepEqual(prev.map(isTakeable), [true, false, false]);
  const s = toggleSelection(new Set(), "a");
  assert.ok(s.has("a"));
  assert.ok(!toggleSelection(s, "a").has("a"));
  assert.deepEqual([...pruneSelection(new Set(["a", "b"]), prev)], ["a"]);
  assert.deepEqual(selectedProposals(prev, new Set(["a", "b", "c"])), [{ id: "a" }]);
});
test("describe + labels + summary", () => {
  assert.equal(describeTarget(prev[0]), "abcdef01 → 12345678");
  assert.equal(describeTarget({ id: "n", outcome: "update", target: { kind: "npm", version: "2.0.0" } }), "? → v2.0.0");
  assert.equal(outcomeLabel("current").tone, "ok");
  assert.equal(summarizeResults([{ id: "a", outcome: "updated" }, { id: "b", outcome: "error" }]), "1 updated, 1 failed");
});
