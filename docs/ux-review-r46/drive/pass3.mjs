import { start, stop, openDesk, CFGS, SHOTS, state, resetBackend } from "./common.mjs";
import { writeFileSync } from "node:fs";
await start();
const out = {};
for (const cfg of CFGS) {
  resetBackend();
  state.items = state.items.filter((i) => ["forework", "sbb"].includes(i.squad));
  const { context, page, errs } = await openDesk(cfg);
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.textContent,
    summary: document.querySelector('[data-testid="boring-decision-summary"]')?.textContent,
    empty: document.querySelector(".boring-decision-desk")?.innerText.slice(0, 400).replace(/\n/g, " | "),
  }));
  out[cfg.name + "-pre"] = s;
  await page.screenshot({ path: `${SHOTS}/r46-${cfg.name}-onhold-only.png`, scale: "css", clip: { x: 0, y: 0, width: 1920, height: 400 } });
  await page.locator('[data-testid="boring-decision-empty-show-all"]').click(); await page.waitForTimeout(300);
  const s2 = await page.evaluate(() => ({ nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.textContent, summary: document.querySelector('[data-testid="boring-decision-summary"]')?.textContent, ls: localStorage.getItem("vs.decisionFilterOverrides"), pressed: [...document.querySelectorAll('[data-testid^="boring-decision-pill"],[data-testid^="boring-decision-preset"]')].map((e) => e.dataset.testid.slice(16) + "=" + e.getAttribute("aria-pressed")).join(" ") }));
  out[cfg.name + "-afterShowAll"] = s2;
  await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(1200);
  out[cfg.name + "-afterReload"] = await page.evaluate(() => ({ nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.textContent, summary: document.querySelector('[data-testid="boring-decision-summary"]')?.textContent }));
  await page.locator('[data-testid="boring-decision-preset-active"]').click(); await page.waitForTimeout(300);
  // navigate away to a project: badge must stay filtered off the Decisions page
  await page.locator('[data-testid^="boring-project-"]').first().click().catch(() => {});
  await page.waitForTimeout(600);
  out[cfg.name + "-awayFromDesk"] = await page.evaluate(() => ({ nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.textContent, deskMounted: !!document.querySelector(".boring-decision-desk") }));
  // also navigate away to an agent and back: is nav badge the only cue?
  out[cfg.name] = { ...s, errs: errs.filter((e) => !e.includes("404")) };
  await context.close();
}
writeFileSync(SHOTS + "/logs/pass3.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await stop();
