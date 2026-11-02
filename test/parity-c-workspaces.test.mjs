import assert from "node:assert/strict";
import test from "node:test";
import { branchHint, branchShapeError, buildCreateSource, normalizeTitle, pinnedFirst, projectDeleteWarning, setupLabel } from "../src/workspaceLogic.ts";

test("normalizeTitle: blank resets to null", () => {
  assert.equal(normalizeTitle("  "), null);
  assert.equal(normalizeTitle(" hi "), "hi");
});

test("pinnedFirst: pinned on top (newest pin first), rest keep order", () => {
  const rows = [{ n: "a" }, { n: "b", p: "2026-01-01T00:00:00Z" }, { n: "c" }, { n: "d", p: "2026-02-01T00:00:00Z" }];
  assert.deepEqual(pinnedFirst(rows, (r) => r.p).map((r) => r.n), ["d", "b", "a", "c"]);
});

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

test("buildCreateSource", () => {
  assert.deepEqual(buildCreateSource("local", { path: " C:/x ", cwd: "", branch: "", base: "" }), { source: { kind: "directory", path: "C:/x" } });
  assert.ok("error" in buildCreateSource("local", { path: "", cwd: "", branch: "", base: "" }));
  assert.ok("error" in buildCreateSource("branch-off", { path: "", cwd: "", branch: "a", base: "" }));
  assert.ok("error" in buildCreateSource("branch-off", { path: "", cwd: "/r", branch: "a b", base: "" }));
  assert.deepEqual(buildCreateSource("branch-off", { path: "", cwd: "/r", branch: "feat/a", base: "main" }), {
    source: { kind: "worktree", cwd: "/r", action: "branch-off", branchName: "feat/a", baseBranch: "main", refName: "main" },
  });
  assert.deepEqual(buildCreateSource("checkout", { path: "", cwd: "/r", branch: "dev", base: "" }), {
    source: { kind: "worktree", cwd: "/r", action: "checkout", refName: "dev" },
  });
});

test("projectDeleteWarning and setupLabel", () => {
  assert.match(projectDeleteWarning("P", 1), /1 workspace\b/);
  assert.match(projectDeleteWarning("P", 3), /3 workspaces/);
  assert.match(projectDeleteWarning("P", 3), /does not delete any folders/);
  assert.equal(setupLabel(null), "no setup run");
  assert.equal(setupLabel("failed"), "setup failed");
});

import { dropFromOverlay, mergeOverlay, pruneOverlay } from "../src/workspaceLogic.ts";

test("overlay: patch applies over store, created fills gaps, store wins once caught up", () => {
  const stored = new Map([["a", { id: "a", title: null, pinnedAt: null, name: "branch" }]]);
  const ov = new Map([
    ["a", { patch: { title: "T", name: "T" } }],
    ["n", { created: { id: "n", title: null, pinnedAt: null, name: "new" }, patch: {} }],
  ]);
  const m = mergeOverlay(stored, ov);
  assert.equal(m.get("a").name, "T");
  assert.equal(m.get("n").name, "new");
  // store not yet caught up: kept
  assert.equal(pruneOverlay(stored, ov).has("a"), true);
  // daemon push arrives with the title -> evicted (even if name differs); created entry evicted once stored has it
  const caught = new Map([["a", { id: "a", title: "T", pinnedAt: null, name: "T2" }], ["n", { id: "n", title: null, pinnedAt: null, name: "new" }]]);
  assert.equal(pruneOverlay(caught, ov).size, 0);
  // a newer store value beats a stale... only if equal; differing store value keeps patch pending
  const other = new Map([["a", { id: "a", title: "X", pinnedAt: null, name: "X" }]]);
  assert.equal(pruneOverlay(other, new Map([["a", { patch: { title: "T" } }]])).has("a"), true);
  // reset title (null) is caught up by store title null/undefined
  assert.equal(pruneOverlay(new Map([["a", { id: "a", name: "b" }]]), new Map([["a", { patch: { title: null } }]])).size, 0);
});

test("overlay: dropFromOverlay evicts archived / removed ids", () => {
  const ov = new Map([["a", { patch: {} }], ["b", { patch: {} }]]);
  assert.deepEqual([...dropFromOverlay(ov, ["a", "z"]).keys()], ["b"]);
  assert.equal(dropFromOverlay(ov, ["z"]), ov);
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
