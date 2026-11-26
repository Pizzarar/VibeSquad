// R42 pass 3: rail-mode column alignment (every column's left edge per strip line) + truncation at 1920 and 3200@1.2, dark+light, quiet fold closed and open.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5969; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const log = {};
const measure = () => {
  const strip = document.querySelector('[data-testid="boring-decision-strip"]');
  const lines = [...strip.querySelectorAll(".boring-decision-strip-line")];
  const rows = lines.map(l => {
    const kids = [...l.children].map(c => { const r = c.getBoundingClientRect(); return { cls: c.className.split(" ")[0], x: Math.round(r.left), r: Math.round(r.right), text: c.textContent.trim().slice(0, 40), trunc: c.scrollWidth > c.clientWidth + 1 }; });
    return { name: l.querySelector(".boring-decision-strip-lane-name")?.textContent, lineX: Math.round(l.getBoundingClientRect().left), lineR: Math.round(l.getBoundingClientRect().right), kids, truncSpans: [...l.querySelectorAll("span")].filter(s => s.scrollWidth > s.clientWidth + 1).map(s => ({ cls: s.className, text: s.textContent, shown: s.clientWidth, need: s.scrollWidth })) };
  });
  // per-column-index spread of left edges (only cells with nonzero width)
  const byCls = {};
  for (const r of rows) for (const k of r.kids) (byCls[k.cls] ||= []).push(k.x);
  const spreads = Object.fromEntries(Object.entries(byCls).map(([c, v]) => [c, { n: v.length, spread: Math.max(...v) - Math.min(...v) }]));
  const pick = (c) => { const e = document.querySelector(c); return e ? getComputedStyle(e).gridTemplateColumns : null; };
  const sr = strip.getBoundingClientRect();
  return { cols: { groups: pick(".boring-decision-strip-groups"), squad: pick(".boring-decision-strip-squad"), lanes: pick(".boring-decision-strip-lanes"), line: pick(".boring-decision-strip-line") },
    lineTemplatesDistinct: [...new Set(lines.map(l => getComputedStyle(l).gridTemplateColumns))].length,
    spreads, nLines: lines.length, truncLines: rows.filter(r => r.truncSpans.length).length, trunc: rows.filter(r => r.truncSpans.length).map(r => ({ name: r.name, t: r.truncSpans })),
    overflowRight: rows.filter(r => r.kids.some(k => k.r > r.lineR + 1)).map(r => r.name),
    strip: { w: Math.round(sr.width), h: Math.round(sr.height), bottom: Math.round(sr.bottom) }, innerHeight,
    fade: !!strip.querySelector('[data-testid="boring-decision-strip-fade"]'), rows };
};
for (const theme of ["dark", "light"]) for (const [name, vp, dsf] of [["1920", { width: 1920, height: 1080 }, 1], ["3200", { width: 3200, height: 1800 }, 1.2]]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme }); await ctx.addInitScript(prefsInit(theme));
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`); await page.waitForTimeout(1800);
  const k = `${theme}-${name}`;
  log[k] = await page.evaluate(measure);
  if (k === "dark-3200" || k === "light-1920") await page.locator('[data-testid="boring-decision-strip"]').screenshot({ path: path.join(OUT, `r42-${k}-rail-strip.png`) });
  if (k === "dark-1920") await page.screenshot({ path: path.join(OUT, `r42-dark-1920-lanes24.png`), scale: "css" });
  if (name === "3200") {
    await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
    log[k + "-quietOpen"] = await page.evaluate(measure);
    if (theme === "dark") await page.locator('[data-testid="boring-decision-strip"]').screenshot({ path: path.join(OUT, `r42-dark-3200-quiet-open.png`) });
  }
  log[k].errs = errs; await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass3.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify({ cols: v.cols, distinct: v.lineTemplatesDistinct, spreads: v.spreads, n: v.nLines, trunc: v.truncLines, ovR: v.overflowRight, strip: v.strip, fade: v.fade, errs: v.errs }));
await browser.close(); server.close();
