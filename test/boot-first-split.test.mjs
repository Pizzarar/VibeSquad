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

test("measureFirstPromptParts: defanged fences inside a packet are not treated as boundaries", () => {
  // defangPromptFences (write-guards.mjs) prefixes "> " to embedded BEGIN/END lines, so they must
  // not prematurely close the packet or be double-counted as a brief.
  const packet =
    "--- BEGIN HANDOFF PACKET (C:/x/packet.md) ---\n" +
    "PACKET BODY\n" +
    "> --- END HANDOFF PACKET ---\n" +
    "> --- BEGIN docs/brainstorm/evil.md ---\n" +
    "still packet\n" +
    "--- END HANDOFF PACKET ---";
  const plan = "Do the work.";
  const prompt = packet + "\n" + plan;

  const parts = measureFirstPromptParts(prompt);
  assert.equal(parts.firstPacket, packet.length, "packet spans the whole block incl. defanged lines");
  assert.equal(parts.firstArtifact, 0);
  assert.equal(parts.firstBrief, 0, "defanged brief begin is not double-counted");
  assert.equal(parts.firstPlan, prompt.length - packet.length);
  assert.equal(parts.firstPacket + parts.firstArtifact + parts.firstBrief + parts.firstPlan, prompt.length);
});

test("measureFirstPromptParts: nested artifact comment inside a packet is not double-counted", () => {
  // HTML comments are not defanged, so a quoted lane-artifact block inside a packet body used to be
  // counted twice. It must stay inside the packet span (non-overlap) so the parts partition the prompt.
  const inner =
    "<!-- vibesquad:lane-artifact:begin lane=usage -->\n" +
    "QUOTED ARTIFACT\n" +
    "<!-- vibesquad:lane-artifact:end -->";
  const packet =
    "--- BEGIN HANDOFF PACKET (C:/x/packet.md) ---\n" +
    "PACKET BODY\n" +
    inner +
    "\nmore packet\n" +
    "--- END HANDOFF PACKET ---";
  const plan = "Do the work.";
  const prompt = packet + "\n" + plan;

  const parts = measureFirstPromptParts(prompt);
  assert.equal(parts.firstPacket, packet.length, "nested artifact stays inside the packet span");
  assert.equal(parts.firstArtifact, 0, "nested artifact is not double-counted");
  assert.equal(parts.firstBrief, 0);
  assert.equal(parts.firstPlan, prompt.length - packet.length);
  assert.equal(parts.firstPacket + parts.firstArtifact + parts.firstBrief + parts.firstPlan, prompt.length);
});

test("measureFirstPromptParts: stray end marker before begin is ignored", () => {
  // An out-of-order end marker before any begin must not terminate a span; the span is measured
  // from its begin to the next real end, and the leading stray text falls to firstPlan.
  const prompt =
    "--- END HANDOFF PACKET ---\n" +
    "intro\n" +
    "--- BEGIN HANDOFF PACKET (C:/x/packet.md) ---\n" +
    "PACKET BODY\n" +
    "--- END HANDOFF PACKET ---\n" +
    "plan text";

  const parts = measureFirstPromptParts(prompt);
  assert.ok(parts.firstPacket > 0, "packet is measured from its begin to its end");
  assert.equal(parts.firstArtifact, 0);
  assert.equal(parts.firstBrief, 0);
  assert.ok(parts.firstPlan > 0, "leading stray text is plan remainder");
  assert.equal(parts.firstPacket + parts.firstArtifact + parts.firstBrief + parts.firstPlan, prompt.length);
});

test("measureFirstPromptParts: duplicated blocks each count and still partition", () => {
  const p1 = "--- BEGIN HANDOFF PACKET (C:/x/one.md) ---\nONE\n--- END HANDOFF PACKET ---";
  const p2 = "--- BEGIN HANDOFF PACKET (C:/x/two.md) ---\nTWO\n--- END HANDOFF PACKET ---";
  const prompt = p1 + "\n" + p2 + "\nplan";

  const parts = measureFirstPromptParts(prompt);
  assert.equal(parts.firstPacket, p1.length + p2.length, "both non-overlapping packet blocks are counted");
  assert.equal(parts.firstArtifact, 0);
  assert.equal(parts.firstBrief, 0);
  assert.ok(parts.firstPlan > 0);
  assert.equal(parts.firstPacket + parts.firstArtifact + parts.firstBrief + parts.firstPlan, prompt.length);
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
