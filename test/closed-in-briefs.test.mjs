// unit-closed-in-briefs: the three informational text builders (hub boot "Teams", "In flight" boot block, and the
// "## Who's here" brief section) must treat a closed-but-resumable lead as live, not as "no lead running". Before
// c4d023a + this fix they used a raw `status !== "closed"` filter, so a lost/parked lead (resumable) read as leaderless.
// Each builder is exercised with a closed+resumable lead (counted live) and a closed+!resumable lead (excluded).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubTeamsBlock } from "../server/brainstorm.mjs";
import { liveInFlightBlock } from "../server/in-flight.mjs";
import { whosHereBody } from "../server/whos-here.mjs";

// A single feature-lane lead. `over` supplies status/resumable (the only thing that varies per case).
const lead = (over = {}) => ({
  id: "rn-lead",
  title: "★ Bug9 · fixing",
  status: "idle",
  labels: { team: "vibesquad", lane: "own", role: "lead", job: "fixing" },
  ...over,
});

test("hubTeamsBlock counts a closed+resumable lead as live and drops a closed+!resumable lead", () => {
  const team = { id: "vibesquad", lanes: [{ id: "own", name: "Own", state: "pinned" }] };
  const resumable = hubTeamsBlock({ team, agents: [lead({ status: "closed", resumable: true })] });
  assert.match(resumable, /Own \(`own`\) · pinned · lead working: fixing/);
  const dead = hubTeamsBlock({ team, agents: [lead({ status: "closed", resumable: false })] });
  assert.match(dead, /Own \(`own`\) · pinned · no lead running/);
});

test("liveInFlightBlock counts a closed+resumable lead as live and drops a closed+!resumable lead", () => {
  const home = mkdtempSync(join(tmpdir(), "vs-closed-briefs-"));
  try {
    const resumable = liveInFlightBlock({ agents: [lead({ status: "closed", resumable: true })], laneId: "own", teamId: "vibesquad", home });
    assert.match(resumable, /- Lead: ★ Bug9 · fixing \[closed\]/);
    const dead = liveInFlightBlock({ agents: [lead({ status: "closed", resumable: false })], laneId: "own", teamId: "vibesquad", home });
    assert.match(dead, /- Lead: none running/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("whosHereBody counts a closed+resumable lead as live and drops a closed+!resumable lead", () => {
  const resumable = whosHereBody([lead({ status: "closed", resumable: true })], "own");
  assert.match(resumable, /- Lead: ★ Bug9 · fixing/);
  const dead = whosHereBody([lead({ status: "closed", resumable: false })], "own");
  assert.match(dead, /- Lead: none\n/);
});
