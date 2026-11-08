// U4b contrast audit of the REAL app: computed text/control colours vs the backgrounds they sit on.
// Elements on the spray wash are checked against EVERY ramp/wash stop, solid ones against their own fill, opacity is applied.
// Usage: node u4b-contrast.mjs <url> <out.md>
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || join(homedir(), "projects/VibeSquad/scratch/pw/node_modules/playwright-core"));
const [,, url, out] = process.argv;
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const tok = readFileSync(join(homedir(), ".vibesquad/local-token"), "utf8").trim();

// [label, selector, kind (text 4.5 | non-text 3.0 | disabled 3.0), opts]  opts: { hover, pre, post }
const CHAT = [
  ["sidebar squad name", ".sidebar .team-name", "text"],
  ["sidebar section label", ".sidebar-teams-label", "text"],
  ["sidebar lane row", ".sidebar .pin-row", "text"],
  ["sidebar lane row, no session (was opacity .7)", ".sidebar .pin-row.no-session .pin-row-name", "text"],
  ["sidebar lane row, done (was opacity .6)", ".sidebar .pin-row.done", "text"],
  ["sidebar @code chip", ".sidebar .pin-lane-handle", "text"],
  ["sidebar inbox button (selected)", ".sidebar-inbox-badge", "text"],
  ["sidebar inbox button (unselected)", ".sidebar-inbox-badge", "text", { pre: "document.querySelector('.sidebar-inbox-badge').classList.remove('on')", post: "document.querySelector('.sidebar-inbox-badge').classList.add('on')" }],
  ["sidebar text button", ".sidebar-collapse-all-btn", "text"],
  ["sidebar row menu chip (quiet)", ".sidebar .tchip", "text"],
  ["sidebar row menu chip (hover)", ".sidebar .tchip", "text", { hover: true }],
  ["sidebar needs-you badge", ".sidebar .badge.alert, .sidebar .team-head .badge", "text"],
  ["sidebar footer button", ".sidebar-footer-row .btn", "text"],
  ["provider signals label", ".sidebar-signals-toggle > span:first-child", "text"],
  ["provider signals glyph 1 (Claude)", ".sidebar-signals-dots > span:nth-child(1)", "text"],
  ["provider signals glyph 2 (Gemini)", ".sidebar-signals-dots > span:nth-child(2)", "text"],
  ["provider signals glyph 3 (DeepSeek)", ".sidebar-signals-dots > span:nth-child(3)", "text"],
  ["provider signals glyph 4 (Codex)", ".sidebar-signals-dots > span:nth-child(4)", "text"],
  ["breadcrumb current", ".pin-focus-bar .breadcrumb-seg.current", "text"],
  ["breadcrumb parent", ".pin-focus-bar .breadcrumb-seg:not(.current)", "text"],
  ["top bar @code chip", ".pin-focus-bar .pin-lane-handle", "text"],
  ["top bar select value", ".pin-focus-bar .drawer-provider-select", "text"],
  ["top bar config button", ".pin-focus-bar .drawer-config-summary", "text"],
  ["top bar working chip", ".pin-focus-bar .drawer-working-chip", "text"],
  ["top bar dock button", ".pin-focus-bar .dock-toggle-btn", "text"],
  ["chat user bubble", ".timeline .tl-user", "text"],
  ["chat user bubble meta", ".timeline .tl-user .tl-stamp", "text"],
  ["chat tool row title", ".timeline .tl-tool .tool-name", "text"],
  ["chat tool row detail", ".timeline .tl-tool .muted", "text"],
  ["chat assistant body", ".timeline .tl-assistant", "text"],
  ["chat assistant body (hover)", ".timeline .tl-assistant", "text", { hover: true }],
  ["chat timestamp", ".timeline .tl-stamp", "text"],
  ["composer text", ".composer textarea", "text"],
  ["composer send button", ".composer .btn:not(.ghost)", "text"],
  ["composer ghost button", ".composer .btn.ghost", "text"],
  ["composer working chip", ".drawer-subagent-chip, .composer-subagents button", "text"],
];
const HUB = [
  ["hub: breadcrumb current", ".pin-focus-bar .breadcrumb-seg.current", "text"],
  ["hub: breadcrumb parent", ".pin-focus-bar .breadcrumb-seg:not(.current)", "text"],
  ["hub: top bar config button", ".pin-focus-bar .drawer-config-summary", "text"],
  ["hub: top bar select value", ".pin-focus-bar .drawer-provider-select", "text"],
  ["hub: composer text", ".composer textarea", "text"],
];

