// R49 pass3: every ?demo card — question, Show source presence, excerpt text (to judge idea-1150 redundancy), hint texts.
import * as C from "./common.mjs";
import path from "node:path";
import { writeFileSync } from "node:fs";
const out = {};
await C.start();
for (const cfg of [C.CFGS[0], C.CFGS[3]]) {
  const { page, errs, context } = await C.open(cfg);
  await page.waitForSelector('[data-testid^="boring-decision-card-"]', { timeout: 20000 }); await page.waitForTimeout(500);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="boring-decision-card-"]')].map((c) => c.dataset.testid.replace("boring-decision-card-", "")));
  const cards = [];
  for (const id of ids) {
    const tog = page.locator(`[data-testid="boring-decision-source-toggle-${id}"]`);
    const has = (await tog.count()) > 0;
    if (has) { await tog.click(); await page.waitForTimeout(100); }
    cards.push(await page.evaluate(({ id, has }) => {
      const c = document.querySelector(`[data-testid="boring-decision-card-${id}"]`);
      const src = document.getElementById(`boring-decision-source-body-${id}`);
      return { id: id.slice(-2), hasToggle: has, text: c.innerText.replace(src?.innerText ?? "\u0000", "").replace(/\n+/g, " ⏎ ").slice(0, 400), source: src?.innerText ?? null };
    }, { id, has }));
    if (has) await tog.click();
  }
  out[cfg.name] = { cards, errs };
  await context.close();
}
await C.stop();
writeFileSync(path.join(C.SHOTS, "logs", "pass3.json"), JSON.stringify(out, null, 1));
console.log("ok");
