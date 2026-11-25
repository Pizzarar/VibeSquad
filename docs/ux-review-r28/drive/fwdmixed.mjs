// R28 probe: a mixed team=<new>&agent=<cur> entry reached by Forward (or Back) while the screen already shows <cur>'s chat.
// Arg 8 = "go2" (history.go(-2), skip the mixed entry), "pw2" (two Playwright goBack calls) or "slow2" (two Backs 700ms apart)
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out, mode] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7], process.argv[8] || "go2"];
const { browser, page, errs } = await open(port, { w, h, zoom, theme }, "?demo=&team=vibesquad");
const tag = `${theme}-${w}-${mode}`;
const step = async (n, shot) => { await page.waitForTimeout(700); const s = await state(page); if (shot && out) await page.screenshot({ path: `${out}/${tag}-fm-${n}.png` }); const inv = s.on.length === 1 && (s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url)); console.log(`${n.padEnd(14)} ${s.url.padEnd(42)} ${s.chat ? "chat" : "ov"}:${s.crumb} on=${s.on.length} inv=${inv} len=${s.hlen} :: ${s.hist}`); return s; };
const needs = (t) => page.locator(".boring-sidebar .boring-needs-open", { hasText: t }).first().click();
await needs("Audit - token scout"); await step("1-aud");
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("2-efi");
if (mode === "go2") await page.evaluate(() => history.go(-2));
else if (mode === "pw2") { await page.goBack(); await page.goBack(); }
else if (mode.startsWith("gap")) { await page.evaluate((ms) => { history.back(); setTimeout(() => history.back(), ms); }, +mode.slice(3)); }
else { await page.goBack(); await page.waitForTimeout(700); await page.goBack(); }
await step("back2x", true);
await page.goForward(); await step("fwd1", true);
await page.goForward(); await step("fwd2(efi?)", true);
await page.goBack(); await step("back-a");
await page.goBack(); await step("back-b");
await page.goBack(); await step("back-c");
console.log("pageerrors=" + errs.length);
await browser.close();
