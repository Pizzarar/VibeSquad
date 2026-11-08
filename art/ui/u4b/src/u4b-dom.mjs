// Prints the class tree of the chat view (depth-limited) to find selectors.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || join(homedir(), "projects/VibeSquad/scratch/pw/node_modules/playwright-core"));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const tok = readFileSync(join(homedir(), ".vibesquad/local-token"), "utf8").trim();
const ctx = await browser.newContext({ extraHTTPHeaders: { "x-vibesquad-token": tok }, viewport: { width: 3072, height: 1728 }, colorScheme: "dark" });
await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
const page = await ctx.newPage();
await page.goto(process.argv[2]);
await page.waitForTimeout(5000);
await page.locator(".sidebar >> text=Art Direction").first().click(); await page.waitForTimeout(500);
console.log(await page.evaluate(() => [...document.querySelectorAll(".sidebar-inbox-badge")].map(e => e.outerHTML.slice(0,160) + " | " + getComputedStyle(e).color + " | " + getComputedStyle(e).backgroundColor)));
await page.waitForTimeout(4000);
console.log(await page.evaluate((sel) => {
  const out = [];
  const walk = (e, d) => { if (d > +sel.depth) return; out.push("  ".repeat(d) + e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "")); for (const c of e.children) walk(c, d + 1); };
  for (const s of sel.roots) { const e = document.querySelector(s); if (e) walk(e, 0); }
  return out.slice(0, 260).join("\n");
}, { depth: 5, roots: [".sidebar"] }));
await browser.close();
