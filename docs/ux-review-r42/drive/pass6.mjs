// R42 pass 6: candidate fixes injected in-page (no source edit): code-slot cap 63/64px, or chip padding 4px at 62px. Reports ellipsized codes + event truncation/min slack at 1920 and 3200@1.2, quiet fold open.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5972; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const P = 'html[data-vibe="boring"] .is-wide ';
const FIXES = { asBuilt: "", slot63: P + ".boring-decision-code-slot{max-width:63px}", slot64: P + ".boring-decision-code-slot{max-width:64px}", pad4: P + ".boring-decision-code{padding-inline:4px}" };
const log = {};
for (const [name, vp, dsf] of [["1920", { width: 1920, height: 1080 }, 1], ["3200", { width: 3200, height: 1800 }, 1.2]]) for (const [fk, css] of Object.entries(FIXES)) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: "dark" }); await ctx.addInitScript(prefsInit("dark"));
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`);
  await page.waitForSelector('[data-testid^="boring-decision-strip-quiet-"]', { timeout: 15000 });
  if (css) await page.addStyleTag({ content: css });
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
  log[`${name}-${fk}`] = await page.evaluate(() => {
    let ell = 0, n = 0, evTrunc = 0, minSlack = 1e9, lineH = new Set();
    for (const l of document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')) {
      lineH.add(Math.round(l.getBoundingClientRect().height));
      const c = l.querySelector(".boring-decision-code");
      if (c) { n++; const cs = getComputedStyle(c); const r = document.createRange(); r.selectNodeContents(c); const box = c.getBoundingClientRect().width - 2 * parseFloat(cs.paddingLeft) - 2 * parseFloat(cs.borderLeftWidth); if (r.getBoundingClientRect().width > box + 0.1) ell++; }
      const ev = l.querySelector(".boring-decision-strip-event"); const r = document.createRange(); r.selectNodeContents(ev); minSlack = Math.min(minSlack, ev.getBoundingClientRect().width - r.getBoundingClientRect().width);
      if ([...ev.querySelectorAll("span")].some(s => s.scrollWidth > s.clientWidth + 1)) evTrunc++;
    }
    return { chips: n, ellipsized: ell, evTrunc, minSlack: +minSlack.toFixed(1), lineH: [...lineH] };
  });
  if (name === "1920" && fk === "slot64") await page.locator('[data-testid="boring-decision-strip"]').screenshot({ path: path.join(OUT, "r42-dark-1920-candidate-slot64.png") });
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass6.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify(v));
await browser.close(); server.close();
