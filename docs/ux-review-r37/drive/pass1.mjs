// R37 first pass: landing at 4 configs, metrics + screenshots.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r37"); const LOGS = path.join(OUT, "logs"); fs.mkdirSync(LOGS, { recursive: true });
const PORT = 5937; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const cfgs = (process.argv[2] ? [process.argv[2]] : ["dark-1920", "light-1920", "dark-3200", "light-3200"]);
export async function open(cfg, url = "/?demo=") {
  const [theme, w] = cfg.split("-"); const big = w === "3200";
  const ctx = await browser.newContext({ viewport: big ? { width: 3200, height: 1800 } : { width: 1920, height: 1080 }, deviceScaleFactor: big ? 1.2 : 1, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
for (const cfg of cfgs) {
  resetBackend();
  const { ctx, page, errs } = await open(cfg);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s); const qa = (s) => [...document.querySelectorAll(s)];
    const r = (e) => e ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) : null;
    const desk = q('[data-testid="boring-decision-desk"]');
    const strip = q('[data-testid="boring-decision-strip"]');
    const needs = qa('.boring-sidebar *').find((e) => /^Needs you/.test(e.textContent?.trim() || "") && e.children.length < 6);
    return {
      url: location.search,
      nav: q('[data-testid="boring-decisions-nav"]')?.textContent, navRect: r(q('[data-testid="boring-decisions-nav"]')),
      summary: q('[data-testid="boring-decision-summary"]')?.textContent,
      desk: r(desk), deskScroll: desk ? { sh: desk.scrollHeight, ch: desk.clientHeight } : null,
      strip: r(strip), stripScroll: strip ? { sh: strip.scrollHeight, ch: strip.clientHeight, sw: strip.scrollWidth, cw: strip.clientWidth } : null,
      stripLines: qa('[data-testid="boring-decision-strip"] .boring-decision-strip-line').map((e) => ({ t: e.textContent, trunc: e.scrollWidth > e.clientWidth + 1, ...r(e) })),
      stripText: strip?.innerText,
      send: r(q('[data-testid="boring-decision-send-btn"]')), sendText: q('[data-testid="boring-decision-send-btn"]')?.textContent,
      deskText: desk?.innerText,
      needsHead: qa('.boring-sidebar h2, .boring-sidebar h3, .boring-sidebar button, .boring-sidebar div').map(e => e.textContent.trim()).filter(t => /^Needs you/.test(t)).slice(0, 3),
      sidebarText: q('.boring-sidebar')?.innerText,
      selected: qa('.boring-sidebar [aria-current="page"], .boring-sidebar .is-selected, .boring-sidebar .selected, .boring-sidebar [aria-selected="true"]').map(e => e.textContent.trim().slice(0, 40)),
      crumb: q('.boring-breadcrumb, [data-testid="boring-breadcrumb"]')?.textContent,
      fonts: [...new Set(qa('[data-testid="boring-decision-desk"] *').map(e => getComputedStyle(e).fontSize))],
    };
  });
  fs.writeFileSync(path.join(LOGS, `pass1-${cfg}.json`), JSON.stringify({ ...m, errs }, null, 1));
  await page.screenshot({ path: path.join(OUT, `r37-${cfg}-landing.png`) });
  console.log(cfg, JSON.stringify({ url: m.url, nav: m.nav, summary: m.summary, desk: m.desk, deskScroll: m.deskScroll, strip: m.strip, stripScroll: m.stripScroll, n: m.stripLines.length, trunc: m.stripLines.filter(l => l.trunc).length, send: m.send, needsHead: m.needsHead, selected: m.selected, crumb: m.crumb, fonts: m.fonts, errs }));
  await ctx.close();
}
await browser.close(); server.close();
