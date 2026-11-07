import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// N0: plain inline code (`.tl-icode` without `.tl-file-link`) must not share the link
// cyan; it renders muted. Real code-styled file links (`.tl-file-link.tl-icode`) keep
// cyan + pointer. Both must use theme variables, never hard-coded colours.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `Expected CSS rule for "${selector}"`);
  return m[1];
}

test("plain inline code (.tl-icode) is muted, not the link cyan", () => {
  const body = ruleBody(".tl-icode");
  assert.match(body, /color:\s*var\(--muted\)/, "plain .tl-icode must use var(--muted)");
  assert.doesNotMatch(body, /var\(--cyan/, "plain .tl-icode must not use the link cyan");
  assert.doesNotMatch(body, /color:\s*#[0-9a-fA-F]{3,8}/, "plain .tl-icode must use a theme variable, not a hard-coded colour");
  assert.match(body, /cursor:\s*text/, "plain .tl-icode must not use a pointer cursor");
});

test("code-styled file links keep cyan + pointer", () => {
  const body = ruleBody(".tl-file-link.tl-icode");
  assert.match(body, /color:\s*var\(--cyan-t\)/, "code file links must keep the cyan link colour");
  assert.match(body, /cursor:\s*pointer/, "code file links must keep the pointer cursor");
});

test("both dark and light themes declare --muted and --cyan-t as variables", () => {
  for (const theme of [":root", ':root[data-theme="light"]']) {
    const body = ruleBody(theme);
    assert.match(body, /--muted:\s*/, `${theme} must declare --muted`);
    assert.match(body, /--cyan-t:\s*/, `${theme} must declare --cyan-t`);
  }
});
