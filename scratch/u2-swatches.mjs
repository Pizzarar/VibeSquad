import fs from "node:fs";
function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
const rgb = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
const lum = (x) => { const [r, g, b] = rgb(x).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, p) => "#" + rgb(a).map((v, i) => Math.round(v * p + rgb(b)[i] * (1 - p)).toString(16).padStart(2, "0")).join("");
const INK = "#2b1840", MUTED = "#574268";
const acc = { teal: "#3fa3a6", pink: "#d63f88", mint: "#2e9462", violet: "#9a7fe0" };
const tok = { "--cyan-t": mix(acc.teal, INK, 0.38), "--pink-t": mix(acc.pink, INK, 0.5), "--mint-t": mix(acc.mint, INK, 0.42), "--violet-t": mix(acc.violet, INK, 0.3) };
const cands = [
  { id: "A", name: "Dusty Mauve", h: 318, s: 20, l: 85 },
  { id: "B", name: "Lavender Cream", h: 275, s: 22, l: 86 },
  { id: "C", name: "Peach Cream", h: 24, s: 38, l: 85 },
];
const out = [];
let html = `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#222;font:13px/1.35 Consolas,monospace;padding:16px;width:1400px}
h1{color:#eee;font-size:16px;margin:0 0 10px}
.row{display:flex;gap:16px}
.sw{flex:1;padding:14px;border:2px solid #111}
.sw h2{margin:0 0 8px;font-size:15px}
.p{padding:10px;margin:8px 0;border:1px solid}
.t{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.t span{padding:1px 6px}
table{border-collapse:collapse;font-size:11px;margin-top:6px}td{padding:1px 8px 1px 0}
</style><h1>U2 light --bg candidates (P0 text #2b1840, muted #65507d). Mock target: pastel, softer than #fff0f4.</h1><div class=row>`;
for (const c of cands) {
  const bg = hsl2hex(c.h, c.s, c.l);
  const panel = hsl2hex(c.h, c.s, c.l + 5);
  const hi = hsl2hex(c.h, c.s, c.l - 5);
  const line = hsl2hex(c.h, c.s - 4, c.l - 22);
  const rows = [];
  const add = (label, fg, bgc) => { const r = cr(fg, bgc); rows.push([label, r]); if (r < 4.5) throw new Error(`${c.id} ${label} ${r.toFixed(2)}`); };
  for (const [sn, sv] of [["bg", bg], ["panel", panel], ["panel-hi", hi]]) {
    add(`text on ${sn}`, INK, sv);
    add(`muted on ${sn}`, MUTED, sv);
    for (const k of Object.keys(tok)) add(`${k} on ${sn}`, tok[k], sv);
  }
  out.push({ ...c, bg, panel, hi, line, rows });
  html += `<div class=sw style="background:${bg};color:${INK}"><h2>${c.id}: ${c.name} --bg ${bg}</h2>
<div class=p style="background:${panel};border-color:${line}"><b>--panel ${panel}</b><br><span style="color:${MUTED}">muted text</span> ${Object.keys(tok).map((k) => `<span style="color:${tok[k]}">${k.slice(2)}</span>`).join(" ")}</div>
<div class=p style="background:${hi};border-color:${line}"><b>--panel-hi ${hi}</b><br><span style="color:${MUTED}">muted text</span> ${Object.keys(tok).map((k) => `<span style="color:${tok[k]}">${k.slice(2)}</span>`).join(" ")}</div>
<div style="color:${MUTED}">muted on bg</div><div class=t><span style="background:${acc.violet}">violet fill</span><span style="background:${acc.pink};color:#fff">pink</span><span style="background:#f7bf5c">amber</span></div>
<table>${rows.map(([l, r]) => `<tr><td>${l}</td><td>${r.toFixed(2)}:1</td></tr>`).join("")}</table></div>`;
}
html += "</div>";
fs.writeFileSync("scratch/u2-swatches.html", html);
fs.writeFileSync("scratch/u2-swatches.json", JSON.stringify(out.map((o) => ({ id: o.id, bg: o.bg, panel: o.panel, hi: o.hi, line: o.line, min: Math.min(...o.rows.map((r) => r[1])).toFixed(2) })), null, 1));
console.log(fs.readFileSync("scratch/u2-swatches.json", "utf8"));
