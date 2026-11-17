import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handoffLogText } from "../server/lead-handoff.mjs";
import { STANDING_RULES } from "../server/lessons.mjs";

describe("per success events (idea-142)", () => {
  it("handoff log text carries a parseable plan=<path>", () => {
    const t = handoffLogText({ oldId: "a1", successorId: "b2", oldOrd: 1, nextOrd: 2, trigger: "self", plan: "docs/PLAN_PER_POST03.md" });
    assert.match(t, /\(trigger=self\) plan=docs\/PLAN_PER_POST03\.md$/);
    assert.equal(t.match(/plan=(\S+)/)[1], "docs/PLAN_PER_POST03.md");
  });
  it("omits plan= when the lane has no plan file", () => {
    const t = handoffLogText({ oldId: "a1", successorId: "b2", oldOrd: 1, nextOrd: 2, trigger: "self", plan: "(none yet)" });
    assert.ok(!t.includes("plan="));
  });
  it("keeps the idle-worker suffix and the 240 char cap", () => {
    const t = handoffLogText({ oldId: "a1", successorId: "b2", oldOrd: 1, nextOrd: 2, trigger: "auto-250", plan: "docs/PLAN_X.md", idleRepointed: 3 });
    assert.match(t, /plan=docs\/PLAN_X\.md; 3 idle workers re-pointed/);
    assert.ok(handoffLogText({ oldId: "x".repeat(300), successorId: "b", oldOrd: 1, nextOrd: 2, trigger: "self" }).length <= 240);
  });
  it("STANDING_RULES tells leads to log done plan <PLAN_x> PASS", () => {
    assert.ok(STANDING_RULES.some((r) => r.includes('vs log done \\"plan <PLAN_x> PASS\\"') || r.includes('vs log done "plan <PLAN_x> PASS"')));
  });
});
