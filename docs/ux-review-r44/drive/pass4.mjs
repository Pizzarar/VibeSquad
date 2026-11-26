// R44 pass 4: reload on an empty card with a real split: lane card (?lane=) vs Desk slot card (?slot=) vs ?agent= control. Plus R43 m2 (Bugs Lead, no Bugs lane).
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5994; const browser = await boot(PORT); const T = (id) => `[data-testid="${id}"]`;
const out = [];
const panes = (page) => page.evaluate(() => { const p = JSON.parse(localStorage.getItem("vs.panes.v1") || "{}"); return `split=${p.split} L=${p.leftActiveId} R=${p.rightActiveId} rightTabs=${(p.rightTabs || []).join(",")} active=${p.activePane}`; }).catch(() => "?");
const S = async (page, label, fn, wait) => { let r; try { r = await step(page, label, fn, wait); r.panes = await panes(page); } catch (e) { r = { label, error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify({ label: r.label, url: r.url, crumb: r.crumb, sel: r.selected, empty: r.empty, split: r.split, right: r.right?.slice(0, 30), panes: r.panes, h: r.h, error: r.error })); return r; };
const leftDown = (page) => page.locator(`${T("boring-pane-left")} .boring-agent-header`).first().click({ position: { x: 300, y: 10 } });
async function setup(q) {
  const o = await open(browser, { port: PORT, q });
  await S(o.page, "Split", () => o.page.click(T("boring-split-toggle")));
  await S(o.page, "picker Plugins Lead -> right", () => o.page.click(T("boring-pp-open-plugins-lead")));
  await S(o.page, "activate left", () => leftDown(o.page));
  return o;
}
for (const [name, enter] of [
  ["LANE", (p) => p.click(T("boring-top-brainstorm"))], // Runner Pilot: no Brainstorm -> ?lane=runner-pilot (no fold: no live Buddy)
  ["SLOT", async (p) => { if (!(await p.$(T("boring-project-lanes-efi")))) { await p.click(T("boring-project-toggle-efi")); await p.waitForTimeout(300); } await p.locator(`${T("boring-project-lanes-efi")} [data-testid^="boring-core-overlord"]`).click(); }],
  ["AGENT", (p) => p.click(`${T("boring-conv-wiki")} .boring-conv-title`)],
]) {
  out.push({ label: `== ${name}` }); console.log("==", name);
  const { page, ctx } = await setup("?demo=&team=vibesquad&agent=demo-lead-runner");
  await S(page, `${name} enter`, () => enter(page));
  await S(page, `${name} reload`, () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  await S(page, `${name} Back (Runner Pilot Lead; right pane?)`, () => page.goBack());
  out.push({ label: `errs ${name}`, errs: page.errs }); await ctx.close();
}
// R43 m2: ?slot=bugs&role=lead with no Bugs lane (efi, vibesquad): cold load, reload, and Back onto a role=lead entry.
for (const q of ["?demo=&team=efi&slot=bugs&role=lead", "?demo=&team=vibesquad&slot=bugs&role=lead", "?demo=&riff=1&team=vibesquad&slot=bugs&role=lead"]) {
  const { page, ctx } = await open(browser, { port: PORT, q });
  out.push({ label: `cold ${q}`, ...(await state(page)) }); console.log("cold", q, JSON.stringify(await state(page)));
  await S(page, "reload", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  await S(page, "inject role=lead entry then Back onto it", async () => { await page.evaluate((u) => { history.pushState(null, "", u); history.pushState(null, "", u.replace(/slot=bugs&role=lead/, "slot=overlord")); dispatchEvent(new PopStateEvent("popstate")); }, q); await page.waitForTimeout(500); await page.goBack(); });
  if (q.includes("efi")) await page.screenshot({ path: path.join(OUT, "r44-dark-1920-bugs-lead-nolane.png"), scale: "css" });
  out.push({ label: "errs", errs: page.errs }); await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass4.json"), JSON.stringify(out, null, 1));
await browser.close(); server.close();
