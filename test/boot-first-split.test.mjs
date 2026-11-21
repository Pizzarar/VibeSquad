import assert from "node:assert/strict";
import test from "node:test";
import { bootSizeMetric, measureFirstPromptParts } from "../server/hooks/agent-duties.ts";

// idea-327 (EXP5): split the boot-size `first=` total into firstPacket / firstArtifact / firstBrief / firstPlan.

test("measureFirstPromptParts: handoff packet + lane artifact + brief + plan", () => {
  const packet = "--- BEGIN HANDOFF PACKET (C:/x/packet.md) ---\nPACKET BODY\n--- END HANDOFF PACKET ---";
  const artifact = "<!-- vibesquad:lane-artifact:begin lane=usage -->\nARTIFACT BODY\n<!-- vibesquad:lane-artifact:end -->";
  const brief = "--- BEGIN BRAINSTORM SUMMARY (C:/x/summary.md) ---\nSUMMARY BODY\n--- END BRAINSTORM SUMMARY ---";
  const plan = "You are the successor lead for lane `usage`.\nDo the work.";
  const prompt = [packet, artifact, brief, plan].join("\n");

  const parts = measureFirstPromptParts(prompt);
  assert.equal(parts.firstPacket, packet.length, "packet span");
  assert.equal(parts.firstArtifact, artifact.length, "artifact span");
  assert.equal(parts.firstBrief, brief.length, "brief span");
  assert.ok(parts.firstPlan > 0, "plan remainder is non-empty");
  assert.equal(
    parts.firstPacket + parts.firstArtifact + parts.firstBrief + parts.firstPlan,
    prompt.length,
    "the four parts partition the prompt",
  );
});

test("measureFirstPromptParts: docs/brainstorm brief block is counted as firstBrief", () => {
  const brief = "--- BEGIN docs/brainstorm/usage.md ---\nBRIEF BODY\n--- END docs/brainstorm/usage.md ---";
  const plan = "Rules (BF-P1):\nWork the top Open item.";
  const prompt = [brief, plan].join("\n");

  const parts = measureFirstPromptParts(prompt);
  assert.equal(parts.firstPacket, 0);
  assert.equal(parts.firstArtifact, 0);
  assert.equal(parts.firstBrief, brief.length);
  assert.equal(parts.firstPlan, prompt.length - brief.length);
});

test("measureFirstPromptParts: empty prompt -> all zero", () => {
  assert.deepEqual(measureFirstPromptParts(""), {
    firstPacket: 0,
    firstArtifact: 0,
    firstBrief: 0,
    firstPlan: 0,
  });
});

test("measureFirstPromptParts: no markers -> structured parts zero, plan is the whole prompt", () => {
  const plain = "Just a work order, no markers at all.";
  assert.deepEqual(measureFirstPromptParts(plain), {
    firstPacket: 0,
    firstArtifact: 0,
    firstBrief: 0,
    firstPlan: plain.length,
  });
});

test("bootSizeMetric appends the four first-prompt parts after estTok", () => {
  const line = bootSizeMetric("worker", 1000, {
    provider: "claude",
    lane: "usage",
    sys: 100,
    plugin: 600,
    artifact: 300,
    brief: 0,
    first: 21,
    firstPacket: 5,
    firstArtifact: 7,
    firstBrief: 11,
    firstPlan: 13,
  });
  assert.equal(
    line,
    "boot-size role=worker provider=claude lane=usage chars=1000 total=1021 sys=100 plugin=600 artifact=300 brief=0 first=21 estTok=256 firstPacket=5 firstArtifact=7 firstBrief=11 firstPlan=13",
  );
});
