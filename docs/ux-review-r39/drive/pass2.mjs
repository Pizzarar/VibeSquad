// R39 pass 2: keyboard focus order (rail + stacked), stacked strip scroll-in-cap + quiet fold, lean opt-in visuals,
// truncated event hover text, m1 fresh ?view=decisions URL flash, m3 strip order vs feed order.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r39"); const LOGS = path.join(OUT, "logs");
const PORT = 5958; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const T = (id) => `[data-testid="${id}"]`;
async function open(theme, url, vp = { width: 1920, height: 1080 }, dsf = 1) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const log = {};
const desc = () => { const e = document.activeElement; if (!e || e === document.body) return "body"; const zone = e.closest('[data-testid="boring-decision-strip"]') ? "STRIP" : e.closest('[data-testid="boring-decision-feed"]') ? "FEED" : e.closest(".boring-sidebar") ? "SIDEBAR" : e.closest('[data-testid="boring-decision-desk"]') ? "DESK" : "OTHER"; const r = e.getBoundingClientRect(); return `${zone} ${e.tagName.toLowerCase()}${e.dataset.testid ? "#" + e.dataset.testid : ""} "${(e.textContent || e.placeholder || "").trim().slice(0, 28)}" y=${Math.round(r.y)} x=${Math.round(r.x)}`; };
for (const [name, vp] of [["focus1920", { width: 1920, height: 1080 }], ["focus1600", { width: 1600, height: 900 }]]) {
  const { ctx, page, errs } = await open("dark", "/?demo=&lanes=24", vp);
  await page.locator(T("boring-decision-summary")).click({ position: { x: 2, y: 2 } }).catch(() => {});
  const seq = [];
  for (let i = 0; i < 75; i++) { await page.keyboard.press("Tab"); seq.push(await page.evaluate(desc)); }
  // collapse to zone transitions
  const zones = []; for (const s of seq) { const z = s.split(" ")[0]; if (zones[zones.length - 1] !== z) zones.push(z); }
  log[name] = { zones, seq, errs };
  await ctx.close();
}
{ // stacked strip at 1600: scroll to it, scroll within cap, expand quiet, check feed/page unaffected; dark + light
  for (const theme of ["dark", "light"]) {
    const { ctx, page, errs } = await open(theme, "/?demo=&lanes=24", { width: 1600, height: 900 });
    const strip = page.locator(T("boring-decision-strip"));
    await strip.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    const geo = () => page.evaluate(() => { const s = document.querySelector('[data-testid="boring-decision-strip"]'); const r = s.getBoundingClientRect(); const lines = [...s.querySelectorAll(".boring-decision-strip-line")]; const vis = lines.filter(l => { const b = l.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1; }).length; return { top: Math.round(r.top), h: Math.round(r.height), clientH: s.clientHeight, scrollH: s.scrollHeight, scrollTop: Math.round(s.scrollTop), lines: lines.length, visibleLines: vis, quietBtn: s.querySelector('[data-testid^="boring-decision-strip-quiet-"]')?.textContent, overscroll: getComputedStyle(s).overscrollBehaviorY, sticky: [...s.querySelectorAll("*")].filter(e => getComputedStyle(e).position === "sticky").map(e => e.className).slice(0, 3) }; });
    const before = await geo();
    await page.screenshot({ path: path.join(OUT, `r39-${theme}-1600-stacked-strip.png`) });
    const box = await strip.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200); await page.waitForTimeout(300);
    const afterWheel = await geo();
    await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(250);
    const afterQuiet = await geo();
    await page.screenshot({ path: path.join(OUT, `r39-${theme}-1600-stacked-quiet-open.png`) });
    log[`stacked-${theme}`] = { before, afterWheel, afterQuiet, errs };
    await ctx.close();
  }
}
{ // quiet fold in the rail at 3200 (dark)
  const { ctx, page, errs } = await open("dark", "/?demo=&lanes=24", { width: 3200, height: 1800 }, 1.2);
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(250);
  log.quiet3200 = await page.evaluate(() => { const s = document.querySelector('[data-testid="boring-decision-strip"]'); const r = s.getBoundingClientRect(); return { h: Math.round(r.height), bottom: Math.round(r.bottom), clientH: s.clientHeight, scrollH: s.scrollHeight, lines: s.querySelectorAll(".boring-decision-strip-line").length, btn: s.querySelector('[data-testid^="boring-decision-strip-quiet-"]')?.textContent, innerHeight, feedTop: Math.round(document.querySelector('[data-testid="boring-decision-feed"]').getBoundingClientRect().top) }; });
  log.quiet3200.errs = errs;
  await page.screenshot({ path: path.join(OUT, "r39-dark-3200-lanes24-quiet-open.png") }); await ctx.close();
}
{ // lean opt-in visuals + hover text on truncated events at 1920 (light)
  const { ctx, page, errs } = await open("light", "/?demo=");
  const i1 = "ny-00000000000000000001";
  const chip = () => page.evaluate(() => { const e = document.querySelector("button.is-lean"); const cs = getComputedStyle(e); return { t: e.textContent, pressed: e.getAttribute("aria-pressed"), cls: e.className, bs: cs.borderStyle, bg: cs.backgroundColor }; });
  const barT = () => page.evaluate(() => document.querySelector('[data-testid="boring-decision-send-btn"]')?.closest("div")?.parentElement?.innerText.replace(/\n/g, " | "));
  log.lean = { initial: await chip(), bar0: await barT() };
  await page.locator(T(`boring-decision-lean-${i1}`)).click(); await page.waitForTimeout(150);
  log.lean.clicked = await chip(); log.lean.bar1 = await barT();
  await page.locator(T(`boring-decision-card-${i1}`)).screenshot({ path: path.join(OUT, "r39-light-1920-lean-staged-card.png") });
  log.hover = await page.evaluate(() => [...document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')].map(l => { const sp = [...l.querySelectorAll("span")].filter(s => s.scrollWidth > s.clientWidth + 1); if (!sp.length) return null; const s = sp[0]; let t = null; for (let e = s; e && e !== l.parentElement; e = e.parentElement) if (e.title) { t = e.title; break; } return { text: s.textContent, ellipsis: getComputedStyle(s).textOverflow, titleOnSelfOrAncestor: t }; }).filter(Boolean));
  log.leanErrs = errs; await ctx.close();
}
{ // m1: fresh load of ?view=decisions; m3: strip Squad order vs feed order
  const { ctx, page, errs } = await open("dark", "/?demo=&view=decisions");
  log.freshViewDecisions = await page.evaluate(() => ({ url: location.search, h: window.__h }));
  await page.reload(); await page.waitForTimeout(1500);
  log.reloadViewDecisions = await page.evaluate(() => ({ url: location.search, h: window.__h }));
  log.order = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="boring-decision-strip"]'); const feed = document.querySelector('[data-testid="boring-decision-feed"]');
    const stripSquads = [...new Set([...strip.querySelectorAll('[data-testid^="boring-decision-strip-lane-"]')].map(e => e.dataset.testid.replace("boring-decision-strip-lane-", "").split("-")[0]))];
    const feedSquads = [...feed.querySelectorAll("h3, h4, [class*='squad']")].map(e => e.textContent.trim()).filter(Boolean).slice(0, 8);
    return { stripSquads, feedSquads, stripText: strip.innerText.split("\n").slice(0, 3) };
  });
  log.m1m3Errs = errs; await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify(k.startsWith("focus") ? { zones: v.zones, errs: v.errs } : v).slice(0, 1500));
await browser.close(); server.close();
