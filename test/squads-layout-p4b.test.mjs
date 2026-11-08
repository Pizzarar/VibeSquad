import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const css = read("styles.css");
const rule = (sel) => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `missing rule ${sel}`);
  return css.slice(i, css.indexOf("}", i));
};

test("P4b squads page is one flex column on the section-gap token with a shared max-width", () => {
  const home = rule(".squads-home");
  assert.match(home, /flex-direction: column/);
  assert.match(home, /gap: var\(--sp-5\)/);
  assert.match(home, /max-width: var\(--squads-max\)/);
  assert.match(home, /margin-inline: auto/);
  assert.doesNotMatch(rule(".squads-dashboard"), /margin-top/);
});

test("P4b card grids use the token gap and a responsive min that cannot overflow", () => {
  for (const sel of [".squads-home-grid", ".pin-grid"]) {
    const r = rule(sel);
    assert.match(r, /gap: var\(--sp-3\)/, sel);
    assert.match(r, /minmax\(min\(100%, /, sel);
    assert.doesNotMatch(r, /minmax\(\d+px/, sel);
  }
  assert.ok(css.includes("@media (max-width: 520px) { .squads-home-grid, .pin-grid { grid-template-columns: 1fr; } }"));
});

test("P4b pager uses no fixed px width and the section header is rendered", () => {
  assert.doesNotMatch(rule(".squads-pager-pos"), /min-width: \d+px/);
  const tsx = read("PinGrid.tsx");
  assert.match(tsx, /className=\{`squads-section squads-home-pager-wrap/);
  assert.match(tsx, /className="squads-section-title"/);
  assert.match(rule(".squads-section-title"), /font-size: 12px/);
});
