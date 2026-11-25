// R24 probe: record every breadcrumb/URL the user could see during a Back/Forward (rAF sampling)
import { open } from "./lib.mjs";
const port = +process.argv[2];
const { browser, page } = await open(port, { w: 1920, h: 1080, theme: "dark" }, "?demo=&team=vibesquad");
const aud = () => page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
const sample = (fn) => page.evaluate(async (f) => {
  const seen = []; const t = () => (document.querySelector(".boring-crumb-seg")?.parentElement?.textContent || "").replace(/\s+/g, " ").trim();
  let stop = false; const tick = () => { const s = t() + " @ " + location.search; if (seen.at(-1) !== s) seen.push(s); if (!stop) requestAnimationFrame(tick); }; tick();
  history[f](); await new Promise(r => setTimeout(r, 800)); stop = true; return seen;
}, fn);
await aud(); await page.waitForTimeout(600);
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await page.waitForTimeout(600);
console.log("f3 back :", (await sample("back")).join("  ->  "));
console.log("f3 fwd  :", (await sample("forward")).join("  ->  "));
await aud(); await page.waitForTimeout(600);
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI Lab"); await page.waitForTimeout(400); await page.keyboard.press("Enter"); await page.waitForTimeout(700);
console.log("f2 back :", (await sample("back")).join("  ->  "));
console.log("f2 fwd  :", (await sample("forward")).join("  ->  "));
await browser.close();
