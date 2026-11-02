// Block D2: pure git-history helpers. Run: node --test test/parity-d2-git.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import * as m from "../src/gitHistoryLogic.ts";

test("parsePrUrl", () => {
  assert.deepEqual(m.parsePrUrl("https://github.com/Pizzarar/VibeSquad/pull/42"), { repoOwner: "Pizzarar", repoName: "VibeSquad", number: 42 });
  assert.equal(m.parsePrUrl("https://github.com/a/b/issues/1"), null);
  assert.equal(m.parsePrUrl(null), null);
});

test("branchNameError", () => {
  assert.equal(m.branchNameError("feat/ok-1"), null);
  assert.ok(m.branchNameError(""));
  assert.ok(m.branchNameError("a b"));
  assert.ok(m.branchNameError("a..b"));
  assert.ok(m.branchNameError("-x"));
  assert.ok(m.branchNameError("x.lock"));
  assert.ok(m.branchNameError("x/.hid"));
  assert.ok(m.branchNameError("same", "same"));
  assert.ok(m.branchNameError("a~b"));
});

test("relTime", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(m.relTime("2026-11-02T11:59:50Z", now), "now");
  assert.equal(m.relTime("2026-11-02T11:30:00Z", now), "30m");
  assert.equal(m.relTime("2026-11-02T09:00:00Z", now), "3h");
  assert.equal(m.relTime("2026-10-30T12:00:00Z", now), "3d");
  assert.equal(m.relTime("garbage", now), "");
});

test("commit file badges + clip", () => {
  assert.equal(m.commitFileBadge("added"), "A");
  assert.equal(m.commitFileBadge("renamed"), "R");
  assert.equal(m.commitFileBadge(undefined), "M");
  assert.equal(m.commitFileBadgeClass("deleted"), "del");
  assert.equal(m.clip("abcdef", 3), "abc…");
  assert.equal(m.clip(null), "");
});
