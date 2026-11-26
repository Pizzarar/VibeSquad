// R43 pass 2: how users reach the Lead card (topbar Lead pill), card chips, and regressions: ?slot=, Overview ?tab=, ?agent=, ?view=decisions, split picker (B17).
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5976; const browser = await boot(PORT);
const T = (id) => `[data-testid="${id}"]`;
const all = {};
const cfgs = [["dark", 1920, 1080], ["light", 1600, 900], ["light", 1920, 1080], ["dark", 1600, 900]];
for (const [theme, w, h] of cfgs) {
  const name = `${theme}-${w}`; const out = []; all[name] = out;
  const S = async (...a) => { let r; try { r = await step(...a); } catch (e) { r = { label: a[1], error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify(r).slice(0, 900)); return r; };
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r43-${name}-${n}.png`) });
  let { page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&riff=1" });
  // a) Lead pill from the Bug Chaser Brainstorm chat.
  await S(page, "sidebar Bug Chaser", async () => { if (!(await page.$(`${T("boring-conv-bug-chaser")} .boring-conv-title`))) { await page.click(T("boring-project-toggle-vibesquad")); await page.waitForTimeout(300); } await page.click(`${T("boring-conv-bug-chaser")} .boring-conv-title`); });
  await S(page, "topbar Lead · none pill", () => page.click(T("boring-top-lead")));
  if (theme === "light" && w === 1600) await shot(page, "leadpill-card");
  await S(page, "Back", () => page.goBack());
  await S(page, "Forward", () => page.goForward());
  await S(page, "reload", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  await S(page, "card chip Brainstorm Idle", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
  await S(page, "Back to Lead card", () => page.goBack());
  await S(page, "Switch to Brainstorm CTA", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Switch to Brainstorm")`));
  out.push({ label: "errsA", errs: page.errs }); await ctx.close();
  // b) Runner Pilot: Lead pill <-> Brainstorm pill.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&team=vibesquad&lane=runner-pilot" }));
  out.push({ label: "deep link runner-pilot card", ...(await state(page)) });
  await S(page, "Lead · idle pill", () => page.click(T("boring-top-lead")));
  await S(page, "Brainstorm pill (from Lead chat)", () => page.click(T("boring-top-brainstorm")));
  await S(page, "card chip Lead Idle", () => page.click(`${T("boring-lane-no-agent")} .drawer-shell button:has-text("Lead")`));
  // c) Regressions: Desk slot (Main Game Overlord: no agent), Overview tabs, ?agent=, ?view=decisions.
  await S(page, "efi Overlord no-agent slot", async () => { if (!(await page.$(T("boring-core-overlord") + ":visible"))) { await page.click(T("boring-project-toggle-efi")).catch(() => {}); await page.waitForTimeout(300); } await page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-overlord")}`).click(); });
  await S(page, "efi RiffBot slot", () => page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-riffbot")}`).click());
  await S(page, "Back (to Overlord slot)", () => page.goBack());
  await S(page, "efi overview", () => page.click(T("boring-project-header-efi")));
  await S(page, "tab inbox", () => page.click(T("boring-tab-inbox")));
  await S(page, "tab feed", () => page.click(T("boring-tab-feed")));
  await S(page, "Back (inbox)", () => page.goBack());
  await S(page, "Back (overview)", () => page.goBack());
  await S(page, "Back (Overlord slot)", () => page.goBack());
  await S(page, "Decisions nav", () => page.click(T("boring-decisions-nav")));
  await S(page, "Back from decisions", () => page.goBack());
  await S(page, "Needs-you open (agent)", () => page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click());
  await S(page, "Back from agent", () => page.goBack());
  await S(page, "Forward to agent", () => page.goForward());
  out.push({ label: "errsB", errs: page.errs }); await ctx.close();
  // d) Split picker: open agent, Split, pick a lane's empty card in the right pane -> URL must not change, no push.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&team=vibesquad&agent=demo-lead-runner" }));
  out.push({ label: "deep link ?agent=demo-lead-runner", ...(await state(page)) });
  await S(page, "Split", () => page.click(T("boring-split-toggle")));
  const picks = await page.$$eval('[data-testid^="boring-pp-open-"]', (bs) => bs.map((b) => `${b.dataset.testid} | ${b.getAttribute("aria-label")} | live=${b.classList.contains("live")}`));
  out.push({ label: "picker pills", picks }); console.log(picks.slice(0, 30).join("\n"));
  const deadPill = picks.find((p) => p.includes("live=false"));
  if (deadPill) await S(page, "picker: non-live pill -> right empty card", () => page.click(T(deadPill.split(" | ")[0])));
  if (w === 1920) await shot(page, "split-rightcard");
  out.push({ label: "after right card", ...(await state(page)), right: await page.$eval(T("boring-pane-right"), (e) => e.innerText.replace(/\n/g, " / ").slice(0, 200)).catch(() => null) });
  await S(page, "Back after right card", () => page.goBack());
  out.push({ label: "errsC", errs: page.errs }); await ctx.close();
  fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(all, null, 1));
  console.log("== done", name);
}
await browser.close(); server.close();
