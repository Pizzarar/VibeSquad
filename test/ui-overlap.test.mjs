// V1a overlap + contrast guard (docs/PLAN_OVERLAP_AUDIT_V1.md): runs scripts/ui-overlap.mjs against the demo app.
//
// SKIPPED unless UI_OVERLAP=1: it fails until V1b (layout fixes) and @art U4b (colour/line art) land, so it must
// not block the normal `npm test`. Run it with `UI_OVERLAP=1 node --test test/ui-overlap.test.mjs`
// (or `npm run ui:overlap` for the report only). Default matrix = 4k@1.2 + 1080, dark + light (~3 min);
// UI_OVERLAP_FULL=1 adds 1280x800 + 390x844 (~7 min). Report: scratch/ui-overlap/report.{json,md}, shots: scratch/shots/v1a-*.
import { test } from "node:test";
import assert from "node:assert/strict";

const on = process.env.UI_OVERLAP === "1";

test("ui overlap guard: no overlap / overflow / clipping / line-through-text / low-contrast hits", { skip: on ? false : "set UI_OVERLAP=1 (fails until V1b + @art U4b land)", timeout: 900000 }, async () => {
  const { run } = await import("../scripts/ui-overlap.mjs");
  const report = await run({ sizes: process.env.UI_OVERLAP_FULL === "1" ? "4k,1080,800,mobile" : "4k,1080" });
  const lines = report.hits.filter((h) => !h.allowed).slice(0, 15).map((h) => `#${h.id} ${h.kind} [${h.split}] ${h.selector} (${h.surface} ${h.size} ${h.theme}): ${h.detail}`);
  assert.equal(report.totals.hits, 0, `${report.totals.hits} overlap hits (see scratch/ui-overlap/report.md). First:\n${lines.join("\n")}`);
});
