import assert from "node:assert/strict";
import test from "node:test";
import { featureChange, featureRows, noticeText, supportsApplyConfig, turnNote } from "../src/paseoFeaturesLogic.ts";

test("featureRows normalizes toggles and selects, drops junk", () => {
  const rows = featureRows([
    { type: "toggle", id: "fast", label: "Fast", value: 1 },
    { type: "select", id: "eff", label: "", value: null, options: [{ id: "a", label: "" }] },
    { type: "select", id: "bad", label: "x", value: "a" },
    null,
    { type: "toggle", label: "no id", value: true },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["fast", "eff"]);
  assert.equal(rows[0].value, true);
  assert.equal(rows[1].label, "eff");
  assert.equal(rows[1].options[0].label, "a");
  assert.deepEqual(featureRows(undefined), []);
});

test("featureChange skips no-ops", () => {
  const [t, s] = featureRows([
    { type: "toggle", id: "t", label: "T", value: false },
    { type: "select", id: "s", label: "S", value: "a", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  ]);
  assert.equal(featureChange(t, true), true);
  assert.equal(featureChange(t, false), null);
  assert.equal(featureChange(s, "b"), "b");
  assert.equal(featureChange(s, "a"), null);
});

test("supportsApplyConfig / turnNote / noticeText", () => {
  assert.equal(supportsApplyConfig({ agentConfigApply: true }), true);
  assert.equal(supportsApplyConfig(null), false);
  assert.equal(turnNote("running", "model"), "Model change applies from the next turn.");
  assert.equal(turnNote("idle", "model"), "");
  assert.equal(turnNote("running", "mode"), "");
  assert.equal(noticeText({ type: "warning", message: "hi" }), "warning: hi");
  assert.equal(noticeText(null), "");
});

test("featureRows: tooltip fallback, null options dropped; turnNote both", () => {
  const rows = featureRows([
    { type: "toggle", id: "f", label: "F", tooltip: "Toggle fast", value: false },
    { type: "select", id: "s", label: "S", value: "x", options: [null, { id: "x", label: "X" }, { id: "" }] },
  ]);
  assert.equal(rows[0].hint, "Toggle fast");
  assert.deepEqual(rows[1].options, [{ id: "x", label: "X" }]);
  assert.equal(turnNote("running", "both"), "Model and thinking changes apply from the next turn.");
});
