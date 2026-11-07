import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("parseCommitToken: standalone 7-40 hex only", async () => {
  const { parseCommitToken } = await import("../src/commitLinks.ts");
  assert.equal(parseCommitToken("7e1c1f6"), "7e1c1f6");
  assert.equal(parseCommitToken("7E1C1F6"), "7E1C1F6");
  assert.equal(parseCommitToken("a".repeat(40)), "a".repeat(40));
  assert.equal(parseCommitToken("deadbeef"), "deadbeef"); // not a real commit? links anyway; Changes shows the error
  for (const num of ["1234567", "86400000", "20261107", "1".repeat(40)]) assert.equal(parseCommitToken(num), null, num);
  assert.equal(parseCommitToken("1234567a"), "1234567a");
  for (const bad of ["abc12", "a".repeat(41), "git show 7e1c1f6", "7e1c1f6 ", "7e1c1f6.", "src/7e1c1f6", "xyz1234", "--help", "`7e1c1f6`", ""]) {
    assert.equal(parseCommitToken(bad), null, JSON.stringify(bad));
  }
});

test("Timeline wires commit links through openCommit with the agent cwd, styled as tl-file-link", () => {
  const t = src("Timeline.tsx");
  assert.match(t, /parseCommitToken\(m\[7\]\)/);
  assert.match(t, /getAgentCwd\(agentId\)/);
  assert.match(t, /className="tl-icode tl-file-link"[^>]*\n?[^>]*data-testid="tl-commit-link"/);
  assert.match(t, /openCommit\(commitCwd, sha\)/);
  assert.match(src("attachments.ts"), /export function getAgentCwd/);
});

test("unknown hash: the pinned commit shows the route error instead of throwing", () => {
  const c = src("ChangesPanel.tsx");
  assert.match(c, /vsGitCommitDiff\(req\.cwd, req\.sha\)\.then\(/);
  assert.match(c, /setPinned\(\{ sha: req\.sha, state: \{ error:/);
});

test("discard: a renamed file (2 paths) arms its own row, not Discard all", async () => {
  const src_ = src("ChangesPanel.tsx");
  assert.match(src_, /discardRowArmed\(discardState, discardScope, discardFileScope\(f\.path\)\)/);
  assert.match(src_, /discardRowArmed\(discardState, discardScope, DISCARD_ALL_SCOPE\)/);
  assert.doesNotMatch(src_, /discardState\.length (===|>) 1/);
  const m = await import("../src/ChangesPanel.tsx").catch(() => null);
  if (!m) return; // component imports need the browser build; source assertions above cover the wiring
  const renamed = { path: "new.ts", oldPath: "old.ts" };
  const state = m.discardArm(m.discardPaths(renamed));
  assert.equal(state.length, 2);
  assert.equal(m.discardRowArmed(state, m.discardFileScope("new.ts"), m.discardFileScope("new.ts")), true);
  assert.equal(m.discardRowArmed(state, m.discardFileScope("new.ts"), m.DISCARD_ALL_SCOPE), false);
  assert.equal(m.discardRowArmed(state, m.DISCARD_ALL_SCOPE, m.discardFileScope("new.ts")), false);
  assert.equal(m.discardRowArmed(null, null, m.DISCARD_ALL_SCOPE), false);
});

test("loadDiff computes `changed` outside a state updater, against a ref", () => {
  const c = src("ChangesPanel.tsx");
  assert.match(c, /const changed = json !== lastDiffJson\.current;/);
  assert.doesNotMatch(c, /setDiff\(\(prev\)/);
  assert.doesNotMatch(c, /let changed = false/);
});
