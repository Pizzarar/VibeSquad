// R44 pass 1: split open + Back/Forward onto a lane's empty card, then reload (idea-1099, c456f311).
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5991; const browser = await boot(PORT); const T = (id) => `[data-testid="${id}"]`;
const all = {}; const cfgs = process.env.CFG ? [JSON.parse(process.env.CFG)] : [["dark", 1920, 1080, 1], ["light", 1600, 900, 1]];
for (const [theme, w, h, dsf] of cfgs) {
  const name = `${theme}-${w}`; const out = []; all[name] = out;
  const S = async (...a) => { let r; try { r = await step(...a); } catch (e) { r = { label: a[1], error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify(r).slice(0, 800)); return r; };
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r44-${name}-${n}.png`), scale: "css" });
  // A) Runner Pilot: Brainstorm card -> Lead chat -> split + right agent -> Back (card) -> Forward -> Back -> reload -> Forward.
  let { page, ctx } = await open(browser, { port: PORT, theme, w, h, dsf, q: "?demo=&team=vibesquad&lane=runner-pilot" });
  out.push({ label: "A deep link card", ...(await state(page)) });
  await S(page, "A sidebar Runner Pilot (Lead chat)", () => page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`));
  await S(page, "A Split", () => page.click(T("boring-split-toggle")));
  const live = await page.$$eval('[data-testid^="boring-pp-open-"].live', (bs) => bs.map((b) => b.dataset.testid));
  out.push({ label: "A live picks", live: live.slice(0, 8) });
  await S(page, "A picker: live agent -> right pane", () => page.click(T(live.find((x) => !x.includes("runner-pilot")) || live[0])));
  if (w === 1920) await shot(page, "A-split-before-back");
  await S(page, "A Back (?lane=runner-pilot card)", () => page.goBack());
  if (w === 1920 || dsf > 1) await shot(page, "A-back-card");
  await S(page, "A Forward (Lead + split?)", () => page.goForward());
  if (w === 1920) await shot(page, "A-forward");
  await S(page, "A Back again", () => page.goBack());
  await S(page, "A reload on card", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  if (w === 1920) await shot(page, "A-reload-card");
  await S(page, "A Forward after reload", () => page.goForward());
  await S(page, "A Back after reload", () => page.goBack());
  out.push({ label: "errsA", errs: page.errs }); await ctx.close();
  // B) Bug Chaser (riff=1, no Lead): Lead card -> chip Brainstorm (agent) -> Split -> Back (?lane=&role=lead) -> Forward -> Back -> reload.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, dsf, q: "?demo=&riff=1&team=vibesquad&lane=bug-chaser&role=lead" }));
  out.push({ label: "B deep link Lead card", ...(await state(page)) });
  await S(page, "B card chip Brainstorm", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
  await S(page, "B Split", () => page.click(T("boring-split-toggle")));
  await S(page, "B Back (?lane=bug-chaser&role=lead, picker open)", () => page.goBack());
  if (w === 1920) await shot(page, "B-back-leadcard");
  await S(page, "B Forward", () => page.goForward());
  await S(page, "B Back", () => page.goBack());
  await S(page, "B reload on Lead card", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  await S(page, "B Forward after reload", () => page.goForward());
  out.push({ label: "errsB", errs: page.errs }); await ctx.close();
}
fs.writeFileSync(path.join(LOGS, process.env.CFG ? "pass1-3200.json" : "pass1.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
