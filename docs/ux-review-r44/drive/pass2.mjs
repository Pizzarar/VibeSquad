// R44 pass 2: entering a lane's empty card by click while split is open (pickRole with no member, c456f311), and Back/Forward/reload after.
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5992; const browser = await boot(PORT); const T = (id) => `[data-testid="${id}"]`;
const all = {}; const cfgs = [["dark", 1920, 1080], ["light", 1600, 900]];
const leftDown = (page) => page.locator(`${T("boring-pane-left")} .boring-agent-header`).first().click({ position: { x: 300, y: 10 } });
for (const [theme, w, h] of cfgs) {
  const name = `${theme}-${w}`; const out = []; all[name] = out;
  const S = async (...a) => { let r; try { r = await step(...a); } catch (e) { r = { label: a[1], error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify(r).slice(0, 700)); return r; };
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r44-${name}-${n}.png`), scale: "css" });
  // a) Bug Chaser Brainstorm left + live agent right; activate left; topbar "Lead · none" pill -> ?lane=bug-chaser&role=lead.
  let { page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&riff=1&team=vibesquad&agent=demo-bugs" });
  await S(page, "a Split", () => page.click(T("boring-split-toggle")));
  await S(page, "a picker: Overlord -> right", () => page.click(T("boring-pp-open-_overlord-lead")).catch(async () => { const l = await page.$$eval('[data-testid^="boring-pp-open-"].live', (b) => b.map((x) => x.dataset.testid)); await page.click(T(l[0])); }));
  await S(page, "a activate left pane", () => leftDown(page));
  await S(page, "a topbar Lead · none pill (split open)", () => page.click(T("boring-top-lead")));
  if (w === 1920) await shot(page, "a-leadpill-split");
  await S(page, "a card chip Brainstorm (split back?)", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
  if (w === 1920) await shot(page, "a-chip-back-to-split");
  await S(page, "a Back (Lead card)", () => page.goBack());
  await S(page, "a reload on Lead card", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  await S(page, "a Forward (agent; split?)", () => page.goForward());
  out.push({ label: "errsA", errs: page.errs }); await ctx.close();
  // b) Runner Pilot Lead left; Split; picker "Buddy (not running)" = B17 right card; then topbar Brainstorm pill; then sidebar paths.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&team=vibesquad&agent=demo-lead-runner" }));
  await S(page, "b Split", () => page.click(T("boring-split-toggle")));
  await S(page, "b picker: Runner Pilot Buddy (right card)", () => page.click(T("boring-pp-open-runner-pilot-brainstorm")));
  if (w === 1920) await shot(page, "b-rightcard");
  await S(page, "b activate left pane", () => leftDown(page));
  await S(page, "b topbar Brainstorm pill (no Brainstorm, split open)", () => page.click(T("boring-top-brainstorm")));
  if (w === 1920) await shot(page, "b-bspill-card");
  await S(page, "b Back", () => page.goBack());
  await S(page, "b Forward", () => page.goForward());
  await S(page, "b sidebar Runner Pilot row (Lead)", () => page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`));
  out.push({ label: "errsB", errs: page.errs }); await ctx.close();
  // c) Right card shown (B17) -> sidebar row whose target is an empty card: efi Bugs (no agent) and efi Overlord.
  ({ page, ctx } = await open(browser, { port: PORT, theme, w, h, q: "?demo=&team=vibesquad&agent=demo-lead-runner" }));
  await S(page, "c Split", () => page.click(T("boring-split-toggle")));
  await S(page, "c picker: Runner Pilot Buddy (right card)", () => page.click(T("boring-pp-open-runner-pilot-brainstorm")));
  await S(page, "c sidebar Runner Pilot row while right card active", () => page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`));
  await S(page, "c picker again: Runner Pilot Buddy", async () => { if (await page.$(T("boring-pp-open-runner-pilot-brainstorm"))) await page.click(T("boring-pp-open-runner-pilot-brainstorm")); });
  await S(page, "c sidebar efi Bugs (no agent)", async () => { if (!(await page.$(T("boring-project-lanes-efi")))) { await page.click(T("boring-project-toggle-efi")); await page.waitForTimeout(300); } await page.locator(`${T("boring-project-lanes-efi")} ${T("boring-core-bugs")}`).click(); });
  await S(page, "c Back", () => page.goBack());
  out.push({ label: "errsC", errs: page.errs }); await ctx.close();
}
fs.writeFileSync(path.join(LOGS, "pass2.json"), JSON.stringify(all, null, 1));
await browser.close(); server.close();
