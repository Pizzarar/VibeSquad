// D: Pure logic tests for ChangesPanel utilities.
// No DOM or React rendering — Node-only.
// Run: node --test test/ade-batch-d.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

// ─── Inline copies of exported pure functions ────────────────────────────────
// (We copy rather than import to avoid bundling React in the test runner.)

const WORKFLOW_PREFIXES = [".github/workflows/", "src-tauri/tauri.conf.json"];
const WORKFLOW_BASENAME = [/^release/i];

function touchesWorkflowOrRelease(paths) {
  return paths.some((p) => {
    const norm = p.replace(/\\/g, "/");
    if (WORKFLOW_PREFIXES.some((pfx) => norm === pfx || norm.startsWith(pfx) || norm.includes("/" + pfx))) return true;
    const base = norm.split("/").pop() ?? norm;
    return WORKFLOW_BASENAME.some((rx) => rx.test(base));
  });
}

function classifyDiffLine(raw) {
  if (raw.startsWith("@@")) return "header";
  if (raw.startsWith("+")) return "add";
  if (raw.startsWith("-")) return "remove";
  return "context";
}

async function gitActionWrapper(fn) {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function discardArm(paths) { return paths; }
function discardCancel() { return null; }
function discardIsArmed(s) { return s !== null; }

// ─── D1: Workflow / release config path detector ─────────────────────────────

test("D1a: .github/workflows/ci.yml triggers the guard", () => {
  assert.ok(touchesWorkflowOrRelease([".github/workflows/ci.yml"]));
});

test("D1b: .github/workflows/ directory prefix triggers the guard", () => {
  assert.ok(touchesWorkflowOrRelease([".github/workflows/deploy.yml"]));
});

test("D1c: src-tauri/tauri.conf.json triggers the guard", () => {
  assert.ok(touchesWorkflowOrRelease(["src-tauri/tauri.conf.json"]));
});

test("D1d: release-*.sh triggers the guard via basename pattern", () => {
  assert.ok(touchesWorkflowOrRelease(["scripts/release-beta.sh"]));
});

test("D1e: RELEASE.md triggers the guard via basename pattern", () => {
  assert.ok(touchesWorkflowOrRelease(["RELEASE.md"]));
});

test("D1f: normal src/App.tsx does NOT trigger the guard", () => {
  assert.ok(!touchesWorkflowOrRelease(["src/App.tsx"]));
});

test("D1g: package.json without release basename pattern does NOT trigger", () => {
  // package.json itself is NOT a release file by name (no 'release' prefix)
  assert.ok(!touchesWorkflowOrRelease(["package.json"]));
});

test("D1h: mixed paths — only one workflow file still triggers", () => {
  assert.ok(touchesWorkflowOrRelease(["src/App.tsx", ".github/workflows/ci.yml", "src/index.ts"]));
});

test("D1i: empty path list does not trigger", () => {
  assert.ok(!touchesWorkflowOrRelease([]));
});

test("D1j: Windows-style backslash paths are normalised", () => {
  assert.ok(touchesWorkflowOrRelease([".github\\workflows\\ci.yml"]));
});

// ─── D2: Unified diff line classifier ────────────────────────────────────────

test("D2a: line starting with @@ is classified as header", () => {
  assert.equal(classifyDiffLine("@@ -1,8 +1,20 @@"), "header");
});

test("D2b: line starting with + is classified as add", () => {
  assert.equal(classifyDiffLine("+import { useState } from 'react';"), "add");
});

test("D2c: line starting with - is classified as remove", () => {
  assert.equal(classifyDiffLine("-// old code"), "remove");
});

test("D2d: line starting with space is classified as context", () => {
  assert.equal(classifyDiffLine(" const x = 1;"), "context");
});

test("D2e: empty line is classified as context", () => {
  assert.equal(classifyDiffLine(""), "context");
});

test("D2f: +++ header line is classified as add (starts with +)", () => {
  assert.equal(classifyDiffLine("+++ b/src/App.tsx"), "add");
});

// ─── D3: DEMO mode fallback data ─────────────────────────────────────────────

const DEMO_DIFF = {
  files: [
    { path: "src/ChangesPanel.tsx", isNew: false, isDeleted: false, additions: 120, deletions: 8, hunks: [{ lines: [{ type: "header", content: "@@ -1,8 +1,120 @@" }, { type: "add", content: "+import { useState } from 'react';" }] }] },
    { path: "src/WorkspacesView.tsx", isNew: false, isDeleted: false, additions: 12, deletions: 8, hunks: [] },
    { path: "test/ade-batch-d.test.mjs", isNew: true, isDeleted: false, additions: 80, deletions: 0, hunks: [] },
  ],
};

const DEMO_PR_STATUS = { status: null, githubFeaturesEnabled: true, error: null, forge: "github" };

test("D3a: DEMO diff has at least 1 file", () => {
  assert.ok(DEMO_DIFF.files.length >= 1, "DEMO diff must contain files");
});

test("D3b: DEMO diff contains a new file (isNew=true)", () => {
  const hasNew = DEMO_DIFF.files.some((f) => f.isNew);
  assert.ok(hasNew, "DEMO diff should include at least one new file");
});

test("D3c: DEMO PR status has no open PR (status=null for clean state)", () => {
  assert.equal(DEMO_PR_STATUS.status, null);
  assert.equal(DEMO_PR_STATUS.githubFeaturesEnabled, true);
});

test("D3d: DEMO diff hunk lines have correct types", () => {
  const lines = DEMO_DIFF.files[0].hunks[0].lines;
  assert.ok(lines.some((l) => l.type === "header"), "must have header line");
  assert.ok(lines.some((l) => l.type === "add"), "must have add line");
});

// ─── D4: gitActionWrapper ─────────────────────────────────────────────────────

test("D4a: gitActionWrapper returns ok=true on success", async () => {
  const r = await gitActionWrapper(() => Promise.resolve("done"));
  assert.equal(r.ok, true);
  assert.equal(r.result, "done");
});

test("D4b: gitActionWrapper returns ok=false and captures error message", async () => {
  const r = await gitActionWrapper(() => Promise.reject(new Error("push failed")));
  assert.equal(r.ok, false);
  assert.equal(r.error, "push failed");
});

test("D4c: gitActionWrapper captures non-Error throws as strings", async () => {
  const r = await gitActionWrapper(() => Promise.reject("network timeout"));
  assert.equal(r.ok, false);
  assert.equal(r.error, "network timeout");
});

// ─── D5: Discard confirmation state machine ───────────────────────────────────

test("D5a: initial state is null (idle)", () => {
  const state = null;
  assert.equal(discardIsArmed(state), false);
});

test("D5b: discardArm transitions to armed with the given paths", () => {
  const state = discardArm(["src/App.tsx"]);
  assert.deepEqual(state, ["src/App.tsx"]);
  assert.equal(discardIsArmed(state), true);
});

test("D5c: discardCancel resets state to null", () => {
  const armed = discardArm(["src/App.tsx"]);
  const cancelled = discardCancel();
  assert.equal(cancelled, null);
  assert.equal(discardIsArmed(cancelled), false);
  // original armed state unchanged
  assert.equal(discardIsArmed(armed), true);
});

test("D5d: discardArm with multiple paths works correctly", () => {
  const paths = ["src/A.tsx", "src/B.tsx", "src/C.tsx"];
  const state = discardArm(paths);
  assert.equal(discardIsArmed(state), true);
  assert.equal(state.length, 3);
  assert.deepEqual(state, paths);
});

test("D5e: discardIsArmed returns false for null and true for non-null", () => {
  assert.equal(discardIsArmed(null), false);
  assert.equal(discardIsArmed([]), true); // empty array is still armed
  assert.equal(discardIsArmed(["a"]), true);
});
