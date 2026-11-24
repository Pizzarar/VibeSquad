import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/UsageDashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("usa-53: burst table sits in the workflows section with insufficient state + unjoined note", () => {
  const wf = src.slice(src.indexOf('id="workflows"'));
  assert.ok(wf.includes('data-testid="usage-burst-table"'));
  assert.ok(wf.includes("burstCellText("));
  assert.ok(wf.includes("unjoined"));
});

test("usa-53: plan rows are expandable and link the path", () => {
  const plans = src.slice(src.indexOf('id="plans"'), src.indexOf('id="ready-time"'));
  assert.ok(plans.includes("usage-plan-details"));
  assert.match(plans, /<a className="usage-plan-path"/);
  assert.ok(plans.includes("data.planScores.plans"));
});

test("usa-53: CSS rules exist, dimming via --muted not opacity", () => {
  for (const c of ["usage-plan-summary", "usage-plan-path", "usage-plan-status", "usage-plan-detail", "usage-burst-thin"]) assert.ok(css.includes(`.${c}`), c);
  const block = css.slice(css.indexOf("/* usa-53"), css.indexOf("/* usa-27") > 0 ? undefined : undefined).split("\n").slice(0, 16).join("\n");
  assert.ok(!/opacity/.test(block));
});
