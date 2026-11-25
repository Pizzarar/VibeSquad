// R38 pass 2: lean opt-in semantics, send bar copy, Send+Undo, badge vs feed after send, quiet expand, narrow (non-rail) layout, history.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend, state } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r38"); const LOGS = path.join(OUT, "logs");
const PORT = 5948; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const B = `http://127.0.0.1:${PORT}`;
async function open(theme, url = "/?demo=", vp = { width: 1920, height: 1080 }, dsf = 1) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } addEventListener("popstate", () => window.__h.push("POP " + location.search)); })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
const log = {}; const T = (id) => `[data-testid="${id}"]`;
const bar = (p) => p.evaluate(() => { const b = document.querySelector('[data-testid="boring-decision-send-btn"]') || document.querySelector('[data-testid="boring-decision-undo-btn"]'); if (!b) return null; let e = b; while (e && !/sendbar|send-bar|boring-decision-send(?!-btn)/.test(e.className || "")) e = e.parentElement; return { btn: b?.textContent, disabled: b?.disabled, bar: (e || b.parentElement.parentElement).innerText.replace(/\n/g, " | ") }; });
const chips = (p, id) => p.evaluate((id) => [...document.querySelectorAll(`[data-testid="boring-decision-card-${id}"] button`)].map(e => `${e.textContent}[${e.getAttribute("aria-pressed")}|${e.className.replace("boring-decision-choice", "").trim()}]`), id);
const nav = (p) => p.locator(T("boring-decisions-nav")).textContent();
const feedN = (p) => p.evaluate(() => ({ summary: document.querySelector('[data-testid="boring-decision-summary"]')?.textContent, cards: document.querySelectorAll('[data-testid^="boring-decision-card-"]').length, feedMeta: document.querySelector('[data-testid="boring-decision-feed"] .boring-decision-section-meta')?.textContent }));
{
  resetBackend(); const { ctx, page, errs } = await open("dark");
  const [i1, i2, i3, i5] = ["ny-00000000000000000001", "ny-00000000000000000002", "ny-00000000000000000003", "ny-00000000000000000005"];
  log.initial = { bar: await bar(page), c1: await chips(page, i1) };
  await page.locator(T(`boring-decision-lean-${i1}`)).click(); await page.waitForTimeout(150);
  log.leanClick = { bar: await bar(page), c1: await chips(page, i1) };
  await page.locator(T(`boring-decision-lean-${i1}`)).click(); await page.waitForTimeout(150);
  log.leanUnclick = { bar: await bar(page), c1: await chips(page, i1) };
  // done-check style: flip 2 (Not that on 1, alt on 2), answer 1 (row 3)
  await page.locator(T(`boring-decision-not-${i1}`)).click();
  await page.locator(`${T(`boring-decision-card-${i2}`)} button`, { hasText: "Hold for D4 bundle" }).click();
  await page.locator(T(`boring-decision-input-${i3}`)).fill("30000"); await page.waitForTimeout(200);
  log.flip2answer1 = { bar: await bar(page), c1: await chips(page, i1), c2: await chips(page, i2), c5: await chips(page, i5) };
  await page.screenshot({ path: path.join(OUT, "r38-dark-1920-staged3.png") });
  await page.locator(T("boring-decision-desk")).locator("button", { hasText: /^Use all leans/ }).click(); await page.waitForTimeout(200);
  log.useAll = { bar: await bar(page), c5: await chips(page, i5), c1: await chips(page, i1) };
  await page.locator(T(`boring-decision-card-${i5}`)).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "r38-dark-1920-useall.png") });
  log.navBefore = await nav(page); log.feedBefore = await feedN(page);
  await page.locator(T("boring-decision-send-btn")).click(); await page.waitForTimeout(300);
  log.sending = await bar(page);
  await page.screenshot({ path: path.join(OUT, "r38-dark-1920-sending.png") });
  await page.waitForTimeout(6500);
  log.afterSend = { delivered: state.deliveredPrompts.length, nav: await nav(page), feed: await feedN(page), bar: await bar(page) };
  await page.screenshot({ path: path.join(OUT, "r38-dark-1920-after-send.png") });
  log.errs = errs; await ctx.close();
}
{ // quiet expand at 1920 lanes=24 (light)
  resetBackend(); const { ctx, page, errs } = await open("light", "/?demo=&lanes=24");
  const q = page.locator('[data-testid^="boring-decision-strip-quiet-"]').first();
  await q.click(); await page.waitForTimeout(250);
  log.quietOpen = await page.evaluate(() => { const s = document.querySelector('[data-testid="boring-decision-strip"]').getBoundingClientRect(); return { stripBottom: Math.round(s.bottom), lines: document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line').length, btn: document.querySelector('[data-testid^="boring-decision-strip-quiet-"]').textContent, innerHeight }; });
  await page.screenshot({ path: path.join(OUT, "r38-light-1920-lanes24-quiet-open.png") });
  log.errsQ = errs; await ctx.close();
}
for (const [w, h] of [[1600, 900], [1366, 768]]) { // below the rail threshold
  resetBackend(); const { ctx, page, errs } = await open("dark", "/?demo=&lanes=24", { width: w, height: h });
  log[`narrow${w}`] = await page.evaluate(() => { const q = (s) => document.querySelector(s); const send = q('[data-testid="boring-decision-send-btn"]'); const top = send.closest("div").getBoundingClientRect().top; const cards = [...document.querySelectorAll('[data-testid^="boring-decision-card-"]')]; const s = q('[data-testid="boring-decision-strip"]').getBoundingClientRect(); return { wide: q('[data-testid="boring-decision-desk"]').className, strip: [Math.round(s.top), Math.round(s.bottom)], sendTop: Math.round(top), cardsStart: cards.filter(c => c.getBoundingClientRect().top < top - 40).length, cardsFull: cards.filter(c => c.getBoundingClientRect().bottom <= top).length }; });
  log[`narrow${w}`].errs = errs;
  await page.screenshot({ path: path.join(OUT, `r38-dark-${w}-lanes24.png`) }); await ctx.close();
}
async function seq(name, startUrl, steps) {
  resetBackend(); const { ctx, page, errs } = await open("dark", startUrl);
  const tr = [{ step: "load", url: await page.evaluate(() => location.search), h: await page.evaluate(() => window.__h.splice(0)) }];
  for (const [label, fn] of steps) { await fn(page); await page.waitForTimeout(700); tr.push({ step: label, url: await page.evaluate(() => location.search), desk: await page.locator(T("boring-decision-desk")).count(), crumb: await page.locator(".boring-topbar, header").first().innerText().catch(() => "").then(s => s.split("\n")[0]), sel: await page.evaluate(() => [...document.querySelectorAll('.boring-sidebar [aria-current="page"], .boring-sidebar .is-selected, .boring-sidebar .selected')].map(e => e.textContent.trim().slice(0, 30))), h: await page.evaluate(() => window.__h.splice(0)) }); }
  log[name] = { tr, errs }; await page.screenshot({ path: path.join(OUT, `r38-seq-${name}.png`) }); await ctx.close();
}
const needsRow = (p) => p.locator(".boring-sidebar").getByText("Review - Sonnet", { exact: false }).first().click();
const proj = (n) => (p) => p.locator(".boring-sidebar .boring-project-row", { hasText: n }).first().click();
await seq("landing-needs-back", "/?demo=", [["click needs-you", needsRow], ["back", (p) => p.goBack()], ["forward", (p) => p.goForward()], ["back again", (p) => p.goBack()], ["reload", (p) => p.reload()]]);
await seq("deeplink-agent", "/?demo=&agent=demo-hub-lead", [["back", (p) => p.goBack().catch(() => {})]]);
await seq("team-url", "/?demo=&team=vibesquad", [["reload on team", (p) => p.reload()], ["click Decisions", (p) => p.locator(T("boring-decisions-nav")).click()], ["back", (p) => p.goBack()], ["forward", (p) => p.goForward()], ["reload", (p) => p.reload()], ["back after reload", (p) => p.goBack()]]);
await seq("proj-a-b-back2", "/?demo=", [["proj Main", proj("Main Game Project")], ["proj Site", proj("Site")], ["back", (p) => p.goBack()], ["back", (p) => p.goBack()], ["forward", (p) => p.goForward()], ["reload", (p) => p.reload()]]);
await seq("ctrlj", "/?demo=", [["ctrl+j", (p) => p.keyboard.press("Control+j")], ["back", (p) => p.goBack()]]);
await seq("strip-line-click", "/?demo=", [["click strip Plugins", (p) => p.locator('[data-testid="boring-decision-strip-lane-vibesquad-plugins"]').click()], ["back", (p) => p.goBack()]]);
fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(log, null, 1));
await browser.close(); server.close();