// Runs in the page. Background = first opaque layer, or a gradient ancestor (then EVERY ramp/wash stop is checked);
// a url() image under text FAILs; opacity along the ancestor chain is applied to the text colour.
const measure = ([items, withSyn]) => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const g = cv.getContext("2d", { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (f, b, a = f[3]) => [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)).concat([1]);
  const root = getComputedStyle(document.documentElement);
  const tok = (n) => rgba(root.getPropertyValue(n).trim());
  const mix = (a, b, p) => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat([1]);
  const bg = tok("--bg"), panel = tok("--panel"), hi = tok("--panel-hi");
  const stops = {
    sidebar: [bg, panel, hi], // --u4-ramp: bg 0%, panel 52%, panel-hi 100%
    page: [bg, panel, mix(tok("--violet"), bg, 0.14), mix(tok("--hot-pink"), panel, 0.09)], // --u4-wash: bg->panel + violet 14% pool (top right, over bg) + pink 9% pool (bottom left, over panel)
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const res = [];
  for (const [label, sel, kind] of items) {
    const el = document.querySelector(sel);
    if (!el) { res.push({ label, kind, missing: true }); continue; }
    const fg0 = rgba(getComputedStyle(el).color);
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    const layers = []; let cands = null, urlImage = false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s2 = getComputedStyle(n);
      const c = rgba(s2.backgroundColor), img = s2.backgroundImage;
      if (img && img !== "none") {
        if (/url\(/.test(img)) { urlImage = true; break; }
        if (/gradient/.test(img)) { cands = n.matches(".sidebar") ? stops.sidebar : stops.page; break; }
      }
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.99) { cands = [layers.pop()]; break; }
    }
    if (urlImage) { res.push({ label, kind, fg: hex(fg0), bgLo: "url()", bgHi: "url()", lo: 0, hi: 0, ramp: false, note: "url() image under text" }); continue; }
    if (!cands) cands = stops.page;
    while (layers.length) { const l = layers.pop(); cands = cands.map((b) => over(l, b)); }
    const rs = cands.map((b) => { const f = over(fg0, b, fg0[3] * opacity); return { r: ratio(f, b), f, b }; });
    const lo = rs.reduce((a, b) => (b.r < a.r ? b : a)), best = rs.reduce((a, b) => (b.r > a.r ? b : a));
    res.push({ label, kind, fg: hex(lo.f), bgLo: hex(lo.b), bgHi: hex(best.b), lo: lo.r, hi: best.r, ramp: cands.length > 1, note: opacity < 0.99 ? `opacity ${opacity.toFixed(2)}` : "" });
  }
  if (withSyn) {
    const muted = tok("--muted"), text = tok("--text"), light = document.documentElement.dataset.theme === "light";
    const syn = [
      ["disabled button label (muted on panel)", muted, [panel], "disabled"],
      ["placeholder (muted on composer field)", muted, [bg], "text"],
      ["control edge / select edge (non-text)", light ? muted : tok("--violet"), stops.sidebar.concat(stops.page), "non-text"],
      ["status pip fill running/attn (dark) or INK rim (light)", light ? rgba("#35204c") : tok("--emerald"), [bg, panel, hi], "non-text"],
      ["status pip needs-you fill (dark) or INK rim (light)", light ? rgba("#35204c") : tok("--hot-pink"), [bg, panel, hi], "non-text"],
      ["status pip idle outline (muted)", muted, [bg, panel, hi], "non-text"],
      ["raised row (text on panel-hi)", text, [hi], "text"],
      ["selected row accent bar (non-text, cyan-fill)", tok("--cyan-fill"), [panel, hi], "non-text"],
    ];
    for (const [label, fg, bgs, kind] of syn) {
      const rs = bgs.map((b) => ratio(fg, b));
      res.push({ label, kind, fg: hex(fg), bgLo: hex(bgs[rs.indexOf(Math.min(...rs))]), bgHi: hex(bgs[rs.indexOf(Math.max(...rs))]), lo: Math.min(...rs), hi: Math.max(...rs), ramp: bgs.length > 1, note: "" });
    }
  }
  return { rows: res, stops: { bg: hex(bg), panel: hex(panel), hi: hex(hi), poolViolet: hex(stops.page[2]), poolPink: hex(stops.page[3]) } };
};

