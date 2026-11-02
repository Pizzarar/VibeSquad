import assert from "node:assert/strict";
import test from "node:test";
import { freezeLaneCodes, laneCodesForTeam } from "../server/identity.mjs";
import { freezeLaneCodes as tsFreeze } from "../src/identity.ts";
import { expectedTitleFor, expectedV2TitleFor, legacyTitleFor, lintTitle, titleFor } from "../src/teams.ts";

const agent = (title, labels, extra = {}) => ({ id: "a1", title, status: "idle", labels, ...extra });

test("title lint: v1-titled live agents are not flagged; wrong titles still are", () => {
  const lead = (title) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "5" });
  assert.equal(lintTitle(lead("★ VIBESQUAD ord5")), null);
  assert.equal(expectedV2TitleFor(lead("★ VIBESQUAD ord5")), "★ Hub5");
  assert.equal(legacyTitleFor(lead("x")), "★ VIBESQUAD ord5");
  assert.equal(lintTitle(lead("★ Hub5")), null);
  assert.equal(lintTitle(lead("Some random title")), "★ Hub5");
  assert.equal(lintTitle(lead("★ VIBESQUAD ord4")), "★ Hub5");

  const bs = (title, topic) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "brainstorm", ...(topic ? { topic } : {}) });
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD")), null);
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD · naming", "naming")), null);
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD · wrong", "naming")), "Hub Buddy · naming");
  assert.equal(lintTitle(bs("whatever")), "Hub Buddy");

  const worker = (title) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "worker", job: "drop files" });
  assert.equal(lintTitle(worker("VIBESQUAD · drop files")), null);
  assert.equal(lintTitle(worker("nope")), "Hub · drop files");
  // Block 4 path: the v2 title is still available for a v1-titled agent.
  assert.equal(expectedTitleFor(worker("VIBESQUAD · drop files")), null);
  assert.equal(expectedV2TitleFor(worker("VIBESQUAD · drop files")), "Hub · drop files");
});

test("titleFor defaults the code from the lane (hub lane is Hub, not Vib)", () => {
  assert.equal(titleFor("brainstorm", "VibeSquad", {}), "Hub Buddy");
  assert.equal(titleFor("lead", "VibeSquad", { ord: "1" }), "★ Hub1");
  assert.equal(titleFor("lead", "VibeSquad", { ord: "2", laneId: "vibesquad" }), "★ Hub2");
  assert.equal(titleFor("worker", "VibeSquad", { ord: "2", job: "x" }), "Hub2 · x");
});

test("freeze: persisting codes makes later colliding stored codes unable to displace existing lanes", () => {
  for (const freeze of [freezeLaneCodes, tsFreeze]) {
    const lanes = [
      { id: "a-lane", name: "Alpha" },
      { id: "c-lane", name: "Charlie" },
    ];
    const frozen = freeze(lanes);
    assert.deepEqual(frozen.map((l) => l.code), ["Alp", "Cha"]);
    // A new lane arrives with a colliding stored code: the existing lane keeps Alp, the newcomer is deduped.
    const after = laneCodesForTeam({ lanes: [...frozen, { id: "b-lane", name: "Bravo", code: "Alp" }] });
    assert.equal(after["a-lane"], "Alp");
    assert.equal(after["c-lane"], "Cha");
    assert.notEqual(after["b-lane"].toLowerCase(), "alp");
    // Freezing again is a no-op.
    assert.deepEqual(freeze(frozen), frozen);
  }
});
