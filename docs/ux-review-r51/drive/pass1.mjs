// R51 pass 1: S1 checks (idea-1096 Overview Lead cell, idea-1104 Lead pill with split, idea-1105 reload on card keeps right pane) + regressions.
// Usage (repo root): node docs/ux-review-r51/drive/pass1.mjs <dark|light> <w> <h> <dsf>
import path from "node:path"; import fs from "node:fs";
import { boot, open, state, step, server, OUT, LOGS } from "./lib.mjs";
const [theme = "dark", W = "1920", H = "1080", DSF = "1"] = process.argv.slice(2);
const w = +W, h = +H, dsf = +DSF; const tag = `${theme}-${w}`;
const PORT = 5990 + (theme === "dark" ? 0 : 1) + (w > 2000 ? 2 : 0); const browser = await boot(PORT); const T = (id) => `[data-testid="${id}"]`;
const out = [];
const panes = (page) => page.evaluate(() => { const p = JSON.parse(localStorage.getItem("vs.panes.v1") || "{}"); return `split=${p.split} L=${p.leftActiveId} R=${p.rightActiveId} rightTabs=${(p.rightTabs || []).join(",")} active=${p.activePane}`; }).catch(() => "?");
const S = async (page, label, fn, wait) => { let r; try { r = await step(page, label, fn, wait); r.panes = await panes(page); r.nsel = r.selected.length; } catch (e) { r = { label, error: String(e).split("\n")[0] }; } out.push(r); console.log(JSON.stringify({ label: r.label, url: r.url, crumb: r.crumb, sel: r.selected, empty: r.empty, head: r.head?.slice(0, 60), split: r.split, right: r.right?.slice(0, 40), panes: r.panes, h: r.h, error: r.error })); return r; };
const leftDown = (page) => page.locator(`${T("boring-pane-left")} .boring-agent-header`).first().click({ position: { x: 300, y: 10 } });
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `r51-${tag}-${n}.png`), scale: "css" });
const O = (q) => open(browser, { port: PORT, theme, w, h, dsf, q });
const cell = (lane, n) => `${T(`boring-lane-row-${lane}`)} td:nth-child(${n}) button`; // 2 = Brainstorm, 3 = Lead
async function split(page) { await S(page, "Split", () => page.click(T("boring-split-toggle"))); await S(page, "picker Plugins Lead -> right", () => page.click(T("boring-pp-open-plugins-lead"))); await S(page, "activate left", () => leftDown(page)); }
const sec = (n) => { out.push({ label: `== ${n}` }); console.log("==", n); };
let page, ctx;
// Q1 idea-1096: Overview Lead cell on a lane with no Lead (Bug Chaser, riff demo) -> Lead empty card.
sec("Q1");
({ page, ctx } = await O("?demo=&riff=1&team=vibesquad"));
await S(page, "Q1 overview", async () => {});
await S(page, "Q1 Bug Chaser Lead cell", () => page.click(cell("bug-chaser", 3)));
await shot(page, "Q1-leadcell-card");
await S(page, "Q1 Back (Overview)", () => page.goBack());
await S(page, "Q1 Bug Chaser Brainstorm cell (live)", () => page.click(cell("bug-chaser", 2)));
await S(page, "Q1 Back", () => page.goBack());
await S(page, "Q1 Runner Pilot Brainstorm cell (no Buddy)", () => page.click(cell("runner-pilot", 2)));
await S(page, "Q1 Back", () => page.goBack());
await S(page, "Q1 Runner Pilot Lead cell (live)", () => page.click(cell("runner-pilot", 3)));
await S(page, "Q1 Back", () => page.goBack());
await S(page, "Q1 Forward", () => page.goForward());
out.push({ label: "errsQ1", errs: page.errs }); await ctx.close();
// Q2 idea-1104: split open, topbar Lead · none -> card in place, split kept; chip / Back restore it.
sec("Q2");
({ page, ctx } = await O("?demo=&riff=1&team=vibesquad&agent=demo-bugs"));
await split(page);
await shot(page, "Q2-split-before");
await S(page, "Q2 topbar Lead · none pill", () => page.click(T("boring-top-lead")));
await shot(page, "Q2-leadpill-card");
await S(page, "Q2 card chip Brainstorm", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
await shot(page, "Q2-after-chip");
await S(page, "Q2 Back (card)", () => page.goBack());
await S(page, "Q2 Back (Brainstorm + split)", () => page.goBack());
await S(page, "Q2 Forward", () => page.goForward());
await S(page, "Q2 Forward", () => page.goForward());
out.push({ label: "errsQ2", errs: page.errs }); await ctx.close();
// Q2b: split open, Overview Lead cell (empty) while split -> card; then Shift+click a live pill.
sec("Q2b");
({ page, ctx } = await O("?demo=&riff=1&team=vibesquad&agent=demo-bugs"));
await split(page);
await S(page, "Q2b sidebar project row -> Overview", () => page.click(`${T("boring-project-row-vibesquad")}, [data-testid^="boring-project-name-vibesquad"]`).catch(() => page.locator('.boring-project-name:has-text("VibeSquad")').first().click()));
await S(page, "Q2b Overview Bug Chaser Lead cell", () => page.click(cell("bug-chaser", 3)));
await S(page, "Q2b card chip Brainstorm", () => page.click(`${T("boring-lane-no-agent")} button:has-text("Brainstorm")`));
await shot(page, "Q2b-chip-split");
out.push({ label: "errsQ2b", errs: page.errs }); await ctx.close();
// Q3 idea-1105: reload on an empty card with a real right agent: lane card, lead card, slot card, ?agent= control.
for (const [name, q0, enter] of [
  ["LANE", "?demo=&team=vibesquad&agent=demo-lead-runner", (p) => p.click(T("boring-top-brainstorm"))],
  ["LEADCARD", "?demo=&riff=1&team=vibesquad&agent=demo-bugs", (p) => p.click(T("boring-top-lead"))],
  ["SLOT", "?demo=&team=vibesquad&agent=demo-lead-runner", async (p) => { if (!(await p.$(T("boring-project-lanes-efi")))) { await p.click(T("boring-project-toggle-efi")); await p.waitForTimeout(300); } await p.locator(`${T("boring-project-lanes-efi")} [data-testid^="boring-core-overlord"]`).click(); }],
  ["AGENT", "?demo=&team=vibesquad&agent=demo-lead-runner", (p) => p.click(`${T("boring-conv-wiki")} .boring-conv-title`)],
]) {
  sec(`Q3 ${name}`);
  ({ page, ctx } = await O(q0)); await split(page);
  await S(page, `${name} enter`, () => enter(page));
  await S(page, `${name} reload`, () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
  if (name !== "AGENT") await shot(page, `Q3-${name}-reload`);
  await S(page, `${name} Back`, () => page.goBack());
  if (name !== "AGENT") await shot(page, `Q3-${name}-back`);
  await S(page, `${name} Forward`, () => page.goForward());
  await S(page, `${name} Back`, () => page.goBack());
  out.push({ label: `errs ${name}`, errs: page.errs }); await ctx.close();
}
// Q4 regressions: R5-4 overview reload with a saved split; cold load into another project; Ctrl+J; ?agent= deep link.
sec("Q4");
({ page, ctx } = await O("?demo=&team=vibesquad&agent=demo-lead-runner"));
await split(page);
await S(page, "Q4 sidebar project VibeSquad (Overview)", () => page.locator('.boring-sidebar').getByText('VibeSquad', { exact: true }).last().click());
await S(page, "Q4 reload Overview", () => page.reload({ waitUntil: "domcontentloaded" }), 1800);
await shot(page, "Q4-overview-reload");
await S(page, "Q4 goto ?team=efi (other project, cold)", () => page.goto(page.url().replace(/\?.*/, "?demo=&team=efi"), { waitUntil: "domcontentloaded" }), 1800);
await shot(page, "Q4-cold-efi");
await S(page, "Q4 Ctrl+J", async () => { await page.keyboard.press("Control+j"); await page.waitForTimeout(400); }, 600);
await S(page, "Q4 Escape", () => page.keyboard.press("Escape"), 400);
await S(page, "Q4 sidebar Bug Chaser", async () => { const l = page.locator(`${T("boring-conv-bug-chaser")} .boring-conv-title`); if (await l.count()) await l.click(); else await page.click(`${T("boring-conv-runner-pilot")} .boring-conv-title`); });
await S(page, "Q4 Back", () => page.goBack());
await S(page, "Q4 Back", () => page.goBack());
out.push({ label: "errsQ4", errs: page.errs }); await ctx.close();
// Q4b: live-role pills still open the agent (no split) and Shift+click targets the right pane.
sec("Q4b");
({ page, ctx } = await O("?demo=&team=vibesquad&agent=demo-lead-runner"));
await S(page, "Q4b sidebar Bug Chaser? / Plugins", () => page.click(`${T("boring-conv-plugins")} .boring-conv-title`));
await S(page, "Q4b topbar Brainstorm pill (live?)", () => page.click(T("boring-top-brainstorm")));
await S(page, "Q4b topbar Lead pill (live)", () => page.click(T("boring-top-lead")));
await S(page, "Q4b Split", () => page.click(T("boring-split-toggle")));
await S(page, "Q4b Shift+click Brainstorm pill", () => page.click(T("boring-top-brainstorm"), { modifiers: ["Shift"] }));
await shot(page, "Q4b-shift-pill");
await S(page, "Q4b Back", () => page.goBack());
out.push({ label: "errsQ4b", errs: page.errs }); await ctx.close();
fs.writeFileSync(path.join(LOGS, `pass1-${tag}.json`), JSON.stringify(out, null, 1));
await browser.close(); server.close();