const rows = {};
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-vibesquad-token": tok }, viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
  await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(6000);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  const one = async ([label, sel, kind, o]) => {
    if (o?.pre) await page.evaluate(o.pre);
    if (o?.hover) { const loc = page.locator(sel).first(); if (await loc.count()) await loc.hover({ force: true }).catch(() => {}); await page.waitForTimeout(300); }
    const r = await page.evaluate(measure, [[[label, sel, kind]], false]);
    if (o?.pre) await page.evaluate(o.post);
    if (o?.hover) await page.mouse.move(0, 0);
    return r.rows[0];
  };
  const all = [];
  await page.locator(".sidebar >> text=Art Direction").first().click();
  await page.waitForTimeout(3500);
  await page.locator(".pin-done-toggle").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  const first = await page.evaluate(measure, [CHAT.filter((x) => !x[3]).map((x) => x.slice(0, 3)), true]);
  all.push(...first.rows);
  for (const it of CHAT.filter((x) => x[3])) all.push(await one(it));
  await page.locator(".sidebar-riffbot").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(3500);
  for (const it of HUB) all.push(await one(it));
  rows[theme] = { rows: all, stops: first.stops };
  await ctx.close();
}
await browser.close();

let md = "# U4b contrast table (WCAG 2.x)\n\nGenerated by `art/ui/u4b/src/u4b-contrast.mjs` from the REAL app's computed colours (`node u4b-contrast.mjs <url> art/ui/u4b/CONTRAST.md`). Text/controls need >= 4.5, disabled labels and non-text edges/dots >= 3.0. Rows that sit on the spray wash are measured against EVERY ramp stop (sidebar: bg / panel / panel-hi; page + chat pane: bg / panel / violet 14% pool / pink 9% pool); `ratio` is the worst stop, `best` the easiest.\n";
let fails = 0;
for (const theme of ["dark", "light"]) {
  const { rows: r, stops } = rows[theme];
  md += `\n## ${theme}\n\nRamp stops: bg \`${stops.bg}\` -> panel \`${stops.panel}\` -> panel-hi \`${stops.hi}\`; pools \`${stops.poolViolet}\` (violet) / \`${stops.poolPink}\` (pink).\n\n| Pair | FG | worst BG | Kind | Ratio (worst) | Best | Bar | |\n|---|---|---|---|---|---|---|---|\n`;
  for (const x of r.slice().sort((a, b) => (a.lo ?? 99) - (b.lo ?? 99))) {
    if (x.missing) { md += `| ${x.label} | n/a | n/a | n/a | not on screen | | | SKIP |\n`; continue; }
    const bar = x.kind === "text" ? 4.5 : 3.0; const ok = x.lo >= bar; if (!ok) fails++;
    md += `| ${x.label}${x.ramp ? " (ramp)" : ""}${x.note ? ` [${x.note}]` : ""} | \`${x.fg}\` | \`${x.bgLo}\` | ${x.kind} | ${x.lo.toFixed(2)} | ${x.hi.toFixed(2)} | ${bar} | ${ok ? "PASS" : "FAIL"} |\n`;
  }
}
md += `\n**FAIL count: ${fails}**\n`;
writeFileSync(out, md);
console.log(md);
