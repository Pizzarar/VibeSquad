// R41 pass 1: geometry at 1366x768, 1600x900, 1920x1080, 3200x1800@1.2 x dark/light with ?lanes=24 (+ plain demo at 1920/3200):
// rail width, strip truncation, stacked order feed -> off-screen -> strip, strip cap + scroll-cue state, cards above send bar.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5967; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const VP = { 1366: [{ width: 1366, height: 768 }, 1], 1600: [{ width: 1600, height: 900 }, 1], 1920: [{ width: 1920, height: 1080 }, 1], 3200: [{ width: 3200, height: 1800 }, 1.2] };
const runs = [];
for (const w of ["1366", "1600", "1920", "3200"]) for (const theme of ["dark", "light"]) runs.push([theme, w, "&lanes=24"]);
runs.push(["dark", "1920", ""], ["light", "1920", ""], ["dark", "3200", ""]);
const all = {};
for (const [theme, w, extra] of runs) {
  resetBackend();
  const [viewport, dsf] = VP[w];
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(prefsInit(theme));
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions${extra}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s); const qa = (s) => [...document.querySelectorAll(s)];
    const r = (e) => e ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) : null;
    const T = (id) => `[data-testid="${id}"]`;
    const desk = q(T("boring-decision-desk")); const strip = q(T("boring-decision-strip")); const feed = q(T("boring-decision-feed")); const off = q(T("boring-decision-offscreen"));
    const bar = q(T("boring-decision-bar")); const sendTop = bar ? bar.getBoundingClientRect().top : innerHeight;
    const cards = qa('[data-testid^="boring-decision-card-"]');
    const lines = qa('[data-testid="boring-decision-strip"] .boring-decision-strip-line');
    const lineInfo = lines.map((e) => { const tr = [...e.querySelectorAll("span")].filter(s => s.scrollWidth > s.clientWidth + 1); return { t: e.innerText.replace(/\n/g, " | "), w: Math.round(e.getBoundingClientRect().width), trunc: tr.map(s => ({ cls: s.className, text: s.textContent, shown: Math.round(s.clientWidth), need: s.scrollWidth })) }; });
    const fade = q(T("boring-decision-strip-fade"));
    const pos = (a, b) => a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after") : null;
    return {
      wide: desk?.classList.contains("is-wide"), desk: r(desk), feed: r(feed), off: r(off), strip: r(strip),
      feedBeforeOff: pos(feed, off), offBeforeStrip: pos(off, strip),
      stripCss: strip ? { maxH: getComputedStyle(strip).maxHeight, ovY: getComputedStyle(strip).overflowY, overscroll: getComputedStyle(strip).overscrollBehaviorY } : null,
      stripScroll: strip ? { clientH: strip.clientHeight, scrollH: strip.scrollHeight } : null,
      scrollMore: strip?.dataset.scrollMore || null, fadeDisplay: fade ? getComputedStyle(fade).display : null,
      nLines: lines.length, truncLines: lineInfo.filter(l => l.trunc.length).length, lineInfo,
      sendTop: Math.round(sendTop), innerHeight, cardsAbove: cards.filter(c => c.getBoundingClientRect().bottom <= sendTop).length, cardsStart: cards.filter(c => c.getBoundingClientRect().top < sendTop).length,
      quietBtns: qa('[data-testid^="boring-decision-strip-quiet-"]').map(e => e.textContent), search: location.search,
    };
  });
  const name = `${theme}-${w}${extra ? "-lanes24" : ""}`;
  all[name] = { ...m, errs };
  if (["dark-1920-lanes24", "light-3200-lanes24"].includes(name)) await page.screenshot({ path: path.join(OUT, `r41-${name}.png`), scale: "css" });
  console.log(name, JSON.stringify({ wide: m.wide, desk: m.desk?.w, feed: m.feed?.w, strip: m.strip, off: m.off?.y, order: [m.feedBeforeOff, m.offBeforeStrip], css: m.stripCss, sc: m.stripScroll, more: m.scrollMore, fade: m.fadeDisplay, n: m.nLines, trunc: m.truncLines, above: m.cardsAbove, start: m.cardsStart, search: m.search, errs }));
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass1.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
