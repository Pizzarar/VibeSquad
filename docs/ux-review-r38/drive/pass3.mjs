// R38 pass 3: valid ?agent= deep link, fresh load of ?view=decisions (URL flash), selected-row count on Desk vs project.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r38"); const LOGS = path.join(OUT, "logs");
const PORT = 5949; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const log = {};
async function load(name, url, after) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  await ctx.addInitScript(`(() => { window.__h = []; for (const k of ["pushState","replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k+" "+a[2]); return o(...a); }; } })()`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}${url}`); await page.waitForTimeout(1500);
  if (after) { await after(page); await page.waitForTimeout(800); }
  log[name] = { errs, ...(await page.evaluate(() => ({ url: location.search, h: window.__h, desk: !!document.querySelector('[data-testid="boring-decision-desk"]'),
    crumb: document.querySelector(".boring-topbar")?.innerText.split("\n")[0],
    hl: [...document.querySelectorAll(".boring-sidebar *")].filter(e => /(^|\s)(on|active|selected|is-selected|is-active)(\s|$)/.test(e.className || "") || e.getAttribute("aria-current")).map(e => (e.className || "").toString().slice(0, 40) + " :: " + e.textContent.trim().slice(0, 30)) }))) };
  if (name === "deeplink") await page.screenshot({ path: path.join(OUT, "r38-dark-1920-deeplink-agent.png") });
  await ctx.close();
}
await load("fresh-view-decisions", "/?demo=&view=decisions");
await load("deeplink", "/?demo=&team=vibesquad&agent=demo-rev");
await load("deeplink-noteam", "/?demo=&agent=demo-rev");
await load("desk-selection", "/?demo=");
await load("project-selection", "/?demo=", (p) => p.locator(".boring-sidebar .boring-project-row", { hasText: "Site" }).first().click());
fs.writeFileSync(path.join(LOGS, "pass3.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify(v));
await browser.close(); server.close();
