import fs from "node:fs";

function splitTop(s) {
  const out = []; let d = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") d++; if (ch === ")") d--;
    if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const sgn = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

function rewriteShadow(prop, value, selector) {
  if (/^none\b/.test(value.trim())) return null;
  if (prop === "text-shadow") return "2px 2px 0 var(--shadow-hard)";
  if (/\.badge\.alert$/.test(selector.trim())) return null; // the one allowed glow
  const layers = splitTop(value);
  const keep = []; let hard = false, glow = false;
  for (const l of layers) {
    if (/^inset\b/.test(l)) { keep.push(l); continue; } // hard inset bars / rings
    const m = l.match(/^(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?\s+(\d+(?:\.\d+)?)(?:px)?/);
    if (!m) { keep.push(l); continue; }
    const [x, y, b] = [+m[1], +m[2], +m[3]];
    if (b === 0) { keep.push(l); continue; }
    if (x === 0 && y === 0) { glow = true; continue; }
    hard = true;
    keep.push(`${sgn(x) * 2}px ${sgn(y) * 2}px 0 var(--shadow-hard)`);
  }
  if (glow || hard) {
    const out = keep.filter((k) => !/var\(--shadow-hard\)$/.test(k) || true);
    const hasHard = out.some((k) => /--shadow-hard/.test(k));
    const lead = glow ? ["var(--bevel)"] : [];
    if (hard && !glow) lead.push("var(--bevel)");
    return [...lead, ...out].join(", ");
  }
  return null;
}

let css = fs.readFileSync("src/styles.css", "utf8");
let n = 0;
css = css.replace(/([^{};]*)\{([^{}]*)\}/g, (full, sel, body) => {
  const nb = body.replace(/(box-shadow|text-shadow):\s*([^;]+);/g, (m, prop, val) => {
    const r = rewriteShadow(prop, val, sel.split(/\n/).pop());
    if (r === null) return m;
    n++;
    return `${prop}: ${r};`;
  });
  return nb === body ? full : `${sel}{${nb}}`;
});
console.log("shadows rewritten:", n);

const base = {
  "00f0ff": "cyan", ff2a85: "hot-pink", ff3d81: "hot-pink", ff4d4d: "hot-pink", ff4fd8: "hot-pink", ff7ae5: "hot-pink", ff4d6a: "hot-pink",
  b86bff: "violet", b06bff: "violet", "7c9cf5": "violet",
  f59e0b: "amber", ffb000: "amber", fbbf24: "amber", ffc83d: "amber",
  "4dffb0": "emerald", "35e08a": "emerald", "4df7a6": "emerald", "00e09a": "emerald",
};
const hairlines = ["161830", "1a1c34", "2b244d", "162238", "1a1d3a", "2c3060", "1b1e38", "1b4d46", "1c4a56", "274868", "3b4270", "2b3048"];
let h = 0;
css = css.split("\n").map((line, i) => {
  if (i < 90 || /data-accent/.test(line)) return line;
  line = line.replace(/#([0-9a-f]{6})([0-9a-f]{2})?\b/gi, (m, hex, a, off) => {
    const before = line.slice(0, off);
    if (/var\(--[\w-]+,\s*$/.test(before)) return m;
    const k = hex.toLowerCase();
    let tok = base[k] ? `var(--${base[k]})` : null;
    if (!tok && hairlines.includes(k)) tok = "var(--line)";
    if (!tok && k === "0d111c") return "var(--well)";
    if (!tok) return m;
    h++;
    const pct = a ? Math.max(4, Math.round((parseInt(a, 16) / 255) * 100)) : (hairlines.includes(k) ? 50 : 100);
    return pct === 100 ? tok : `color-mix(in srgb, ${tok} ${pct}%, transparent)`;
  });
  line = line.replace(/rgba\(\s*(0|255|184|56),\s*(240|61|255|107|246|77),\s*(255|129|240|106),\s*([\d.]+)\)/g, (m, r, g, b, a) => {
    const key = `${r},${g},${b}`;
    const t = { "0,240,255": "cyan", "255,61,129": "hot-pink", "184,107,255": "violet", "0,255,240": "cyan", "255,77,106": "hot-pink" }[key];
    if (!t) return m;
    h++;
    return `color-mix(in srgb, var(--${t}) ${Math.round(+a * 100)}%, transparent)`;
  });
  return line;
}).join("\n");
console.log("hex/rgba rewritten:", h);
css = css.replace(/var\(--neon-cyan\)/g, "var(--cyan)");
fs.writeFileSync("src/styles.css", css);

for (const f of ["src/ResponsiveSmallWindow.css", "src/HubBar.css"]) {
  let c = fs.readFileSync(f, "utf8");
  c = c.replace(/box-shadow:\s*0 0 24px rgba\(255, 77, 106, 0\.35\)/, "box-shadow: var(--bevel), var(--hard)").replace(/#ff4d6a/g, "var(--hot-pink)");
  fs.writeFileSync(f, c);
}
