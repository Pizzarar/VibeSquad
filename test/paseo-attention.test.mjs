import assert from "node:assert/strict";
import test from "node:test";
import { createAlertDedupe, decideEvent, workspaceToClear } from "../src/paseoAttentionCore.ts";

test("dedupe: second claim inside the window loses, other tone/agent wins, window expiry re-arms", () => {
  const d = createAlertDedupe(1000);
  assert.equal(d.claim("a", "finished", 0), true);
  assert.equal(d.claim("a", "finished", 500), false);
  assert.equal(d.claim("a", "error", 500), true);
  assert.equal(d.claim("b", "finished", 500), true);
  assert.equal(d.claim("a", "finished", 1000), true);
});

test("decideEvent honours shouldNotify and the pref gate", () => {
  const on = () => true;
  assert.equal(decideEvent({ shouldNotify: true, reason: "finished" }, on), "alert");
  assert.equal(decideEvent({ shouldNotify: false, reason: "finished" }, on), "skip");
  assert.equal(decideEvent({ shouldNotify: true, reason: "error" }, (t) => t !== "error"), "skip");
});

test("workspaceToClear: only when no other agent in the workspace needs attention", () => {
  const agents = [
    { id: "a", workspaceId: "w1" },
    { id: "b", workspaceId: "w1" },
    { id: "c", workspaceId: "w2" },
    { id: "d" },
  ];
  assert.equal(workspaceToClear("a", agents, () => false), "w1");
  assert.equal(workspaceToClear("a", agents, (x) => x.id === "b"), null);
  assert.equal(workspaceToClear("a", agents, (x) => x.id === "c"), "w1");
  assert.equal(workspaceToClear("d", agents, () => false), null);
  assert.equal(workspaceToClear("zzz", agents, () => false), null);
});
