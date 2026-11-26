// R44 explore: which sidebar rows lead to a lane's empty card (lane children, riff=1 and default demo).
import { boot, open, state, server } from "./lib.mjs";
const browser = await boot(5981);
for (const q of ["?demo=&team=vibesquad&agent=demo-lead-runner", "?demo=&riff=1&team=vibesquad&agent=demo-bugs"]) {
  const { page, ctx } = await open(browser, { port: 5981, q });
  for (const l of ["runner-pilot", "bug-chaser", "plugins", "wiki"]) await page.click(`[data-testid="boring-conv-toggle-${l}"]`).catch(() => {});
  await page.waitForTimeout(400);
  console.log(q, "\n" + (await page.$$eval('.boring-sidebar [data-testid^="boring-lead-"], .boring-sidebar [data-testid^="boring-brainstorm-"], .boring-sidebar [data-testid*="role"], .boring-sidebar [data-testid^="boring-conv-"]', (es) => es.filter(e => e.offsetParent).map((e) => e.dataset.testid + " | " + e.innerText.replace(/\n/g, " / ").slice(0, 60)).join("\n"))));
  await ctx.close();
}
await browser.close(); server.close();
