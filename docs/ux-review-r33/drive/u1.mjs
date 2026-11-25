// UX R33 independent U1 probe. Usage: node u1.mjs <port> <w> <h> <zoom> <theme> [shotdir] [only]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out, only] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7], process.argv[8]];
const sb = ".boring-sidebar";
const base = `http://127.0.0.1:${port}/`;
async function st(page) {
  const s = await state(page);
  const x = await page.evaluate(() => {
    const t = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const card = document.querySelector("[data-testid=boring-empty-card]");
    const nohead = document.querySelector("[data-testid=boring-lane-no-agent-head]");
    const sbv = !document.querySelector(".boring-sidebar");
    return { card: card ? t(card).slice(0, 50) : "", nohead: t(nohead).slice(0, 60), sbOpen: sbv };
  });
  return { ...s, ...x };
}
const fmt = (s) => `${s.url} | ${s.chat ? "chat" : s.card ? "CARD[" + s.card + "]" : "ov[tab=" + s.tab + "]"} crumb=${s.crumb} on=${JSON.stringify(s.on)} len=${s.hlen}${s.sbOpen ? " SB" : ""}`;
const lines = []; const log = (l) => { lines.push(l); console.log(l); };
async function session(name, start, fn) {
  if (only && !name.startsWith(only)) return;
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, start);
  const settle = async (label) => { await page.waitForTimeout(700); const s = await st(page); log(`  ${label.padEnd(14)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`); return s; };
  const shot = async (n) => { if (out) await page.screenshot({ path: `${out}/${theme}-${w}-${n}.png` }); };
  const reload = async (label, url) => { await page.goto(base + url); await page.waitForSelector(sb, { timeout: 6000 }).catch(() => {}); return settle(label); };
  log(`== ${name} (${theme} ${w}x${h}@${zoom})`);
  try { await fn({ page, settle, shot, reload }); } catch (e) { log("  ERROR " + String(e).slice(0, 200)); }
  log(`  pageerrors=${errs.length} ${errs.slice(0, 2).join(" ; ").slice(0, 200)}`);
  await browser.close();
}
const expand = async (p, team) => { const tg = p.getByTestId(`boring-project-toggle-${team}`); if ((await tg.getAttribute("aria-expanded")) !== "true") await tg.click(); await p.waitForTimeout(400); };
const mate = async (p, team, t) => { await expand(p, team); await p.locator(`${sb} [data-testid=boring-project-group-${team}] .boring-mate-name, ${sb} .boring-mate-name`, { hasText: t }).first().click(); };
const tab = (p, id) => p.getByTestId(`boring-tab-${id}`).click();

