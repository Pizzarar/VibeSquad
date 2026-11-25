// R37 pass 2: lean semantics, Undo, off-screen strip, full page, Back/Forward vs landing.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend, state } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r37"); const LOGS = path.join(OUT, "logs");
const PORT = 5938; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const B = `http://127.0.0.1:${PORT}`;
async function open(theme, url = "/?demo=", big = false) {
  const ctx = await browser.newContext({ viewport: big ? { width: 3200, height: 1800 } : { width: 1920, height: 1080 }, deviceScaleFactor: big ? 1.2 : 1, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } addEventListener("popstate", () => window.__h.push("POP " + location.search)); })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
const log = {}; const T = (id) => `[data-testid="${id}"]`;
const sendTxt = (p) => p.locator(T("boring-decision-send-btn")).textContent();
const btnState = (p, id) => p.evaluate((id) => [...document.querySelectorAll(`[data-testid^="boring-decision-"][data-testid*="${id}"]`)].filter(e => e.tagName === "BUTTON").map(e => ({ tid: e.dataset.testid, t: e.textContent, pressed: e.getAttribute("aria-pressed"), cls: e.className, bg: getComputedStyle(e).backgroundColor, bc: getComputedStyle(e).borderColor })), id);
{
  resetBackend(); const { ctx, page, errs } = await open("dark");
  const id1 = "ny-00000000000000000001";
  log.initial = { send: await sendTxt(page), row1: await btnState(page, id1) };
  // click lean of row 1
  const lean = page.locator(`button[data-testid^="boring-decision-"][data-testid*="${id1}"]`).first();
  await lean.click(); await page.waitForTimeout(200);
  log.afterLeanClick = { send: await sendTxt(page), row1: await btnState(page, id1) };
  await page.locator(T("boring-decision-desk")).locator("button", { hasText: /^Use all leans/ }).click(); await page.waitForTimeout(200);
  log.afterUseAll = { send: await sendTxt(page), row1: await btnState(page, id1) };
  await page.locator(T(`boring-decision-not-${id1}`)).click(); await page.waitForTimeout(200);
  log.afterNot = { send: await sendTxt(page), row1: await btnState(page, id1) };
  await page.locator(T(`boring-decision-row-${id1}`)).scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(OUT, "r37-dark-1920-useall-then-not.png") });
  await page.locator(T("boring-decision-send-btn")).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "r37-dark-1920-undo.png") });
  log.undoMsg = await page.locator(T("boring-decision-undo-msg")).textContent().catch(() => null);
  await page.locator(T("boring-decision-undo-btn")).click(); await page.waitForTimeout(200);
  log.afterUndo = { send: await sendTxt(page), delivered: state.deliveredPrompts.length };
  // Full page scroll to offscreen strip
  const off = page.locator(T("boring-decision-offscreen")); await off.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "r37-dark-1920-offscreen.png") });
  log.offscreen = await off.innerText();
  log.scrollers = await page.evaluate(() => [...document.querySelectorAll("*")].filter(e => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)).map(e => e.className.toString().slice(0, 60) + " " + e.scrollHeight + "/" + e.clientHeight));
  log.errs1 = errs; await ctx.close();
}
// Back/Forward sequences
async function seq(name, startUrl, steps) {
  resetBackend(); const { ctx, page, errs } = await open("dark", startUrl);
  const tr = [{ step: "load", url: await page.evaluate(() => location.search), h: await page.evaluate(() => window.__h.splice(0)) }];
  for (const [label, fn] of steps) { await fn(page); await page.waitForTimeout(700); tr.push({ step: label, url: await page.evaluate(() => location.search), desk: await page.locator(T("boring-decision-desk")).count(), crumb: await page.locator(".boring-topbar, header").first().innerText().catch(() => "").then(s => s.split("\n")[0]), h: await page.evaluate(() => window.__h.splice(0)) }); }
  log[name] = { tr, errs }; await page.screenshot({ path: path.join(OUT, `r37-seq-${name}.png`) }); await ctx.close();
}
const needsRow = (p) => p.locator(".boring-sidebar").getByText("Review - Sonnet", { exact: false }).first().click();
const proj = (n) => (p) => p.locator(".boring-sidebar .boring-project-row", { hasText: n }).first().click();
await seq("landing-needs-back", "/?demo=", [["click needs-you", needsRow], ["back", (p) => p.goBack()], ["forward", (p) => p.goForward()], ["back again", (p) => p.goBack()]]);
await seq("deeplink-agent", "/?demo=&agent=demo-hub-lead", [["back", (p) => p.goBack().catch(() => {})]]);
await seq("team-url", "/?demo=&team=vibesquad", [["click Decisions", (p) => p.locator(T("boring-decisions-nav")).click()], ["back", (p) => p.goBack()], ["forward", (p) => p.goForward()], ["reload", (p) => p.reload()]]);
await seq("proj-a-b-back2", "/?demo=", [["proj Main", proj("Main Game Project")], ["proj Site", proj("Site")], ["back", (p) => p.goBack()], ["back", (p) => p.goBack()], ["back", (p) => p.goBack().catch(() => {})]]);
await seq("ctrlj", "/?demo=", [["ctrl+j", (p) => p.keyboard.press("Control+j")], ["back", (p) => p.goBack()]]);
await seq("ctrlk-decisions", "/?demo=&team=vibesquad", [["ctrl+k", async (p) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(300); await p.keyboard.type("decision"); await p.waitForTimeout(300); }]]);
fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1).slice(0, 9000));
await browser.close(); server.close();
