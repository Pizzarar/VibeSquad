// U4b real-app shots: 3200x1800 CSS viewport at deviceScaleFactor 1.2 = 3840x2160 px at 120% zoom.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("C:/Users/Fugma/projects/VibeSquad/scratch/pw/node_modules/playwright-core");
const [,, url, out, theme, click] = process.argv;
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
import { readFileSync } from "node:fs";
const tok = readFileSync("C:/Users/Fugma/.vibesquad/local-token", "utf8").trim();
const ctx = await browser.newContext({ extraHTTPHeaders: { "x-vibesquad-token": tok }, viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
const page = await ctx.newPage();
await page.goto(url);
await page.waitForTimeout(6000);
await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
if (click) { for (const c of click.split("|")) { await page.locator(c).first().click(); await page.waitForTimeout(2500); } }
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => [document.title, location.href, document.querySelectorAll("select").length, [...document.querySelectorAll("button")].length]));
await page.screenshot({ path: out });
await browser.close();
