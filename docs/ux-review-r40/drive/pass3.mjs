// R40 pass 3: rail-mode column alignment (state + event column left edges per strip line) at 1920 and 3200@1.2, built tip.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5969; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const log = {};
for (const [name, vp, dsf] of [["1920", { width: 1920, height: 1080 }, 1], ["3200", { width: 3200, height: 1800 }, 1.2]]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: "dark" }); await ctx.addInitScript(prefsInit("dark"));
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`); await page.waitForTimeout(1800);
  log[name] = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')].map(l => {
      const x = (c) => { const e = l.querySelector(c); return e ? Math.round(e.getBoundingClientRect().left) : null; };
      return { name: l.querySelector(".boring-decision-strip-lane-name")?.textContent, state: x(".boring-decision-strip-state"), event: x(".boring-decision-strip-event") };
    });
    const spread = (k) => { const v = rows.map(r => r[k]).filter(n => n != null); return Math.max(...v) - Math.min(...v); };
    return { cols: getComputedStyle(document.querySelector(".boring-decision-strip-line")).gridTemplateColumns, stateSpreadPx: spread("state"), eventSpreadPx: spread("event"), rows };
  });
  if (name === "3200") await page.locator('[data-testid="boring-decision-strip"]').screenshot({ path: path.join(OUT, "r40-dark-3200-rail-strip.png") });
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass3.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, v.cols, "stateSpread", v.stateSpreadPx, "eventSpread", v.eventSpreadPx, JSON.stringify(v.rows));
await browser.close(); server.close();
