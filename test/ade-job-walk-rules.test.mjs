import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// WALK_DOC_PATH lets a caller point at a modified copy (used to prove the test bites).
const docPath = process.env.WALK_DOC_PATH || new URL("../docs/ADE_JOB_WALK.md", import.meta.url);
const doc = readFileSync(docPath, "utf8");
const lines = doc.split(/\r?\n/);
const has = (re) => assert.match(doc, re);

function row(n) {
  return lines.find((l) => l.startsWith(`| ${n} |`));
}

test("UX rows: control-present does not count as a pass", () => {
  // The scoring section must pair 'control-present' with a not-pass statement for UX rows.
  const near = lines.filter((l) => /control-present/i.test(l) && /(never count|does not count|not count|FAIL|no control-present)/i.test(l));
  assert.ok(near.length >= 1, "no line pairs control-present with a not-pass statement");
  has(/click count/i);
});

for (const n of [75, 76, 77, 78]) {
  test(`attention row ${n} exists and carries a pass bar`, () => {
    const r = row(n);
    assert.ok(r, `row ${n} missing`);
    const cells = r.split("|").map((c) => c.trim());
    // | # | Task | Steps | PASS criterion | Result | Maps to gap |
    assert.ok(cells.length >= 7, `row ${n} has too few cells`);
    const pass = cells[4];
    assert.match(pass, /≤\s*1 click|record(?:\s+the)?\s+(?:clicks?|click count)|record what/i, `row ${n} PASS criterion lacks a click/record bar`);
    assert.match(pass, /record/i, `row ${n} PASS criterion lacks a recorded result`);
  });
}

test("run matrix covers both resolutions in dark and light, all cells must pass", () => {
  has(/3200\s*[x×]\s*1800/);
  has(/1920\s*[x×]\s*1080/);
  has(/dark/i);
  has(/light/i);
  const matrix = lines.find((l) => /3200\s*[x×]\s*1800/.test(l) && /1920\s*[x×]\s*1080/.test(l));
  assert.ok(matrix, "matrix line missing");
  assert.match(matrix, /all\s+4\s+cells|every\s+cell|all\s+cells/i);
  assert.match(matrix, /pass/i);
});

test("fresh-eyes rule: walker does not read the plan first", () => {
  const l = lines.find((x) => /fresh[- ]eyes/i.test(x) && /plan/i.test(x));
  assert.ok(l, "no fresh-eyes line mentioning the plan");
  assert.match(l, /not|never/i);
});
