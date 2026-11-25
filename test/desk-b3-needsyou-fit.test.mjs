// Des8 B3 (docs/PLAN_DESK_NAV_HISTORY.md, idea-740 m3 + m5, docs/UX_REVIEW_R16.md:50,52).
// Pins two invariants:
//   (1) the light `--st-err` token clears 4.5:1 against the `.tl-exit-badge` background (`--st-err-bg` over `--surface-0`);
//   (2) the Needs-you location tooltip is always set (geometry now lives in desk-u3-needs-loc.test.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("boring.css");
const inbox = read("BoringInbox.tsx");

// --- WCAG contrast math (same as test/i5-contrast.test.mjs) --------------------
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
// 6- or 8-digit hex -> [r, g, b] (+ alpha in [0,1] when 8-digit)
const hex = (h) => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(h.trim());
  if (!m) throw new Error("bad hex " + h);
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return m[2] ? [...rgb, parseInt(m[2], 16) / 255] : rgb;
};
// composite an 8-digit-hex token over a solid surface
const over = (fg, surf) => {
  const [r, g, b, a] = hex(fg);
  return [r, g, b].map((x, i) => x * a + surf[i] * (1 - a));
};

// --- light token block ----------------------------------------------------------
function lightTokens() {
  // The first `data-theme="light"` block is the alias block (no --st-err); pick the one that declares the semantic tokens.
  const blocks = [...css.matchAll(/html\[data-vibe="boring"\]\[data-theme="light"\]\s*\{([^{}]*)\}/g)];
  const block = blocks.find((m) => m[1].includes("--st-err"));
  assert.ok(block, "light token block with --st-err present");
  const t = {};
  for (const mm of block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) t[mm[1]] = mm[2].trim();
  return t;
}

// --- CSS rules in source order --------------------------------------------------
function rules(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ sel: m[1].trim(), body: m[2], at: m.index });
  return out;
}
const allRules = rules(css);
// the last rule whose selector matches is the effective one (source-order cascade)
const lastRule = (re) => {
  const hits = allRules.filter((r) => re.test(r.sel));
  assert.ok(hits.length > 0, `expected a rule matching ${re}`);
  return hits[hits.length - 1];
};

test("B3 m5: light --st-err clears 4.5:1 on the .tl-exit-badge background", () => {
  const t = lightTokens();
  const fg = hex(t["--st-err"]);
  const surf = hex(t["--surface-0"]);
  // `.tl-exit-badge` (base, non-.ok) is `color: var(--st-err)` on `background: var(--st-err-bg)`
  const badgeRule = lastRule(/\.tl-exit-badge\b(?!\.ok)/);
  assert.match(badgeRule.body, /background:\s*var\(--st-err-bg\)/);
  assert.match(badgeRule.body, /color:\s*var\(--st-err\)/);
  const bg = over(t["--st-err-bg"], surf);
  const cr = ratio(fg, bg);
  assert.ok(cr >= 4.5, `light --st-err (${t["--st-err"]}) on --st-err-bg over --surface-0 = ${cr.toFixed(2)}:1, need >= 4.5:1`);
});

test("B3 n1: light --st-err-bg is the same hue as --st-err (matched token pair)", () => {
  const t = lightTokens();
  const err = hex(t["--st-err"]).slice(0, 3);
  const bg = hex(t["--st-err-bg"]).slice(0, 3);
  assert.deepEqual(bg, err, `--st-err-bg rgb ${bg} should equal --st-err rgb ${err}`);
});

// B3 m3 (location geometry) moved to test/desk-u3-needs-loc.test.mjs: a real-browser probe at 290/307px, light + dark (UX R25 m3).
test("B3 round 2: the location tooltip is always set (it can ellipsize)", () => {
  const src = readFileSync(new URL("../src/BoringInbox.tsx", import.meta.url), "utf8");
  assert.match(src, /data-testid="boring-needs-where" title=\{`\$\{r\.lane\} · \$\{r\.project\}`\}/);
});
