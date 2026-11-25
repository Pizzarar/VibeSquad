import assert from "node:assert/strict";
import test from "node:test";
import { etClock, etDate, etDateTime } from "../src/etTime.ts";
import { formatTimestamp } from "../src/prefs.ts";

test("etClock renders US Eastern with zone, EST and EDT", () => {
  assert.equal(etClock("2026-11-25T13:00:00Z"), "8:00 AM ET"); // EST
  assert.equal(etClock("2026-07-01T12:00:00Z"), "8:00 AM ET"); // EDT
  assert.equal(etClock("2026-11-25T03:30:00Z"), "10:30 PM ET"); // previous ET day
});
test("etDate / etDateTime follow the ET calendar day", () => {
  assert.equal(etDate("2026-11-25T03:30:00Z"), "2026-11-24");
  assert.equal(etDateTime("2026-11-25T13:00:00Z"), "2026-11-25 8:00 AM ET");
});
test("invalid input yields empty string", () => {
  assert.equal(etClock("nope"), "");
  assert.equal(etClock(null), "");
  assert.equal(etDateTime(undefined), "");
});
test("formatTimestamp absolute is ET-labelled", () => {
  const now = Date.parse("2026-11-25T15:00:00Z");
  assert.equal(formatTimestamp("2026-11-25T13:00:00Z", "absolute", now), "8:00 AM ET");
  assert.equal(formatTimestamp("2026-11-24T13:00:00Z", "absolute", now), "2026-11-24 8:00 AM ET");
});
test("owner-facing dates in src use etTime, not toLocale*String (idea-734)", async () => {
  const { readFileSync } = await import("node:fs");
  const ud = readFileSync(new URL("../src/UsageDashboard.tsx", import.meta.url), "utf8");
  assert.match(ud, /import \{[^}]*etDateTime[^}]*\} from "\.\/etTime"/);
  assert.doesNotMatch(ud, /new Date\([^)]*\)\.toLocale(Time|Date)?String/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /psycho-focus-normal-btn[\s\S]{0,200}left: 8, bottom: 8/);
});
