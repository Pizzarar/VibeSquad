// Block I5 (docs/PLAN_INBOX_SWEEP_1108.md, idea-26 + idea-27): @art V1b contrast leftovers.
// (a) In Vite 8's CSS minifier (lightningcss), `border-image: none !important` is serialized as invalid `border-image:!important`
//     (empty value before `!important`), which Chromium drops at parse time. That left U3's `.chip { border-image-source: var(--u3-chip-teal) }`
//     and `border-image-slice: 3 4 fill` active in production builds, painting the solid #4fd6cf teal sprite fill (1.59:1 with #f7f0ff --text).
//     Using the longhand `border-image-source: none !important` survives lightningcss (`border-image-source:none!important`) and clears the sprite.
// (b) `.sky-static-text` already sits on solid `background: var(--bg)` (>= 4.5:1 in dark and light).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

test("I5a: .drawer-labels-list .chip avoids lightningcss border-image:none truncation and clears --u3-chip-teal (>= 4.5:1)", () => {
  const u3ChipFill = allRules.find((r) => /\.chip\b/.test(r.sel) && /border-image:[^;]*\bfill\b/.test(r.body));
  const u3ChipTeal = allRules.find((r) => /\.chip\b/.test(r.sel) && /border-image-source:\s*var\(--u3-chip-teal\)/.test(r.body));
  assert.ok(u3ChipFill && u3ChipTeal, "U3 .chip 9-slice fill and --u3-chip-teal rules exist");

  // Confirm why master's `chip-teal-dark.png` center (#4fd6cf = rgb(79,214,207)) failed with dark `--text` (#f7f0ff): 1.59:1 < 4.5.
  const brokenCr = ratio(color(dark, "var(--text)"), [79, 214, 207]);
  assert.ok(brokenCr < 1.65, `un-cleared --u3-chip-teal fill contrast is ${brokenCr.toFixed(2)}:1 (< 4.5:1)`);

  const override = allRules.find((r) => r.sel === ":root:root .drawer-labels-list .chip");
  assert.ok(override, ":root:root .drawer-labels-list .chip override exists");
  assert.ok(override.at > u3ChipTeal.at, "override appears after U3 .chip border-image-source rule");
  assert.doesNotMatch(override.body, /border-image\s*:\s*none\b/, "must not use `border-image: none` shorthand (lightningcss minifies it to invalid `border-image:`)");
  assert.match(override.body, /border-image-source:\s*none\s*!important/, "uses longhand `border-image-source: none !important`");

  // Verify through Vite's lightningcss minifier that the rule emits valid `border-image-source:none!important` (and not `border-image:!important`).
  const req = createRequire(new URL("../node_modules/vite/package.json", import.meta.url));
  const lightningcss = req("lightningcss");
  const minified = lightningcss
    .transform({
      filename: "styles.css",
      code: Buffer.from(`${override.sel} { ${override.body} }`),
      minify: true,
    })
    .code.toString();
  assert.doesNotMatch(minified, /border-image:\s*(!important|[;}])/, "minified CSS has no empty `border-image:` value");
  assert.match(minified, /border-image-source:none!important/, "minified CSS preserves `border-image-source:none!important`");

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

test("I5b: .sky-static-text sits on solid var(--bg) with >= 4.5:1 contrast in dark and light", () => {
  const textRule = allRules.find((r) => r.sel === ".sky-static-text");
  assert.ok(textRule && /background:\s*var\(--bg\)/.test(textRule.body), ".sky-static-text sits on solid var(--bg)");

  for (const [name, tokens] of [
    ["dark", dark],
    ["light", light],
  ]) {
    const textCr = ratio(color(tokens, "var(--text)"), color(tokens, "var(--bg)"));
    assert.ok(textCr >= 4.5, `${name} .sky-static-text contrast ${textCr.toFixed(2)}:1 >= 4.5:1`);
  }
});