// 1. Slot card: VibeSquad Bugs (no agent), Back/Forward/reload
await session("slot-bugs", "?demo=&team=vibesquad", async ({ page, settle, shot, reload }) => {
  const s0 = await settle("start");
  await mate(page, "vibesquad", "Bugs"); const s1 = await settle("click Bugs"); await shot("slot-bugs");
  await page.goBack(); await settle("back");
  await page.goForward(); await settle("forward");
  await reload("reload final", s1.url);
  await page.goBack(); await settle("back after rl");
});
// 1b. efi Overlord slot from a chat (R31 m1 repro), then RiffBot slot
await session("slot-efi", "?demo=&team=vibesquad", async ({ page, settle, shot, reload }) => {
  await page.locator(`${sb} .boring-needs-open`, { hasText: "Audit - token scout" }).first().click(); await settle("audit chat");
  await mate(page, "efi", "Overlord"); const s1 = await settle("efi Overlord"); await shot("slot-efi-overlord");
  await mate(page, "efi", "RiffBot"); const s2 = await settle("efi RiffBot"); await shot("slot-efi-riffbot");
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2");
  await page.goForward(); await settle("fwd");
  await page.goForward(); await settle("fwd2");
  await reload("reload ovl", s1.url); await reload("reload rb", s2.url);
});
// 2. Tabs
await session("tabs", "?demo=&team=vibesquad", async ({ page, settle, shot, reload }) => {
  await settle("start");
  await tab(page, "inbox"); const s1 = await settle("inbox"); await shot("tab-inbox");
  await tab(page, "feed"); const s2 = await settle("standup"); await shot("tab-standup");
  await tab(page, "feed"); await settle("standup again");
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2");
  await page.goForward(); await settle("fwd");
  await page.goForward(); await settle("fwd2");
  await reload("reload inbox", s1.url); await reload("reload standup", s2.url);
  await tab(page, "overview"); await settle("click Overview");
  await page.goBack(); await settle("back");
});
// 3. Project switch resets tab; Back restores the previous project's tab
await session("proj-switch", "?demo=&team=vibesquad", async ({ page, settle, shot, reload }) => {
  await tab(page, "inbox"); const s1 = await settle("vs inbox");
  await page.locator(`${sb} .boring-project-row`, { hasText: "Main Game Project" }).first().click(); const s2 = await settle("efi row"); await shot("proj-switch-efi");
  await tab(page, "feed"); await settle("efi standup");
  await page.locator(`${sb} .boring-project-row`, { hasText: "VibeSquad" }).first().click(); await settle("vs row again");
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2"); 
  await page.goBack(); const s5 = await settle("back3"); await shot("proj-switch-back");
  await page.goForward(); await settle("fwd");
  await reload("reload back3", s5.url);
});
// 4. Ctrl+K agent pick from a tab, then Back
await session("ctrlk", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  await tab(page, "inbox"); const s0 = await settle("vs inbox");
  await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI Lab"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
  const s1 = await settle("ctrlk UI Lab"); log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.goBack(); await settle("back"); await shot("ctrlk-back");
  await page.goBack(); await settle("back2");
  await page.goForward(); await settle("fwd");
  await page.goForward(); await settle("fwd2");
});
// 4b. Ctrl+K same project from tab
await session("ctrlk-same", "?demo=&team=vibesquad", async ({ page, settle }) => {
  await tab(page, "feed"); const s0 = await settle("vs standup");
  await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("Audit - token"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
  const s1 = await settle("ctrlk Audit"); log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2");
});
// 5. Unknown / conflicting URL values
for (const q of ["?demo=", "?demo=&team=nope", "?demo=&team=vibesquad&foo=1", "?demo=&team=vibesquad&view=bogus", "?demo=&team=vibesquad&tab=bogus", "?demo=&team=vibesquad&slot=bogus", "?demo=&team=vibesquad&tab=overview", "?demo=&team=vibesquad&tab=feed",
  "?demo=&team=vibesquad&slot=overlord", "?demo=&team=efi&slot=lead", "?demo=&team=efi&slot=brainstorm", "?demo=&team=efi&slot=overlord&tab=inbox", "?demo=&team=vibesquad&tab=inbox&agent=demo-aud", "?demo=&team=efi&slot=overlord&agent=demo-aud",
  "?demo=&slot=overlord", "?demo=&tab=inbox", "?demo=&team=nope&tab=inbox", "?demo=&team=vibesquad&tab=INBOX", "?demo=&team=vibesquad&tab=inbox&tab=standup"]) {
  await session("unknown " + q, q, async ({ page, settle }) => { await settle("load"); await page.goBack(); await settle("back"); });
}
await session("storybook-ov", "?demo=&team=vibesquad", async ({ page, settle }) => {
  await settle("vs overview");
  await page.getByRole("button", { name: "Storybook" }).first().click(); await settle("storybook");
  await page.keyboard.press("Escape"); await settle("esc");
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2");
  await page.goForward(); await settle("fwd");
});
// 6. Storybook over a tab, Esc
await session("storybook", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  await tab(page, "inbox"); await settle("vs inbox");
  await page.getByRole("button", { name: "Storybook" }).first().click(); await settle("storybook"); await shot("storybook-over-inbox");
  await page.keyboard.press("Escape"); await settle("esc"); await shot("storybook-esc");
  await page.goBack(); await settle("back");
  await page.goBack(); await settle("back2");
  await page.goForward(); await settle("fwd");
});
await session("storybook-url", "?demo=&team=vibesquad&tab=standup&sb=1", async ({ page, settle }) => {
  await settle("load sb+tab");
  await page.keyboard.press("Escape"); await settle("esc");
  await page.goBack(); await settle("back");
});
// 7. Open in Inbox from a ref popover in a chat
await session("open-in-inbox", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  await page.locator(`${sb} .boring-needs-open`, { hasText: "Audit - token scout" }).first().click(); const s0 = await settle("audit chat");
  await page.getByText("idea-729", { exact: true }).first().click(); await page.waitForTimeout(500); await shot("ref-popover");
  await page.getByText("Open in Inbox").first().click(); const s1 = await settle("open in inbox"); await shot("open-in-inbox"); log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.goBack(); await settle("back");
  await page.goForward(); await settle("fwd");
});
