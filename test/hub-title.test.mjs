// PLAN_HUB_BUDDY block 6 (name part): the hub Buddy is titled RiffBot; Team Buddies are unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { formatDisplayTitle as tsTitle } from "../src/identity.ts";
import { formatDisplayTitle as mjsTitle } from "../server/identity.mjs";
import { breadcrumbOf } from "../src/pinFocusLogic.ts";
import { expectedV2TitleFor, lintTitle, titleFor } from "../src/teams.ts";

for (const [name, fmt] of [["identity.ts", tsTitle], ["identity.mjs", mjsTitle]]) {
  test(`formatDisplayTitle (${name}): hub Buddy is RiffBot, Team Brainstorm uses lane display name`, () => {
    const base = { role: "brainstorm", laneId: "alpha", laneName: "Alpha", code: "Alp" };
    assert.equal(fmt({ ...base, hub: true }), "RiffBot");
    assert.equal(fmt(base), "Alpha");
    assert.equal(fmt({ ...base, hub: true, topic: "naming" }), "Alpha · naming");
    assert.equal(fmt({ role: "lead", laneId: "alpha", code: "Alp", ord: "2", hub: true }), "Overlord");
  });
}

test("live vibesquad hub Buddy (bundled registry, id fallback) expects RiffBot; lint accepts it", () => {
  const bs = (title, extra = {}) => ({ id: "a1", title, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", ...extra } });
  assert.equal(expectedV2TitleFor(bs("whatever")), "RiffBot");
  assert.equal(lintTitle(bs("RiffBot")), null);
  assert.equal(titleFor("brainstorm", "VibeSquad", { laneId: "vibesquad" }), "RiffBot");
  assert.equal(lintTitle(bs("Hub Buddy · naming", { topic: "naming" })), null);
});

test("breadcrumb says RiffBot for the hub, BRAINSTORM · lane otherwise", () => {
  const c = { squadsHome: false, squadName: "S", laneName: "Alpha" };
  assert.equal(breadcrumbOf({ ...c, hub: true }).at(-1).label, "RiffBot");
  assert.equal(breadcrumbOf(c).at(-1).label, "BRAINSTORM · Alpha");
});
