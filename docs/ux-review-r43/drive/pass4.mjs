// R43 pass 4: deep-link edge cases: unknown lane, lane of another project, Bugs slot role=lead, 3200x1800@1.2 card.
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5979; const browser = await boot(PORT); const out = [];
for (const q of ["?demo=&team=vibesquad&lane=nope", "?demo=&team=efi&lane=runner-pilot", "?demo=&team=vibesquad&lane=runner-pilot&role=lead", "?demo=&team=efi&slot=bugs&role=lead", "?demo=&team=vibesquad&lane=vibesquad"]) {
  const { page, ctx } = await open(browser, { port: PORT, q }); const s = await state(page); out.push({ q, ...s, errs: page.errs }); console.log(q, JSON.stringify(s)); await ctx.close();
}
const { page, ctx } = await open(browser, { port: PORT, w: 3200, h: 1800, dsf: 1.2, q: "?demo=&team=vibesquad&lane=runner-pilot" });
out.push({ q: "3200", ...(await state(page)) }); await page.screenshot({ path: path.join(OUT, "r43-dark-3200-A-card.png"), scale: "css" }); await ctx.close();
fs.writeFileSync(path.join(LOGS, "pass4.json"), JSON.stringify(out, null, 1));
await browser.close(); server.close();
