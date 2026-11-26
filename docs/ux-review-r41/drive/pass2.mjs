// R41 pass 2: Tab order (rail 1920 + stacked 1600), stacked-strip scroll cue (top/mid/bottom, sticky heads, fade colour vs strip bg),
// quiet fold (stacked + 3200 rail), lean opt-in visuals, fresh ?view=decisions URL writes.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit, T } from "./common.mjs";
const PORT = 5968; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
async function open(theme, url, vp = { width: 1920, height: 1080 }, dsf = 1) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(prefsInit(theme));
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const log = {};
const desc = () => { const e = document.activeElement; if (!e || e === document.body) return "body"; const zone = e.closest('[data-testid="boring-decision-strip"]') ? "STRIP" : e.closest('[data-testid="boring-decision-offscreen"]') ? "OFFSCREEN" : e.closest('[data-testid="boring-decision-feed"]') ? "FEED" : e.closest('[data-testid="boring-decision-bar"]') ? "BAR" : e.closest(".boring-sidebar") ? "SIDEBAR" : e.closest('[data-testid="boring-decision-desk"]') ? "DESK" : "OTHER"; const r = e.getBoundingClientRect(); return `${zone} ${e.tagName.toLowerCase()}${e.dataset.testid ? "#" + e.dataset.testid : ""} "${(e.textContent || "").trim().slice(0, 28)}" y=${Math.round(r.y)} x=${Math.round(r.x)}`; };
for (const [name, vp] of [["focus1920", { width: 1920, height: 1080 }], ["focus1600", { width: 1600, height: 900 }]]) {
  const { ctx, page, errs } = await open("dark", "/?demo=&view=decisions&lanes=24", vp);
  await page.locator(T("boring-decision-summary")).click({ position: { x: 2, y: 2 } }).catch(() => {});
  const seq = []; for (let i = 0; i < 80; i++) { await page.keyboard.press("Tab"); seq.push(await page.evaluate(desc)); }
  const zones = []; for (const s of seq) { const z = s.split(" ")[0]; if (zones[zones.length - 1] !== z) zones.push(z); }
  log[name] = { zones, seq, errs }; await ctx.close();
}
const geo = (page) => page.evaluate(() => {
  const s = document.querySelector('[data-testid="boring-decision-strip"]'); const r = s.getBoundingClientRect();
  const fade = s.querySelector('[data-testid="boring-decision-strip-fade"]'); const fr = fade.getBoundingClientRect();
  const heads = [...s.querySelectorAll(".boring-decision-strip-squad-btn")];
  const stuck = heads.filter(h => Math.abs(h.getBoundingClientRect().top - r.top) < 2 && s.scrollTop > 0).map(h => h.textContent.trim().slice(0, 30));
  let bgEl = s; while (bgEl && getComputedStyle(bgEl).backgroundColor === "rgba(0, 0, 0, 0)") bgEl = bgEl.parentElement;
  return { top: Math.round(r.top), h: Math.round(r.height), scrollTop: Math.round(s.scrollTop), scrollH: s.scrollHeight, clientH: s.clientHeight, more: s.dataset.scrollMore || null,
    fade: { display: getComputedStyle(fade).display, top: Math.round(fr.top), bottom: Math.round(fr.bottom), bg: getComputedStyle(fade).backgroundImage },
    stripBg: getComputedStyle(bgEl).backgroundColor, stripBgFrom: bgEl.className || bgEl.tagName, headBg: heads[0] ? getComputedStyle(heads[0]).backgroundColor : null, headPos: heads[0] ? getComputedStyle(heads[0]).position : null, stuckHead: stuck,
    quietBtn: s.querySelector('[data-testid^="boring-decision-strip-quiet-"]')?.textContent, lines: s.querySelectorAll(".boring-decision-strip-line").length,
    pageScrollY: Math.round(scrollY), mainScroll: Math.round(document.querySelector('[data-testid="boring-decision-desk"]')?.closest("main")?.scrollTop ?? -1) };
});
for (const [theme, vp] of [["dark", { width: 1600, height: 900 }], ["light", { width: 1600, height: 900 }], ["dark", { width: 1366, height: 768 }]]) {
  const key = `stacked-${theme}-${vp.width}`;
  const { ctx, page, errs } = await open(theme, "/?demo=&view=decisions&lanes=24", vp);
  const strip = page.locator(T("boring-decision-strip"));
  await strip.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  const atTop = await geo(page);
  if (vp.width === 1600) await page.screenshot({ path: path.join(OUT, `r41-${theme}-1600-stacked-strip.png`), scale: "css" });
  const box = await strip.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120); await page.waitForTimeout(300);
  const mid = await geo(page);
  if (theme === "dark" && vp.width === 1600) await strip.screenshot({ path: path.join(OUT, `r41-dark-1600-strip-mid.png`) });
  await page.mouse.wheel(0, 2000); await page.waitForTimeout(300);
  const bottom = await geo(page);
  await page.mouse.wheel(0, 400); await page.waitForTimeout(300);
  const overscroll = await geo(page);
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
  const quietOpen = await geo(page);
  if (theme === "light" && vp.width === 1600) await strip.screenshot({ path: path.join(OUT, `r41-light-1600-strip-quiet-open.png`) });
  log[key] = { atTop, mid, bottom, overscroll, quietOpen, errs }; await ctx.close();
}
{ const { ctx, page, errs } = await open("dark", "/?demo=&view=decisions&lanes=24", { width: 3200, height: 1800 }, 1.2);
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(250);
  log.quiet3200 = await page.evaluate(() => { const s = document.querySelector('[data-testid="boring-decision-strip"]'); const r = s.getBoundingClientRect(); const f = s.querySelector('[data-testid="boring-decision-strip-fade"]'); return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), clientH: s.clientHeight, scrollH: s.scrollHeight, lines: s.querySelectorAll(".boring-decision-strip-line").length, btn: s.querySelector('[data-testid^="boring-decision-strip-quiet-"]')?.textContent, fade: f ? getComputedStyle(f).display : "absent", headPos: getComputedStyle(s.querySelector(".boring-decision-strip-squad-btn")).position, trunc: [...s.querySelectorAll(".boring-decision-strip-line span")].filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent), innerHeight, feedTop: Math.round(document.querySelector('[data-testid="boring-decision-feed"]').getBoundingClientRect().top) }; });
  log.quiet3200.errs = errs; await ctx.close(); }
{ const { ctx, page, errs } = await open("light", "/?demo=&view=decisions");
  const i1 = "ny-00000000000000000001";
  const chip = () => page.evaluate(() => { const e = document.querySelector("button.is-lean"); const cs = getComputedStyle(e); return { t: e.textContent, pressed: e.getAttribute("aria-pressed"), cls: e.className, bs: cs.borderStyle, bg: cs.backgroundColor }; });
  const barT = () => page.evaluate(() => document.querySelector('[data-testid="boring-decision-bar"]')?.innerText.replace(/\n/g, " | "));
  log.lean = { initial: await chip(), bar0: await barT() };
  await page.locator(T(`boring-decision-lean-${i1}`)).click(); await page.waitForTimeout(150);
  log.lean.clicked = await chip(); log.lean.bar1 = await barT(); log.leanErrs = errs; await ctx.close(); }
{ const { ctx, page, errs } = await open("dark", "/?demo=&view=decisions");
  log.freshViewDecisions = await page.evaluate(() => ({ url: location.search, h: window.__h }));
  await page.reload(); await page.waitForTimeout(1500);
  log.reloadViewDecisions = await page.evaluate(() => ({ url: location.search, h: window.__h }));
  log.urlErrs = errs; await ctx.close(); }
fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify(k.startsWith("focus") ? { zones: v.zones, errs: v.errs } : v).slice(0, 1800));
await browser.close(); server.close();
