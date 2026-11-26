// R43 pass 1: lane empty card URL. For each theme x viewport: Overview -> Brainstorm cell (Runner Pilot: Lead idle, no Brainstorm) -> card;
// elsewhere (another project) -> Back -> Forward -> Back -> reload. Then ?riff=1 Bug Chaser: Lead cell (no Lead) and sidebar lane click.
// Logs URL, history calls, per-frame screen signatures (flash check), selected sidebar rows, breadcrumb, card head.
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, take, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5975; const browser = await boot(PORT);
const T = (id) => `[data-testid="${id}"]`;
const all = {};
const logStep = async (...a) => { const r = await step(...a); console.log(JSON.stringify(r)); return r; };
const cfgs = [["dark", 1920, 1080], ["light", 1920, 1080], ["dark", 1600, 900], ["light", 1600, 900]];
for (const [theme, w, h] of cfgs) {
  const name = `${theme}-${w}`; const out = []; const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r43-${name}-${n}.png`) });
  // A. Runner Pilot card from the Overview's Brainstorm cell.
  let { page, ctx } = await open(browser, { port: PORT, theme, w, h });
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click(); await page.waitForTimeout(800);
  out.push(await logStep(page, "overview vibesquad", () => page.click(T("boring-project-header-vibesquad"))));
  out.push(await logStep(page, "click Runner Pilot Brainstorm cell", () => page.click(`${T("boring-lane-row-runner-pilot")} td:nth-child(2) button`)));
  if (w === 1920) await shot(page, "A-card");
  out.push(await logStep(page, "elsewhere: Main Game overview", () => page.click(T("boring-project-header-efi"))));
  out.push(await logStep(page, "Back", () => page.goBack()));
  if (w === 1920) await shot(page, "A-back");
  out.push(await logStep(page, "Forward", () => page.goForward()));
  out.push(await logStep(page, "Back again", () => page.goBack()));
  out.push(await logStep(page, "reload", () => page.reload({ waitUntil: "domcontentloaded" }), 1800));
  if (w === 1920 && theme === "light") await shot(page, "A-reload");
  // Lead cell on the same row (Lead idle) -> should open the Lead chat, not the card.
  out.push(await logStep(page, "overview vibesquad again", () => page.click(T("boring-project-header-vibesquad"))));
  out.push(await logStep(page, "Runner Pilot Lead cell", () => page.click(`${T("boring-lane-row-runner-pilot")} td:nth-child(3) button`)));
  out.push(await logStep(page, "Back from Lead chat", () => page.goBack()));
  out.errs = page.errs; await ctx.close();
  // B. ?riff=1 Bug Chaser: Brainstorm only, no Lead.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&riff=1" }));
  out.push(await logStep(page, "riff: overview vibesquad", () => page.click(T("boring-project-header-vibesquad"))));
  const cells = await page.$$eval(`${T("boring-lane-row-bug-chaser")} td`, (tds) => tds.map((td) => ({ text: td.innerText.replace(/\n/g, " "), btn: !!td.querySelector("button"), title: td.querySelector("button")?.title || td.querySelector("button")?.getAttribute("aria-label") || null })));
  out.push({ label: "bug-chaser cells", cells });
  out.push(await logStep(page, "Bug Chaser Lead cell (no Lead)", () => page.click(`${T("boring-lane-row-bug-chaser")} td:nth-child(3) button`)));
  if (w === 1920) await shot(page, "B-leadcell");
  out.push(await logStep(page, "Back to overview", () => page.goBack()));
  out.push(await logStep(page, "Bug Chaser Brainstorm cell", () => page.click(`${T("boring-lane-row-bug-chaser")} td:nth-child(2) button`)));
  out.push(await logStep(page, "Back to overview 2", () => page.goBack()));
  out.push(await logStep(page, "deep link ?lane=bug-chaser&role=lead", () => page.goto(page.url().replace(/\?.*/, "?demo=&riff=1&team=vibesquad&lane=bug-chaser&role=lead"), { waitUntil: "domcontentloaded" }), 1800));
  if (w === 1920) await shot(page, "B-leadcard");
  const ctas = await page.$$eval(`${T("boring-lane-no-agent")} button`, (bs) => bs.map((b) => b.innerText.replace(/\n/g, " ").slice(0, 60))).catch(() => []);
  out.push({ label: "lead card buttons", ctas });
  out.push(await logStep(page, "sidebar: Bug Chaser lane title", async () => { if (!(await page.$(`${T("boring-conv-bug-chaser")} .boring-conv-title`))) { await page.click(T("boring-project-toggle-vibesquad")); await page.waitForTimeout(300); } await page.click(`${T("boring-conv-bug-chaser")} .boring-conv-title`); }));
  if (w === 1920) await shot(page, "B-sidebar-lane");
  out.push(await logStep(page, "elsewhere then Back", async () => { await page.click(T("boring-project-header-efi")); await page.waitForTimeout(700); await page.goBack(); }));
  out.errsB = page.errs; await ctx.close();
  all[name] = { steps: out, errsA: out.errs, errsB: out.errsB };
  fs.writeFileSync(path.join(LOGS, "pass1.json"), JSON.stringify(all, null, 1));
  console.log("==", name, "errs", out.errs, out.errsB);
  for (const s of out) console.log(JSON.stringify(s));
}
fs.writeFileSync(path.join(LOGS, "pass1.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
