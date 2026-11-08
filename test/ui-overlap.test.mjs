// V1a overlap + contrast guard (docs/PLAN_OVERLAP_AUDIT_V1.md): runs scripts/ui-overlap.mjs against the demo app.
//
// SKIPPED unless UI_OVERLAP=1: it fails until V1b (layout fixes) and @art U4b (colour/line art) land, so it must
// not block the normal `npm test`. Run it with `UI_OVERLAP=1 node --test test/ui-overlap.test.mjs`
// (or `npm run ui:overlap` for the report only). Matrix = all four sizes (4k@1.2, 1080, 1280x800, 390x844), dark + light
// (~6 min); UI_OVERLAP_SIZES=4k,1080 narrows it for quick local runs. Report: scratch/ui-overlap/report.{json,md}, shots: scratch/shots/v1a-*.
//
// decor-suspect (pixel background step through text) is warn-only, EXCEPT when it matches one of the owner-reported
// known hits: those always fail. The known-hit assertions below fail on ANY hit of any kind, allow-listed or not, so
// V1b has to fix them rather than allow-list them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const on = process.env.UI_OVERLAP === "1";
const skip = on ? false : "set UI_OVERLAP=1 (fails until V1b + @art U4b land)";
const opts = { timeout: 1200000, skip };

let reportPromise = null;
async function getReport() {
  reportPromise ??= import("../scripts/ui-overlap.mjs").then(({ run }) => run({ sizes: process.env.UI_OVERLAP_SIZES || "4k,1080,800,mobile" }));
  return reportPromise;
}
const describeHits = (hits) => hits.slice(0, 12).map((h) => `#${h.id} ${h.kind} [${h.split}] ${h.selector} (${h.occurrences.map((o) => `${o.surface}@${o.size}/${o.theme}`).slice(0, 3).join(", ")}): ${h.detail}`).join("\n");

test("ui overlap guard: no failing overlap / overflow / clipping / line-through-text / low-contrast hits", opts, async () => {
  const r = await getReport();
  const failing = r.hits.filter((h) => !h.allowed && !h.warn);
  assert.equal(failing.length, 0, `${failing.length} unique failing hits (see scratch/ui-overlap/report.md). First:\n${describeHits(failing)}`);
});

test("no owner-reported known hit reproduces (any kind, allow-list ignored)", opts, async () => {
  const r = await getReport();
  const bad = r.known.filter((k) => k.hitIds.length > 0);
  assert.equal(bad.length, 0, `known hits still reproducing: ${bad.map((k) => `${k.id} [${k.sizes.join(",")}]`).join("; ")}`);
});

test("composer MEDIUM chip (drawer-config-menu-btn) is clean on the composer surface, allow-list free", opts, async () => {
  const r = await getReport();
  const bad = r.hits.filter((h) => h.known.includes("r3-medium-auto-chip-line"));
  assert.equal(bad.length, 0, `composer chip hits (allow-list and warn status ignored):\n${describeHits(bad)}`);
  assert.ok(r.known.find((k) => k.id === "r3-medium-auto-chip-line"), "known-hit registry must keep the composer chip case");
});

test("settings header is clean, allow-list free", opts, async () => {
  const r = await getReport();
  const bad = r.hits.filter((h) => h.known.includes("r3-settings-header"));
  assert.equal(bad.length, 0, `settings header hits (allow-list and warn status ignored):\n${describeHits(bad)}`);
});

// Cheap and always meaningful when enabled: the allow-list may not mention these surfaces at all.
test("allow-list has no entries for the composer chip, chip row or settings header", { skip }, () => {
  const allow = JSON.parse(fs.readFileSync(new URL("../scripts/ui-overlap/allowlist.json", import.meta.url), "utf8")).allow;
  const forbidden = /drawer-config|config-summary|composer|subagent|settings|modal-head/i;
  const bad = allow.filter((a) => forbidden.test(`${a.selector ?? ""} ${a.other ?? ""} ${a.text ?? ""} ${a.surface ?? ""}`));
  assert.deepEqual(bad, [], "these hits must be fixed, not allow-listed");
});
