import assert from "node:assert/strict";
import test from "node:test";
import { branchHint, branchShapeError } from "../src/workspaceLogic.ts";

test("branchShapeError", () => {
  assert.equal(branchShapeError("feat/x-1"), null);
  for (const bad of ["", "a b", "a..b", "-x", "x/", "x.lock", "a~b", "a:b", "a//b", ".hid/x", "a@{b"]) assert.ok(branchShapeError(bad), bad);
});

test("branchHint tones", () => {
  assert.equal(branchHint("", null), null);
  assert.equal(branchHint("a b", null).tone, "bad");
  assert.equal(branchHint("ok", null).tone, "muted");
  assert.equal(branchHint("ok", { exists: false, isRemote: false, resolvedRef: null, error: null }).tone, "ok");
  assert.equal(branchHint("ok", { exists: true, isRemote: true, resolvedRef: "origin/ok", error: null }).tone, "warn");
  assert.equal(branchHint("ok", { exists: false, isRemote: false, resolvedRef: null, error: "boom" }).text, "boom");
});

test("workspaceIdForAgent: own id first, else deepest folder holding the cwd", async () => {
  const { workspaceIdForAgent } = await import("../src/workspaceLogic.ts");
  const ws = new Map([
    ["root", { workspaceDirectory: "C:\\repo" }],
    ["wt", { workspaceDirectory: "C:\\repo\\.worktrees\\a\\" }],
    ["other", { workspaceDirectory: "C:\\repo-two" }],
  ]);
  assert.equal(workspaceIdForAgent({ cwd: "C:\\repo\\.worktrees\\a\\src", workspaceId: "own" }, ws), "own");
  assert.equal(workspaceIdForAgent({ cwd: "c:/repo/.worktrees/a/src" }, ws), "wt");
  assert.equal(workspaceIdForAgent({ cwd: "C:\\repo" }, ws), "root");
  assert.equal(workspaceIdForAgent({ cwd: "C:\\repo-two\\x" }, ws), "other");
  assert.equal(workspaceIdForAgent({ cwd: "C:\\elsewhere" }, ws), null);
  assert.equal(workspaceIdForAgent({ cwd: "" }, ws), null);
});
