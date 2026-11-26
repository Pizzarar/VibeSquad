import { start, stop, openDesk, CFGS, SHOTS, state } from "./common.mjs";
import { writeFileSync } from "node:fs";
await start();
const out = {};
for (const cfg of [CFGS[0], CFGS[3]]) {
  state.items = state.items.filter((i) => ["forework", "sbb"].includes(i.squad));
  const { context, page, errs } = await openDesk(cfg);
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.textContent,
    summary: document.querySelector('[data-testid="boring-decision-summary"]')?.textContent,
    empty: document.querySelector(".boring-decision-desk")?.innerText.slice(0, 400).replace(/\n/g, " | "),
  }));
  // also navigate away to an agent and back: is nav badge the only cue?
  await page.screenshot({ path: `${SHOTS}/r45-${cfg.name}-onhold-only.png`, scale: "css", clip: { x: 0, y: 0, width: 1920, height: 400 } });
  out[cfg.name] = { ...s, errs: errs.filter((e) => !e.includes("404")) };
  await context.close();
}
writeFileSync(SHOTS + "/logs/pass3.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await stop();
