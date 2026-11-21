// idea-480: Normal-mode Sandbox panel inside the agent ⋯ menu must anchor to the menu, not run off the right edge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const boring = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "..", "src", "styles.css"), "utf8");
const rule = (css, sel) => {
  const i = css.indexOf(sel + " {");
  assert.ok(i >= 0, `missing rule ${sel}`);
  return css.slice(i, css.indexOf("}", i));
};

test("Normal agent menu: sandbox wrapper is static so the panel anchors to the menu", () => {
  const r = rule(boring, 'html[data-vibe="boring"] .boring-agent-menu .drawer-sandbox');
  assert.match(r, /position:\s*static/);
});

test("Normal agent menu: sandbox panel fills the menu width, no fixed 300px, no !important", () => {
  const r = rule(boring, 'html[data-vibe="boring"] .boring-agent-menu .drawer-sandbox-panel');
  assert.match(r, /left:\s*4px/);
  assert.match(r, /right:\s*4px/);
  assert.match(r, /width:\s*auto/);
  assert.doesNotMatch(r, /!important/);
});

test("Psycho sandbox panel rule is unchanged (300px, unscoped)", () => {
  assert.match(rule(styles, ".drawer-sandbox-panel"), /width:\s*300px/);
});
