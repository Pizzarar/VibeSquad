// U4b contrast audit of the REAL app: computed text/control colours vs the backgrounds they sit on.
// Elements on the spray wash are checked against both ends of the ramp (and the pool tints), solid ones against their own fill.
// Usage: node u4b-contrast.mjs <url> <out.md>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)("C:/Users/Fugma/projects/VibeSquad/scratch/pw/node_modules/playwright-core");
const [,, url, out] = process.argv;
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const tok = readFileSync("C:/Users/Fugma/.vibesquad/local-token", "utf8").trim();

const PAIRS = [
  // [label, selector, kind (text 4.5 | non-text 3.0), color property, edge: false]
  ["sidebar squad name", ".sidebar .team-name", "text"],
  ["sidebar section label", ".sidebar-teams-label", "text"],
  ["sidebar lane row", ".sidebar .pin-row", "text"],
  ["sidebar @code chip", ".sidebar .pin-lane-handle", "text"],
  ["sidebar inbox button (selected)", ".sidebar-inbox-badge", "text"],
  ["sidebar text button", ".sidebar-collapse-all-btn", "text"],
  ["sidebar row menu chip", ".sidebar .tchip", "text"],
  ["sidebar needs-you badge", ".sidebar .badge.alert", "text"],
  ["sidebar footer button", ".sidebar-footer-row .btn", "text"],
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
  ["chat timestamp", ".timeline > .tl-stamp, .timeline .tl-assistant + .tl-stamp, .timeline .tl-stamp", "text"],
  ["composer text", ".composer textarea", "text"],
  ["composer send button", ".composer .btn:not(.ghost)", "text"],
  ["composer ghost button", ".composer .btn.ghost", "text"],
  ["composer working chip", ".drawer-subagent-chip, .composer-subagents button", "text"],
];

const rows = {};
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-vibesquad-token": tok }, viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
  await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(6000);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.locator(".sidebar >> text=Art Direction").first().click();
  await page.waitForTimeout(3500);
  rows[theme] = await page.evaluate((PAIRS) => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1;
    const g = cv.getContext("2d", { willReadFrequently: true });
    const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat([1]);
    const root = getComputedStyle(document.documentElement);
    const tok = (n) => rgba(root.getPropertyValue(n).trim());
    const mix = (a, b, p) => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat([1]);
    const bg = tok("--bg"), panel = tok("--panel"), hi = tok("--panel-hi");
    const wash = { // both ends of each ramp + the soft pools (violet 14% top-right over bg, pink 9% bottom-left over panel)
      sidebar: [bg, panel, hi],
      page: [bg, panel, mix(tok("--violet"), bg, 0.14), mix(tok("--hot-pink"), panel, 0.09)],
    };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const res = [];
    for (const [label, sel, kind] of PAIRS) {
      const el = document.querySelector(sel);
      if (!el) { res.push({ label, missing: true }); continue; }
      const fg0 = rgba(getComputedStyle(el).color);
      // background stack: collect layers from el upward until opaque
      let layers = [], n = el, zone = el.closest(".sidebar") ? "sidebar" : "page";
      while (n && n !== document.documentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 0.99) break;
        n = n.parentElement;
      }
      let cands = layers.length && layers[layers.length - 1][3] >= 0.99 ? [layers.pop()] : wash[zone];
      while (layers.length) { const l = layers.pop(); cands = cands.map((b) => over(l, b)); }
      let worst = null;
      for (const b of cands) { const fg = fg0[3] < 1 ? over(fg0, b) : fg0; const r = ratio(fg, b); if (!worst || r < worst.r) worst = { r, fg, b }; }
      let best = null; for (const b of cands) { const fg = fg0[3] < 1 ? over(fg0, b) : fg0; const r = ratio(fg, b); if (!best || r > best.r) best = { r, fg, b }; }
      res.push({ label, kind, fg: hex(worst.fg), bgLo: hex(worst.b), bgHi: hex(best.b), lo: worst.r, hi: best.r, ramp: cands.length > 1 });
    }
    // synthetic pairs for states that are not on screen right now
    const muted = tok("--muted"), text = tok("--text"), edge = rgba(root.getPropertyValue("--u4-edge").trim() === "var(--violet)" ? root.getPropertyValue("--violet") : root.getPropertyValue("--muted"));
    const edgeNow = rgba(getComputedStyle(document.documentElement).getPropertyValue("--u4-edge") || "#000");
    const syn = [
      ["disabled button label (muted on panel)", muted, [panel], "disabled"],
      ["placeholder (muted on composer field)", muted, [bg], "text"],
      ["control edge / select edge (non-text)", (document.documentElement.dataset.theme === "light" ? muted : tok("--violet")), wash.sidebar.concat(wash.page), "non-text"],
      ["status pip fill running/idle-attn (dark) or INK rim (light)", document.documentElement.dataset.theme === "light" ? rgba("#35204c") : tok("--emerald"), [bg, panel, hi], "non-text"],
      ["status pip needs-you fill (dark) or INK rim (light)", document.documentElement.dataset.theme === "light" ? rgba("#35204c") : tok("--hot-pink"), [bg, panel, hi], "non-text"],
      ["status pip idle outline (muted)", muted, [bg, panel, hi], "non-text"],
      ["raised row (text on panel-hi)", text, [hi], "text"],
      ["selected row accent bar (non-text, cyan-fill)", tok("--cyan-fill"), [panel, hi], "non-text"],
    ];
    for (const [label, fg, bgs, kind] of syn) {
      const rs = bgs.map((b) => ratio(fg, b));
      res.push({ label, kind, fg: hex(fg), bgLo: hex(bgs[rs.indexOf(Math.min(...rs))]), bgHi: hex(bgs[rs.indexOf(Math.max(...rs))]), lo: Math.min(...rs), hi: Math.max(...rs), ramp: bgs.length > 1, synthetic: true });
    }
    return { rows: res, stops: { bg: hex(bg), panel: hex(panel), hi: hex(hi), poolViolet: hex(mix(tok("--violet"), bg, 0.14)), poolPink: hex(mix(tok("--hot-pink"), panel, 0.09)) } };
  }, PAIRS);
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
    md += `| ${x.label}${x.ramp ? " (ramp)" : ""} | \`${x.fg}\` | \`${x.bgLo}\` | ${x.kind} | ${x.lo.toFixed(2)} | ${x.hi.toFixed(2)} | ${bar} | ${ok ? "PASS" : "FAIL"} |\n`;
  }
}
md += `\n**FAIL count: ${fails}**\n`;
writeFileSync(out, md);
console.log(md);
