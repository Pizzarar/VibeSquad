// UX 1075 driver: real dist + ?demo cast, mocked backend routes (scripts/ui-overlap/env.mjs), random local port.
import path from "node:path"; import fs from "node:fs";
const ROOT = process.argv[2]; const OUT = path.join(ROOT, "docs/ux-review-1075");
const E = await import(path.join(ROOT, "scripts/ui-overlap/env.mjs"));
const pw = E.resolvePlaywright(); const exe = E.findBrowser();
const { server, baseUrl } = await E.serveDist();
const b = await pw.chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const init = (theme) => `try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"boring","app.theme":"${theme}"}));}catch{}`;
const log = [];
async function open(theme, w, h, dpr) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.addInitScript(init(theme)); await E.installRoutes(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log.push("PAGEERROR " + e.message));
  await page.goto(`${baseUrl}/?demo=1`);
  await page.locator('[data-testid="boring-worker-demo-aud"]').click({ timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page };
}
const state = (page) => page.evaluate(() => {
  const t = (s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, " ").trim().slice(0, 90) : null; };
  const u = new URL(location.href);
  const pane = (side) => { const e = document.querySelector(`[data-testid="boring-pane-${side}"]`); if (!e) return null; const n = e.querySelector('[data-testid="boring-agent-name"]'); const card = e.querySelector('[data-testid="boring-empty-card"]'); const pick = e.querySelector('[data-testid="boring-pp-lanes"]'); return (n ? "agent:" + n.innerText : card ? "card:" + card.innerText.replace(/\s+/g, " ").slice(0, 60) : pick ? "picker" : "?") + (e.className.includes("active") ? " [active]" : ""); };
  return {
    url: u.search,
    crumb: [...document.querySelectorAll('[data-testid^="boring-crumb-"]')].map((e) => e.innerText.trim()).join(" › "),
    split: !!document.querySelector('[data-testid="boring-chat-split"]'),
    left: pane("left"), right: pane("right"),
    head: t('[data-testid="boring-lane-no-agent-head"]') ?? t('.boring-chat-column > * [data-testid="boring-agent-name"]'),
    card: document.querySelector('.boring-chat-column [data-testid="boring-empty-card"]') ? t('.boring-chat-column [data-testid="boring-empty-card"]') : null,
    selected: [...document.querySelectorAll('[aria-current="true"],[aria-current="page"]')].map((e) => e.dataset.testid).filter(Boolean),
    splitToggle: (() => { const e = document.querySelector('[data-testid="boring-split-toggle"]'); return e ? (e.getAttribute("aria-pressed") ?? e.className) : null; })(),
  };
});
let n = 0;
async function step(page, tag, label, shot = false) {
  await page.waitForTimeout(350);
  const s = await state(page);
  log.push(`${tag} ${String(++n).padStart(2, "0")} ${label}\n   ${JSON.stringify(s)}`);
  if (shot) await page.screenshot({ path: path.join(OUT, `${tag}-${String(n).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) });
  return s;
}
const click = (page, id, mod) => page.locator(`[data-testid="${id}"]`).first().click(mod ? { modifiers: [mod] } : {});
async function splitBoth(page) { await click(page, "boring-split-toggle"); await page.waitForTimeout(300); await click(page, "boring-worker-demo-rev", "Shift"); await page.waitForTimeout(300); }

for (const [theme, w, h, dpr] of [["dark", 1920, 1080, 1], ["light", 3200, 1800, 1.2]]) {
  const shots = w === 1920;
  const T = `${theme}${w}`;
  // S1/S2: Normal split with both panes filled, sidebar dormant slot, Back, Forward, agent
  for (const slot of ["boring-core-bugs", "boring-core-overlord", "boring-core-riffbot"]) {
    n = 0; const tag = `${T}-s1-${slot.replace("boring-core-", "")}`;
    const { ctx, page } = await open(theme, w, h, dpr);
    await splitBoth(page); await step(page, tag, "split both panes", shots);
    await click(page, slot); await step(page, tag, "sidebar dormant slot", shots || slot === "boring-core-bugs");
    await page.goBack(); await step(page, tag, "back", shots);
    await page.goForward(); await step(page, tag, "forward", shots);
    await click(page, "boring-worker-demo-mech"); await step(page, tag, "click agent mech", shots);
    await page.goBack(); await step(page, tag, "back from agent");
    await page.goBack(); await step(page, tag, "back again");
    await ctx.close();
  }
  // S1b: split with right pane empty (picker) and left active
  { n = 0; const tag = `${T}-s1b-bugs`; const { ctx, page } = await open(theme, w, h, dpr);
    await click(page, "boring-split-toggle"); await step(page, tag, "split right picker");
    await click(page, "boring-pane-left"); await step(page, tag, "focus left");
    await click(page, "boring-core-bugs"); await step(page, tag, "sidebar bugs", shots);
    await page.goBack(); await step(page, tag, "back");
    await page.goForward(); await step(page, tag, "forward");
    await click(page, "boring-worker-demo-mech"); await step(page, tag, "click agent", shots);
    await ctx.close(); }
  // S3: right pane active, B17 card for Bugs, then sidebar Bugs
  for (const pill of ["boring-pp-open-_bugs-open", "boring-pp-open-_overlord-open"]) {
    n = 0; const tag = `${T}-s3-${pill.includes("bugs") ? "bugs" : "overlord"}`; const { ctx, page } = await open(theme, w, h, dpr);
    await click(page, "boring-split-toggle"); await page.waitForTimeout(300);
    const has = await page.locator(`[data-testid="${pill}"]`).count();
    if (!has) { log.push(`${tag} pill ${pill} missing; pills: ` + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-testid^="boring-pp-open-"]')].map((e) => e.dataset.testid)))); await ctx.close(); continue; }
    await click(page, pill); await step(page, tag, "right pane B17 card", shots);
    await click(page, pill.includes("bugs") ? "boring-core-bugs" : "boring-core-overlord"); await step(page, tag, "sidebar same slot", shots);
    await page.goBack(); await step(page, tag, "back", shots);
    await page.goForward(); await step(page, tag, "forward");
    await click(page, "boring-worker-demo-mech"); await step(page, tag, "click agent", shots);
    await ctx.close(); }
  // S4: non-split unchanged
  for (const slot of ["boring-core-bugs", "boring-core-overlord"]) {
    n = 0; const tag = `${T}-s4-${slot.replace("boring-core-", "")}`; const { ctx, page } = await open(theme, w, h, dpr);
    await click(page, slot); await step(page, tag, "sidebar slot", shots && slot === "boring-core-bugs");
    await page.goBack(); await step(page, tag, "back");
    await page.goForward(); await step(page, tag, "forward");
    await click(page, "boring-worker-demo-mech"); await step(page, tag, "click agent");
    await ctx.close(); }
}
fs.writeFileSync(path.join(OUT, "drive-log.txt"), log.join("\n") + "\n");
console.log(log.join("\n"));
await b.close(); server.close();
