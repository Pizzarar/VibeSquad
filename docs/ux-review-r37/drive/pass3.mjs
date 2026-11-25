// R37 pass 3: strip pitch + font sizes + contrast, valid ?agent= deep link, strip line click, light 3200 shot.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright(); const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r37");
const PORT = 5939; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const out = {};
for (const theme of ["dark", "light"]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vs.prefs.v1", JSON.stringify({"app.theme":"${theme}"})); }catch{}`);
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=`); await page.waitForTimeout(1500);
  out[theme] = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".boring-decision-strip-line")].map(e => e.getBoundingClientRect());
    const pitch = lines.slice(1).map((r, i) => Math.round(r.y - lines[i].y));
    const strip = document.querySelector('[data-testid="boring-decision-strip"]').getBoundingClientRect();
    const sample = {};
    for (const sel of [".boring-decision-strip-state", ".boring-decision-strip-event", ".boring-decision-strip-lane-name", ".boring-decision-row-ask, .boring-decision-ask", ".boring-decision-choice", "[class*=decision][class*=age]", "[class*=decision][class*=handle], [class*=decision] code", "[class*=decision-decides]"]) {
      const e = document.querySelector(sel); if (!e) { sample[sel] = null; continue; }
      const cs = getComputedStyle(e); sample[sel] = { cls: e.className, fs: cs.fontSize, color: cs.color, t: e.textContent.slice(0, 30) };
    }
    const firstRow = document.querySelector('[data-testid^="boring-decision-row-"]')?.getBoundingClientRect();
    return { pitch, stripH: Math.round(strip.height), stripTop: Math.round(strip.top), firstRowTop: Math.round(firstRow?.top), vh: innerHeight, mainW: document.querySelector(".boring-main, main")?.getBoundingClientRect().width, sample };
  });
  await page.screenshot({ path: path.join(OUT, `r37-${theme}-3200-crop.png`), clip: { x: 1370, y: 60, width: 840, height: 520 } });
  // strip line click
  await page.locator(".boring-decision-strip-line").nth(1).click(); await page.waitForTimeout(600);
  out[theme].stripClick = await page.evaluate(() => location.search);
  await ctx.close();
}
{ // valid deep link
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(`localStorage.setItem("vs.vibePicked","1")`);
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=&team=vibesquad&agent=demo-rev`); await page.waitForTimeout(1500);
  out.deeplink = { url: await page.evaluate(() => location.search), desk: await page.locator('[data-testid="boring-decision-desk"]').count() };
  await page.screenshot({ path: path.join(OUT, "r37-dark-1920-deeplink-agent.png") });
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1)); fs.writeFileSync(path.join(OUT, "logs/pass3.json"), JSON.stringify(out, null, 1));
await browser.close(); server.close();
