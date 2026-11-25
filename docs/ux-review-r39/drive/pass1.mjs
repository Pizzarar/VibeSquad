// R39 pass 1: landing geometry at 1600x900, 1920x1080, 3200x1800@1.2 x dark/light x {demo, ?lanes=24}:
// rail width, feed measure, strip truncation, stacked-strip order/cap/scroll, cards above the send bar.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r39"); const LOGS = path.join(OUT, "logs"); fs.mkdirSync(LOGS, { recursive: true });
const PORT = 5957; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const VP = { 1600: [{ width: 1600, height: 900 }, 1], 1920: [{ width: 1920, height: 1080 }, 1], 3200: [{ width: 3200, height: 1800 }, 1.2], 1366: [{ width: 1366, height: 768 }, 1], 2400: [{ width: 2400, height: 1350 }, 1] };
const runs = [];
for (const w of ["1600", "1920", "3200"]) for (const theme of ["dark", "light"]) for (const extra of ["", "&lanes=24"]) runs.push([theme, w, extra]);
runs.push(["dark", "1366", "&lanes=24"], ["dark", "2400", "&lanes=24"]);
const all = {};
for (const [theme, w, extra] of runs) {
  resetBackend();
  const [viewport, dsf] = VP[w];
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=${extra}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s); const qa = (s) => [...document.querySelectorAll(s)];
    const r = (e) => e ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) : null;
    const T = (id) => `[data-testid="${id}"]`;
    const desk = q(T("boring-decision-desk")); const strip = q(T("boring-decision-strip")); const feed = q(T("boring-decision-feed"));
    const send = q(T("boring-decision-send-btn")); const sendBar = send?.closest('[class*="send"]') || send?.parentElement;
    const sendTop = sendBar ? sendBar.getBoundingClientRect().top : innerHeight;
    const cards = qa('[data-testid^="boring-decision-card-"]');
    // the scroll container that holds the strip lines (strip itself or a child)
    const scroller = [strip, ...(strip ? strip.querySelectorAll("*") : [])].find(e => e && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
      || [strip, ...(strip ? strip.querySelectorAll("*") : [])].find(e => e && /auto|scroll/.test(getComputedStyle(e).overflowY));
    const lines = qa('[data-testid="boring-decision-strip"] .boring-decision-strip-line');
    const lineInfo = lines.map((e) => { const spans = [...e.querySelectorAll("span")]; const tr = spans.filter(s => s.scrollWidth > s.clientWidth + 1); return { t: e.innerText.replace(/\n/g, " | "), w: Math.round(e.getBoundingClientRect().width), truncSpans: tr.map(s => ({ cls: s.className, shown: Math.round(s.clientWidth), need: s.scrollWidth, title: !!s.title || !!e.title })) }; });
    const card0 = cards[0]; const ask = card0?.querySelector('[class*="ask"], h3, h2, strong');
    const cs = (e) => e ? getComputedStyle(e) : null;
    return {
      deskCls: desk?.className, desk: r(desk), main: r(desk?.parentElement), strip: r(strip), feed: r(feed),
      order: strip && feed ? (strip.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING ? "strip-before-feed(DOM)" : "feed-before-strip(DOM)") : null,
      visualOrder: strip && feed ? (strip.getBoundingClientRect().top >= feed.getBoundingClientRect().bottom - 1 ? "strip-below-feed" : strip.getBoundingClientRect().left >= feed.getBoundingClientRect().right - 1 ? "strip-right-of-feed" : "strip-above/overlap") : null,
      stripCss: strip ? { maxH: cs(strip).maxHeight, ovY: cs(strip).overflowY, gridArea: cs(strip).gridArea, order: cs(strip).order } : null,
      scroller: scroller ? { cls: scroller.className, testid: scroller.dataset?.testid, maxH: cs(scroller).maxHeight, ovY: cs(scroller).overflowY, clientH: scroller.clientHeight, scrollH: scroller.scrollHeight, ...r(scroller) } : null,
      stripMeta: q('[data-testid="boring-decision-strip"] .boring-decision-section-meta')?.textContent,
      nLines: lines.length, truncLines: lineInfo.filter(l => l.truncSpans.length).length, lineInfo,
      quietBtns: qa('[data-testid^="boring-decision-strip-quiet-"]').map(e => e.textContent),
      card0: r(card0), card0Ask: ask ? { w: Math.round(ask.getBoundingClientRect().width), font: cs(ask).fontSize, chars: Math.round(ask.getBoundingClientRect().width / (parseFloat(cs(ask).fontSize) * 0.5)) } : null,
      sendTop: Math.round(sendTop), innerHeight, innerWidth,
      cardsAbove: cards.filter(c => c.getBoundingClientRect().bottom <= sendTop).length,
      cardsStart: cards.filter(c => c.getBoundingClientRect().top < sendTop).length,
      docScroll: document.scrollingElement.scrollHeight > innerHeight + 2,
      summary: q(T("boring-decision-summary"))?.textContent,
      groups: qa('[data-testid="boring-decision-strip"] [class*="group-head"], [data-testid="boring-decision-strip"] h3, [data-testid="boring-decision-strip"] h4').map(e => e.textContent.trim().slice(0, 30)),
      feedGroups: qa('[data-testid="boring-decision-feed"] h3, [data-testid="boring-decision-feed"] [class*="group-head"]').map(e => e.textContent.trim().slice(0, 30)),
    };
  });
  const name = `${theme}-${w}${extra ? "-lanes24" : ""}`;
  all[name] = { ...m, errs };
  await page.screenshot({ path: path.join(OUT, `r39-${name}.png`) });
  console.log(name, JSON.stringify({ deskCls: m.deskCls, desk: m.desk, strip: m.strip, feed: m.feed, vis: m.visualOrder, dom: m.order, stripCss: m.stripCss, scroller: m.scroller && { maxH: m.scroller.maxH, ovY: m.scroller.ovY, cH: m.scroller.clientH, sH: m.scroller.scrollH }, n: m.nLines, trunc: m.truncLines, quiet: m.quietBtns, card0: m.card0, ask: m.card0Ask, sendTop: m.sendTop, above: m.cardsAbove, start: m.cardsStart, docScroll: m.docScroll, errs }));
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass1.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
