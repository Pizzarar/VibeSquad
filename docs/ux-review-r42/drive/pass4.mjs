// R42 pass 4: dot/name overlap, code-chip wrap/ellipsis/title and line heights in rail mode (1920, 3200@1.2, dark+light), quiet fold closed and open.
import path from "node:path"; import fs from "node:fs";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
const PORT = 5970; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const m = () => [...document.querySelectorAll('[data-testid="boring-decision-strip"] .boring-decision-strip-line')].map(l => {
  const R = (c) => l.querySelector(c).getBoundingClientRect(); const d = R(".boring-decision-dot"), n = R(".boring-decision-strip-lane-name"), st = R(".boring-decision-strip-state"), ev = R(".boring-decision-strip-event");
  const code = l.querySelector(".boring-decision-code"); const cr = code?.getBoundingClientRect();
  return { name: l.querySelector(".boring-decision-strip-lane-name").textContent, dotR: Math.round(d.right), nameL: Math.round(n.left), overlapPx: Math.round(d.right - n.left), lineH: Math.round(l.getBoundingClientRect().height), codeH: cr ? Math.round(cr.height) : null, codeClip: code ? code.scrollWidth > code.parentElement.clientWidth + 1 : null, codeEll: code ? code.scrollWidth > code.clientWidth + 1 : null, codeTitle: code ? code.title === code.textContent : null, codeText: code?.textContent, codeW: cr ? Math.round(cr.width) : null, codeOverStL: cr ? Math.round(cr.right - st.left) : null, nameTrunc: l.querySelector(".boring-decision-strip-lane-name").scrollWidth > l.querySelector(".boring-decision-strip-lane-name").clientWidth + 1, stL: Math.round(st.left), evL: Math.round(ev.left), evTrunc: [...l.querySelectorAll(".boring-decision-strip-event span")].some(s => s.scrollWidth > s.clientWidth + 1) };
});
const sum = (rows) => ({ n: rows.length, overlapping: rows.filter(r => r.overlapPx > 0).length, maxOverlap: Math.max(...rows.map(r => r.overlapPx)), lineH: [...new Set(rows.map(r => r.lineH))], codeWrapped: rows.filter(r => r.codeH > 24).map(r => r.name), codeClipped: rows.filter(r => r.codeClip).map(r => r.name), codeEllipsized: rows.filter(r => r.codeEll).map(r => r.codeText), codeNoTitle: rows.filter(r => r.codeTitle === false).map(r => r.name), codeMaxW: Math.max(...rows.map(r => r.codeW || 0)), codeIntoState: rows.filter(r => r.codeOverStL > 0).length, nameTrunc: rows.filter(r => r.nameTrunc).map(r => r.name), stSpread: Math.max(...rows.map(r => r.stL)) - Math.min(...rows.map(r => r.stL)), evSpread: Math.max(...rows.map(r => r.evL)) - Math.min(...rows.map(r => r.evL)), evTrunc: rows.filter(r => r.evTrunc).map(r => r.name) });
const log = {};
for (const [name, vp, dsf] of [["1920", { width: 1920, height: 1080 }, 1], ["3200", { width: 3200, height: 1800 }, 1.2]]) for (const theme of ["dark", "light"]) {
  resetBackend();
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, colorScheme: theme }); await ctx.addInitScript(prefsInit(theme));
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/?demo=&view=decisions&lanes=24`); await page.waitForTimeout(1800);
  const k = `${theme}-${name}`;
  log[k] = { closed: sum(await page.evaluate(m)) };
  await page.locator('[data-testid^="boring-decision-strip-quiet-"]').first().click(); await page.waitForTimeout(300);
  log[k].quietOpen = sum(await page.evaluate(m));
  if (theme === "dark") log[`rows${name}`] = (await page.evaluate(m)).slice(0, 6);
  await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass4.json"), JSON.stringify(log, null, 1));
for (const [k, v] of Object.entries(log)) console.log(k, JSON.stringify(v));
await browser.close(); server.close();
