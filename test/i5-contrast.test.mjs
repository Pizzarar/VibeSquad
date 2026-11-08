// Block I5 (docs/PLAN_INBOX_SWEEP_1108.md, idea-26 + idea-27): @art V1b contrast leftovers.
// (a) .drawer-labels-list .chip clears the U3 9-slice border-image-source (--u3-chip-teal) so the tinted P0 panel fill shows (>= 4.5:1).
// (b) .sky-static moves the repeating-linear-gradient scanlines onto ::before (pointer-events: none, behind content) so text sits on the solid base.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function rules(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ sel: m[1].trim(), body: m[2], at: m.index });
  return out;
}

const allRules = rules(css);

function themeTokens(block) {
  const t = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].replace(/\/\*.*?\*\//g, "").trim();
  return t;
}
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="light"] {'));
const lightBlock = css.slice(css.indexOf(':root[data-theme="light"] {'), css.indexOf("* {\n  box-sizing"));
const dark = themeTokens(rootBlock);
const light = { ...dark, ...themeTokens(lightBlock) };

function color(tokens, v, depth = 0) {
  v = v.trim();
  if (depth > 8) throw new Error("loop " + v);
  let m;
  if ((m = /^var\((--[\w-]+)\)$/.exec(v))) return color(tokens, tokens[m[1]], depth + 1);
  if ((m = /^#([0-9a-f]{6})$/i.exec(v))) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  if ((m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v))) {
    const a = color(tokens, m[1], depth + 1);
    const b = color(tokens, m[3], depth + 1);
    const p = +m[2] / 100;
    return a.map((x, i) => x * p + b[i] * (1 - p));
  }
  throw new Error("cannot resolve " + v);
}
const lum = (c) => {
  const f = (x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a, b) => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("I5a: .drawer-labels-list .chip clears the U3 border-image-source (--u3-chip-teal) and meets >= 4.5:1 in dark and light", () => {
  // The U3 rule `.badge, .unit-tag, .chip, ... { border-image-source: var(--u3-chip-teal); }` comes AFTER the border-image shorthand,
  // so `.drawer-labels-list .chip` in `.pin-rail-active-inspector` (outside U4b's `.sidebar` scope) painted the solid teal 9-slice fill.
  const u3ChipTeal = allRules.find((r) => /\.chip\b/.test(r.sel) && /border-image-source:\s*var\(--u3-chip-teal\)/.test(r.body));
  assert.ok(u3ChipTeal, "U3 .chip border-image-source rule exists");

  const override = allRules.find((r) => r.sel === ":root:root .drawer-labels-list .chip");
  assert.ok(override, ":root:root .drawer-labels-list .chip override exists");
  assert.ok(override.at > u3ChipTeal.at, "override appears after U3 .chip border-image-source rule");
  assert.match(override.body, /border-image:\s*none\s*!important/, "clears border-image shorthand");
  assert.match(override.body, /border-image-source:\s*none\s*!important/, "clears border-image-source longhand");
  assert.match(override.body, /border:\s*1px solid var\(--cyan\)\s*!important/, "resets border from U3 1x2 kit-px transparent slice to 1px solid var(--cyan)");
  assert.match(override.body, /background:\s*color-mix\(in srgb,\s*var\(--cyan\)\s+18%,\s*var\(--panel\)\)\s*!important/);
  assert.match(override.body, /color:\s*var\(--text\)\s*!important/);

  for (const [name, tokens] of [
    ["dark", dark],
    ["light", light],
  ]) {
    const bg = color(tokens, "color-mix(in srgb, var(--cyan) 18%, var(--panel))");
    const fg = color(tokens, "var(--text)");
    const cr = ratio(fg, bg);
    assert.ok(cr >= 4.5, `${name} .drawer-labels-list .chip contrast ${cr.toFixed(2)}:1 >= 4.5:1`);
  }
});

test("I5b: .sky-static moves scanline repeating-linear-gradient to ::before (pointer-events: none, behind content) and keeps solid base >= 4.5:1", () => {
  const base = allRules.find((r) => r.sel === ".sky-static");
  assert.ok(base, ".sky-static rule exists");
  assert.doesNotMatch(base.body, /repeating-linear-gradient/, ".sky-static itself has no repeating-linear-gradient");
  assert.match(base.body, /background-color:\s*#11131f/, ".sky-static keeps solid dark base #11131f");
  assert.match(base.body, /position:\s*relative/, ".sky-static is position: relative for ::before");
  assert.match(base.body, /isolation:\s*isolate/, ".sky-static isolates stacking context so z-index: -1 stays above solid base");

  const before = allRules.find((r) => r.sel === ".sky-static::before");
  assert.ok(before, ".sky-static::before rule exists");
  assert.match(before.body, /content:\s*""/);
  assert.match(before.body, /position:\s*absolute/);
  assert.match(before.body, /pointer-events:\s*none/, "::before has pointer-events: none");
  assert.match(before.body, /z-index:\s*-1/, "::before sits behind content");
  assert.match(before.body, /inset:\s*0\s+0\s+60%\s+0/, "::before stops above centered label/button");
  assert.match(before.body, /repeating-linear-gradient\(0deg/, "::before carries horizontal scanlines");
  assert.match(before.body, /repeating-linear-gradient\(90deg/, "::before carries vertical scanlines");
  assert.match(before.body, /animation:\s*sky-static-roll/);

  const idleBefore = allRules.find((r) => r.sel === ".sky-zone.is-idle .sky-static::before");
  assert.ok(idleBefore && /display:\s*none/.test(idleBefore.body), "idle strip disables ::before scanlines");

  const textRule = allRules.find((r) => r.sel === ".sky-static-text");
  assert.ok(textRule && /background:\s*var\(--bg\)/.test(textRule.body), ".sky-static-text sits on solid var(--bg)");

  const btnRule = allRules.find((r) => r.sel === ".sky-static .btn");
  assert.ok(btnRule && /background:\s*var\(--cyan-fill\)/.test(btnRule.body) && /color:\s*var\(--on-cyan-fill\)/.test(btnRule.body), ".sky-static .btn uses solid --cyan-fill + --on-cyan-fill");

  for (const [name, tokens] of [
    ["dark", dark],
    ["light", light],
  ]) {
    const textCr = ratio(color(tokens, "var(--text)"), color(tokens, "var(--bg)"));
    assert.ok(textCr >= 4.5, `${name} .sky-static-text contrast ${textCr.toFixed(2)}:1 >= 4.5:1`);
    const btnCr = ratio(color(tokens, "var(--on-cyan-fill)"), color(tokens, "var(--cyan-fill)"));
    assert.ok(btnCr >= 4.5, `${name} .sky-static .btn contrast ${btnCr.toFixed(2)}:1 >= 4.5:1`);
  }
});
