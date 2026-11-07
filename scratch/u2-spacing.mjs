import fs from "node:fs";
import { execSync } from "node:child_process";
const f = "src/styles.css";
const diff = execSync(`git diff -U0 fc388c6 -- ${f}`, { encoding: "utf8" });
const changed = new Set();
for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) { const s = +m[1], n = m[2] === undefined ? 1 : +m[2]; for (let i = 0; i < n; i++) changed.add(s + i); }
let css = fs.readFileSync(f, "utf8");
const tok = { 4: 1, 8: 2, 12: 3, 16: 4, 24: 5, 32: 6 };
const round = { 7: 8, 9: 8, 11: 12, 13: 12, 15: 16, 17: 16 };
const rounded = {}; let rules = 0, vals = 0;
const lineAt = (off) => css.slice(0, off).split("\n").length;
css = css.replace(/([^{};]*)\{([^{}]*)\}/g, (full, sel, body, off) => {
  const start = lineAt(off + sel.length), end = lineAt(off + sel.length + body.length + 1);
  let touched = false;
  for (let l = start; l <= end; l++) if (changed.has(l)) { touched = true; break; }
  if (!touched || /^\s*(:root|@font-face|@keyframes)/.test(sel.trim())) return full;
  let did = false;
  const nb = body.replace(/(^|[;\s{])((?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g, (m, pre, prop, val) => {
    if (/var\(|calc\(|%|auto|em|rem|vh|vw|clamp|min\(|max\(/.test(val.replace(/var\(--sp-\d\)/g, ""))) { if (/var\(--(?!sp)|calc|%|em|vh|vw|clamp|min\(|max\(/.test(val)) return m; }
    const nv = val.replace(/(-?)(\d+)px/g, (mm, neg, n) => {
      let k = +n; let r = k;
      if (round[k]) r = round[k];
      if (!tok[r]) return mm;
      if (r !== k) { const key = `${k}->${r}`; rounded[key] = (rounded[key] || 0) + 1; }
      vals++; did = true;
      return neg ? `calc(var(--sp-${tok[r]}) * -1)` : `var(--sp-${tok[r]})`;
    });
    return pre + prop + ": " + nv;
  });
  if (did) rules++;
  return did ? `${sel}{${nb}}` : full;
});
css = css.replace("  --vs-ui-scale: 1;\n  --sidebar-w", "  --sp-1: 4px;\n  --sp-2: 8px;\n  --sp-3: 12px;\n  --sp-4: 16px;\n  --sp-5: 24px;\n  --sp-6: 32px;\n  --vs-ui-scale: 1;\n  --sidebar-w");
fs.writeFileSync(f, css);
console.log({ rules, vals, rounded });
