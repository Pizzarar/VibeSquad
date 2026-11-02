import assert from "node:assert/strict";
import test from "node:test";
import { sandboxPosture, NOT_REPORTED } from "../src/paseoSandboxLogic.ts";

const by = (rows, k) => rows.find((r) => r.key === k);

test("empty agent reports everything as not reported", () => {
  const rows = sandboxPosture({});
  assert.ok(rows.every((r) => r.value === NOT_REPORTED && r.source === "none"));
  assert.equal(rows[0].key, "mode");
});

test("features, runtimeInfo extra and mode are labelled by source", () => {
  const rows = sandboxPosture({
    features: [
      { type: "select", id: "sandbox", label: "Sandbox", value: "ws", options: [{ id: "ws", label: "Workspace write" }] },
      { type: "toggle", id: "approval_policy", label: "Approval", value: false },
    ],
    runtimeInfo: { extra: { networkAccess: true, writable_roots: ["/a", "/b"], nested: { x: 1 } } },
    currentModeId: "auto",
    availableModes: [{ id: "auto", label: "Auto", description: "edits freely" }],
  });
  assert.deepEqual([by(rows, "sandbox").value, by(rows, "sandbox").source], ["Workspace write", "feature"]);
  assert.deepEqual([by(rows, "approval").value, by(rows, "approval").source], ["off", "feature"]);
  assert.deepEqual([by(rows, "network").value, by(rows, "network").source], ["on", "runtimeInfo"]);
  assert.equal(by(rows, "roots").value, "/a, /b");
  assert.equal(by(rows, "mode").value, "Auto - edits freely");
  assert.equal(by(rows, "allowlist").source, "none");
});

test("mode falls back to runtimeInfo.modeId", () => {
  assert.equal(by(sandboxPosture({ runtimeInfo: { modeId: "plan" } }), "mode").value, "plan");
});
