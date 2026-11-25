// R38 pass 1: landing metrics at 4 configs x {demo, ?lanes=24}; fold, rail, lean, counts, badge.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r38"); const LOGS = path.join(OUT, "logs"); fs.mkdirSync(LOGS, { recursive: true });
const PORT = 5947; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const runs = [];
for (const cfg of ["dark-1920", "light-1920", "dark-3200", "light-3200"]) for (const extra of ["", "&lanes=24"]) runs.push([cfg, extra]);
const all = {};
for (const [cfg, extra] of runs) {
  resetBackend();
  const [theme, w] = cfg.split("-"); const big = w === "3200";
  const ctx = await browser.newContext({ viewport: big ? { width: 3200, height: 1800 } : { width: 1920, height: 1080 }, deviceScaleFactor: big ? 1.2 : 1, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=${extra}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s); const qa = (s) => [...document.querySelectorAll(s)];
    const r = (e) => e ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) : null;
    const T = (id) => `[data-testid="${id}"]`;
    const send = q(T("boring-decision-send-btn")); const sendBar = send?.closest('[class*="send"]') || send?.parentElement;
    const cards = qa('[data-testid^="boring-decision-card-"]');
    const sendTop = sendBar ? sendBar.getBoundingClientRect().top : innerHeight;
    return {
      url: location.search, h: window.__h,
      desk: r(q(T("boring-decision-desk"))), wide: q(T("boring-decision-desk"))?.className,
      nav: q(T("boring-decisions-nav"))?.textContent,
      summary: q(T("boring-decision-summary"))?.textContent, offLink: q(T("boring-decision-offscreen-link"))?.textContent,
      h1: qa('[data-testid="boring-decision-desk"] h1').length,
      head: r(q(".boring-decision-head")),
      strip: r(q(T("boring-decision-strip"))), feed: r(q(T("boring-decision-feed"))),
      stripMeta: q('[data-testid="boring-decision-strip"] .boring-decision-section-meta')?.textContent,
      stripLines: qa('[data-testid="boring-decision-strip"] .boring-decision-strip-line').map((e) => ({ t: e.innerText.replace(/\n/g, " | "), trunc: [...e.querySelectorAll("span")].some(s => s.scrollWidth > s.clientWidth + 1 && !s.title), y: Math.round(e.getBoundingClientRect().y) })),
      quietBtns: qa('[data-testid^="boring-decision-strip-quiet-"]').map(e => ({ t: e.textContent, title: e.title, ...r(e) })),
      feedMeta: q('[data-testid="boring-decision-feed"] .boring-decision-section-meta')?.textContent,
      sendText: send?.textContent, sendBarText: sendBar?.innerText, sendTop: Math.round(sendTop), innerHeight,
      cardsAbove: cards.filter(c => c.getBoundingClientRect().bottom <= sendTop).length,
      cardsStart: cards.filter(c => c.getBoundingClientRect().top < sendTop).length,
      firstCard: r(cards[0]),
      lean1: qa('button.is-lean').slice(0, 2).map(e => ({ t: e.textContent, pressed: e.getAttribute("aria-pressed"), cls: e.className, bs: getComputedStyle(e).borderStyle, bg: getComputedStyle(e).backgroundColor })),
      selected: qa('.boring-sidebar [aria-current="page"], .boring-sidebar .is-selected, .boring-sidebar .selected, .boring-sidebar [aria-selected="true"]').map(e => e.textContent.trim().slice(0, 40)),
      crumb: q('.boring-breadcrumb, [data-testid="boring-breadcrumb"]')?.textContent,
      needsTitle: qa('.boring-sidebar [title]').filter(e => /^Needs you/.test(e.textContent.trim())).map(e => e.title).slice(0, 2),
    };
  });
  const name = `${cfg}${extra ? "-lanes24" : ""}`;
  all[name] = { ...m, errs };
  await page.screenshot({ path: path.join(OUT, `r38-${name}-landing.png`) });
  console.log(name, JSON.stringify({ url: m.url, h: m.h, nav: m.nav, summary: m.summary, wide: m.wide, h1: m.h1, strip: m.strip, feed: m.feed, nLines: m.stripLines.length, trunc: m.stripLines.filter(l => l.trunc).length, quiet: m.quietBtns.map(b => b.t), send: m.sendText, sendTop: m.sendTop, cardsAbove: m.cardsAbove, cardsStart: m.cardsStart, firstCard: m.firstCard, lean1: m.lean1[0], errs }));
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass1.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
