// R52 pass1 (idea-1081): rail chips at ?lanes=24, quiet fold open: 8-char codes vs content box (Range width), long-slug ellipsis + title, event slack/truncation. 4 configs + 1600.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock42.mjs";
import { REPO_ROOT, findBrowser, resolvePlaywright } from "../../../scripts/ui-overlap/env.mjs";
const OUT = path.join(REPO_ROOT, "docs/ux-review-r52"); const PORT = 5972;
await startServer(path.join(REPO_ROOT, "dist"), PORT);
const browser = await resolvePlaywright().chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const prefs = (t) => `try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vs.prefs.v1", JSON.stringify({"app.theme":"${t}"})); }catch{}`;
const log = {};
for (const [name, theme, vp, dsf] of [["dark-1920", "dark", { width: 1920, height: 1080 }, 1], ["light-1920", "light", { width: 1920, height: 1080 }, 1], ["dark-3200", "dark", { width: 3200, height: 1800 }, 1.2], ["light-3200", "light", { width: 3200, height: 1800 }, 1.2], ["dark-1600", "dark", { width: 1600, height: 1000 }, 1]]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme }); await ctx.addInitScript(prefs(theme));
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`);
  await page.waitForSelector('[data-testid^="boring-decision-strip-quiet-"]', { timeout: 15000 });
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
  log[name] = await page.evaluate(() => {
    const out = { wide: !!document.querySelector(".boring-decision-desk.is-wide"), chips: [], events: [] };
    for (const l of document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')) {
      const c = l.querySelector(".boring-decision-code");
      if (c) { const cs = getComputedStyle(c); const r = document.createRange(); r.selectNodeContents(c); const need = r.getBoundingClientRect().width; const box = c.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
        out.chips.push({ code: c.textContent, need: +need.toFixed(1), box: +box.toFixed(1), ellipsized: need > box + 0.1, textOverflow: cs.textOverflow, pad: cs.paddingLeft, title: c.title }); }
      const ev = l.querySelector(".boring-decision-strip-event"); if (!ev) continue; const r = document.createRange(); r.selectNodeContents(ev);
      out.events.push({ lane: l.querySelector(".boring-decision-strip-lane-name")?.textContent, text: ev.textContent, colW: Math.round(ev.clientWidth), textW: Math.round(r.getBoundingClientRect().width), slack: Math.round(ev.clientWidth - r.getBoundingClientRect().width), lineH: Math.round(l.getBoundingClientRect().height) });
    }
    const uniq = new Map(out.chips.map(c => [c.code, c])); out.chips = [...uniq.values()];
    out.ellipsized = out.chips.filter(c => c.ellipsized).map(c => `${c.code} (title=${c.title || "∅"})`);
    out.eightChar = out.chips.filter(c => c.code.length === 8).map(c => `${c.code} ${c.need}/${c.box}`);
    out.truncatedEvents = out.events.filter(e => e.slack < 0); out.minSlack = Math.min(...out.events.map(e => e.slack));
    out.desk = out.events.filter(e => /desk/i.test(e.lane || "")); out.lineHeights = [...new Set(out.events.map(e => e.lineH))];
    delete out.chips; delete out.events; return out;
  });
  log[name].errs = errs;
  const strip = page.locator('[data-testid="boring-decision-strip"]');
  await strip.screenshot({ path: path.join(OUT, `r52-${name}-rail.png`) });
  if (name === "dark-3200") { await page.locator('.boring-decision-code', { hasText: "@art-dir" }).first().hover(); await page.waitForTimeout(200); log.hoverTitle = await page.evaluate(() => document.querySelector(".boring-decision-code:hover")?.title); }
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, "logs/pass1.json"), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1));
await browser.close(); server.close();
