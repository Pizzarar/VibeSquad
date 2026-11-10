import assert from "node:assert/strict";
import test from "node:test";
import { freezeLaneCodes, laneCodesForTeam } from "../server/identity.mjs";
import { freezeLaneCodes as tsFreeze } from "../src/identity.ts";
import { expectedTitleFor, expectedV2TitleFor, legacyTitleFor, lintTitle, titleFor } from "../src/teams.ts";

const agent = (title, labels, extra = {}) => ({ id: "a1", title, status: "idle", labels, ...extra });

test("title lint: expectedTitleFor and lintTitle always return null; expectedV2TitleFor and legacyTitleFor still compute", () => {
  const lead = (title) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "5" });
  assert.equal(lintTitle(lead("★ VIBESQUAD ord5")), null);
  assert.equal(expectedV2TitleFor(lead("★ VIBESQUAD ord5")), "Overlord");
  assert.equal(legacyTitleFor(lead("x")), "★ VIBESQUAD ord5");
  assert.equal(lintTitle(lead("★ Hub5")), null);
  assert.equal(lintTitle(lead("Some random title")), null);
  assert.equal(lintTitle(lead("★ VIBESQUAD ord4")), null);

  const bs = (title, topic) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "brainstorm", ...(topic ? { topic } : {}) });
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD")), null);
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD · naming", "naming")), null);
  assert.equal(lintTitle(bs("BRAINSTORM · VIBESQUAD · wrong", "naming")), null);
  assert.equal(lintTitle(bs("whatever")), null);

  const worker = (title) => agent(title, { team: "vibesquad", lane: "vibesquad", role: "worker", job: "drop files" });
  assert.equal(lintTitle(worker("VIBESQUAD · drop files")), null);
  assert.equal(lintTitle(worker("nope")), null);
  assert.equal(expectedTitleFor(worker("VIBESQUAD · drop files")), null);
  assert.equal(expectedTitleFor(worker("nope")), null);
  assert.equal(expectedV2TitleFor(worker("VIBESQUAD · drop files")), "Hub · drop files");
});

test("titleFor defaults the code from the lane (hub lane is Hub, not Vib)", () => {
  assert.equal(titleFor("brainstorm", "VibeSquad", {}), "RiffBot");
  assert.equal(titleFor("lead", "VibeSquad", { ord: "1" }), "Overlord");
  assert.equal(titleFor("lead", "VibeSquad", { ord: "2", laneId: "vibesquad" }), "Overlord");
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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyTitle, buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";
import { buildSuccessorPrompt, leadTitles } from "../server/lead-handoff.mjs";

function sandboxRoot() {
  const root = mkdtempSync(join(tmpdir(), "vs-lane-codes-"));
  writeFileSync(
    join(root, "teams.json"),
    JSON.stringify({
      teams: [
        { id: "vibesquad", name: "VibeSquad", paths: [], lanes: [{ id: "vibesquad", name: "VibeSquad" }, { id: "bug-chaser", name: "Bug Chaser" }] },
      ],
    }),
  );
  return root;
}

test("spawn paths: lead handoff and Buddy titles use the lane code (sandbox registry)", () => {
  const root = sandboxRoot();
  try {
    const prev = process.env.VIBESQUAD_HOME;
    process.env.VIBESQUAD_HOME = root;
    try {
      const t = leadTitles({ laneId: "vibesquad", laneName: "VibeSquad", nextOrd: 2, oldOrd: 1, oldLead: { labels: { job: "squad view" } }, rootDir: root });
      assert.equal(t.newTitle, "★ Hub2");
      assert.equal(t.oldTitle, "(old) Hub1 · squad view");
      const noJob = leadTitles({ laneId: "bug-chaser", laneName: "Bug Chaser", nextOrd: 5, oldOrd: 4, oldLead: { labels: {} }, rootDir: root });
      assert.deepEqual(noJob, { newTitle: "★ Bug5", oldTitle: "(old) Bug4" });
      assert.equal(buddyTitle("bug-chaser", "Bug Chaser", "", root), "Bug Chaser");
      assert.equal(buddyTitle("bug-chaser", "Bug Chaser", "flaky tests", root), "Bug Chaser · flaky tests");
    } finally {
      if (prev === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prev;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn paths: prompts name the new agent by its title", () => {
  const p = buildSuccessorPrompt({
    laneId: "vibesquad", laneName: "VibeSquad", nextOrd: 2, newTitle: "★ Hub2", oldLead: { id: "x", title: "★ Hub1" },
    oldTitle: "(old) Hub1", trigger: "self", packetPath: "p", packetContent: "c", summaryPath: "s", summaryContent: "", latestPlan: null,
  });
  assert.match(p, /You are ★ Hub2, the successor lead/);
  assert.match(p, /retired to "\(old\) Hub1"/);
  const b = buildBrainstormInitialPrompt({ laneId: "vibesquad", laneUpper: "VIBESQUAD", buddyName: "Hub Buddy", summaryContent: "", latestPlan: null });
  assert.match(b, /You are Hub Buddy \(fresh start/);
});
