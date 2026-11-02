// PLAN_HUB_BUDDY block 2: hub rules live in HUB_BUDDY_RULES and reach only the hub Buddy.
import assert from "node:assert/strict";
import test from "node:test";
import { BRAINSTORM_PACK, HUB_BUDDY_RULES, VIBE_MODE_BUDDY_RULES, injectedPrefix, isHubCwd, rolePack } from "../plugin/index.server.ts";
import { buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";

test("topic Buddy pack has no hub rules; hub Buddy pack appends them", () => {
  assert.doesNotMatch(BRAINSTORM_PACK, /hub chat|vs:spin-off|Open threads/);
  assert.equal(rolePack("brainstorm", ""), BRAINSTORM_PACK);
  assert.equal(rolePack("brainstorm", "", false, false), BRAINSTORM_PACK);
  const hub = rolePack("brainstorm", "", false, true);
  assert.equal(hub, `${BRAINSTORM_PACK}\n${HUB_BUDDY_RULES}`);
  assert.match(hub, /Open threads:/);
  assert.match(hub, /```vs:spin-off/);
  assert.match(injectedPrefix("brainstorm", "", false, true), /Open threads:/);
  assert.doesNotMatch(injectedPrefix("brainstorm", "", false, false), /Open threads:/);
  console.log(`hub pack char delta: +${hub.length - BRAINSTORM_PACK.length}`);
});

test("hub rules come after vibe rules; other roles ignore isHub", () => {
  assert.equal(rolePack("brainstorm", "", true, true), `${BRAINSTORM_PACK}\n${VIBE_MODE_BUDDY_RULES}\n${HUB_BUDDY_RULES}`);
  assert.equal(rolePack("worker", "", false, true), rolePack("worker", ""));
  assert.equal(rolePack("lead", "", false, true), rolePack("lead", ""));
});

test("isHubCwd matches isHubLane: explicit flag, id fallback, no fallback when another lane is flagged", () => {
  const plain = { id: "sq", lanes: [{ id: "sq" }, { id: "a" }] };
  assert.equal(isHubCwd(plain, "sq"), true);
  assert.equal(isHubCwd(plain, "a"), false);
  const flagged = { id: "sq", lanes: [{ id: "sq" }, { id: "a", hub: true }] };
  assert.equal(isHubCwd(flagged, "a"), true);
  assert.equal(isHubCwd(flagged, "sq"), false);
  assert.equal(isHubCwd(undefined, "sq"), false);
  assert.equal(isHubCwd(plain, "nope"), false);
});

test("boot prompt omits vs:looks-done for the hub only", () => {
  const args = { laneId: "sq", laneUpper: "SQ", buddyName: "SQ Buddy", summaryContent: "brief", latestPlan: "none" };
  assert.match(buildBrainstormInitialPrompt(args), /vs:looks-done/);
  const hub = buildBrainstormInitialPrompt({ ...args, hubTeams: "Teams in this Squad:\n- (none)" });
  assert.doesNotMatch(hub, /vs:looks-done|looks done/);
  assert.match(hub, /Never mark the hub done/);
});
