import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unitFirstTry, buildQualitySummary, buildQualityByModel } from "../src/usageHelpers.ts";

const src = readFileSync(new URL("../src/UsageDashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("usa-64: unitFirstTry matches server rules (reviewSource none -> null, verdict wins, legacy rounds fallback)", () => {
  assert.equal(unitFirstTry(null), null);
  assert.equal(unitFirstTry({ reviewSource: "none", firstReviewVerdict: "PASS", reviewRounds: 1 }), null);
  assert.equal(unitFirstTry({ reviewSource: "verdict-log", firstReviewVerdict: "PASS", reviewRounds: 3 }), true);
  assert.equal(unitFirstTry({ reviewSource: "both", firstReviewVerdict: "FAIL", reviewRounds: 1 }), false);
  assert.equal(unitFirstTry({ reviewSource: "subject", firstReviewVerdict: null, reviewRounds: 1 }), true);
  assert.equal(unitFirstTry({ reviewSource: "subject", firstReviewVerdict: null, reviewRounds: 2 }), false);
  assert.equal(unitFirstTry({ reviewRounds: 0 }), true);
});

test("usa-64: buildQualitySummary computes overall 1st-try PASS % and fix-after-merge % over known review outcomes only", () => {
  const empty = buildQualitySummary([]);
  assert.equal(empty.totalUnits, 0);
  assert.equal(empty.knownReviewUnits, 0);
  assert.equal(empty.firstTryPassRate, null);
  assert.equal(empty.fixAfterMergeRate, null);

  const s = buildQualitySummary([
    { reviewSource: "verdict-log", firstReviewVerdict: "PASS", fixAfterMerge: false },
    { reviewSource: "verdict-log", firstReviewVerdict: "PASS", fixAfterMerge: true },
    { reviewSource: "both", firstReviewVerdict: "FAIL", fixAfterMerge: false },
    { reviewSource: "subject", firstReviewVerdict: null, reviewRounds: 1, fixAfterMerge: false },
    // Unknown review outcome must be excluded from both rates
    { reviewSource: "none", firstReviewVerdict: null, reviewRounds: 0, fixAfterMerge: true },
    { reviewSource: "none", firstReviewVerdict: null, reviewRounds: 0, fixAfterMerge: true },
  ]);
  assert.equal(s.totalUnits, 6);
  assert.equal(s.knownReviewUnits, 4);
  assert.equal(s.unknownReviewUnits, 2);
  assert.equal(s.firstTryPassCount, 3);
  assert.equal(s.firstTryPassRate, 0.75);
  assert.equal(s.fixAfterMergeCount, 1);
  assert.equal(s.fixAfterMergeRate, 0.25);
});

test("usa-64: buildQualityByModel aggregates per model, excludes reviewSource=none from PASS% and implementerShared from $/unit, sorts by PASS desc then $/unit asc", () => {
  const rows = buildQualityByModel([
    // Unattributed unit is skipped
    { implementerModel: null, implementerProfile: null, reviewSource: "verdict-log", firstReviewVerdict: "PASS", costUsd: 5 },
    // Model A: 2 units, 1 known PASS (100%), 1 reviewSource=none; 1 shared credit excluded from $/unit -> $2.00/unit
    { implementerModel: "model-a", reviewSource: "verdict-log", firstReviewVerdict: "PASS", fixRounds: 0, fixAfterMerge: false, implementerShared: false, costUsd: 2.0 },
    { implementerModel: "model-a", reviewSource: "none", firstReviewVerdict: null, fixRounds: 1, fixAfterMerge: false, implementerShared: true, costUsd: 99.0 },
    // Model B: 2 units, both known PASS (100%), $1.00/unit -> ties PASS% with Model A, wins $/unit tiebreak!
    { implementerModel: "model-b", reviewSource: "verdict-log", firstReviewVerdict: "PASS", fixRounds: 0, fixAfterMerge: false, implementerShared: false, costUsd: 1.0 },
    { implementerModel: "model-b", reviewSource: "both", firstReviewVerdict: "PASS", fixRounds: 0, fixAfterMerge: true, implementerShared: false, costUsd: 1.0 },
    // Model C: 2 units, 1 PASS 1 FAIL (50%), $0.50/unit -> cheaper, but lower PASS% so ranks below A & B
    { implementerModel: "model-c", reviewSource: "verdict-log", firstReviewVerdict: "PASS", fixRounds: 0, fixAfterMerge: false, implementerShared: false, costUsd: 0.5 },
    { implementerModel: "model-c", reviewSource: "verdict-log", firstReviewVerdict: "FAIL", fixRounds: 2, fixAfterMerge: false, implementerShared: false, costUsd: 0.5 },
    // Model D: only reviewSource=none -> PASS% is null, sorted last; falls back to implementerProfile when implementerModel is null
    { implementerModel: null, implementerProfile: "Legacy Profile", reviewSource: "none", firstReviewVerdict: null, fixRounds: 0, fixAfterMerge: false, implementerShared: true, costUsd: null },
  ]);

  assert.deepEqual(rows.map((r) => r.model), ["model-b", "model-a", "model-c", "Legacy Profile"]);

  const b = rows[0];
  assert.equal(b.units, 2);
  assert.equal(b.firstTryKnown, 2);
  assert.equal(b.firstTryPassRate, 1);
  assert.equal(b.fixRoundsPerUnit, 0);
  assert.equal(b.fixAfterMergeRate, 0.5);
  assert.equal(b.costPerUnit, 1.0);

  const a = rows[1];
  assert.equal(a.units, 2);
  assert.equal(a.firstTryKnown, 1);
  assert.equal(a.firstTryPassRate, 1);
  assert.equal(a.fixRoundsPerUnit, 0.5);
  assert.equal(a.costUnits, 1);
  assert.equal(a.costPerUnit, 2.0);

  const c = rows[2];
  assert.equal(c.firstTryKnown, 2);
  assert.equal(c.firstTryPassRate, 0.5);
  assert.equal(c.fixRoundsPerUnit, 1);
  assert.equal(c.costPerUnit, 0.5);

  const d = rows[3];
  assert.equal(d.firstTryKnown, 0);
  assert.equal(d.firstTryPassRate, null);
  assert.equal(d.costPerUnit, null);
});

test("usa-64: UI places usage-saving-quality next to usage-saving-routing and renders usage-quality-by-model with 390px data-label stacking", () => {
  const wf = src.slice(src.indexOf('id="workflows"'));
  const routingIdx = wf.indexOf('data-testid="usage-saving-routing"');
  const qualityIdx = wf.indexOf('data-testid="usage-saving-quality"');
  const contextIdx = wf.indexOf('data-testid="usage-saving-context"');
  assert.ok(routingIdx >= 0 && qualityIdx > routingIdx && qualityIdx < contextIdx, "quality card sits right next to routing savings card");

  const tblIdx = wf.indexOf('data-testid="usage-quality-by-model"');
  assert.ok(tblIdx > qualityIdx, "per-model quality table renders in workflows section");
  const tbl = wf.slice(tblIdx, wf.indexOf("</table>", tblIdx));
  for (const label of ["Units", "1st-try PASS %", "Fix rounds/unit", "Fix-after-merge %", "$/unit"]) {
    assert.ok(tbl.includes(`data-label="${label}"`), `missing data-label="${label}"`);
  }

  const start = css.indexOf("/* usa-62:");
  assert.ok(start > 0);
  const block = css.slice(start);
  assert.match(block, /\[data-testid="usage-quality-by-model"\] td\[data-label\]::before/);
});
