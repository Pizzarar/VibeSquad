// R44 pass 3: does split survive the empty card? Compare lane card (pill, Back) vs Desk slot card (sidebar), with a real right-pane agent.
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const PORT = 5993; const browser = await boot(PORT); const T = (id) => `[data-testid="${id}"]`;
const out = [];
const panes = (page) => page.evaluate(() => { const p = JSON.parse(localStorage.getItem("vs.panes.v1") || "{}"); return `split=${p.split} L=${p.leftActiveId} R=${p.rightActiveId} rightTabs=${(p.rightTabs || []).join(",")} active=${p.activePane}`; });
const S = async (page, label, fn, wait) => { let r; try { r = await step(page, label, fn, wait); r.panes = await panes(page); } catch (e) { r = { label, error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify({ label: r.label, url: r.url, crumb: r.crumb, sel: r.selected, empty: r.empty, split: r.split, right: r.right?.slice(0, 40), panes: r.panes, h: r.h, frames: r.frames, error: r.error })); return r; };
const leftDown = (page) => page.locator(`${T("boring-pane-left")} .boring-agent-header`).first().click({ position: { x: 300, y: 10 } });
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r44-dark-1920-${n}.png`), scale: "css" });
// X) Runner Pilot card -> Lead (sidebar) -> Split -> Shift+click Overlord to the right -> Back x2 (card) -> reload -> Forward.
let { page, ctx } = await open(browser, { port: PORT, q: "?demo=&team=vibesquad&lane=runner-pilot" });
await S(page, "X sidebar Runner Pilot (Lead)", () => page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`));
await S(page, "X Split", () => page.click(T("boring-split-toggle")));
await S(page, "X picker Plugins Lead -> right", () => page.click(T("boring-pp-open-plugins-lead")));
await S(page, "X Back (left Lead active)", () => page.goBack());
await S(page, "X Back (?lane=runner-pilot card)", () => page.goBack());
await shot(page, "X-back-card-split-kept");
await S(page, "X reload on card", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
await S(page, "X Forward (split back?)", () => page.goForward());
await shot(page, "X-forward-after-reload");
out.push({ label: "errsX", errs: page.errs }); await ctx.close();
// Y) Lane card via topbar pill with real split, then card chip; compare panes before/after each.
({ page, ctx } = await open(browser, { port: PORT, q: "?demo=&riff=1&team=vibesquad&agent=demo-bugs" }));
await S(page, "Y Split", () => page.click(T("boring-split-toggle")));
await S(page, "Y picker Plugins Lead -> right", () => page.click(T("boring-pp-open-plugins-lead")));
await S(page, "Y activate left", () => leftDown(page));
await S(page, "Y topbar Lead · none pill", () => page.click(T("boring-top-lead")));
await S(page, "Y card chip Brainstorm", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
await shot(page, "Y-after-chip");
await S(page, "Y Back (card)", () => page.goBack());
await S(page, "Y Back (Brainstorm, split?)", () => page.goBack());
out.push({ label: "errsY", errs: page.errs }); await ctx.close();
// Z) Desk slot comparison: same split, sidebar efi Overlord (no agent) -> then sidebar Runner Pilot (agent).
({ page, ctx } = await open(browser, { port: PORT, q: "?demo=&riff=1&team=vibesquad&agent=demo-bugs" }));
await S(page, "Z Split", () => page.click(T("boring-split-toggle")));
await S(page, "Z picker Plugins Lead -> right", () => page.click(T("boring-pp-open-plugins-lead")));
await S(page, "Z activate left", () => leftDown(page));
await S(page, "Z sidebar efi Overlord (no agent)", async () => { if (!(await page.$(T("boring-project-lanes-efi")))) { await page.click(T("boring-project-toggle-efi")); await page.waitForTimeout(300); } await page.locator(`${T("boring-project-lanes-efi")} [data-testid^="boring-core-overlord"]`).click(); });
await S(page, "Z sidebar Bug Chaser (agent)", () => page.click(`${T("boring-conv-bug-chaser")} .boring-conv-title`));
await S(page, "Z sidebar efi Bugs (no agent)", () => page.locator(`${T("boring-project-lanes-efi")} [data-testid^="boring-core-bugs"]`).click());
await S(page, "Z Back", () => page.goBack());
out.push({ label: "errsZ", errs: page.errs }); await ctx.close();
fs.writeFileSync(path.join(LOGS, "pass3.json"), JSON.stringify(out, null, 1));
await browser.close(); server.close();
