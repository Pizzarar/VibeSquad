import assert from "node:assert/strict";
import test from "node:test";
import { BRAINSTORM_PACK, CRUNCH_MODE_RULES, VIBE_MODE_BUDDY_RULES, injectedPrefix, rolePack } from "../server/hooks/agent-duties.ts";
import { VIBE_HEARTBEAT_LINE, buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";

test("Buddy pack is byte-identical with Crunch mode off and gains only the rule block when on", () => {
  assert.equal(rolePack("brainstorm", ""), BRAINSTORM_PACK);
  assert.equal(rolePack("brainstorm", "", false), BRAINSTORM_PACK);
  const on = rolePack("brainstorm", "", true);
  assert.equal(on, `${BRAINSTORM_PACK}\n${CRUNCH_MODE_RULES}`);
  assert.equal(VIBE_MODE_BUDDY_RULES, CRUNCH_MODE_RULES);
  assert.match(on, /Crunch mode is ON/);
  assert.match(on, /\(auto\)/);
  assert.match(on, /ONE needs-you digest/);
  assert.match(on, /UX Review and merge gates/);
  console.log(`crunch pack char delta: +${on.length - BRAINSTORM_PACK.length}`);
});

test("Crunch mode touches Buddy and Lead packs but never the worker pack", () => {
  assert.equal(rolePack("worker", "", true), rolePack("worker", "", false));
  assert.doesNotMatch(rolePack("worker", "", true), /Crunch mode is ON/);
  assert.equal(rolePack("lead", "", false), rolePack("lead", ""));
  const on = rolePack("lead", "", true);
  assert.equal(on, `${rolePack("lead", "", false)}\n${CRUNCH_MODE_RULES}`);
  assert.match(on, /Crunch mode is ON/);
  assert.equal(injectedPrefix("brainstorm", "", false), injectedPrefix("brainstorm", ""));
});

test("restart boot prompt carries the heartbeat line only when Vibe mode is on", () => {
  const args = { laneId: "x", laneUpper: "X", buddyName: "X Buddy", summaryContent: "brief", latestPlan: "none" };
  const off = buildBrainstormInitialPrompt(args);
  const on = buildBrainstormInitialPrompt({ ...args, vibeMode: true });
  assert.ok(!off.includes("create_heartbeat"));
  assert.ok(on.includes(VIBE_HEARTBEAT_LINE));
  assert.equal(on.replace(`${VIBE_HEARTBEAT_LINE}\n`, ""), off);
});
