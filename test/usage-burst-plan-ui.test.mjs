import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/UsageDashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const between = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  assert.ok(i >= 0, `missing marker ${a}`);
  assert.ok(j > i, `missing marker ${b}`);
  return src.slice(i, j);
};

test("usa-53: burst table renders in workflows section and when no savings/workflows exist", () => {
  const wf = src.slice(src.indexOf('id="workflows"'));
  assert.ok(src.indexOf('id="workflows"') >= 0);
  assert.ok(wf.includes('data-testid="usage-burst-table"'));
  assert.ok(wf.includes("burstCellText("));
  assert.ok(wf.includes("unjoined"));
  assert.match(src, /data\.savings \|\| workflows\.length > 0 \|\| data\.burstCohorts/);
});

test("usa-53: plan rows are details with shared grid; path link lives in the expanded dl, not the summary", () => {
  const plans = between('id="plans"', 'id="ready-time"');
  assert.ok(plans.includes("usage-plan-head"));
  const summary = between('<summary className="usage-plan-grid', "</summary>");
  assert.ok(!summary.includes("<a "));
  const dl = between('<dl className="usage-plan-detail', "</dl>");
  assert.match(dl, /<a className="usage-plan-path"/);
});

test("usa-53: CSS rules exist; no opacity; detail dd resets nowrap", () => {
  for (const c of ["usage-plan-grid", "usage-plan-summary", "usage-plan-path", "usage-plan-status", "usage-plan-detail", "usage-burst-thin"]) assert.ok(css.includes(`.${c}`), c);
  const start = css.indexOf(".usage-plan-rows {");
  assert.ok(start >= 0);
  const end = css.indexOf(".usage-burst-thin", start);
  assert.ok(end > start);
  const block = css.slice(start, end);
  assert.ok(!/opacity/.test(block));
  assert.match(block, /\.usage-plan-detail dd \{[^}]*white-space: normal/);
});

test("usa-62: phone <=600px stacks burst split cells with data-label, wraps Model x Stakes labels, and adds right-edge scroll hint", () => {
  assert.match(src, /data-label=\{c\.label\}/);
  const start = css.indexOf("/* usa-62:");
  assert.ok(start > 0, "usa-62 CSS block present");
  const block = css.slice(start);
  assert.match(block, /@media \(max-width: 600px\)/);
  assert.match(block, /\[data-testid="usage-burst-split-table"\] td\[data-label\]::before/);
  assert.match(block, /\[data-testid="usage-workflow-table"\] td:first-child \{[^}]*overflow-wrap: anywhere/);
  assert.match(block, /\.usage-table-wrap \{[^}]*linear-gradient\(to left,/);
});
