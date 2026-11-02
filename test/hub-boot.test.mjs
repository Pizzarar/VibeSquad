// PLAN_HUB_BUDDY block 3: hub boot prompt lists the Teams and threads; a Team Buddy's prompt is unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { buildBrainstormInitialPrompt, hubTeamsBlock, HUB_BOOT_RULES } from "../server/brainstorm.mjs";
import { newPinBrief } from "../server/pin-ideas.mjs";

const team = {
  id: "sq",
  lanes: [
    { id: "sq", name: "Squad hub" },
    { id: "alpha", name: "Alpha", state: "pinned" },
    { id: "beta", name: "Beta", state: "done" },
    { id: "gone", name: "Gone", state: "removed" },
  ],
};
const agents = [
  { id: "1", status: "running", labels: { lane: "alpha", role: "lead", job: "drop files" } },
  { id: "2", status: "closed", labels: { lane: "beta", role: "lead", job: "stale" } },
];
const base = { laneId: "sq", laneUpper: "SQ", buddyName: "SQ Buddy", latestPlan: "docs/P.md", inFlight: "In flight (live)", summaryContent: "## Unsplit threads\n- dark mode\n- search" };

test("hub boot prompt lists live Teams (state + lead job) and the brief's unsplit threads", () => {
  const block = hubTeamsBlock({ team, agents });
  assert.match(block, /Alpha \(`alpha`\) · pinned · lead working: drop files/);
  assert.match(block, /Beta \(`beta`\) · done · no lead running/);
  assert.doesNotMatch(block, /Gone|Squad hub/);
  const prompt = buildBrainstormInitialPrompt({ ...base, hubTeams: block });
  assert.match(prompt, /Teams in this Squad/);
  assert.match(prompt, /- dark mode\n- search/);
  for (const r of HUB_BOOT_RULES) assert.ok(prompt.includes(r));
});

test("unreadable daemon list says lead unknown", () => {
  assert.match(hubTeamsBlock({ team, agents: null }), /lead unknown/);
});

test("a Team Buddy's boot prompt is unchanged", () => {
  const plain = buildBrainstormInitialPrompt(base);
  assert.equal(plain, buildBrainstormInitialPrompt({ ...base, hubTeams: "" }));
  assert.doesNotMatch(plain, /RiffBot|Unsplit threads\` in the brief|Teams in this Squad/);
});

test("hub brief seed has Teams and Unsplit threads; a Team's seed does not", () => {
  const hub = newPinBrief("sq", "Sq", "idea", { hub: true });
  assert.match(hub, /## Teams\n[\s\S]*## Unsplit threads/);
  assert.doesNotMatch(newPinBrief("a", "A", "idea"), /## Teams|## Unsplit threads/);
});
