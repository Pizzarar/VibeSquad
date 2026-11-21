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
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) => /:root:root :is\(\.btn\):disabled/.test(sel));
  assert.ok(rule, "quiet-surface rule for unscoped disabled controls is missing");
  for (const re of [/opacity:\s*1/, /background:\s*var\(--panel\)/, /color:\s*var\(--muted\)/, /border:\s*1px dashed var\(--u4-edge\)/, /border-image:\s*none/, /box-shadow:\s*none/, /text-shadow:\s*none/, /font-weight:\s*400/, /cursor:\s*default/]) {
    assert.match(rule[2], re);
  }
});

test("the quiet disabled surface exists once: scoped and unscoped selectors share one rule", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel, body]) => /:disabled/.test(sel) && /border:\s*1px dashed var\(--u4-edge\)/.test(body));
  assert.equal(rules.length, 1, "duplicate quiet-surface rules drift; keep one selector list");
  assert.match(rules[0][1], /\.sky-crt-body/);
  // idea-255: the usage buttons keep their Normal (boring.css) look, so their half of the list is scoped off Normal with a zero-specificity :where().
  assert.match(rules[0][1], /:root:root :is\(\.btn\):disabled/);
  assert.match(rules[0][1], /:root:root:where\(:not\(\[data-vibe="boring"\]\)\) :is\(\.usage-review-run, \.usage-inbox-btn\):disabled/);
});

test("no !important colour/fill rule on a .btn variant can beat the quiet disabled surface", () => {
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/(^|[\s,])(:root:root )?[^,]*(\.btn\b|\.usage-review-run|\.usage-inbox-btn)/.test(sel)) continue;
    if (!/(color|background|border-color):[^;]*!important/.test(body)) continue;
    if (/:disabled/.test(sel)) continue;
    bad.push(sel.trim());
  }
  assert.deepEqual(bad, []);
});
