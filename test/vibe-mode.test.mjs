import assert from "node:assert/strict";
import test from "node:test";
import { BRAINSTORM_PACK, VIBE_MODE_BUDDY_RULES, injectedPrefix, rolePack } from "../server/hooks/agent-duties.ts";
import { VIBE_HEARTBEAT_LINE, buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";

test("Buddy pack is byte-identical with Vibe mode off and gains only the rule block when on", () => {
  assert.equal(rolePack("brainstorm", ""), BRAINSTORM_PACK);
  assert.equal(rolePack("brainstorm", "", false), BRAINSTORM_PACK);
  const on = rolePack("brainstorm", "", true);
  assert.equal(on, `${BRAINSTORM_PACK}\n${VIBE_MODE_BUDDY_RULES}`);
  assert.match(on, /\(auto\)/);
  assert.match(on, /ONE needs-you digest/);
  console.log(`vibe pack char delta: +${on.length - BRAINSTORM_PACK.length}`);
});

test("Vibe mode never touches worker or lead packs", () => {
  assert.equal(rolePack("worker", "", true), rolePack("worker", "", false));
  assert.equal(rolePack("lead", "", true), rolePack("lead", "", false));
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
