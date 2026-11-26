// R43 pass 3: Desk slots (?slot=) on Main Game (no Overlord/RiffBot), and the split picker's right-pane lane card (must write no URL).
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5977; const browser = await boot(PORT);
const T = (id) => `[data-testid="${id}"]`;
const all = {};
for (const [theme, w, h] of [["dark", 1920, 1080], ["light", 1600, 900]]) {
  const name = `${theme}-${w}`; const out = []; all[name] = out;
  const S = async (...a) => { let r; try { r = await step(...a); } catch (e) { r = { label: a[1], error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify(r).slice(0, 700)); return r; };
  let { page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&team=vibesquad&lane=runner-pilot" });
  if (!(await page.$(T("boring-project-lanes-efi")))) { await page.click(T("boring-project-toggle-efi")); await page.waitForTimeout(400); }
  await S(page, "efi Overlord slot (no agent)", () => page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-overlord")}`).click());
  await S(page, "efi RiffBot slot", () => page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-riffbot")}`).click());
  await S(page, "efi Bugs slot", () => page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-bugs")}`).click());
  await S(page, "Back (RiffBot)", () => page.goBack());
  await S(page, "Back (Overlord)", () => page.goBack());
  await S(page, "Back (runner-pilot card)", () => page.goBack());
  await S(page, "Forward (Overlord)", () => page.goForward());
  await S(page, "reload (Overlord)", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  out.push({ label: "errs", errs: page.errs }); await ctx.close();
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=" }));
  await S(page, "open Runner Pilot Lead (sidebar)", async () => { await page.click(T("boring-project-toggle-vibesquad")).catch(() => {}); await page.waitForTimeout(300); await page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`); });
  await S(page, "Split", () => page.click(T("boring-split-toggle")));
  await S(page, "picker: Runner Pilot Buddy (not running)", () => page.click(T("boring-pp-open-runner-pilot-brainstorm")));
  const right = await page.$eval(T("boring-pane-right"), (e) => e.innerText.replace(/\n/g, " / ").slice(0, 300)).catch(() => null);
  out.push({ label: "right pane", right }); console.log("right:", right);
  if (w === 1920) await page.screenshot({ path: path.join(OUT, `r43-${name}-split-rightcard.png`) });
  await S(page, "picker back ← All lanes", () => page.click(T("boring-pp-back")));
  await S(page, "Close split", () => page.click(T("boring-split-close")));
  await S(page, "Back (pre-split: Desk)", () => page.goBack());
  out.push({ label: "errs2", errs: page.errs }); await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass3.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
