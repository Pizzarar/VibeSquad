// R42 pass 5: exact chip ellipsis (Range width vs content box), chip padding, and event slack per line at 1920 and 3200@1.2 dark, quiet fold open.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5971; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const log = {};
for (const [name, vp, dsf] of [["1920", { width: 1920, height: 1080 }, 1], ["3200", { width: 3200, height: 1800 }, 1.2]]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: "dark" }); await ctx.addInitScript(prefsInit("dark"));
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`);
  await page.waitForSelector('[data-testid^="boring-decision-strip-quiet-"]', { timeout: 15000 });
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
  log[name] = await page.evaluate(() => {
    const out = { chips: [], eventSlack: [] };
    for (const l of document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')) {
      const c = l.querySelector(".boring-decision-code");
      if (c) { const cs = getComputedStyle(c); const r = document.createRange(); r.selectNodeContents(c); const need = r.getBoundingClientRect().width; const box = c.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
        out.chips.push({ code: c.textContent, need: +need.toFixed(1), box: +box.toFixed(1), ellipsized: need > box + 0.1, pad: cs.paddingLeft + "/" + cs.paddingRight, font: cs.fontSize + " " + cs.fontFamily.split(",")[0], title: c.title }); }
      const ev = l.querySelector(".boring-decision-strip-event"); const r = document.createRange(); r.selectNodeContents(ev);
      out.eventSlack.push({ lane: l.querySelector(".boring-decision-strip-lane-name").textContent, colW: Math.round(ev.clientWidth), textW: Math.round(r.getBoundingClientRect().width), slack: Math.round(ev.clientWidth - r.getBoundingClientRect().width) });
    }
    const uniq = new Map(out.chips.map(c => [c.code, c])); out.chips = [...uniq.values()];
    out.ellipsized = out.chips.filter(c => c.ellipsized).map(c => c.code); out.minSlack = Math.min(...out.eventSlack.map(e => e.slack)); out.minSlackLane = out.eventSlack.find(e => e.slack === out.minSlack)?.lane; delete out.eventSlack; return out;
  });
  if (name === "3200") { await page.locator('.boring-decision-code', { hasText: "@plugins" }).first().hover(); await page.waitForTimeout(200); log.hoverTitle = await page.evaluate(() => document.querySelector(".boring-decision-code:hover")?.title); }
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass5.json"), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1));
await browser.close(); server.close();
