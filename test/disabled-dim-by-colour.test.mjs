import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Disabled controls dim by colour (--muted), never opacity (idea-165, Art13).
// Every rule whose selector targets :disabled / [disabled] / [aria-disabled] must not set opacity < 1.
// EXEMPT: deliberate state dims kept on purpose (not generic disabled-control styling).
const EXEMPT = [
  ".squads-pager-btn[aria-disabled", // pager end-stop: state dim, kept (idea-165 plan)
];

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("no :disabled / [disabled] / [aria-disabled] control rule sets opacity < 1", () => {
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const op = /(?:^|[;\s])opacity:\s*([\d.]+)/.exec(m[2]);
    if (!op || Number(op[1]) >= 1) continue;
    // selectors that merely exclude disabled controls (:not(:disabled)) are not disabled rules
    const positive = sel.split(",").some((s) => /(:disabled|\[disabled|\[aria-disabled)/.test(s.replace(/:not\([^)]*\)/g, "")));
    if (!positive || EXEMPT.some((e) => sel.includes(e))) continue;
    bad.push(`${sel} { opacity: ${op[1]} }`);
  }
  assert.deepEqual(bad, []);
});

test("disabled .btn / .usage-review-run / .usage-inbox-btn pick up the quiet surface (panel bg, dashed edge, no fill/shadow)", () => {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) => /:root:root :is\(\.btn, \.usage-review-run, \.usage-inbox-btn\):disabled/.test(sel));
  assert.ok(rule, "quiet-surface rule for unscoped disabled controls is missing");
  for (const re of [/opacity:\s*1/, /background:\s*var\(--panel\)/, /color:\s*var\(--muted\)/, /border:\s*1px dashed var\(--u4-edge\)/, /border-image:\s*none/, /box-shadow:\s*none/, /text-shadow:\s*none/, /font-weight:\s*400/]) {
    assert.match(rule[2], re);
  }
});
