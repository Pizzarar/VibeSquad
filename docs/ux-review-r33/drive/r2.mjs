// UX R33 r2 re-check: stale slot/tab leak across projects, cold reload, Storybook over a chat.
// Usage: node r2.mjs <port> <w> <h> <zoom> <theme> [shotdir]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7]];
const sb = ".boring-sidebar"; const base = `http://127.0.0.1:${port}/`;
const fmt = (s) => `${s.url} | ${s.chat ? "chat" : "ov[tab=" + s.tab + "]"} crumb=${s.crumb} on=${JSON.stringify(s.on)} len=${s.hlen}${s.sbOpen ? " SB" : ""}`;
async function session(name, start, fn) {
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, start);
  const settle = async (label) => { await page.waitForTimeout(700); const s = await state(page); s.sbOpen = await page.evaluate(() => !document.querySelector(".boring-sidebar")); console.log(`  ${label.padEnd(14)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`); return s; };
  const shot = async (n) => { if (out) await page.screenshot({ path: `${out}/${theme}-${w}-r2-${n}.png` }); };
  console.log(`== ${name} (${theme} ${w}x${h}@${zoom})`);
  try { await fn({ page, settle, shot }); } catch (e) { console.log("  ERROR " + String(e).slice(0, 200)); }
  console.log(`  pageerrors=${errs.length} ${errs.slice(0, 2).join(" ; ").slice(0, 200)}`);
  await browser.close();
}
const expand = async (p, team) => { const tg = p.getByTestId(`boring-project-toggle-${team}`); if ((await tg.getAttribute("aria-expanded")) !== "true") await tg.click(); await p.waitForTimeout(400); };
const mate = async (p, team, t) => { await expand(p, team); await p.locator(`${sb} .boring-mate-name`, { hasText: t }).first().click(); };
const ctrlk = async (p, q) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(400); await p.keyboard.type(q); await p.waitForTimeout(400); await p.keyboard.press("Enter"); };
const sbBtn = (p) => p.getByRole("button", { name: "Storybook" }).first().click();

// A. Storybook open over vs Inbox, then Ctrl+K to an efi agent (leak repro)
await session("leak sb+ctrlk agent", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  await page.getByTestId("boring-tab-inbox").click(); const s0 = await settle("vs inbox");
  await sbBtn(page); await settle("storybook");
  await ctrlk(page, "UI Lab"); const s1 = await settle("ctrlk UI Lab"); await shot("leak-ctrlk-agent"); console.log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.goBack(); await settle("back"); await page.goBack(); await settle("back2"); await page.goForward(); await settle("fwd");
});
// A1b. Storybook over vs Standup, Ctrl+K to the efi team item
await session("leak sb+ctrlk team", "?demo=&team=vibesquad&tab=standup", async ({ page, settle, shot }) => {
  await settle("vs standup"); await sbBtn(page); await settle("storybook");
  await ctrlk(page, "Main Game squad team"); await settle("ctrlk efi team"); await shot("leak-ctrlk-team");
  await page.goBack(); await settle("back"); await page.goBack(); await settle("back2"); await page.goForward(); await settle("fwd");
});
// A2. Storybook open over efi Overlord slot, then Ctrl+K to VibeSquad project
await session("leak sb+ctrlk proj", "?demo=&team=efi&slot=overlord", async ({ page, settle, shot }) => {
  await settle("efi slot");
  await sbBtn(page); await settle("storybook");
  await ctrlk(page, "VibeSquad squad team"); await settle("ctrlk vs team"); await shot("leak-ctrlk-proj");
  await page.goBack(); await settle("back"); await page.goBack(); await settle("back2");
});
// A3. Tab on vs, slot on efi, then project row switches: no slot/tab carried
await session("leak rows", "?demo=&team=vibesquad&tab=standup", async ({ page, settle }) => {
  await settle("vs standup");
  await page.locator(`${sb} .boring-project-row`, { hasText: "Main Game Project" }).first().click(); await settle("efi row");
  await mate(page, "efi", "Overlord"); await settle("efi overlord");
  await page.locator(`${sb} .boring-project-row`, { hasText: "VibeSquad" }).first().click(); await settle("vs row");
  await page.goBack(); await settle("back"); await page.goBack(); await settle("back2"); await page.goBack(); await settle("back3");
});
// B. Cold URLs: gone team with slot/tab; tab on a team that is not first; reloads
for (const q of ["?demo=&team=gone&tab=inbox", "?demo=&team=gone&slot=overlord", "?demo=&team=efi&tab=inbox", "?demo=&team=efi&tab=standup", "?demo=&team=site&tab=inbox", "?demo=&team=efi&slot=riffbot"]) {
  await session("cold " + q, q, async ({ page, settle }) => {
    const s0 = await settle("load");
    await page.goto(base + s0.url); await page.waitForSelector(sb, { timeout: 6000 }).catch(() => {}); await settle("reload");
    await page.goBack(); await settle("back");
  });
}
// C. Storybook over an Overview reached from a chat (pre-existing SB5 close-on-open), Esc, Back
await session("sb over ov-from-chat", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  await page.locator(`${sb} .boring-needs-open`, { hasText: "Audit - token scout" }).first().click(); await settle("audit chat");
  await page.locator(`${sb} .boring-project-row`, { hasText: "VibeSquad" }).first().click(); const s0 = await settle("vs ov");
  await sbBtn(page); const s1 = await settle("storybook"); await shot("sb-from-chat"); console.log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.keyboard.press("Escape"); await settle("esc");
  await page.goBack(); await settle("back"); await page.goForward(); await settle("fwd");
});
// D. Storybook from a chat (agent on screen), Esc, Back
await session("sb over chat", "?demo=&team=vibesquad", async ({ page, settle }) => {
  await page.locator(`${sb} .boring-needs-open`, { hasText: "Audit - token scout" }).first().click(); const s0 = await settle("audit chat");
  await sbBtn(page); const s1 = await settle("storybook"); console.log(`  dLen=${s1.hlen - s0.hlen}`);
  await page.keyboard.press("Escape"); await settle("esc");
  await page.goBack(); await settle("back");
});
