// R44 explore 2: what each sidebar lane row opens (find lanes whose row lands on an empty card).
import { boot, open, state, server } from "./lib.mjs";
const browser = await boot(5982);
for (const q of ["?demo=", "?demo=&riff=1"]) {
  const { page, ctx } = await open(browser, { port: 5982, q });
  for (const p of ["vibesquad", "efi", "site"]) if (!(await page.$(`[data-testid="boring-project-lanes-${p}"]`))) { await page.click(`[data-testid="boring-project-toggle-${p}"]`).catch(() => {}); await page.waitForTimeout(250); }
  const ids = await page.$$eval('.boring-sidebar [data-testid^="boring-conv-"]:not([data-testid^="boring-conv-toggle"])', (es) => es.map((e) => e.dataset.testid));
  for (const id of ids) { const t = page.locator(`[data-testid="${id}"] .boring-conv-title`).first(); if (!(await t.count())) continue; await t.click().catch(() => {}); await page.waitForTimeout(500); const s = await state(page); console.log(q, id, "->", s.url, "|", s.crumb, "| empty", s.empty, "|", s.head?.slice(0, 50)); }
  await ctx.close();
}
await browser.close(); server.close();
