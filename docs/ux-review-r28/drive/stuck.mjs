// R24 probe: after Back lands on a mixed B2 entry (team=<prev>&agent=<new>), does the NEXT user navigation still push?
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7]];
const { browser, page, errs } = await open(port, { w, h, zoom, theme }, "?demo=&team=vibesquad");
const tag = `${theme}-${w}`;
const step = async (n, shot) => { await page.waitForTimeout(700); const s = await state(page); if (shot) await page.screenshot({ path: `${out}/${tag}-stuck-${n}.png` }); console.log(`${n.padEnd(12)} ${s.url.padEnd(40)} ${s.chat ? "chat" : "ov"}:${s.crumb} len=${s.hlen} :: ${s.hist}`); return s; };
const aud = () => page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
await aud(); await step("chat");
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI Lab"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
await step("pick-uilab");
await page.goBack(); await step("back(mixed)");
// next user navigation: open a different Needs-you item (Review - Sonnet), same project
await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Review - Sonnet" }).first().click();
await step("click-review", true);
await page.goBack(); await step("back", true);
await page.goBack(); await step("back2");
// variant: mixed via project row, then click a sidebar project
await aud(); await step("chat-b");
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("proj-efi");
await page.goBack(); await step("back(mixed)");
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI BOIS"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
await step("pick-uibois");
await page.goBack(); await step("back");
console.log("pageerrors=" + errs.length);
await browser.close();
